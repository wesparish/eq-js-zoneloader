// Minimal Chrome DevTools Protocol driver: enough WebSocket to open a page,
// collect console output, wait for a readiness predicate, and grab a screenshot.
// Node 20 has no global WebSocket, so the client framing is hand-rolled.

import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

class WS {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const frame = this.readFrame();
        if (!frame) break;
        for (const h of this.handlers) h(frame);
      }
    });
  }
  static async connect(url) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    // Consume the handshake response before framing starts.
    await new Promise((resolve) => {
      let acc = Buffer.alloc(0);
      const onData = (d) => {
        acc = Buffer.concat([acc, d]);
        const end = acc.indexOf('\r\n\r\n');
        if (end === -1) return;
        sock.removeListener('data', onData);
        const rest = acc.subarray(end + 4);
        resolve();
        if (rest.length) sock.emit('data', rest);
      };
      sock.on('data', onData);
    });
    return new WS(sock);
  }
  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const len0 = b[1] & 0x7f;
    let off = 2, len = len0;
    if (len0 === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len0 === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + len) return null;
    const payload = b.subarray(off, off + len);
    this.buf = b.subarray(off + len);
    return payload.toString('utf8');
  }
  send(str) {
    const payload = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  onMessage(fn) { this.handlers.push(fn); }
  close() { this.sock.destroy(); }
}

export async function drive({ url, readyExpr, timeoutMs = 120000, screenshot, width = 1280, height = 800, before, shots = [] }) {
  const port = 9222 + Math.floor(Math.random() * 500);
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader',
    `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},${height}`, '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) { chrome.kill(); throw new Error('chrome did not expose a debugging port'); }

  const ws = await WS.connect(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const logs = [];
  const errors = [];
  let sessionId = null;

  ws.onMessage((raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  });

  const send = (method, params = {}, sid = sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true });
      if (res.result?.value === true) { ready = true; break; }
    } catch { /* page still navigating */ }
  }

  if (ready && before) {
    await send('Runtime.evaluate', { expression: before, returnByValue: true, awaitPromise: true });
    await new Promise((r) => setTimeout(r, 800));
  }

  let shotPath = null;
  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshot, Buffer.from(data, 'base64'));
    shotPath = screenshot;
  }

  // Optional extra captures, each preceded by its own setup expression.
  for (const shot of shots) {
    await send('Runtime.evaluate', { expression: shot.expr, returnByValue: true, awaitPromise: true });
    await new Promise((r) => setTimeout(r, shot.settleMs ?? 700));
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot.path, Buffer.from(data, 'base64'));
  }

  const stats = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({stats: document.getElementById("stats")?.innerText, readout: document.getElementById("readout")?.innerText, load: document.getElementById("loadText")?.innerText})',
    returnByValue: true,
  }).then((r) => r.result.value).catch(() => null);

  ws.close();
  chrome.kill();
  return { ready, logs, errors, shotPath, stats: stats ? JSON.parse(stats) : null };
}
