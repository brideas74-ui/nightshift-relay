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
  const c = { socket, alive: true, id: crypto.randomBytes(4).toString('hex'), name: 'Player', lobby: null, st: 'alive', buf: Buffer.alloc(0), fragOp: 0, frag: [], ip, last: Date.now(), win: 0, cnt: 0, acct: null, aw: 0, aq: 0 };
  clients.add(c);
  send(c, { t: 'hello', proto: PROTO, online: clients.size, auth: needAuth() ? 1 : 0 });
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


// =====================================================================
// v143: HESAP SISTEMI (dunya geneli benzersiz kullanici adi, guvenli giris)
//  - Sifre: scrypt (N=16384) + kisiye ozel 16 bayt salt (+ istege bagli ACCOUNT_PEPPER). Sifre asla duz metin saklanmaz/loglanmaz.
//  - Oturum: rastgele 256 bit anahtar; sunucuda sadece SHA-256'si tutulur (veri sizsa bile anahtar calinamaz). 60 gun, her giriste uzar.
//  - Kullanici adi: dunya genelinde tek. Buyuk/kucuk harf ve benzer gorunen harfler (I/l/1, O/0, S/5, . _ -) ayni sayilir -> taklit hesap acilamaz.
//  - Saldiri korumasi: IP basina yanlis giris siniri, hesap kilidi (5 yanlis -> artan bekleme), kayit siniri, sabit zamanli karsilastirma,
//    olmayan kullanicida da ayni sure (kullanici var mi diye yoklanamaz), mesaj boyutu/hiz siniri.
//  - Kalicilik: ACCOUNTS_FILE (yerel dosya) VEYA UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (ucretsiz Render'da dosya silinir -> Upstash onerilir).
// =====================================================================
const ACC_FILE = process.env.ACCOUNTS_FILE || path.join(ROOT, 'accounts.json');
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PEPPER = process.env.ACCOUNT_PEPPER || '';
const needAuth = () => process.env.REQUIRE_AUTH != null ? process.env.REQUIRE_AUTH === '1' : RELAY;
const TOK_TTL = 60 * 864e5, MAX_TOK = 6, REG_PER_IP = +process.env.REG_PER_IP || 5;
const USERS = new Map();                 // skeleton -> {u, k, salt, hash, created, tok:[{h,exp}], fails, lock}
const dirtyKeys = new Set(); let flushT = 0, accReady = null;
const UN_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,15}$/;
const RESERVED = /^(admin|administrator|moderator|mod|system|server|root|support|staff|owner|nightshift|creature|player|guest|null|undefined|anonymous|anon|bot|npc|host)$/;
const skel = u => String(u).toLowerCase().replace(/[._-]/g, '').replace(/0/g, 'o').replace(/[1il]/g, 'l').replace(/5/g, 's').replace(/rn/g, 'm');
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'qwertyuiop', 'abc12345', 'iloveyou', '11111111', '00000000', 'nightshift', 'night shift', 'nightshift1', 'sifre123', 'sifre1234', 'parola123', 'admin123', 'letmein123', 'welcome1']);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function userProblem(u) {
  if (typeof u !== 'string' || !UN_RE.test(u)) return 'Username: 3-16 characters, start with a letter, only letters, numbers, . _ -';
  if (RESERVED.test(u.toLowerCase().replace(/[._-]/g, ''))) return 'This username is reserved.';
  return '';
}
function passProblem(p, u) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 128) return 'Password is too long (max 128).';
  if (/[\u0000-\u001f]/.test(p)) return 'Password has invalid characters.';
  if (!/\p{L}/u.test(p) || !/\d/.test(p)) return 'Password must contain at least one letter and one number.';
  if (new Set(p).size < 4) return 'Password is too simple.';
  if (COMMON.has(p.toLowerCase())) return 'This password is too common.';
  if (u && p.toLowerCase().includes(String(u).toLowerCase())) return 'Password must not contain your username.';
  return '';
}
let pending = 0;
const pre = p => PEPPER ? crypto.createHmac('sha256', PEPPER).update(p).digest('hex') : p.normalize('NFKC');
const kdf = (pw, salt) => new Promise((res, rej) => { pending++; crypto.scrypt(pre(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => { pending--; e ? rej(e) : res(k); }); });
const DUMMY_SALT = crypto.randomBytes(16);

// ---- kalicilik ----
async function upCmd(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j.result;
}
async function dbLoad() {
  try {
    if (UP_URL && UP_TOK) {
      let cur = '0';
      do {
        const r = await upCmd(['SCAN', cur, 'MATCH', 'nsu:*', 'COUNT', '500']); cur = String(r[0]); const keys = r[1];
        for (let i = 0; i < keys.length; i += 100) {
          const vals = await upCmd(['MGET'].concat(keys.slice(i, i + 100)));
          vals.forEach(v => { try { const o = JSON.parse(v); if (o && o.u && o.hash) USERS.set(skel(o.u), o); } catch (e) {} });
        }
      } while (cur !== '0');
    } else if (fs.existsSync(ACC_FILE)) {
      const j = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
      Object.keys(j.users || {}).forEach(k => USERS.set(k, j.users[k]));
    }
    console.log(' Hesaplar yuklendi: ' + USERS.size + (UP_URL ? ' (Upstash)' : ' (' + ACC_FILE + ')'));
  } catch (e) { console.error(' Hesaplar yuklenemedi:', e.message); if (UP_URL) { throw e; } }
}
function dbDirty(rec) {
  dirtyKeys.add(skel(rec.u)); if (flushT) return;
  flushT = setTimeout(() => { flushT = 0; dbFlush().catch(() => {}); }, 400);
}
async function dbFlush() {
  const keys = [...dirtyKeys]; dirtyKeys.clear(); if (!keys.length) return;
  if (UP_URL && UP_TOK) {
    for (const k of keys) { const r = USERS.get(k); if (!r) continue; try { await upCmd(['SET', 'nsu:' + k, JSON.stringify(r)]); } catch (e) { dirtyKeys.add(k); console.error(' Hesap kaydedilemedi:', e.message); } }
    if (dirtyKeys.size && !flushT) flushT = setTimeout(() => { flushT = 0; dbFlush().catch(() => {}); }, 5000);
  } else {
    const o = { v: 1, users: {} }; USERS.forEach((v, k) => { o.users[k] = v; });
    const tmp = ACC_FILE + '.tmp';
    await new Promise(r => fs.writeFile(tmp, JSON.stringify(o), { mode: 0o600 }, e => e ? r() : fs.rename(tmp, ACC_FILE, () => r())));
  }
}
function dbFlushSync() {   // kapanirken (sadece dosya modu)
  if (UP_URL && UP_TOK) return; try { const o = { v: 1, users: {} }; USERS.forEach((v, k) => { o.users[k] = v; }); fs.writeFileSync(ACC_FILE, JSON.stringify(o), { mode: 0o600 }); } catch (e) {}
}

// ---- hiz / kaba kuvvet siniri ----
const ipFail = new Map(), ipReg = new Map(), ipChk = new Map();
const blockedFor = ip => { const f = ipFail.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
function ipBad(ip) { const now = Date.now(); let f = ipFail.get(ip); if (!f || now - f.t0 > 6e5) f = { n: 0, t0: now, until: 0 }; if (++f.n >= 10) f.until = now + 15 * 6e4; ipFail.set(ip, f); }
setInterval(() => { const now = Date.now(); [ipFail, ipReg, ipChk].forEach(m => m.forEach((v, k) => { const t = Array.isArray(v) ? v[v.length - 1] : (v.until > now ? now : v.t0); if (now - t > 36e5) m.delete(k); })); }, 6e5).unref();
const mins = s => Math.max(1, Math.ceil(s / 60));

function mkTok(rec) {
  const tok = crypto.randomBytes(32).toString('hex'), now = Date.now();
  rec.tok = (rec.tok || []).filter(t => t.exp > now); rec.tok.push({ h: sha(tok), exp: now + TOK_TTL });
  if (rec.tok.length > MAX_TOK) rec.tok.splice(0, rec.tok.length - MAX_TOK);
  return tok;
}
function findRec(u) { if (typeof u !== 'string') return null; const r = USERS.get(skel(u)); return r && r.u.toLowerCase() === u.toLowerCase() ? r : null; }
const guestSafeName = n => { const r = USERS.get(skel(n)); return r ? 'Player' + Math.floor(Math.random() * 90 + 10) : n; };

async function accMsg(c, m) {
  const op = m.t, now = Date.now();
  const fail = (msg, x) => send(c, Object.assign({ t: 'acc_err', op, m: msg }, x || {}));
  if (!accReady) accReady = dbLoad();
  try { await accReady; } catch (e) { accReady = null; return fail('Account service is unavailable right now. Try again soon.'); }
  if (now - (c.aw || 0) > 6e4) { c.aw = now; c.aq = 0; }
  if (++c.aq > 30) return fail('Too many requests. Slow down.');
  if (pending > 8) return fail('Server is busy, try again in a moment.');
  const ip = c.ip, bl = blockedFor(ip);
  if (op === 'acc_check') {
    let a = ipChk.get(ip) || []; a = a.filter(t => now - t < 6e5); a.push(now); ipChk.set(ip, a);
    if (a.length > 80) return fail('Too many checks. Wait a few minutes.');
    const u = m.u, pr = userProblem(u);
    if (pr) return send(c, { t: 'acc_chk', u, ok: 0, m: pr });
    return send(c, { t: 'acc_chk', u, ok: USERS.has(skel(u)) ? 0 : 1, m: USERS.has(skel(u)) ? 'This username is taken (or looks too similar to one).' : '' });
  }
  if (op === 'acc_logout') {
    const r = findRec(m.u);
    if (r && typeof m.tok === 'string') { const h = sha(m.tok); const n = (r.tok || []).length; r.tok = (r.tok || []).filter(t => !eq(t.h, h)); if (r.tok.length !== n) dbDirty(r); }
    c.acct = null; return send(c, { t: 'acc_ok', op: 'logout' });
  }
  if (op === 'acc_resume') {
    if (bl) return fail('Too many failed attempts. Try again in ' + mins(bl) + ' min.');
    const r = findRec(m.u);
    if (r && typeof m.tok === 'string' && /^[0-9a-f]{64}$/.test(m.tok)) {
      const h = sha(m.tok), t = (r.tok || []).find(x => x.exp > now && eq(x.h, h));
      if (t) { t.exp = now + TOK_TTL; dbDirty(r); c.acct = r.u; return send(c, { t: 'acc_ok', op, u: r.u }); }
    }
    ipBad(ip); return fail('Session expired. Please log in again.', { code: 'expired' });
  }
  if (op === 'acc_reg') {
    if (bl) return fail('Too many failed attempts. Try again in ' + mins(bl) + ' min.');
    const u = m.u, p = m.p; let pr = userProblem(u) || passProblem(p, u); if (pr) return fail(pr);
    if (USERS.has(skel(u))) return fail('This username is taken (or looks too similar to one).', { code: 'taken' });
    let a = ipReg.get(ip) || []; a = a.filter(t => now - t < 36e5);
    if (a.length >= REG_PER_IP) return fail('Too many accounts created from this connection. Try again later.');
    const salt = crypto.randomBytes(16), hash = await kdf(p, salt);
    if (USERS.has(skel(u))) return fail('This username is taken (or looks too similar to one).', { code: 'taken' });   // kdf beklerken baskasi almis olabilir
    a.push(Date.now()); ipReg.set(ip, a);
    const rec = { u, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(), tok: [], fails: 0, lock: 0 };
    USERS.set(skel(u), rec); const tok = mkTok(rec); dbDirty(rec); c.acct = rec.u;
    return send(c, { t: 'acc_ok', op, u: rec.u, tok });
  }
  if (op === 'acc_login') {
    if (bl) return fail('Too many failed attempts. Try again in ' + mins(bl) + ' min.');
    const u = m.u, p = m.p;
    if (typeof u !== 'string' || typeof p !== 'string' || u.length > 16 || p.length > 128 || !p) return fail('Wrong username or password.');
    const r = findRec(u);
    if (!r) { await kdf(p, DUMMY_SALT).catch(() => {}); ipBad(ip); return fail('Wrong username or password.'); }
    if (r.lock > now) { ipBad(ip); return fail('Account temporarily locked after too many wrong passwords. Try again in ' + mins((r.lock - now) / 1000) + ' min.'); }
    const k = await kdf(p, Buffer.from(r.salt, 'hex'));
    if (!eq(k.toString('hex'), r.hash)) {
      r.fails = (r.fails | 0) + 1; if (r.fails >= 5) r.lock = Date.now() + Math.min(36e5, 6e4 * Math.pow(2, r.fails - 5)); dbDirty(r); ipBad(ip);
      return fail('Wrong username or password.');
    }
    r.fails = 0; r.lock = 0; const tok = mkTok(r); dbDirty(r); c.acct = r.u;
    return send(c, { t: 'acc_ok', op, u: r.u, tok });
  }
}

// ---------- lobbies ----------
const lobbies = new Map();
const rnd = () => String(Math.floor(Math.random() * 1e9));
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)]; } while (lobbies.has(s)); return s; }
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const GMS = ['classic', 'regular', 'detective'];
// ---- Behind Us ayarlari (lobi sahibi lobi acikken degistirir; herkese yayilir) ----
const AUS_DEF = { stun: 20, killCd: 15, catchR: 1.9, linger: 4, grace: 5, tpTime: 5, tpCd: 30, bossHits: 10, bossHp: 100, bossMg: .35, bossGun: 4, bossQcd: .8, revert: 10, shiftR: 7, loneR: 8, loneWin: 1, blink: 1, creBlink: 0, cd: 10 };
const AUS_RNG = { stun: [3, 60], killCd: [0, 120], catchR: [1, 4], linger: [1, 15], grace: [0, 20], tpTime: [1, 15], tpCd: [0, 180], bossHits: [1, 30], bossHp: [20, 500], bossMg: [.05, 3], bossGun: [.5, 30], bossQcd: [.2, 5], revert: [0, 120], shiftR: [2, 20], loneR: [3, 20], loneWin: [0, 1], blink: [0, 1], creBlink: [0, 1], cd: [0, 30] };
const ausSet = (L, k, v) => { const r = AUS_RNG[k]; v = +v; if (!r || !isFinite(v)) return false; L.aus[k] = Math.round(Math.max(r[0], Math.min(r[1], v)) * 100) / 100; return true; };
function tally(L) { const t = { classic: 0, regular: 0, detective: 0 }; L.votes.forEach(v => { if (t[v] != null) t[v]++; }); return t; }
function info(L) {
  return { code: L.code, name: L.name, max: L.max, priv: L.priv, diff: L.diff, state: L.state, day: L.day, host: L.host,
    au: L.au ? 1 : 0, ncre: L.ncre, aus: L.aus, tally: tally(L),
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
// ---- v142: round ozeti (kim kimi yakaladi, kim ne kadar yasadi, en iyi saklanan) ----
function sumNew(L) {
  const now = Date.now();
  L.sum = { t0: now, nt0: now, kills: [], names: {}, cre: {}, surv: {}, deaths: {}, kc: {}, hide: {}, lk: {} };
  L.players.forEach(p => { L.sum.names[p.id] = p.name; p.lsT = 0; });
  L.roles.forEach((r, id) => { if (r === 'creature') L.sum.cre[id] = 1; });
}
function sumNight(L) {   // gece bitti: hayatta olanlara gecenin suresini ekle
  const S = L.sum; if (!S) return; const now = Date.now();
  L.players.forEach(p => { if (p.st === 'alive') S.surv[p.id] = (S.surv[p.id] || 0) + (now - S.nt0) / 1000; });
  S.nt0 = now;
}
function sumBuild(L, outcome, escName) {
  const S = L.sum; if (!S) return null; sumNight(L);
  const pl = Object.keys(S.names).map(id => ({ id: isNaN(+id) ? id : +id, name: S.names[id], cre: S.cre[id] ? 1 : 0, kills: S.kc[id] | 0, deaths: S.deaths[id] | 0, surv: Math.round(S.surv[id] || 0), hide: Math.round(S.hide[id] || 0) }));
  const sum = { outcome, dur: Math.round((Date.now() - S.t0) / 1000), day: L.day, esc: escName || '', players: pl,
    kills: S.kills.map(k => ({ by: S.names[k.by] || '?', v: S.names[k.v] || '?', t: k.t })) };
  L.sum = null; return sum;
}
function night(L) {
  sumNight(L);
  L.day++; L.round++; L.players.forEach(p => p.st = 'alive');
  if (L.day > 10) return endGame(L, true);
  bcast(L, { t: 'night', day: L.day, seed: rnd(), r: L.round, diff: L.diff, gm: L.gm || 'classic', au: L.auOn ? 1 : 0, aus: L.aus });
  pushLobby(L);
}
function endGame(L, win, cw) {
  const sum = sumBuild(L, cw ? 'creature' : win ? 'humans' : 'over');
  L.state = 'wait'; L.day = 1; L.round++; L.players.forEach(p => p.st = 'alive');
  L.auOn = 0; L.roles.clear(); L.gm = null;
  bcast(L, { t: 'end', win: !!win, cw: !!cw, sum }); pushLobby(L);
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
    case 'acc_check': case 'acc_reg': case 'acc_login': case 'acc_resume': case 'acc_logout': accMsg(c, m).catch(() => send(c, { t: 'acc_err', op: m.t, m: 'Server error, try again.' })); return;
    case 'ping': return send(c, { t: 'pong', c: m.c, n: clients.size });
    case 'list': {
      const a = []; lobbies.forEach(l => { if (!l.priv && l.state === 'wait') { const h = l.players.get(l.host); a.push({ code: l.code, name: l.name, n: l.players.size, max: l.max, diff: l.diff, hn: h ? h.name : '' }); } });
      a.sort((x, y) => (y.n < y.max) - (x.n < x.max) || y.n - x.n);
      return send(c, { t: 'list', lobbies: a.slice(0, 60), online: clients.size, proto: PROTO });
    }
    case 'create': {
      // v160: lobiye girmek/kurmak icin hesap GEREKMEZ (hesap sadece kozmetikler icin)
      if (lobbies.size >= MAX_LOBBIES) return send(c, { t: 'err', m: 'Server is full, try again later.' });
      if (L) leave(c);
      c.name = c.acct || guestSafeName(clean(m.pname, 16) || 'Player'); c.st = 'alive';
      const l = { code: newCode(), name: clean(m.name, 24) || (c.name + "'s lobby"), max: Math.max(2, Math.min(8, +m.max || 4)), priv: !!m.priv,
        diff: Math.max(0, Math.min(3, (m.diff == null ? 1 : +m.diff) | 0)), state: 'wait', day: 1, round: 1, host: c.id, players: new Map(),
        votes: new Map(), roles: new Map(), au: 0, auOn: 0, gm: null, ncre: 1, aus: Object.assign({}, AUS_DEF), created: Date.now(), warned: 0 };
      l.ncre = Math.max(1, Math.min(l.max - 1, +m.ncre || 1));
      l.players.set(c.id, c); c.lobby = l; lobbies.set(l.code, l);
      send(c, Object.assign({ t: 'joined', you: c.id }, info(l)));
      return;
    }
    case 'join': {
      const code = clean(m.code, 8).toUpperCase(), l = lobbies.get(code);
      // v160: lobiye girmek/kurmak icin hesap GEREKMEZ (hesap sadece kozmetikler icin)
      if (!l) return send(c, { t: 'err', m: 'Lobby not found.' });
      if (l.state !== 'wait') return send(c, { t: 'err', m: 'Game already started.' });
      if (l.players.size >= l.max) return send(c, { t: 'err', m: 'Lobby is full.' });
      if (c.acct && [...l.players.values()].some(p => p.acct === c.acct && p !== c)) return send(c, { t: 'err', m: 'This account is already in that lobby.' });
      if (L) leave(c);
      c.name = c.acct || guestSafeName(clean(m.pname, 16) || 'Player'); c.st = 'alive';
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
      sumNew(L);
      // her oyuncuya kendi rolu ayri gonderilir (kimin yaratik oldugu gizli kalir)
      ps.forEach(p => send(p, { t: 'role', gm: L.gm, au: L.auOn, role: L.roles.get(p.id) || 'human', r: L.round }));
      bcast(L, { t: 'night', day: 1, seed: rnd(), r: L.round, diff: L.diff, gm: L.gm, au: L.auOn, aus: L.aus, first: 1 });
      pushLobby(L);
      return;
    }
    case 'vote': { if (L && L.state === 'wait' && GMS.includes(m.gm)) { L.votes.set(c.id, m.gm); pushLobby(L); } return; }
    case 'au': { if (L && L.host === c.id && L.state === 'wait') { L.au = m.v ? 1 : 0; pushLobby(L); } return; }
    case 'ncre': { if (L && L.host === c.id && L.state === 'wait') { L.ncre = Math.max(1, Math.min(Math.max(1, L.max - 1), m.v | 0)); pushLobby(L); } return; }
    case 'aus': { if (L && L.host === c.id && L.state === 'wait') { if (m.reset) L.aus = Object.assign({}, AUS_DEF); else ausSet(L, m.k, m.v); pushLobby(L); } return; }
    case 'diff': { if (L && L.host === c.id && L.state === 'wait') { L.diff = Math.max(0, Math.min(3, m.v | 0)); pushLobby(L); } return; }
    case 's': { if (L) {
      if (L.sum && L.state === 'play' && c.st === 'alive' && !isCre(L, c)) { const now = Date.now(), dt = c.lsT ? Math.min(1.5, (now - c.lsT) / 1000) : 0; c.lsT = now; if (m.hid) L.sum.hide[c.id] = (L.sum.hide[c.id] || 0) + dt; }
      bcast(L, Object.assign({}, m, { id: c.id }), c); } return; }
    case 'dead': { if (L && L.state === 'play' && m.r === L.round) { if (L.sum && c.st === 'alive') { L.sum.surv[c.id] = (L.sum.surv[c.id] || 0) + (Date.now() - L.sum.nt0) / 1000; L.sum.deaths[c.id] = (L.sum.deaths[c.id] | 0) + 1; } c.st = 'dead'; pushLobby(L); check(L); } return; }
    case 'cwin': { if (L && L.state === 'play' && L.auOn && m.r === L.round && isCre(L, c)) endGame(L, false, true); return; }   // v138: yalniz oyuncuyu oldurunce Creature kazanir
    case 'esc': { if (L && L.state === 'play' && m.r === L.round) { const sum = sumBuild(L, 'humans', c.name); L.state = 'wait'; L.day = 1; L.round++; L.players.forEach(p => p.st = 'alive'); L.auOn = 0; L.roles.clear(); L.gm = null; bcast(L, { t: 'win', sum }); pushLobby(L); } return; }
    // genel aktarim: bc = herkese (gonderen haric), to = tek oyuncuya
    case 'bc': { if (L && m.d) bcast(L, { t: 'x', from: c.id, d: m.d }, c); return; }
    case 'to': { if (L && m.d) { const q = L.players.get(m.to);
      if (q && L.sum && L.state === 'play' && m.d.k === 'caught' && isCre(L, c) && !isCre(L, q) && q.st === 'alive') { const S = L.sum, now = Date.now(); if (!S.lk[q.id] || now - S.lk[q.id] > 3000) { S.lk[q.id] = now; S.kc[c.id] = (S.kc[c.id] | 0) + 1; S.kills.push({ by: c.id, v: q.id, t: Math.round((now - S.t0) / 1000) }); } }
      if (q) send(q, { t: 'x', from: c.id, d: m.d }); } return; }
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
  accReady = dbLoad(); ['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { dbFlushSync(); process.exit(0); }));
  listen(PORT, '0.0.0.0').then(() => {
    if (RELAY) { console.log('\n NIGHT SHIFT relay (internet lobi sunucusu) calisiyor. Port: ' + PORT + '  /health ile kontrol et.\n'); return; }
    console.log('\n NIGHT SHIFT sunucusu calisiyor.');
    console.log(' Bu bilgisayarda:  http://localhost:' + PORT + '/Night_Shift.html');
    const ni = os.networkInterfaces();
    Object.keys(ni).forEach(k => ni[k].forEach(a => { if (a.family === 'IPv4' && !a.internal) console.log(' Ayni agdaki (LAN) arkadaslar: http://' + a.address + ':' + PORT + '/Night_Shift.html'); }));
    console.log(' Dunya geneli icin: bu server.js dosyasini RELAY_ONLY=1 ile bir internet sunucusunda calistir (bkz. ONLINE_SUNUCU_KURULUM.md)\n');
  }).catch(e => { console.error('Sunucu baslatilamadi:', e.message); process.exit(1); });
}
