const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT || 3000);

// PostgreSQL is preferred. If Render hasn't injected DATABASE_URL yet,
// the game still starts and uses a temporary in-memory store instead of crashing.
const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
}) : null;

let dbReady = false;
let dbRetryTimer = null;
const memoryPlayers = new Map();
const rooms = new Map();

const INDEX_HTML = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070812"><title>Хрестики Нулики Online</title><style>${String.raw`*{box-sizing:border-box}body{margin:0;background:#070812;color:#fff;font-family:system-ui,sans-serif}button,input,select{font:inherit}button{border:0;border-radius:12px;padding:12px 16px;background:linear-gradient(135deg,#7354ff,#c04dff);color:#fff;font-weight:800;cursor:pointer}#load{position:fixed;inset:0;display:grid;place-content:center;text-align:center;background:#070812;font-size:55px;z-index:99}.bar{width:300px;height:9px;background:#20243a;border-radius:9px}.bar i{display:block;width:0;height:100%;background:#a657ff;border-radius:9px}.bar~b{font-size:14px}#app{max-width:720px;margin:auto;padding:18px}header{display:flex;gap:12px;align-items:center}header>b{font-size:30px}small{color:#8f93aa}nav{display:flex;gap:8px;margin:18px 0}nav button{flex:1;background:#171a2d}.head{display:flex;justify-content:space-between;align-items:center;gap:10px}.card,.server{background:#111426;border:1px solid #292d48;border-radius:18px;padding:18px}.server{display:flex;justify-content:space-between;align-items:center;margin:8px 0;gap:10px}.server small{display:block}.card input,.card select,#rname,#size{width:100%;height:48px;background:#080a13;color:#fff;border:1px solid #30344d;border-radius:12px;padding:0 12px;margin:8px 0}.card #av{width:90px;height:90px;border-radius:50%;overflow:hidden;background:#22263b;margin:0 auto 12px;display:grid;place-items:center;font-size:40px}.card #av img{width:100%;height:100%;object-fit:cover}.card button{width:100%;margin-top:8px}#game{position:fixed;inset:0;background:#080a14;overflow:auto;padding:18px;z-index:3}.players{display:flex;gap:8px}.pl{flex:1;text-align:center;background:#15192b;border-radius:14px;padding:10px}.pl img{width:48px;height:48px;border-radius:50%;object-fit:cover}.pl .emo{font-size:35px}.pl b,.pl small{display:block}.grid{display:grid;gap:6px;max-width:650px;margin:auto}.cell{padding:0;aspect-ratio:1;background:#11162a;border:1px solid #303550;font-size:clamp(25px,8vw,55px)}.x{color:#65aaff}.o{color:#ff70d8}#again,#leave{display:block;width:min(650px,100%);margin:10px auto}#leave{background:#24283e}#pod{display:flex;gap:8px;align-items:end}.pod{flex:1;text-align:center;background:#171a2c;border-radius:14px;padding:10px}.pod img,.pod .emo{width:55px;height:55px;border-radius:50%;object-fit:cover;margin:auto;display:grid;place-items:center;font-size:28px}.leader{display:flex;align-items:center;gap:10px;background:#171a2c;border-radius:12px;padding:9px;margin:6px 0}.leader img,.leader .emo{width:42px;height:42px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-size:23px}.grow{flex:1}.wins{color:#aaa}#modal{position:fixed;inset:0;background:#0009;display:grid;place-items:center;z-index:9}#modal .card{width:min(430px,92%)}label{display:block;margin:8px 0}#share{margin:12px auto;max-width:650px}`}</style></head><body>${String.raw`<div id="load"><div>❌ ⭕</div><h1>Хрестики Нулики</h1><div class="bar"><i id="p"></i></div><b id="pct">0%</b></div>
<div id="app" hidden><header><b>❌⭕</b><h1>Хрестики Нулики <small>ONLINE</small></h1></header>
<nav><button data-t="servers">🌐 Сервери</button><button data-t="top">🏆 Топ гравців</button><button data-t="profile">👤 Профіль</button></nav>
<section id="servers"><div class="head"><h2>Сервери</h2><button id="create">＋ Створити</button></div><div id="list"></div></section>
<section id="top" hidden><h2>🏆 ТОП 100</h2><div id="pod"></div><div id="leaders"></div></section>
<section id="profile" hidden><h2>👤 Профіль</h2><div class="card"><div id="av">🙂</div><input id="nick" placeholder="Твій нік" maxlength="24"><label>📷 Аватарка <input id="file" type="file" accept="image/*"></label><button id="save">Зберегти</button><p id="rank"></p></div></section>
<section id="game" hidden><div id="players"></div><p id="status"></p><div id="board"></div><button id="again">🔄 Продовжити матч</button><button id="leave">← Вийти з сервера</button><div id="share" class="card" hidden></div></section>
<div id="modal" hidden><div class="card"><h2>Створити сервер</h2><input id="rname" placeholder="Назва"><select id="size"><option value="3">3×3</option><option value="4">4×4</option><option value="5">5×5</option><option value="6">6×6</option><option value="7">7×7</option><option value="8">8×8</option></select><p><label><input type="radio" name="privacy" value="1" checked> 🌐 Публічна</label><label><input type="radio" name="privacy" value="0"> 🔒 Приватна (за посиланням)</label></p><button id="make">Створити</button><button id="cancel">Скасувати</button></div></div></div>`}</body><script>${String.raw`let ws,me=localStorage.id||crypto.randomUUID(),prof=JSON.parse(localStorage.profile||'{}');localStorage.id=me;const $=x=>document.querySelector(x);
function conn(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.onopen=()=>{send({type:'profile',nickname:prof.nickname||'Гравець',avatar:prof.avatar||''});send({type:'servers'});let room=new URLSearchParams(location.search).get('room');if(room)setTimeout(()=>send({type:'join',room}),300)};ws.onmessage=e=>h(JSON.parse(e.data));ws.onclose=()=>setTimeout(conn,1500)}
function send(x){if(ws?.readyState===1)ws.send(JSON.stringify({...x,id:me}))}
function h(m){if(m.type==='profile'){prof=m.player;localStorage.profile=JSON.stringify(prof);showProf()}if(m.type==='servers')drawServers(m.servers);if(m.type==='leaderboard')drawTop(m);if(m.type==='joined'){$('#game').hidden=false; if(m.shareUrl)showShare(m.shareUrl);window.scrollTo(0,0)}if(m.type==='roomClosed'){alert('Сервер закрит.');$('#game').hidden=true;send({type:'servers'})}if(m.type==='state')drawGame(m);if(m.type==='error')alert(m.message)}
function showProf(){$('#nick').value=prof.nickname||'Гравець';$('#av').innerHTML=prof.avatar?\`<img src="\${prof.avatar}">\`:'🙂';$('#rank').textContent=\`\${prof.rank||'🥉 Бронза 3'} • \${prof.wins||0} перемог\`}
function drawServers(a){$('#list').innerHTML=a.length?a.map(s=>\`<div class="server"><div><b>\${esc(s.name)}</b><small>\${s.size}×\${s.size} • \${esc(s.host)}</small></div><button onclick="join('\${s.id}')">Грати</button></div>\`).join(''):'<p style="text-align:center;color:#888">Публічних серверів немає.</p>'}
function join(id){send({type:'join',room:id})}
function showShare(url){if(!url)return;$('#share').hidden=false;$('#share').innerHTML=\`<b>🔒 Приватна кімната</b><p>Надішли це посилання другу:</p><input value="\${esc(url)}" readonly onclick="this.select()"><button onclick="navigator.clipboard?.writeText('\${esc(url)}').then(()=>alert('Посилання скопійовано!'))">📋 Копіювати</button>\`}
function drawGame(m){let mep=m.players.find(p=>p.id===me),op=m.players.find(p=>p.id!==me),person=p=>p?\`<div class="pl">\${p.avatar?\`<img src="\${p.avatar}">\`:'<div class="emo">🙂</div>'}<b>\${esc(p.nickname)}</b><small>\${p.rank}</small><small>\${p.mark}</small></div>\`:'<div class="pl">⏳ Очікуємо</div>';$('#players').className='players';$('#players').innerHTML=person(mep)+person(op);$('#board').className='grid';$('#board').style.gridTemplateColumns=\`repeat(\${m.size},1fr)\`;$('#board').innerHTML=m.board.map((v,i)=>\`<button class="cell \${v?.toLowerCase()||''}" onclick="move(\${i})">\${v}</button>\`).join('');$('#status').textContent=m.result?(m.result==='draw'?'🤝 Нічия!':\`🏆 Переміг \${m.result}\`):(m.players.length<2?'⏳ Очікуємо гравця':m.turn===mep?.mark?'🔥 Твій хід':'⏳ Хід суперника')}
function move(i){send({type:'move',index:i})}
function drawTop(m){$('#pod').innerHTML=m.top.slice(0,3).map((p,i)=>\`<div class="pod">\${['🥇','🥈','🥉'][i]}<br>\${p.avatar?\`<img src="\${p.avatar}">\`:'<div class="emo">🙂</div>'}<b>\${esc(p.nickname)}</b><small>\${p.wins} 🏆</small></div>\`).join('');$('#leaders').innerHTML=m.top.map(p=>\`<div class="leader"><b>#\${p.position}</b>\${p.avatar?\`<img src="\${p.avatar}">\`:'<div class="emo">🙂</div>'}<div class="grow"><b>\${esc(p.nickname)}</b><small>\${p.rank}</small></div><span>\${p.wins} 🏆</span></div>\`).join('')+\`<hr><div class="leader"><b>#\${m.me.position}</b><div class="grow"><b>Ти • \${esc(m.me.nickname)}</b><small>\${m.me.rank}</small></div><span>\${m.me.wins} 🏆</span></div>\`}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('section').forEach(x=>x.hidden=true);$('#'+b.dataset.t).hidden=false;if(b.dataset.t==='servers')send({type:'servers'});if(b.dataset.t==='top')send({type:'leaderboard'})});
$('#create').onclick=()=>$('#modal').hidden=false;$('#cancel').onclick=()=>$('#modal').hidden=true;$('#make').onclick=()=>{send({type:'create',name:$('#rname').value,size:+$('#size').value,public:$('input[name=privacy]:checked').value==='1'});$('#modal').hidden=true};$('#again').onclick=()=>send({type:'restart'});$('#leave').onclick=()=>{send({type:'leave'});$('#game').hidden=true;$('#share').hidden=true;send({type:'servers'})};$('#save').onclick=()=>send({type:'profile',nickname:$('#nick').value,avatar:prof.avatar});
$('#file').onchange=e=>{let f=e.target.files[0];if(!f)return;if(f.size>800000){alert('Аватарка завелика. Максимум 800 КБ.');return}let r=new FileReader;r.onload=()=>{let img=new Image;img.onload=()=>{let c=document.createElement('canvas'),s=256;c.width=c.height=s;let x=c.getContext('2d'),k=Math.min(s/img.width,s/img.height),w=img.width*k,h=img.height*k;x.drawImage(img,(s-w)/2,(s-h)/2,w,h);prof.avatar=c.toDataURL('image/jpeg',.82);showProf()};img.src=r.result};r.readAsDataURL(f)};
conn();let n=0,t=setInterval(()=>{n+=2;$('#p').style.width=n+'%';$('#pct').textContent=n+'%';if(n>=100){clearInterval(t);$('#load').remove();$('#app').hidden=false;showProf()}},25);`}</script></html>`;

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function memoryPlayer(id) {
  if (!memoryPlayers.has(id)) memoryPlayers.set(id, {
    id, nickname: 'Гравець', avatar: '', wins: 0, updated_at: new Date().toISOString()
  });
  return memoryPlayers.get(id);
}

async function initDatabase() {
  if (!pool) return false;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players(
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT 'Гравець',
      avatar TEXT,
      wins INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    dbReady = true;
    console.log('PostgreSQL: connected');
    if (dbRetryTimer) clearTimeout(dbRetryTimer);
    return true;
  } catch (err) {
    dbReady = false;
    console.error('PostgreSQL not ready:', err.code || err.message);
    if (!dbRetryTimer) dbRetryTimer = setTimeout(() => {
      dbRetryTimer = null;
      initDatabase();
    }, 5000);
    return false;
  }
}

async function getPlayer(id) {
  if (dbReady) {
    try {
      const r = await pool.query('SELECT * FROM players WHERE id=$1', [id]);
      if (r.rows[0]) return r.rows[0];
      return (await pool.query('INSERT INTO players(id) VALUES($1) RETURNING *', [id])).rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB read failed, using memory fallback:', e.code || e.message);
    }
  }
  return memoryPlayer(id);
}

async function updateProfile(id, nickname, avatar) {
  const cleanName = String(nickname || 'Гравець').trim().slice(0, 24) || 'Гравець';
  if (dbReady) {
    try {
      const r = await pool.query(
        'INSERT INTO players(id,nickname,avatar) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET nickname=$2,avatar=$3,updated_at=NOW() RETURNING *',
        [id, cleanName, avatar || '']
      );
      return r.rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB profile write failed:', e.code || e.message);
    }
  }
  const p = memoryPlayer(id);
  p.nickname = cleanName;
  if (avatar !== undefined) p.avatar = avatar || '';
  p.updated_at = new Date().toISOString();
  return p;
}

async function addWin(id) {
  if (dbReady) {
    try {
      return (await pool.query('UPDATE players SET wins=wins+1,updated_at=NOW() WHERE id=$1 RETURNING *', [id])).rows[0];
    } catch (e) {
      dbReady = false;
      console.error('DB win write failed:', e.code || e.message);
    }
  }
  const p = memoryPlayer(id);
  p.wins += 1;
  p.updated_at = new Date().toISOString();
  return p;
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
      console.error('DB leaderboard read failed:', e.code || e.message);
    }
  }
  const all = [...memoryPlayers.values()].sort((a,b) => b.wins-a.wins || String(a.updated_at).localeCompare(String(b.updated_at)));
  const me = memoryPlayer(id);
  const position = all.filter(p => p.wins > me.wins).length + 1;
  return { top: all.slice(0,100), me: { ...me, position } };
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

function winResult(board, n) {
  const need = n === 3 ? 3 : n === 4 ? 4 : 5;
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (let r=0;r<n;r++) for (let c=0;c<n;c++) {
    const v=board[r*n+c]; if (!v) continue;
    for (const [dr,dc] of dirs) {
      let ok=true;
      for (let k=1;k<need;k++) {
        const rr=r+dr*k, cc=c+dc*k;
        if (rr<0 || rr>=n || cc<0 || cc>=n || board[rr*n+cc]!==v) { ok=false; break; }
      }
      if (ok) return v;
    }
  }
  return board.every(Boolean) ? 'draw' : null;
}

function publicState(room) {
  return {
    type:'state', name:room.name, size:room.size, board:room.board,
    turn:room.turn, result:room.result,
    players:room.players.map(p => ({ id:p.id, mark:p.mark, nickname:p.nickname, avatar:p.avatar, wins:p.wins, rank:rank(p.wins) }))
  };
}
function broadcast(room) { const state=publicState(room); room.players.forEach(p=>send(p.ws,state)); }
function roomList() { return [...rooms.values()].filter(r=>r.public && r.players.length<2).map(r=>({id:r.id,name:r.name,size:r.size,host:r.players[0]?.nickname||'Гравець'})); }

app.get('/healthz', (_req,res) => res.status(200).json({ok:true,database:dbReady?'connected':(hasDatabase?'connecting':'not-configured')}));
app.get('/api/status', (_req,res) => res.json({ok:true,database:dbReady}));
app.get('/', (_req,res) => res.type('html').send(INDEX_HTML));

wss.on('connection', ws => {
  ws.on('message', async raw => {
    let m; try { m=JSON.parse(raw); } catch { return; }
    const id=String(m.id||'').slice(0,100); if(!id) return;

    try {
      if (m.type==='profile') {
        const p=await updateProfile(id,m.nickname,m.avatar);
        return send(ws,{type:'profile',player:{...p,rank:rank(p.wins)}});
      }
      if (m.type==='leaderboard') {
        const data=await leaderboard(id);
        return send(ws,{type:'leaderboard',top:data.top.map((p,i)=>({...p,position:i+1,rank:rank(p.wins)})),me:{...data.me,rank:rank(data.me.wins)}});
      }
      if (m.type==='servers') return send(ws,{type:'servers',servers:roomList()});

      if (m.type==='create') {
        const p=await getPlayer(id);
        const roomId=Math.random().toString(36).slice(2,8).toUpperCase();
        const size=Math.max(3,Math.min(8,Number(m.size)||3));
        const room={id:roomId,name:String(m.name||'Мій сервер').slice(0,30),size,public:!!m.public,board:Array(size*size).fill(''),turn:'X',result:null,players:[]};
        rooms.set(roomId,room);
        room.players.push({...p,ws,mark:'X'});
        ws.room=roomId; ws.mark='X'; ws.playerId=id;
        send(ws,{type:'joined',room:roomId,private:!room.public,shareUrl:`${process.env.RENDER_EXTERNAL_URL||''}/?room=${roomId}`});
        return broadcast(room);
      }

      if (m.type==='join') {
        const room=rooms.get(String(m.room||'').toUpperCase());
        if(!room) return send(ws,{type:'error',message:'Сервер не знайдено або він уже закритий.'});
        if(room.players.length>=2) return send(ws,{type:'error',message:'Сервер уже заповнений.'});
        const p=await getPlayer(id);
        room.players.push({...p,ws,mark:'O'});
        ws.room=room.id; ws.mark='O'; ws.playerId=id;
        send(ws,{type:'joined',room:room.id,private:!room.public});
        return broadcast(room);
      }

      const room=rooms.get(ws.room); if(!room) return;
      if (m.type==='move') {
        const i=Number(m.index);
        if(room.result || room.players.length<2 || ws.mark!==room.turn || !Number.isInteger(i) || i<0 || i>=room.board.length || room.board[i]) return;
        room.board[i]=ws.mark;
        room.result=winResult(room.board,room.size);
        if(room.result && room.result!=='draw') {
          const winner=room.players.find(p=>p.mark===room.result);
          const updated=await addWin(winner.id);
          winner.wins=updated.wins;
        } else if(!room.result) room.turn=room.turn==='X'?'O':'X';
        return broadcast(room);
      }
      if (m.type==='restart') {
        if(room.players.length<2) return;
        room.board.fill(''); room.turn='X'; room.result=null; return broadcast(room);
      }
      if (m.type==='leave') {
        rooms.delete(room.id);
        room.players.forEach(p=>{if(p.ws!==ws) send(p.ws,{type:'roomClosed'});});
        return;
      }
    } catch (e) {
      console.error('message error:',e);
      send(ws,{type:'error',message:'Сервер тимчасово зайнятий. Спробуй ще раз.'});
    }
  });

  ws.on('close',()=>{
    const room=rooms.get(ws.room); if(!room) return;
    rooms.delete(room.id);
    room.players.forEach(p=>{if(p.ws!==ws) send(p.ws,{type:'roomClosed'});});
  });
});

// Never block the web server on the database connection.
initDatabase();
server.listen(PORT,'0.0.0.0',()=>console.log(`XO Online listening on ${PORT}`));
