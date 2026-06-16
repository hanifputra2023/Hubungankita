// ============================================================
// public/assets/js/screen_share_v2.js
// NativeScreenShareSession — Manajemen sesi berbagi layar native
// mandiri (tanpa panggilan suara/video).
//
// Arsitektur:
//   Sharer (Android APK): ScreenSharePlugin.java → WebRTC native
//   Viewer  (browser/APK): RTCPeerConnection web standar
//   Signaling: Pusher (existing) + server /layarbersama/...
// ============================================================

class NativeScreenShareSession {
    constructor({ baseUrl, coupleKey, userId, partnerId, username, partnerName, partnerAvatar, pusherChannel }) {
        this.baseUrl        = baseUrl;
        this.coupleKey      = coupleKey;
        this.userId         = userId;
        this.partnerId      = partnerId;
        this.username       = username;
        this.partnerName    = partnerName;
        this.partnerAvatar  = partnerAvatar;
        this.pusherChannel  = pusherChannel; // Objek channel Pusher yang sudah subscribe

        // RTCConfig — gunakan STUN gratis yang sama dengan call_v2.js
        this.rtcConfig = {
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            sdpSemantics: 'unified-plan',
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' },
            ],
        };

        // State
        this.status     = 'idle';   // 'idle' | 'sharing' | 'viewing' | 'connecting'
        this.role       = null;     // 'sharer' | 'viewer'
        this.sessionId  = null;
        this.pc         = null;     // RTCPeerConnection (hanya dipakai di sisi viewer)
        this.localStream = null;    // Audio stream lokal sharer (mic)

        // Pending ICE buffer
        this._pendingCandidates = [];
        this._remoteDescSet     = false;

        // Timer
        this._timerInterval = null;
        this._secondsElapsed = 0;

        // Bind Pusher events
        this._bindPusherEvents();

