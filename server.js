const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT || 3000);

// PostgreSQL is optional for startup. If Render injects DATABASE_URL,
// wins/profile are persistent. Without it, the game still works in memory.
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
}) : null;

let dbReady = false;
let dbRetry = null;
const memoryPlayers = new Map();
const rooms = new Map();

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function safeText(value, fallback, max) {
  const s = String(value ?? '').trim().slice(0, max);
  return s || fallback;
}

function memoryPlayer(id) {
  if (!memoryPlayers.has(id)) {
    memoryPlayers.set(id, {
      id,
      nickname: 'Гравець',
      avatar: '',
      wins: 0,
      updated_at: new Date().toISOString()
    });
  }
  return memoryPlayers.get(id);
}

async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT 'Гравець',
      avatar TEXT NOT NULL DEFAULT '',
      wins INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    dbReady = true;
    console.log('PostgreSQL connected');
  } catch (e) {
    dbReady = false;
    console.error('PostgreSQL unavailable:', e.code || e.message);
    if (!dbRetry) dbRetry = setTimeout(() => { dbRetry = null; initDb(); }, 10000);
  }
}

async function getPlayer(id) {
  if (dbReady) {
    try {
      const found = await pool.query('SELECT * FROM players WHERE id=$1', [id]);
      if (found.rows[0]) return found.rows[0];
      return (await pool.query('INSERT INTO players(id) VALUES($1) RETURNING *', [id])).rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB read:', e.code || e.message);
    }
  }
  return memoryPlayer(id);
}

async function saveProfile(id, nickname, avatar) {
  const name = safeText(nickname, 'Гравець', 24);
  const pic = String(avatar || '').slice(0, 1200000);
  if (dbReady) {
    try {
      const r = await pool.query(`INSERT INTO players(id,nickname,avatar)
        VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET nickname=EXCLUDED.nickname, avatar=EXCLUDED.avatar, updated_at=NOW()
        RETURNING *`, [id, name, pic]);
      return r.rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB profile:', e.code || e.message);
    }
  }
  const p = memoryPlayer(id);
  p.nickname = name;
  p.avatar = pic;
  p.updated_at = new Date().toISOString();
  return p;
}

async function addWin(id) {
  if (dbReady) {
    try {
      const r = await pool.query('UPDATE players SET wins=wins+1,updated_at=NOW() WHERE id=$1 RETURNING *', [id]);
      if (r.rows[0]) return r.rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB win:', e.code || e.message);
    }
  }
  const p = memoryPlayer(id);
  p.wins += 1;
  p.updated_at = new Date().toISOString();
  return p;
}

function rank(wins) {
  if (wins >= 100) return '👑 Легенда';
  if (wins >= 80) return '💎 Діамант 1';
  if (wins >= 60) return '💎 Діамант 2';
  if (wins >= 45) return '💎 Діамант 3';
  if (wins >= 35) return '🥇 Золото 1';
  if (wins >= 27) return '🥇 Золото 2';
  if (wins >= 20) return '🥇 Золото 3';
  if (wins >= 15) return '🥈 Срібло 1';
  if (wins >= 10) return '🥈 Срібло 2';
  if (wins >= 6) return '🥈 Срібло 3';
  if (wins >= 4) return '🥉 Бронза 1';
  if (wins >= 2) return '🥉 Бронза 2';
  return '🥉 Бронза 3';
}

async function leaderboard(id) {
  if (dbReady) {
    try {
      const top = (await pool.query('SELECT * FROM players ORDER BY wins DESC, updated_at ASC, id ASC LIMIT 100')).rows;
      const me = await getPlayer(id);
      const pos = Number((await pool.query('SELECT COUNT(*)+1 AS n FROM players WHERE wins>$1', [me.wins])).rows[0].n);
      return { top, me: { ...me, position: pos } };
    } catch (e) {
      dbReady = false;
      console.error('DB leaderboard:', e.code || e.message);
    }
  }
  const all = [...memoryPlayers.values()].sort((a,b) => b.wins-a.wins || String(a.updated_at).localeCompare(String(b.updated_at)) || a.id.localeCompare(b.id));
  const me = memoryPlayer(id);
  return { top: all.slice(0,100), me: { ...me, position: all.filter(p => p.wins > me.wins).length + 1 } };
}

function winResult(board, n) {
  const need = n === 3 ? 3 : n === 4 ? 4 : 5;
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (let r=0;r<n;r++) for (let c=0;c<n;c++) {
    const v = board[r*n+c];
    if (!v) continue;
    for (const [dr,dc] of dirs) {
      let ok = true;
      for (let k=1;k<need;k++) {
        const rr=r+dr*k, cc=c+dc*k;
        if (rr<0 || rr>=n || cc<0 || cc>=n || board[rr*n+cc] !== v) { ok=false; break; }
      }
      if (ok) return v;
    }
  }
  return board.every(Boolean) ? 'draw' : null;
}

