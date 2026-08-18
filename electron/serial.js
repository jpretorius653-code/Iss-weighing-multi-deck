// ============================================================
//  ISS Weighbridge — native serial manager
//  Holds COM ports open at the OS level, streams raw bytes to the
//  renderer, auto-reconnects on cable drops, and supports demand
//  (poll) mode. Implements the issDesktop serial contract that the
//  app already expects: serialAvailable / serialList / serialOpen /
//  serialClose / serialSaved + onSerialData / onSerialRaw / onSerialStatus.
// ============================================================
'use strict';

let SerialPortLib = null;
let LOAD_ERROR = null;
try { SerialPortLib = require('serialport'); }
catch (e) { LOAD_ERROR = (e && (e.message || String(e))) || 'unknown'; console.warn('[serial] serialport module not available:', LOAD_ERROR); }

const RECONNECT_MS = 3000;

function unescape(s) {
  return String(s || '')
    // <TAG> tokens — the format the renderer's Request Command dropdown stores.
    // Without these, the EXE wrote the literal text "<ENQ>" to the indicator
    // instead of byte 0x05, so demand-mode polling never worked natively.
    .replace(/<CR>/gi, '\r').replace(/<LF>/gi, '\n')
    .replace(/<ENQ>/gi, '\x05').replace(/<STX>/gi, '\x02')
    .replace(/<ETX>/gi, '\x03').replace(/<EOT>/gi, '\x04')
    // backslash escapes
    .replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

class SerialManager {
  constructor() {
    this.bridges = {};        // bi -> { port, opts, want, pollTimer, reconnectTimer }
    this.send = () => {};     // set by main: (channel, payload) => void
  }

  available() { return !!SerialPortLib; }
  loadError() { return LOAD_ERROR; }

  async list() {
    if (!SerialPortLib) return [];
    try {
      const ports = await SerialPortLib.SerialPort.list();
      return ports.map(p => ({
        path: p.path,
        friendlyName: p.friendlyName || p.pnpId || p.manufacturer || p.path,
        manufacturer: p.manufacturer || '',
        vendorId: p.vendorId || null,
        productId: p.productId || null,
      }));
    } catch (e) {
      console.warn('[serial] list failed', e.message);
      return [];
    }
  }

  _status(bi, status, path, detail) {
    // Console trace so `npm start` shows a readable [serial] log; also sent to the UI.
    const line = `[serial] bridge${bi} ${status}` + (path ? ` ${path}` : '') + (detail ? ` — ${detail}` : '');
    if (status === 'error') console.error(line); else console.log(line);
    this.send('iss-serial-status', { bi: Number(bi), status, path: path || '', detail: detail || '' });
  }

  // Re-resolve the current COM path from the saved device identity (handles
  // Windows COM renumbering between reboots/replugs).
  async _resolvePath(bi) {
    const b = this.bridges[bi]; if (!b || !b.opts || !SerialPortLib) return;
    const o = b.opts;
    try {
      const ports = await SerialPortLib.SerialPort.list();
      const exact = ports.find(p => p.path === o.path);
      if (exact) {
        o.serialNumber = o.serialNumber || exact.serialNumber || null;
        o.pnpId        = o.pnpId        || exact.pnpId        || null;
        o.vendorId     = o.vendorId     || exact.vendorId     || null;
        o.productId    = o.productId    || exact.productId    || null;
      } else {
        const match = ports.find(p =>
          (o.serialNumber && p.serialNumber === o.serialNumber) ||
          (o.pnpId && p.pnpId === o.pnpId) ||
          (o.vendorId && p.vendorId === o.vendorId && p.productId === o.productId));
        if (match && match.path !== o.path) {
          this._status(bi, 'info', match.path, `Port moved → ${match.path}`);
          o.path = match.path;
        }
      }
    } catch (_) {}
  }

  // Reset the adapter's receive path after open — the software equivalent of
  // toggling the COM port's FIFO/Advanced settings in Device Manager. Purges
  // buffers, then pulses DTR/RTS low→high to re-init CH340/Prolific chips.
  _kick(port, o = {}) {
    const holdDtr = o.dtr !== false, holdRts = o.rts !== false;   // default asserted
    try {
      port.flush(() => {
        try {
          port.set({ dtr: false, rts: false }, () => {
            // raise back to the state the indicator needs to keep transmitting
            setTimeout(() => { try { port.set({ dtr: holdDtr, rts: holdRts }, () => {}); } catch (_) {} }, 120);
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Release a port handle fully so a retry starts clean (key to escaping a
  // stuck "SetCommState error 31" loop — a half-open handle blocks reopen).
  _cleanupPort(b) {
    const p = b && b.port;
    if (!p) return;
    try { clearInterval(b.pollTimer); } catch (_) {}
    try { p.removeAllListeners(); } catch (_) {}
    try { if (p.isOpen) p.close(() => {}); } catch (_) {}
    try { if (typeof p.destroy === 'function') p.destroy(); } catch (_) {}
    b.port = null;
  }

  async open(bi, opts) {
    if (!SerialPortLib) return { ok: false, error: 'Native serial not available' };
    bi = Number(bi);
    await this.close(bi, true);   // close any existing, keep "want" intent

    const b = this.bridges[bi] || (this.bridges[bi] = {});
    b.opts = Object.assign({ baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, pollCmd: '', pollMs: 1000 }, opts);
    b.want = true;
    b.attempts = 0;

    await this._resolvePath(bi);      // find the device by identity if the COM moved
    const r = await this._spawn(bi);
    if (r && r.ok) r.opts = b.opts;   // hand enriched opts (identity + path) back so main can persist them
    return r;
  }

  // serial diagnostics for the Help menu
  async diagnostics() {
    const ports = await this.list();
    const bridges = {};
    for (const [bi, b] of Object.entries(this.bridges)) {
      bridges[bi] = { want: !!b.want, open: !!(b.port && b.port.isOpen), path: b.opts && b.opts.path };
    }
    return {
      available: this.available(),
      loadError: LOAD_ERROR,
      runtime: { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules, arch: process.arch },
      ports, bridges
    };
  }

  _spawn(bi) {
    const b = this.bridges[bi];
    if (!b || !b.want) return { ok: false, error: 'closed' };
    this._cleanupPort(b);                      // never stack handles on the same COM
    b._loggedData = false;
    const o = b.opts;
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let port;
      try {
        // Prolific (and some FTDI) drivers throw "SetCommState error 31" when handed
        // flow-control flags they dislike — even though PuTTY, which sends a minimal
        // config, opens the same port fine. So build the MINIMAL config PuTTY uses and
        // only add the extra flags when explicitly asked. This is the fix for ports
        // that open in PuTTY but not here.
        const cfg = {
          path: o.path,
          baudRate: parseInt(o.baud) || 9600,
          autoOpen: false,
        };
        // Only pin these when the user set a non-default — otherwise let the driver keep
        // its current (PuTTY-set) values, which is what avoids the SetCommState rejection.
        if (o.dataBits) cfg.dataBits = parseInt(o.dataBits) || 8;
        if (o.stopBits) cfg.stopBits = parseFloat(o.stopBits) || 1;
        if (o.parity)   cfg.parity   = o.parity;
        if (o.hwflow === true) { cfg.rtscts = true; }   // opt-in only
        console.log('[serial] opening', JSON.stringify(cfg), 'kick='+(o.kick===true));
        port = new SerialPortLib.SerialPort(cfg);
      } catch (e) {
        this._status(bi, 'error', o.path, e.message);
        this._scheduleReconnect(bi);
        return resolve({ ok: false, error: e.message });
      }
      b.port = port;

      port.on('data', (buf) => {
        if (!b._loggedData) { b._loggedData = true;
          console.log('[serial] bridge'+bi+' DATA ('+buf.length+'B): '+
            [...buf.subarray(0,16)].map(x=>x.toString(16).padStart(2,'0')).join(' ')); }
        this.send('iss-serial-raw', { bi, data: buf.toString('latin1') });
      });
      port.on('error', (err) => {
        this._status(bi, 'error', o.path, err.message);
        if (settled) this._scheduleReconnect(bi);   // runtime drop after a good open
      });
      port.on('close', () => {
        clearInterval(b.pollTimer);
        this._status(bi, 'closed', o.path);
        if (b.want) this._scheduleReconnect(bi);
      });

      port.open((err) => {
        if (err) {
          // SetCommState / error-31 / busy / driver errors arrive here. On CH340 this
          // usually means the adapter was left in a bad line state by the last session
          // (exactly what toggling a setting in Device Manager fixes). Reproduce that
          // toggle in software: briefly open with control lines forced, pulse DTR/RTS,
          // close, and retry the real open ONCE before falling back to reconnect.
          const msg = String(err.message || err);
          this._cleanupPort(b);
          // "SetCommState error 31" on a CH340 is a known bad-driver bug: the port
          // opens in PuTTY (old serial API) but not via SetCommState. A software reset
          // can't fix it because the reset opener hits the same SetCommState. Detect it
          // and surface a clear, actionable message instead of a cryptic code.
          if (/31/.test(msg) && /SetCommState/i.test(msg)) {
            this._status(bi, 'error', o.path,
              'CH340 driver rejected the port (SetCommState error 31). This is a known Windows ' +
              'CH340 driver bug — it works in PuTTY but not here. Fix: in Device Manager roll the ' +
              'USB-SERIAL CH340 driver back to 3.5.2019.1 (or 3.7.2022.1), then reconnect.');
            this._scheduleReconnect(bi);
            return done({ ok: false, error: 'CH340 driver error 31 — roll back the CH340 driver to 3.5.2019.1 (see Serial Diagnostics).' });
          }
          this._status(bi, 'error', o.path, msg);
          const looksResettable = /Access|denied|busy|not function/i.test(msg);
          if (looksResettable && !b._didReset && b.want) {
            b._didReset = true;
            this._forceResetAdapter(o.path, () => {
              // retry the real open after the adapter has been kicked
              const r2 = this._spawn(bi);
              if (r2 && typeof r2.then === 'function') r2.then(done); else done(r2 || { ok: false });
            });
            return;
          }
          this._scheduleReconnect(bi);
          return done({ ok: false, error: msg });
        }
        b._didReset = false;                 // clean open — reset the guard
        this._status(bi, 'open', o.path);
        b.attempts = 0;
        // Line control. PuTTY does NOT pulse DTR/RTS, and Prolific/FTDI indicators
        // often stop transmitting when it happens — so the pulse is now OPT-IN only.
        // Default: leave the lines asserted high (host-ready) and just flush, which is
        // how PuTTY behaves and what these indicators expect.
        if (o.kick === true) {
          this._kick(port, o);
        } else {
          try { port.flush(() => {}); } catch (_) {}
          try { port.set({ dtr: o.dtr !== false, rts: o.rts !== false }, () => {}); } catch (_) {}
        }
        if (o.pollCmd) {
          const cmd = Buffer.from(unescape(o.pollCmd), 'latin1');
          clearInterval(b.pollTimer);
          b.pollTimer = setInterval(() => { try { port.write(cmd); } catch (_) {} }, Math.max(150, parseInt(o.pollMs) || 1000));
        }
        done({ ok: true });
      });
    });
  }

  _scheduleReconnect(bi) {
    const b = this.bridges[bi];
    if (!b || !b.want) return;
    this._cleanupPort(b);
    clearTimeout(b.reconnectTimer);
    b.attempts = (b.attempts || 0) + 1;
    // quick early retries (USB adapters often throw SetCommState error 31 on the
    // first attempt right after enumerating at boot), capped at RECONNECT_MS
    const delay = Math.min(RECONNECT_MS, 500 + b.attempts * 400);
    b.reconnectTimer = setTimeout(async () => {
      if (!b.want) return;
      await this._resolvePath(bi).catch(() => {});
      this._spawn(bi);
    }, delay);
  }

  async close(bi, keepIntent) {
    bi = Number(bi);
    const b = this.bridges[bi];
    if (!b) return { ok: true };
    if (!keepIntent) b.want = false;
    clearTimeout(b.reconnectTimer);
    clearInterval(b.pollTimer);
    const p = b.port;
    b.port = null;
    if (p) {
      // Detach listeners first so the 'close' event can't re-trigger a reconnect,
      // then ALWAYS release the OS handle — close it if open, and destroy the
      // stream regardless of isOpen. Dropping the reference without destroying is
      // exactly what orphans the handle and makes the port look "occupied".
      try { p.removeAllListeners(); } catch (_) {}
      // Reset pulse while the port is STILL OPEN (control lines can't be set once
      // closed). Toggling DTR/RTS low nudges CH340/FTDI adapters to release cleanly.
      try { if (p.isOpen) p.set({ dtr: false, rts: false }, () => {}); } catch (_) {}
      await new Promise(res => {
        let done = false; const fin = () => { if (!done) { done = true; res(); } };
        try {
          if (p.isOpen) p.close(() => fin());
          else fin();
        } catch (_) { fin(); }
        setTimeout(fin, 1500);                // longer safety: never hang on a wedged handle
      });
      try { if (typeof p.destroy === 'function') p.destroy(); } catch (_) {}
    }
    return { ok: true };
  }

  isOpen(bi) {
    const b = this.bridges[Number(bi)];
    return !!(b && b.port && b.port.isOpen);
  }

  // Software equivalent of toggling a COM setting in Device Manager: briefly open the
  // raw port, pulse DTR/RTS low->high, then close. Clears the wedged CH340 line state
  // that produces "error 31" without the operator touching Device Manager. Always
  // calls cb() (best-effort — a failure here just means the retry proceeds normally).
  _forceResetAdapter(pathName, cb) {
    let called = false;
    const finish = () => { if (!called) { called = true; try { cb(); } catch (_) {} } };
    let rp;
    try {
      rp = new SerialPortLib.SerialPort({ path: pathName, baudRate: 9600, autoOpen: false });
    } catch (_) { return finish(); }
    const bail = () => { try { rp.removeAllListeners(); } catch (_) {} 
                         try { if (rp.isOpen) rp.close(() => {}); } catch (_) {}
                         try { rp.destroy(); } catch (_) {} finish(); };
    rp.on('error', () => {});                 // swallow — this is best-effort
    try {
      rp.open((e) => {
        if (e) return bail();
        try { rp.set({ dtr: false, rts: false }, () => {}); } catch (_) {}
        setTimeout(() => {
          try { rp.set({ dtr: true, rts: true }, () => {}); } catch (_) {}
          try { rp.flush(() => {}); } catch (_) {}
          setTimeout(() => {
            try { rp.close(() => { try { rp.destroy(); } catch (_) {} finish(); }); }
            catch (_) { bail(); }
          }, 150);
        }, 150);
      });
    } catch (_) { bail(); }
    setTimeout(bail, 2500);                    // hard timeout so we never hang the open
  }

  async closeAll() {
    for (const bi of Object.keys(this.bridges)) await this.close(bi);
  }

  // Best-effort synchronous release, used on process 'exit' where async can't run.
  // Destroying the stream drops the underlying fd immediately.
  closeAllSync() {
    for (const bi of Object.keys(this.bridges)) {
      const b = this.bridges[bi];
      if (!b) continue;
      b.want = false;
      clearTimeout(b.reconnectTimer);
      clearInterval(b.pollTimer);
      const p = b.port; b.port = null;
      if (!p) continue;
      try { p.removeAllListeners(); } catch (_) {}
      try { if (p.isOpen) p.close(() => {}); } catch (_) {}
      try { if (typeof p.destroy === 'function') p.destroy(); } catch (_) {}
    }
  }

  // bridges that are configured/open right now (renderer reflects "paired")
  saved() {
    const out = {};
    for (const [bi, b] of Object.entries(this.bridges)) {
      if (b.want && b.opts) out[bi] = { path: b.opts.path, baud: b.opts.baud, parity: b.opts.parity };
    }
    return out;
  }
}

module.exports = { SerialManager };
