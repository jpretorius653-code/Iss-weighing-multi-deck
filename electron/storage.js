// ============================================================
//  ISS Weighbridge — storage / backup / sync
//  - Resolves its own save folder via app.getPath('userData') — doesn't
//    depend on the caller passing the right path.
//  - EVERY write to disk goes through atomicWriteFileSync(): write to a
//    temp file, fsync it to disk, then rename over the real file. Rename
//    is atomic at the filesystem level, so a crash or power loss can never
//    leave a half-written config/backup/sync file — the reader always sees
//    either the old complete file or the new complete file, never a mix.
//  - The config file additionally keeps a "last known good" .bak copy. If
//    the live file is ever found corrupt (e.g. from an outage before this
//    fix was in place, or a damaged disk sector), we recover from .bak
//    instead of silently resetting to a blank config (which is what caused
//    "asks for activation again / looks like a fresh install").
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

// Electron derives userData from productName, so renaming/rebranding the app moves
// the folder and strands the saved config (remembered serial ports, sync folder).
// Adopt the newest legacy config once, so paired ports survive a rebrand/upgrade.
// Every productName this app has ever shipped under. Ordered newest-first so a
// PC that has been through several rebrands adopts the most recent data.
const LEGACY_APP_DIRS = ['Hillside Complex Weighbridge', 'Hillside Weighbridge',
                         'NovaSpire Weighbridge', 'A AND N KADIR Weighbridge'];
const CONFIG_NAME  = 'iss-config.json';
const STATE_NAME   = 'iss-state.json';
// Filenames used before the ISS rebrand. Read (once) but never written.
const LEGACY_CONFIG_NAMES = ['novaspire-config.json'];
const LEGACY_STATE_NAMES  = ['hillside-state.json', 'novaspire-state.json'];
const BACKUP_PREFIX = 'ISS-Backup-';
// Match our own backups plus the pre-rebrand ones, so rotation keeps working
// on a PC that already has a folder full of Hillside-Backup-*.json files.
const BACKUP_DATED_RE = /^(ISS|Hillside|NovaSpire)-Backup-\d{4}-\d{2}-\d{2}\.json$/;

// Files created by the sync tool (Syncthing/OneDrive/Dropbox), never real
// records. Reading these back in was importing conflict copies as duplicate
// transactions, so they are excluded everywhere the share is listed.
function isSyncArtifact(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('.sync-conflict-')   // Syncthing conflict copies
      || n.includes('~syncthing~')       // Syncthing temp files
      || n.includes('.tmp-')             // our own atomic-write temps
      || n.endsWith('.tmp')
      || n.includes('-conflicted copy')  // OneDrive / Dropbox style
      || n.startsWith('.');              // hidden/partial files
}

// ---- Atomic, fsynced write helper — used for every file this module writes ----
// Writing straight to the destination file (fs.writeFileSync(dest, data)) is what
// broke: if power is lost or the process dies mid-write, the destination is left
// truncated/corrupt. Writing to a neighbour temp file, fsync-ing it to disk, and
// then renaming over the destination avoids that: rename() is an atomic filesystem
// operation, so the destination is always either fully-old or fully-new.
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);              // force the temp file's bytes onto disk NOW —
                                    // without this, a power cut can lose the write
                                    // entirely even though the rename looks clean.
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);    // atomic replace — never a partial destination file
}

// Read + JSON.parse a file, returning `fallback` (default: null) if it's missing,
// unreadable, or corrupt — never throws.
function readJsonSafe(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}

class Storage {
  // userDataDir is optional — if the caller doesn't pass one (or passes nothing),
  // this resolves it itself via Electron's app.getPath('userData'), so storage.js
  // is correct on its own rather than depending on main.js wiring it through.
  constructor(userDataDir) {
    this.userData = userDataDir || Storage.resolveUserDataDir();
    this.backupDir = path.join(this.userData, 'backups');
    this.configPath = path.join(this.userData, CONFIG_NAME);
    this.configBakPath = this.configPath + '.bak';         // last-known-good copy
    this.statePath = path.join(this.userData, STATE_NAME);
    this.stateBakPath = this.statePath + '.bak';
    fs.mkdirSync(this.backupDir, { recursive: true });
    // Rebranding changes productName, which changes Electron's userData folder.
    // Without this, every existing site would launch looking like a brand-new
    // install: no activation, no users, no database, no paired COM ports.
    if (!fs.existsSync(this.configPath)) this._adoptLegacy(CONFIG_NAME, LEGACY_CONFIG_NAMES, 'config');
    if (!fs.existsSync(this.statePath))  this._adoptLegacy(STATE_NAME,  LEGACY_STATE_NAMES,  'state');
    this.config = this._readConfig();
  }

