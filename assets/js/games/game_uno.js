/**
 * game_uno.js — Mesin Game UNO 2-Pemain Deterministik Real-Time (v2.0)
 * Sinkronisasi via database polling. Desain modern, ultra-stabil & anti-desync.
 */
window.gameUno = (function () {
    'use strict';

    // ── Konstanta & Deck Generator ─────────────────────────────
    const COLORS = ['R', 'Y', 'G', 'B']; // Red, Yellow, Green, Blue
    const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+2', 'S']; // Numbers, Draw 2, Skip

    const COLOR_MAP = {
        'R': { hex: '#ff4757', name: 'Merah' },
        'Y': { hex: '#ffa502', name: 'Kuning' },
        'G': { hex: '#2ed573', name: 'Hijau' },
        'B': { hex: '#1e90ff', name: 'Biru' },
        'W': { hex: '#a855f7', name: 'Wild' }
    };

    // ── State Game ─────────────────────────────────────────────
    let deck = [];
    let discardPile = [];
    let hostHand = [];
    let guestHand = [];
    
    let currentTurn = 'host'; // 'host' | 'guest'
    let activeColor = '';
    let isGameOver = false;
    let scores = { me: 0, partner: 0 };
    let gameRound = 0; // Digunakan sebagai bagian dari seed agar tiap round ter-shuffle berbeda
    
    let isHost = false;
    let myRole = ''; // 'host' | 'guest'
    let partnerRole = '';
    let el = null;
    
    const CFG = window.ROOM_CONFIG || {};
    const BASE_URL = CFG.baseUrl || '';
    const coupleKey = CFG.coupleKey || 'default_seed_key_123';

    // ── Seeded PRNG (Mulberry32) ──────────────────────────────
    function getSeededRandom(seedStr) {
        let h = 1779033703 ^ seedStr.length;
        for (let i = 0; i < seedStr.length; i++) {
            h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
            h = h << 13 | h >>> 19;
        }
        return function () {
            let t = h += 0x6D2B79F5;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seededShuffle(array, randomFn) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex !== 0) {
            randomIndex = Math.floor(randomFn() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    // ── Generator & Setup State Awal ──────────────────────────
    function generateDeck() {
        const newDeck = [];
        for (const col of COLORS) {
            for (const val of VALUES) {
                newDeck.push(col + val);
                if (val !== '0') newDeck.push(col + val);
            }
        }
        for (let i = 0; i < 4; i++) {
            newDeck.push('W');
        }
        return newDeck;
    }

    function initDeterministicBoard(customSeed) {
        // Buat seed unik per ronde permainan
        const roundSeed = customSeed ? `${coupleKey}_uno_custom_${customSeed}` : `${coupleKey}_uno_round_${gameRound}`;
        const randomFn = getSeededRandom(roundSeed);

        deck = generateDeck();
        seededShuffle(deck, randomFn);

        // Bagi kartu awal secara adil (masing-masing 7)
        hostHand = [];
        guestHand = [];
        for (let i = 0; i < 7; i++) {
            hostHand.push(deck.pop());
            guestHand.push(deck.pop());
        }

        // Ambil kartu pertama untuk discard pile (tidak boleh Wild untuk pertama kali)
        let firstCard = deck.pop();
        while (firstCard === 'W') {
            deck.unshift(firstCard);
            seededShuffle(deck, randomFn);
            firstCard = deck.pop();
        }
        discardPile = [firstCard];
        activeColor = firstCard[0];

        currentTurn = 'host';
        isGameOver = false;
    }

    // ── Card UI Renderer ──────────────────────────────────────
    function getCardLabel(card) {
        if (card === 'W') return 'W';
        const val = card.substring(1);
        if (val === 'S') return '🚫';
        return val;
    }

    function renderCard(card, isClickable = false, index = -1) {
        const colorCode = card === 'W' ? 'W' : card[0];
        const label = getCardLabel(card);
        const colorInfo = COLOR_MAP[colorCode];
        
        let cardStyle = `background: ${colorInfo.hex}; box-shadow: 0 4px 10px rgba(0,0,0,0.3);`;
        let cursor = isClickable ? 'cursor: pointer;' : 'cursor: default;';
        
        let clickHandler = isClickable && index !== -1 ? `onclick="window.gameUno.playCard(${index})"` : '';
        let hoverEffects = isClickable 
            ? `onmouseenter="this.style.transform='translateY(-12px) scale(1.05)'" onmouseleave="this.style.transform='none'"` 
            : '';

        return `
            <div ${clickHandler} ${hoverEffects}
                 style="${cardStyle} ${cursor} width: clamp(50px, 12vw, 75px); aspect-ratio: 2/3; border-radius: 8px; border: 2px solid rgba(255,255,255,0.8);
                        display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative;
                        transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); user-select: none;"
                 class="uno-card">
                <div style="background: white; width: 70%; aspect-ratio: 1; border-radius: 50%; display: flex; align-items: center; justify-content: center; transform: rotate(-10deg);">
                    <span style="color: ${colorInfo.hex}; font-size: clamp(14px, 3.5vw, 24px); font-weight: 900; font-family: 'Outfit', sans-serif;">
                        ${label}
                    </span>
                </div>
            </div>
        `;
    }

    // ── Main Render ──────────────────────────────────────────
    function render() {
        if (!el) return;

        const myTurn = (currentTurn === myRole);
        const myHand = isHost ? hostHand : guestHand;
        const partnerHand = isHost ? guestHand : hostHand;
        const boardColor = COLOR_MAP[activeColor] || { hex: '#1e293b', name: 'Belum ditentukan' };

        let html = `
            <div class="flex flex-col gap-4 w-full select-none" style="font-family: 'Outfit', sans-serif;">
                
                <!-- 1. Pasangan Hand Area (Top) -->
                <div class="flex flex-col items-center p-3 rounded-xl bg-white/5 border border-white/5">
                    <span class="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-2">Kartu Pasangan (${partnerHand.length} kartu)</span>
                    <div class="flex justify-center gap-1.5 overflow-x-auto no-scrollbar w-full max-w-full py-1">
                        ${partnerHand.length > 0 
                            ? partnerHand.map(() => `
                                <div style="background: linear-gradient(135deg, #1e1b4b, #311042); width: clamp(35px, 8vw, 45px); aspect-ratio: 2/3; border-radius: 6px; border: 1.5px solid rgba(255,255,255,0.15);
                                            display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 5px rgba(0,0,0,0.2);">
                                    <span style="color: #f472b6; font-size: clamp(8px, 2vw, 12px); font-weight: 900;">UNO</span>
                                </div>
                              `).join('')
                            : `<span class="text-xs text-emerald-400 font-bold">Kartu Habis! 🏆</span>`
                        }
                    </div>
                </div>

                <!-- 2. Arena Tengah (Tumpukan Kartu & Discard Pile) -->
                <div class="grid grid-cols-2 gap-4 items-center justify-center py-4 bg-slate-950/20 border border-white/5 rounded-xl px-4">
                    
                    <!-- Sisi Kiri: Draw Pile -->
                    <div class="flex flex-col items-center justify-center">
                        <span class="text-[9px] text-gray-500 uppercase font-semibold mb-1">Ambil Kartu</span>
                        <div id="uno-draw-pile" 
                             onclick="window.gameUno.drawCard()"
                             style="background: linear-gradient(135deg, #e11d48, #be123c); width: clamp(55px, 13vw, 80px); aspect-ratio: 2/3; border-radius: 8px; border: 2px dashed rgba(255,255,255,0.6);
                                    display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: ${myTurn && !isGameOver ? 'pointer' : 'not-allowed'};
                                    box-shadow: 0 0 15px rgba(225, 29, 72, 0.2); transition: all 0.2s;"
                             class="group hover:border-white hover:scale-105 active:scale-95">
                            <span style="color: white; font-size: 16px; font-weight: 900; font-family: 'Outfit', sans-serif;">+</span>
                            <span style="color: rgba(255,255,255,0.8); font-size: 8px; font-weight: 700; text-transform: uppercase;">Ambil</span>
                        </div>
                    </div>

                    <!-- Sisi Kanan: Discard Pile -->
                    <div class="flex flex-col items-center justify-center">
                        <span class="text-[9px] text-gray-500 uppercase font-semibold mb-1">Tumpukan Buang</span>
                        ${discardPile.length > 0 
                            ? renderCard(discardPile[discardPile.length - 1], false) 
                            : '<div style="width: 80px; aspect-ratio:2/3; border:2px dashed #475569; border-radius:8px"></div>'
                        }
                    </div>

                    <!-- Warna Aktif Indicator -->
                    <div class="col-span-2 flex items-center justify-center gap-1.5 bg-white/5 border border-white/5 rounded-lg py-1 px-3 mt-1">
                        <span class="text-[9px] text-gray-400 uppercase font-bold">Warna Aktif:</span>
                        <span class="w-3.5 h-3.5 rounded-full border border-white/20" style="background: ${boardColor.hex}"></span>
                        <span class="text-xs font-bold" style="color: ${boardColor.hex}">${boardColor.name}</span>
                    </div>

                </div>

                <!-- 3. Hand Deck Sendiri (Bottom) -->
                <div class="flex flex-col items-center p-3 rounded-xl bg-white/5 border border-white/5">
                    <div class="flex justify-between items-center w-full mb-2 px-1">
                        <span class="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Kartu Milikmu (${myHand.length} kartu)</span>
                        ${myHand.length === 1 ? '<span class="text-[10px] font-black text-rose-500 animate-pulse bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full">🗣️ BILANG UNO!</span>' : ''}
                    </div>
                    <div class="flex justify-start gap-1 overflow-x-auto no-scrollbar w-full max-w-full py-2 px-1" style="min-height: 110px;">
                        ${myHand.map((card, idx) => {
                            const isPlayable = myTurn && !isGameOver && canPlayCard(card);
                            return `
                                <div style="position: relative;" class="${isPlayable ? 'playable-wrapper' : 'opacity-60'}">
                                    ${renderCard(card, isPlayable, idx)}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <!-- Wild Color Selector Modal -->
                <div id="uno-wild-modal" class="hidden fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div class="bg-slate-900 border border-white/10 rounded-2xl p-6 text-center shadow-2xl max-w-xs w-full mx-4">
                        <h3 class="text-sm font-bold text-white mb-4">Pilih Warna Kartu Wild!</h3>
                        <div class="grid grid-cols-2 gap-3">
                            <button onclick="window.gameUno.chooseWildColor('R')" class="py-2 px-4 rounded-xl font-bold text-xs text-white" style="background: #ff4757">Merah</button>
                            <button onclick="window.gameUno.chooseWildColor('Y')" class="py-2 px-4 rounded-xl font-bold text-xs text-white" style="background: #ffa502">Kuning</button>
                            <button onclick="window.gameUno.chooseWildColor('G')" class="py-2 px-4 rounded-xl font-bold text-xs text-white" style="background: #2ed573">Hijau</button>
                            <button onclick="window.gameUno.chooseWildColor('B')" class="py-2 px-4 rounded-xl font-bold text-xs text-white" style="background: #1e90ff">Biru</button>
                        </div>
                    </div>
                </div>

            </div>
        `;

        el.innerHTML = html;
        updateTurnIndicator();
    }

    // ── Turn Indicator Helper ────────────────────────────────
    function updateTurnIndicator() {
        const ind = document.getElementById('uno-turn-indicator');
        if (!ind) return;
        const myTurn = (currentTurn === myRole);
        if (isGameOver) return;
        
        ind.textContent = myTurn ? 'Giliranmu! 🃏' : 'Giliran Pasangan...';
        ind.className = myTurn
            ? 'text-xs font-bold text-pink-400 bg-pink-500/10 px-2 py-0.5 rounded-full border border-pink-500/20 animate-pulse'
            : 'text-xs font-semibold text-gray-500 bg-white/5 px-2 py-0.5 rounded-full border border-transparent';
    }

    // ── Aturan Main UNO ──────────────────────────────────────
    function canPlayCard(card) {
        if (card === 'W') return true;
        
        const topCard = discardPile[discardPile.length - 1];
        const cardColor = card[0];
        const cardValue = card.substring(1);
        
        const topColor = activeColor;
        const topValue = topCard === 'W' ? '' : topCard.substring(1);

        return cardColor === topColor || (topValue !== '' && cardValue === topValue);
    }

    // ── Aksi Lokal Deterministik (Host & Guest mengeksekusi aksi yang sama) ──
    function doPlayCard(role, index, chosenColor) {
        const hand = role === 'host' ? hostHand : guestHand;
        const card = hand[index];
        
        hand.splice(index, 1);
        discardPile.push(card);
        activeColor = chosenColor || card[0];

        // Cek Kemenangan
        if (hand.length === 0) {
            isGameOver = true;
            if (role === myRole) {
                scores.me++;
                document.getElementById('uno-score-me').textContent = scores.me;
            } else {
                scores.partner++;
                document.getElementById('uno-score-partner').textContent = scores.partner;
            }
            setResult(role === myRole ? 'Kamu Menang! 🏆 Deck Kartu Habis!' : 'Pasangan Menang! 👑 Kartu Milikmu Masih Ada!');
        } else {
            // Evaluasi efek kartu aksi
            const val = card.substring(1);
            const opponentRole = role === 'host' ? 'guest' : 'host';
            
            if (card === 'W') {
                currentTurn = opponentRole;
            } else if (val === 'S') {
                currentTurn = role; // Skip lawan: giliran kembali ke pembuat langkah (2-player)
            } else if (val === '+2') {
                currentTurn = role; // Skip lawan
                doDrawCard(opponentRole); // Ambil 2 kartu untuk lawan
                doDrawCard(opponentRole);
            } else {
                currentTurn = opponentRole;
            }
        }
    }

    function doDrawCard(role) {
        if (deck.length === 0) {
            const topCard = discardPile.pop();
            deck = seededShuffle([...discardPile], getSeededRandom(`${coupleKey}_reshuffle_${discardPile.length}`));
            discardPile = [topCard];
        }

        const drawnCard = deck.pop();
        const hand = role === 'host' ? hostHand : guestHand;
        hand.push(drawnCard);

        // Jika giliran dia saat menggambar kartu, periksa apakah bisa langsung dimainkan
        if (currentTurn === role) {
            if (!canPlayCard(drawnCard)) {
                currentTurn = role === 'host' ? 'guest' : 'host';
            }
        }
    }

    // ── Interface Eksternal ──────────────────────────────────
    let pendingWildIndex = -1;

    function playCard(index) {
        const myHand = isHost ? hostHand : guestHand;
        const card = myHand[index];
        
        if (card === 'W') {
            pendingWildIndex = index;
            const modal = document.getElementById('uno-wild-modal');
            if (modal) modal.classList.remove('hidden');
            return;
        }

        executeCardPlay(index, card[0]);
    }

    function chooseWildColor(color) {
        const modal = document.getElementById('uno-wild-modal');
        if (modal) modal.classList.add('hidden');

        if (pendingWildIndex !== -1) {
            executeCardPlay(pendingWildIndex, color);
            pendingWildIndex = -1;
        }
    }

    async function executeCardPlay(index, chosenColor) {
        doPlayCard(myRole, index, chosenColor);
        render();

        // Kirim move deterministik via network
        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    event_type: 'game_move',
                    event_data: JSON.stringify({ game: 'uno', action: 'play', role: myRole, index, chosenColor })
                })
            });
        } catch (e) {}
    }

    async function drawCard() {
        const myTurn = (currentTurn === myRole);
        if (!myTurn || isGameOver) return;

        doDrawCard(myRole);
        render();

        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    event_type: 'game_move',
                    event_data: JSON.stringify({ game: 'uno', action: 'draw', role: myRole })
                })
            });
        } catch (e) {}
    }

    // ── Penerimaan Aksi Remot ────────────────────────────────
    function applyRemote(data) {
        if (data.game !== 'uno') return;

        if (data.action === 'play') {
            doPlayCard(data.role, data.index, data.chosenColor);
        } else if (data.action === 'draw') {
            doDrawCard(data.role);
        }

        render();
    }

    function setResult(msg) {
        const ind = document.getElementById('uno-turn-indicator');
        if (ind) {
            ind.textContent = msg;
            ind.className = 'text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/25 animate-bounce';
        }
        if (window.roomWs) window.roomWs.addLog('🃏', msg);
    }

    // ── Inisialisasi Utama ────────────────────────────────────
    function init(container, playerIsHost, seed) {
        el = container;
        isHost = playerIsHost;
        myRole = isHost ? 'host' : 'guest';
        partnerRole = isHost ? 'guest' : 'host';
        scores = { me: 0, partner: 0 };
        gameRound = 0;

        resetGame(seed);
    }

    function resetGame(seed) {
        initDeterministicBoard(seed);
        render();
    }

    return { init, playCard, chooseWildColor, drawCard, applyRemote, resetGame };
})();