function roomList() {
  return [...rooms.values()]
    .filter(r => r.public && r.players.length === 1)
    .map(r => ({ id:r.id, name:r.name, size:r.size, host:r.players[0]?.nickname || 'Гравець' }));
}

function publicState(room) {
  return {
    type:'state', roomId:room.id, name:room.name, size:room.size,
    board:room.board, turn:room.turn, result:room.result,
    players:room.players.map(p => ({
      id:p.id, mark:p.mark, nickname:p.nickname, avatar:p.avatar,
      wins:p.wins, rank:rank(p.wins)
    }))
  };
}

function broadcast(room) {
  const state = publicState(room);
  room.players.forEach(p => send(p.ws, state));
}

const INDEX_HTML = String.raw`<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#070914">
<title>Хрестики Нулики Online</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#070914;--panel:#111528;--panel2:#171c32;--line:#282f4d;--text:#f7f8ff;--muted:#8991ad;--accent:#7c5cff;--accent2:#b34cff;--danger:#ff5577}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{overscroll-behavior:none}
button,input,select{font:inherit}button{border:0;color:white;font-weight:800;cursor:pointer}button:active{transform:scale(.98)}
#loading{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 20%,#1d1740 0,#070914 48%);padding:24px;text-align:center}
.logo{font-size:64px;letter-spacing:-8px;margin-bottom:8px}.load-title{font-size:28px;font-weight:900;margin:0 0 20px}.progress{width:min(340px,85vw);height:10px;background:#20263d;border-radius:99px;overflow:hidden}.progress i{display:block;width:0;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:99px}.percent{margin-top:9px;color:var(--muted);font-weight:800}
#app{width:100%;max-width:520px;margin:auto;padding:calc(14px + env(safe-area-inset-top)) 14px calc(92px + env(safe-area-inset-bottom))}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}.brand{display:flex;align-items:center;gap:10px}.brand-icon{font-size:27px}.brand h1{font-size:19px;margin:0;font-weight:950}.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:1.5px;margin-top:1px}.icon-btn{width:44px;height:44px;border-radius:14px;background:var(--panel2);border:1px solid var(--line);font-size:20px}
.page{display:block}.page[hidden]{display:none}.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 14px}.section-head h2{margin:0;font-size:25px}.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;padding:12px 15px;box-shadow:0 8px 25px #6f4cff2b}.ghost{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:12px 15px}
.card{background:linear-gradient(180deg,#12172b,#0f1323);border:1px solid var(--line);border-radius:20px;padding:15px;box-shadow:0 12px 30px #00000025}.empty{text-align:center;padding:34px 18px;color:var(--muted)}.empty b{display:block;color:white;font-size:17px;margin-bottom:6px}
.server{display:flex;align-items:center;gap:12px;padding:13px;margin:9px 0;background:var(--panel);border:1px solid var(--line);border-radius:17px}.server-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:#1b2140;font-size:23px}.server-info{min-width:0;flex:1}.server-info b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.server-info small{display:block;color:var(--muted);margin-top:4px}.server button{padding:10px 13px;border-radius:12px;background:#252d4d;white-space:nowrap}
.bottom{position:fixed;z-index:20;left:50%;bottom:0;transform:translateX(-50%);width:min(520px,100%);padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:#090c18ee;backdrop-filter:blur(18px);border-top:1px solid #252b45;display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.tab{background:transparent;color:var(--muted);padding:9px 5px;border-radius:13px;font-size:12px}.tab.active{background:#1a2040;color:white}.tab span{display:block;font-size:19px;margin-bottom:2px}
.modal{position:fixed;inset:0;z-index:50;background:#000b;display:flex;align-items:flex-end;justify-content:center}.modal[hidden]{display:none}.sheet{width:min(520px,100%);background:#101426;border:1px solid var(--line);border-radius:25px 25px 0 0;padding:18px 15px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -20px 60px #0008}.sheet h2{margin:0 0 14px}.field{margin:12px 0}.field label{display:block;color:var(--muted);font-size:13px;margin-bottom:6px}.input,.select{width:100%;height:49px;background:#080b16;border:1px solid #303755;border-radius:13px;color:white;padding:0 13px;outline:none}.input:focus,.select:focus{border-color:var(--accent)}.privacy{display:grid;grid-template-columns:1fr 1fr;gap:8px}.privacy label{margin:0;color:white;background:#171c31;border:1px solid var(--line);border-radius:13px;padding:12px;font-size:12px}.privacy input{accent-color:var(--accent)}.sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}.sheet-actions button{height:48px}
.profile-head{display:flex;flex-direction:column;align-items:center;padding:18px}.avatar{width:92px;height:92px;border-radius:50%;display:grid;place-items:center;background:#1d2340;border:3px solid #343d67;overflow:hidden;font-size:40px;margin-bottom:12px}.avatar img{width:100%;height:100%;object-fit:cover}.profile-name{font-size:20px;font-weight:900}.rank-pill{color:#b9c1dd;margin-top:4px}.save{width:100%;margin-top:10px}
.podium{display:grid;grid-template-columns:1fr 1.15fr 1fr;align-items:end;gap:8px;margin-bottom:15px}.pod{background:var(--panel2);border:1px solid var(--line);border-radius:18px;padding:10px;text-align:center}.pod:nth-child(2){padding-top:16px}.pod-avatar{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:#222a49;margin:5px auto 7px;font-size:25px;overflow:hidden}.pod-avatar img{width:100%;height:100%;object-fit:cover}.pod b{font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pod small{color:var(--muted)}
.leader{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:9px;margin:7px 0}.place{width:32px;text-align:center;font-weight:900;color:#aeb6d0}.leader-avatar{width:43px;height:43px;border-radius:50%;display:grid;place-items:center;background:#222a49;overflow:hidden;font-size:21px}.leader-avatar img{width:100%;height:100%;object-fit:cover}.leader-main{min-width:0;flex:1}.leader-main b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.leader-main small{color:var(--muted)}.wins{font-weight:900;font-size:13px}.me-row{border-color:#6e55db;background:#171936}
#game{position:fixed;inset:0;z-index:40;background:var(--bg);overflow:auto;padding:calc(12px + env(safe-area-inset-top)) 12px calc(28px + env(safe-area-inset-bottom))}.game-inner{width:min(520px,100%);margin:auto}.game-head{display:flex;align-items:center;gap:9px;margin-bottom:12px}.game-head .back{width:42px;height:42px;border-radius:13px;background:var(--panel2);border:1px solid var(--line)}.game-title{min-width:0;flex:1}.game-title b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.game-title small{color:var(--muted)}
.players{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:11px}.player{background:var(--panel);border:1px solid var(--line);border-radius:17px;padding:9px;display:flex;align-items:center;gap:8px;min-width:0}.player.active{border-color:#7b62ff;box-shadow:0 0 0 1px #7b62ff33}.player-avatar{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#202746;overflow:hidden;font-size:22px;flex:0 0 auto}.player-avatar img{width:100%;height:100%;object-fit:cover}.player-info{min-width:0}.player-info b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.player-info small{display:block;color:var(--muted);margin-top:2px;font-size:10px}.mark{font-weight:1000;margin-left:auto;font-size:20px}
.status{text-align:center;color:#c4cae0;font-weight:800;min-height:23px;margin:8px 0 10px}.board-wrap{background:#0c1020;border:1px solid var(--line);border-radius:21px;padding:8px;box-shadow:0 15px 40px #0005}.board{display:grid;gap:5px}.cell{aspect-ratio:1;background:#151a2d;border:1px solid #2b3353;border-radius:9px;padding:0;font-size:clamp(28px,10vw,52px);line-height:1}.cell.x{color:#70a7ff;text-shadow:0 0 15px #508eff55}.cell.o{color:#ff72d4;text-shadow:0 0 15px #ff4dc455}.cell:disabled{cursor:default;opacity:1}.game-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.game-actions button{height:48px}.share{margin-top:10px}.share input{margin-top:8px}.notice{font-size:12px;color:var(--muted);text-align:center;margin-top:10px}
@media(min-width:700px){body{background:#05060d}.bottom{bottom:12px;border:1px solid var(--line);border-radius:18px}.modal{align-items:center}.sheet{border-radius:24px}}
</style></head>
<body>
<div id="loading"><div class="logo">❌⭕</div><h1 class="load-title">Хрестики Нулики</h1><div class="progress"><i id="bar"></i></div><div class="percent" id="percent">0%</div></div>
<script>
/* Незалежний екран завантаження: не залежить від WebSocket, localStorage чи іншого коду гри. */
(function(){
  var start=Date.now(), duration=1400, bar=document.getElementById('bar'), percent=document.getElementById('percent'), loading=document.getElementById('loading');
  function tick(){
    if(!loading || !bar || !percent) return;
    var n=Math.min(100, Math.round(((Date.now()-start)/duration)*100));
    bar.style.width=n+'%'; percent.textContent=n+'%';
    if(n>=100){
      loading.style.opacity='0'; loading.style.transition='opacity .2s ease';
      setTimeout(function(){ var app=document.getElementById('app'); if(loading.parentNode) loading.parentNode.removeChild(loading); if(app) app.hidden=false; },220);
    } else { setTimeout(tick,35); }
  }
  setTimeout(tick,20);
})();
</script>
<div id="app" hidden>
  <div class="topbar"><div class="brand"><div class="brand-icon">❌⭕</div><div><h1>Хрестики Нулики</h1><small>ONLINE</small></div></div><button class="icon-btn" id="refresh">↻</button></div>
  <main>
    <section class="page" id="page-servers"><div class="section-head"><h2>Сервери</h2><button class="primary" id="create">＋ Створити</button></div><div id="serverList"></div></section>
    <section class="page" id="page-top" hidden><div class="section-head"><h2>Топ гравців</h2></div><div class="podium" id="podium"></div><div id="leaders"></div></section>
    <section class="page" id="page-profile" hidden><div class="section-head"><h2>Профіль</h2></div><div class="card profile-head"><div class="avatar" id="avatarPreview">🙂</div><div class="profile-name" id="profileName">Гравець</div><div class="rank-pill" id="profileRank">🥉 Бронза 3 • 0 перемог</div></div><div class="card" style="margin-top:10px"><div class="field"><label>Нікнейм</label><input class="input" id="nickname" maxlength="24" placeholder="Твій нік"></div><div class="field"><label>Аватарка</label><input class="input" id="avatarFile" type="file" accept="image/*"></div><button class="primary save" id="saveProfile">Зберегти профіль</button></div></section>
  </main>
  <nav class="bottom"><button class="tab active" data-page="servers"><span>🌐</span>Сервери</button><button class="tab" data-page="top"><span>🏆</span>Топ</button><button class="tab" data-page="profile"><span>👤</span>Профіль</button></nav>
</div>
<div class="modal" id="modal" hidden><div class="sheet"><h2>Створити сервер</h2><div class="field"><label>Назва сервера</label><input class="input" id="roomName" maxlength="30" placeholder="Моя кімната"></div><div class="field"><label>Розмір поля</label><select class="select" id="roomSize"><option value="3">3 × 3</option><option value="4">4 × 4</option><option value="5">5 × 5</option><option value="6">6 × 6</option><option value="7">7 × 7</option><option value="8">8 × 8</option></select></div><div class="field"><label>Тип сервера</label><div class="privacy"><label><input type="radio" name="privacy" value="public" checked> 🌐 Публічний<br><small>Буде видно у списку</small></label><label><input type="radio" name="privacy" value="private"> 🔒 Приватний<br><small>Тільки за посиланням</small></label></div></div><div class="sheet-actions"><button class="ghost" id="cancel">Скасувати</button><button class="primary" id="make">Створити</button></div></div></div>
<div id="game" hidden><div class="game-inner"><div class="game-head"><button class="back" id="leaveTop">←</button><div class="game-title"><b id="gameName">Сервер</b><small id="gameInfo">Очікування гравця</small></div></div><div class="players" id="players"></div><div class="status" id="status">Підключення…</div><div class="board-wrap"><div class="board" id="board"></div></div><div class="game-actions"><button class="primary" id="again">🔄 Ще раз</button><button class="ghost" id="leave">Вийти</button></div><div class="card share" id="share" hidden></div><div class="notice">3×3 — 3 в ряд • 4×4 — 4 в ряд • 5×5+ — 5 в ряд</div></div></div>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let id = localStorage.getItem('ttt_id');
  if (!id) {
    try { id = globalThis.crypto?.randomUUID?.() || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2)); }
    catch { id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
    localStorage.setItem('ttt_id', id);
  }
  let profile = {}; try { profile = JSON.parse(localStorage.getItem('ttt_profile') || '{}'); } catch {}
  let ws = null, reconnectTimer = null, joinedRoom = false, currentState = null;

  function send(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({...data, id})); }
  function connect() {
    clearTimeout(reconnectTimer);
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host);
    } catch (e) {
      ws = null;
      reconnectTimer = setTimeout(connect, 2000);
      return;
    }
    ws.onopen = () => { send({type:'profile', nickname:profile.nickname || 'Гравець', avatar:profile.avatar || ''}); send({type:'servers'}); send({type:'leaderboard'}); const room = new URLSearchParams(location.search).get('room'); if (room) setTimeout(() => send({type:'join', room}), 250); };
    ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { reconnectTimer = setTimeout(connect, 1500); };
    ws.onerror = () => {};
  }
  function handle(m) {
    if (m.type === 'profile') { profile = m.player; localStorage.setItem('ttt_profile', JSON.stringify(profile)); renderProfile(); }
    if (m.type === 'servers') renderServers(m.servers || []);
    if (m.type === 'leaderboard') renderLeaderboard(m);
    if (m.type === 'joined') { joinedRoom = true; showGame(); if (m.private && m.room) showShare(m.room); }
    if (m.type === 'state') { currentState = m; renderGame(m); }
    if (m.type === 'roomClosed') { joinedRoom=false; hideGame(); alert('Сервер закрит.'); send({type:'servers'}); history.replaceState({},'',location.pathname); }
    if (m.type === 'error') alert(m.message || 'Помилка');
  }
  function switchPage(name) { document.querySelectorAll('.page').forEach(x => x.hidden=true); $('page-'+name).hidden=false; document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.page===name)); if(name==='servers') send({type:'servers'}); if(name==='top') send({type:'leaderboard'}); }
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));
  function renderServers(list) {
    $('serverList').innerHTML = list.length ? list.map(s => \`<div class="server"><div class="server-icon">🎮</div><div class="server-info"><b>\${esc(s.name)}</b><small>👤 \${esc(s.host)} • \${s.size}×\${s.size}</small></div><button onclick="window.joinRoom('\${esc(s.id)}')">Грати</button></div>\`).join('') : \`<div class="card empty"><div style="font-size:35px">🕹️</div><b>Серверів поки немає</b><span>Створи свій і чекай суперника.</span></div>\`;
  }
  window.joinRoom = room => send({type:'join',room});
  function renderProfile() { $('nickname').value=profile.nickname || 'Гравець'; $('profileName').textContent=profile.nickname || 'Гравець'; $('profileRank').textContent=(profile.rank || '🥉 Бронза 3')+' • '+(profile.wins || 0)+' перемог'; $('avatarPreview').innerHTML=profile.avatar ? \`<img src="\${profile.avatar}" alt="">\` : '🙂'; }
  function avatar(p, cls) { return p.avatar ? \`<div class="\${cls}"><img src="\${p.avatar}" alt=""></div>\` : \`<div class="\${cls}">🙂</div>\`; }
  function renderLeaderboard(m) {
    const top=m.top||[]; $('podium').innerHTML=top.slice(0,3).map((p,i)=>\`<div class="pod"><div>\${['🥈','🥇','🥉'][i]}</div>\${avatar(p,'pod-avatar')}<b>\${esc(p.nickname)}</b><small>\${p.wins} 🏆</small></div>\`).join('');
    if(top.length && top.length<3) $('podium').style.gridTemplateColumns=\`repeat(\${top.length},1fr)\`; else $('podium').style.gridTemplateColumns='1fr 1.15fr 1fr';
    $('leaders').innerHTML=top.length ? top.map(p=>\`<div class="leader \${p.id===id?'me-row':''}"><div class="place">#\${p.position}</div>\${avatar(p,'leader-avatar')}<div class="leader-main"><b>\${esc(p.nickname)}\${p.id===id?' • Ти':''}</b><small>\${esc(p.rank)}</small></div><div class="wins">\${p.wins} 🏆</div></div>\`).join('') : \`<div class="card empty"><b>Поки що ніхто не зіграв</b><span>Твоя перемога може бути першою!</span></div>\`;
    if(m.me && !top.some(p=>p.id===m.me.id)) $('leaders').innerHTML += \`<div class="leader me-row"><div class="place">#\${m.me.position}</div>\${avatar(m.me,'leader-avatar')}<div class="leader-main"><b>\${esc(m.me.nickname)} • Ти</b><small>\${esc(m.me.rank)}</small></div><div class="wins">\${m.me.wins} 🏆</div></div>\`;
  }
  function showGame() { $('game').hidden=false; document.body.style.overflow='hidden'; window.scrollTo(0,0); }
  function hideGame() { $('game').hidden=true; document.body.style.overflow=''; $('share').hidden=true; }
  function renderGame(m) {
    $('gameName').textContent=m.name || 'Сервер'; $('gameInfo').textContent=\`\${m.size}×\${m.size} • \${m.players.length}/2 гравців\`;
    const mine=m.players.find(p=>p.id===id), other=m.players.find(p=>p.id!==id);
    const playerCard=p=>p ? \`<div class="player \${m.turn===p.mark && !m.result?'active':''}">\${avatar(p,'player-avatar')}<div class="player-info"><b>\${esc(p.nickname)}\${p.id===id?' (ти)':''}</b><small>\${esc(p.rank)}</small></div><div class="mark">\${p.mark==='X'?'❌':'⭕'}</div></div>\` : \`<div class="player"><div class="player-avatar">⌛</div><div class="player-info"><b>Очікуємо</b><small>Другий гравець</small></div></div>\`;
    $('players').innerHTML=playerCard(mine)+playerCard(other);
    $('status').textContent=m.result ? (m.result==='draw'?'🤝 Нічия!':\`🏆 Переміг \${esc(m.players.find(p=>p.mark===m.result)?.nickname || '')}\`) : (m.players.length<2?'⏳ Чекаємо суперника…':(m.turn===mine?.mark?'🔥 Твій хід':'⏳ Хід суперника'));
    $('board').style.gridTemplateColumns=\`repeat(\${m.size},1fr)\`;
    $('board').innerHTML=m.board.map((v,i)=>\`<button class="cell \${v==='X'?'x':v==='O'?'o':''}" \${v||m.result||m.players.length<2||m.turn!==mine?.mark?'disabled':''} onclick="window.makeMove(\${i})">\${v==='X'?'❌':v==='O'?'⭕':''}</button>\`).join('');
    $('again').disabled=!m.result || m.players.length<2; $('again').style.opacity=$('again').disabled?.55:1;
  }
  window.tttSend = send;
  window.makeMove=i=>send({type:'move',index:i});
  function showShare(room) { const url=location.origin+'/?room='+encodeURIComponent(room); $('share').hidden=false; $('share').innerHTML=\`<b>🔒 Приватна кімната</b><div style="color:#8991ad;font-size:12px;margin-top:4px">Надішли другу це посилання:</div><input class="input" id="shareInput" value="\${esc(url)}" readonly><button class="primary" style="width:100%;margin-top:8px" onclick="window.copyShare()">📋 Скопіювати</button>\`; }
  window.copyShare=()=>{ const v=$('shareInput')?.value||''; if(navigator.clipboard) navigator.clipboard.writeText(v).then(()=>alert('Посилання скопійовано!')); else { $('shareInput').select(); document.execCommand('copy'); alert('Посилання скопійовано!'); } };
  $('create').onclick=()=>{$('modal').hidden=false}; $('cancel').onclick=()=>{$('modal').hidden=true}; $('modal').addEventListener('click',e=>{if(e.target.id==='modal')$('modal').hidden=true});
  $('make').onclick=()=>{ const name=$('roomName').value.trim()||'Моя кімната'; const size=Number($('roomSize').value)||3; const pub=document.querySelector('input[name="privacy"]:checked')?.value==='public'; send({type:'create',name,size,public:pub}); $('modal').hidden=true; };
  $('refresh').onclick=()=>{send({type:'servers'});send({type:'leaderboard'});};
  function leaveRoom(){send({type:'leave'});joinedRoom=false;hideGame();history.replaceState({},'',location.pathname);setTimeout(()=>send({type:'servers'}),100);}
  $('leave').onclick=leaveRoom; $('leaveTop').onclick=leaveRoom; $('again').onclick=()=>send({type:'restart'});
  $('saveProfile').onclick=()=>{send({type:'profile',nickname:$('nickname').value,avatar:profile.avatar||''});alert('Профіль збережено!');};
  $('avatarFile').onchange=e=>{ const f=e.target.files?.[0]; if(!f)return; if(f.size>3*1024*1024){alert('Фото завелике. Максимум 3 МБ.');e.target.value='';return;} const r=new FileReader(); r.onload=()=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas'),s=256;c.width=c.height=s;const ctx=c.getContext('2d'),k=Math.min(s/img.width,s/img.height),w=img.width*k,h=img.height*k;ctx.drawImage(img,(s-w)/2,(s-h)/2,w,h);profile.avatar=c.toDataURL('image/jpeg',.82);renderProfile();};img.src=r.result;};r.readAsDataURL(f);};
  // Екран завантаження працює окремо вище. Підключення запускається після ініціалізації гри.
  connect();
  renderProfile();
  window.__TTT_UI_WIRED = true;
})();
</script>
<script>
/* Надійний резервний шар кнопок. Працює навіть якщо якийсь необов'язковий JS з основного клієнта не завантажився. */
(function(){
  function $(id){ return document.getElementById(id); }
  function getId(){
    var id=localStorage.getItem('ttt_id');
    if(!id){ id='p_'+Date.now()+'_'+Math.random().toString(36).slice(2); localStorage.setItem('ttt_id',id); }
    return id;
  }
  var pid=getId(), socket=null, timer=null;
  function send(data){
    if(window.tttSend){ window.tttSend(data); return; }
    if(!socket || socket.readyState!==1) return;
    data.id=pid; socket.send(JSON.stringify(data));
  }
  function fallbackConnect(){
    if(window.tttSend || socket) return;
    try{ socket=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host); }catch(e){ return; }
    socket.onopen=function(){
      var p={}; try{p=JSON.parse(localStorage.getItem('ttt_profile')||'{}')}catch(e){}
      send({type:'profile',nickname:p.nickname||'Гравець',avatar:p.avatar||''});
      send({type:'servers'}); send({type:'leaderboard'});
    };
    socket.onmessage=function(ev){
      var m; try{m=JSON.parse(ev.data)}catch(e){return;}
      if(m.type==='servers') renderServers(m.servers||[]);
      if(m.type==='leaderboard') renderLeaders(m);
      if(m.type==='profile'){ localStorage.setItem('ttt_profile',JSON.stringify(m.player||{})); renderProfileSafe(m.player||{}); }
      if(m.type==='joined'){ if($('game')) $('game').hidden=false; }
    };
    socket.onclose=function(){ socket=null; clearTimeout(timer); timer=setTimeout(fallbackConnect,1500); };
  }
  function renderProfileSafe(p){
    if($('profileName')) $('profileName').textContent=p.nickname||'Гравець';
    if($('profileRank')) $('profileRank').textContent=(p.rank||'🥉 Бронза 3')+' • '+(p.wins||0)+' перемог';
    if($('nickname')) $('nickname').value=p.nickname||'Гравець';
  }
  function renderServers(list){
    if(!$('serverList')) return;
    $('serverList').innerHTML=list.length?list.map(function(s){return '<div class="server"><div class="server-icon">🎮</div><div class="server-info"><b>'+String(s.name).replace(/[&<>]/g,'')+'</b><small>👤 '+String(s.host).replace(/[&<>]/g,'')+' • '+s.size+'×'+s.size+'</small></div><button data-join="'+String(s.id).replace(/[^A-Z0-9]/gi,'')+'">Грати</button></div>';}).join(''):'<div class="card empty"><div style="font-size:35px">🕹️</div><b>Серверів поки немає</b><span>Створи свій і чекай суперника.</span></div>' ;
  }
  function renderLeaders(m){
    var top=m.top||[]; if(!$('leaders')) return;
    $('leaders').innerHTML=top.length?top.map(function(p){return '<div class="leader"><div class="place">#'+p.position+'</div><div class="leader-avatar">🙂</div><div class="leader-main"><b>'+String(p.nickname||'Гравець').replace(/[&<>]/g,'')+'</b><small>'+String(p.rank||'')+'</small></div><div class="wins">'+(p.wins||0)+' 🏆</div></div>';}).join(''):'<div class="card empty"><b>Поки що ніхто не зіграв</b></div>';
  }
  function page(name){
    document.querySelectorAll('.page').forEach(function(x){x.hidden=true;});
    var el=$('page-'+name); if(el) el.hidden=false;
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-page')===name);});
    if(name==='servers') send({type:'servers'});
    if(name==='top') send({type:'leaderboard'});
  }
  function wire(){
    document.addEventListener('click',function(e){
      var tab=e.target.closest ? e.target.closest('.tab') : null;
      if(tab){e.preventDefault();page(tab.getAttribute('data-page'));return;}
      var join=e.target.closest ? e.target.closest('[data-join]') : null;
      if(join){e.preventDefault();send({type:'join',room:join.getAttribute('data-join')});if($('game'))$('game').hidden=false;return;}
    },true);
    if($('create')) $('create').onclick=function(e){e.preventDefault();$('modal').hidden=false;};
    if($('cancel')) $('cancel').onclick=function(e){e.preventDefault();$('modal').hidden=true;};
    if($('modal')) $('modal').onclick=function(e){if(e.target===$('modal'))$('modal').hidden=true;};
    if($('refresh')) $('refresh').onclick=function(e){e.preventDefault();send({type:'servers'});send({type:'leaderboard'});};
    if($('make')) $('make').onclick=function(e){
      e.preventDefault(); var name=($('roomName').value||'').trim()||'Моя кімната'; var size=Number($('roomSize').value)||3; var radio=document.querySelector('input[name="privacy"]:checked'); var pub=radio ? radio.value==='public' : true;
      send({type:'create',name:name,size:size,public:pub}); $('modal').hidden=true;
    };
    if($('saveProfile')) $('saveProfile').onclick=function(e){
      e.preventDefault(); var old={}; try{old=JSON.parse(localStorage.getItem('ttt_profile')||'{}')}catch(x){}
      old.nickname=($('nickname').value||'Гравець').trim()||'Гравець'; localStorage.setItem('ttt_profile',JSON.stringify(old)); send({type:'profile',nickname:old.nickname,avatar:old.avatar||''}); alert('Профіль збережено!');
    };
    if($('leave')) $('leave').onclick=function(e){e.preventDefault();send({type:'leave'});if($('game'))$('game').hidden=true;};
    if($('leaveTop')) $('leaveTop').onclick=function(e){e.preventDefault();send({type:'leave'});if($('game'))$('game').hidden=true;};
    if($('again')) $('again').onclick=function(e){e.preventDefault();send({type:'restart'});};
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire); else wire();
  setTimeout(fallbackConnect,250);
})();
</script></body></html>`;

