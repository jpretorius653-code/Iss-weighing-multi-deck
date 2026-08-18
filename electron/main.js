// ============================================================
//  ISS Weighbridge — Electron main process
// ============================================================
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { SerialManager } = require('./serial');
const { TcpManager } = require('./tcp');
let tcp = new TcpManager();
const { Storage } = require('./storage');

const isDev = !app.isPackaged;
let win = null;
let serial = null;
let storage = null;

// single instance — a weighbridge PC runs exactly one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680,
    backgroundColor: '#0E0E10',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,            // preload needs node (serial/fs via IPC target)
      spellcheck: false,
    },
  });

  serial.send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
  tcp.send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

  // ---- Serial ownership ----
  // The native main process is the SOLE owner of the COM port. We deny
  // Chromium's Web Serial entirely so two processes can never hold the same
  // port at once — that double-ownership is what left a handle open and made
  // the port look "occupied by another process" until a physical replug.
  const ses = win.webContents.session;
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    callback('');                                   // refuse Web Serial port selection
  });
  ses.setPermissionCheckHandler((wc, permission) => permission !== 'serial');
  ses.setDevicePermissionHandler((details) => !details || details.deviceType !== 'serial');

  win.once('ready-to-show', () => win.show());

  // ── Robust renderer load ───────────────────────────────────────────
  // "Not allowed to load local resource / chromewebdata" means loadFile
  // couldn't find index.html at the given path. Depending on how the build
  // packs files (asar on/off, app vs app.asar), the renderer can sit in a few
  // places. Try each; if all fail, show an inline page listing what we tried.
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'index.html'),
    path.join(__dirname, 'renderer', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'renderer', 'index.html'),
    path.join(process.resourcesPath || '', 'app.asar', 'renderer', 'index.html'),
    path.join(app.getAppPath(), 'renderer', 'index.html'),
  ];
  let loaded = null;
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) { loaded = p; break; } } catch (_) {}
  }
  if (loaded) {
    win.loadFile(loaded);
  } else {
    const tried = candidates.map(p => '• ' + p).join('<br>');
    const html = '<body style="background:#0E0E10;color:#eee;font:14px system-ui;padding:30px">' +
      '<h2 style="color:#ff7b7b">Renderer not found</h2>' +
      '<p>The app could not locate <code>renderer/index.html</code>. Paths tried:</p>' +
      '<div style="font:12px monospace;color:#9fe">' + tried + '</div>' +
      '<p style="margin-top:20px;color:#aaa">appPath: ' + app.getAppPath() + '<br>resourcesPath: ' + (process.resourcesPath||'') + '</p>' +
      '</body>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    try { win.show(); win.webContents.openDevTools({ mode: 'bottom' }); } catch (_) {}
  }

  // ── Black-screen failsafe ──────────────────────────────────────────
  // If the renderer fails to load or crashes, force DevTools open and show
  // the window so the error is visible (the ASUS keyboard steals F12, so we
  // can't rely on a keypress). Also surfaces uncaught renderer errors.
  const _forceDevTools = (why) => {
    try { win.show(); } catch (_) {}
    try { win.webContents.openDevTools({ mode: 'bottom' }); } catch (_) {}
    try { console.error('[renderer failsafe]', why); } catch (_) {}
  };
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return; // aborted, harmless
    _forceDevTools('did-fail-load ' + code + ' ' + desc + ' ' + url);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    _forceDevTools('render-process-gone ' + (details && details.reason));
  });
  win.webContents.on('preload-error', (e, file, error) => {
    _forceDevTools('preload-error ' + file + ' ' + (error && error.message));
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    // level 3 = error. Mirror renderer errors to the main-process log and, on
    // the first hard error, pop DevTools so a crash can't hide behind black.
    if (level === 3) {
      try { console.error('[renderer console]', message, '(' + sourceId + ':' + line + ')'); } catch (_) {}
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };   // print preview windows etc.
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    {
      label: 'ISS Weighbridge',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: 'Toggle Full Screen', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { label: 'Developer Tools', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Open Backup Folder', click: () => shell.openPath(storage.backupDir) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'Help', submenu: [
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Serial Diagnostics…', click: async () => {
        let info = { available: false, ports: [], bridges: {}, loadError: null, runtime: {} };
        try { info = await serial.diagnostics(); } catch (_) {}
        const saved = (storage.config.serialPorts) || {};
        const portLines = info.ports.length
          ? info.ports.map(p => `   ${p.path}  —  ${p.friendlyName}`).join('\n')
          : '   (none detected)';
        const savedLines = Object.keys(saved).length
          ? Object.entries(saved).map(([bi, o]) => `   Bridge ${Number(bi) + 1}: ${o.path} @ ${o.baud || 9600}${o.serialNumber ? '  (SN ' + o.serialNumber + ')' : ''}`).join('\n')
          : '   (no ports paired yet)';
        const rt = info.runtime || {};
        dialog.showMessageBox(win, {
          type: info.available ? 'info' : 'warning',
          title: 'Serial Diagnostics',
          message: info.available ? 'Native serial: ACTIVE' : 'Native serial: NOT loaded — using Web Serial fallback',
          detail:
            (info.available ? '' : `Reason the native module did not load:\n   ${info.loadError || 'unknown'}\n\n`) +
            `Runtime: Electron ${rt.electron || '?'} · Node ${rt.node || '?'} · ABI ${rt.abi || '?'} · ${rt.arch || '?'} · ${app.isPackaged ? 'packaged' : 'dev'}\n\n` +
            `Detected COM ports:\n${portLines}\n\n` +
            `Remembered (auto-reopen) ports:\n${savedLines}\n\n` +
            (info.available
              ? 'Paired ports reopen automatically on launch and are re-found by device identity if Windows changes the COM number.'
              : 'Fix: the serialport native binary must match this Electron build. Rebuild with:  npm install  (runs electron-builder install-app-deps), or  npx electron-rebuild -f -w serialport . Until then the app uses Web Serial, which must be re-picked each start and is not saved here.')
        });
      } },
      { label: 'Open Backup Folder', click: () => shell.openPath(storage.backupDir) },
      { label: 'About ISS Weighbridge', click: () => {
        dialog.showMessageBox(win, {
          type: 'info', title: 'ISS Weighbridge',
          message: 'ISS Weighbridge',
          detail: `Version ${app.getVersion()}\nNative serial: ${serial.available() ? 'active' : 'Web Serial fallback'}\nIndustrial Scale Solutions · Weigh Forward`,
          icon: path.join(__dirname, '..', 'build', 'icon.png'),
        });
      } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: the full issDesktop contract ----
function wireIpc() {
  ipcMain.handle('iss-version', () => app.getVersion());

  ipcMain.handle('iss-serial-available', () => serial.available());
  ipcMain.handle('iss-serial-error', () => ({ available: serial.available(), loadError: serial.loadError(), packaged: app.isPackaged, abi: process.versions.modules, electron: process.versions.electron }));
  ipcMain.handle('iss-serial-list', () => serial.list());
  ipcMain.handle('iss-serial-open', async (_e, { bi, opts }) => {
    const r = await serial.open(bi, opts);
    if (r && r.ok) persistPort(bi, r.opts || opts);   // persist enriched opts (identity + resolved path)
    return r;
  });
  ipcMain.handle('iss-serial-close', async (_e, { bi }) => {
    await serial.close(bi);
    forgetPort(bi);
    return { ok: true };
  });
  ipcMain.handle('iss-serial-saved', () => serial.saved());

  // ---- Network serial gateway (TCP) ----
  ipcMain.handle('iss-tcp-open', async (_e, { bi, opts }) => tcp.open(bi, opts));
  ipcMain.handle('iss-tcp-close', async (_e, { bi }) => { tcp.close(bi); return { ok: true }; });
  ipcMain.handle('iss-tcp-saved', () => tcp.saved());

  // ---- Durable state (activation/config/users) survives file:// storage resets ----
  ipcMain.handle('iss-state-read', () => storage.readState());
  ipcMain.handle('iss-state-write', (_e, { key, value }) => storage.writeState(key, value));
  ipcMain.on('iss-state-sync', (e) => { try { e.returnValue = storage.readState(); } catch (_) { e.returnValue = {}; } });
  ipcMain.handle('iss-data-paths', () => ({
    userData: storage.userData, statePath: storage.statePath, configPath: storage.configPath,
    stateExists: require('fs').existsSync(storage.statePath),
    configExists: require('fs').existsSync(storage.configPath),
  }));

  ipcMain.handle('iss-auto-backup', (_e, json) => {
    try { return storage.autoBackup(json); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('iss-sync-write', (_e, tx) => storage.syncWrite(tx));
  ipcMain.handle('iss-sync-read', () => storage.syncRead());
  ipcMain.handle('iss-shared-put', (_e, a) => storage.sharedPut(a.kind, a.id, a.obj));
  ipcMain.handle('iss-shared-list', (_e, a) => storage.sharedList(a.kind));
  ipcMain.handle('iss-shared-put-doc', (_e, a) => storage.sharedPutDoc(a.name, a.obj));
  ipcMain.handle('iss-shared-doc', (_e, a) => storage.sharedDoc(a.name));
  ipcMain.handle('iss-shared-status', () => storage.sharedStatus());
  ipcMain.handle('iss-pick-sync-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose shared sync folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return '';
    return storage.setSyncFolder(r.filePaths[0]);
  });
  ipcMain.handle('iss-open-backup-folder', () => shell.openPath(storage.backupDir));
}

// ---- persist paired ports so they auto-reopen on next launch ----
function persistPort(bi, opts) {
  const ports = storage.config.serialPorts || (storage.config.serialPorts = {});
  ports[bi] = opts;
  storage._writeConfig();
}
function forgetPort(bi) {
  if (storage.config.serialPorts) { delete storage.config.serialPorts[bi]; storage._writeConfig(); }
}
// Reopen paired ports on launch. A USB adapter (CH340/FTDI) can take a second or two
// to enumerate after boot, so a single attempt often lands before the port exists —
// retry a few times before giving up.
async function reopenSavedPorts(attempt = 1) {
  const ports = storage.config.serialPorts || {};
  const keys = Object.keys(ports);
  if (!keys.length) return;
  const failed = [];
  for (const bi of keys) {
    if (serial.isOpen && serial.isOpen(bi)) continue;   // already attached
    try {
      const r = await serial.open(bi, ports[bi]);
      if (!r || !r.ok) failed.push(bi);
    } catch (_) { failed.push(bi); }
  }
  if (failed.length && attempt < 5) {
    console.log(`[serial] reopen attempt ${attempt} failed for [${failed}] — retrying`);
    setTimeout(() => reopenSavedPorts(attempt + 1), 2000 * attempt);  // longer for USB to enumerate
  }
}

app.whenReady().then(async () => {
  storage = new Storage(app.getPath('userData'));
  serial = new SerialManager();
  buildMenu();
  createWindow();
  wireIpc();
  // give the renderer a moment to bind serial event handlers, then reopen
  // re-attach on every load (covers renderer reloads), not just the first
  win.webContents.on('did-finish-load', () => setTimeout(() => reopenSavedPorts(), 800));

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ---- Clean shutdown: ALWAYS release the serial handle before the process dies.
// Electron does NOT await async event listeners, so an `async` before-quit handler
// returns immediately and the process exits with the port still open — the OS then
// reports it as "occupied by another process" on the next launch. We must block the
// quit, close the ports, then exit for real.
let _cleanupDone = false;
async function shutdownCleanly() {
  if (_cleanupDone) return;
  _cleanupDone = true;
  try { if (serial) await serial.closeAll(); } catch (_) {}
  try { if (tcp) await tcp.closeAll(); } catch (_) {}
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();   // before-quit does the cleanup
});

app.on('before-quit', (e) => {
  if (_cleanupDone) return;                         // second pass: let the quit proceed
  e.preventDefault();                               // hold the quit open
  const hardExit = setTimeout(() => { _cleanupDone = true; app.exit(0); }, 2500); // never hang
  shutdownCleanly().finally(() => { clearTimeout(hardExit); app.quit(); });
});

// Last-resort safety nets for hard kills / crashes.
app.on('will-quit', (e) => {
  if (_cleanupDone) return;
  e.preventDefault();
  shutdownCleanly().finally(() => app.exit(0));
});
process.on('exit', () => { try { if (serial) serial.closeAllSync(); } catch (_) {} try { if (tcp) tcp.closeAllSync(); } catch (_) {} });
process.on('SIGINT',  () => { shutdownCleanly().finally(() => app.exit(0)); });
process.on('SIGTERM', () => { shutdownCleanly().finally(() => app.exit(0)); });
