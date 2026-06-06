/**
 * room_video.js
 * ==============================================================
 * Watch Together — Sinkronisasi YouTube untuk dua layar.
 *
 * Cara kerja:
 *   1. User A tempel URL YouTube → klik Muat
 *   2. Event "video_load" dikirim ke DB → polling pasangan B terima
 *   3. Kedua player load video yang sama
 *   4. A klik Play → event "video_sync" {action:'play', time:N} → B ikut play
 *   5. A seek ke menit tertentu → B ikut jump ke menit yang sama
 *
 * Anti-echo:
 *   Flag `isSyncing` mencegah saat B menerima event dari A dan
 *   apply ke player, player B tidak ikut re-broadcast event itu lagi.
 * ==============================================================
 */

(function () {
    'use strict';

    // ==========================================================
    // 1. State
    // ==========================================================
    let player         = null;  // Instance YT.Player
    let currentVideoId = null;  // Video ID yang sedang diputar
    let isSyncing      = false; // True saat sedang apply event dari pasangan (anti-echo)
    let isPlayerReady  = false;
    let seekBarDragging = false;
    let timeUpdateTimer = null;
    let lastSavedTimestamp = 0;
    let shouldAutoPlayOnReady = false;
    const SEEK_TOLERANCE_SEC = 3; // Perbedaan < 3 detik tidak perlu di-sync

    // ==========================================================
    // 2. Elemen DOM
    // ==========================================================
    const elInput     = document.getElementById('yt-url-input');
    const elOverlay   = document.getElementById('yt-overlay');
    const elSeekBar   = document.getElementById('seek-bar');
    const elTime      = document.getElementById('time-display');
    const elPlayBtn   = document.getElementById('btn-play-pause');
    const elSyncBadge = document.getElementById('sync-badge');

    // ==========================================================
    // 3. YouTube URL Parser → ekstrak Video ID
    // ==========================================================
    function extractVideoId(url) {
        if (!url) return null;
        url = url.trim();

        // Format: youtu.be/XXXXX
        let m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        if (m) return m[1];

        // Format: youtube.com/watch?v=XXXXX
        m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (m) return m[1];

        // Format: youtube.com/embed/XXXXX
        m = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (m) return m[1];

        // Format: youtube.com/shorts/XXXXX
        m = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (m) return m[1];

        // Jika input adalah video ID langsung (11 karakter alphanumerik)
        if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

        return null;
    }

    // ==========================================================
    // 4. Format detik → "M:SS"
    // ==========================================================
    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // ==========================================================
    // 5. Perbarui Seek Bar & Time Display
    // ==========================================================
    function updateTimeUI() {
        if (!player || !isPlayerReady) return;
        try {
            const current  = player.getCurrentTime() || 0;
            const duration = player.getDuration()    || 0;

            if (!seekBarDragging && duration > 0) {
                elSeekBar.value = (current / duration) * 100;
            }

            if (elTime) {
                elTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
            }

            // Simpan state secara berkala per 5 detik ke database jika sedang memutar
            const now = Date.now();
            if (now - lastSavedTimestamp >= 5000) {
                const state = player.getPlayerState();
                if (state === YT.PlayerState.PLAYING) {
                    lastSavedTimestamp = now;
                    saveVideoState(currentVideoId, current, 1);
                }
            }
        } catch (e) {}
    }

    // ==========================================================
    // 6. Inisialisasi / Buat YouTube Player
    // ==========================================================
    function createPlayer(videoId, startSeconds) {
        startSeconds = startSeconds || 0;

        if (player) {
            // Player sudah ada → cukup ganti video
            isSyncing = true;
            player.loadVideoById({ videoId, startSeconds });
            setTimeout(() => { isSyncing = false; }, 1000);
            currentVideoId = videoId;
            return;
        }

        player = new YT.Player('yt-player', {
            videoId,
            playerVars: {
                autoplay:       0,
                controls:       1,
                modestbranding: 1,
                rel:            0,
                origin:         window.location.origin,
                start:          Math.floor(startSeconds),
            },
            events: {
                onReady:       onPlayerReady,
                onStateChange: onPlayerStateChange,
            }
        });

        currentVideoId = videoId;
    }

    function onPlayerReady(event) {
        isPlayerReady = true;

        // Sembunyikan overlay
        if (elOverlay) {
            elOverlay.style.opacity = '0';
            elOverlay.style.pointerEvents = 'none';
        }

        // Update seek bar max
        const duration = event.target.getDuration();
        if (elSeekBar && duration > 0) {
            elSeekBar.max = 100;
        }

        // Mulai loop update UI
        clearInterval(timeUpdateTimer);
        timeUpdateTimer = setInterval(updateTimeUI, 500);

        if (window.roomWs) {
            window.roomWs.addLog('🎬', `Video siap diputar!`);
        }

        if (shouldAutoPlayOnReady) {
            shouldAutoPlayOnReady = false;
            try {
                event.target.playVideo();
                updatePlayButton(true);
            } catch (e) {}
        }
    }

    function onPlayerStateChange(event) {
        if (isSyncing) return; // Jangan broadcast jika sedang menerima sync dari pasangan

        const state = event.data;
        const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';

        if (state === YT.PlayerState.PLAYING) {
            const currentTime = player.getCurrentTime() || 0;
            updatePlayButton(true);
            broadcastVideoSync('play', currentTime);
            saveVideoState(currentVideoId, currentTime, 1);
            if (window.roomWs) window.roomWs.addLog('▶️', 'Kamu memulai video — pasangan ikut play!');
        } else if (state === YT.PlayerState.PAUSED) {
            const currentTime = player.getCurrentTime() || 0;
            updatePlayButton(false);
            broadcastVideoSync('pause', currentTime);
            saveVideoState(currentVideoId, currentTime, 0);
            if (window.roomWs) window.roomWs.addLog('⏸️', 'Kamu pause — pasangan ikut pause!');
        } else if (state === YT.PlayerState.ENDED) {
            updatePlayButton(false);
            saveVideoState(currentVideoId, player.getCurrentTime() || 0, 0);
        }
    }

    // ==========================================================
    // 7. Update tombol Play/Pause
    // ==========================================================
    function updatePlayButton(isPlaying) {
        if (!elPlayBtn) return;
        elPlayBtn.innerHTML = isPlaying ? '⏸ Pause' : '▶ Play';
    }

    // ==========================================================
    // 8. Kirim event video_sync ke DB (lewat polling sistem)
    // ==========================================================
    async function broadcastVideoSync(action, time, videoId) {
        const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';
        const data = { action, time: Math.floor(time || 0) };
        if (videoId) data.video_id = videoId;

        try {
            setSyncBadge('syncing');
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    event_type: 'video_sync',
                    event_data: JSON.stringify(data),
                }),
            });
            setTimeout(() => setSyncBadge('synced'), 600);
        } catch (e) {
            setSyncBadge('synced');
        }
    }

    async function broadcastVideoLoad(videoId, time) {
        const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';
        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    event_type: 'video_load',
                    event_data: JSON.stringify({ video_id: videoId, time: Math.floor(time || 0) }),
                }),
            });
        } catch (e) {}
    }

    // ==========================================================
    // 9. Sinkronisasi Masuk dari Pasangan (dipanggil oleh room_websocket.js)
    // ==========================================================
    function applyRemoteEvent(event) {
        const data = event.event_data || {};

        if (event.event_type === 'video_load') {
            const vid = data.video_id;
            if (!vid) return;
            setSyncBadge('syncing');
            if (window.roomWs) window.roomWs.addLog('📺', `Pasangan memuat video baru!`);

            // Update text input URL agar terlihat oleh pasangan
            if (elInput) {
                elInput.value = 'https://www.youtube.com/watch?v=' + vid;
            }

            isSyncing = true;
            createPlayer(vid, data.time || 0);
            setTimeout(() => {
                isSyncing = false;
                setSyncBadge('synced');
            }, 1500);
            return;
        }

        if (event.event_type === 'video_sync') {
            if (!player || !isPlayerReady) return;
            setSyncBadge('syncing');

            isSyncing = true;
            try {
                if (data.action === 'play') {
                    const partnerTime  = data.time || 0;
                    const myTime       = player.getCurrentTime() || 0;
                    // Sinkronisasi waktu jika selisih > toleransi
                    if (Math.abs(myTime - partnerTime) > SEEK_TOLERANCE_SEC) {
                        player.seekTo(partnerTime, true);
                    }
                    player.playVideo();
                    updatePlayButton(true);
                    if (window.roomWs) window.roomWs.addLog('▶️', 'Pasangan memulai video — ikut play!');

                } else if (data.action === 'pause') {
                    const partnerTime = data.time || 0;
                    player.seekTo(partnerTime, true);
                    player.pauseVideo();
                    updatePlayButton(false);
                    if (window.roomWs) window.roomWs.addLog('⏸️', 'Pasangan pause — ikut pause!');

                } else if (data.action === 'seek') {
                    player.seekTo(data.time || 0, true);
                    if (window.roomWs) window.roomWs.addLog('⏩', `Pasangan lompat ke ${formatTime(data.time)}`);
                }
            } catch (e) {}

            setTimeout(() => {
                isSyncing = false;
                setSyncBadge('synced');
            }, 800);
        }
    }

    // ==========================================================
    // 10. Update badge sinkronisasi
    // ==========================================================
    function setSyncBadge(state) {
        if (!elSyncBadge) return;
        elSyncBadge.className = 'ml-auto sync-badge ' + state;
        elSyncBadge.innerHTML = state === 'syncing'
            ? '<span class="w-1.5 h-1.5 rounded-full bg-yellow-400"></span> Sinkron...'
            : '<span class="w-1.5 h-1.5 rounded-full bg-indigo-400 status-pulse-dot"></span> Siap';
    }

    // ==========================================================
    // 11. Public API (dipanggil dari onclick HTML)
    // ==========================================================

    /** Muat URL yang diinput user */
    function loadUrl() {
        const url  = elInput ? elInput.value.trim() : '';
        const vid  = extractVideoId(url);

        if (!vid) {
            alert('URL YouTube tidak valid. Coba: https://youtu.be/XXXXX atau https://www.youtube.com/watch?v=XXXXX');
            return;
        }

        if (window.roomWs) window.roomWs.addLog('🔗', 'Memuat video untuk kedua layar...');
        setSyncBadge('syncing');

        // Muat di player sendiri
        isSyncing = true;
        createPlayer(vid, 0);
        setTimeout(() => { isSyncing = false; setSyncBadge('synced'); }, 1500);

        // Broadcast ke pasangan
        broadcastVideoLoad(vid, 0);
        saveVideoState(vid, 0, 0);
    }

    /** Toggle play/pause */
    function togglePlay() {
        if (!player || !isPlayerReady) return;
        try {
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                player.pauseVideo();
            } else {
                player.playVideo();
            }
        } catch (e) {}
    }

    /** Seek bar sedang digeser (preview, belum commit) */
    function onSeekInput(val) {
        seekBarDragging = true;
        try {
            const duration = player ? player.getDuration() : 0;
            if (elTime && duration > 0) {
                elTime.textContent = `${formatTime((val / 100) * duration)} / ${formatTime(duration)}`;
            }
        } catch (e) {}
    }

    /** Seek bar dilepas (commit seek) */
    function onSeekCommit(val) {
        seekBarDragging = false;
        if (!player || !isPlayerReady) return;
        try {
            const duration = player.getDuration() || 0;
            const seekTo   = (val / 100) * duration;
            player.seekTo(seekTo, true);
            broadcastVideoSync('seek', seekTo);
            
            const isPlaying = player.getPlayerState() === YT.PlayerState.PLAYING ? 1 : 0;
            saveVideoState(currentVideoId, seekTo, isPlaying);

            if (window.roomWs) window.roomWs.addLog('⏩', `Kamu lompat ke ${formatTime(seekTo)} — pasangan ikut!`);
        } catch (e) {}
    }

    /** Paksa resync posisi ke pasangan */
    function syncNow() {
        if (!player || !isPlayerReady) return;
        try {
            const time = player.getCurrentTime() || 0;
            const state = player.getPlayerState();
            const action = state === YT.PlayerState.PLAYING ? 'play' : 'pause';
            broadcastVideoSync(action, time);
            if (window.roomWs) window.roomWs.addLog('🔄', `Sync paksa dikirim ke pasangan (${formatTime(time)})`);
        } catch (e) {}
    }

    // ==========================================================
    // 12. Persistent State Management
    // ==========================================================
    async function saveVideoState(videoId, time, isPlaying) {
        const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';
        try {
            await fetch(`${BASE_URL}/roomevent/save_video`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    video_id: videoId || '',
                    video_time: Math.floor(time || 0),
                    is_playing: isPlaying ? 1 : 0
                })
            });
        } catch (e) {
            console.error('Gagal menyimpan state video:', e);
        }
    }

    async function loadVideoState() {
        const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';
        try {
            const res = await fetch(`${BASE_URL}/roomevent/get_video`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await res.json();
            if (data.status === 'ok' && data.video_id) {
                console.log('[Watch Together] Memulihkan video:', data.video_id, 'pada detik:', data.video_time);
                
                // Update text input URL agar terlihat oleh pasangan saat masuk ruangan
                if (elInput) {
                    elInput.value = 'https://www.youtube.com/watch?v=' + data.video_id;
                }

                // Matikan overlay agar terlihat lebih responsif
                if (elOverlay) {
                    elOverlay.style.opacity = '0';
                    elOverlay.style.pointerEvents = 'none';
                }
                
                isSyncing = true;
                if (data.is_playing) {
                    shouldAutoPlayOnReady = true;
                }
                createPlayer(data.video_id, data.video_time || 0);
                setTimeout(() => {
                    isSyncing = false;
                }, 1500);
            }
        } catch (e) {
            console.error('Gagal memulihkan state video:', e);
        }
    }

    // ==========================================================
    // 12.5. Audio Ducking untuk integrasi panggilan VoIP
    // ==========================================================
    let originalVolume = null;

    function duckVolume(shouldDuck) {
        const isDuckEnabled = localStorage.getItem('hk_audio_ducking_enabled') !== 'false';
        if (!isDuckEnabled) return;

        if (!player || typeof player.setVolume !== 'function' || typeof player.getVolume !== 'function') {
            console.log('[Watch Together] Player belum siap untuk ducking volume.');
            return;
        }

        try {
            if (shouldDuck) {
                const currentVol = player.getVolume();
                if (originalVolume === null) {
                    originalVolume = currentVol;
                }
                const duckPercent = parseInt(localStorage.getItem('hk_audio_ducking_percent') || '20');
                if (currentVol > duckPercent) {
                    player.setVolume(duckPercent);
                    console.log(`[Watch Together] Volume diduck otomatis dari ${originalVolume} ke ${duckPercent}`);
                }
            } else {
                if (originalVolume !== null) {
                    player.setVolume(originalVolume);
                    console.log(`[Watch Together] Volume dipulihkan otomatis ke ${originalVolume}`);
                    originalVolume = null;
                }
            }
        } catch (e) {
            console.error('[Watch Together] Gagal memproses duckVolume:', e);
        }
    }

    // ==========================================================
    // 13. Expose ke global
    // ==========================================================
    window.roomVideo = {
        loadUrl,
        togglePlay,
        onSeekInput,
        onSeekCommit,
        syncNow,
        applyRemoteEvent, // dipanggil oleh room_websocket.js
        loadVideoState,
        duckVolume,
    };

    // Enter key di input URL langsung load
    if (elInput) {
        elInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') loadUrl();
        });
    }

    // Bersihkan saat berpindah halaman via PJAX
    window.addEventListener('page-leave', () => {
        clearInterval(timeUpdateTimer);
        console.log('[Room Video] Video sync time update cleaned up.');
    });

    // ==========================================================
    // 14. YouTube IFrame API Ready Callback (global, wajib ada)
    // ==========================================================
    // Fungsi ini dipanggil otomatis oleh YouTube setelah library-nya load.
    // Jika sudah ada definisi sebelumnya, chain ke yang lama.
    const prevYTReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
        if (typeof prevYTReady === 'function') prevYTReady();
        // Player tidak dibuat di sini — dibuat saat user klik Muat
        console.log('[Watch Together] YouTube IFrame API siap.');
        
        // Memuat state video persisten saat IFrame API siap
        loadVideoState();
    };

    // Jika YouTube API sudah dimuat sebelum file ini di-parse, langsung jalankan inisialisasi state!
    if (window.YT && window.YT.Player) {
        console.log('[Watch Together] YT API sudah terdeteksi di window, langsung memulihkan state.');
        loadVideoState();
    }

})();