app.get('/healthz', (_req,res) => res.status(200).json({ok:true,database:dbReady?'connected':(pool?'connecting':'memory')}));
app.get('/api/status', (_req,res) => res.json({ok:true,database:dbReady}));
app.get('/', (_req,res) => res.type('html').send(INDEX_HTML));

wss.on('connection', ws => {
  ws.on('message', async raw => {
    let m; try { m=JSON.parse(raw.toString()); } catch { return; }
    const id=String(m.id||'').slice(0,100); if(!id)return;
    try {
      if(m.type==='profile') { const p=await saveProfile(id,m.nickname,m.avatar); return send(ws,{type:'profile',player:{...p,rank:rank(p.wins)}}); }
      if(m.type==='servers') return send(ws,{type:'servers',servers:roomList()});
      if(m.type==='leaderboard') { const d=await leaderboard(id); return send(ws,{type:'leaderboard',top:d.top.map((p,i)=>({...p,position:i+1,rank:rank(p.wins)})),me:{...d.me,rank:rank(d.me.wins)}}); }
      if(m.type==='create') {
        if(ws.room) return send(ws,{type:'error',message:'Спочатку вийди з поточної кімнати.'});
        const p=await getPlayer(id), size=Math.max(3,Math.min(8,Number(m.size)||3));
        const roomId=Math.random().toString(36).slice(2,8).toUpperCase();
        const room={id:roomId,name:safeText(m.name,'Моя кімната',30),size,public:Boolean(m.public),board:Array(size*size).fill(''),turn:'X',result:null,players:[]};
        room.players.push({...p,ws,mark:'X'}); rooms.set(roomId,room); ws.room=roomId; ws.playerId=id; ws.mark='X';
        send(ws,{type:'joined',room:roomId,private:!room.public}); broadcast(room); return;
      }
      if(m.type==='join') {
        const rid=String(m.room||'').toUpperCase(); const room=rooms.get(rid);
        if(!room)return send(ws,{type:'error',message:'Сервер не знайдено або він уже закритий.'});
        if(room.players.length>=2)return send(ws,{type:'error',message:'Сервер уже заповнений.'});
        if(ws.room) return send(ws,{type:'error',message:'Ти вже в іншій кімнаті.'});
        const p=await getPlayer(id); room.players.push({...p,ws,mark:'O'}); ws.room=room.id; ws.playerId=id; ws.mark='O';
        send(ws,{type:'joined',room:room.id,private:!room.public}); broadcast(room); return;
      }
      const room=rooms.get(ws.room); if(!room)return;
      if(m.type==='move') {
        const i=Number(m.index);
        if(room.result || room.players.length!==2 || ws.mark!==room.turn || !Number.isInteger(i) || i<0 || i>=room.board.length || room.board[i])return;
        room.board[i]=ws.mark; room.result=winResult(room.board,room.size);
        if(room.result && room.result!=='draw') { const winner=room.players.find(p=>p.mark===room.result); const updated=await addWin(winner.id); winner.wins=updated.wins; winner.rank=rank(updated.wins); }
        else if(!room.result) room.turn=room.turn==='X'?'O':'X';
        broadcast(room); return;
      }
      if(m.type==='restart') { if(room.players.length!==2)return; room.board.fill('');room.turn='X';room.result=null;broadcast(room);return; }
      if(m.type==='leave') { rooms.delete(room.id); room.players.forEach(p=>{if(p.ws!==ws){p.ws.room=null;send(p.ws,{type:'roomClosed'});}}); ws.room=null; return; }
    } catch(e) { console.error('WS error:',e); send(ws,{type:'error',message:'Серверна помилка. Спробуй ще раз.'}); }
  });
  ws.on('close',()=>{ const room=rooms.get(ws.room); if(!room)return; rooms.delete(room.id); room.players.forEach(p=>{if(p.ws!==ws){p.ws.room=null;send(p.ws,{type:'roomClosed'});}}); });
});

initDb();
server.listen(PORT,'0.0.0.0',()=>console.log(`Tic-Tac-Toe server listening on ${PORT}`));
