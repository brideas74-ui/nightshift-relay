// NIGHT SHIFT - multiplayer sunucusu (ekstra paket gerekmez, sadece Node.js)
// Calistir: node server.js   (veya start_game.bat / start_game.sh)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 8000, ROOT = __dirname;
const PROTO = 1;                                   // istemci/sunucu protokol surumu
let RELAY = process.env.RELAY_ONLY === '1';        // true: sadece lobi/relay (oyun dosyasi sunmaz) -> internet sunucusu icin
const TRUST_PROXY = process.env.TRUST_PROXY !== '0'; // Render/Fly/Railway/nginx arkasinda gercek IP'yi x-forwarded-for'dan al
const MAX_LOBBIES = +process.env.MAX_LOBBIES || 300, MAX_PER_IP = +process.env.MAX_PER_IP || 12;
const clients = new Set();
let MAXMIN = 0;   // lobi omru (dakika). 0 = sinirsiz. Relay modunda varsayilan 15 (LOBBY_MAX_MIN ile degisir)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.json': 'application/json', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/health' || (RELAY && u === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: 1, game: 'nightshift', proto: PROTO, players: clients.size, lobbies: lobbies.size, lobbyMaxMin: MAXMIN }));
  }
  if (RELAY) { res.writeHead(404); return res.end('404'); }
  if (u === '/') u = '/Night_Shift.html';
  const f = path.normalize(path.join(ROOT, u));
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('404'); }
    const h = { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' };
    res.writeHead(200, h);
    fs.createReadStream(f).pipe(res);
  });
});

// ---------- minimal WebSocket ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(str) {
  const p = Buffer.from(str), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function send(c, o) { if (c && c.alive && !c.socket.destroyed) { try { c.socket.write(frame(JSON.stringify(o))); } catch (e) {} } }

const ipOf = (req, socket) => {
  let ip = socket.remoteAddress || '';
  if (TRUST_PROXY) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) ip = f; }
  return ip;
};
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const ip = ipOf(req, socket); let same = 0; clients.forEach(x => { if (x.ip === ip) same++; });
  if (same >= MAX_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, alive: true, id: crypto.randomBytes(4).toString('hex'), name: 'Player', lobby: null, st: 'alive', buf: Buffer.alloc(0), fragOp: 0, frag: [], ip, last: Date.now(), win: 0, cnt: 0 };
  clients.add(c);
  send(c, { t: 'hello', proto: PROTO, online: clients.size });
  socket.on('data', d => {
    c.last = Date.now();
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 1 << 20) return socket.destroy();
    for (;;) {
      const b = c.buf;
      if (b.length < 2) break;
      const fin = b[0] & 0x80, op = b[0] & 15, mask = b[1] & 0x80;
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + (mask ? 4 : 0) + len) break;
      let pl = b.slice(off + (mask ? 4 : 0), off + (mask ? 4 : 0) + len);
      if (mask) { const m = b.slice(off, off + 4); pl = Buffer.from(pl); for (let i = 0; i < pl.length; i++) pl[i] ^= m[i & 3]; }
      c.buf = b.slice(off + (mask ? 4 : 0) + len);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8A, pl.length]), pl])); continue; }
      if (op === 1 || op === 0) {
        if (op === 1) c.frag = [];
        c.frag.push(pl);
        if (fin) {
          const s = Buffer.concat(c.frag).toString(); c.frag = [];
          const now = Date.now(); if (now - c.win > 1000) { c.win = now; c.cnt = 0; }   // mesaj hiz siniri: sn'de 300'den fazlasi yok sayilir, 1500+ atilir
          if (++c.cnt > 1500) return socket.destroy();
          if (c.cnt > 300) continue;
          try { onMsg(c, JSON.parse(s)); } catch (e) {}
        }
      }
    }
  });
  const gone = () => { if (!c.alive) return; c.alive = false; clients.delete(c); leave(c); };
  socket.on('close', gone); socket.on('error', gone); socket.on('end', gone);
});