        // Cek apakah ada sesi aktif saat halaman dibuka
        this._checkExistingSession();
    }

    // ============================================================
    // PUSHER: Dengarkan event screen share dari pasangan
    // ============================================================
    _bindPusherEvents() {
        if (!this.pusherChannel) {
            console.warn('[ScreenShare] Pusher channel belum tersedia, fallback ke polling & menunggu pusher-ready...');
            this._startPolling();

            // Coba ambil channel begitu Pusher ready
            const onPusherReady = () => {
                if (window._globalCoupleChannel && !this.pusherChannel) {
                    this.pusherChannel = window._globalCoupleChannel;
                    this._stopPolling();
                    this._bindPusherEvents(); // re-bind sekarang channel sudah ada
                }
            };

            // Jika sudah ready, langsung bind
            if (window._pusherReadyFired && window._globalCoupleChannel) {
                onPusherReady();
            } else {
                document.addEventListener('pusher-ready', function handler() {
                    document.removeEventListener('pusher-ready', handler);
                    onPusherReady();
                });
            }
            return;
        }

        // Pasangan mulai share screen
        this.pusherChannel.bind('screen-share-incoming', (data) => {
            console.log('[ScreenShare] Menerima notifikasi share screen masuk:', data);
            // Hanya tampilkan jika KITA adalah viewer (bukan sharer)
            if (data.sharer_id && String(data.sharer_id) === String(this.userId)) {
                console.log('[ScreenShare] Kita adalah sharer, abaikan event ini.');
                return;
            }
            this._onIncomingShareScreen(data);
        });

        // Menerima sinyal WebRTC (SDP Answer, ICE candidates)
        this.pusherChannel.bind('screen-share-signal', (data) => {
            console.log('[ScreenShare] Menerima sinyal WebRTC:', data.signal?.type);
            if (data.sender_id && String(data.sender_id) === String(this.userId)) return;
            this._handleIncomingSignal(data);
        });

        // Sesi share screen dihentikan
        this.pusherChannel.bind('screen-share-ended', (data) => {
            console.log('[ScreenShare] Sesi share screen dihentikan oleh pasangan.');
            this._onRemoteSessionEnded();
        });
    }

    // ============================================================
    // STATE: Cek sesi aktif saat halaman pertama kali dibuka
    // ============================================================
    async _checkExistingSession() {
        try {
            const data = await this._fetchJson(`${this.baseUrl}/layarbersama/poll`, { method: 'POST' });
            if (data.status === 'idle') return;

            console.log('[ScreenShare] Menemukan sesi aktif:', data);

            if (data.role === 'sharer') {
                // Kita adalah sharer — perbarui UI saja
                this.sessionId = data.session_id;
                this.role      = 'sharer';
                this.status    = 'sharing';
                this._updateUI('sharing');
            } else if (data.role === 'viewer' && data.status === 'active') {
                // Kita adalah viewer dan sesi sudah aktif
                this.sessionId = data.session_id;
                this.role      = 'viewer';
                await this._startViewerConnection(data.sdp_offer, data.ice_candidates_sharer || []);
            } else if (data.role === 'viewer' && data.status === 'pending') {
                // Sesi pending — pasangan baru mulai share
                this._onIncomingShareScreen({
                    session_id:    data.session_id,
                    sdp_offer:     data.sdp_offer,
                    sharer_name:   this.partnerName,
                    sharer_avatar: this.partnerAvatar,
                });
            }
        } catch (e) {
            console.warn('[ScreenShare] Gagal cek sesi awal:', e);
        }
    }

    // ============================================================
    // SHARER: Mulai share screen dari Android native plugin
    // ============================================================
    async startSharing(useGamingMode = false) {
        if (this.status !== 'idle') {
            console.warn('[ScreenShare] Sesi sudah aktif, status:', this.status);
            return;
        }

        const isApk = this._isCapacitorNative();
        if (!isApk) {
            this._showAlert('Fitur berbagi layar native hanya tersedia di aplikasi Android.', 'Tidak Didukung', 'info');
            return;
        }

        if (!window.Capacitor?.Plugins?.ScreenShare) {
            this._showAlert('Plugin ScreenShare tidak ditemukan. Pastikan APK sudah versi terbaru.', 'Plugin Tidak Ada', 'error');
            return;
        }

        this.status = 'connecting';
        this._updateUI('connecting');
        this._pendingNativeCandidates = [];

        try {
            // Register native listener sebelum memanggil startNativeWebRTC
            if (this.nativeSignalListener) {
                try { this.nativeSignalListener.remove(); } catch (e) {}
            }
            this.nativeSignalListener = await window.Capacitor.Plugins.ScreenShare.addListener('screen-share-signal', async (data) => {
                console.log('[ScreenShare Native Listener] Menerima sinyal:', data);
                if (data.type === 'ice-candidate' && data.candidate) {
                    if (this.sessionId) {
                        await this._sendIceCandidate(data.candidate, 'sharer');
                    } else {
                        this._pendingNativeCandidates.push(data.candidate);
                    }
                }
            });

            // 1. Jalankan native capture di plugin Java
            const captureOpts = useGamingMode
                ? { mode: 'webrtc', fps: 30, width: 1280, height: 720, audioBitrate: 128000 }
                : { mode: 'webrtc', fps: 25, width: 960,  height: 540, audioBitrate: 96000  };

            console.log('[ScreenShare] Memulai native WebRTC capture...', captureOpts);

            const result = await window.Capacitor.Plugins.ScreenShare.startNativeWebRTC(captureOpts);

            if (!result?.sdp_offer) {
                throw new Error('Plugin tidak menghasilkan SDP Offer.');
            }

            console.log('[ScreenShare] SDP Offer dari plugin native diterima.');

            // 2. Kirim SDP Offer ke server
            const fd = new FormData();
            fd.append('sdp_offer', result.sdp_offer);

            const data = await this._fetchJson(`${this.baseUrl}/layarbersama/mulai`, { method: 'POST', body: fd });

            if (data.status !== 'success') throw new Error(data.message || 'Server error');

            this.sessionId = data.session_id;
            this.role      = 'sharer';
            this.status    = 'sharing';

            // Kirim pending native candidates yang terkumpul sebelum session ID siap
            if (this._pendingNativeCandidates && this._pendingNativeCandidates.length) {
                console.log(`[ScreenShare] Mengirim ${this._pendingNativeCandidates.length} pending native candidates`);
                for (const c of this._pendingNativeCandidates) {
                    await this._sendIceCandidate(c, 'sharer');
                }
                this._pendingNativeCandidates = [];
            }

            // 3. Kirim ICE candidates yang sudah terkumpul di result (jika ada)
            if (result.ice_candidates?.length) {
                for (const c of result.ice_candidates) {
                    await this._sendIceCandidate(c, 'sharer');
                }
            }

            // 4. Listen untuk SDP Answer dari viewer (via Pusher event yang sudah di-bind)
            console.log('[ScreenShare] Sharer aktif, menunggu viewer terhubung...');
            this._updateUI('sharing');
            this._startTimer();

        } catch (err) {
            console.error('[ScreenShare] Gagal memulai share:', err);
            if (this.nativeSignalListener) {
                try { this.nativeSignalListener.remove(); } catch (e) {}
                this.nativeSignalListener = null;
            }
            this._pendingNativeCandidates = [];
            this.status = 'idle';
            this._updateUI('idle');
            this._showAlert('Gagal memulai berbagi layar: ' + err.message, 'Error', 'error');
        }
    }

    // ============================================================
    // VIEWER: Terima share screen dari pasangan
    // ============================================================
    _onIncomingShareScreen(data) {
        this.sessionId = data.session_id;

        // Tampilkan notifikasi / modal
        const sharerName = data.sharer_name || this.partnerName;
        console.log(`[ScreenShare] ${sharerName} sedang berbagi layar!`);

        // Update UI incoming
        this._showIncomingUI(data);
    }

    _showIncomingUI(data) {
        const sharerName = data.sharer_name || this.partnerName;
        const sharerAvatar = data.sharer_avatar || this.partnerAvatar;

        // Update elemen UI incoming
        const nameEl   = document.getElementById('ss-incoming-name');
        const avatarEl = document.getElementById('ss-incoming-avatar');
        const modal    = document.getElementById('ss-incoming-modal');

        if (nameEl)   nameEl.textContent = sharerName;
        if (avatarEl && sharerAvatar) {
            avatarEl.src = sharerAvatar;
            avatarEl.classList.remove('hidden');
        }
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        // Simpan data untuk dipakai saat viewer klik "Tonton"
        this._pendingIncomingData = data;
    }

    async acceptViewing() {
        if (!this._pendingIncomingData) return;

        const { sdp_offer, ice_candidates_sharer, session_id } = this._pendingIncomingData;
        this.sessionId = session_id || this.sessionId;

        // Tutup modal
        const modal = document.getElementById('ss-incoming-modal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }

        this._updateUI('connecting');

        await this._startViewerConnection(sdp_offer, ice_candidates_sharer || []);
    }

    async _startViewerConnection(sdpOffer, pendingCandidates = []) {
        this.role   = 'viewer';
        this.status = 'connecting';

        console.log('[ScreenShare Viewer] Memulai koneksi WebRTC...');

        try {
            this.pc = new RTCPeerConnection(this.rtcConfig);

            // Terima track (Video = layar, Audio = mic sharer)
            this.pc.ontrack = (event) => {
                console.log('[ScreenShare Viewer] Menerima track:', event.track.kind);
                this._attachTrackToUI(event.track, event.streams?.[0]);
            };

            // Kumpulkan ICE candidate viewer
            this.pc.onicecandidate = async (event) => {
                if (event.candidate) {
                    await this._sendIceCandidate(event.candidate.toJSON(), 'viewer');
                }
            };

            this.pc.oniceconnectionstatechange = () => {
                const state = this.pc?.iceConnectionState;
                console.log('[ScreenShare Viewer] ICE state:', state);
                if (state === 'connected' || state === 'completed') {
                    this.status = 'viewing';
                    this._updateUI('viewing');
                    this._startTimer();
                } else if (state === 'failed' || state === 'disconnected') {
                    this._onConnectionFailed();
                }
            };

            // Set remote SDP (offer dari sharer)
            const normOffer = this._normalizeSdp(sdpOffer);
            await this.pc.setRemoteDescription({ type: 'offer', sdp: normOffer });
            this._remoteDescSet = true;

            // Terapkan ICE candidates yang pending
            for (const c of pendingCandidates) {
                try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
            }

            // Buat SDP Answer
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            // Tunggu ICE gathering selesai (Vanilla ICE)
            await this._waitForIceGathering(this.pc);

            const finalAnswer = this.pc.localDescription.sdp;

            // Kirim SDP Answer ke server
            const fd = new FormData();
            fd.append('session_id', this.sessionId);
            fd.append('sdp_answer', finalAnswer);

            const data = await this._fetchJson(`${this.baseUrl}/layarbersama/terima`, { method: 'POST', body: fd });

            if (data.status !== 'success') throw new Error(data.message || 'Gagal mengirim answer');

            console.log('[ScreenShare Viewer] SDP Answer terkirim, menunggu ICE...');

        } catch (err) {
            console.error('[ScreenShare Viewer] Gagal terhubung:', err);
            this.status = 'idle';
            this._updateUI('idle');
            this._showAlert('Gagal menonton layar: ' + err.message, 'Error', 'error');
        }
    }

    // ============================================================
    // SIGNAL HANDLER: Proses sinyal masuk dari Pusher
    // ============================================================
    async _handleIncomingSignal(data) {
        if (!data?.signal) return;
        if (data.session_id && this.sessionId && String(data.session_id) !== String(this.sessionId)) return;

        const signal = data.signal;

        if (signal.type === 'sdp-answer' && this.role === 'sharer') {
            // Plugin native menerima SDP Answer — forward ke plugin Java
            console.log('[ScreenShare Sharer] Menerima SDP Answer, mengirim ke native plugin...');
            if (window.Capacitor?.Plugins?.ScreenShare?.setRemoteDescription) {
                try {
                    await window.Capacitor.Plugins.ScreenShare.setRemoteDescription({
                        sdp:  signal.sdp,
                        type: 'answer',
                    });
                    this.status = 'sharing';
                    this._updateUI('sharing');
                    console.log('[ScreenShare Sharer] Remote SDP berhasil di-set di plugin native.');
                } catch (e) {
                    console.error('[ScreenShare Sharer] Gagal set remote SDP di plugin:', e);
                }
            }
        }

        if (signal.type === 'ice-candidate') {
            const candidate = signal.candidate;
            const senderRole = signal.role; // 'sharer' atau 'viewer'

            if (this.role === 'viewer' && senderRole === 'sharer') {
                // Kandidat dari sharer → tambahkan ke PC viewer
                if (this.pc) {
                    if (this._remoteDescSet) {
                        try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
                    } else {
                        this._pendingCandidates.push(candidate);
                    }
                }
            } else if (this.role === 'sharer' && senderRole === 'viewer') {
                // Kandidat dari viewer → kirim ke native plugin
                if (window.Capacitor?.Plugins?.ScreenShare?.addIceCandidate) {
                    try {
                        await window.Capacitor.Plugins.ScreenShare.addIceCandidate({ candidate });
                    } catch (e) {}
                }
            }
        }
    }

    // ============================================================
    // STOP: Hentikan sesi (sharer atau viewer)
    // ============================================================
    async stopSession() {
        console.log('[ScreenShare] Menghentikan sesi...');

        // Bersihkan native listener & pending candidates
        if (this.nativeSignalListener) {
            try { this.nativeSignalListener.remove(); } catch (e) {}
            this.nativeSignalListener = null;
        }
        this._pendingNativeCandidates = [];

        // Hentikan plugin native (sharer)
        if (this.role === 'sharer' && window.Capacitor?.Plugins?.ScreenShare) {
            try { await window.Capacitor.Plugins.ScreenShare.stopNativeWebRTC(); } catch (e) {}
        }

        // Tutup PeerConnection (viewer)
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        // Hentikan local audio stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }

        // Beritahu server
        if (this.sessionId) {
            const fd = new FormData();
            fd.append('session_id', this.sessionId);
            fetch(`${this.baseUrl}/layarbersama/berhenti`, { method: 'POST', body: fd }).catch(() => {});
        }

        this._stopTimer();
        this.sessionId = null;
        this.role      = null;
        this.status    = 'idle';
        this._remoteDescSet = false;
        this._pendingCandidates = [];

        this._updateUI('idle');
        this._detachVideoFromUI();
    }

    // ============================================================
    // REMOTE STOP: Pasangan menghentikan sesi
    // ============================================================
    _onRemoteSessionEnded() {
        console.log('[ScreenShare] Sesi dihentikan oleh pasangan.');

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        this._stopTimer();
        this._detachVideoFromUI();

        this.sessionId = null;
        this.role      = null;
        this.status    = 'idle';
        this._remoteDescSet = false;
        this._pendingCandidates = [];

        this._updateUI('idle');

        // Tampilkan notifikasi ringan
        this._showToast('Sesi berbagi layar telah dihentikan oleh pasangan.');
    }

    _onConnectionFailed() {
        console.warn('[ScreenShare] Koneksi ICE gagal.');
        this._showToast('Koneksi terputus. Coba mulai lagi.');
        this.stopSession();
    }

    // ============================================================
    // MEDIA HELPER
    // ============================================================
    _attachTrackToUI(track, stream) {
        const videoEl = document.getElementById('ss-remote-video');
        if (!videoEl) return;

        if (!videoEl.srcObject) {
            videoEl.srcObject = stream || new MediaStream([track]);
        } else {
            videoEl.srcObject.addTrack(track);
        }

        if (track.kind === 'video') {
            videoEl.play().catch(e => console.warn('[ScreenShare] Video autoplay ditolak:', e));

            // Update layout sesuai orientasi video
            videoEl.onloadedmetadata = () => this._adjustVideoLayout(videoEl);
            videoEl.onresize         = () => this._adjustVideoLayout(videoEl);
        }

        const viewerArea = document.getElementById('ss-viewer-area');
        if (viewerArea) {
            viewerArea.classList.remove('hidden');
            viewerArea.classList.add('flex');
        }

        const placeholder = document.getElementById('ss-placeholder');
        if (placeholder) placeholder.classList.add('hidden');
    }

    _detachVideoFromUI() {
        const videoEl = document.getElementById('ss-remote-video');
        if (videoEl) {
            videoEl.srcObject = null;
            videoEl.pause();
        }

        const viewerArea = document.getElementById('ss-viewer-area');
        if (viewerArea) {
            viewerArea.classList.add('hidden');
            viewerArea.classList.remove('flex');
        }

        const placeholder = document.getElementById('ss-placeholder');
        if (placeholder) placeholder.classList.remove('hidden');
    }

    _adjustVideoLayout(videoEl) {
        const isLandscape = videoEl.videoWidth > videoEl.videoHeight;
        const container   = document.getElementById('ss-video-container');
        if (!container) return;

        if (isLandscape) {
            videoEl.style.objectFit = 'contain';
            container.style.aspectRatio = '16/9';
        } else {
            videoEl.style.objectFit = 'contain';
            container.style.aspectRatio = '9/16';
        }
    }

    // ============================================================
    // NETWORK: Kirim ICE candidate ke server
    // ============================================================
    async _sendIceCandidate(candidate, role) {
        if (!this.sessionId) return;
        const fd = new FormData();
        fd.append('session_id', this.sessionId);
        fd.append('role', role);
        fd.append('candidate', JSON.stringify(candidate));
        try {
            await this._fetchJson(`${this.baseUrl}/layarbersama/tambahice`, { method: 'POST', body: fd });
        } catch (e) {
            console.warn('[ScreenShare] Gagal kirim ICE candidate:', e);
        }
    }

    // ============================================================
    // UI UPDATES
    // ============================================================
    _updateUI(state) {
        // Tombol utama
        const btnStart = document.getElementById('ss-btn-start');
        const btnStop  = document.getElementById('ss-btn-stop');
        const statusEl = document.getElementById('ss-status-text');
        const badge    = document.getElementById('ss-status-badge');

        const states = {
            idle: {
                text:       'Siap berbagi layar',
                badgeClass: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
                badgeText:  'Tidak Aktif',
                startHidden: false,
                stopHidden:  true,
            },
            connecting: {
                text:       'Menghubungkan...',
                badgeClass: 'bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse',
                badgeText:  'Menghubungkan',
                startHidden: true,
                stopHidden:  false,
            },
            sharing: {
                text:       'Sedang berbagi layar Anda',
                badgeClass: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
                badgeText:  'LIVE • Berbagi',
                startHidden: true,
                stopHidden:  false,
            },
            viewing: {
                text:       `Menonton layar ${this.partnerName}`,
                badgeClass: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
                badgeText:  'LIVE • Menonton',
                startHidden: true,
                stopHidden:  false,
            },
        };

        const cfg = states[state] || states.idle;

        if (statusEl) statusEl.textContent = cfg.text;
        if (badge) {
            badge.className = `inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${cfg.badgeClass}`;
            badge.textContent = cfg.badgeText;
        }
        if (btnStart) btnStart.classList.toggle('hidden', cfg.startHidden);
        if (btnStop)  btnStop.classList.toggle('hidden', cfg.stopHidden);
    }

    // ============================================================
    // TIMER
    // ============================================================
    _startTimer() {
        this._secondsElapsed = 0;
        if (this._timerInterval) clearInterval(this._timerInterval);
        this._timerInterval = setInterval(() => {
            this._secondsElapsed++;
            const m = String(Math.floor(this._secondsElapsed / 60)).padStart(2, '0');
            const s = String(this._secondsElapsed % 60).padStart(2, '0');
            const el = document.getElementById('ss-timer');
            if (el) el.textContent = `${m}:${s}`;
        }, 1000);
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
        const el = document.getElementById('ss-timer');
        if (el) el.textContent = '00:00';
    }

    // ============================================================
    // POLLING: Fallback jika Pusher tidak tersedia
    // ============================================================
    _startPolling() {
        if (this._pollingInterval) return; // hindari duplikat
        this._pollingInterval = setInterval(() => this._checkExistingSession(), 5000);
    }

    _stopPolling() {
        if (this._pollingInterval) {
            clearInterval(this._pollingInterval);
            this._pollingInterval = null;
        }
    }

    // ============================================================
    // UTILITIES
    // ============================================================
    async _fetchJson(url, options = {}) {
        try {
            const res = await fetch(url, options);
            if (res.status === 401) {
                this.destroy();
                this._showAlert('Sesi login Anda telah berakhir. Silakan login kembali.', 'Sesi Berakhir', 'error');
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
                throw new Error('Sesi berakhir');
            }
            return await res.json();
        } catch (e) {
            throw e;
        }
    }

    _isCapacitorNative() {
        return (
            (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
            (window.Capacitor && (window.Capacitor.platform === 'android' || window.Capacitor.platform === 'ios')) ||
            (window.cordova && window.cordova.platformId === 'android')
        );
    }

    _normalizeSdp(sdp) {
        if (!sdp) return sdp;
        return sdp.replace(/\r\n|\r/g, '\n').replace(/\n/g, '\r\n');
    }

    async _waitForIceGathering(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const check = () => {
                if (pc.iceGatheringState === 'complete') {
                    pc.removeEventListener('icegatheringstatechange', check);
                    resolve();
                }
            };
            pc.addEventListener('icegatheringstatechange', check);
            setTimeout(resolve, 6000); // timeout 6 detik
        });
    }

    _showAlert(msg, title = 'Info', type = 'info') {
        if (typeof window.showAlert === 'function') {
            window.showAlert(msg, title, type);
        } else {
            alert(msg);
        }
    }

    _showToast(msg) {
        const toast = document.getElementById('ss-toast');
        if (toast) {
            toast.textContent = msg;
            toast.classList.remove('opacity-0', 'pointer-events-none');
            toast.classList.add('opacity-100');
            setTimeout(() => {
                toast.classList.add('opacity-0', 'pointer-events-none');
                toast.classList.remove('opacity-100');
            }, 3500);
        }
    }

    destroy() {
        this.stopSession();
        this._stopPolling();
        // Unbind Pusher events
        if (this.pusherChannel) {
            this.pusherChannel.unbind('screen-share-incoming');
            this.pusherChannel.unbind('screen-share-signal');
            this.pusherChannel.unbind('screen-share-ended');
        }
    }
}

// Ekspor ke window agar bisa dipakai dari view
window.NativeScreenShareSession = NativeScreenShareSession;
