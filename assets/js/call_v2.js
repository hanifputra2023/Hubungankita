
class RelationshipCall {
    constructor() {
        // Gunakan BASE_URL global yang disinkronkan dari PHP
        this.baseUrl = typeof BASE_URL !== 'undefined' ? BASE_URL : (window.location.origin + '/hubungan/public');

        // ID user yang sedang login — digunakan untuk memfilter sinyal Pusher milik sendiri
        // agar Receiver tidak memproses sdp-answer yang dikirimnya sendiri
        this.currentUserId = (typeof window.MY_USER_ID !== 'undefined') ? parseInt(window.MY_USER_ID) : null;

        // State & Variabel Koneksi
        this.callId = null;
        this.role = null; // 'caller' atau 'receiver'
        this.status = 'idle'; // 'idle', 'dialing', 'ringing', 'active'
        this.callType = 'audio'; // 'audio' atau 'video'
        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.pollInterval = null;
        this.callTimer = null;
        this.callDuration = 0;
        this.incomingCallerName = null;
        this.incomingCallerAvatar = null;
        this.cameraFacingMode = 'user'; // 'user' (front) atau 'environment' (back)
        this.isScreenSharing = false;
        this.screenStream = null;

        // Tracking ICE Candidates yang sudah diproses agar tidak double
        this.processedCandidates = new Set();

        // Buffer ICE Candidates yang datang sebelum remoteDescription siap
        // Ini adalah penyebab utama HP gagal terhubung di balik CG-NAT operator seluler
        this.pendingRemoteCandidates = [];

        // Buffer local ICE Candidates yang dikumpulkan sebelum callId siap dari server
        this.pendingLocalCandidates = [];

        // Flag untuk ICE restart agar tidak loop
        this.iceRestartInProgress = false;

        // Flag untuk mencegah multiple reconnect bersamaan
        this._reconnecting = false;

        // Tracking versi SDP saat ini untuk mendeteksi reconnect sinkron pasangan
        this.currentSdpOffer = null;
        this.currentSdpAnswer = null;

        // ── ANTI-FLICKER: Identifikasi unik per-tab (persisten via window.name & sessionStorage) ──
        // window.name bertahan sempurna saat reload di PWA HP/standalone webview,
        // sedangkan sessionStorage digunakan sebagai fallback. Keduanya tidak dibagikan lintas tab.
        this.tabId = window.name;
        if (!this.tabId || !this.tabId.startsWith('hk_tab_')) {
            this.tabId = sessionStorage.getItem('hk_call_tab_id');
            if (!this.tabId) {
                this.tabId = 'hk_tab_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
                sessionStorage.setItem('hk_call_tab_id', this.tabId);
            }
            window.name = this.tabId;
        }

        // Blocklist call_id yang sudah gagal reconnect — jangan coba lagi
        // Ini menghentikan loop popup muncul-hilang berulang tanpa henti
        this.failedReconnectIds = new Set();

        // Kunci sesi lintas-tab menggunakan localStorage
        // Format: { tabId, callId, timestamp, status }
        this.callSessionKey = 'hk_active_call_session';

        // Interval heartbeat untuk memperbarui timestamp kunci sesi
        this._sessionHeartbeat = null;

        // Konfigurasi WebRTC — dioptimalkan untuk menembus Symmetric NAT & CG-NAT operator seluler
        this.rtcConfig = {
            // iceCandidatePoolSize: pre-gather candidates sebelum offer/answer dibuat
            // Sangat penting agar HP tidak kehabisan waktu kumpulkan candidates
            iceCandidatePoolSize: 10,

            // bundlePolicy max-bundle: gabungkan semua media dalam 1 transport
            // Mengurangi jumlah koneksi yang perlu dibuka — lebih mudah menembus NAT
            bundlePolicy: 'max-bundle',

            // rtcpMuxPolicy require: wajibkan RTCP multiplexed dengan RTP
            // Mengurangi port yang dibutuhkan — penting untuk mobile NAT
            rtcpMuxPolicy: 'require',

            iceServers: [
                // STUN Google — cepat, bebas, reliable
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                // STUN Cloudflare — alternative cepat
                { urls: 'stun:stun.cloudflare.com:3478' },
                // TURN Metered (lebih reliable dari openrelay, 50GB/bulan gratis)
                {
                    urls: [
                        'turn:a.relay.metered.ca:80',
                        'turn:a.relay.metered.ca:80?transport=tcp',
                        'turn:a.relay.metered.ca:443',
                        'turns:a.relay.metered.ca:443?transport=tcp'
                    ],
                    username: 'e8dd65f0519bb0a19f49ceea',
                    credential: 'uMQSGkH5m+LqUPyX'
                },
                // TURN openrelay sebagai fallback
                {
                    urls: [
                        'turn:openrelay.metered.ca:443',
                        'turns:openrelay.metered.ca:443?transport=tcp'
                    ],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        };

        // Web Audio API Synthesizer (Untuk suara nada sambung & dering tanpa aset berkas)
        this.audioCtx = null;
        this.synthInterval = null;

        // Inisialisasi Event Listeners & Start Polling
        this.init();
    }

    init() {
        // Ambil elemen audio static yang sudah dideklarasikan di main.php
        this.remoteAudio = document.getElementById('remote-audio');
        if (!this.remoteAudio) {
            // Fallback jika tidak ditemukan
            this.remoteAudio = document.createElement('audio');
            this.remoteAudio.autoplay = true;
            this.remoteAudio.playsInline = true;
            this.remoteAudio.style.position = 'absolute';
            this.remoteAudio.style.width = '1px';
            this.remoteAudio.style.height = '1px';
            this.remoteAudio.style.opacity = '0';
            this.remoteAudio.style.pointerEvents = 'none';
            document.body.appendChild(this.remoteAudio);
        }

        // Pasang event ke tombol-tombol overlay
        this.bindEvents();

        // Cek status panggilan sekali saja saat load halaman untuk pemulihan sesi aktif jika ada
        this.pollCallStatus();
        this.startIdlePolling();

        // ── Pemulihan Otomatis: Sinkronisasi ulang saat tab kembali aktif dari background ──
        // Begitu tab dimasuki / menjadi aktif, paksa polling instan saat itu juga (0 detik delay)
        // untuk menyambungkan kembali panggilan secara seketika!
        this._visibilityChangeHandler = () => {
            if (document.visibilityState === 'visible') {
                console.log('[Call] Tab menjadi aktif — memaksa sinkronisasi status panggilan instan...');
                this.pollCallStatus();
            }
        };
        document.addEventListener('visibilitychange', this._visibilityChangeHandler);

        // ── Kirim sinyal reload cepat sebelum tab / halaman ditutup penuh (0 detik delay) ──
        window.addEventListener('beforeunload', () => {
            this.notifyReload();
        });

        // ── Sinkronisasi lintas-tab via localStorage storage event ──
        // Jika tab lain mengubah status sesi (misal: menjawab/mengakhiri panggilan),
        // tab ini akan mendeteksinya dan menyesuaikan UI-nya
        window.addEventListener('storage', (e) => {
            // Lewati proteksi tab ganda sepenuhnya jika berjalan di aplikasi mobile native (Capacitor/Cordova)
            if (window.cordova || window.Capacitor) return;
            if (e.key !== this.callSessionKey) return;
            const session = this._parseSession(e.newValue);

            // Sesi dihapus (panggilan berakhir di tab lain)
            if (!session) {
                if (this.status !== 'idle' && !this._isSessionOwner()) {
                    // Diberi delay 2.5 detik untuk menghindari bentrok ketika tab lain sedang me-reload halaman
                    // (reload memicu penghapusan session lock sesaat sebelum ia diklaim kembali)
                    console.log('[Call] Sesi panggilan kosong di localStorage — memverifikasi status dalam 2.5 detik...');
                    setTimeout(async () => {
                        try {
                            const verifyRes = await fetch(`${this.baseUrl}/call/poll`, { method: 'POST' });
                            const verifyData = await verifyRes.json();
                            if (verifyData.status !== 'active' && this.status !== 'idle' && !this._isSessionOwner()) {
                                console.log('[Call] Sesi terkonfirmasi berakhir di server — membersihkan UI lokal.');
                                this.terminateCallLocally();
                            } else {
                                console.log('[Call] Panggilan terdeteksi masih aktif di server — membatalkan penutupan lokal.');
                            }
                        } catch (err) {
                            // Fallback jika fetch gagal
                            if (this.status !== 'idle' && !this._isSessionOwner()) {
                                this.terminateCallLocally();
                            }
                        }
                    }, 2500);
                }
                return;
            }

            // ── PENGAMBILALIHAN SESI LINTAS-TAB (TAKEOVER PROTECTION) ──
            // Jika tab lain merebut posisi Master, tab ini harus mengalah secara anggun.
            // PENTING: Di localhost, dua browser berbeda berbagi localStorage yang sama (same-origin).
            // Tambahkan guard: hanya terminate jika sesi sudah lebih dari 5 detik berlalu (bukan sesi yang baru saja dibuat).
            if (session.tabId !== this.tabId && this.status !== 'idle' && this.status !== 'ringing') {
                const sessionAge = Date.now() - (session.timestamp || 0);
                if (sessionAge < 5000) {
                    // Sesi sangat baru — mungkin baru saja di-create oleh kita sendiri di tab/browser lain,
                    // jangan terminate karena ini bisa jadi false positive di localhost same-origin.
                    console.log('[Call] Abaikan takeover: sesi terlalu baru (' + sessionAge + 'ms). Kemungkinan localhost cross-browser.');
                    return;
                }
                console.log('[Call] Tab lain mengambil alih panggilan sebagai Master baru — menutup koneksi lokal.');
                this.terminateCallLocally('Panggilan dipindahkan ke tab lain.');
                return;
            }

            // Tab lain sedang aktif dan bukan tab ini — tutup modal dering jika ada
            if (session.tabId !== this.tabId && this.status === 'ringing') {
                if (session.status === 'active' || session.status === 'dialing') {
                    console.log('[Call] Tab lain telah menjawab panggilan — menutup modal dering lokal.');
                    this.stopSounds();
                    this.hideIncomingModal();
                    this.status = 'idle';
                    this.callId = null;
                    this.startIdlePolling();
                }
            }
        });

        // ── Cek izin latar belakang otomatis (Android/Oppo/Realme/dll.) ──
        // Tunggu Capacitor/Cordova device ready terlebih dahulu, BARU akses plugin
        if (window.cordova || window.Capacitor) {
            const runBgPermCheck = () => {
                // Tambah delay 3 detik setelah device ready agar plugin benar-benar terdaftar
                setTimeout(() => {
                    this.checkBackgroundPermissions();
                    // Hook ke backgroundMode activate/deactivate untuk manajemen video track
                    this._hookBackgroundModeEvents();
                }, 3000);
            };

            // Capacitor: gunakan event 'deviceready' dari Cordova atau tunggu Capacitor.Plugins
            if (document.readyState === 'complete') {
                // Dokumen sudah siap, tunggu sedikit agar plugin bridge terpasang
                runBgPermCheck();
            } else {
                document.addEventListener('deviceready', runBgPermCheck, { once: true });
                // Fallback via window load event jika deviceready tidak fired
                window.addEventListener('load', () => {
                    setTimeout(runBgPermCheck, 1000);
                }, { once: true });
            }
        }

        // Expose instance ke window agar MainActivity bisa panggil _onPipExited() via evaluateJavascript
        window._callManager = this;
    }

    checkBackgroundPermissions(isUserInitiated = false) {
        console.log('[Call] Menjalankan diagnosis izin latar belakang...');

        // Guard: pastikan plugin tersedia
        const bgMode = window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode;
        if (!bgMode) {
            console.log('[Call] Plugin backgroundMode tidak tersedia, dilewati.');
            return;
        }

        // Aktifkan background mode terlebih dahulu
        bgMode.enable();
        if (typeof bgMode.disableWebViewOptimizations === 'function') {
            bgMode.disableWebViewOptimizations();
            console.log('[Call] disableWebViewOptimizations dipanggil saat inisialisasi.');
        }

        // Cek status battery optimization — SELALU cek, tidak bergantung localStorage
        bgMode.isIgnoringBatteryOptimizations((isIgnored) => {
            console.log('[Call] isIgnoringBatteryOptimizations:', isIgnored);
            if (!isIgnored) {
                console.log('[Call] Battery optimization AKTIF — memunculkan panduan izin...');

                // Tampilkan modal panduan
                this.showBatteryOptimizationModal();

                // Trigger dialog sistem: "Izinkan app ini diabaikan dari optimasi baterai?"
                // Ini akan memunculkan popup SISTEM Android (bukan popup custom)
                bgMode.ignoreBatteryOptimizations();

                // 2 detik kemudian buka OEM settings (Oppo autostart, dll.)
                setTimeout(() => {
                    console.log('[Call] Membuka pengaturan OEM...');
                    if (bgMode.openOemSettings) bgMode.openOemSettings();
                }, 2000);
            } else {
                console.log('[Call] Izin latar belakang sudah aktif ✓');
                if (isUserInitiated) {
                    window.showAlert && window.showAlert(
                        'Izin latar belakang aktif! Aplikasi Anda siap menerima panggilan di latar belakang.',
                        'Izin Aktif 🟢', 'success'
                    );
                }
            }
        }, (err) => {
            console.warn('[Call] isIgnoringBatteryOptimizations error:', err);
        });
    }

    showBatteryOptimizationModal() {
        // Cari apakah modal sudah ada
        let modal = document.getElementById('hk-battery-modal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            return;
        }

        // Buat modal secara dinamis dengan Tailwind CSS premium glassmorphism
        modal = document.createElement('div');
        modal.id = 'hk-battery-modal';
        modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm';
        modal.innerHTML = `
            <div class="w-full max-w-md bg-gray-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md transform transition-all duration-300 scale-95 hover:scale-100 flex flex-col">
                <!-- Header -->
                <div class="px-6 py-4 bg-gradient-to-r from-rose-500/20 to-indigo-500/20 border-b border-white/10 flex items-center gap-3">
                    <span class="text-2xl animate-pulse">⚙️</span>
                    <div>
                        <h3 class="text-base font-bold text-white tracking-wide">Izin Latar Belakang Diperlukan</h3>
                        <p class="text-[10px] text-rose-300/80 font-medium">Khusus Panggilan & Notifikasi Android</p>
                    </div>
                </div>

                <!-- Body -->
                <div class="p-6 space-y-4 text-left overflow-y-auto max-h-[60vh]">
                    <p class="text-xs text-gray-300 leading-relaxed font-normal">
                        Agar panggilan suara dari pasangan Anda **tetap berdering dan tidak terputus** saat aplikasi diminimalkan (tombol Home ditekan), Anda perlu mengaktifkan izin latar belakang.
                    </p>
                    
                    <!-- Steps -->
                    <div class="space-y-3 bg-white/5 p-4 rounded-xl border border-white/5 text-xs">
                        <div class="flex gap-2.5 items-start">
                            <span class="w-5 h-5 rounded-full bg-rose-500/20 text-rose-300 font-bold flex items-center justify-center text-[10px] shrink-0">1</span>
                            <div class="space-y-0.5">
                                <p class="font-bold text-white">Abaikan Optimasi Baterai</p>
                                <p class="text-[10px] text-gray-400">Pilih "Izinkan / Allow" pada dialog sistem Android berikutnya.</p>
                            </div>
                        </div>
                        <div class="flex gap-2.5 items-start">
                            <span class="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 font-bold flex items-center justify-center text-[10px] shrink-0">2</span>
                            <div class="space-y-0.5">
                                <p class="font-bold text-white">Izinkan Aktivitas Latar Belakang (OEM)</p>
                                <p class="text-[10px] text-gray-400">Untuk Oppo/Realme/Xiaomi: Aktifkan "Mulai Otomatis" & "Aktivitas Latar Belakang".</p>
                            </div>
                        </div>
                    </div>

                    <div class="text-[10px] text-amber-400/90 font-medium bg-amber-950/20 border border-amber-900/30 p-2.5 rounded-lg flex gap-2">
                        <span>⚠️</span>
                        <span>Catatan: Android memblokir kamera di latar belakang secara total untuk privasi. Saat di-minimize, video Anda akan terjeda (freeze) tetapi suara Anda akan tetap aktif lancar!</span>
                    </div>
                </div>

                <!-- Footer -->
                <div class="px-6 py-4 border-t border-white/5 flex gap-2 justify-end bg-black/10">
                    <button id="hk-btn-battery-close" class="px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white bg-transparent hover:bg-white/5 rounded-lg transition-all cursor-pointer">
                        Nanti Saja
                    </button>
                    <button id="hk-btn-battery-open" class="px-5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-rose-500 to-indigo-600 hover:from-rose-600 hover:to-indigo-700 rounded-lg shadow-lg hover:shadow-rose-500/10 transition-all cursor-pointer">
                        Buka Pengaturan
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Bind events
        document.getElementById('hk-btn-battery-close').addEventListener('click', () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            localStorage.setItem('hk_battery_opt_prompted', 'true');
        });

        document.getElementById('hk-btn-battery-open').addEventListener('click', () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            localStorage.setItem('hk_battery_opt_prompted', 'true');

            // 1. Trigger standar battery optimization dialog
            if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
                console.log('[Call] Menjalankan ignoreBatteryOptimizations...');
                window.cordova.plugins.backgroundMode.ignoreBatteryOptimizations();

                // 2. Jeda 1.5 detik kemudian buka OEM settings
                setTimeout(() => {
                    console.log('[Call] Menjalankan openOemSettings...');
                    window.cordova.plugins.backgroundMode.openOemSettings();
                }, 1500);
            }
        });
    }

    bindEvents() {
        // Pasang listener tombol navbar (via bindNavButtons agar bisa dipanggil ulang setelah PJAX)
        this.bindNavButtons();

        // ── Pemicu Pemulihan Koneksi Manual (Fallback PWA HP) ──
        // Saat diklik dalam status reconnecting/failed, memaksa browser mencoba mengambil alih mic & audio.
        const triggerManualReconnect = () => {
            const txtStatusElement = document.getElementById('call-status-text');
            const isReconnecting = (txtStatusElement && txtStatusElement.classList.contains('text-amber-400')) || this.status === 'reconnecting';
            if (isReconnecting && this.lastPolledData) {
                console.log('[Call] Menjalankan pemulihan koneksi manual via interaksi user...');
                this.reconnectActiveCall(this.lastPolledData);
            }
        };

        const txtStatus = document.getElementById('call-status-text');
        if (txtStatus) {
            txtStatus.addEventListener('click', triggerManualReconnect);
        }

        const expandStatus = document.getElementById('call-expand-status');
        if (expandStatus) {
            expandStatus.addEventListener('click', triggerManualReconnect);
        }

        // Tombol Jawab panggilan masuk
        const btnAccept = document.getElementById('btn-call-accept');
        if (btnAccept) {
            btnAccept.addEventListener('click', () => this.acceptCallFlow());
        }

        // Tombol Tolak panggilan masuk
        const btnDecline = document.getElementById('btn-call-decline');
        if (btnDecline) {
            btnDecline.addEventListener('click', () => this.declineCallFlow());
        }

        // Tombol Akhiri (widget) — Hangup
        const btnHangup = document.getElementById('btn-call-hangup');
        if (btnHangup) {
            btnHangup.addEventListener('click', () => this.endCallFlow());
        }

        // Tombol Bisu (Mute) di widget
        const btnMute = document.getElementById('btn-call-mute');
        if (btnMute) {
            btnMute.addEventListener('click', () => this.toggleMute());
        }

        // ── Floating Widget: Minimize ──
        const btnMinimize = document.getElementById('btn-call-minimize');
        if (btnMinimize) {
            btnMinimize.addEventListener('click', (e) => {
                e.stopPropagation();
                this.minimizeWidget();
            });
        }

        // ── Floating Widget: Expand (buka full-screen modal) ──
        const btnExpand = document.getElementById('btn-call-expand');
        if (btnExpand) {
            btnExpand.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openExpandModal();
            });
        }
        // Klik header juga buka expand
        const widgetHeader = document.getElementById('call-widget-header');
        if (widgetHeader) {
            widgetHeader.addEventListener('click', () => this.openExpandModal());
        }

        // ── Restore Button (floating bubble saat minimize) ──
        const btnRestore = document.getElementById('call-restore-btn');
        if (btnRestore) {
            let isDragging = false;
            let startX = 0;
            let startY = 0;

            btnRestore.addEventListener('mousedown', (e) => {
                startX = e.clientX;
                startY = e.clientY;
                isDragging = false;
            });

            btnRestore.addEventListener('mousemove', (e) => {
                if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
                    isDragging = true;
                }
            });

            btnRestore.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;
                isDragging = false;
            }, { passive: true });

            btnRestore.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                if (Math.abs(touch.clientX - startX) > 5 || Math.abs(touch.clientY - startY) > 5) {
                    isDragging = true;
                }
            }, { passive: true });

            btnRestore.addEventListener('click', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                this.restoreWidget();
            });

            this.makeElementDraggable(btnRestore, btnRestore);
        }

        // ── Expand Modal: Collapse (kecilkan kembali ke widget) ──
        const btnCollapse = document.getElementById('btn-call-collapse');
        if (btnCollapse) {
            btnCollapse.addEventListener('click', () => this.closeExpandModal());
        }

        // ── Expand Modal: Hangup ──
        const btnExpandHangup = document.getElementById('btn-call-expand-hangup');
        if (btnExpandHangup) {
            btnExpandHangup.addEventListener('click', () => this.endCallFlow());
        }

        // ── Expand Modal: Mute ──
        const btnExpandMute = document.getElementById('btn-call-expand-mute');
        if (btnExpandMute) {
            btnExpandMute.addEventListener('click', () => this.toggleMute());
        }

        // ── Expand Modal: Kamera ──
        const btnExpandCamera = document.getElementById('btn-call-expand-camera');
        if (btnExpandCamera) {
            btnExpandCamera.addEventListener('click', () => this.toggleCamera());
        }

        // ── Expand Modal: Bagi Layar ──
        const btnScreenShare = document.getElementById('btn-call-screen-share');
        if (btnScreenShare) {
            btnScreenShare.addEventListener('click', () => this.toggleScreenShare());
        }

        // ── Expand Modal: Putar Kamera (Front/Back) ──
        const btnFlipCamera = document.getElementById('btn-call-flip-camera');
        if (btnFlipCamera) {
            btnFlipCamera.addEventListener('click', () => this.flipCamera());
        }

        // ── Expand Modal: Layout Video Mode ──
        const btnVideoLayout = document.getElementById('btn-call-video-layout');
        if (btnVideoLayout) {
            btnVideoLayout.addEventListener('click', () => this.toggleVideoLayoutMode());
        }

        // ── Single Tap to Toggle Controls in Video Call & Screen Share ──
        const expandCard = document.getElementById('call-expand-card');
        if (expandCard) {
            expandCard.addEventListener('click', (e) => {
                // Only act if call is active or ringing
                if (this.status === 'idle') return;
                if (this.callType !== 'video' && !this._remoteScreenSharing && !this.isScreenSharing) return;

                // Ignore if clicked on a button or inside the self-preview local PIP wrapper
                if (e.target.closest('button') || e.target.closest('#local-video-wrapper')) {
                    return;
                }

                this.toggleVideoControls();
            });
        }

        // ── Buat widget call-overlay bisa digeser/draggable secara interaktif ──
        const callOverlay = document.getElementById('call-overlay');
        const callHeader = document.getElementById('call-widget-header');
        if (callOverlay && callHeader) {
            this.makeElementDraggable(callOverlay, callHeader);
        }

        // ── Buat local video preview (PIP) bisa digeser/draggable di dalam container video modal ──
        const localVideoWrapper = document.getElementById('local-video-wrapper');
        const callVideoContainer = document.getElementById('call-video-container');
        if (localVideoWrapper && callVideoContainer) {
            this.makePIPDraggable(localVideoWrapper, callVideoContainer);
        }

        // ── Deteksi Perubahan Orientasi Stream Pasangan (Screen Share) ──
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) {
            remoteVideo.addEventListener('resize', () => {
                if (this._remoteScreenSharing) {
                    console.log('[ScreenShare] Remote video resize event detected.');
                    this.adjustScreenShareLayout();
                }
            });
        }
        const overlayRemoteVideo = document.getElementById('overlay-remote-video');
        if (overlayRemoteVideo) {
            overlayRemoteVideo.addEventListener('resize', () => {
                if (this._remoteScreenSharing) {
                    console.log('[ScreenShare] Overlay remote video resize event detected.');
                    this.adjustScreenShareLayout();
                }
            });
        }
        window.addEventListener('resize', () => {
            if (this._remoteScreenSharing) {
                this.adjustScreenShareLayout();
            }
        });
    }

    // Helper untuk membuat elemen bisa digeser (draggable) di desktop & mobile
    makeElementDraggable(dragEl, handleEl) {
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;

        handleEl.addEventListener('mousedown', dragMouseDown);
        handleEl.addEventListener('touchstart', dragTouchStart, { passive: false });

        function dragMouseDown(e) {
            e = e || window.event;
            // Hanya izinkan drag jika tidak mengklik tombol perbesar/kecil (kecuali untuk tombol restore itu sendiri)
            if (handleEl.id !== 'call-restore-btn' && e.target.closest('button')) return;

            e.preventDefault();

            // Catat koordinat mouse awal & offset posisi element mula-mula
            startX = e.clientX;
            startY = e.clientY;
            startLeft = dragEl.offsetLeft;
            startTop = dragEl.offsetTop;

            document.addEventListener('mouseup', closeDragElement);
            document.addEventListener('mousemove', elementDrag);
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();

            // Hitung selisih pergerakan mouse dari awal klik
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            const newLeft = startLeft + deltaX;
            const newTop = startTop + deltaY;

            const maxLeft = window.innerWidth - dragEl.offsetWidth;
            const maxTop = window.innerHeight - dragEl.offsetHeight;

            dragEl.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + "px";
            dragEl.style.top = Math.max(0, Math.min(newTop, maxTop)) + "px";
            dragEl.style.bottom = "auto";
            dragEl.style.right = "auto";
        }

        function closeDragElement() {
            document.removeEventListener('mouseup', closeDragElement);
            document.removeEventListener('mousemove', elementDrag);
        }

        // Dukungan Sentuh (Touch) untuk Mobile
        function dragTouchStart(e) {
            // Hanya izinkan drag jika satu jari aktif untuk mencegah loncatan multi-touch
            if (e.touches.length !== 1) return;

            // Hanya izinkan drag jika tidak mengklik tombol perbesar/kecil (kecuali untuk tombol restore itu sendiri)
            if (handleEl.id !== 'call-restore-btn' && e.target.closest('button')) return;

            const touch = e.targetTouches[0] || e.touches[0];
            if (!touch) return;

            // Catat koordinat sentuh awal & offset posisi element mula-mula
            startX = touch.clientX;
            startY = touch.clientY;
            startLeft = dragEl.offsetLeft;
            startTop = dragEl.offsetTop;

            document.addEventListener('touchend', closeTouchDragElement);
            document.addEventListener('touchmove', touchElementDrag, { passive: false });
        }

        function touchElementDrag(e) {
            // Hanya izinkan drag jika satu jari aktif
            if (e.touches.length !== 1) return;
            e.preventDefault();

            const touch = e.targetTouches[0] || e.touches[0];
            if (!touch) return;

            // Hitung selisih pergerakan sentuh dari awal sentuhan
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;

            // Terapkan sedikit dampening (0.9) khusus layar sentuh mobile agar stabil & empuk
            const dampening = 0.9;
            const newLeft = startLeft + (deltaX * dampening);
            const newTop = startTop + (deltaY * dampening);

            const maxLeft = window.innerWidth - dragEl.offsetWidth;
            const maxTop = window.innerHeight - dragEl.offsetHeight;

            dragEl.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + "px";
            dragEl.style.top = Math.max(0, Math.min(newTop, maxTop)) + "px";
            dragEl.style.bottom = "auto";
            dragEl.style.right = "auto";
        }

        // Touch end
        function closeTouchDragElement() {
            document.removeEventListener('touchend', closeTouchDragElement);
            document.removeEventListener('touchmove', touchElementDrag);
        }
    }

    makePIPDraggable(pipEl, containerEl) {
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;
        let currentLeft = 0, currentTop = 0;

        pipEl.addEventListener('mousedown', dragMouseDown);
        pipEl.addEventListener('touchstart', dragTouchStart, { passive: false });

        function dragMouseDown(e) {
            e.preventDefault();
            // Clear any active transition so the drag is responsive
            pipEl.style.transition = '';

            startX = e.clientX;
            startY = e.clientY;

            const rect = pipEl.getBoundingClientRect();
            const parentRect = containerEl.getBoundingClientRect();

            startLeft = rect.left - parentRect.left;
            startTop = rect.top - parentRect.top;
            currentLeft = startLeft;
            currentTop = startTop;

            document.addEventListener('mouseup', closeDragElement);
            document.addEventListener('mousemove', elementDrag);
        }

        function elementDrag(e) {
            e.preventDefault();

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;

            const maxLeft = containerEl.clientWidth - pipEl.offsetWidth;
            const maxTop = containerEl.clientHeight - pipEl.offsetHeight;

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            currentLeft = newLeft;
            currentTop = newTop;

            pipEl.style.left = newLeft + 'px';
            pipEl.style.top = newTop + 'px';
            pipEl.style.bottom = 'auto';
            pipEl.style.right = 'auto';
        }

        function closeDragElement() {
            document.removeEventListener('mouseup', closeDragElement);
            document.removeEventListener('mousemove', elementDrag);
            snapToCorner();
        }

        // Touch support
        function dragTouchStart(e) {
            if (e.touches.length !== 1) return;
            // Clear any active transition so the drag is responsive
            pipEl.style.transition = '';

            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;

            const rect = pipEl.getBoundingClientRect();
            const parentRect = containerEl.getBoundingClientRect();

            startLeft = rect.left - parentRect.left;
            startTop = rect.top - parentRect.top;
            currentLeft = startLeft;
            currentTop = startTop;

            document.addEventListener('touchend', closeTouchDragElement);
            document.addEventListener('touchmove', touchElementDrag, { passive: false });
        }

        // Touch drag
        function touchElementDrag(e) {
            if (e.touches.length !== 1) return;
            e.preventDefault();

            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;

            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;

            const maxLeft = containerEl.clientWidth - pipEl.offsetWidth;
            const maxTop = containerEl.clientHeight - pipEl.offsetHeight;

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            currentLeft = newLeft;
            currentTop = newTop;

            pipEl.style.left = newLeft + 'px';
            pipEl.style.top = newTop + 'px';
            pipEl.style.bottom = 'auto';
            pipEl.style.right = 'auto';
        }

        function closeTouchDragElement() {
            document.removeEventListener('touchend', closeTouchDragElement);
            document.removeEventListener('touchmove', touchElementDrag);
            snapToCorner();
        }

        function snapToCorner() {
            const pad = 12; // 12px padding dari batas layar video
            const midX = containerEl.clientWidth / 2;
            const midY = containerEl.clientHeight / 2;

            const pipCenterX = currentLeft + pipEl.offsetWidth / 2;
            const pipCenterY = currentTop + pipEl.offsetHeight / 2;

            let targetLeft = pad;
            let targetTop = pad;

            if (pipCenterX < midX) {
                targetLeft = pad;
            } else {
                targetLeft = containerEl.clientWidth - pipEl.offsetWidth - pad;
            }

            if (pipCenterY < midY) {
                targetTop = pad;
            } else {
                targetTop = containerEl.clientHeight - pipEl.offsetHeight - pad;
            }

            // Pasang transisi animasi meluncur halus ke pojok terdekat
            pipEl.style.transition = 'left 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), top 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
            pipEl.style.left = targetLeft + 'px';
            pipEl.style.top = targetTop + 'px';

            // Bersihkan transisi setelah animasi selesai agar seretan berikutnya instan tanpa hambatan
            setTimeout(() => {
                if (pipEl.style.transition.includes('left')) {
                    pipEl.style.transition = '';
                }
            }, 350);
        }
    }

    closeMobileMenu() {
        const mobileMenu = document.getElementById('mobile-menu');
        if (mobileMenu && !mobileMenu.classList.contains('hidden')) {
            mobileMenu.classList.add('hidden');
            mobileMenu.classList.remove('flex');
        }

        // Force restore scrolling capability on body and html elements
        try {
            document.body.classList.remove('overflow-hidden', 'overflow-y-hidden');
            document.documentElement.classList.remove('overflow-hidden', 'overflow-y-hidden');
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
            // Force a browser reflow/repaint
            document.body.offsetHeight;
        } catch (err) {
            console.warn('closeMobileMenu scroll restoration failed:', err);
        }
    }

    // --------------------------------------------------------
    // WEB AUDIO API SYNTHESIZER (NADA DERING & SAMBUNG DARI BROWSER)
    // --------------------------------------------------------
    initAudioContext() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    playTone(frequency, duration, type = 'sine') {
        try {
            this.initAudioContext();
            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
            const osc = this.audioCtx.createOscillator();
            const gainNode = this.audioCtx.createGain();

            osc.type = type;
            osc.frequency.setValueAtTime(frequency, this.audioCtx.currentTime);

            // Efek fade-in & fade-out lembut
            gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.2, this.audioCtx.currentTime + 0.05);
            gainNode.gain.setValueAtTime(0.2, this.audioCtx.currentTime + duration - 0.05);
            gainNode.gain.linearRampToValueAtTime(0, this.audioCtx.currentTime + duration);

            osc.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            osc.start();
            osc.stop(this.audioCtx.currentTime + duration);
        } catch (e) {
            console.error("Synthesizer error:", e);
        }
    }

    startDialingSound() {
        this.stopSounds();
        // Nada Sambung Keluar (Tut... Tut...)
        this.synthInterval = setInterval(() => {
            this.playTone(440, 0.8, 'sine');
        }, 2000);
    }

    startRingingSound() {
        this.stopSounds();
        // Nada Dering Masuk (Kring... Kring...)
        this.synthInterval = setInterval(() => {
            this.playTone(480, 0.2, 'triangle');
            setTimeout(() => {
                this.playTone(440, 0.2, 'triangle');
            }, 250);
        }, 1500);
    }

    playHangupSound() {
        this.stopSounds();
        // Nada Tutup Panggilan (Descending Pitch)
        try {
            this.initAudioContext();
            const osc = this.audioCtx.createOscillator();
            const gainNode = this.audioCtx.createGain();
            osc.frequency.setValueAtTime(350, this.audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(150, this.audioCtx.currentTime + 0.5);
            gainNode.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0, this.audioCtx.currentTime + 0.5);
            osc.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.5);
        } catch (e) { }
    }

    stopSounds() {
        if (this.synthInterval) {
            clearInterval(this.synthInterval);
            this.synthInterval = null;
        }
    }

    // --------------------------------------------------------
    // POLLING ENGINE (SINKRONISASI STATUS VIA AJAX)
    // --------------------------------------------------------
    startIdlePolling() {
        this.stopPolling();
        // Polling dinonaktifkan sepenuhnya standby guna menghemat hits database
    }

    startActivePolling() {
        this.stopPolling();
        // Polling ringan setiap 10 detik selama panggilan aktif:
        // - Mendeteksi jika pasangan tiba-tiba disconnect tanpa sinyal Pusher
        // - Mereset consecutiveIdleCount jika server masih 'active'
        // - Tidak terlalu agresif sehingga tidak membebani hit limit hosting
        this.pollInterval = setInterval(() => {
            this.pollCallStatus();
        }, 10000);
    }

    startReconnectingPolling() {
        this.stopPolling();
        // Polling lebih sering saat reconnecting (setiap 5 detik)
        this.pollInterval = setInterval(() => {
            this.pollCallStatus();
        }, 5000);
    }

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // SESI LINTAS TAB (localStorage Session Lock)
    // Mencegah beberapa tab saling berkonflik memperebutkan satu panggilan
    // ─────────────────────────────────────────────────────────────

    _parseSession(raw) {
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    }

    _isSessionOwner() {
        // Pada aplikasi native, tab ini selalu memegang hak kepemilikan mutlak karena hanya ada satu instance WebView.
        if (window.cordova || window.Capacitor) return true;
        const session = this._parseSession(localStorage.getItem(this.callSessionKey));
        return session && session.tabId === this.tabId;
    }

    isCallOwnedByOtherTab(callId) {
        // Pada aplikasi native, tidak ada konflik lintas-tab.
        if (window.cordova || window.Capacitor) return false;
        const session = this._parseSession(localStorage.getItem(this.callSessionKey));
        if (!session) return false;
        // Anggap sesi sudah kedaluwarsa jika tidak ada heartbeat dalam 8 detik
        if (Date.now() - session.timestamp > 8000) {
            localStorage.removeItem(this.callSessionKey);
            return false;
        }
        return session.tabId !== this.tabId && session.callId === callId;
    }

    claimCallSession(callId, status) {
        const session = { tabId: this.tabId, callId, status, timestamp: Date.now() };
        localStorage.setItem(this.callSessionKey, JSON.stringify(session));
        // Mulai heartbeat agar tab lain tahu sesi ini masih hidup
        if (this._sessionHeartbeat) clearInterval(this._sessionHeartbeat);
        this._sessionHeartbeat = setInterval(() => {
            if (this._isSessionOwner()) {
                const current = this._parseSession(localStorage.getItem(this.callSessionKey));
                if (current) {
                    current.timestamp = Date.now();
                    current.status = this.status;
                    localStorage.setItem(this.callSessionKey, JSON.stringify(current));
                }
            } else {
                clearInterval(this._sessionHeartbeat);
                this._sessionHeartbeat = null;
            }
        }, 3000);
    }

    releaseCallSession() {
        if (this._sessionHeartbeat) {
            clearInterval(this._sessionHeartbeat);
            this._sessionHeartbeat = null;
        }
        // Hanya hapus sesi jika tab ini yang memilikinya
        if (this._isSessionOwner()) {
            localStorage.removeItem(this.callSessionKey);
        }
    }

    async pollCallStatus() {
        try {
            const res = await fetch(`${this.baseUrl}/call/poll`, { method: 'POST' });
            const data = await res.json();

            // Simpan data polling terakhir untuk pemulihan manual
            this.lastPolledData = data;

            // ─── DETEKSI PANGGILAN MASUK ──────────────────────────────
            // Cek incoming call TERLEBIH DAHULU, tanpa peduli status lokal saat ini.
            // Ini fix bug utama: jika client statusnya bukan 'idle' (misal habis call
            // atau ada state stale), incoming call tetap harus bisa terdeteksi.
            if (data.status === 'ringing' && data.role === 'receiver') {
                // Reset counter toleransi karena server mendeteksi status valid
                this.consecutiveIdleCount = 0;

                // Jika kita sudah dalam state 'ringing' dengan call_id yang sama,
                // jangan tampilkan modal lagi (hindari duplicate)
                if (this.status !== 'ringing' || this.callId !== data.call_id) {
                    // PENTING: Jangan terminateCallLocally jika kita sedang dialing atau active
                    // sebagai CALLER — itu berarti data polling ini bukan untuk kita (2 user berbeda)
                    // atau ada bug sinkronisasi role di server.
                    if (this.status !== 'idle' && this.status !== 'dialing' && this.status !== 'active') {
                        this.terminateCallLocally();
                    } else if (this.status === 'idle') {
                        // Hanya tampilkan incoming jika kita memang idle (tidak sedang menelepon)
                        this.showIncomingUI(data);
                    }
                    // Jika status 'dialing'/'active', berarti user ini yang menelepon — abaikan sinyal ringing ini
                    if (this.status === 'idle') return;
                } else {
                    // Sudah menampilkan ringing untuk call_id yang sama — tidak perlu apa-apa
                }
                return; // Jangan proses blok lain
            }

            // ─── JIKA CLIENT SEDANG IDLE ──────────────────────────────
            if (this.status === 'idle') {
                this.consecutiveIdleCount = 0;

                if (data.status === 'active' && data.call_id && !this._reconnecting) {
                    // ── ANTI-FLICKER: Jangan reconnect jika tab lain sudah pegang sesi ini ──
                    if (this.isCallOwnedByOtherTab(data.call_id)) {
                        console.log('[Call] Tab lain sedang aktif untuk call #' + data.call_id + ' — lewati reconnect.');
                        this.showTransferCallUI(data);
                        return;
                    }

                    // ── SMART RECOVERY: Jangan reconnect jika pasangan terdeteksi sedang me-reload halaman ──
                    const partnerCandidates = (this.role === 'caller') ? data.ice_candidates_receiver : data.ice_candidates_caller;
                    if (partnerCandidates && Array.isArray(partnerCandidates)) {
                        const isPartnerReloading = partnerCandidates.some(c => c && c.reloading === true);
                        if (isPartnerReloading) {
                            console.log('[Call] Menunda reconnect karena pasangan masih dalam proses reload...');
                            return;
                        }
                    }

                    // ── ANTI-FLICKER: Jangan reconnect jika ID ini sudah pernah gagal ──
                    if (this.failedReconnectIds.has(data.call_id)) {
                        console.log('[Call] Call #' + data.call_id + ' ada di blocklist gagal — lewati reconnect.');
                        return;
                    }
                    // ── ANTI-FLICKER: Di native app (Capacitor/Cordova), reconnect harus tetap berjalan meski di background ──
                    // Di browser biasa (PWA), tunda reconnect jika tab tidak terlihat untuk menghemat resource.
                    const isNativeApp = !!(window.cordova || window.Capacitor);
                    if (!isNativeApp && document.visibilityState !== 'visible') {
                        console.log('[Call] Tab browser tidak aktif — tunda reconnect hingga tab terlihat.');
                        return;
                    }
                    console.log('[Call] Panggilan aktif terdeteksi saat idle — menyambungkan kembali...');
                    this.reconnectActiveCall(data);
                }
                return;
            }

            // ─── CLIENT SEDANG AKTIF (DIALING / RINGING / ACTIVE) ────
            if (data.status === 'idle' || data.status === 'ended' || data.status === 'declined') {
                this.hideTransferCallUI();

                // Debounce toleransi: DB di hosting gratis lambat/lag, kadang mengembalikan status kosong untuk 1-2 kali polling.
                // Kita hanya menutup panggilan jika menerima status mati sebanyak 3 kali berturut-turut (total ~4.5 detik).
                this.consecutiveIdleCount = (this.consecutiveIdleCount || 0) + 1;
                console.log(`[Call] Menerima status non-aktif (${data.status}). Menghitung toleransi: ${this.consecutiveIdleCount}/5`);

                if (this.consecutiveIdleCount >= 5) {
                    this.consecutiveIdleCount = 0;
                    const wasDeclined = data.status === 'declined';
                    this.terminateCallLocally(wasDeclined ? '' : 'Panggilan diakhiri.');
                    if (wasDeclined) {
                        if (typeof showAlert !== 'undefined') {
                            showAlert('Panggilan ditolak oleh pasangan.', 'Panggilan Ditolak', 'error');
                        } else {
                            alert('Panggilan ditolak oleh pasangan.');
                        }
                    }
                }
            } else {
                // Reset counter jika menerima status valid (ringing/active)
                this.consecutiveIdleCount = 0;

                if (data.status === 'ringing' && data.role === 'caller') {
                    // Caller masih menunggu — pasangan belum menjawab, biarkan terus dialing
                    // Tidak perlu action, polling berikutnya akan cek lagi
                } else if (this.status === 'dialing' && data.status === 'active') {
                    // Pasangan telah menjawab!
                    if (data.sdp_answer) {
                        this.currentSdpAnswer = data.sdp_answer;
                    }
                    if (data.sdp_offer) {
                        this.currentSdpOffer = data.sdp_offer;
                    }
                    this.handleCallAnswered(data);
                } else if (this.status === 'active' || this.status === 'dialing') {
                    // ── MUTUAL RECONNECT: Deteksi jika pasangan melakukan reconnect / reload ──
                    if (data.status === 'active') {
                        if (this.role === 'caller') {
                            // Skenario 2: CALLER mendeteksi jika RECEIVER (B) mengunggah answer baru
                            if (data.sdp_answer && data.sdp_answer !== this.currentSdpAnswer) {
                                if (this.currentSdpAnswer !== null) {
                                    // Ini adalah answer baru akibat Receiver melakukan reconnect/reload halaman!
                                    // Kita harus me-recreate PeerConnection kita agar DTLS handshake bersih dan segar!
                                    console.warn('[Call Signaling] Receiver (B) melakukan reconnect. Menghancurkan koneksi lama untuk negosiasi ulang bersih...');
                                    this.currentSdpAnswer = data.sdp_answer;

                                    if (this.peerConnection) {
                                        this.peerConnection.close();
                                        this.peerConnection = null;
                                    }
                                    this.status = 'idle';

                                    // Panggil reconnectActiveCall sebagai caller untuk mengunggah Offer baru
                                    this.reconnectActiveCall(data);
                                    return;
                                } else {
                                    // Answer awal panggilan (pertama kali terhubung)
                                    console.log('[Call Signaling] Remote answer awal diterima. Menyambungkan panggilan...');
                                    this.currentSdpAnswer = data.sdp_answer;

                                    try {
                                        await this.peerConnection.setRemoteDescription(
                                            new RTCSessionDescription({ type: 'answer', sdp: data.sdp_answer })
                                        );
                                        // Bersihkan candidates lama dan sync candidates baru
                                        this.processedCandidates.clear();
                                        this.syncIceCandidates(data);
                                        await this.flushPendingCandidates();

                                        this.status = 'active';
                                        this.claimCallSession(this.callId, 'active');
                                        this.setCallUIState('active', 'Terhubung');
                                        this.startTimer();
                                    } catch (err) {
                                        console.error('[Call Signaling] Gagal memasang remote answer awal:', err);
                                    }
                                }
                                return;
                            }
                        } else if (this.role === 'receiver') {
                            // RECEIVER mendeteksi jika CALLER (A) me-reload halaman (membuat offer baru)
                            if (data.sdp_offer && data.sdp_offer !== this.currentSdpOffer) {
                                console.warn('[Call Signaling] Caller (A) memperbarui offer. Receiver melakukan negosiasi ulang balik...');
                                this.currentSdpOffer = data.sdp_offer;

                                try {
                                    if (this.peerConnection) {
                                        this.peerConnection.close();
                                        this.peerConnection = null;
                                    }
                                    this.status = 'idle';
                                    this.reconnectActiveCall(data);
                                } catch (err) {
                                    console.error('[Call Signaling] Gagal memproses tawaran negosiasi ulang:', err);
                                }
                                return;
                            }
                        }
                    }

                    // Sinkronisasi ICE Candidates secara terus-menerus
                    this.syncIceCandidates(data);

                    // Deteksi jika koneksi WebRTC lokal terputus/gagal sedangkan server masih aktif
                    if (this.peerConnection) {
                        const ice = this.peerConnection.iceConnectionState;
                        const conn = this.peerConnection.connectionState;

                        // Jika status koneksi failed/disconnected
                        if (ice === 'failed' || conn === 'failed' || ice === 'disconnected') {
                            // Catat waktu pertama kali terputus
                            if (!this._disconnectStartTime) {
                                this._disconnectStartTime = Date.now();
                                console.warn(`[Call] Koneksi terputus (ICE: ${ice}, Conn: ${conn}). Memulai toleransi pemulihan 5 detik...`);
                                // Ubah UI ke status oranye dinamis sesegera mungkin
                                this.handleConnectionStateChange(ice, conn);
                            }

                            const elapsed = Date.now() - this._disconnectStartTime;

                            // Jika terputus sudah lebih dari 5 detik ATAU status koneksi failed permanen
                            if (elapsed >= 5000 || ice === 'failed' || conn === 'failed') {
                                console.warn(`[Call] Batas toleransi terlampaui (${elapsed}ms). Memaksa rekonstruksi peer connection...`);
                                this._disconnectStartTime = null;

                                // Hancurkan koneksi lokal lama yang rusak secara diam-diam tanpa mematikan sesi di server
                                if (this.localStream) {
                                    this.localStream.getTracks().forEach(track => track.stop());
                                    this.localStream = null;
                                }
                                this.peerConnection.close();
                                this.peerConnection = null;

                                // Set status ke 'idle' agar reconnectActiveCall bersedia memproses ulang
                                this.status = 'idle';
                                this.reconnectActiveCall(data);
                            }
                        } else {
                            // Reset timer jika koneksi kembali sehat
                            this._disconnectStartTime = null;
                        }
                    }
                }
            }

            // SELALU update info avatar pasangan di overlay jika tersedia
            if (data.partner_name) {
                this.updateOverlayDetails(data.partner_name, data.partner_avatar || '');
            }

        } catch (e) {
            console.error('Gagal melakukan polling panggilan:', e);
        }
    }

    // --------------------------------------------------------
    // RECONNECT: Sambungkan kembali setelah tab reload / background kill
    // Dipanggil saat this.status === 'idle' tapi server melaporkan call masih 'active'.
    // Ini terjadi terutama di iOS/Android saat browser kill tab, lalu user kembali.
    // --------------------------------------------------------
    async reconnectActiveCall(data) {
        if (this._reconnecting) return;

        // ── ANTI-FLICKER: Pengecekan ganda sebelum benar-benar memulai ──
        if (this.isCallOwnedByOtherTab(data.call_id)) {
            console.log('[Call Reconnect] Tab lain sudah pegang sesi — dibatalkan.');
            return;
        }
        if (this.failedReconnectIds.has(data.call_id)) {
            console.log('[Call Reconnect] Call #' + data.call_id + ' ada di blocklist — dibatalkan.');
            return;
        }

        this._reconnecting = true;

        const role = data.role; // 'caller' atau 'receiver'
        if (!role || !data.call_id) {
            this._reconnecting = false;
            return;
        }

        console.log(`[Call Reconnect] Memulai reconnect sebagai ${role} untuk call #${data.call_id}`);

        try {
            // Pastikan mediaDevices didukung (HTTPS required di hosting)
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.warn('[Call Reconnect] getUserMedia tidak tersedia.');
                this._reconnecting = false;
                return;
            }

            this.callType = data.call_type || data.type || 'audio';

            // Ambil media dengan constraints dinamis
            const constraints = {
                audio: this.getAudioConstraints()
            };
            if (this.callType === 'video') {
                constraints.video = {
                    facingMode: this.cameraFacingMode || 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                };
            }
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

            // Set state lokal
            this.callId = data.call_id;
            this.role = role;
            this.status = 'active';

            // Tampilkan widget sesuai state minimized terakhir
            const isMinimized = sessionStorage.getItem('hk_call_minimized') === 'true';
            if (isMinimized) {
                this.minimizeWidget();
            } else {
                this.showOverlay();
            }
            this.setCallUIState('active', 'Menyambungkan kembali...');
            this.updateVideoUI();
            if (data.partner_name) {
                this.updateOverlayDetails(data.partner_name, data.partner_avatar || '');
            }

            // Buat RTCPeerConnection baru
            this.peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.processedCandidates.clear();
            this.pendingRemoteCandidates = [];
            this.pendingLocalCandidates = [];

            // Pasang track lokal
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Bind preview video lokal untuk FaceTime style PIP
            if (this.callType === 'video') {
                const localVideo = document.getElementById('local-video');
                if (localVideo) {
                    localVideo.srcObject = this.localStream;
                }
            }

            // Pasang handler track remote (suara & video pasangan)
            this.peerConnection.ontrack = (event) => {
                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                } else {
                    if (!this.remoteStream) {
                        this.remoteStream = new MediaStream();
                    }
                    this.remoteStream.addTrack(event.track);
                }

                if (event.track.kind === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = this.remoteStream;
                        remoteVideo.play().catch(e => { });
                    }
                    const overlayRemoteVideo = document.getElementById('overlay-remote-video');
                    if (overlayRemoteVideo) {
                        overlayRemoteVideo.srcObject = this.remoteStream;
                        overlayRemoteVideo.play().catch(e => { });
                    }
                } else if (event.track.kind === 'audio') {
                    this.remoteAudio.srcObject = this.remoteStream;
                    this.applyAudioOutputDevice();
                    this.remoteAudio.play().catch(() => { });
                }
            };

            // Pasang ICE candidate handler
            this.peerConnection.onicecandidate = (event) => {
                this.handleLocalIceCandidate(event, role);
            };

            const updateDebugState = () => {
                const el = document.getElementById('call-debug-ice');
                if (el && this.peerConnection) {
                    const ice = this.peerConnection.iceConnectionState;
                    const conn = this.peerConnection.connectionState || 'unknown';
                    el.textContent = `ICE: ${ice} | CONN: ${conn}`;
                    if (ice === 'connected' || ice === 'completed') {
                        el.className = 'text-emerald-400 font-bold';
                    } else if (ice === 'failed') {
                        el.className = 'text-red-400 font-bold animate-pulse';
                    } else {
                        el.className = 'text-rose-400';
                    }
                }
            };

            this.peerConnection.oniceconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState;
                const conn = this.peerConnection?.connectionState || 'unknown';
                console.log(`[Call Reconnect] ICE state: ${ice} | Conn state: ${conn}`);
                this.handleConnectionStateChange(ice, conn);
            };