// ---------- lobbies ----------
const lobbies = new Map();
const rnd = () => String(Math.floor(Math.random() * 1e9));
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)]; } while (lobbies.has(s)); return s; }
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const GMS = ['classic', 'regular', 'detective'];
function tally(L) { const t = { classic: 0, regular: 0, detective: 0 }; L.votes.forEach(v => { if (t[v] != null) t[v]++; }); return t; }
function info(L) {
  return { code: L.code, name: L.name, max: L.max, priv: L.priv, diff: L.diff, state: L.state, day: L.day, host: L.host,
    au: L.au ? 1 : 0, ncre: L.ncre, tally: tally(L),
    players: [...L.players.values()].map(p => ({ id: p.id, name: p.name, st: p.st, v: L.votes.get(p.id) || null })) };
}
const shuf = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const isCre = (L, p) => L.roles.get(p.id) === 'creature';
function pickMode(L) {
  const t = tally(L); let best = 0; GMS.forEach(g => { if (t[g] > best) best = t[g]; });
  const top = best ? GMS.filter(g => t[g] === best) : GMS.slice();
  return top[Math.floor(Math.random() * top.length)];
}
function bcast(L, o, except) { L.players.forEach(p => { if (p !== except) send(p, o); }); }
function pushLobby(L) { const i = info(L); bcast(L, Object.assign({ t: 'lobby' }, i)); }
function leave(c) {
  const L = c.lobby; if (!L) return;
  L.players.delete(c.id); c.lobby = null; L.votes.delete(c.id); L.roles.delete(c.id);
  if (!L.players.size) { lobbies.delete(L.code); return; }
  const wasHost = L.host === c.id;
  if (wasHost) L.host = L.players.values().next().value.id;
  bcast(L, { t: 'gone', id: c.id });
  if (wasHost && L.state === 'play') return endGame(L, false); // dunyayi host calistirir
  pushLobby(L);
  if (L.state === 'play') check(L);
}
function night(L) {
  L.day++; L.round++; L.players.forEach(p => p.st = 'alive');
  if (L.day > 10) return endGame(L, true);
  bcast(L, { t: 'night', day: L.day, seed: rnd(), r: L.round, diff: L.diff, gm: L.gm || 'classic', au: L.auOn ? 1 : 0 });
  pushLobby(L);
}
function endGame(L, win, cw) {
  L.state = 'wait'; L.day = 1; L.round++; L.players.forEach(p => p.st = 'alive');
  L.auOn = 0; L.roles.clear(); L.gm = null;
  bcast(L, { t: 'end', win: !!win, cw: !!cw }); pushLobby(L);
}
// herkes olu/kacmis ise: kacan varsa oyun biter, yoksa sonraki gece
function check(L) {
  if (L.state !== 'play') return;
  const ps = [...L.players.values()];
  if (L.auOn) {
    // Behind Us: yaratiklar olmez. Tum insanlar olurse yaratik kazanir.
    const hum = ps.filter(p => !isCre(L, p));
    if (ps.some(p => isCre(L, p))) {
      if (!hum.length || hum.every(p => p.st === 'dead')) return endGame(L, false, true);
      if (hum.some(p => p.st === 'alive')) return;
      return night(L);
    }
  }
  if (ps.some(p => p.st === 'alive')) return;
  night(L);
}
function onMsg(c, m) {
  const L = c.lobby;
  switch (m.t) {
    case 'ping': return send(c, { t: 'pong', c: m.c, n: clients.size });
    case 'list': {
      const a = []; lobbies.forEach(l => { if (!l.priv && l.state === 'wait') { const h = l.players.get(l.host); a.push({ code: l.code, name: l.name, n: l.players.size, max: l.max, diff: l.diff, hn: h ? h.name : '' }); } });
      a.sort((x, y) => (y.n < y.max) - (x.n < x.max) || y.n - x.n);
      return send(c, { t: 'list', lobbies: a.slice(0, 60), online: clients.size, proto: PROTO });
    }
    case 'create': {
      if (lobbies.size >= MAX_LOBBIES) return send(c, { t: 'err', m: 'Server is full, try again later.' });
      if (L) leave(c);
      c.name = clean(m.pname, 16) || 'Player'; c.st = 'alive';
      const l = { code: newCode(), name: clean(m.name, 24) || (c.name + "'s lobby"), max: Math.max(2, Math.min(8, +m.max || 4)), priv: !!m.priv,
        diff: Math.max(0, Math.min(3, (m.diff == null ? 1 : +m.diff) | 0)), state: 'wait', day: 1, round: 1, host: c.id, players: new Map(),
        votes: new Map(), roles: new Map(), au: 0, auOn: 0, gm: null, ncre: 1, created: Date.now(), warned: 0 };
      l.ncre = Math.max(1, Math.min(l.max - 1, +m.ncre || 1));
      l.players.set(c.id, c); c.lobby = l; lobbies.set(l.code, l);
      send(c, Object.assign({ t: 'joined', you: c.id }, info(l)));
      return;
    }
    case 'join': {
      const code = clean(m.code, 8).toUpperCase(), l = lobbies.get(code);
      if (!l) return send(c, { t: 'err', m: 'Lobby not found.' });
      if (l.state !== 'wait') return send(c, { t: 'err', m: 'Game already started.' });
      if (l.players.size >= l.max) return send(c, { t: 'err', m: 'Lobby is full.' });
      if (L) leave(c);
      c.name = clean(m.pname, 16) || 'Player'; c.st = 'alive';
      l.players.set(c.id, c); c.lobby = l;
      send(c, Object.assign({ t: 'joined', you: c.id }, info(l)));
      pushLobby(l);
      return;
    }
    case 'leave': return leave(c);
    case 'start': {
      if (!L || L.host !== c.id || L.state !== 'wait') return;
      L.state = 'play'; L.day = 1; L.round++; L.players.forEach(p => p.st = 'alive');
      L.gm = pickMode(L); L.roles.clear();
      const ps = [...L.players.values()];
      L.auOn = (L.au && ps.length >= 2) ? 1 : 0;
      if (L.auOn) {
        const n = Math.max(1, Math.min(L.ncre, ps.length - 1));
        shuf(ps).slice(0, n).forEach(p => L.roles.set(p.id, 'creature'));
      }
      // her oyuncuya kendi rolu ayri gonderilir (kimin yaratik oldugu gizli kalir)
      ps.forEach(p => send(p, { t: 'role', gm: L.gm, au: L.auOn, role: L.roles.get(p.id) || 'human', r: L.round }));
      bcast(L, { t: 'night', day: 1, seed: rnd(), r: L.round, diff: L.diff, gm: L.gm, au: L.auOn, first: 1 });
      pushLobby(L);
      return;
    }
    case 'vote': { if (L && L.state === 'wait' && GMS.includes(m.gm)) { L.votes.set(c.id, m.gm); pushLobby(L); } return; }
    case 'au': { if (L && L.host === c.id && L.state === 'wait') { L.au = m.v ? 1 : 0; pushLobby(L); } return; }
    case 'ncre': { if (L && L.host === c.id && L.state === 'wait') { L.ncre = Math.max(1, Math.min(Math.max(1, L.max - 1), m.v | 0)); pushLobby(L); } return; }
    case 'diff': { if (L && L.host === c.id && L.state === 'wait') { L.diff = Math.max(0, Math.min(3, m.v | 0)); pushLobby(L); } return; }
    case 's': { if (L) bcast(L, Object.assign({}, m, { id: c.id }), c); return; }
    case 'dead': { if (L && L.state === 'play' && m.r === L.round) { c.st = 'dead'; pushLobby(L); check(L); } return; }
    case 'esc': { if (L && L.state === 'play' && m.r === L.round) { L.state = 'wait'; L.day = 1; L.round++; L.players.forEach(p => p.st = 'alive'); L.auOn = 0; L.roles.clear(); L.gm = null; bcast(L, { t: 'win' }); pushLobby(L); } return; }
    // genel aktarim: bc = herkese (gonderen haric), to = tek oyuncuya
    case 'bc': { if (L && m.d) bcast(L, { t: 'x', from: c.id, d: m.d }, c); return; }
    case 'to': { if (L && m.d) { const q = L.players.get(m.to); if (q) send(q, { t: 'x', from: c.id, d: m.d }); } return; }
    case 'night': { if (L && L.state === 'play' && m.r === L.round) night(L); return; }
  }
}