  static resolveUserDataDir() {
    try {
      // Only valid in the main process; lazy-required so this file can still be
      // loaded (e.g. by tests) without Electron running.
      const { app } = require('electron');
      return app.getPath('userData');
    } catch (e) {
      throw new Error('[storage] No userDataDir supplied and Electron app.getPath is unavailable: ' + e.message);
    }
  }

  // ---- Durable state store (activation, cfg, users, db, orders) ----------
  // Mirrors the renderer's critical localStorage keys to a real file in userData,
  // so activation and settings survive even if the packaged app's file:// local
  // storage is cleared/not persisted.
  readState() {
    const s = readJsonSafe(this.statePath);
    if (s) return s;
    const bak = readJsonSafe(this.stateBakPath);
    if (bak) { console.warn('[storage] state file unreadable — recovered from .bak'); return bak; }
    return {};
  }
  writeState(key, value) {
    try {
      const s = this.readState();
      s[key] = value;
      const json = JSON.stringify(s);
      // keep the pre-write file as the "last known good" copy before overwriting
      if (fs.existsSync(this.statePath)) {
        try { fs.copyFileSync(this.statePath, this.stateBakPath); } catch (_) {}
      }
      atomicWriteFileSync(this.statePath, json);
      return true;
    } catch (e) { console.error('[storage] writeState failed:', e.message); return false; }
  }

  // Finds `current` (or any of `legacyNames`) in this app's own folder or in any
  // folder the app used under a previous product name, and copies the first hit
  // in. Runs only when the destination file is absent, so it can never clobber
  // live data, and it is a copy — the old folder is left untouched as a fallback.
  _adoptLegacy(current, legacyNames, label) {
    try {
      const parent = path.dirname(this.userData);
      const dirs = [this.userData, ...LEGACY_APP_DIRS.map(d => path.join(parent, d))];
      const names = [current, ...legacyNames];
      for (const dir of dirs) {
        for (const name of names) {
          const src = path.join(dir, name);
          if (src === path.join(this.userData, current)) continue;   // the destination itself
          if (!fs.existsSync(src)) continue;
          const data = fs.readFileSync(src);
          if (!data || !data.length) continue;
          try { JSON.parse(data.toString('utf8')); } catch (_) { continue; }   // skip corrupt
          atomicWriteFileSync(path.join(this.userData, current), data);
          console.log(`[storage] adopted ${label} from previous install:`, src);
          return true;
        }
      }
    } catch (e) {
      console.error('[storage] legacy adopt failed:', e.message);
    }
    return false;
  }

  // Reads the config, recovering from the .bak copy if the live file is missing
  // or corrupt, instead of silently falling back to an empty config (which is
  // what previously made the app look freshly reinstalled after a crash).
  _readConfig() {
    const cfg = readJsonSafe(this.configPath);
    if (cfg) return cfg;
    const bak = readJsonSafe(this.configBakPath);
    if (bak) {
      console.warn('[storage] config file unreadable — recovered from .bak, restoring it as primary');
      try { atomicWriteFileSync(this.configPath, JSON.stringify(bak, null, 2)); } catch (_) {}
      return bak;
    }
    if (fs.existsSync(this.configPath)) {
      console.error('[storage] config file exists but is corrupt and no .bak is available — starting fresh. ' +
        'A copy of the damaged file has been kept for inspection.');
      try { fs.copyFileSync(this.configPath, this.configPath + '.corrupt-' + Date.now()); } catch (_) {}
    }
    return {};
  }

  _writeConfig() {
    try {
      // Snapshot the current good file as .bak BEFORE writing the new one, so if
      // this process dies partway through building the new JSON (before the
      // atomic write even starts), the previous good state is still recoverable.
      if (fs.existsSync(this.configPath)) {
        try { fs.copyFileSync(this.configPath, this.configBakPath); } catch (_) {}
      }
      atomicWriteFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error('[storage] writeConfig failed:', e.message);
    }
  }