            this.peerConnection.onconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState || 'unknown';
                const conn = this.peerConnection?.connectionState;
                console.log(`[Call Reconnect] Connection state: ${conn}`);
                this.handleConnectionStateChange(ice, conn);
            };

            updateDebugState();

            if (role === 'receiver' && data.sdp_offer) {
                // RECEIVER RECONNECT: gunakan offer yang sudah ada di DB untuk langsung menjawab kembali
                this.currentSdpOffer = data.sdp_offer;

                await this.peerConnection.setRemoteDescription(
                    new RTCSessionDescription({ type: 'offer', sdp: data.sdp_offer })
                );

                // Sync ICE candidates caller yang sudah ada di DB
                this.syncIceCandidates(data);
                await this.flushPendingCandidates();

                // Buat answer baru
                const answer = await this.peerConnection.createAnswer();
                answer.sdp = this._optimizeSdpCodecs(answer.sdp);
                await this.peerConnection.setLocalDescription(answer);

                // Tunggu pengumpulan ICE kandidat (Vanilla ICE) agar tertanam di SDP
                await this.waitForIceGathering();
                const vanillaAnswerSdp = this.peerConnection.localDescription.sdp;

                this.currentSdpAnswer = vanillaAnswerSdp;

                // Kirim ICE local yang terkumpul
                await this.flushPendingLocalCandidates();

                // Kirim answer baru ke server (update DB)
                const fd = new FormData();
                fd.append('call_id', this.callId);
                fd.append('sdp_answer', vanillaAnswerSdp);
                await fetch(`${this.baseUrl}/call/accept`, { method: 'POST', body: fd });

                console.log('[Call Reconnect] Answer baru berhasil diunggah ke server.');

            } else if (role === 'caller') {
                // CALLER RECONNECT: Buat offer baru yang segar, membersihkan internal state
                const offer = await this.peerConnection.createOffer();
                offer.sdp = this._optimizeSdpCodecs(offer.sdp);
                await this.peerConnection.setLocalDescription(offer);

                // Tunggu pengumpulan ICE kandidat (Vanilla ICE) agar tertanam di SDP
                await this.waitForIceGathering();
                const vanillaOfferSdp = this.peerConnection.localDescription.sdp;

                this.currentSdpOffer = vanillaOfferSdp;
                this.currentSdpAnswer = null; // Menunggu answer baru dari receiver

                // Kirim ICE local
                await this.flushPendingLocalCandidates();

                // Kirim offer baru ke server (update DB)
                const fd = new FormData();
                fd.append('call_id', this.callId);
                fd.append('sdp_offer', vanillaOfferSdp);
                await fetch(`${this.baseUrl}/call/updateOffer`, { method: 'POST', body: fd });

                // Pancarkan sdp-offer secara instan via Pusher (Zero-Polling)
                const signalFd = new FormData();
                signalFd.append('call_id', this.callId);
                signalFd.append('signal', JSON.stringify({ type: 'sdp-offer', sdp: vanillaOfferSdp }));
                await fetch(`${this.baseUrl}/call/signal`, { method: 'POST', body: signalFd });

                console.log('[Call Reconnect] Offer baru berhasil diperbarui di server, menunggu Answer dari pasangan.');

            } else {
                // Data tidak cukup untuk reconnect
                console.warn('[Call Reconnect] Data SDP tidak cukup, menunda reconnect hingga polling berikutnya.');
                this.setCallUIState('reconnecting', 'Pasangan sedang menyambung kembali...');
                this._reconnecting = false;
                // JANGAN panggil terminateCallLocally agar UI pasangan A tidak ikut mati!
                return;
            }

            // Pasca-reconnect berbeda tergantung peran:
            if (role === 'receiver') {
                // Receiver sudah selesai: kirim answer baru, langsung terhubung
                this.claimCallSession(data.call_id, 'active');
                this.setCallUIState('active', 'Terhubung');
                this.startTimer();
                console.log('[Call Reconnect] Receiver berhasil menyambungkan kembali!');
            } else {
                // Caller sudah kirim offer baru, menunggu Receiver menjawab
                // setCallUIState & startTimer akan dipanggil nanti saat handleCallAnswered
                // dipicu oleh pendeteksian perubahan sdp_answer di pollCallStatus
                this.claimCallSession(data.call_id, 'reconnecting');
                this.setCallUIState('reconnecting', 'Menunggu pasangan menyambung kembali...');
                console.log('[Call Reconnect] Caller mengirim offer baru. Menunggu answer dari Receiver...');
            }
            this.startActivePolling();

            // Pastikan mode background aktif saat menyambungkan kembali
            if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
                window.cordova.plugins.backgroundMode.enable();
            }

        } catch (e) {
            console.error('[Call Reconnect] Gagal:', e);
            // JANGAN langsung matikan UI secara lokal agar tidak mematikan pasangan A.
            // Cukup tampilkan status oranye dan coba lagi di polling berikutnya.
            this.setCallUIState('reconnecting', 'Pasangan sedang menyambung kembali...');
        } finally {
            this._reconnecting = false;
        }
    }

    // --------------------------------------------------------
    // ALUR 1: MEMULAI TELEPON (CALLER SIDE)
    // --------------------------------------------------------
    async startCallFlow(type = 'audio') {
        this.closeMobileMenu();
        // Proteksi: Jangan bisa mulai panggilan jika sedang ada panggilan aktif
        if (this.status !== 'idle') {
            console.warn('startCallFlow diabaikan: sedang ada panggilan aktif, status =', this.status);
            return;
        }

        this.callType = type;

        // Pastikan mediaDevices didukung
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const errorMsg = 'Gagal mengakses mikrofon/kamera. Jika di server hosting, pastikan Anda menggunakan koneksi aman (HTTPS/SSL aktif) agar browser mengizinkan akses media.';
            if (window.showAlert) {
                window.showAlert(errorMsg, 'Akses Media Gagal', 'error');
            } else {
                alert(errorMsg);
            }
            return;
        }

        try {
            this.initAudioContext();
        } catch (e) {
            console.warn("Gagal inisialisasi AudioContext:", e);
        }
        sessionStorage.setItem('hk_call_minimized', 'false'); // Reset minimized state untuk panggilan baru
        this.showOverlay();
        this.setCallUIState('dialing', 'Menghubungkan pasangan...');
        this.updateVideoUI();

        // Segera tampilkan nama & foto pasangan saat overlay muncul
        try {
            const infoRes = await fetch(`${this.baseUrl}/call/poll`, { method: 'POST' });
            const infoData = await infoRes.json();
            if (infoData.partner_name) {
                this.updateOverlayDetails(infoData.partner_name, infoData.partner_avatar || '');
            }
        } catch (e) { /* Lanjutkan meskipun gagal */ }

        try {
            // 1. Ambil akses media lokal dengan constraints dinamis sesuai tipe
            const constraints = {
                audio: this.getAudioConstraints()
            };
            if (this.callType === 'video') {
                constraints.video = {
                    facingMode: this.cameraFacingMode || 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                };
            }
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

            // 2. Buat objek RTCPeerConnection
            this.peerConnection = new RTCPeerConnection(this.rtcConfig);

            const updateDebugState = () => {
                const el = document.getElementById('call-debug-ice');
                if (el && this.peerConnection) {
                    const ice = this.peerConnection.iceConnectionState;
                    const conn = this.peerConnection.connectionState || 'unknown';
                    el.textContent = `ICE: ${ice} | CONN: ${conn}`;
                    if (ice === 'connected' || ice === 'completed') {
                        el.className = 'text-emerald-400 font-bold';
                    } else if (ice === 'failed') {
                        el.className = 'text-red-400 font-bold animate-pulse';
                    } else {
                        el.className = 'text-rose-400';
                    }
                }
            };
            this.peerConnection.oniceconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState;
                const conn = this.peerConnection?.connectionState || 'unknown';
                console.log('[WebRTC Caller] ICE state:', ice);

                this.handleConnectionStateChange(ice, conn);

                // ICE Restart otomatis saat koneksi putus / gagal
                if ((ice === 'disconnected' || ice === 'failed') && !this.iceRestartInProgress) {
                    this.iceRestartInProgress = true;
                    console.warn('[WebRTC Caller] ICE', ice, '— mencoba ICE restart...');
                    setTimeout(async () => {
                        if (this.peerConnection && this.status === 'active') {
                            try {
                                const restartOffer = await this.peerConnection.createOffer({ iceRestart: true });
                                restartOffer.sdp = this._optimizeSdpCodecs(restartOffer.sdp);
                                await this.peerConnection.setLocalDescription(restartOffer);
                                // Kirim offer baru ke server untuk restart ICE
                                const fd = new FormData();
                                fd.append('sdp_offer', restartOffer.sdp);
                                // Hanya log — server polling akan sync otomatis
                                console.log('[WebRTC Caller] ICE restart offer dibuat, menunggu sync polling.');
                            } catch (err) {
                                console.error('[WebRTC Caller] ICE restart gagal:', err);
                            }
                        }
                        this.iceRestartInProgress = false;
                    }, 2000);
                }
            };
            this.peerConnection.onconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState || 'unknown';
                const conn = this.peerConnection?.connectionState;
                console.log('[WebRTC Caller] Connection state:', conn);
                this.handleConnectionStateChange(ice, conn);
            };
            updateDebugState();

            // Tambahkan track lokal ke koneksi
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Bind preview video lokal untuk FaceTime style PIP
            if (this.callType === 'video') {
                const localVideo = document.getElementById('local-video');
                if (localVideo) {
                    localVideo.srcObject = this.localStream;
                }
            }

            // Handle track remote masuk (suara & video pasangan)
            this.peerConnection.ontrack = (event) => {
                console.log("Menerima track remote (caller):", event.track.kind);
                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                } else {
                    if (!this.remoteStream) {
                        this.remoteStream = new MediaStream();
                    }
                    this.remoteStream.addTrack(event.track);
                }

                if (event.track.kind === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = this.remoteStream;
                        remoteVideo.play().catch(e => { });
                        
                        // Deteksi instan rotasi/perubahan dimensi stream screen share
                        remoteVideo.onresize = () => {
                            if (this._remoteScreenSharing) {
                                console.log(`[ScreenShare Video] Deteksi onresize pada remote-video (caller): ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
                                this.adjustScreenShareLayout();
                            }
                        };
                    }
                    const overlayRemoteVideo = document.getElementById('overlay-remote-video');
                    if (overlayRemoteVideo) {
                        overlayRemoteVideo.srcObject = this.remoteStream;
                        overlayRemoteVideo.play().catch(e => { });
                        
                        // Deteksi instan rotasi/perubahan dimensi stream screen share di overlay
                        overlayRemoteVideo.onresize = () => {
                            if (this._remoteScreenSharing) {
                                console.log(`[ScreenShare Video] Deteksi onresize pada overlay-remote-video (caller): ${overlayRemoteVideo.videoWidth}x${overlayRemoteVideo.videoHeight}`);
                                this.adjustScreenShareLayout();
                            }
                        };
                    }
                } else if (event.track.kind === 'audio') {
                    this.remoteAudio.srcObject = this.remoteStream;
                    this.applyAudioOutputDevice();

                    // Menembus kebijakan Autoplay browser mobile
                    this.remoteAudio.play().catch(err => {
                        console.warn("Autoplay ditolak browser, memasang fallback tap/click:", err);
                        const resumeAudio = () => {
                            this.remoteAudio.play().catch(e => { });
                            document.removeEventListener('click', resumeAudio);
                            document.removeEventListener('touchstart', resumeAudio);
                        };
                        document.addEventListener('click', resumeAudio);
                        document.addEventListener('touchstart', resumeAudio);
                    });
                }
            };

            // Kumpulkan local ICE Candidates
            this.peerConnection.onicecandidate = (event) => {
                this.handleLocalIceCandidate(event, 'caller');
            };

            // 3. Buat SDP Offer
            const offer = await this.peerConnection.createOffer();
            offer.sdp = this._optimizeSdpCodecs(offer.sdp);
            await this.peerConnection.setLocalDescription(offer);

            // Tunggu pengumpulan ICE kandidat (Vanilla ICE) agar tertanam di SDP
            await this.waitForIceGathering();
            const vanillaOfferSdp = this.peerConnection.localDescription.sdp;

            // 4. Kirim SDP Offer ke server
            const formData = new FormData();
            formData.append('sdp_offer', vanillaOfferSdp);
            formData.append('type', this.callType);

            const res = await fetch(`${this.baseUrl}/call/initiate`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.status === 'success') {
                this.callId = data.call_id;
                this.role = 'caller';
                this.status = 'dialing';
                this.currentSdpOffer = vanillaOfferSdp;
                this.currentSdpAnswer = null;

                if (typeof window.triggerPartnerNotification === 'function') {
                    const callTypeName = this.callType === 'video' ? 'Video' : 'Suara';
                    window.triggerPartnerNotification(`Telepon Masuk 📞`, `Sayang memanggilmu via Panggilan ${callTypeName}. Ketuk untuk menjawab!`, `call_notif`);
                }

                // Klaim sesi agar tab lain tidak berebut koneksi
                this.claimCallSession(data.call_id, 'dialing');
                // Bersihkan blocklist untuk call baru ini (fresh start)
                this.failedReconnectIds.delete(data.call_id);

                // Aktifkan mode background agar mesin JS tidak dibekukan Android
                if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
                    const bgMode = window.cordova.plugins.backgroundMode;
                    bgMode.enable();
                    bgMode.configure({
                        title: 'Panggilan HubunganKita',
                        text: 'Panggilan sedang berlangsung...',
                        icon: 'icon',
                        color: 'F53D3D',
                        isCall: true,
                        callerName: (data && data.partner_name) ? data.partner_name : 'Pasangan'
                    }, true);
                }
                // Beritahu native layer bahwa panggilan aktif (untuk gating PiP)
                this._setNativeCallFlag(true);

                this.setCallUIState('dialing', 'Memanggil pasangan Anda...');
                if (data.partner_name) {
                    this.updateOverlayDetails(data.partner_name, data.partner_avatar || '');
                }

                try {
                    this.startDialingSound();
                } catch (e) {
                    console.warn("Gagal memainkan nada sambung:", e);
                }

                this.startActivePolling();

                try {
                    // Kirim local candidates yang terkumpul sebelum callId siap
                    await this.flushPendingLocalCandidates();
                } catch (e) {
                    console.warn("Gagal mengirim ICE Candidates awal:", e);
                }
            } else {
                this.terminateCallLocally(data.message);
            }

        } catch (e) {
            console.error("Gagal memulai telepon:", e);
            this.terminateCallLocally("Akses mikrofon/kamera ditolak atau dibatalkan.");
        }
    }

    // --------------------------------------------------------
    // ALUR 2: MENANGANI PANGGILAN MASUK (RECEIVER SIDE)
    // --------------------------------------------------------
    showIncomingUI(data) {
        this.closeMobileMenu();
        this.callId = data.call_id;
        this.role = 'receiver';
        this.status = 'ringing';
        this.callType = data.call_type || data.type || 'audio';

        if (data.sdp_offer) {
            this.currentSdpOffer = data.sdp_offer;
        }

        // Tampilkan Modal Panggilan Masuk melayang
        const modal = document.getElementById('incoming-call-modal');
        const callerName = document.getElementById('incoming-caller-name');
        const callerAvatar = document.getElementById('incoming-caller-avatar');
        const typeLabel = document.getElementById('incoming-call-type-label');

        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }
        if (callerName) callerName.textContent = data.caller_name;

        if (typeLabel) {
            typeLabel.textContent = this.callType === 'video' ? 'Panggilan Video masuk...' : 'Panggilan Suara masuk...';
        }

        if (callerAvatar) {
            let avatarUrl = data.caller_avatar;
            if (avatarUrl && (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) && !avatarUrl.includes('images.weserv.nl')) {
                avatarUrl = 'https://images.weserv.nl/?url=' + encodeURIComponent(avatarUrl);
            }
            callerAvatar.onerror = () => {
                callerAvatar.src = 'https://api.dicebear.com/7.x/adventurer/svg?seed=' + encodeURIComponent(data.caller_name || 'Pasangan');
            };
            callerAvatar.src = avatarUrl || 'https://api.dicebear.com/7.x/adventurer/svg?seed=' + encodeURIComponent(data.caller_name || 'Pasangan');
        }

        this.incomingCallerName = data.caller_name;
        this.incomingCallerAvatar = data.caller_avatar;

        // Bawa aplikasi ke depan (Foreground) secara otomatis jika sedang diminimize (untuk Capacitor APK)
        if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
            try {
                window.cordova.plugins.backgroundMode.moveToForeground();
            } catch (err) {
                console.warn('[Call] Gagal memindahkan ke foreground:', err);
            }
        }

        // Kirim notifikasi banner lokal jika aplikasi sedang di latar belakang
        const isMinimized = document.hidden || (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode && window.cordova.plugins.backgroundMode.isActive());

        if (isMinimized) {
            // Skenario A ditonaktifkan (di-comment) karena APK sudah menerima notifikasi FCM real-time via Vercel Bridge.
            // Jika memicu LocalNotifications lagi, pengguna akan menerima notifikasi ganda (FCM + Lokal).
            /*
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
                try {
                    window.Capacitor.Plugins.LocalNotifications.schedule({
                        notifications: [
                            {
                                title: '📞 Panggilan Masuk',
                                body: data.caller_name + ' memanggil Anda...',
                                id: 9999,
                                sound: null,
                                extra: {
                                    call_id: data.call_id
                                }
                            }
                        ]
                    });
                } catch (err) {
                    console.warn('[Call] Gagal mengirim LocalNotification native:', err);
                }
            }
            */
            // Skenario B: Jika di browser / PWA standar
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                try {
                    const notif = new Notification('📞 Panggilan Masuk', {
                        body: data.caller_name + ' memanggil Anda...',
                        icon: data.caller_avatar || '/assets/img/logo.png',
                        tag: 'incoming-call',
                        requireInteraction: true
                    });
                    notif.onclick = () => {
                        window.focus();
                        if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
                            window.cordova.plugins.backgroundMode.moveToForeground();
                        }
                    };

                    // Simpan instansi agar bisa ditutup otomatis jika dibatalkan caller
                    this._incomingLocalNotif = notif;
                } catch (err) {
                    console.warn('[Call] Gagal membuat notifikasi HTML5:', err);
                }
            }
        }

        this.startRingingSound();
        this.startActivePolling();
    }

    async acceptCallFlow() {
        this.stopSounds();
        this.hideIncomingModal();

        // Pastikan mediaDevices didukung
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const errorMsg = 'Gagal menerima panggilan: Browser Anda memblokir akses media. Jika di server hosting, pastikan koneksi aman (HTTPS/SSL aktif).';
            if (window.showAlert) {
                window.showAlert(errorMsg, 'Akses Media Gagal', 'error');
            } else {
                alert(errorMsg);
            }
            return;
        }

        sessionStorage.setItem('hk_call_minimized', 'false'); // Reset minimized state untuk panggilan baru
        this.showOverlay();
        this.openExpandModal();
        if (this.incomingCallerName && this.incomingCallerAvatar) {
            this.updateOverlayDetails(this.incomingCallerName, this.incomingCallerAvatar);
        }
        this.setCallUIState('active', 'Menghubungkan...');

        try {
            // Ambil detail panggilan (gunakan data sdp_offer memori jika tersedia untuk hemat hit database)
            let callData = null;
            if (this.currentSdpOffer && this.callId) {
                callData = {
                    status: 'ringing',
                    call_id: this.callId,
                    call_type: this.callType,
                    sdp_offer: this.currentSdpOffer,
                    caller_name: this.incomingCallerName,
                    caller_avatar: this.incomingCallerAvatar
                };
            } else {
                const checkRes = await fetch(`${this.baseUrl}/call/poll`, { method: 'POST' });
                callData = await checkRes.json();
            }

            if (callData.status !== 'ringing') {
                this.terminateCallLocally("Panggilan sudah kedaluwarsa atau dibatalkan.");
                return;
            }

            // Pastikan callId & callType tersinkronisasi sempurna
            this.callId = callData.call_id;
            this.role = 'receiver';
            this.callType = callData.call_type || callData.type || 'audio';
            this.updateVideoUI();

            if (!this.incomingCallerName && callData.caller_name) {
                this.incomingCallerName = callData.caller_name;
            }
            if (!this.incomingCallerAvatar && callData.caller_avatar) {
                this.incomingCallerAvatar = callData.caller_avatar;
            }
            if (this.incomingCallerName) {
                this.updateOverlayDetails(this.incomingCallerName, this.incomingCallerAvatar || '');
            }

            // 1. Ambil akses media lokal dengan constraints dinamis
            const constraints = {
                audio: this.getAudioConstraints()
            };
            if (this.callType === 'video') {
                constraints.video = {
                    facingMode: this.cameraFacingMode || 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                };
            }
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

            // 2. Inisialisasi Peer Connection
            this.peerConnection = new RTCPeerConnection(this.rtcConfig);

            const updateDebugState = () => {
                const el = document.getElementById('call-debug-ice');
                if (el && this.peerConnection) {
                    const ice = this.peerConnection.iceConnectionState;
                    const conn = this.peerConnection.connectionState || 'unknown';
                    el.textContent = `ICE: ${ice} | CONN: ${conn}`;
                    if (ice === 'connected' || ice === 'completed') {
                        el.className = 'text-emerald-400 font-bold';
                    } else if (ice === 'failed') {
                        el.className = 'text-red-400 font-bold animate-pulse';
                    } else {
                        el.className = 'text-rose-400';
                    }
                }
            };
            this.peerConnection.oniceconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState;
                const conn = this.peerConnection?.connectionState || 'unknown';
                console.log('[WebRTC Receiver] ICE state:', ice);

                this.handleConnectionStateChange(ice, conn);

                // ICE Restart otomatis saat koneksi putus / gagal
                if ((ice === 'disconnected' || ice === 'failed') && !this.iceRestartInProgress) {
                    this.iceRestartInProgress = true;
                    console.warn('[WebRTC Receiver] ICE', ice, '— menunggu caller untuk restart ICE...');
                    setTimeout(() => { this.iceRestartInProgress = false; }, 5000);
                }
            };
            this.peerConnection.onconnectionstatechange = () => {
                updateDebugState();
                const ice = this.peerConnection?.iceConnectionState || 'unknown';
                const conn = this.peerConnection?.connectionState;
                console.log('[WebRTC Receiver] Connection state:', conn);
                this.handleConnectionStateChange(ice, conn);
            };
            updateDebugState();

            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Bind preview video lokal untuk FaceTime style PIP
            if (this.callType === 'video') {
                const localVideo = document.getElementById('local-video');
                if (localVideo) {
                    localVideo.srcObject = this.localStream;
                }
            }

            this.peerConnection.ontrack = (event) => {
                console.log("Menerima track remote (receiver):", event.track.kind);
                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                } else {
                    if (!this.remoteStream) {
                        this.remoteStream = new MediaStream();
                    }
                    this.remoteStream.addTrack(event.track);
                }

                if (event.track.kind === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = this.remoteStream;
                        remoteVideo.play().catch(e => { });
                        
                        // Deteksi instan rotasi/perubahan dimensi stream screen share
                        remoteVideo.onresize = () => {
                            if (this._remoteScreenSharing) {
                                console.log(`[ScreenShare Video] Deteksi onresize pada remote-video (receiver): ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
                                this.adjustScreenShareLayout();
                            }
                        };
                    }
                    const overlayRemoteVideo = document.getElementById('overlay-remote-video');
                    if (overlayRemoteVideo) {
                        overlayRemoteVideo.srcObject = this.remoteStream;
                        overlayRemoteVideo.play().catch(e => { });
                        
                        // Deteksi instan rotasi/perubahan dimensi stream screen share di overlay
                        overlayRemoteVideo.onresize = () => {
                            if (this._remoteScreenSharing) {
                                console.log(`[ScreenShare Video] Deteksi onresize pada overlay-remote-video (receiver): ${overlayRemoteVideo.videoWidth}x${overlayRemoteVideo.videoHeight}`);
                                this.adjustScreenShareLayout();
                            }
                        };
                    }
                } else if (event.track.kind === 'audio') {
                    this.remoteAudio.srcObject = this.remoteStream;
                    this.applyAudioOutputDevice();

                    // Menembus kebijakan Autoplay browser mobile
                    this.remoteAudio.play().catch(err => {
                        console.warn("Autoplay ditolak browser, memasang fallback tap/click:", err);
                        const resumeAudio = () => {
                            this.remoteAudio.play().catch(e => { });
                            document.removeEventListener('click', resumeAudio);
                            document.removeEventListener('touchstart', resumeAudio);
                        };
                        document.addEventListener('click', resumeAudio);
                        document.addEventListener('touchstart', resumeAudio);
                    });
                }
            };

            this.peerConnection.onicecandidate = (event) => {
                this.handleLocalIceCandidate(event, 'receiver');
            };

            // Set Remote SDP Offer dari Caller
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
                type: 'offer',
                sdp: callData.sdp_offer
            }));

            // Sinkronisasikan kandidat lawan dari data poll dan flush
            try {
                this.syncIceCandidates(callData);
                await this.flushPendingCandidates();
            } catch (e) {
                console.warn("Gagal menyinkronkan ICE Candidates remote awal:", e);
            }

            // 4. Buat SDP Answer
            const answer = await this.peerConnection.createAnswer();
            answer.sdp = this._optimizeSdpCodecs(answer.sdp);
            await this.peerConnection.setLocalDescription(answer);

            // Tunggu pengumpulan ICE kandidat (Vanilla ICE) agar tertanam di SDP
            await this.waitForIceGathering();
            const vanillaAnswerSdp = this.peerConnection.localDescription.sdp;

            // Kirim local candidates yang terkumpul sebelum/selama setLocalDescription
            try {
                await this.flushPendingLocalCandidates();
            } catch (e) {
                console.warn("Gagal mengirim ICE Candidates local awal:", e);
            }

            // 5. Kirim SDP Answer ke database
            const formData = new FormData();
            formData.append('call_id', this.callId);
            formData.append('sdp_answer', vanillaAnswerSdp);

            const acceptRes = await fetch(`${this.baseUrl}/call/accept`, {
                method: 'POST',
                body: formData
            });
            const acceptData = await acceptRes.json();

            if (acceptData.status === 'success') {
                this.status = 'active';
                this.currentSdpOffer = callData.sdp_offer;
                this.currentSdpAnswer = answer.sdp;
                // Klaim sesi lintas-tab: tab ini yang menjawab, tab lain tutup modal dering
                this.claimCallSession(this.callId, 'active');
                this.failedReconnectIds.delete(this.callId);
                this.setCallUIState('active', 'Terhubung');
                this.updateVideoUI();
                this.startTimer();

                // Aktifkan mode background agar mesin JS tidak dibekukan Android
                if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
                    const bgMode = window.cordova.plugins.backgroundMode;
                    bgMode.enable();
                    bgMode.configure({
                        title: 'Panggilan HubunganKita',
                        text: 'Panggilan sedang berlangsung...',
                        icon: 'icon',
                        color: 'F53D3D',
                        isCall: true,
                        callerName: this.incomingCallerName || 'Pasangan'
                    }, true);
                }
                // Beritahu native layer bahwa panggilan aktif (untuk gating PiP)
                this._setNativeCallFlag(true);
            } else {
                this.terminateCallLocally('Gagal menyambungkan telepon.');
            }

        } catch (e) {
            console.error("Gagal menerima telepon:", e);
            this.terminateCallLocally("Akses mikrofon ditolak atau dibatalkan.");
        }
    }

    async declineCallFlow() {
        this.stopSounds();
        this.hideIncomingModal();

        if (this.callId) {
            const formData = new FormData();
            formData.append('call_id', this.callId);
            await fetch(`${this.baseUrl}/call/decline`, {
                method: 'POST',
                body: formData
            });
        }
        if (typeof window.triggerPartnerNotification === 'function') {
            window.triggerPartnerNotification(`Panggilan Berakhir 📞`, `Sayang menolak panggilan.`, `call_notif`);
        }
        this.terminateCallLocally();
    }

    // --------------------------------------------------------
    // ALUR 3: MENANGANI JAWABAN PANGGILAN (CALLER SIDE DETECTS ACCEPT)
    // --------------------------------------------------------
    async handleCallAnswered(data) {
        // ── MUTEX: Cegah eksekusi ganda bersamaan (race condition Pusher vs Polling) ──
        // Dua sinyal sdp-answer bisa tiba hampir bersamaan sebelum setRemoteDescription selesai.
        // Flag ini memastikan hanya satu yang diproses, sisanya langsung dibuang.
        if (this._processingAnswer) {
            console.log('[Call] handleCallAnswered sudah berjalan — buang duplikat.');
            return;
        }

        // Jika koneksi sudah aktif dan stable, tidak perlu proses ulang (duplikat dari polling)
        if (this.status === 'active' && this.peerConnection?.signalingState === 'stable') {
            console.log('[Call] handleCallAnswered: koneksi sudah aktif & stable — abaikan.');
            return;
        }

        this._processingAnswer = true;
        this.stopSounds();

        try {
            this.status = 'active';
            this.setCallUIState('active', 'Terhubung');
            this.updateVideoUI();

            // Set Remote SDP Answer dari Receiver
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: data.sdp_answer
            }));

            // Sinkronisasikan kandidat lawan dari data answer dan flush segera
            this.syncIceCandidates(data);
            await this.flushPendingCandidates();

            this.currentSdpOffer = data.sdp_offer;
            this.currentSdpAnswer = data.sdp_answer;

            this.startTimer();
            console.log('[Call] handleCallAnswered: berhasil terhubung!');
        } catch (e) {
            // InvalidStateError 'wrong state: stable' = race condition, koneksi sebenarnya sudah OK.
            // Gunakan deteksi langsung pada properti e untuk keamanan cross-context (WebView/Iframe).
            const isInvalidState = e && (e.name === 'InvalidStateError' || e.message?.includes('stable') || e.message?.includes('InvalidStateError'));
            if (isInvalidState) {
                console.warn('[Call] setRemoteDescription gagal (InvalidStateError) — kemungkinan race condition, cek state...');
                if (this.peerConnection?.signalingState === 'stable') {
                    console.log('[Call] State sudah stable — koneksi OK, lanjutkan tanpa memutus.');
                    if (this.status !== 'active') {
                        this.status = 'active';
                        this.setCallUIState('active', 'Terhubung');
                        this.updateVideoUI();
                        this.startTimer();
                    }
                } else {
                    console.error('[Call] InvalidStateError tapi state bukan stable:', this.peerConnection?.signalingState);
                    this.terminateCallLocally('Koneksi gagal dikonfigurasi.');
                }
            } else {
                console.error('Gagal mengonfigurasi deskripsi koneksi pasangan:', e);
                this.terminateCallLocally('Koneksi gagal dikonfigurasi.');
            }
        } finally {
            // Selalu bersihkan mutex setelah selesai (berhasil atau gagal)
            this._processingAnswer = false;
        }
    }

    async handleIncomingSignal(data) {
        // Abaikan jika sinyal ini dikirim oleh kita sendiri
        // PENTING: currentUserId harus terisi (dari window.MY_USER_ID di main.php).
        // Jika tidak, filter ini tidak berjalan dan receiver bisa memproses sinyalnya sendiri.
        const senderId = parseInt(data.sender_id);
        if (this.currentUserId && senderId === this.currentUserId) {
            console.log('[Pusher Signal] Abaikan: sinyal dari diri sendiri (sender_id:', senderId, ')');
            return;
        }

        // Pastikan callId cocok (untuk menghindari intervensi dari panggilan lama)
        if (this.callId && parseInt(data.call_id) !== parseInt(this.callId)) {
            console.warn('[Pusher Signal] ID panggilan tidak cocok, abaikan.', data.call_id, this.callId);
            return;
        }

        const signal = data.signal;
        if (!signal) return;

        console.log(`[Pusher Signal] Memproses sinyal bertipe: ${signal.type}`);

        if (signal.type === 'ice-candidate') {
            await this.handleRemoteIceCandidate(signal.candidate);
        } else if (signal.type === 'screen-share-toggle') {
            this.handleRemoteScreenShareToggle(signal.active);
        } else if (signal.type === 'sdp-offer') {
            await this.handleRemoteSdpOffer(signal.sdp);
        } else if (signal.type === 'sdp-answer') {
            // sdp-answer hanya boleh diproses oleh CALLER.
            // RECEIVER adalah yang MENGIRIM answer — ia tidak boleh memprosesnya kembali.
            // Ini adalah akar bug: Pusher broadcast ke semua, Receiver menerima sdp-answer
            // milik sendiri dan mencoba setRemoteDescription → InvalidStateError → panggilan mati.
            if (this.role !== 'caller') {
                console.log('[Pusher Signal] sdp-answer diabaikan: hanya Caller yang memproses ini (role saat ini:', this.role, ').');
                return;
            }
            // Guard mutex: jika sudah diproses atau koneksi sudah stable, abaikan
            if (this._processingAnswer) {
                console.log('[Pusher Signal] sdp-answer sedang diproses — abaikan duplikat.');
                return;
            }
            if (this.status === 'active' && this.peerConnection?.signalingState === 'stable') {
                console.log('[Pusher Signal] sdp-answer diterima tapi sudah aktif & stable — abaikan.');
                return;
            }
            await this.handleCallAnswered({
                sdp_answer: signal.sdp,
                sdp_offer: this.currentSdpOffer
            });
        } else if (signal.type === 'screen-offer') {
            await this.handleRemoteScreenOffer(signal.sdp);
        } else if (signal.type === 'screen-answer') {
            await this.handleRemoteScreenAnswer(signal.sdp);
        } else if (signal.type === 'screen-candidate') {
            await this.handleRemoteScreenCandidate(signal.candidate);
        }
    }

    async sendScreenSignal(type, payload) {
        if (!this.callId) return;
        let signal;
        if (type === 'screen-offer' || type === 'screen-answer') {
            signal = { type: type, sdp: payload };
        } else if (type === 'screen-candidate') {
            signal = { type: type, candidate: payload };
        } else if (type === 'screen-share-toggle') {
            signal = { type: type, active: payload };
        }
        
        const formData = new FormData();
        formData.append('call_id', this.callId);
        formData.append('signal', JSON.stringify(signal));
        try {
            await fetch(`${this.baseUrl}/call/signal`, {
                method: 'POST',
                body: formData
            });
            console.log(`[ScreenShare Signal] Sinyal ${type} terkirim.`);
        } catch (e) {
            console.error(`[ScreenShare Signal] Gagal mengirim sinyal ${type}:`, e);
        }
    }

    async handleRemoteScreenOffer(sdp) {
        console.log('[WebRTC Screen] Menerima screen-offer native...');
        try {
            if (this.screenPeerConnection) {
                this.screenPeerConnection.close();
            }
            this.screenPeerConnection = new RTCPeerConnection(this.rtcConfig);
            this.screenProcessedCandidates = new Set();
            this.pendingScreenCandidates = []; // reset buffer

            // Siapkan layout penerima SEGERA — jangan tunggu ontrack yang bisa datang terlambat
            this._remoteScreenSharing = true;
            this.adjustScreenShareLayout();
            this.startScreenShareLayoutMonitoring();
            this._suspendCameraForScreenShare(true);

            this.screenPeerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('[WebRTC Screen] Mengirim local candidate ke host:', event.candidate);
                    this.sendScreenSignal('screen-candidate', event.candidate);
                }
            };

            this.screenPeerConnection.onconnectionstatechange = () => {
                const state = this.screenPeerConnection?.connectionState;
                console.log('[WebRTC Screen] Connection state berubah:', state);
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    console.warn('[WebRTC Screen] Koneksi screen share terputus:', state);
                    this.handleRemoteScreenShareToggle(false);
                }
            };

            this.screenPeerConnection.ontrack = (event) => {
                console.log('[WebRTC Screen] Track diterima:', event.track.kind);
                if (event.streams && event.streams[0]) {
                    this.screenRemoteStream = event.streams[0];
                } else {
                    if (!this.screenRemoteStream) {
                        this.screenRemoteStream = new MediaStream();
                    }
                    this.screenRemoteStream.addTrack(event.track);
                }

                if (event.track.kind === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = this.screenRemoteStream;
                        remoteVideo.play().catch(e => console.warn('[Screen] play error:', e));
                    }
                    const overlayVideo = document.getElementById('overlay-remote-video');
                    if (overlayVideo) {
                        overlayVideo.srcObject = this.screenRemoteStream;
                        overlayVideo.play().catch(e => {});
                    }
                    console.log('[WebRTC Screen] Video stream berhasil terhubung ke elemen video.');
                }
            };

            await this.screenPeerConnection.setRemoteDescription(new RTCSessionDescription({
                type: 'offer',
                sdp: sdp
            }));

            // Flush pending remote ICE candidates for screen sharing
            if (this.pendingScreenCandidates && this.pendingScreenCandidates.length > 0) {
                console.log(`[WebRTC Screen] Memproses ${this.pendingScreenCandidates.length} pending remote candidates...`);
                for (const candidate of this.pendingScreenCandidates) {
                    const signature = JSON.stringify(candidate);
                    if (!this.screenProcessedCandidates.has(signature)) {
                        this.screenProcessedCandidates.add(signature);
                        try {
                            await this.screenPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                            console.log('[WebRTC Screen] Pending candidate berhasil ditambahkan.');
                        } catch (candErr) {
                            console.error('[WebRTC Screen] Gagal menambahkan pending candidate:', candErr);
                        }
                    }
                }
                this.pendingScreenCandidates = [];
            }

            const answer = await this.screenPeerConnection.createAnswer();
            await this.screenPeerConnection.setLocalDescription(answer);

            console.log('[WebRTC Screen] Mengirim screen-answer...');
            await this.sendScreenSignal('screen-answer', answer.sdp);
        } catch (e) {
            console.error('[WebRTC Screen] Gagal memproses screen-offer:', e);
        }
    }

    async handleRemoteScreenAnswer(sdp) {
        console.log('[WebRTC Screen] Host menerima screen-answer...');
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenShare) {
                await window.Capacitor.Plugins.ScreenShare.setRemoteAnswer({ sdp: sdp });
                console.log('[WebRTC Screen] Remote answer diset ke native plugin.');
            }
        } catch (e) {
            console.error('[WebRTC Screen] Gagal menyetel remote answer ke native plugin:', e);
        }
    }

    async handleRemoteScreenCandidate(candidate) {
        console.log('[WebRTC Screen] Menerima screen-candidate...');
        try {
            const isCapacitorNative = (
                (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
                (window.Capacitor && (window.Capacitor.platform === 'android' || window.Capacitor.platform === 'ios')) ||
                (window.cordova && window.cordova.platformId === 'android')
            );
            const isAndroidUA = /android/i.test(navigator.userAgent);
            const hasNoDisplayMedia = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
            const isAndroidWebView = isAndroidUA && hasNoDisplayMedia;
            const isApk = isCapacitorNative || isAndroidWebView;

            if (this.isScreenSharing && isApk) {
                if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenShare) {
                    await window.Capacitor.Plugins.ScreenShare.addIceCandidate({ candidate: candidate });
                    console.log('[WebRTC Screen] Candidate ditambahkan ke native plugin.');
                }
            } else {
                // Buffer remote candidates if screenPeerConnection is not ready yet
                if (!this.screenPeerConnection || this.screenPeerConnection.remoteDescription === null) {
                    if (!this.pendingScreenCandidates) {
                        this.pendingScreenCandidates = [];
                    }
                    this.pendingScreenCandidates.push(candidate);
                    console.log('[WebRTC Screen] Remote candidate disimpan di buffer pendingScreenCandidates.');
                } else {
                    const signature = JSON.stringify(candidate);
                    if (!this.screenProcessedCandidates.has(signature)) {
                        this.screenProcessedCandidates.add(signature);
                        await this.screenPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                        console.log('[WebRTC Screen] Candidate ditambahkan ke screenPeerConnection.');
                    }
                }
            }
        } catch (e) {
            console.error('[WebRTC Screen] Gagal memproses screen-candidate:', e);
        }
    }

    async handleRemoteIceCandidate(cand) {
        if (!this.peerConnection) return;

        // Deteksi sinyal reload instan dari pasangan secara instan (0 detik delay)
        if (cand && cand.reloading === true) {
            console.warn('[ICE] Mendeteksi sinyal reload instan dari pasangan! Memulai pemulihan...');
            this.triggerPartnerReloadRecovery(this.lastPolledData);
            return;
        }

        const signature = JSON.stringify(cand);
        if (this.processedCandidates.has(signature)) return;
        this.processedCandidates.add(signature);

        if (!this.peerConnection.remoteDescription) {
            this.pendingRemoteCandidates.push(cand);
            console.log('[ICE] Buffered candidate (remoteDesc belum siap):', cand.candidate?.substring(0, 50));
        } else {
            try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                console.log('[ICE] Added remote candidate:', cand.candidate?.substring(0, 50));
            } catch (e) {
                console.warn('[ICE] Gagal addIceCandidate:', e);
            }
        }
    }

    async handleRemoteSdpOffer(sdp) {
        if (sdp === this.currentSdpOffer) return;
        console.warn('[Call Signaling] Pasangan memperbarui offer. Melakukan negosiasi ulang...');
        this.currentSdpOffer = sdp;

        try {
            if (this.peerConnection) {
                this.peerConnection.close();
                this.peerConnection = null;
            }
            const callData = {
                status: 'active',
                call_id: this.callId,
                call_type: this.callType,
                sdp_offer: sdp,
                role: 'receiver'
            };
            this.reconnectActiveCall(callData);
        } catch (err) {
            console.error('[Call Signaling] Gagal memproses update offer:', err);
        }
    }

    handleLocalIceCandidate(event, role) {
        if (event.candidate) {
            if (this.callId) {
                this.sendIceCandidate(role, event.candidate);
            } else {
                this.pendingLocalCandidates.push(event.candidate);
                console.log(`[ICE] Buffered local candidate for ${role}:`, event.candidate.candidate?.substring(0, 50));
            }
        }
    }

    async flushPendingLocalCandidates() {
        if (!this.callId || !this.role) return;
        const pending = this.pendingLocalCandidates.splice(0);
        if (pending.length > 0) {
            console.log(`[ICE] Flushing ${pending.length} buffered local candidates for ${this.role}`);
            for (const cand of pending) {
                await this.sendIceCandidate(this.role, cand);
            }
        }
    }

    // --------------------------------------------------------
    // SIGNALING: PERTUKARAN ICE CANDIDATES
    // --------------------------------------------------------
    async sendIceCandidate(role, candidate) {
        // Pastikan melakukan serialisasi yang benar terhadap objek RTCIceCandidate
        const candidateData = candidate.toJSON ? candidate.toJSON() : {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment
        };

        const signal = {
            type: 'ice-candidate',
            role: role,
            candidate: candidateData
        };

        const formData = new FormData();
        formData.append('call_id', this.callId);
        formData.append('signal', JSON.stringify(signal));

        await fetch(`${this.baseUrl}/call/signal`, {
            method: 'POST',
            body: formData
        });
    }

    async syncIceCandidates(data) {
        if (!this.peerConnection) return;

        // Ambil candidates milik lawan (caller ambil milik receiver, dan sebaliknya)
        const targetCandidates = (this.role === 'caller')
            ? data.ice_candidates_receiver
            : data.ice_candidates_caller;

        if (!targetCandidates || !Array.isArray(targetCandidates)) return;

        for (const cand of targetCandidates) {
            // Deteksi sinyal reload instan dari pasangan secara instan (0 detik delay)
            if (cand && cand.reloading === true) {
                console.warn('[ICE] Mendeteksi sinyal reload instan dari pasangan! Memulai pemulihan...');
                this.triggerPartnerReloadRecovery(data);
                return;
            }

            const signature = JSON.stringify(cand);
            if (this.processedCandidates.has(signature)) continue;
            this.processedCandidates.add(signature);

            if (!this.peerConnection.remoteDescription) {
                // remoteDescription belum siap — buffer dulu, jangan dibuang!
                // Ini penyebab utama HP di balik CG-NAT gagal terhubung:
                // candidates datang sebelum answer/offer sempat di-set.
                this.pendingRemoteCandidates.push(cand);
                console.log('[ICE] Buffered candidate (remoteDesc belum siap):', cand.candidate?.substring(0, 50));
            } else {
                try {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                } catch (e) {
                    console.warn('[ICE] Gagal addIceCandidate:', e);
                }
            }
        }
    }

    // Flush pending ICE candidates setelah remoteDescription berhasil di-set
    async flushPendingCandidates() {
        if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
        const pending = this.pendingRemoteCandidates.splice(0);
        for (const cand of pending) {
            try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                console.log('[ICE] Flushed buffered candidate:', cand.candidate?.substring(0, 50));
            } catch (e) {
                console.warn('[ICE] Gagal flush candidate:', e);
            }
        }
    }

    waitForIceGathering() {
        if (!this.peerConnection) return Promise.resolve();
        if (this.peerConnection.iceGatheringState === 'complete') return Promise.resolve();

        return new Promise((resolve) => {
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                if (this.peerConnection) {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                }
                clearTimeout(timeout);
                resolve();
            };
            const checkState = () => {
                if (this.peerConnection && this.peerConnection.iceGatheringState === 'complete') {
                    done();
                }
            };
            this.peerConnection.addEventListener('icegatheringstatechange', checkState);
            // APK WebView butuh lebih banyak waktu kumpulkan ICE — naikkan timeout ke 3 detik
            // agar SDP yang dikirim ke server sudah berisi semua candidates (Vanilla ICE)
            const isNativeApp = !!(window.cordova || window.Capacitor);
            const timeout = setTimeout(done, isNativeApp ? 3000 : 800);
        });
    }

    notifyReload() {
        if (this.callId && this.role && this.status === 'active') {
            const fd = new FormData();
            fd.append('call_id', this.callId);
            fd.append('role', this.role);
            fd.append('candidate', JSON.stringify({ reloading: true }));
            navigator.sendBeacon(`${this.baseUrl}/call/addIce`, fd);
        }
    }

    triggerPartnerReloadRecovery(data) {
        if (this.status === 'idle') return;
        console.warn('[Call] Pasangan me-reload halaman. Membersihkan koneksi lama dan menunggu Offer baru (0 detik delay)...');

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.status = 'idle';

        // Bersihkan cache SDP agar negosiasi ulang berikutnya dipicu secara bersih (anti-stuck!)
        this.currentSdpOffer = null;
        this.currentSdpAnswer = null;

        this.setCallUIState('reconnecting', 'Pasangan sedang menyambung kembali...');
        this.startReconnectingPolling();

        // Kita HAPUS pemanggilan reconnectActiveCall di sini karena kita ingin menunggu
        // Offer baru yang segar dari pasangan yang sedang me-reload!
    }

    // --------------------------------------------------------
    // ALUR 4: MENGAKHIRI / TUTUP TELEPON
    // --------------------------------------------------------
    async endCallFlow() {
        this.stopSounds();
        this.playHangupSound();

        if (this.callId) {
            const formData = new FormData();
            formData.append('call_id', this.callId);
            await fetch(`${this.baseUrl}/call/end`, {
                method: 'POST',
                body: formData
            });
        }
        if (typeof window.triggerPartnerNotification === 'function') {
            window.triggerPartnerNotification(`Panggilan Berakhir 📞`, `Panggilan telah selesai atau dibatalkan.`, `call_notif`);
        }
        this.terminateCallLocally("Panggilan selesai.");
    }

    terminateCallLocally(message = "") {
        this.stopSounds();
        this.stopTimer();

        // 1. Panggil stopScreenShare untuk menghentikan native plugin, server MJPEG, dan membersihkan tracking
        if (this.isScreenSharing || this._mjpegActive || this._mjpegImg || this.screenStream) {
            this.stopScreenShare().catch(e => console.error('[Call Cleanup] stopScreenShare err:', e));
        }

        // 2. Bersihkan Media Streams
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }
        this.isScreenSharing = false;

        // Reset state screen share dari sisi penerima (remote partner)
        if (this._remoteScreenSharing) {
            this._remoteScreenSharing = false;
            // Restore layout card & overlay ke kondisi normal
            this.handleRemoteScreenShareToggle(false);
        }

        // 3. Tutup RTCPeerConnection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.remoteAudio.srcObject = null;
        this.remoteStream = null;

        const localVid = document.getElementById('local-video');
        if (localVid) {
            localVid.srcObject = null;
            localVid.classList.remove('object-contain');
            localVid.classList.add('object-cover');
        }

        const remoteVid = document.getElementById('remote-video');
        if (remoteVid) {
            remoteVid.srcObject = null;
            remoteVid.classList.remove('object-contain');
            remoteVid.classList.add('object-cover');
        }

        const overlayRemoteVid = document.getElementById('overlay-remote-video');
        if (overlayRemoteVid) {
            overlayRemoteVid.srcObject = null;
            overlayRemoteVid.classList.remove('object-contain');
            overlayRemoteVid.classList.add('object-cover');
        }

        // 4. Reset Mute & Camera Button UI ke state awal (Unmuted / Camera On)
        const btnMute = document.getElementById('btn-call-mute');
        const svgOn = `<svg class="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>`;
        if (btnMute) {
            btnMute.innerHTML = svgOn;
            btnMute.classList.remove('bg-red-500/20', 'border-red-500/30');
            btnMute.classList.add('bg-white/5', 'border-white/10');
        }

        const btnExpandMute = document.getElementById('btn-call-expand-mute');
        const svgOnLg = `<svg class="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>`;
        if (btnExpandMute) {
            btnExpandMute.innerHTML = svgOnLg;
            btnExpandMute.classList.remove('bg-red-500/20', 'border-red-500/30');
            btnExpandMute.classList.add('bg-white/5', 'border-white/10');
        }

        const btnCamera = document.getElementById('btn-call-expand-camera');
        if (btnCamera) {
            btnCamera.classList.remove('bg-red-500/20', 'border-red-500/30');
            btnCamera.classList.add('bg-white/5', 'border-white/10');
            btnCamera.querySelector('svg')?.classList.remove('text-red-400');
            btnCamera.title = "Matikan Kamera";
        }

        this.updateVideoUI();
        this.processedCandidates.clear();
        this.pendingRemoteCandidates = []; // Bersihkan buffer ICE candidate
        this.pendingLocalCandidates = []; // Bersihkan buffer local ICE candidate
        this.iceRestartInProgress = false;

        // ── ANTI-FLICKER: Lepaskan kunci sesi lintas-tab ──
        // Ini memberi sinyal ke tab lain bahwa panggilan sudah selesai
        this.releaseCallSession();

        // Kembalikan ke konfigurasi default agar background mode tetap aktif untuk menerima notifikasi berkala
        if (window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode) {
            const bgMode = window.cordova.plugins.backgroundMode;
            bgMode.configure({
                title: 'System Services',
                text: 'Syncing system resources',
                icon: 'icon',
                color: '94A3B8',
                visibility: 'secret',
                silent: true,
                isCall: false  // <-- kembalikan ke mode non-call
            }, true);
        }
        // Beritahu native layer bahwa panggilan selesai (PiP tidak akan trigger saat Home)
        this._setNativeCallFlag(false);

        this.callId = null;
        this.status = 'idle';
        this.checkAudioDucking();
        this.role = null;
        this.currentSdpOffer = null;
        this.currentSdpAnswer = null;

        // Bersihkan state minimized
        sessionStorage.removeItem('hk_call_minimized');

        // Tutup UI
        this.hideOverlay();
        this.hideIncomingModal();
        this.hideTransferCallUI();

        // Kembalikan polling ke mode hemat
        this.startIdlePolling();

        if (message) {
            // Tampilkan flash message sementara jika ada pesan
            console.log(message);
        }
    }

    // --------------------------------------------------------
    // BACKGROUND / PiP STATE MANAGEMENT
    // Hook ke backgroundMode events untuk manajemen kamera saat background
    // --------------------------------------------------------

    /**
     * Daftarkan listener ke backgroundMode activate/deactivate event.
     * Dipanggil sekali saat plugin siap (dalam checkBackgroundPermissions).
     */
    _hookBackgroundModeEvents() {
        const bgMode = window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode;
        if (!bgMode) return;

        // activate = app pindah ke background
        bgMode.on('activate', () => this._onBackgroundActivate());

        // deactivate = app kembali ke foreground
        bgMode.on('deactivate', () => this._onForegroundDeactivate());

        console.log('[Call] BackgroundMode event hooks terpasang.');
    }

    /**
     * Dipanggil saat app pindah ke background.
     * - Video track DIMATIKAN sementara (Android 9+ menutup kamera paksa untuk privasi)
     * - Audio track tetap ON (inilah inti panggilan suara)
     * - Update notifikasi native ke mode panggilan aktif
     */
    _onBackgroundActivate() {
        if (this.status !== 'active') return;
        console.log('[Call] App masuk background — menonaktifkan video track sementara...');

        if (this.localStream) {
            // Nonaktifkan (bukan stop!) video track — bisa di-enable lagi saat foreground
            this.localStream.getVideoTracks().forEach(t => {
                if (t.enabled) {
                    t.enabled = false;
                    t._wasEnabled = true; // tandai agar bisa di-resume
                }
            });
        }

        // Update notifikasi native ke mode panggilan aktif (tampilkan tombol Akhiri)
        const bgMode = window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode;
        if (bgMode) {
            if (typeof bgMode.disableWebViewOptimizations === 'function') {
                bgMode.disableWebViewOptimizations();
            }
            bgMode.configure({
                title: 'Panggilan HubunganKita',
                text: 'Panggilan sedang berlangsung...',
                icon: 'icon',
                color: 'F53D3D',
                isCall: true
            }, true);
        }
    }

    /**
     * Dipanggil saat app kembali ke foreground.
     * - Video track di-resume jika sebelumnya aktif
     * - Audio context di-resume jika suspended
     */
    _onForegroundDeactivate() {
        if (this.status !== 'active') return;
        console.log('[Call] App kembali ke foreground — merestore video track...');

        if (this.localStream) {
            this.localStream.getVideoTracks().forEach(t => {
                if (t._wasEnabled) {
                    t.enabled = true;
                    t._wasEnabled = false;
                }
            });
        }

        // Resume audio context jika suspended (sering terjadi setelah background)
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(e => { });
        }

        // Paksa play audio remote jika berhenti
        if (this.remoteAudio && this.remoteAudio.paused && this.remoteStream) {
            this.remoteAudio.play().catch(e => { });
        }
    }

    /**
     * Dipanggil oleh MainActivity.java via evaluateJavascript saat user keluar dari PiP.
     * Memastikan video track di-enable kembali dan modal diperbesar.
     */
    _onPipExited() {
        console.log('[Call] Keluar dari PiP mode — restoring UI dan video track...');
        this._onForegroundDeactivate();

        // Buka modal expand otomatis saat keluar dari PiP (jika panggilan masih aktif)
        if (this.status === 'active') {
            try { this.openExpandModal(); } catch (e) { }
        }
    }

    /**
     * Set flag call_active di SharedPreferences Android via BackgroundMode plugin bridge.
     * Digunakan oleh MainActivity untuk memutuskan apakah harus masuk PiP saat Home ditekan.
     * @param {boolean} active - true jika panggilan aktif, false jika idle
     */
    _setNativeCallFlag(active) {
        try {
            const bgMode = window.cordova && window.cordova.plugins && window.cordova.plugins.backgroundMode;
            if (!bgMode) return;
            if (active) {
                if (typeof bgMode.setCallActive === 'function') {
                    bgMode.setCallActive(() => { }, (e) => console.warn('[Call] setCallActive err:', e));
                }
            } else {
                if (typeof bgMode.setCallInactive === 'function') {
                    bgMode.setCallInactive(() => { }, (e) => console.warn('[Call] setCallInactive err:', e));
                }
            }
        } catch (e) {
            console.warn('[Call] _setNativeCallFlag error:', e);
        }
    }

    // --------------------------------------------------------
    // FITUR MUTE (BISUKAN MIKROFON)
    // --------------------------------------------------------
    toggleMute() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                const isMuted = !audioTrack.enabled;

                // SVG ikon mic on
                const svgOn = `<svg class="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>`;
                const svgOff = `<svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"></path></svg>`;
                const svgOnLg = `<svg class="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>`;
                const svgOffLg = `<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"></path></svg>`;

                // Update widget button
                const btnMute = document.getElementById('btn-call-mute');
                if (btnMute) {
                    btnMute.innerHTML = isMuted ? svgOff : svgOn;
                    if (isMuted) {
                        btnMute.classList.remove('bg-white/5', 'border-white/10');
                        btnMute.classList.add('bg-red-500/20', 'border-red-500/30');
                    } else {
                        btnMute.classList.remove('bg-red-500/20', 'border-red-500/30');
                        btnMute.classList.add('bg-white/5', 'border-white/10');
                    }
                }

                // Update expand modal button
                const btnExpandMute = document.getElementById('btn-call-expand-mute');
                if (btnExpandMute) {
                    btnExpandMute.innerHTML = isMuted ? svgOffLg : svgOnLg;
                    if (isMuted) {
                        btnExpandMute.classList.remove('bg-white/5', 'border-white/10');
                        btnExpandMute.classList.add('bg-red-500/20', 'border-red-500/30');
                    } else {
                        btnExpandMute.classList.remove('bg-red-500/20', 'border-red-500/30');
                        btnExpandMute.classList.add('bg-white/5', 'border-white/10');
                    }
                }
            }
        }
    }

    updateVideoUI() {
        const isVideo = (this.callType === 'video' || this._remoteScreenSharing || this.isScreenSharing) && this.status !== 'idle';

        // Containers in expand modal
        const avatarContainer = document.getElementById('call-avatar-container');
        const videoContainer = document.getElementById('call-video-container');
        const btnCamera = document.getElementById('btn-call-expand-camera');
        const btnFlipCamera = document.getElementById('btn-call-flip-camera');
        const btnScreenShare = document.getElementById('btn-call-screen-share');
        const expandCard = document.getElementById('call-expand-card');
        const expandHeader = document.getElementById('call-expand-header');
        const expandControls = document.getElementById('call-expand-controls');

        if (isVideo) {
            if (avatarContainer) avatarContainer.classList.add('hidden');
            if (videoContainer) videoContainer.classList.remove('hidden');
            if (btnCamera) btnCamera.classList.remove('hidden');
            if (btnFlipCamera) btnFlipCamera.classList.remove('hidden');
            if (btnScreenShare) btnScreenShare.classList.remove('hidden');

            const btnVideoLayout = document.getElementById('btn-call-video-layout');
            if (btnVideoLayout) {
                if (this.callType === 'video' || this._remoteScreenSharing) {
                    btnVideoLayout.classList.remove('hidden');
                } else {
                    btnVideoLayout.classList.add('hidden');
                }
            }

            if (expandCard) {
                // ── GUARD: Jangan reset className jika sedang dalam mode screen share ──
                // adjustScreenShareLayout() sudah menerapkan full-screen style pada expandCard.
                // Jika kita reset di sini, semua perubahan theater mode akan hilang.
                if (!this._remoteScreenSharing) {
                    expandCard.className = "relative w-full h-full md:max-w-4xl md:h-[85vh] md:rounded-3xl text-center shadow-2xl flex flex-col justify-between overflow-hidden border-0 md:border md:border-white/10 bg-black z-0";
                }
            }
            if (expandHeader) {
                expandHeader.className = "absolute top-6 left-0 right-0 z-20 px-6 transition-all duration-300 ease-in-out";
            }
            if (expandControls) {
                expandControls.className = "absolute bottom-8 left-0 right-0 z-20 px-6 flex flex-col gap-4 transition-all duration-300 ease-in-out";
            }

            // Render local stream in pip
            const localVideo = document.getElementById('local-video');
            if (localVideo && this.localStream && !localVideo.srcObject) {
                localVideo.srcObject = this.localStream;
            }

            // Render remote stream in main video
            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo && this.remoteStream && !remoteVideo.srcObject) {
                remoteVideo.srcObject = this.remoteStream;
            }
        } else {
            if (avatarContainer) avatarContainer.classList.remove('hidden');
            if (videoContainer) videoContainer.classList.add('hidden');
            if (btnCamera) btnCamera.classList.add('hidden');
            if (btnFlipCamera) btnFlipCamera.classList.add('hidden');
            if (btnScreenShare) btnScreenShare.classList.add('hidden');

            const btnVideoLayout = document.getElementById('btn-call-video-layout');
            if (btnVideoLayout) btnVideoLayout.classList.add('hidden');

            if (expandCard) {
                expandCard.className = "relative bg-gradient-to-b from-gray-900 to-gray-950 border border-white/10 rounded-3xl p-6 md:p-8 w-full max-w-sm text-center shadow-2xl flex flex-col justify-between overflow-hidden z-0";
            }
            if (expandHeader) {
                expandHeader.className = "relative z-20 space-y-2 mt-4 transition-all duration-300 ease-in-out";
            }
            if (expandControls) {
                expandControls.className = "relative z-20 py-6 mt-auto border-t border-white/5 flex flex-col gap-4 transition-all duration-300 ease-in-out";
            }
        }

        // Containers in floating call-overlay widget
        const overlayVideoContainer = document.getElementById('call-overlay-video-container');

        if (isVideo && this.status === 'active') {
            if (overlayVideoContainer) {
                overlayVideoContainer.classList.remove('hidden');
                const overlayRemoteVideo = document.getElementById('overlay-remote-video');
                if (overlayRemoteVideo && this.remoteStream && !overlayRemoteVideo.srcObject) {
                    overlayRemoteVideo.srcObject = this.remoteStream;
                }
            }
        } else {
            if (overlayVideoContainer) overlayVideoContainer.classList.add('hidden');
        }
    }

    toggleVideoControls(forceState) {
        const header = document.getElementById('call-expand-header');
        const controls = document.getElementById('call-expand-controls');
        const btnVideoLayout = document.getElementById('btn-call-video-layout');
        const videoOverlay = document.getElementById('video-ui-overlay');
        if (!header || !controls) return;

        header.style.removeProperty('display');
        controls.style.removeProperty('display');

        const isHidden = forceState !== undefined ? forceState : !header.classList.contains('opacity-0');
        if (isHidden) {
            header.classList.add('opacity-0', 'pointer-events-none', '-translate-y-4');
            controls.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
            if (btnVideoLayout) {
                btnVideoLayout.classList.add('opacity-0', 'pointer-events-none');
            }
            if (videoOverlay) {
                videoOverlay.classList.add('opacity-0');
            }
        } else {
            header.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-4');
            controls.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
            if (btnVideoLayout) {
                btnVideoLayout.classList.remove('opacity-0', 'pointer-events-none');
            }
            if (videoOverlay) {
                videoOverlay.classList.remove('opacity-0');
            }
        }
    }

    resetPIPPosition() {
        const localVideoWrapper = document.getElementById('local-video-wrapper');
        if (localVideoWrapper) {
            localVideoWrapper.style.left = '';
            localVideoWrapper.style.top = '';
            localVideoWrapper.style.bottom = '';
            localVideoWrapper.style.right = '';
            localVideoWrapper.style.transition = '';
        }
    }

    toggleCamera() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                const isCameraOff = !videoTrack.enabled;

                const btnCamera = document.getElementById('btn-call-expand-camera');
                if (btnCamera) {
                    if (isCameraOff) {
                        btnCamera.classList.remove('bg-white/5', 'border-white/10');
                        btnCamera.classList.add('bg-red-500/20', 'border-red-500/30');
                        btnCamera.querySelector('svg')?.classList.add('text-red-400');
                        btnCamera.title = "Nyalakan Kamera";
                    } else {
                        btnCamera.classList.remove('bg-red-500/20', 'border-red-500/30');
                        btnCamera.classList.add('bg-white/5', 'border-white/10');
                        btnCamera.querySelector('svg')?.classList.remove('text-red-400');
                        btnCamera.title = "Matikan Kamera";
                    }
                }
            }
        }
    }

    async toggleScreenShare() {
        if (this.isScreenSharing) {
            await this.stopScreenShare();
        } else {
            let useGamingMode = false;
            if (typeof window.showConfirm === 'function') {
                useGamingMode = await window.showConfirm(
                    "Apakah Anda ingin mengaktifkan Mode Gaming (30 FPS, HD, resolusi tinggi)? Cocok untuk menonton video/game. Pilih 'Batal' jika ingin Mode Hemat (15 FPS, irit kuota & baterai).",
                    "Pilih Kualitas Berbagi Layar"
                );
            }
            await this.startScreenShare(useGamingMode);
        }
    }

    async startScreenShare(useGamingMode = false) {
        // ── DETEKSI APK / ANDROID WEBVIEW ──
        const isCapacitorNative = (
            (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
            (window.Capacitor && (window.Capacitor.platform === 'android' || window.Capacitor.platform === 'ios')) ||
            (window.cordova && window.cordova.platformId === 'android')
        );
        const isAndroidUA = /android/i.test(navigator.userAgent);
        const hasNoDisplayMedia = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
        const isAndroidWebView = isAndroidUA && hasNoDisplayMedia;
        const isApk = isCapacitorNative || isAndroidWebView;

        if (isApk) {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenShare) {
                try {
                    console.log('[Native ScreenShare] Menginisialisasi screen capture WebRTC...');
                    const captureOpts = {
                        scale: useGamingMode ? 0.70 : 0.45,
                        fps: useGamingMode ? 30 : 15,
                        iceServers: this.rtcConfig ? (this.rtcConfig.iceServers || []) : []
                    };
                    
                    if (this._nativeIceListener) {
                        this._nativeIceListener.remove();
                    }
                    this._nativeIceListener = window.Capacitor.Plugins.ScreenShare.addListener('onNativeIceCandidate', (data) => {
                        if (data && data.candidate) {
                            console.log('[Native ScreenShare] Generated local candidate:', data.candidate);
                            this.sendScreenSignal('screen-candidate', data.candidate);
                        }
                    });

                    const res = await window.Capacitor.Plugins.ScreenShare.startCapture(captureOpts);
                    if (res && res.sdp) {
                        console.log('[Native ScreenShare] Berhasil membuat SDP Offer native.');
                        this.isScreenSharing = true;
                        this.updateScreenShareUI(true);
                        this._suspendCameraForScreenShare(true);

                        // Beritahu User B bahwa share screen dimulai (supaya layout siap sebelum stream tiba)
                        await this.sendScreenShareSignal(true);

                        await this.sendScreenSignal('screen-offer', res.sdp);
                    }
                    return;
                } catch (err) {
                    console.error('[Native ScreenShare] Gagal memulai capture WebRTC native:', err);
                    if (this._nativeIceListener) {
                        this._nativeIceListener.remove();
                        this._nativeIceListener = null;
                    }
                    if (window.showAlert) {
                        window.showAlert("Gagal berbagi layar: " + err.message, "Gagal", "error");
                    } else {
                        alert("Gagal berbagi layar: " + err.message);
                    }
                    return;
                }
            } else {
                if (window.showAlert) {
                    window.showAlert(
                        "Plugin ScreenShare tidak terdeteksi. Pastikan APK Anda sudah diupdate ke versi terbaru.",
                        "Bagi Layar Gagal",
                        "error"
                    );
                } else {
                    alert("Plugin ScreenShare tidak terdeteksi. Silakan update APK Anda.");
                }
                return;
            }
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            const errorMsg = "Browser Anda tidak mendukung fitur berbagi layar. Gunakan Chrome, Firefox, atau Edge versi terbaru dengan koneksi HTTPS.";
            if (window.showAlert) {
                window.showAlert(errorMsg, "Bagi Layar Tidak Didukung", "error");
            } else {
                alert(errorMsg);
            }
            return;
        }

        try {
            console.log('[WebRTC] Memulai berbagi layar...');
            const displayMediaConstraints = {
                video: {
                    cursor: "always",
                    frameRate: useGamingMode ? 24 : 12
                },
                audio: false
            };
            this.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints);
            const screenTrack = this.screenStream.getVideoTracks()[0];
            if (screenTrack && 'contentHint' in screenTrack) {
                screenTrack.contentHint = useGamingMode ? 'motion' : 'detail';
            }
            if (this.peerConnection) {
                const senders = this.peerConnection.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    await videoSender.replaceTrack(screenTrack);
                    console.log('[WebRTC] Kamera lokal digantikan oleh aliran layar.');
                    
                    // Optimasi parameter encoding WebRTC untuk membatasi bitrate & framerate (hemat kuota)
                    try {
                        const parameters = videoSender.getParameters();
                        if (!parameters.encodings) {
                            parameters.encodings = [{}];
                        }
                        if (parameters.encodings.length > 0) {
                            parameters.encodings[0].maxBitrate = useGamingMode ? 1000000 : 300000; // Limit ke 1.8 Mbps atau 400 kbps
                            parameters.encodings[0].maxFramerate = useGamingMode ? 24 : 12;
                            await videoSender.setParameters(parameters);
                            console.log(`[WebRTC] Parameter encoding berhasil dioptimalkan (${useGamingMode ? '1.8Mbps, 30 FPS' : '400kbps, 15 FPS'}).`);
                        }
                    } catch (paramErr) {
                        console.warn('[WebRTC] Gagal menyetel parameter videoSender:', paramErr);
                    }
                }
            }

            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = this.screenStream;
                localVideo.classList.remove('object-cover');
                localVideo.classList.add('object-contain');
            }

            this.isScreenSharing = true;
            this.updateScreenShareUI(true);
            this.sendScreenShareSignal(true);
            this._suspendCameraForScreenShare(true);

            screenTrack.onended = () => {
                console.log('[WebRTC] Berbagi layar dihentikan oleh pengguna.');
                this.stopScreenShare();
            };

        } catch (err) {
            console.error('[WebRTC] Gagal memulai berbagi layar:', err);
            if (err.name !== 'NotAllowedError') {
                if (window.showAlert) {
                    window.showAlert("Gagal mengakses rekaman layar: " + err.message, "Bagi Layar Gagal", "error");
                }
            }
        }
    }

            _suspendCameraForScreenShare(suspend) {
        console.log('[WebRTC] Suspend local camera for screen share:', suspend);
        
        // 1. Toggle local camera track
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                if (suspend) {
                    this._cameraPreScreenShareEnabled = videoTrack.enabled;
                    videoTrack.enabled = false;
                } else {
                    videoTrack.enabled = this._cameraPreScreenShareEnabled !== false;
                }
            }
        }
        
        // 2. Show/hide local PIP preview wrapper
        const localVideoWrapper = document.getElementById('local-video-wrapper');
        if (localVideoWrapper) {
            if (suspend) {
                localVideoWrapper.classList.add('hidden');
            } else {
                localVideoWrapper.classList.remove('hidden');
            }
        }

        // 3. Show/hide camera toggle button at the bottom controls
        const btnCamera = document.getElementById('btn-call-expand-camera');
        if (btnCamera) {
            if (suspend) {
                btnCamera.classList.add('hidden');
            } else {
                btnCamera.classList.remove('hidden');
            }
        }
    }

    _preferCodecInSdp(sdp, codecName) {
        if (!sdp) return sdp;
        const lines = sdp.split('\r\n');
        let mVideoIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('m=video') === 0) {
                mVideoIndex = i;
                break;
            }
        }
        if (mVideoIndex === -1) return sdp;

        const codecPayloads = [];
        const rtpMapRegex = new RegExp(`a=rtpmap:(\\d+)\\s+(${codecName})\\/`, 'i');
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(rtpMapRegex);
            if (match) {
                codecPayloads.push(match[1]);
            }
        }

        if (codecPayloads.length === 0) return sdp;

        const mVideoLine = lines[mVideoIndex];
        const mVideoParts = mVideoLine.split(' ');
        const media = mVideoParts[0];
        const port = mVideoParts[1];
        const proto = mVideoParts[2];
        const existingPayloads = mVideoParts.slice(3);

        const newPayloads = [];
        codecPayloads.forEach(payload => {
            if (existingPayloads.includes(payload)) {
                newPayloads.push(payload);
            }
        });
        existingPayloads.forEach(payload => {
            if (!newPayloads.includes(payload)) {
                newPayloads.push(payload);
            }
        });

        lines[mVideoIndex] = `${media} ${port} ${proto} ${newPayloads.join(' ')}`;
        return lines.join('\r\n');
    }

    _optimizeSdpCodecs(sdp) {
        let optSdp = this._preferCodecInSdp(sdp, 'AV1');
        optSdp = this._preferCodecInSdp(optSdp, 'VP9');
        return optSdp;
    }

    async stopScreenShare() {
        if (!this.isScreenSharing) return;

        console.log('[WebRTC] Menghentikan berbagi layar, mengembalikan kamera...');

        const isCapacitorNative = (
            (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
            (window.Capacitor && (window.Capacitor.platform === 'android' || window.Capacitor.platform === 'ios')) ||
            (window.cordova && window.cordova.platformId === 'android')
        );
        const isAndroidUA = /android/i.test(navigator.userAgent);
        const hasNoDisplayMedia = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
        const isAndroidWebView = isAndroidUA && hasNoDisplayMedia;
        const isApk = isCapacitorNative || isAndroidWebView;

        if (isApk && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenShare) {
            try {
                if (this._nativeIceListener) {
                    this._nativeIceListener.remove();
                    this._nativeIceListener = null;
                }
                await window.Capacitor.Plugins.ScreenShare.stopCapture();
                console.log('[Native ScreenShare] Capture dihentikan secara native.');
            } catch (err) {
                console.error('[Native ScreenShare] Gagal menghentikan capture native:', err);
            }
        }

        if (!isApk) {
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }

            if (this.localStream && this.peerConnection) {
                const cameraTrack = this.localStream.getVideoTracks()[0];
                if (cameraTrack) {
                    const senders = this.peerConnection.getSenders();
                    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        await videoSender.replaceTrack(cameraTrack);
                        console.log('[WebRTC] Kamera lokal berhasil dikembalikan ke panggilan.');
                        
                        try {
                            const parameters = videoSender.getParameters();
                            if (parameters && parameters.encodings && parameters.encodings.length > 0) {
                                delete parameters.encodings[0].maxBitrate;
                                delete parameters.encodings[0].maxFramerate;
                                await videoSender.setParameters(parameters);
                                console.log('[WebRTC] Parameter encoding kamera berhasil dikembalikan ke default.');
                            }
                        } catch (paramErr) {
                            console.warn('[WebRTC] Gagal mengembalikan parameter videoSender:', paramErr);
                        }
                    }
                }
            }

            const localVideo = document.getElementById('local-video');
            if (localVideo && this.localStream) {
                localVideo.srcObject = this.localStream;
                localVideo.classList.remove('object-contain');
                localVideo.classList.add('object-cover');
            }
        }

        this.resetPIPPosition();
        this.isScreenSharing = false;
        this.updateScreenShareUI(false);
        this.sendScreenShareSignal(false);
        this._suspendCameraForScreenShare(false);
    }

    updateScreenShareUI(active) {
        const btnScreenShare = document.getElementById('btn-call-screen-share');
        if (btnScreenShare) {
            if (active) {
                btnScreenShare.classList.remove('bg-black/40', 'border-white/10');
                btnScreenShare.classList.add('bg-emerald-500/20', 'border-emerald-500/30');
                btnScreenShare.querySelector('svg')?.classList.add('text-emerald-400');
                btnScreenShare.title = "Hentikan Berbagi Layar";
            } else {
                btnScreenShare.classList.remove('bg-emerald-500/20', 'border-emerald-500/30');
                btnScreenShare.classList.add('bg-black/40', 'border-white/10');
                btnScreenShare.querySelector('svg')?.classList.remove('text-emerald-400');
                btnScreenShare.title = "Bagi Layar";
            }
        }
    }

    async sendScreenShareSignal(active) {
        if (!this.callId) return;
        const signal = {
            type: 'screen-share-toggle',
            active: active
        };
        const formData = new FormData();
        formData.append('call_id', this.callId);
        formData.append('signal', JSON.stringify(signal));
        try {
            await fetch(`${this.baseUrl}/call/signal`, {
                method: 'POST',
                body: formData
            });
            console.log('[WebRTC] Sinyal toggle screen share dikirim:', active);
        } catch (e) {
            console.error('[WebRTC] Gagal mengirim sinyal screen share:', e);
        }
    }

    // ── Kunci orientasi layar User B agar cocok dengan stream User A ──
    // Dipanggil saat stream aktif. Unlock otomatis saat share berhenti.
    _lockOrientationToStream(isStreamLandscape) {
        if (!screen || !screen.orientation || typeof screen.orientation.lock !== 'function') {
            console.log('[Orientation] Screen Orientation API tidak tersedia, dilewati.');
            return;
        }

        const targetOrientation = isStreamLandscape ? 'landscape' : 'portrait';
        const currentType = screen.orientation.type || '';

        // Hindari spamming lock orientation jika orientasi layar saat ini sudah sesuai target
        if (targetOrientation === 'landscape' && currentType.startsWith('landscape')) {
            return;
        }
        if (targetOrientation === 'portrait' && currentType.startsWith('portrait')) {
            return;
        }

        console.log(`[Orientation] Mengunci orientasi layar ke: ${targetOrientation}`);

        screen.orientation.lock(targetOrientation)
            .then(() => {
                console.log(`[Orientation] ✓ Layar berhasil dikunci ke ${targetOrientation}`);
            })
            .catch(err => {
                // Gagal jika: perangkat tidak support, atau tidak dalam fullscreen di browser desktop.
                // Di Capacitor APK Android ini umumnya berhasil tanpa syarat fullscreen.
                console.warn('[Orientation] Gagal kunci orientasi:', err.message);
            });
    }

    // ── Lepas kunci orientasi (kembalikan ke auto-rotate sistem) ──
    _unlockOrientation() {
        if (!screen || !screen.orientation || typeof screen.orientation.unlock !== 'function') return;
        try {
            screen.orientation.unlock();
            console.log('[Orientation] Orientasi dikembalikan ke auto-rotate sistem.');
        } catch (e) {
            console.warn('[Orientation] Gagal unlock orientasi:', e.message);
        }
    }

    toggleVideoLayoutMode() {
        console.log('[Layout Mode] toggleVideoLayoutMode dipicu! _remoteScreenSharing:', this._remoteScreenSharing, 'callType:', this.callType);
        
        const remoteVideo = document.getElementById('remote-video');
        if (!remoteVideo) {
            console.error('[Layout Mode] Elemen remote-video tidak ditemukan!');
            return;
        }

        if (typeof this._videoLayoutMode === 'undefined') {
            this._videoLayoutMode = 0;
        }

        this._videoLayoutMode = (this._videoLayoutMode + 1) % 2;
        console.log('[Layout Mode] Mengubah mode layout video ke:', this._videoLayoutMode);

        const btnLayout = document.getElementById('btn-call-video-layout');
        if (btnLayout) {
            const svgPath = btnLayout.querySelector('path');
            if (svgPath) {
                if (this._videoLayoutMode === 0) {
                    svgPath.setAttribute('d', 'M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4');
                    btnLayout.setAttribute('title', 'Tampilan: Fit (Klik untuk Zoom)');
                } else if (this._videoLayoutMode === 1) {
                    svgPath.setAttribute('d', 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3');
                    btnLayout.setAttribute('title', 'Tampilan: Zoom (Klik untuk Fit)');
                }
            }
        }

        this.applyVideoLayoutMode();
    }

    applyVideoLayoutMode() {
        console.log('[Layout Mode] applyVideoLayoutMode dipicu! _remoteScreenSharing:', this._remoteScreenSharing, 'Mode:', this._videoLayoutMode);
        
        const remoteVideo = document.getElementById('remote-video');
        const overlayVideo = document.getElementById('overlay-remote-video');
        if (!remoteVideo) return;

        const mode = this._videoLayoutMode || 0;

        [remoteVideo, overlayVideo].forEach(v => {
            if (!v) return;
            v.style.backgroundColor = '#000';
            v.classList.remove('object-cover', 'object-contain', 'object-fill');

            if (mode === 0) {
                v.style.width = '100%';
                v.style.height = '100%';
                v.style.objectFit = 'contain';
                v.classList.add('object-contain');
                v.style.transform = 'none';
            } else if (mode === 1) {
                v.style.width = '100%';
                v.style.height = '100%';
                v.style.objectFit = 'cover';
                v.classList.add('object-cover');
                v.style.transform = 'none';
            }
        });
    }

    // ── Monitoring Layout Screen Share Dinamis (Periodic Fallback untuk Android WebView) ──
    startScreenShareLayoutMonitoring() {
        this.stopScreenShareLayoutMonitoring();
        let lastWidth = 0;
        let lastHeight = 0;
        this._screenShareMonitorInterval = setInterval(() => {
            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo && this._remoteScreenSharing) {
                const w = remoteVideo.videoWidth;
                const h = remoteVideo.videoHeight;
                if (w > 0 && h > 0 && (w !== lastWidth || h !== lastHeight)) {
                    console.log(`[ScreenShare Monitor] Deteksi perubahan dimensi stream: ${w}x${h} (sebelumnya ${lastWidth}x${lastHeight})`);
                    lastWidth = w;
                    lastHeight = h;
                    this.adjustScreenShareLayout();
                }
            }
        }, 1000);
    }

    stopScreenShareLayoutMonitoring() {
        if (this._screenShareMonitorInterval) {
            clearInterval(this._screenShareMonitorInterval);
            this._screenShareMonitorInterval = null;
        }
    }

    handleRemoteScreenShareToggle(active) {
        console.log('[WebRTC] Pasangan mengubah status screen share:', active);
        this._remoteScreenSharing = active; // track state untuk openExpandModal
        const remoteVideo = document.getElementById('remote-video');
        const overlayVideo = document.getElementById('overlay-remote-video');
        const expandCard = document.getElementById('call-expand-card');
        const overlayContainer = document.getElementById('call-overlay-video-container');
        const expandModal = document.getElementById('call-expand-modal');

        if (active) {
            // Jalankan penyesuaian layout dinamis berdasarkan orientasi video stream
            this.adjustScreenShareLayout();
            this.startScreenShareLayoutMonitoring();
            this._suspendCameraForScreenShare(true);
        } else {
            this.stopScreenShareLayoutMonitoring();

            // Close WebRTC screen share connection and release resources
            if (this.screenPeerConnection) {
                try {
                    this.screenPeerConnection.close();
                } catch (e) {}
                this.screenPeerConnection = null;
            }
            if (this.screenRemoteStream) {
                try {
                    this.screenRemoteStream.getTracks().forEach(t => t.stop());
                } catch (e) {}
                this.screenRemoteStream = null;
            }

            // Restore the standard video stream if present
            if (remoteVideo && this.remoteStream) {
                remoteVideo.srcObject = this.remoteStream;
                remoteVideo.play().catch(e => {});
            }
            if (overlayVideo && this.remoteStream) {
                overlayVideo.srcObject = this.remoteStream;
                overlayVideo.play().catch(e => {});
            }

            // ── Restore semua ke kondisi awal ──

            // Kembalikan orientasi layar ke auto-rotate sistem
            this._unlockOrientation();

            this.resetPIPPosition();
            this.toggleVideoControls(false);

            [remoteVideo, overlayVideo].forEach(v => {
                if (!v) return;
                v.classList.remove('object-contain');
                v.classList.add('object-cover');
                v.style.objectFit = '';
                v.style.width = '';
                v.style.height = '';
                v.style.backgroundColor = '';
                v.style.transform = '';
            });

            this._videoLayoutMode = 0;
            const btnLayout = document.getElementById('btn-call-video-layout');
            if (btnLayout) {
                const svgPath = btnLayout.querySelector('path');
                if (svgPath) {
                    svgPath.setAttribute('d', 'M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4');
                }
                btnLayout.setAttribute('title', 'Ubah Ukuran Layar');
            }

            const videoContainer = document.getElementById('call-video-container');
            if (videoContainer) {
                videoContainer.style.position = '';
                videoContainer.style.top = '';
                videoContainer.style.left = '';
                videoContainer.style.width = '';
                videoContainer.style.height = '';
                videoContainer.style.zIndex = '';
            }

            // Restore expand modal padding
            if (expandModal) {
                if (expandModal.dataset.origClass) {
                    expandModal.className = expandModal.dataset.origClass;
                    delete expandModal.dataset.origClass;
                }
            }

            // Restore expand card
            if (expandCard) {
                if (expandCard.dataset.origClass) {
                    expandCard.className = expandCard.dataset.origClass;
                    delete expandCard.dataset.origClass;
                }
                expandCard.style.minHeight = '';
                expandCard.style.height = '';
                expandCard.style.maxHeight = '';
                expandCard.style.aspectRatio = '';
                expandCard.style.padding = '';
                expandCard.style.maxWidth = '';
                expandCard.style.width = '';
                expandCard.style.borderRadius = '';
                expandCard.style.border = '';
                expandCard.style.margin = '';
            }

            // Restore overlay container
            if (overlayContainer) {
                if (overlayContainer.dataset.origClass) {
                    overlayContainer.className = overlayContainer.dataset.origClass;
                    delete overlayContainer.dataset.origClass;
                }
                overlayContainer.style.aspectRatio = '';
                overlayContainer.style.maxHeight = '';
            }
            this._suspendCameraForScreenShare(false);
        }

        // Selalu panggil updateVideoUI agar kontainer video/avatar disinkronkan seketika
        this.updateVideoUI();
    }

    adjustScreenShareLayout() {
        if (!this._remoteScreenSharing) return;

        const remoteVideo = document.getElementById('remote-video');
        const overlayVideo = document.getElementById('overlay-remote-video');
        const expandCard = document.getElementById('call-expand-card');
        const overlayContainer = document.getElementById('call-overlay-video-container');
        const expandModal = document.getElementById('call-expand-modal');
        const expandHeader = document.getElementById('call-expand-header');
        const expandControls = document.getElementById('call-expand-controls');

        if (!remoteVideo) return;

        // ── Selalu gunakan object-contain agar konten stream TIDAK PERNAH terpotong ──
        // Width 100% memastikan video rata kanan-kiri (full width).
        const streamW = remoteVideo.videoWidth;
        const streamH = remoteVideo.videoHeight;
        const isStreamLandscape = streamW > streamH;
        console.log(`[ScreenShare Layout] Stream: ${streamW}x${streamH} — ${isStreamLandscape ? 'Landscape' : 'Portrait'}`);

        // Kunci orientasi layar User B (viewer) agar sesuai dengan orientasi stream dari User A (host)
        this._lockOrientationToStream(isStreamLandscape);

        this.applyVideoLayoutMode();

        const videoContainer = document.getElementById('call-video-container');
        if (videoContainer) {
            videoContainer.style.position = 'absolute';
            videoContainer.style.top = '0';
            videoContainer.style.left = '0';
            videoContainer.style.width = '100vw';
            videoContainer.style.height = '100vh';
            videoContainer.style.height = '100dvh';
            videoContainer.style.zIndex = '0';
        }

        if (isStreamLandscape) {
            // Mode True Fullscreen: Sembunyikan kontrol agar video mengambil ruang maksimal,
            // tetapi biarkan pengguna dapat mengklik layar untuk memunculkan HUD kembali.
            this.toggleVideoControls(true);
        } else {
            // Mode Normal Portrait: Tampilkan kembali kontrol/menu obrolan
            this.toggleVideoControls(false);
        }
        this.resetPIPPosition();



        // ── Hilangkan padding modal pada desktop agar card bisa benar-benar menyentuh tepi layar ──
        if (expandModal) {
            if (!expandModal.dataset.origClass) {
                expandModal.dataset.origClass = expandModal.className;
            }
            expandModal.classList.remove('md:p-4');
        }

        // ── Buat Expand Card Full Screen Tanial Batasan (Theater Mode) ──
        if (expandCard) {
            if (!expandCard.dataset.origClass) {
                expandCard.dataset.origClass = expandCard.className;
            }
            // Hapus class tailwind pembatas
            expandCard.classList.remove('max-w-sm', 'md:max-w-4xl', 'md:h-[85vh]', 'md:rounded-3xl');

            // Terapkan inline style full-bleed
            expandCard.style.maxWidth = '100vw';
            expandCard.style.width = '100vw';
            expandCard.style.height = '100vh';
            expandCard.style.height = '100dvh';
            expandCard.style.minHeight = '100dvh';
            expandCard.style.maxHeight = '100dvh';
            expandCard.style.borderRadius = '0';
            expandCard.style.border = 'none';
            expandCard.style.margin = '0';
            expandCard.style.padding = '0';
            expandCard.style.aspectRatio = '';
        }

        // ── Overlay widget aspect ratio sesuai video stream ──
        if (overlayContainer) {
            if (!overlayContainer.dataset.origClass) {
                overlayContainer.dataset.origClass = overlayContainer.className;
            }
            const isLandscape = remoteVideo.videoWidth > remoteVideo.videoHeight;
            if (isLandscape) {
                overlayContainer.classList.add('aspect-video');
                overlayContainer.style.aspectRatio = '16 / 9';
                overlayContainer.style.maxHeight = '';
            } else {
                overlayContainer.classList.remove('aspect-video');
                overlayContainer.style.aspectRatio = '9 / 16';
                overlayContainer.style.maxHeight = '260px';
            }
        }
    }

    async flipCamera() {
        if (!this.localStream || this.callType !== 'video') return;

        const newFacingMode = this.cameraFacingMode === 'user' ? 'environment' : 'user';
        console.log(`[Camera Flip] Switching camera facingMode to: ${newFacingMode}`);

        const btnFlip = document.getElementById('btn-call-flip-camera');
        if (btnFlip) {
            btnFlip.classList.add('animate-spin'); // Micro-animation during rotation
            btnFlip.disabled = true;
        }

        // Simpan track video lama untuk referensi jika gagal fallback
        const oldVideoTrack = this.localStream.getVideoTracks()[0];
        const oldFacingMode = this.cameraFacingMode;

        try {
            // 1. Hentikan kamera lama SEBELUM meminta kamera baru untuk melepaskan hardware lock (Sangat Krusial untuk Oppo/Realme)
            if (oldVideoTrack) {
                oldVideoTrack.stop(); // Hentikan kamera lama agar lampu indikator mati dan sensor dilepas
                this.localStream.removeTrack(oldVideoTrack);
            }

            // 2. Ambil video stream baru dengan facingMode yang baru
            let newStream;
            try {
                newStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: { ideal: newFacingMode },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                });
            } catch (err) {
                console.warn('[Camera Flip] Gagal dengan ideal constraints, mencoba fallback tanpa resolusi ideal...', err);
                // Fallback: coba request tanpa ideal resolution untuk kompabilitas maksimum
                newStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: newFacingMode
                    }
                });
            }

            const newVideoTrack = newStream.getVideoTracks()[0];
            if (!newVideoTrack) throw new Error("No video track found in the new stream.");

            // 3. Tambahkan track baru ke localStream
            this.localStream.addTrack(newVideoTrack);

            // 4. Update view video lokal
            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = this.localStream;
            }

            // 5. Ganti track di RTCPeerConnection sender (agar remote peer menerima track baru)
            if (this.peerConnection) {
                const senders = this.peerConnection.getSenders();
                const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
                if (videoSender) {
                    await videoSender.replaceTrack(newVideoTrack);
                    console.log('[Camera Flip] Video track successfully replaced in PeerConnection.');
                }
            }

            // 6. Simpan state facingMode yang baru
            this.cameraFacingMode = newFacingMode;

            // 7. Update title / styling untuk menandakan mode kamera
            if (btnFlip) {
                if (newFacingMode === 'environment') {
                    btnFlip.classList.remove('bg-white/5', 'border-white/10');
                    btnFlip.classList.add('bg-emerald-500/20', 'border-emerald-500/30');
                    btnFlip.querySelector('svg')?.classList.add('text-emerald-400');
                    btnFlip.title = "Gunakan Kamera Depan";
                } else {
                    btnFlip.classList.remove('bg-emerald-500/20', 'border-emerald-500/30');
                    btnFlip.classList.add('bg-white/5', 'border-white/10');
                    btnFlip.querySelector('svg')?.classList.remove('text-emerald-400');
                    btnFlip.title = "Gunakan Kamera Belakang";
                }
            }
        } catch (err) {
            console.error('[Camera Flip] Failed to switch camera:', err);

            // ── FALLBACK AUTO-RECOVERY ──
            // Jika gagal memutar ke kamera baru, coba aktifkan kembali kamera lama agar video tidak hitam/beku permanen
            console.log('[Camera Flip] Mencoba memulihkan kamera sebelumnya...');
            try {
                const fallbackStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: { ideal: oldFacingMode },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                });
                const fallbackTrack = fallbackStream.getVideoTracks()[0];
                if (fallbackTrack) {
                    this.localStream.addTrack(fallbackTrack);
                    const localVideo = document.getElementById('local-video');
                    if (localVideo) localVideo.srcObject = this.localStream;

                    if (this.peerConnection) {
                        const senders = this.peerConnection.getSenders();
                        const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
                        if (videoSender) {
                            await videoSender.replaceTrack(fallbackTrack);
                        }
                    }
                }
            } catch (fallbackErr) {
                console.error('[Camera Flip Recovery] Gagal memulihkan kamera lama:', fallbackErr);
            }

            if (typeof window.showCustomAlert === 'function') {
                window.showCustomAlert('Kamera', 'Gagal memutar kamera atau perangkat tidak mendukung kamera belakang.');
            } else {
                alert('Gagal memutar kamera atau perangkat tidak mendukung kamera belakang.');
            }
        } finally {
            if (btnFlip) {
                setTimeout(() => {
                    btnFlip.classList.remove('animate-spin');
                    btnFlip.disabled = false;
                }, 600); // Tunggu animasi selesai
            }
        }
    }

    // --------------------------------------------------------
    // UI MANAGEMENT (TIMER & MODAL SHOW/HIDE)
    // --------------------------------------------------------
    startTimer() {
        this.stopTimer();
        this.callDuration = 0;

        this.callTimer = setInterval(() => {
            this.callDuration++;
            const minutes = String(Math.floor(this.callDuration / 60)).padStart(2, '0');
            const seconds = String(this.callDuration % 60).padStart(2, '0');
            const formatted = `${minutes}:${seconds}`;

            // Update semua elemen timer (widget, expand modal, restore bubble)
            const ids = ['call-timer', 'call-expand-timer', 'call-restore-timer'];
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = formatted;
            });
        }, 1000);
    }

    stopTimer() {
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }
        ['call-timer', 'call-expand-timer', 'call-restore-timer'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '00:00';
        });
    }

    showOverlay() {
        // Tampilkan floating widget (bukan full-screen)
        const overlay = document.getElementById('call-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.classList.add('flex');
        }
        // Pastikan restore button tersembunyi
        const restoreBtn = document.getElementById('call-restore-btn');
        if (restoreBtn) restoreBtn.classList.add('hidden');
    }

    hideOverlay() {
        // Sembunyikan widget dan expand modal
        const overlay = document.getElementById('call-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
        }
        this.closeExpandModal();
        // Sembunyikan restore button juga
        const restoreBtn = document.getElementById('call-restore-btn');
        if (restoreBtn) {
            restoreBtn.classList.add('hidden');
            restoreBtn.classList.remove('flex');
        }
    }

    minimizeWidget() {
        // Sembunyikan widget, tampilkan bubble kecil
        const overlay = document.getElementById('call-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
        }
        const restoreBtn = document.getElementById('call-restore-btn');
        if (restoreBtn) {
            restoreBtn.classList.remove('hidden');
            restoreBtn.classList.add('flex');
            // Tampilkan timer di bubble jika call aktif
            const restoreTimer = document.getElementById('call-restore-timer');
            if (restoreTimer && this.status === 'active') {
                restoreTimer.classList.remove('hidden');
            }
        }
        sessionStorage.setItem('hk_call_minimized', 'true');
    }

    restoreWidget() {
        // Kembalikan widget, sembunyikan bubble
        const restoreBtn = document.getElementById('call-restore-btn');
        if (restoreBtn) {
            restoreBtn.classList.add('hidden');
            restoreBtn.classList.remove('flex');
        }
        const overlay = document.getElementById('call-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.classList.add('flex');
        }
        sessionStorage.setItem('hk_call_minimized', 'false');
    }

    openExpandModal() {
        const modal = document.getElementById('call-expand-modal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        // Reset controls visibility
        const header = document.getElementById('call-expand-header');
        const controls = document.getElementById('call-expand-controls');
        if (header && controls) {
            header.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-4');
            controls.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
        }

        // Sync konten expand modal dengan state saat ini
        const expandName = document.getElementById('call-expand-name');
        const expandStatus = document.getElementById('call-expand-status');
        const expandTimerContainer = document.getElementById('call-expand-timer-container');
        const expandAvatar = document.getElementById('call-expand-avatar');
        const expandFallback = document.getElementById('call-expand-fallback');

        const widgetName = document.getElementById('call-partner-name');
        const widgetStatus = document.getElementById('call-status-text');
        const widgetAvatar = document.getElementById('call-partner-avatar');

        if (expandName && widgetName) expandName.textContent = widgetName.textContent;
        if (expandStatus && widgetStatus) expandStatus.textContent = widgetStatus.textContent;

        if (expandAvatar && widgetAvatar && widgetAvatar.src && !widgetAvatar.classList.contains('hidden')) {
            expandAvatar.src = widgetAvatar.src;
            expandAvatar.classList.remove('hidden');
            if (expandFallback) expandFallback.classList.add('hidden');
        } else if (expandFallback) {
            expandFallback.classList.remove('hidden');
            if (expandAvatar) expandAvatar.classList.add('hidden');
        }

        if (this.status === 'active') {
            if (expandTimerContainer) expandTimerContainer.classList.remove('hidden');
        } else {
            if (expandTimerContainer) expandTimerContainer.classList.add('hidden');
        }

        // Jika partner sedang screen share, terapkan ulang layout dinamis agar modal
        // tetap pas meski user baru buka expand modal di tengah sesi.
        if (this._remoteScreenSharing) {
            this.adjustScreenShareLayout();
        }
    }

    closeExpandModal() {
        const modal = document.getElementById('call-expand-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    hideIncomingModal() {
        const modal = document.getElementById('incoming-call-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        if (this._incomingLocalNotif) {
            try {
                this._incomingLocalNotif.close();
            } catch (err) {
                // Ignore
            }
            this._incomingLocalNotif = null;
        }
        // Bersihkan notifikasi lokal native Capacitor juga!
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
            try {
                window.Capacitor.Plugins.LocalNotifications.cancel({
                    notifications: [{ id: 9999 }]
                });
            } catch (err) {
                // Ignore
            }
        }
    }

    showTransferCallUI(data) {
        let widget = document.getElementById('call-transfer-widget');
        if (widget) return; // Sudah ada widget transfer

        widget = document.createElement('div');
        widget.id = 'call-transfer-widget';
        widget.className = 'fixed bottom-4 right-4 bg-slate-900/95 backdrop-blur-md text-white border border-emerald-500/30 p-4 rounded-2xl shadow-2xl z-[9999] flex flex-col gap-3 min-w-[280px] animate-fade-in';
        widget.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></div>
                <div class="flex flex-col">
                    <span class="text-[10px] text-slate-400 font-semibold tracking-wider uppercase">PANGGILAN AKTIF</span>
                    <span class="text-xs font-semibold text-slate-200">Sedang aktif di tab lain...</span>
                </div>
            </div>
            <button id="btn-transfer-call" class="w-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white font-medium text-[11px] py-2 px-3 rounded-xl transition duration-150 flex items-center justify-center gap-2">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                Pindahkan ke Tab Ini
            </button>
        `;
        document.body.appendChild(widget);

        // Tambahkan event handler untuk memindahkan panggilan
        const btn = widget.querySelector('#btn-transfer-call');
        if (btn) {
            btn.addEventListener('click', () => {
                console.log('[Call] Pengguna memindahkan panggilan ke tab ini...');
                widget.remove();

                // Klaim sesi secara paksa (hijack)
                this.claimCallSession(data.call_id, 'active');

                // Mulai sambungkan kembali di tab ini
                this.reconnectActiveCall(data);
            });
        }
    }

    hideTransferCallUI() {
        const widget = document.getElementById('call-transfer-widget');
        if (widget) {
            widget.remove();
        }
    }

    // --------------------------------------------------------
    // MENGELOLA DINAMIS WARNA & STATUS INDIKATOR KONEKSI (IDE USER)
    // --------------------------------------------------------
    handleConnectionStateChange(iceState, connState) {
        if (this.status === 'idle') return;

        console.log(`[Call Connection Watcher] ICE: ${iceState} | Conn: ${connState}`);

        // Jika salah satu sisi mendeteksi disconnect sementara (akibat reload/pindah tab/page)
        if (
            iceState === 'disconnected' ||
            iceState === 'failed' ||
            connState === 'disconnected' ||
            connState === 'failed'
        ) {
            console.warn('[Call Connection Watcher] Terdeteksi putus sementara. Mengubah UI ke mode Reconnect...');
            this.setCallUIState('reconnecting', 'Pasangan sedang menyambung kembali...');

            // Aktifkan polling super cepat 800ms agar pemulihan berjalan instan!
            this.startReconnectingPolling();
        } else if (
            iceState === 'connected' ||
            iceState === 'completed' ||
            connState === 'connected'
        ) {
            // Jika berhasil terhubung kembali
            console.log('[Call Connection Watcher] Koneksi sehat kembali!');
            this.setCallUIState('active', 'Terhubung');

            // Kembalikan ke mode polling normal 1.5 detik demi efisiensi server
            this.startActivePolling();
        }
    }

    setCallUIState(state, text) {
        const txtStatus = document.getElementById('call-status-text');
        const iconContainer = document.getElementById('call-ui-pulse');
        const timerContainer = document.getElementById('call-timer-container');
        const expandStatus = document.getElementById('call-expand-status');
        const expandTimerContainer = document.getElementById('call-expand-timer-container');
        const widgetHeader = document.getElementById('call-widget-header');

        const restoreStatus = document.getElementById('call-restore-status');
        const restoreTimer = document.getElementById('call-restore-timer');

        if (txtStatus) txtStatus.textContent = text;
        if (expandStatus) expandStatus.textContent = text;

        const pulseRing = document.querySelector('#call-expand-modal .animate-ping');

        if (state === 'active') {
            // 🟢 TERHUBUNG: Efek denyut hijau neon premium
            if (iconContainer) {
                iconContainer.style.opacity = '1';
                iconContainer.className = "absolute -inset-1 rounded-full border border-emerald-500/50 animate-ping";
            }
            if (pulseRing) {
                pulseRing.className = "w-28 h-28 rounded-full bg-emerald-500/10 border border-emerald-500/30 absolute animate-ping opacity-50";
            }
            if (txtStatus) {
                txtStatus.className = "text-[10px] text-emerald-400 font-semibold";
            }
            if (expandStatus) {
                expandStatus.className = "text-xs text-emerald-400 font-semibold";
            }
            if (widgetHeader) {
                widgetHeader.classList.remove('bg-rose-500/10', 'bg-amber-500/10');
                widgetHeader.classList.add('bg-emerald-500/10');
            }

            if (timerContainer) timerContainer.classList.remove('hidden');
            if (expandTimerContainer) expandTimerContainer.classList.remove('hidden');

            if (restoreTimer) restoreTimer.classList.remove('hidden');
            if (restoreStatus) {
                restoreStatus.textContent = 'AKTIF';
                restoreStatus.className = "text-[9px] text-emerald-400 font-bold tracking-wider uppercase animate-pulse";
            }

        } else if (state === 'reconnecting') {
            // 🟡 RECONNECTING (IDE USER): Efek denyut amber/oranye dinamis
            if (iconContainer) {
                iconContainer.style.opacity = '1';
                iconContainer.className = "absolute -inset-1 rounded-full border border-amber-500/60 animate-ping";
            }
            if (pulseRing) {
                pulseRing.className = "w-28 h-28 rounded-full bg-amber-500/10 border border-amber-500/35 absolute animate-ping opacity-60";
            }
            if (txtStatus) {
                txtStatus.className = "text-[10px] text-amber-400 font-semibold animate-pulse hover:underline cursor-pointer";
                txtStatus.textContent = "Sambungkan Kembali 🔁";
            }
            if (expandStatus) {
                expandStatus.className = "text-xs text-amber-400 font-semibold animate-pulse hover:underline cursor-pointer";
                expandStatus.textContent = "Ketuk untuk Hubungkan Kembali 🔁";
            }
            if (widgetHeader) {
                widgetHeader.classList.remove('bg-rose-500/10', 'bg-emerald-500/10');
                widgetHeader.classList.add('bg-amber-500/10');
            }

            // Tetap biarkan timer berjalan
            if (timerContainer) timerContainer.classList.remove('hidden');
            if (expandTimerContainer) expandTimerContainer.classList.remove('hidden');

            if (restoreTimer) restoreTimer.classList.remove('hidden');
            if (restoreStatus) {
                restoreStatus.textContent = 'RECONNECT';
                restoreStatus.className = "text-[9px] text-amber-400 font-bold tracking-wider uppercase animate-pulse";
            }

        } else {
            // 🔴 DIALING / RINGING / IDLE
            if (iconContainer) {
                iconContainer.style.opacity = state === 'dialing' ? '1' : '0';
                iconContainer.className = "absolute -inset-1 rounded-full border border-rose-500/40 animate-ping";
            }
            if (pulseRing) {
                pulseRing.className = "w-28 h-28 rounded-full bg-rose-500/5 border border-rose-500/20 absolute animate-ping opacity-30";
            }
            if (txtStatus) {
                txtStatus.className = "text-[10px] text-rose-300 font-medium";
            }
            if (expandStatus) {
                expandStatus.className = "text-xs text-gray-400";
            }
            if (widgetHeader) {
                widgetHeader.classList.remove('bg-emerald-500/10', 'bg-amber-500/10');
                widgetHeader.classList.add('bg-rose-500/10');
            }

            if (timerContainer) timerContainer.classList.add('hidden');
            if (expandTimerContainer) expandTimerContainer.classList.add('hidden');

            if (restoreTimer) restoreTimer.classList.add('hidden');
            if (restoreStatus) {
                if (state === 'dialing') {
                    restoreStatus.textContent = 'MEMANGGIL';
                } else if (state === 'ringing') {
                    restoreStatus.textContent = 'BERDERING';
                } else {
                    restoreStatus.textContent = 'PANGGILAN';
                }
                restoreStatus.className = "text-[9px] text-rose-400 font-bold tracking-wider uppercase animate-pulse";
            }
        }

        // Pemicu Audio Ducking dinamis
        this.checkAudioDucking();
    }

    updateOverlayDetails(partnerName, partnerAvatar) {
        // Defensif check
        if (typeof partnerAvatar !== 'string') partnerAvatar = '';
        if (partnerAvatar && (partnerAvatar.startsWith('http://') || partnerAvatar.startsWith('https://')) && !partnerAvatar.includes('images.weserv.nl')) {
            partnerAvatar = 'https://images.weserv.nl/?url=' + encodeURIComponent(partnerAvatar);
        }

        // ── Widget: nama ──
        const nameEl = document.getElementById('call-partner-name');
        if (nameEl && partnerName) nameEl.textContent = partnerName;

        // ── Widget: avatar ──
        const imgAvatar = document.getElementById('call-partner-avatar');
        const fallbackIcon = document.getElementById('call-fallback-icon');
        if (imgAvatar && partnerAvatar) {
            imgAvatar.onerror = () => {
                imgAvatar.classList.add('hidden');
                if (fallbackIcon) fallbackIcon.classList.remove('hidden');
            };
            imgAvatar.src = partnerAvatar;
            imgAvatar.classList.remove('hidden');
            if (fallbackIcon) fallbackIcon.classList.add('hidden');
        } else if (fallbackIcon) {
            fallbackIcon.classList.remove('hidden');
            if (imgAvatar) imgAvatar.classList.add('hidden');
        }

        // ── Expand Modal: nama & avatar ──
        const expandName = document.getElementById('call-expand-name');
        if (expandName && partnerName) expandName.textContent = partnerName;

        const expandAvatar = document.getElementById('call-expand-avatar');
        const expandFallback = document.getElementById('call-expand-fallback');
        if (expandAvatar && partnerAvatar) {
            expandAvatar.onerror = () => {
                expandAvatar.classList.add('hidden');
                if (expandFallback) expandFallback.classList.remove('hidden');
            };
            expandAvatar.src = partnerAvatar;
            expandAvatar.classList.remove('hidden');
            if (expandFallback) expandFallback.classList.add('hidden');
        } else if (expandFallback) {
            expandFallback.classList.remove('hidden');
            if (expandAvatar) expandAvatar.classList.add('hidden');
        }

        // ── Restore Bubble: nama & avatar ──
        const restoreName = document.getElementById('call-restore-name');
        if (restoreName && partnerName) restoreName.textContent = partnerName;

        const restoreAvatar = document.getElementById('call-restore-avatar');
        const restoreFallback = document.getElementById('call-restore-fallback');
        if (restoreAvatar && partnerAvatar) {
            restoreAvatar.onerror = () => {
                restoreAvatar.classList.add('hidden');
                if (restoreFallback) restoreFallback.classList.remove('hidden');
            };
            restoreAvatar.src = partnerAvatar;
            restoreAvatar.classList.remove('hidden');
            if (restoreFallback) restoreFallback.classList.add('hidden');
        } else if (restoreFallback) {
            restoreFallback.classList.remove('hidden');
            if (restoreAvatar) restoreAvatar.classList.add('hidden');
        }
    }

    // --------------------------------------------------------
    // PJAX SPA INTEGRATION: Pulihkan tampilan UI setelah navigasi halaman
    // Dipanggil setiap kali PJAX selesai mengganti konten <main>.
    // Karena overlay berada di luar <main>, elemen DOM-nya tetap ada —
    // kita hanya perlu memastikan visibility class-nya sinkron dengan status.
    // --------------------------------------------------------
    restoreCallUI() {
        if (this.status === 'idle') {
            // Pastikan semua UI panggilan tersembunyi saat idle
            this.hideOverlay();
            this.hideIncomingModal();
            return;
        }

        // Ada panggilan aktif/dialing/ringing — tampilkan kembali UI yang sesuai
        console.log('[Call PJAX] Memulihkan UI panggilan setelah navigasi. Status:', this.status);

        if (this.status === 'ringing' && this.role === 'receiver') {
            // Tampilkan kembali modal panggilan masuk
            const modal = document.getElementById('incoming-call-modal');
            if (modal && modal.classList.contains('hidden')) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
            // Perbarui nama & avatar jika ada
            if (this.incomingCallerName) {
                const nameEl = document.getElementById('incoming-caller-name');
                if (nameEl) nameEl.textContent = this.incomingCallerName;
            }
        } else if (this.status === 'dialing' || this.status === 'active') {
            const isMinimized = sessionStorage.getItem('hk_call_minimized') === 'true';
            if (isMinimized) {
                // Tampilkan bubble, sembunyikan overlay utama
                const overlay = document.getElementById('call-overlay');
                if (overlay) {
                    overlay.classList.add('hidden');
                    overlay.classList.remove('flex');
                }
                const restoreBtn = document.getElementById('call-restore-btn');
                if (restoreBtn) {
                    restoreBtn.classList.remove('hidden');
                    restoreBtn.classList.add('flex');
                    const restoreTimer = document.getElementById('call-restore-timer');
                    if (restoreTimer && this.status === 'active') {
                        restoreTimer.classList.remove('hidden');
                    }
                }
            } else {
                // Tampilkan kembali floating call widget
                const overlay = document.getElementById('call-overlay');
                if (overlay && overlay.classList.contains('hidden')) {
                    overlay.classList.remove('hidden');
                    overlay.classList.add('flex');
                }
                // Pastikan restore button tidak terlihat saat widget sudah tampil
                const restoreBtn = document.getElementById('call-restore-btn');
                if (restoreBtn) restoreBtn.classList.add('hidden');
            }
        }

        // Paksa polling status instan setelah navigasi selesai untuk sinkronisasi seketika!
        this.pollCallStatus();

        // Re-attach tombol navbar agar tetap berfungsi setelah PJAX
        this.bindNavButtons();
    }

    // Re-attach event listener tombol telepon di navbar (aman dipanggil berkali-kali)
    bindNavButtons() {
        // Hapus listener lama terlebih dahulu untuk mencegah duplikasi
        if (this._navCallHandler) {
            const old = document.getElementById('nav-call-btn');
            if (old) old.removeEventListener('click', this._navCallHandler);
            const oldV = document.getElementById('nav-video-btn');
            if (oldV) oldV.removeEventListener('click', this._navVideoHandler);
        }
        // Buat handler baru dan simpan referensinya
        this._navCallHandler = () => this.startCallFlow('audio');
        this._navVideoHandler = () => this.startCallFlow('video');

        const btnCall = document.getElementById('nav-call-btn');
        if (btnCall) btnCall.addEventListener('click', this._navCallHandler);

        const btnVideo = document.getElementById('nav-video-btn');
        if (btnVideo) btnVideo.addEventListener('click', this._navVideoHandler);

        console.log('[Call] Nav buttons re-bound.');
    }

    getAudioConstraints() {
        const echoCancellation = localStorage.getItem('hk_audio_echo_cancellation') !== 'false';
        const noiseSuppression = localStorage.getItem('hk_audio_noise_suppression') !== 'false';
        const autoGainControl = localStorage.getItem('hk_audio_auto_gain_control') !== 'false';

        const audioConstraints = {
            echoCancellation: echoCancellation,
            noiseSuppression: noiseSuppression,
            autoGainControl: autoGainControl
        };

        const selectedMicId = localStorage.getItem('hk_audio_input_device_id');
        if (selectedMicId && selectedMicId !== 'default') {
            audioConstraints.deviceId = { exact: selectedMicId };
        }

        return audioConstraints;
    }

    applyAudioOutputDevice() {
        const selectedSpeakerId = localStorage.getItem('hk_audio_output_device_id');
        if (selectedSpeakerId && this.remoteAudio && typeof this.remoteAudio.setSinkId === 'function') {
            this.remoteAudio.setSinkId(selectedSpeakerId)
                .then(() => {
                    console.log(`[Call Output] Audio berhasil dirutekan ke speaker: ${selectedSpeakerId}`);
                })
                .catch(err => {
                    console.warn('[Call Output] Gagal merutekan audio output:', err);
                });
        }
    }

    checkAudioDucking() {
        if (window.roomVideo && typeof window.roomVideo.duckVolume === 'function') {
            const shouldDuck = (this.status === 'active');
            window.roomVideo.duckVolume(shouldDuck);
        }
    }
}


// ============================================================
// INISIALISASI & INTEGRASI PJAX SPA
// call.js dimuat SEKALI di main.php. window.relationshipCall
// persisten di semua navigasi PJAX — tidak perlu diinisiasi ulang.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    // Guard: Jangan buat instance baru jika sudah ada
    // (misal: jika call.js entah bagaimana dieksekusi dua kali)
    if (window.relationshipCall) {
        console.log('[Call] Instance sudah ada — melewati inisialisasi ulang.');
    } else {
        window.relationshipCall = new RelationshipCall();
    }

    // ── Tangani klik dari Push Notification ──
    // Jika halaman dibuka dari notifikasi push panggilan masuk,
    // URL akan mengandung ?incoming_call_id=xxx
    const urlParams = new URLSearchParams(window.location.search);
    const incomingCallId = urlParams.get('incoming_call_id');

    if (incomingCallId) {
        // Bersihkan parameter dari URL agar tidak tersimpan di history browser
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);

        // Tunggu sebentar agar DOM overlay selesai dirender, lalu paksa polling
        console.log('[Push] Panggilan masuk terdeteksi dari notifikasi, call_id:', incomingCallId);
        setTimeout(() => {
            if (window.relationshipCall && window.relationshipCall.status === 'idle') {
                window.relationshipCall.startActivePolling();
            }
        }, 800);
    }
});

// ── Integrasi PJAX SPA: Sinkronisasi setelah navigasi halaman ──
// Setelah PJAX mengganti konten <main>, panggil restoreCallUI()
// agar overlay yang seharusnya tampil tetap tampil.
window.addEventListener('pjax:complete', () => {
    if (window.relationshipCall) {
        window.relationshipCall.restoreCallUI();
    }
});
