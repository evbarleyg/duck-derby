// Minimal, dependency-free WebSocket relay standing in for Supabase Realtime in headless tests (the build
// sandbox cannot reach *.supabase.co). Semantics mirror what the game uses: rooms, three logical channels
// (control/input/state) broadcast to everyone else in the room (self: false), and presence (join/track/leave
// -> member list). Optional simulated latency/jitter.
//   usage: node tools/relay.mjs [port=8787] [--latency=40] [--jitter=15]
// Implements just enough of RFC 6455 (text frames, ping/pong, close; no extensions) over node:http.
import http from 'node:http';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || 8787);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const LAT = opt('latency', 0);
const JIT = opt('jitter', 0);

// ---- tiny websocket server
const clients = new Set();
function acceptKey(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  pump() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) { const m = b.subarray(maskOff, maskOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(off + len);
      if (op === 0x1) this.onmessage(payload.toString('utf8'));
      else if (op === 0x8) { this.close(); return; }
      else if (op === 0x9) this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); // pong
    }
  }
  send(text) { if (this.open) { try { this.socket.write(frame(text)); } catch { this.close(); } } }
  close() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch { /* ignore */ } this.onclose(); }
}
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('duck relay'); });
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  const c = new Conn(socket);
  clients.add(c);
  attach(c);
});

// ---- relay semantics
const rooms = new Map(); // code -> Map(conn -> {cid, meta})
const stats = { msgs: 0, bytes: 0, byChan: { control: 0, input: 0, state: 0 }, startedAt: Date.now() };
function presence(code) {
  const r = rooms.get(code);
  if (!r) return;
  const members = [...r.values()].map((m) => ({ cid: m.cid, ...m.meta }));
  const s = JSON.stringify({ kind: 'presence', room: code, members });
  for (const c of r.keys()) c.send(s);
}
function attach(c) {
  let myRoom = null;
  c.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.kind === 'join') {
      myRoom = m.room;
      if (!rooms.has(myRoom)) rooms.set(myRoom, new Map());
      rooms.get(myRoom).set(c, { cid: m.cid, meta: m.meta || {}, off: new Set() });
      presence(myRoom);
    } else if (m.kind === 'sub' && myRoom) {
      const me = rooms.get(myRoom) && rooms.get(myRoom).get(c);
      if (me) { if (m.on) me.off.delete(m.chan); else me.off.add(m.chan); }
    } else if (m.kind === 'track' && myRoom) {
      const r = rooms.get(myRoom);
      if (r && r.has(c)) { r.get(c).meta = m.meta || {}; presence(myRoom); }
    } else if (m.kind === 'msg' && myRoom) {
      const r = rooms.get(myRoom);
      if (!r) return;
      stats.msgs++;
      stats.bytes += text.length;
      if (stats.byChan[m.chan] !== undefined) stats.byChan[m.chan]++;
      for (const [peer, info] of r.entries()) {
        if (peer === c || (info.off && info.off.has(m.chan))) continue;
        stats.deliveries = (stats.deliveries || 0) + 1;
        if (LAT || JIT) setTimeout(() => peer.send(text), Math.max(0, LAT + (Math.random() * 2 - 1) * JIT));
        else peer.send(text);
      }
    } else if (m.kind === 'stats') {
      c.send(JSON.stringify({ kind: 'stats', ...stats, upS: (Date.now() - stats.startedAt) / 1000, rooms: [...rooms.entries()].map(([code, r]) => ({ code, members: r.size })) }));
    }
  };
  c.onclose = () => {
    clients.delete(c);
    if (!myRoom) return;
    const r = rooms.get(myRoom);
    if (r) { r.delete(c); presence(myRoom); if (!r.size) rooms.delete(myRoom); }
  };
}
server.listen(port, () => console.log(`relay listening on ws://localhost:${port} (latency ${LAT} ms ± ${JIT})`));