// bosta kalan baglantilari canli tut (proxy'ler ~60sn'de keser) ve olu baglantilari at
setInterval(() => {
  const now = Date.now();
  clients.forEach(c => {
    if (now - c.last > 75000) return c.socket.destroy();
    try { c.socket.write(Buffer.from([0x89, 0])); } catch (e) {}
  });
}, 25000).unref();

// lobi omru dolunca: 1 dk once uyar, sonra herkesi lobiden at ve lobiyi sil (bos kalan sunucu platform tarafindan uyutulur)
function closeLobby(L, msg) {
  L.players.forEach(p => { p.lobby = null; send(p, { t: 'closed', m: msg }); });
  L.players.clear(); lobbies.delete(L.code);
}
setInterval(() => {
  if (!MAXMIN) return;
  const now = Date.now(), life = MAXMIN * 60000;
  [...lobbies.values()].forEach(L => {
    const left = L.created + life - now;
    if (left <= 0) closeLobby(L, 'Lobby time limit (' + MAXMIN + ' min) reached.');
    else if (left <= 60000 && !L.warned) { L.warned = 1; bcast(L, { t: 'closing', s: Math.ceil(left / 1000) }); }
  });
}, 2000).unref();

function listen(port, host, relayOnly, opts) {
  if (relayOnly != null) RELAY = !!relayOnly;
  if (opts && opts.lobbyMaxMin != null) MAXMIN = +opts.lobbyMaxMin || 0;
  else MAXMIN = process.env.LOBBY_MAX_MIN != null ? (+process.env.LOBBY_MAX_MIN || 0) : (RELAY ? 15 : 0);
  return new Promise((res, rej) => {
    const onErr = e => rej(e);
    server.once('error', onErr);
    server.listen(port, host || '0.0.0.0', () => { server.removeListener('error', onErr); res(server.address().port); });
  });
}
function close() {
  clients.forEach(c => { try { c.socket.destroy(); } catch (e) {} });
  clients.clear(); lobbies.clear();
  return new Promise(r => { try { server.close(() => r()); } catch (e) { r(); } });
}
module.exports = { listen, close, PROTO };

if (require.main === module) {
  listen(PORT, '0.0.0.0').then(() => {
    if (RELAY) { console.log('\n NIGHT SHIFT relay (internet lobi sunucusu) calisiyor. Port: ' + PORT + '  /health ile kontrol et.\n'); return; }
    console.log('\n NIGHT SHIFT sunucusu calisiyor.');
    console.log(' Bu bilgisayarda:  http://localhost:' + PORT + '/Night_Shift.html');
    const ni = os.networkInterfaces();
    Object.keys(ni).forEach(k => ni[k].forEach(a => { if (a.family === 'IPv4' && !a.internal) console.log(' Ayni agdaki (LAN) arkadaslar: http://' + a.address + ':' + PORT + '/Night_Shift.html'); }));
    console.log(' Dunya geneli icin: bu server.js dosyasini RELAY_ONLY=1 ile bir internet sunucusunda calistir (bkz. ONLINE_SUNUCU_KURULUM.md)\n');
  }).catch(e => { console.error('Sunucu baslatilamadi:', e.message); process.exit(1); });
}
