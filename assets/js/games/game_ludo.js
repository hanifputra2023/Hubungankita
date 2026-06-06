/**
 * game_ludo.js — Mesin Game Ludo Neon Cross 2-Pemain (v6.0)
 * Sync via database polling. Desain modern, ultra-stabil & anti-desync.
 */
window.gameLudo = (function () {
    'use strict';

    // ── Koordinat Absolute (%) Trek Sirkuit Silang Tradisional (24 Sel) ──
    const TRACK_COORDS = [
        // Left Arm (top side)
        { x: 15, y: 38, color: '#ef4444' }, // 0: Red Start
        { x: 26, y: 38 }, // 1
        { x: 38, y: 38 }, // 2: Left Inner Corner

        // Top Arm (left side)
        { x: 38, y: 26 }, // 3
        { x: 38, y: 14 }, // 4
        
        // Top Arm Tip
        { x: 50, y: 14 }, // 5

        // Top Arm (right side)
        { x: 62, y: 14 }, // 6
        { x: 62, y: 26 }, // 7

        // Top-Right Inner Corner
        { x: 62, y: 38 }, // 8

        // Right Arm (top side)
        { x: 74, y: 38 }, // 9
        { x: 85, y: 38 }, // 10
        
        // Right Arm Tip
        { x: 85, y: 50 }, // 11

        // Right Arm (bottom side)
        { x: 85, y: 62, color: '#3b82f6' }, // 12: Blue Start
        { x: 74, y: 62 }, // 13

        // Right-Bottom Inner Corner
        { x: 62, y: 62 }, // 14

        // Bottom Arm (right side)
        { x: 62, y: 74 }, // 15
        { x: 62, y: 86 }, // 16

        // Bottom Arm Tip
        { x: 50, y: 86 }, // 17

        // Bottom Arm (left side)
        { x: 38, y: 86 }, // 18
        { x: 38, y: 74 }, // 19

        // Bottom-Left Inner Corner
        { x: 38, y: 62 }, // 20

        // Left Arm (bottom side)
        { x: 26, y: 62 }, // 21
        { x: 15, y: 62 }, // 22

        // Left Arm Tip
        { x: 15, y: 50 }  // 23
    ];

    // Jalur Home (branching) inside the center rows
    const RED_HOME_COORDS = [
        { x: 26, y: 50, color: '#ef4444' }, // Red Home 1 (Langkah 24)
        { x: 38, y: 50, color: '#ef4444' }  // Red Home 2 (Langkah 25)
    ];
    const BLUE_HOME_COORDS = [
        { x: 74, y: 50, color: '#3b82f6' }, // Blue Home 1 (Langkah 24)
        { x: 62, y: 50, color: '#3b82f6' }  // Blue Home 2 (Langkah 25)
    ];

    const FINAL_HOME = { x: 50, y: 50 }; // Center Square Finish

    const BASE_COORDS = {
        'R': [
            { x: 20, y: 20 },
            { x: 28, y: 28 }
        ],
        'B': [
            { x: 72, y: 72 },
            { x: 80, y: 80 }
        ]
    };

    // ── State Game ─────────────────────────────────────────────
    let tokens = {
        'R': [ { pos: -1 }, { pos: -1 } ],
        'B': [ { pos: -1 }, { pos: -1 } ]
    };
    
    let diceVal = 1;
    let turn = 'R'; // 'R' | 'B'
    let isDiceRolled = false;
    let isRolling = false;
    let isGameOver = false;
    let scores = { me: 0, partner: 0 };

    let myColor = ''; // 'R' | 'B'
    let partnerColor = '';
    let isHost = false;
    let el = null;
    const BASE_URL = (window.ROOM_CONFIG || {}).baseUrl || '';

    // ── Generator Markup Dadu Ludo Berbintik (Custom CSS Dots) ──
    function getDiceMarkup(val) {
        const dotPositions = {
            1: [ { x: 50, y: 50 } ],
            2: [ { x: 25, y: 25 }, { x: 75, y: 75 } ],
            3: [ { x: 25, y: 25 }, { x: 50, y: 50 }, { x: 75, y: 75 } ],
            4: [ { x: 25, y: 25 }, { x: 25, y: 75 }, { x: 75, y: 25 }, { x: 75, y: 75 } ],
            5: [ { x: 25, y: 25 }, { x: 25, y: 75 }, { x: 50, y: 50 }, { x: 75, y: 25 }, { x: 75, y: 75 } ],
            6: [ { x: 25, y: 25 }, { x: 25, y: 50 }, { x: 25, y: 75 }, { x: 75, y: 25 }, { x: 75, y: 50 }, { x: 75, y: 75 } ]
        };

        const positions = dotPositions[val] || dotPositions[1];
        const dotsHTML = positions.map(pos => `
            <div class="absolute w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_4px_rgba(255,255,255,0.9)]"
                 style="left: ${pos.x}%; top: ${pos.y}%; transform: translate(-50%, -50%);">
            </div>
        `).join('');

        return `
            <div class="relative w-full h-full">
                ${dotsHTML}
            </div>
        `;
    }

    // ── UI Board Renderer ──────────────────────────────────────
    function render() {
        if (!el) return;

        const myTurn = (turn === myColor);
        const redTokens = tokens['R'];
        const blueTokens = tokens['B'];

        let html = `
            <div class="flex flex-col gap-4 w-full select-none" style="font-family: 'Outfit', sans-serif;">
                
                <!-- 1. Papan Ludo Sirkuit Silang (Aspect Ratio 1:1) -->
                <div class="relative w-full aspect-square bg-slate-950 border border-white/10 rounded-2xl overflow-hidden shadow-2xl" id="ludo-board">
                    <!-- Garis-garis Dekoratif Neon -->
                    <div class="absolute inset-0 opacity-10" style="background-image: radial-gradient(#fff 1px, transparent 1px); background-size: 15px 15px;"></div>
                    
                    <!-- Silang Papan Neon SVG -->
                    <svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full pointer-events-none opacity-30">
                        <!-- Garis Batas Silang Ludo Tradisional -->
                        <path d="M 38 10 L 62 10 L 62 38 L 90 38 L 90 62 L 62 62 L 62 90 L 38 90 L 38 62 L 10 62 L 10 38 L 38 38 Z" 
                              stroke="rgba(255,255,255,0.25)" stroke-width="1.2" fill="none" />
                        <!-- Red Home entrance line -->
                        <path d="M 10 50 L 50 50" stroke="#ef4444" stroke-width="0.8" stroke-dasharray="1 1" fill="none" />
                        <!-- Blue Home entrance line -->
                        <path d="M 90 50 L 50 50" stroke="#3b82f6" stroke-width="0.8" stroke-dasharray="1 1" fill="none" />
                    </svg>

                    <!-- Area Kandang / Base Red (Top-Left) -->
                    <div style="position: absolute; left: 10%; top: 10%; width: 28%; aspect-ratio: 1; border-radius: 12px; border: 2px solid #ef4444; background: rgba(239, 68, 68, 0.05); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 15px rgba(239, 68, 68, 0.15)">
                        <div class="flex gap-2">
                            <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
                            <span class="text-[9px] text-red-400 font-bold uppercase tracking-wider">Red Base</span>
                        </div>
                    </div>

                    <!-- Area Kandang / Base Blue (Bottom-Right) -->
                    <div style="position: absolute; right: 10%; bottom: 10%; width: 28%; aspect-ratio: 1; border-radius: 12px; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.05); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 15px rgba(59, 130, 246, 0.15)">
                        <div class="flex gap-2">
                            <span class="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse"></span>
                            <span class="text-[9px] text-blue-400 font-bold uppercase tracking-wider">Blue Base</span>
                        </div>
                    </div>

                    <!-- Pusat Target / Home Center (Finish Area) -->
                    <div style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 14%; aspect-ratio: 1; border-radius: 20%; border: 2px solid #10b981; background: rgba(16, 185, 129, 0.15); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px rgba(16, 185, 129, 0.3)">
                        <span class="text-base">👑</span>
                    </div>

                    <!-- 1. Render Trek Sirkuit Utama (24 Bulatan Trek) -->
                    ${TRACK_COORDS.map((coord, idx) => {
                        const cellColor = coord.color || 'rgba(255,255,255,0.08)';
                        const cellBorder = coord.color ? `border: 2px solid ${coord.color}; box-shadow: 0 0 10px ${coord.color};` : 'border: 1px solid rgba(255,255,255,0.2);';
                        
                        let labelText = `${idx}`;
                        let fontClass = 'text-[9.5px] font-black text-white/70';
                        if (idx === 0) {
                            labelText = '★0';
                            fontClass = 'text-[8.5px] font-black text-rose-400';
                        } else if (idx === 12) {
                            labelText = '★12';
                            fontClass = 'text-[8.5px] font-black text-blue-400';
                        }
                        
                        return `
                            <div style="position: absolute; left: ${coord.x}%; top: ${coord.y}%; transform: translate(-50%, -50%); width: 7.5%; aspect-ratio: 1; border-radius: 50%; background: ${cellColor}; ${cellBorder} display: flex; align-items: center; justify-content: center; z-index: 10;">
                                <span class="${fontClass}">${labelText}</span>
                            </div>
                        `;
                    }).join('')}

                    <!-- 2. Render Jalur Red Home Path -->
                    ${RED_HOME_COORDS.map((coord, idx) => `
                        <div style="position: absolute; left: ${coord.x}%; top: ${coord.y}%; transform: translate(-50%, -50%); width: 7.5%; aspect-ratio: 1; border-radius: 50%; background: rgba(239, 68, 68, 0.15); border: 2.5px solid #ef4444; box-shadow: 0 0 8px rgba(239, 68, 68, 0.3); display: flex; align-items: center; justify-content: center; z-index: 10;">
                            <span class="text-[9.5px] text-rose-400 font-black">R${idx+1}</span>
                        </div>
                    `).join('')}

                    <!-- 3. Render Jalur Blue Home Path -->
                    ${BLUE_HOME_COORDS.map((coord, idx) => `
                        <div style="position: absolute; left: ${coord.x}%; top: ${coord.y}%; transform: translate(-50%, -50%); width: 7.5%; aspect-ratio: 1; border-radius: 50%; background: rgba(59, 130, 246, 0.15); border: 2.5px solid #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.3); display: flex; align-items: center; justify-content: center; z-index: 10;">
                            <span class="text-[9.5px] text-blue-400 font-black">B${idx+1}</span>
                        </div>
                    `).join('')}

                    <!-- 4. Render Token -->
                    ${redTokens.map((t, idx) => renderTokenMarkup('R', idx, t, myTurn)).join('')}
                    ${blueTokens.map((t, idx) => renderTokenMarkup('B', idx, t, myTurn)).join('')}

                </div>

                <!-- 2. Arena Dadu & Kontrol -->
                <div class="flex items-center justify-between bg-slate-950/20 border border-white/5 rounded-2xl p-4 gap-4">
                    <!-- Peran / Warna Diri -->
                    <div class="flex flex-col">
                        <span class="text-[9px] text-gray-500 uppercase font-semibold">Warna Kamu</span>
                        <div class="flex items-center gap-1.5 mt-1">
                            <span class="w-3.5 h-3.5 rounded-full border border-white/20" style="background: ${myColor === 'R' ? '#ef4444' : '#3b82f6'}"></span>
                            <span class="text-xs font-bold text-white">${myColor === 'R' ? 'Merah (Host)' : 'Biru (Guest)'}</span>
                        </div>
                    </div>

                    <!-- Dadu Digital Berbintik Realistis -->
                    <div class="flex flex-col items-center">
                        <span class="text-[9px] text-gray-500 uppercase font-semibold mb-1.5">Dadu</span>
                        <div id="ludo-dice-box" 
                             ${myTurn && !isDiceRolled && !isGameOver && !isRolling ? 'onclick="window.gameLudo.rollDice()"' : ''}
                             style="background: ${turn === 'R' ? '#ef4444' : '#3b82f6'}; 
                                    border: 2px solid rgba(255,255,255,0.7);
                                    box-shadow: 0 0 20px ${turn === 'R' ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)'};
                                    transition: transform 0.1s ease-out;"
                             class="w-14 h-14 p-2 rounded-xl flex items-center justify-center shadow-2xl select-none
                                    ${myTurn && !isDiceRolled && !isGameOver && !isRolling ? 'cursor-pointer animate-bounce hover:scale-105 active:scale-95' : 'opacity-85'}"
                             title="${myTurn ? 'Klik untuk melempar dadu' : 'Menunggu pasangan melempar dadu'}">
                            ${getDiceMarkup(diceVal)}
                        </div>
                    </div>

                    <!-- Petunjuk/Instruksi -->
                    <div class="flex flex-col items-end text-right max-w-[40%]">
                        <span class="text-[9px] text-gray-500 uppercase font-semibold">Instruksi</span>
                        <span id="ludo-instruction-text" class="text-[10px] text-gray-300 font-medium mt-1 leading-normal">
                            ${isRolling ? 'Dadu sedang berputar... 🔄' : (myTurn ? (isDiceRolled ? 'Klik bidak yang menyala untuk bergerak!' : 'Roll dadu untuk memulai!') : 'Menunggu giliran pasangan...')}
                        </span>
                    </div>
                </div>

            </div>
        `;

        el.innerHTML = html;
        updateTurnIndicator();
    }

    // ── Render Token Markup ──────────────────────────────────
    function renderTokenMarkup(color, tokenIdx, t, myTurn) {
        const coords = getTokenCoords(color, tokenIdx, t.pos);
        const hex = color === 'R' ? '#ef4444' : '#3b82f6';
        
        const isSelectable = myTurn && isDiceRolled && !isRolling && (color === myColor) && !isGameOver && canMoveToken(color, tokenIdx);
        
        let selectClass = isSelectable ? 'cursor-pointer animate-ping-glow' : 'cursor-default';
        let clickHandler = isSelectable ? `onclick="window.gameLudo.moveToken('${color}', ${tokenIdx})"` : '';
        const icon = '♟\uFE0E';

        return `
            <div ${clickHandler}
                 style="position: absolute; left: ${coords.x}%; top: ${coords.y}%; transform: translate(-50%, -50%); 
                        width: 9%; aspect-ratio: 1; border-radius: 50%; background: ${hex}; border: 2px solid white;
                        display: flex; align-items: center; justify-content: center; z-index: 100;
                        box-shadow: 0 0 10px ${hex}, 0 2px 5px rgba(0,0,0,0.5); transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);"
                 class="ludo-token ${selectClass}">
                <span style="color: white; font-size: clamp(12px, 3.5vw, 18px); font-weight: bold; line-height: 1;">${icon}</span>
            </div>
        `;
    }

    // ── Get Koordinat Token dari Langkah (0-26) ───────────────
    function getTokenCoords(color, tokenIdx, pos) {
        if (pos === -1) {
            return BASE_COORDS[color][tokenIdx];
        }
        if (pos === 26) {
            return FINAL_HOME;
        }

        if (color === 'R') {
            if (pos >= 24) {
                return RED_HOME_COORDS[pos - 24];
            }
            return TRACK_COORDS[pos];
        } else {
            if (pos >= 24) {
                return BLUE_HOME_COORDS[pos - 24];
            }
            const absoluteCell = (12 + pos) % 24;
            return TRACK_COORDS[absoluteCell];
        }
    }

    // ── Aturan Pergerakan Ludo ───────────────────────────────
    function canMoveToken(color, tokenIdx) {
        const pos = tokens[color][tokenIdx].pos;
        
        // Hanya angka 6 yang bisa mengeluarkan bidak dari base kandang
        if (pos === -1) {
            return diceVal === 6;
        }

        const targetPos = pos + diceVal;
        return targetPos <= 26; // Goal pos adalah 26
    }

    function hasAnyMovableTokens(color) {
        return canMoveToken(color, 0) || canMoveToken(color, 1);
    }

    // ── Local Dice Spin Animation Helper ──────────────────────
    function playRollAnimation(callback) {
        let count = 0;
        const box = document.getElementById('ludo-dice-box');
        const interval = setInterval(() => {
            diceVal = Math.floor(Math.random() * 6) + 1;
            if (box) {
                box.innerHTML = getDiceMarkup(diceVal);
                box.style.transform = `rotate(${Math.floor(Math.random() * 360)}deg) scale(${1 + Math.random() * 0.15})`;
            }
            count++;
            if (count > 12) {
                clearInterval(interval);
                if (box) box.style.transform = 'none';
                const finalVal = Math.floor(Math.random() * 6) + 1;
                if (callback) callback(finalVal);
            }
        }, 70);
    }

    // ── Lempar Dadu (Roll Dice) ───────────────────────────────
    async function rollDice() {
        const myTurn = (turn === myColor);
        if (!myTurn || isDiceRolled || isRolling || isGameOver) return;

        isRolling = true;
        isDiceRolled = true;
        render();

        // 1. Kirim sinyal start_roll ke pasangan agar dadunya berputar di sana juga
        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    event_type: 'game_move',
                    event_data: JSON.stringify({ game: 'ludo', action: 'start_roll' })
                })
            });
        } catch (e) {}

        // 2. Putar dadu secara visual
        playRollAnimation(function (finalVal) {
            diceVal = finalVal;
            isRolling = false;

            const movable = hasAnyMovableTokens(myColor);
            
            if (!movable) {
                document.getElementById('ludo-instruction-text').textContent = `Dadu ${diceVal}. Tidak ada bidak yang bisa gerak! 😔`;
                setTimeout(() => {
                    turn = partnerColor;
                    isDiceRolled = false;
                    render();
                    syncState();
                }, 1800);
            } else {
                render();
                syncState();
            }
        });
    }

    // ── Gerakkan Token ───────────────────────────────────────
    function moveToken(color, tokenIdx) {
        const myTurn = (turn === myColor);
        if (!myTurn || !isDiceRolled || isRolling || color !== myColor || isGameOver) return;

        let currentPos = tokens[color][tokenIdx].pos;
        
        if (currentPos === -1) {
            tokens[color][tokenIdx].pos = 0; // Keluar ke Start (Langkah 0)
        } else {
            tokens[color][tokenIdx].pos = currentPos + diceVal;
        }

        const newPos = tokens[color][tokenIdx].pos;

        // Cek Capture (Jika mendarat di trek utama pada sel absolut yang sama)
        if (newPos >= 0 && newPos <= 23) {
            const myAbsoluteCell = color === 'R' ? newPos : (12 + newPos) % 24;
            const oppTokens = tokens[partnerColor];
            oppTokens.forEach((ot) => {
                if (ot.pos >= 0 && ot.pos <= 23) {
                    const oppAbsoluteCell = partnerColor === 'R' ? ot.pos : (12 + ot.pos) % 24;
                    if (myAbsoluteCell === oppAbsoluteCell) {
                        ot.pos = -1;
                        if (window.roomWs) {
                            window.roomWs.addLog('⚔️', `Bidak ${color === 'R' ? 'Merah' : 'Biru'} menendang Bidak ${partnerColor === 'R' ? 'Merah' : 'Biru'} kembali ke Kandang!`);
                        }
                    }
                }
            });
        }

        // Cek Kemenangan (Jika kedua token mencapai pos = 26)
        if (tokens[color][0].pos === 26 && tokens[color][1].pos === 26) {
            isGameOver = true;
            scores.me++;
            document.getElementById('ludo-score-me').textContent = scores.me;
            setResult(`Kamu Menang! 👑 Kedua bidak berhasil sampai di garis FINISH!`);
        } else {
            // Roll 6 dapat bonus jalan lagi
            if (diceVal === 6) {
                isDiceRolled = false;
                document.getElementById('ludo-instruction-text').textContent = 'Bonus! Roll dadu sekali lagi karena dapat 6! 🎉';
            } else {
                turn = partnerColor;
                isDiceRolled = false;
            }
        }

        render();
        syncState();
    }

    // ── Sinkronisasi via Network ─────────────────────────────
    async function syncState() {
        const gameState = {
            tokens,
            diceVal,
            turn,
            isDiceRolled,
            isGameOver
        };

        try {
            await fetch(`${BASE_URL}/roomevent/trigger`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    event_type: 'game_move',
                    event_data: JSON.stringify({ game: 'ludo', ...gameState })
                })
            });
        } catch (e) {}
    }

    function applyRemote(data) {
        if (data.game !== 'ludo') return;

        // Jika pasangan mulai melempar dadu
        if (data.action === 'start_roll') {
            isRolling = true;
            isDiceRolled = true;
            render();
            playRollAnimation(function () {
                isRolling = false;
            });
            return;
        }

        isRolling = false;
        tokens = data.tokens;
        diceVal = data.diceVal;
        turn = data.turn;
        isDiceRolled = data.isDiceRolled;
        isGameOver = data.isGameOver;

        if (isGameOver) {
            const iWon = (turn === myColor);
            if (iWon) {
                scores.me++;
                document.getElementById('ludo-score-me').textContent = scores.me;
                setResult(`Kamu Menang! 👑 Kedua bidak sampai FINISH!`);
            } else {
                scores.partner++;
                document.getElementById('ludo-score-partner').textContent = scores.partner;
                setResult(`Pasangan Menang! 👑 Bidak Pasangan sampai FINISH!`);
            }
        }

        render();
    }

    function setResult(msg) {
        const ind = document.getElementById('ludo-turn-indicator');
        if (ind) {
            ind.textContent = msg;
            ind.className = 'text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/25 animate-bounce';
        }
        if (window.roomWs) window.roomWs.addLog('🎯', msg);
    }

    function updateTurnIndicator() {
        const ind = document.getElementById('ludo-turn-indicator');
        if (!ind) return;
        const myTurn = (turn === myColor);
        if (isGameOver) return;

        ind.textContent = myTurn ? 'Giliranmu! 🎲' : 'Giliran Pasangan...';
        ind.className = myTurn
            ? 'text-xs font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20 animate-pulse'
            : 'text-xs font-semibold text-gray-500 bg-white/5 px-2 py-0.5 rounded-full border border-transparent';
    }

    // ── Inisialisasi Utama ────────────────────────────────────
    function init(container, playerIsHost) {
        el = container;
        isHost = playerIsHost;
        myColor = isHost ? 'R' : 'B';
        partnerColor = isHost ? 'B' : 'R';

        render();
    }

    function resetGame() {
        tokens = {
            'R': [ { pos: -1 }, { pos: -1 } ],
            'B': [ { pos: -1 }, { pos: -1 } ]
        };
        diceVal = 1;
        turn = 'R';
        isDiceRolled = false;
        isRolling = false;
        isGameOver = false;

        render();
    }

    return { init, rollDice, moveToken, applyRemote, resetGame };
})();
