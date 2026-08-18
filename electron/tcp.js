//  ISS Weighbridge — TCP gateway client
//  Reads a serial stream from a network serial gateway (e.g. USR-W610, Waveshare
//  RS232/485-to-WiFi) over a raw TCP socket, and forwards it to the renderer on
//  the SAME channels native serial uses (iss-serial-raw / iss-serial-status) so
//  the existing weight parser, connection pill and weigh logic all work unchanged.
//  Driver-free: the PC just opens a socket — no COM port, no CH340/FTDI driver.

const net = require('net');

class TcpManager {
  constructor() {
    this.conns = {};
    this.send = () => {};          // set by main.js -> webContents.send
  }

  available() { return true; }

  open(bi, opts) {
    bi = Number(bi);
    this.close(bi, true);          // drop any existing, keep intent
    const c = this.conns[bi] || (this.conns[bi] = {});
    c.opts = Object.assign({ host: '', port: 8899 }, opts);
    c.want = true;
    c.attempts = 0;
    this._spawn(bi);
    return { ok: true };
  }

  _spawn(bi) {
    const c = this.conns[bi];
    if (!c || !c.want) return;
    const host = String(c.opts.host || '').trim();
    const port = parseInt(c.opts.port) || 8899;
    if (!host) { this._status(bi, 'error', '', 'No gateway IP set'); return; }

    let sock;
    try {
      sock = net.createConnection({ host, port }, () => {
        c.attempts = 0;
        this._status(bi, 'open', `tcp ${host}:${port}`);
      });
    } catch (e) { this._status(bi, 'error', `${host}:${port}`, e.message); this._reconnect(bi); return; }

    c.sock = sock;
    try { sock.setKeepAlive(true, 5000); sock.setNoDelay(true); } catch (_) {}
    // guard the initial connect so a black-hole IP doesn't hang forever
    sock.setTimeout(8000, () => { if (!c._connected) { try { sock.destroy(); } catch (_) {} } });

    sock.on('connect', () => { c._connected = true; sock.setTimeout(0); });
    sock.on('data', (buf) => {
      // forward raw bytes into the same pipeline as native serial
      this.send('iss-serial-raw', { bi, data: buf.toString('latin1') });
    });
    sock.on('error', (e) => { this._status(bi, 'error', `${host}:${port}`, e.message); });
    sock.on('close', () => {
      c._connected = false;
      this._cleanup(c);
      this._status(bi, 'closed', `${host}:${port}`);
      if (c.want) this._reconnect(bi);
    });
  }

  _reconnect(bi) {
    const c = this.conns[bi];
    if (!c || !c.want) return;
    c.attempts = (c.attempts || 0) + 1;
    clearTimeout(c.timer);
    const delay = Math.min(8000, 800 + c.attempts * 700);   // backoff, capped 8s
    this._status(bi, 'reconnect', '', `retry in ${Math.round(delay / 1000)}s`);
    c.timer = setTimeout(() => { if (c.want) this._spawn(bi); }, delay);
  }

  _cleanup(c) {
    if (c && c.sock) {
      try { c.sock.removeAllListeners(); } catch (_) {}
      try { c.sock.destroy(); } catch (_) {}
      c.sock = null;
    }
  }

  close(bi, keepWant) {
    bi = Number(bi);
    const c = this.conns[bi];
    if (!c) return;
    if (!keepWant) c.want = false;
    clearTimeout(c.timer);
    this._cleanup(c);
    if (!keepWant) this._status(bi, 'closed', '');
  }

  closeAll() { for (const bi of Object.keys(this.conns)) this.close(bi); }

  closeAllSync() {
    for (const bi of Object.keys(this.conns)) {
      const c = this.conns[bi];
      if (c) { c.want = false; clearTimeout(c.timer); this._cleanup(c); }
    }
  }

  isOpen(bi) {
    const c = this.conns[Number(bi)];
    return !!(c && c.sock && !c.sock.destroyed && c._connected);
  }

  saved() {
    // return {bi: opts} for bridges we should reopen on launch
    const out = {};
    for (const bi of Object.keys(this.conns)) {
      const c = this.conns[bi];
      if (c && c.want && c.opts) out[bi] = c.opts;
    }
    return out;
  }

  _status(bi, status, path, detail) {
    const line = `[tcp] bridge${bi} ${status}` + (path ? ` ${path}` : '') + (detail ? ` — ${detail}` : '');
    if (status === 'error') console.error(line); else console.log(line);
    // 'reconnect' maps to the same 'closed'/reconnecting UX the renderer already knows
    const uiStatus = status === 'reconnect' ? 'error' : status;
    this.send('iss-serial-status', { bi: Number(bi), status: uiStatus, path: path || '', detail: detail || '' });
  }
}

module.exports = { TcpManager };
