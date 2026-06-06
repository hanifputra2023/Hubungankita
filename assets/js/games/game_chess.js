/**
 * game_chess.js — Mesin Catur Real-Time 2 Pemain (v1.0)
 * Sync via database polling. Mendukung semua aturan catur dasar:
 * gerak semua buah, castling, promosi pion, deteksi skak & skakmat.
 */
window.gameChess = (function () {
    'use strict';

    // ── Konstanta ─────────────────────────────────────────────
    const INIT = [
        'bR','bN','bB','bQ','bK','bB','bN','bR',
        'bP','bP','bP','bP','bP','bP','bP','bP',
        null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,
        'wP','wP','wP','wP','wP','wP','wP','wP',
        'wR','wN','wB','wQ','wK','wB','wN','wR',
    ];
    const UNI = {
        wK:'♚\uFE0E',wQ:'♛\uFE0E',wR:'♜\uFE0E',wB:'♝\uFE0E',wN:'♞\uFE0E',wP:'♟\uFE0E',
        bK:'♚\uFE0E',bQ:'♛\uFE0E',bR:'♜\uFE0E',bB:'♝\uFE0E',bN:'♞\uFE0E',bP:'♟\uFE0E'
    };
    const FILES = 'abcdefgh';

    // ── State ─────────────────────────────────────────────────
    let board, turn, castling, selSq, legal, gameOver, scores, isWhite, el;
    const BASE_URL = (window.ROOM_CONFIG||{}).baseUrl||'';

    function reset() {
        board    = [...INIT];
        turn     = 'w';
        castling = { wK:true, wQ:true, bK:true, bQ:true };
        selSq    = null;
        legal    = [];
        gameOver = false;
    }

    // ── Board helpers ─────────────────────────────────────────
    const r = i => Math.floor(i/8);
    const c = i => i%8;
    const idx = (row,col) => row*8+col;
    const ok  = (row,col) => row>=0&&row<8&&col>=0&&col<8;
    const clr = p => p ? p[0] : null;
    const opp = c => c==='w'?'b':'w';
    const sqName = i => FILES[c(i)]+(8-r(i));

    // ── Pseudo-legal move generation ──────────────────────────
    function pseudoMoves(b, sq, cast) {
        const p = b[sq]; if (!p) return [];
        const pc = clr(p), pt = p[1];
        const moves = [];
        const rr = r(sq), cc = c(sq);

        const push = (r2,c2) => {
            if (!ok(r2,c2)) return;
            if (clr(b[idx(r2,c2)]) !== pc) moves.push(idx(r2,c2));
        };
        const slide = (dr,dc) => {
            let r2=rr+dr, c2=cc+dc;
            while (ok(r2,c2)) {
                const t=b[idx(r2,c2)];
                if (clr(t)===pc) break;
                moves.push(idx(r2,c2));
                if (t) break;
                r2+=dr; c2+=dc;
            }
        };

        if (pt==='P') {
            const d=pc==='w'?-1:1, sr=pc==='w'?6:1;
            if (ok(rr+d,cc) && !b[idx(rr+d,cc)]) {
                moves.push(idx(rr+d,cc));
                if (rr===sr && !b[idx(rr+2*d,cc)]) moves.push(idx(rr+2*d,cc));
            }
            for (const dc of [-1,1])
                if (ok(rr+d,cc+dc) && clr(b[idx(rr+d,cc+dc)])===opp(pc))
                    moves.push(idx(rr+d,cc+dc));
        } else if (pt==='N') {
            for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
                push(rr+dr, cc+dc);
        } else if (pt==='B') {
            for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) slide(dr,dc);
        } else if (pt==='R') {
            for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) slide(dr,dc);
        } else if (pt==='Q') {
            for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) slide(dr,dc);
        } else if (pt==='K') {
            for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
                push(rr+dr, cc+dc);
            // Castling
            if (cast) {
                const br = pc==='w'?7:0;
                if (rr===br && cc===4) {
                    if (cast[pc+'K'] && !b[idx(br,5)] && !b[idx(br,6)]) moves.push(idx(br,6));
                    if (cast[pc+'Q'] && !b[idx(br,3)] && !b[idx(br,2)] && !b[idx(br,1)]) moves.push(idx(br,2));
                }
            }
        }
        return moves;
    }

    function inCheck(b, color) {
        const ks = b.findIndex(p => p===color+'K');
        if (ks<0) return false;
        for (let i=0; i<64; i++)
            if (clr(b[i])===opp(color) && pseudoMoves(b,i,null).includes(ks)) return true;
        return false;
    }

    function applyMove(b, from, to, cast) {
        const nb=[...b], p=nb[from], pc=clr(p), br=pc==='w'?7:0;
        const nc={...cast};
        nb[to]=p; nb[from]=null;
        // Pawn promotion → auto Queen
        if (p[1]==='P' && (r(to)===0||r(to)===7)) nb[to]=pc+'Q';
        // Castling: move rook
        if (p[1]==='K') {
            nc[pc+'K']=nc[pc+'Q']=false;
            if (c(to)===6&&c(from)===4) { nb[idx(br,5)]=pc+'R'; nb[idx(br,7)]=null; }
            if (c(to)===2&&c(from)===4) { nb[idx(br,3)]=pc+'R'; nb[idx(br,0)]=null; }
        }
        if (p[1]==='R') {
            if (from===idx(br,0)) nc[pc+'Q']=false;
            if (from===idx(br,7)) nc[pc+'K']=false;
        }
        return {board:nb, castling:nc};
    }

    function legalMoves(b, sq, cast, color) {
        return pseudoMoves(b,sq,cast).filter(to=>{
            const {board:nb}=applyMove(b,sq,to,cast);
            return !inCheck(nb,color);
        });
    }

    function hasAnyLegal(b, color, cast) {
        for (let i=0;i<64;i++)
            if (clr(b[i])===color && legalMoves(b,i,cast,color).length>0) return true;
        return false;
    }

    // ── Rendering ─────────────────────────────────────────────
    let lastFrom = -1, lastTo = -1;

    function render() {
        if (!el) return;
        const flip = !isWhite;
        let html = '<div class="grid grid-cols-8 w-full text-center select-none rounded-lg overflow-hidden" style="border:2px solid rgba(255,255,255,0.15);box-shadow:0 4px 24px rgba(0,0,0,0.5)">';
        for (let dr=0;dr<8;dr++) {
            for (let dc=0;dc<8;dc++) {
                const rr=flip?7-dr:dr, cc_=flip?7-dc:dc;
                const sq=idx(rr,cc_), piece=board[sq];
                const isLight=(rr+cc_)%2===0;
                const isSel=selSq===sq;
                const isLegal=legal.includes(sq);
                const isCapture=isLegal&&!!piece;
                const isLast=(sq===lastFrom||sq===lastTo);

                // Board colors — warm wood tones
                let bg = isLight ? '#f0d9b5' : '#b58863';
                if (isSel) bg = '#f6f669';
                else if (isCapture) bg = '#e74c3c';
                else if (isLegal) bg = isLight ? '#cdd16e' : '#aaa23a';
                else if (isLast) bg = isLight ? '#ced26b80' : '#aaa33a80';

                // Piece rendering — big, bold, high contrast
                let pieceHtml = '';
                if (piece) {
                    const uni = UNI[piece];
                    const isW = clr(piece) === 'w';
                    // White pieces: white fill + thick black outline
                    // Black pieces: dark fill + subtle light outline
                    const shadow = isW
                        ? 'text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 4px rgba(0,0,0,0.5)'
                        : 'text-shadow: -1px -1px 0 rgba(255,255,255,0.3), 1px -1px 0 rgba(255,255,255,0.3), -1px 1px 0 rgba(255,255,255,0.3), 1px 1px 0 rgba(255,255,255,0.3), 0 2px 4px rgba(0,0,0,0.4)';
                    const color = isW ? '#ffffff' : '#1a1a2e';
                    pieceHtml = `<span style="font-family:'Segoe UI Symbol', 'DejaVu Sans', 'Symbola', 'Arial Unicode MS', sans-serif;color:${color};${shadow};line-height:1;pointer-events:none">${uni}</span>`;
                } else if (isLegal) {
                    // Legal move dot
                    pieceHtml = '<div style="width:30%;height:30%;border-radius:50%;background:rgba(0,0,0,0.25)"></div>';
                }

                const hoverBg = piece || isLegal ? 'opacity:0.85' : '';

                html += `<div onclick="window.gameChess.click(${sq})"
                    style="background:${bg};aspect-ratio:1;display:flex;align-items:center;justify-content:center;
                           font-size:clamp(24px,7vw,42px);cursor:pointer;position:relative;transition:opacity 0.15s"
                    onmouseenter="this.style.opacity='0.8'" onmouseleave="this.style.opacity='1'">
                    ${pieceHtml}
                </div>`;
            }
        }
        html += '</div>';
        el.innerHTML = html;
        updateIndicator();
    }

    function updateIndicator() {
        const ind=document.getElementById('chess-turn-indicator');
        if (!ind) return;
        const myTurn=(turn===(isWhite?'w':'b'));
        if (gameOver) return;
        ind.textContent = myTurn?'Giliranmu! ♟️':'Giliran Pasangan...';
        ind.className = myTurn
            ? 'text-xs font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20 animate-pulse'
            : 'text-xs font-semibold text-gray-500 bg-white/5 px-2 py-0.5 rounded-full border border-transparent';
    }

    // ── Click handler ─────────────────────────────────────────
    function click(sq) {
        if (gameOver) return;
        const myColor = isWhite?'w':'b';
        if (turn!==myColor) return;

        if (selSq===null) {
            if (clr(board[sq])!==myColor) return;
            selSq=sq;
            legal=legalMoves(board,sq,castling,myColor);
        } else {
            if (legal.includes(sq)) {
                sendMove(selSq, sq);
            } else if (clr(board[sq])===myColor) {
                selSq=sq;
                legal=legalMoves(board,sq,castling,myColor);
            } else {
                selSq=null; legal=[];
            }
        }
        render();
    }

    // ── Apply move locally ────────────────────────────────────
    function doMove(from, to) {
        const {board:nb, castling:nc} = applyMove(board,from,to,castling);
        board=nb; castling=nc;
        selSq=null; legal=[];
        const nextTurn=opp(turn);
        const oppColor=nextTurn;

        if (!hasAnyLegal(board,oppColor,castling)) {
            gameOver=true;
            if (inCheck(board,oppColor)) {
                const iWon=(turn===(isWhite?'w':'b'));
                if (iWon) { scores.me++; document.getElementById('chess-score-me').textContent=scores.me; }
                else { scores.partner++; document.getElementById('chess-score-partner').textContent=scores.partner; }
                setResult(iWon?'Skak Mat! Kamu Menang 🏆':'Skak Mat! Pasangan Menang 👑');
            } else {
                setResult('Remis (Stalemate) 🤝');
            }
        } else {
            turn=nextTurn;
        }
        render();
    }

    function setResult(msg) {
        const ind=document.getElementById('chess-turn-indicator');
        if (ind) { ind.textContent=msg; ind.className='text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/25 animate-bounce'; }
        if (window.roomWs) window.roomWs.addLog('♟️', msg);
    }

    // ── Network ───────────────────────────────────────────────
    async function sendMove(from, to) {
        doMove(from,to);
        try {
            await fetch(`${BASE_URL}/roomevent/trigger`,{
                method:'POST',
                headers:{'X-Requested-With':'XMLHttpRequest','Content-Type':'application/x-www-form-urlencoded'},
                body:new URLSearchParams({event_type:'game_move',event_data:JSON.stringify({game:'chess',from,to})})
            });
        } catch(e){}
    }

    function applyRemote(data) {
        if (data.game!=='chess') return;
        doMove(data.from, data.to);
    }

    // ── Init ──────────────────────────────────────────────────
    function init(container, playerIsWhite) {
        el=container;
        isWhite=playerIsWhite;
        scores={me:0,partner:0};
        reset();
        render();
    }

    function resetGame() {
        reset();
        render();
    }

    return { init, click, applyRemote, resetGame };
})();
