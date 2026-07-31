/**
 * room_doodle.js — Shared Doodle Canvas Engine (v1.0)
 * ==============================================================
 * Mengelola papan gambar bersama pasangan secara real-time.
 * Mendukung normalisasi koordinat responsif, sentuhan HP (mobile),
 * kompresi batch 100ms, serta pengunduhan gambar.
 * ==============================================================
 */

(function () {
    'use strict';

    // ==========================================================
    // 1. Konfigurasi & State
    // ==========================================================
    const CFG       = window.ROOM_CONFIG || {};
    const BASE_URL  = CFG.baseUrl  || '';
    const BATCH_MS  = 100; // Interval pengiriman batch koordinat (ms)

    let canvas = null;
    let ctx = null;
    let overlay = null;
    
    // Buffer canvas offscreen untuk mencegah gambar hilang saat resize
    let offscreenCanvas = null;
    let offscreenCtx = null;

    // State Menggambar Diri Sendiri
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    let drawQueue = []; // Antrean titik yang siap dikirim
    let batchTimer = null;

    // Pengaturan Gambar Aktif
    let currentTool = 'pen'; // 'pen' | 'eraser'
    let currentColor = '#ff758c'; // Sweet Pink default
    let currentSize = 5;

    // State Menggambar Pasangan (Remote Drawing Queue)
    let remoteDrawQueue = [];
    let isRemoteDrawing = false;
    let remoteLastX = null;
    let remoteLastY = null;
    let animFrameId = null;
    let isDrawingLocked = false; // Pelindung scroll di mobile

    // UI elements tracker
    const UI = {
        toolPen: null,
        toolEraser: null,
        colorPicker: null,
        btnLock: null,
        lockIcon: null,
        lockText: null,
        lockIndicator: null
    };

    // ==========================================================
    // 2. Inisialisasi Kanvas & Resize Protection
    // ==========================================================
    function initCanvas() {
        canvas = document.getElementById('doodle-canvas');
        if (!canvas) return;

        // Query element DOM secara dinamis saat inisialisasi agar terhindar dari bug PJAX/DOMContentLoaded
        UI.toolPen = document.getElementById('tool-pen');
        UI.toolEraser = document.getElementById('tool-eraser');
        UI.colorPicker = document.getElementById('custom-color-picker');
        UI.btnLock = document.getElementById('btn-doodle-lock');
        UI.lockIcon = document.getElementById('doodle-lock-icon');
        UI.lockText = document.getElementById('doodle-lock-text');
        UI.lockIndicator = document.getElementById('doodle-lock-indicator');

        ctx = canvas.getContext('2d');
        overlay = document.getElementById('doodle-overlay');

        // Buat offscreen buffer
        offscreenCanvas = document.createElement('canvas');
        offscreenCtx = offscreenCanvas.getContext('2d');

        // Sizing kanvas pertama kali
        resizeCanvas();

        // Daftarkan listener resize dengan debouncing ringan
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(resizeCanvas, 150);
        });

        // Setel status kunci default untuk mobile/tablet
        if (window.innerWidth < 1024) {
            setDoodleLock(true);
        } else {
            setDoodleLock(false);
        }

        // Daftarkan events menggambar
        setupDrawingEvents();

        // Mulai timer pengiriman batch
        batchTimer = setInterval(sendDrawingBatch, BATCH_MS);

        // Mulai loop rendering remote (60fps)
        startRemoteRenderLoop();

        // Muat snapshot gambar persisten terakhir dari database jika ada
        loadCanvasSnapshot();
    }

    function resizeCanvas() {
        if (!canvas) return;

        // Dapatkan ukuran container saat ini
        const rect = canvas.parentElement.getBoundingClientRect();
        const newWidth = rect.width;
        const newHeight = rect.height || 380;

        // JIKA CONTAINER TERSEMBUNYI (lebar atau tinggi 0), JANGAN RESIZE ATAU RESET!
        if (newWidth === 0 || newHeight === 0) {
            return;
        }

        // Salin isi kanvas lama ke offscreen buffer sebelum di-resize
        // Hanya jika kanvas saat ini memiliki ukuran valid
        if (canvas.width > 0 && canvas.height > 0) {
            offscreenCanvas.width = canvas.width;
            offscreenCanvas.height = canvas.height;
            offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
            offscreenCtx.drawImage(canvas, 0, 0);
        }

        // Ubah ukuran kanvas fisik
        canvas.width = newWidth;
        canvas.height = newHeight;

        // Bersihkan area
        ctx.clearRect(0, 0, newWidth, newHeight);

        // Setel default style baris pada konteks baru
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Kembalikan gambar dari offscreen buffer dengan penskalaan adaptif
        if (offscreenCanvas.width > 0 && offscreenCanvas.height > 0) {
            ctx.drawImage(offscreenCanvas, 0, 0, newWidth, newHeight);
        }
    }


    // ==========================================================
    // 3. Normalisasi Koordinat ($0.0$ ke $1.0$)
    // ==========================================================
    function getNormalizedCoords(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const xPixel = clientX - rect.left;
        const yPixel = clientY - rect.top;
        
        return {
            x: Math.max(0, Math.min(1, xPixel / rect.width)),
            y: Math.max(0, Math.min(1, yPixel / rect.height))
        };
    }

    function denormalizeCoords(normX, normY) {
        return {
            x: normX * canvas.width,
            y: normY * canvas.height
        };
    }

    // ==========================================================
    // 3.5. Smart Draw Lock (Pelindung Scroll)
    // ==========================================================
    function setDoodleLock(locked) {
        isDrawingLocked = locked;
        if (!canvas) return;

        if (locked) {
            canvas.style.pointerEvents = 'none';
            if (UI.btnLock) {
                UI.btnLock.className = "px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-black/40 hover:bg-black/60 border border-white/10 text-white flex items-center gap-1 transition-all active:scale-95 cursor-pointer select-none";
            }
            if (UI.lockIcon) UI.lockIcon.textContent = "🔒";
            if (UI.lockText) UI.lockText.textContent = "Buka Kunci";
            if (UI.lockIndicator) UI.lockIndicator.style.opacity = "1";
        } else {
            canvas.style.pointerEvents = 'auto';
            if (UI.btnLock) {
                UI.btnLock.className = "px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/25 hover:bg-rose-500/35 border border-rose-500/30 text-rose-300 flex items-center gap-1 transition-all active:scale-95 cursor-pointer select-none";
            }
            if (UI.lockIcon) UI.lockIcon.textContent = "✏️";
            if (UI.lockText) UI.lockText.textContent = "Lukis Aktif";
            if (UI.lockIndicator) UI.lockIndicator.style.opacity = "0";
        }
    }

    function toggleDoodleLock() {
        setDoodleLock(!isDrawingLocked);
    }

    // ==========================================================
    // 4. Deteksi & Handler Event Menggambar (Mouse & Touch)
    // ==========================================================
    function setupDrawingEvents() {
        // --- Event Desktop (Mouse) ---
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Hanya klik kiri
            startDrawing(e.clientX, e.clientY);
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!isDrawing) return;
            drawMove(e.clientX, e.clientY);
        });

        window.addEventListener('mouseup', () => {
            if (isDrawing) stopDrawing();
        });

        canvas.addEventListener('mouseleave', () => {
            // Kita tetap menggambar jika mouse keluar layar, tapi goresan terputus
            if (isDrawing) {
                drawQueue.push({ type: 'end' });
            }
        });
        
        canvas.addEventListener('mouseenter', (e) => {
            // Hubungkan kembali jika mouse masuk kembali dan masih memencet
            if (isDrawing && (e.buttons & 1)) {
                const norm = getNormalizedCoords(e.clientX, e.clientY);
                drawQueue.push({
                    type: 'start',
                    x: norm.x,
                    y: norm.y,
                    color: currentTool === 'eraser' ? 'eraser' : currentColor,
                    size: currentSize
                });
                const pixel = denormalizeCoords(norm.x, norm.y);
                lastX = pixel.x;
                lastY = pixel.y;
            }
        });

        // --- Event Mobile (Touch / Jari) ---
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                e.preventDefault(); // Mencegah scrolling browser saat menggambar
                startDrawing(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: false });

        canvas.addEventListener('touchmove', (e) => {
            if (isDrawing && e.touches.length === 1) {
                e.preventDefault();
                drawMove(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: false });

        window.addEventListener('touchend', (e) => {
            if (isDrawing) {
                stopDrawing();
            }
        });
    }

    function startDrawing(clientX, clientY) {
        isDrawing = true;

        // Sembunyikan instruksi awal
        if (overlay) {
            overlay.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => overlay.remove(), 350);
            overlay = null;
        }

        const norm = getNormalizedCoords(clientX, clientY);
        const pixel = denormalizeCoords(norm.x, norm.y);
        
        lastX = pixel.x;
        lastY = pixel.y;

        // Tambah ke antrean pengiriman
        drawQueue.push({
            type: 'start',
            x: norm.x,
            y: norm.y,
            color: currentTool === 'eraser' ? 'eraser' : currentColor,
            size: currentSize
        });

        // Gambar titik awal secara lokal
        drawLocalPoint(pixel.x, pixel.y, currentTool === 'eraser' ? 'eraser' : currentColor, currentSize);
    }

    function drawMove(clientX, clientY) {
        if (!isDrawing) return;

        const norm = getNormalizedCoords(clientX, clientY);
        const pixel = denormalizeCoords(norm.x, norm.y);

        // Gambar garis lokal
        drawLocalLine(lastX, lastY, pixel.x, pixel.y, currentTool === 'eraser' ? 'eraser' : currentColor, currentSize);

        lastX = pixel.x;
        lastY = pixel.y;

        // Tambah ke antrean
        drawQueue.push({
            type: 'move',
            x: norm.x,
            y: norm.y
        });
    }

    function stopDrawing() {
        isDrawing = false;
        drawQueue.push({ type: 'end' });
        
        // Simpan snapshot persisten ke DB sesaat setelah berhenti menggambar
        triggerSaveSnapshot();
    }

    // ==========================================================
    // 5. Fungsi Gambar Lokal (Canvas Renderers)
    // ==========================================================
    function drawLocalPoint(x, y, color, size) {
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        
        if (color === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = color;
        }
        
        ctx.fill();
        ctx.closePath();
    }

    function drawLocalLine(x1, y1, x2, y2, color, size) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = size;
        
        if (color === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = color;
        }
        
        ctx.stroke();
        ctx.closePath();
    }

    // ==========================================================
    // 6. Transmisi Real-Time (Polling / Trigger Batch)
    // ==========================================================
    async function sendDrawingBatch() {
        if (drawQueue.length === 0) return;

        const batch = [...drawQueue];
        drawQueue = []; // Kosongkan antrean

        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    event_type: 'canvas_draw',
                    event_data: JSON.stringify({ points: batch })
                })
            });
        } catch (e) {
            // Jika gagal, gabungkan kembali batch yang gagal di awal antrean agar tidak hilang
            drawQueue = [...batch, ...drawQueue];
        }
    }

    // ==========================================================
    // 7. Penerimaan Event Menggambar Pasangan & Animasi Mulus
    // ==========================================================
    function applyRemoteEvent(event) {
        const data = event.event_data || {};
        
        if (event.event_type === 'canvas_draw' && Array.isArray(data.points)) {
            // Masukkan koordinat baru ke remote queue untuk digambar secara mengalir
            remoteDrawQueue.push(...data.points);
        } else if (event.event_type === 'canvas_clear') {
            // Hapus kanvas langsung tanpa animasi
            clearCanvas(false);
            if (window.roomWs && typeof window.roomWs.addLog === 'function') {
                window.roomWs.addLog('🎨', 'Pasangan membersihkan papan gambar.');
            }
        }
    }

    // Loop interpolasi menggambar goresan pasangan (60 FPS)
    // Mengonsumsi titik-titik dari remoteDrawQueue per frame
    function startRemoteRenderLoop() {
        function renderFrame() {
            // Batasi penggambaran maksimum per frame agar gerakannya seimbang
            // (Mencegah lonjakan ekstrim jika polling terhambat dan langsung meledak)
            const pointsToDraw = Math.min(remoteDrawQueue.length, 5); 

            for (let i = 0; i < pointsToDraw; i++) {
                const pt = remoteDrawQueue.shift();
                if (!pt) continue;

                if (pt.type === 'start') {
                    const pixel = denormalizeCoords(pt.x, pt.y);
                    isRemoteDrawing = true;
                    remoteLastX = pixel.x;
                    remoteLastY = pixel.y;
                    
                    // Rekam style remote
                    canvas.dataset.remoteColor = pt.color;
                    canvas.dataset.remoteSize  = pt.size;

                    drawLocalPoint(pixel.x, pixel.y, pt.color, pt.size);
                } 
                else if (pt.type === 'move' && isRemoteDrawing) {
                    const pixel = denormalizeCoords(pt.x, pt.y);
                    const color = canvas.dataset.remoteColor || currentColor;
                    const size  = parseInt(canvas.dataset.remoteSize || currentSize, 10);

                    if (remoteLastX !== null && remoteLastY !== null) {
                        drawLocalLine(remoteLastX, remoteLastY, pixel.x, pixel.y, color, size);
                    }

                    remoteLastX = pixel.x;
                    remoteLastY = pixel.y;
                } 
                else if (pt.type === 'end') {
                    isRemoteDrawing = false;
                    remoteLastX = null;
                    remoteLastY = null;
                    
                    // Update snapshot lokal ke database agar kedua belah pihak selaras
                    triggerSaveSnapshot();
                }
            }

            animFrameId = requestAnimationFrame(renderFrame);
        }

        animFrameId = requestAnimationFrame(renderFrame);
    }

    // ==========================================================
    // 8. Toolbar Controls & API Global
    // ==========================================================
    function setTool(tool) {
        currentTool = tool;
        if (!UI.toolPen || !UI.toolEraser) return;

        if (tool === 'pen') {
            UI.toolPen.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1 transition-all";
            UI.toolEraser.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white border border-transparent flex items-center gap-1 transition-all";
        } else {
            UI.toolEraser.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1 transition-all";
            UI.toolPen.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white border border-transparent flex items-center gap-1 transition-all";
        }
    }

    function setSize(size, element) {
        currentSize = size;
        
        // Hapus class active dari semua tombol ukuran
        const btns = document.querySelectorAll('.brush-size-btn');
        btns.forEach(btn => btn.classList.remove('active'));
        
        if (element) {
            element.classList.add('active');
        }
    }

    function setColor(color, element) {
        currentColor = color;
        currentTool = 'pen';
        setTool('pen');

        // Update active color ring
        const nodes = document.querySelectorAll('.color-node');
        nodes.forEach(node => node.classList.remove('color-node-active', 'ring-2', 'ring-white', 'scale-110'));

        if (element) {
            element.classList.add('color-node-active', 'ring-2', 'ring-white', 'scale-110');
        }

        // Sinkronkan picker jika warnanya bukan custom manual
        if (UI.colorPicker) {
            UI.colorPicker.value = color;
        }
    }

    function setCustomColor(color) {
        currentColor = color;
        currentTool = 'pen';
        setTool('pen');
        
        // Hapus highlight dari palet bawaan
        const nodes = document.querySelectorAll('.color-node');
        nodes.forEach(node => node.classList.remove('color-node-active', 'ring-2', 'ring-white', 'scale-110'));
    }

    async function clearCanvas(triggerSync = true) {
        if (!canvas || !ctx) return;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Hapus juga kanvas offscreen agar resize tidak memulihkannya
        if (offscreenCanvas && offscreenCtx) {
            offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
        }
        
        if (triggerSync) {
            // Batalkan antrean penyimpanan snapshot tertunda karena sudah di-clear
            clearTimeout(saveTimeout);

            // 1. Simpan snapshot kosong ke database secara langsung (menghapus gambar lama di DB)
            try {
                await fetch(`${BASE_URL}/roomevent/save_canvas`, {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        snapshot: ''
                    })
                });
            } catch (e) {
                console.error('Gagal menghapus snapshot canvas di DB:', e);
            }

            // 2. Kirim event hapus ke pasangan
            try {
                await fetch(`${BASE_URL}/roomevent/trigger`, {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        event_type: 'canvas_clear',
                        event_data: '{}'
                    })
                });
                
                if (window.roomWs && typeof window.roomWs.addLog === 'function') {
                    window.roomWs.addLog('🧹', 'Kamu membersihkan papan gambar.');
                }
            } catch (e) { /* abaikan */ }
        }
    }

    function downloadCanvas() {
        if (!canvas) return;

        // Buat kanvas dummy sementara untuk menggabungkan latar belakang gelap premium 
        // sehingga warna goresan neon terlihat pop secara menakjubkan
        const downloadCanvas = document.createElement('canvas');
        const dCtx = downloadCanvas.getContext('2d');
        
        downloadCanvas.width = canvas.width;
        downloadCanvas.height = canvas.height;

        // 1. Gambar Background Premium Gelap (Slate)
        dCtx.fillStyle = '#111827'; // Dark Gray-900 matching Web Theme
        dCtx.fillRect(0, 0, downloadCanvas.width, downloadCanvas.height);

        // 2. Tambahkan ambient glow garis tipis
        dCtx.strokeStyle = 'rgba(244, 114, 182, 0.08)'; // Pink glow border
        dCtx.lineWidth = 10;
        dCtx.strokeRect(0, 0, downloadCanvas.width, downloadCanvas.height);

        // 3. Gambar tulisan watermark romantis di pojok bawah
        dCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        dCtx.font = 'italic 12px serif';
        dCtx.textAlign = 'right';
        dCtx.fillText('Dilukis Bersama di HubunganKita 💞', downloadCanvas.width - 15, downloadCanvas.height - 15);

        // 4. Gambar coretan dari kanvas utama ke atas background
        dCtx.drawImage(canvas, 0, 0);

        // 5. Trigger download file PNG
        const link = document.createElement('a');
        const dateStr = new Date().toLocaleDateString('id-ID').replace(/\//g, '-');
        link.download = `karya-bersama-${dateStr}.png`;
        link.href = downloadCanvas.toDataURL('image/png');
        link.click();

        if (window.roomWs && typeof window.roomWs.addLog === 'function') {
            window.roomWs.addLog('💾', 'Kamu menyimpan karya gambar bersama ke galeri perangkat!');
        }
    }

    // ==========================================================
    // 9. Snapshot Persistence Engine (Fase 3 Ultimate Upgrade)
    // ==========================================================
    let saveTimeout = null;

    function triggerSaveSnapshot() {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveCanvasSnapshot, 1000); // 1 detik debounce
    }

    async function saveCanvasSnapshot() {
        if (!canvas) return;

        // Cek apakah canvas kosong
        const isEmpty = isCanvasEmpty(canvas);
        const dataUrl = isEmpty ? '' : canvas.toDataURL('image/png');

        try {
            await fetch(`${BASE_URL}/roomevent/save_canvas`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    snapshot: dataUrl
                })
            });
        } catch (e) {
            console.error('Gagal menyimpan snapshot canvas:', e);
        }
    }

    async function loadCanvasSnapshot() {
        try {
            const res = await fetch(`${BASE_URL}/roomevent/get_canvas`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await res.json();

            if (data.status === 'ok' && data.snapshot) {
                // Sembunyikan instruksi/overlay awal jika ada gambar terunggah
                if (overlay) {
                    overlay.classList.add('opacity-0', 'pointer-events-none');
                    setTimeout(() => overlay.remove(), 350);
                    overlay = null;
                }

                const img = new Image();
                img.onload = () => {
                    if (ctx) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        
                        // Gambar ke offscreen buffer agar resize protection bekerja!
                        if (offscreenCanvas && offscreenCtx) {
                            offscreenCanvas.width = canvas.width;
                            offscreenCanvas.height = canvas.height;
                            offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
                            offscreenCtx.drawImage(img, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
                        }
                    }
                };
                img.src = data.snapshot;
            }
        } catch (e) {
            console.error('Gagal memuat snapshot canvas:', e);
        }
    }

    function isCanvasEmpty(canvas) {
        const context = canvas.getContext('2d');
        const buffer = new Uint32Array(
            context.getImageData(0, 0, canvas.width, canvas.height).data.buffer
        );
        return !buffer.some(color => color !== 0);
    }

    // ==========================================================
    // 10. Expose Global API & Jalankan Inisialisasi
    // ==========================================================
    window.roomDoodle = {
        setTool,
        setSize,
        setColor,
        setCustomColor,
        clearCanvas,
        downloadCanvas,
        applyRemoteEvent,
        toggleDoodleLock
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initCanvas();
    } else {
        document.addEventListener('DOMContentLoaded', initCanvas);
    }

    // Cleanup saat halaman ditutup
    window.addEventListener('beforeunload', () => {
        clearInterval(batchTimer);
        cancelAnimationFrame(animFrameId);
        clearTimeout(saveTimeout);
    });

})();