  // ---- backups ----
  autoBackup(json) {
    const latest = path.join(this.backupDir, `${BACKUP_PREFIX}Latest.json`);
    atomicWriteFileSync(latest, json);
    const stamp = new Date().toISOString().slice(0, 10);
    atomicWriteFileSync(path.join(this.backupDir, `${BACKUP_PREFIX}${stamp}.json`), json);
    this._rotate(30);                                 // keep 30 dated backups
    return { ok: true, path: latest };
  }
  _rotate(keep) {
    try {
      const dated = fs.readdirSync(this.backupDir)
        .filter(f => BACKUP_DATED_RE.test(f)).sort();
      while (dated.length > keep) {
        fs.unlinkSync(path.join(this.backupDir, dated.shift()));
      }
    } catch (_) {}
  }

  // ---- multi-PC sync (shared/network folder) ----
  getSyncFolder() { return this.config.syncFolder || ''; }
  setSyncFolder(dir) { this.config.syncFolder = dir; this._writeConfig(); return dir; }

  // ══════════════════════════════════════════════════════════
  // SHARED DATABASE — one folder both weighbridges read/write.
  // Record-per-file so two PCs can never clobber each other.
  // Deletes are tombstones ({_deleted:true}) — a record is only ever
  // removed when the dashboard explicitly says so, never by a sync.
  // ══════════════════════════════════════════════════════════
  _shareDir(kind) {
    const base = this.getSyncFolder();
    if (!base) return '';
    const dir = kind ? path.join(base, kind) : base;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return ''; }
    return dir;
  }

  // Write one record: <sync>/<kind>/<id>.json
  sharedPut(kind, id, obj) {
    const dir = this._shareDir(kind);
    if (!dir || id == null) return { ok: false };
    try {
      const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
      atomicWriteFileSync(path.join(dir, safe + '.json'), JSON.stringify(obj));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Read every record of a kind
  sharedList(kind) {
    const dir = this._shareDir(kind);
    if (!dir) return { items: [] };
    try {
      const items = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && !isSyncArtifact(f))
        .map(f => readJsonSafe(path.join(dir, f)))
        .filter(Boolean);
      return { items };
    } catch (e) { return { items: [], error: e.message }; }
  }

  // Single shared document (e.g. custom field definitions)
  sharedPutDoc(name, obj) {
    const dir = this._shareDir('');
    if (!dir) return { ok: false };
    try {
      const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
      atomicWriteFileSync(path.join(dir, safe + '.json'), JSON.stringify(obj));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  sharedDoc(name) {
    const dir = this._shareDir('');
    if (!dir) return null;
    try {
      const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
      return readJsonSafe(path.join(dir, safe + '.json'));
    } catch (e) { return null; }
  }

  // Is the shared folder reachable right now?
  sharedStatus() {
    const base = this.getSyncFolder();
    if (!base) return { ok: false, reason: 'not set' };
    try {
      fs.mkdirSync(base, { recursive: true });
      const probe = path.join(base, '.iss-probe');
      fs.writeFileSync(probe, String(Date.now()));
      fs.unlinkSync(probe);
      return { ok: true, folder: base };
    } catch (e) { return { ok: false, reason: e.message, folder: base }; }
  }

  syncWrite(tx) {
    const dir = this.getSyncFolder();
    if (!dir || !tx || tx.id == null) return { ok: false };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(tx.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const f = path.join(dir, `tx-${safe}.json`);
      atomicWriteFileSync(f, JSON.stringify(tx));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  syncRead() {
    const dir = this.getSyncFolder();
    if (!dir) return { txs: [] };
    try {
      const txs = fs.readdirSync(dir)
        .filter(f => /^tx-.*\.json$/.test(f) && !isSyncArtifact(f))
        .map(f => readJsonSafe(path.join(dir, f)))
        .filter(Boolean);
      return { txs };
    } catch (e) { return { txs: [], error: e.message }; }
  }
}

module.exports = { Storage, atomicWriteFileSync, readJsonSafe };
