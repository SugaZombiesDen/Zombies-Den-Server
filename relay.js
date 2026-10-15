// Zombies Den online server: a public game list ("quick join") plus a packet relay,
// so players never need to open ports on their routers.
// Game traffic is forwarded untouched: host <-> clients only (clients never talk to each other).
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_ROOMS = 400;
const MAX_ROOMS_PER_IP = 3;
const MAX_PLAYERS = 4;
const MAX_FRAME = 65536 + 8;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O look-alikes issues for the 24-letter keypad

const rooms = new Map(); // code -> room
let nextConn = 1;

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
const cleanName = (n) => (n || 'Survivor').replace(/[^\w '.\-]/g, '').trim().slice(0, 14) || 'Survivor';
const count = (r) => 1 + r.peers.size;
const listable = (r, ver) => r.public && !r.started && count(r) < MAX_PLAYERS && (ver === 0 || r.ver === ver);

function sendJson(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ver = parseInt(u.searchParams.get('ver') || '0', 10) || 0;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/games') {
    const list = [];
    for (const r of rooms.values()) if (listable(r, ver)) list.push({ code: r.code, name: r.name, count: count(r), max: MAX_PLAYERS });
    list.sort((a, b) => b.count - a.count);
    res.end(JSON.stringify({ games: list.slice(0, 20) }));
  } else if (u.pathname === '/quick') {
    let best = null;
    for (const r of rooms.values()) if (listable(r, ver) && (!best || count(r) > count(best) || (count(r) === count(best) && r.created < best.created))) best = r;
    res.end(JSON.stringify({ code: best ? best.code : '' }));
  } else if (u.pathname === '/stats') {
    let players = 0;
    for (const r of rooms.values()) players += count(r);
    res.end(JSON.stringify({ rooms: rooms.size, players }));
  } else {
    res.setHeader('Content-Type', 'text/plain');
    res.end('Zombies Den server OK\n');
  }
});


// ---- minimal WebSocket server (RFC 6455), no dependencies ----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class Sock {
  constructor(socket) {
    this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0);
    this.frag = null; this.handlers = {}; this.isAlive = true;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
    socket.setNoDelay(true);
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  _emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
  _closed() { if (this.readyState !== 3) { this.readyState = 3; this._emit('close'); } }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); if (hi) return this.terminate(); len = b.readUInt32BE(6); off = 10; }
      if (len > MAX_FRAME || !masked) return this.terminate();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this._write(10, payload); continue; }
      if (op === 10) { this.isAlive = true; this._emit('pong'); continue; }
      if (op === 1 || op === 2) { this.frag = { op, parts: [payload] }; }
      else if (op === 0 && this.frag) { this.frag.parts.push(payload); }
      else continue;
      if (fin) { const m = Buffer.concat(this.frag.parts); const isBin = this.frag.op === 2; this.frag = null; this._emit('message', m, isBin); }
    }
  }
  _write(op, payload) {
    if (this.readyState !== 1 && op !== 8) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(n, 6); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) {}
  }
  send(data, opts) { this._write(opts && opts.binary ? 2 : 1, Buffer.isBuffer(data) ? data : Buffer.from(String(data))); }
  ping() { this._write(9, Buffer.alloc(0)); }
  close(code, reason) {
    if (this.readyState !== 1) return;
    const r = Buffer.from(String(reason || '').slice(0, 100));
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    this._write(8, p); this.readyState = 2;
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 500);
  }
  terminate() { this.readyState = 3; try { this.socket.destroy(); } catch (e) {} this._closed(); }
}
const clients = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = new Sock(socket);
  clients.add(ws);
  socket.on('close', () => clients.delete(ws));
  onConnection(ws, req);
});

function closeRoom(room, reason) {
  rooms.delete(room.code);
  for (const p of room.peers.values()) { try { p.close(4000, reason); } catch (e) {} }
  room.peers.clear();
}

function onConnection(ws, req) {
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role');
  const ver = parseInt(u.searchParams.get('ver') || '0', 10) || 0;
  const ip = clientIp(req);
  ws.isAlive = true;
  ws.tokens = 600; ws.tokenT = Date.now();
  let room = null, myId = 0;

  const fail = (msg) => { sendJson(ws, { t: 'error', msg }); setTimeout(() => ws.close(4001, msg), 150); };

  if (role === 'host') {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP) return fail('Too many games from your connection.');
    if (rooms.size >= MAX_ROOMS) return fail('The server is full right now. Try again soon.');
    const code = newCode();
    if (!code) return fail('Could not create a game. Try again.');
    room = { code, host: ws, peers: new Map(), name: cleanName(u.searchParams.get('name')), ver, public: u.searchParams.get('public') === '1', started: false, created: Date.now(), nextId: 2, ip };
    rooms.set(code, room);
    myId = 1;
    sendJson(ws, { t: 'hosted', code });
  } else if (role === 'join') {
    const code = (u.searchParams.get('code') || '').toUpperCase();
    room = rooms.get(code);
    if (!room) return fail('No game with that code. Check the letters, or the host may have left.');
    if (room.ver !== ver) return fail('Different game version. Update both phones.');
    if (room.started) return fail('That match has already started.');
    if (count(room) >= MAX_PLAYERS) return fail('That game is full.');
    myId = room.nextId++;
    room.peers.set(myId, ws);
    sendJson(ws, { t: 'joined', id: myId });
    sendJson(room.host, { t: 'peer', id: myId, on: 1 });
  } else {
    return ws.close(4002, 'bad request');
  }
  const isHost = myId === 1;

  ws.on('message', (data, isBinary) => {
    // flood guard: ~600 messages/s burst, 300/s sustained
    const now = Date.now();
    ws.tokens = Math.min(600, ws.tokens + (now - ws.tokenT) * 0.3);
    ws.tokenT = now;
    if (--ws.tokens < 0) return ws.close(4003, 'too fast');
    if (!isBinary) {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (isHost && m.t === 'info') { room.started = !!m.started; if (typeof m.public === 'boolean') room.public = m.public; }
      else if (isHost && m.t === 'kick') { const p = room.peers.get(m.id | 0); if (p) p.close(4004, 'removed by host'); }
      return;
    }
    if (data.length < 5) return;
    const payload = data.subarray(4);
    const out = Buffer.allocUnsafe(4 + payload.length);
    payload.copy(out, 4);
    if (isHost) {
      const target = data.readInt32LE(0);
      out.writeInt32LE(1, 0);
      if (target > 0) { const p = room.peers.get(target); if (p && p.readyState === 1) p.send(out, { binary: true }); }
      else for (const [id, p] of room.peers) if (id !== -target && p.readyState === 1) p.send(out, { binary: true });
    } else {
      out.writeInt32LE(myId, 0);
      if (room.host.readyState === 1) room.host.send(out, { binary: true });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (isHost) closeRoom(room, 'The host left.');
    else if (room.peers.get(myId) === ws) {
      room.peers.delete(myId);
      sendJson(room.host, { t: 'peer', id: myId, on: 0 });
    }
  });
}

// drop dead connections (phones that vanish without saying goodbye)
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 20000);

server.listen(PORT, () => console.log('Zombies Den server listening on ' + PORT));
