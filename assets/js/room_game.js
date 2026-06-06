/**
 * room_game.js — Pusat Game Pasangan & Orchestrator (v2.0)
 * ==============================================================
 * Mengelola navigasi Pusat Game, Tic-Tac-Toe engine built-in,
 * dan routing ke sub-modul game (Chess, Uno, Ludo).
 * Semua sinkronisasi via HTTP polling database.
 * ==============================================================
 */

(function () {
    'use strict';

    // ==========================================================
    // 1. Konfigurasi State & Peran
    // ==========================================================
    const CFG       = window.ROOM_CONFIG || {};
    const BASE_URL  = CFG.baseUrl  || '';
    const myId      = parseInt(CFG.userId || 0, 10);
    const partnerId = parseInt(CFG.partnerId || 0, 10);

    // Penentuan peran deterministik: ID kecil = Player X / Putih
    const isPlayerX       = myId < partnerId;
    const myMarker        = isPlayerX ? '❌' : '⭕';
    const partnerMarker   = isPlayerX ? '⭕' : '❌';
    const myCode          = isPlayerX ? 'X' : 'O';

    // State Game Utama
    let activeGame   = 'menu'; // 'menu' | 'tictactoe' | 'chess' | 'uno' | 'ludo'
    let boardState   = Array(9).fill(null);
    let currentTurn  = 'X';
    let isGameActive = true;
    let scores       = { me: 0, partner: 0 };

    // Pola Kemenangan Tic-Tac-Toe
    const WIN_PATTERNS = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];

    // DOM
    let menuView, arenaView, chessView, unoView, ludoView, turnIndicator, scoreMeEl, scorePartnerEl, cells;

    // ==========================================================
    // 2. Inisialisasi DOM
    // ==========================================================
    function initGameCenter() {
        menuView       = document.getElementById('game-menu-view');
        arenaView      = document.getElementById('game-arena-view');
        chessView      = document.getElementById('game-chess-view');
        unoView        = document.getElementById('game-uno-view');
        ludoView       = document.getElementById('game-ludo-view');
        turnIndicator  = document.getElementById('game-turn-indicator');
        scoreMeEl      = document.getElementById('game-score-me');
        scorePartnerEl = document.getElementById('game-score-partner');
        cells          = Array.from(document.querySelectorAll('.ttt-cell'));

        if (!menuView) return;
        resetBoardState();
    }

    // ==========================================================
    // 3. Navigasi Game Center (Sinkronisasi Menu)
    // ==========================================================
    function hideAllViews() {
        if (menuView)  menuView.classList.add('hidden');
        if (arenaView) arenaView.classList.add('hidden');
        if (chessView) chessView.classList.add('hidden');
        if (unoView)   unoView.classList.add('hidden');
        if (ludoView)  ludoView.classList.add('hidden');
    }

    async function selectGame(gameName, triggerSync = true, remoteSeed = null) {
        activeGame = gameName;
        hideAllViews();

        let seed = remoteSeed;
        if (!seed && triggerSync && (gameName === 'uno' || gameName === 'ludo')) {
            seed = Math.floor(Math.random() * 10000000);
        }

        if (gameName === 'menu') {
            menuView.classList.remove('hidden');
            resetBoardState();
        } else if (gameName === 'tictactoe') {
            arenaView.classList.remove('hidden');
            resetBoardState();
        } else if (gameName === 'chess') {
            chessView.classList.remove('hidden');
            // Inisialisasi engine Catur
            if (window.gameChess) {
                const container = document.getElementById('chess-board-container');
                window.gameChess.init(container, isPlayerX); // isPlayerX = putih
            }
        } else if (gameName === 'uno') {
            if (unoView) unoView.classList.remove('hidden');
            if (window.gameUno) {
                const container = document.getElementById('uno-board-container');
                window.gameUno.init(container, isPlayerX, seed);
            }
        } else if (gameName === 'ludo') {
            if (ludoView) ludoView.classList.remove('hidden');
            if (window.gameLudo) {
                const container = document.getElementById('ludo-board-container');
                window.gameLudo.init(container, isPlayerX);
            }
        }

        if (triggerSync) {
            try {
                await fetch(`${BASE_URL}/roomevent/trigger`, {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        event_type: 'game_select',
                        event_data: JSON.stringify({ game: gameName, seed: seed })
                    })
                });

                const labels = { tictactoe: 'Tic-Tac-Toe', chess: 'Catur', uno: 'Uno', ludo: 'Ludo' };
                if (window.roomWs && typeof window.roomWs.addLog === 'function') {
                    if (gameName !== 'menu') {
                        window.roomWs.addLog('🎮', `Kamu mengajak pasangan bermain ${labels[gameName] || gameName}!`);
                    } else {
                        window.roomWs.addLog('🏡', 'Kamu kembali ke Menu Utama Game.');
                    }
                }
            } catch (e) { /* abaikan */ }
        }
    }

    // Coming Soon toast
    function showComingSoon(gameTitle) {
        const oldToast = document.getElementById('coming-soon-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.id = 'coming-soon-toast';
        toast.className = "fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2.5 px-4 py-3 rounded-xl border border-pink-500/20 bg-slate-900/90 text-white shadow-2xl backdrop-blur-md transition-all transform translate-y-[-20px] opacity-0 duration-300";
        toast.innerHTML = `
            <span class="text-xl">💖</span>
            <div class="flex flex-col text-left">
                <span class="text-xs font-bold">${gameTitle} Segera Hadir!</span>
                <span class="text-[10px] text-gray-300">Yuk bermain game yang sudah aktif bersama pasanganmu.</span>
            </div>
        `;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.remove('translate-y-[-20px]', 'opacity-0'));
        setTimeout(() => {
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ==========================================================
    // 4. Tic-Tac-Toe Engine
    // ==========================================================
    function isMyTurn() { return isGameActive && currentTurn === myCode; }

    function resetBoardState() {
        boardState = Array(9).fill(null);
        currentTurn = 'X';
        isGameActive = true;
        renderBoard();
        updateTurnIndicator();
    }

    function renderBoard() {
        if (!cells || cells.length === 0) return;
        cells.forEach((cell, idx) => {
            const marker = boardState[idx];
            cell.textContent = marker === 'X' ? '❌' : (marker === 'O' ? '⭕' : '');
            cell.className = "ttt-cell aspect-square w-full rounded-xl bg-slate-950/40 border border-white/10 hover:border-pink-500/30 flex items-center justify-center text-2xl font-black text-white hover:bg-white/5 transition-all cursor-pointer active:scale-95";
            if (marker === 'X') cell.classList.add('text-rose-400');
            else if (marker === 'O') cell.classList.add('text-indigo-400');
        });
    }

    function updateTurnIndicator() {
        if (!turnIndicator || !isGameActive) return;
        if (isMyTurn()) {
            turnIndicator.textContent = `Giliranmu! ${myMarker}`;
            turnIndicator.className = "text-xs font-bold text-rose-400 flex items-center gap-1 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20 shadow-md shadow-rose-500/5 animate-pulse";
        } else {
            turnIndicator.textContent = `Giliran Pasangan... ${partnerMarker}`;
            turnIndicator.className = "text-xs font-semibold text-gray-500 flex items-center gap-1 bg-white/5 px-2 py-0.5 rounded-full border border-transparent";
        }
    }

    async function makeMove(cellIndex) {
        if (activeGame !== 'tictactoe') return;
        if (!isMyTurn() || boardState[cellIndex] !== null) return;

        boardState[cellIndex] = myCode;
        renderBoard();

        const win = checkWin();
        const draw = !win && boardState.every(c => c !== null);
        const nextTurn = myCode === 'X' ? 'O' : 'X';

        if (win) handleWin(myCode, win.pattern);
        else if (draw) handleDraw();
        else { currentTurn = nextTurn; updateTurnIndicator(); }

        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    event_type: 'game_move',
                    event_data: JSON.stringify({ game: 'ttt', index: cellIndex, marker: myCode, nextTurn })
                })
            });
        } catch (e) {}
    }

    function checkWin() {
        for (const p of WIN_PATTERNS) {
            const [a, b, c] = p;
            if (boardState[a] && boardState[a] === boardState[b] && boardState[a] === boardState[c])
                return { winner: boardState[a], pattern: p };
        }
        return null;
    }

    function handleWin(winnerCode, pattern) {
        isGameActive = false;
        pattern.forEach(i => { if (cells[i]) cells[i].classList.add('win-glow'); });
        const didIWin = winnerCode === myCode;
        if (didIWin) {
            scores.me++;
            if (scoreMeEl) scoreMeEl.textContent = scores.me;
            turnIndicator.textContent = "Kamu Menang! 🏆💖";
            turnIndicator.className = "text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/25 animate-bounce";
        } else {
            scores.partner++;
            if (scorePartnerEl) scorePartnerEl.textContent = scores.partner;
            turnIndicator.textContent = "Pasangan Menang! 👑💞";
            turnIndicator.className = "text-xs font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/25";
        }
    }

    function handleDraw() {
        isGameActive = false;
        turnIndicator.textContent = "Permainan Seri! 🤝💞";
        turnIndicator.className = "text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/25";
    }

    async function resetGame(triggerSync = true, remoteSeed = null) {
        let seed = remoteSeed;
        if (!seed && triggerSync && (activeGame === 'uno' || activeGame === 'ludo')) {
            seed = Math.floor(Math.random() * 10000000);
        }

        // Reset sesuai game aktif
        if (activeGame === 'tictactoe') {
            resetBoardState();
        } else if (activeGame === 'chess' && window.gameChess) {
            window.gameChess.resetGame();
        } else if (activeGame === 'uno' && window.gameUno) {
            window.gameUno.resetGame(seed);
        } else if (activeGame === 'ludo' && window.gameLudo) {
            window.gameLudo.resetGame();
        }

        if (triggerSync) {
            try {
                await fetch(`${BASE_URL}/roomevent/trigger`, {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        event_type: 'game_reset',
                        event_data: JSON.stringify({ game: activeGame, seed: seed })
                    })
                });
            } catch (e) {}
        }
    }

    // ==========================================================
    // 5. Penerimaan Event dari Polling Database
    // ==========================================================
    function applyRemoteEvent(event) {
        const data = event.event_data || {};

        if (event.event_type === 'game_select') {
            selectGame(data.game, false, data.seed);
        }
        else if (event.event_type === 'game_move') {
            // Route ke sub-modul yang benar
            if (data.game === 'chess') {
                if (window.gameChess) window.gameChess.applyRemote(data);
            } else if (data.game === 'uno') {
                if (window.gameUno) window.gameUno.applyRemote(data);
            } else if (data.game === 'ludo') {
                if (window.gameLudo) window.gameLudo.applyRemote(data);
            } else {
                // Tic-Tac-Toe (default/legacy)
                boardState[data.index] = data.marker;
                renderBoard();
                const win = checkWin();
                const draw = !win && boardState.every(c => c !== null);
                if (win) handleWin(data.marker, win.pattern);
                else if (draw) handleDraw();
                else { currentTurn = data.nextTurn; updateTurnIndicator(); }
            }
        }
        else if (event.event_type === 'game_reset') {
            if (data.game === 'chess') {
                if (window.gameChess) window.gameChess.resetGame();
            } else if (data.game === 'uno') {
                if (window.gameUno) window.gameUno.resetGame(data.seed);
            } else if (data.game === 'ludo') {
                if (window.gameLudo) window.gameLudo.resetGame();
            } else {
                resetBoardState();
            }
            if (window.roomWs) window.roomWs.addLog('🔄', 'Pasangan memulai ulang game.');
        }
    }

    // ==========================================================
    // 6. Expose API & Init
    // ==========================================================
    window.roomGame = {
        selectGame,
        showComingSoon,
        makeMove,
        resetGame,
        applyRemoteEvent
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initGameCenter();
    } else {
        document.addEventListener('DOMContentLoaded', initGameCenter);
    }

})();
