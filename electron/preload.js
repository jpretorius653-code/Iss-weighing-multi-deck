// ============================================================
//  ISS Weighbridge — preload
//  Exposes window.issDesktop to the renderer over a context-isolated
//  bridge. The renderer already targets this exact API.
// ============================================================
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Read durable state synchronously BEFORE the renderer script runs, so its
// module-level state (activation, cfg, users) can be restored if file:// local
// storage was cleared. Exposed as a plain value.
let _diskState = {};
try { _diskState = ipcRenderer.sendSync('iss-state-sync') || {}; } catch (_) { _diskState = {}; }

contextBridge.exposeInMainWorld('issDesktop', {
  diskState: _diskState,
  // identity
  platform: process.platform,
  version: () => ipcRenderer.invoke('iss-version'),

  // ---- native serial ----
  serialAvailable: () => ipcRenderer.invoke('iss-serial-available'),
  serialError: () => ipcRenderer.invoke('iss-serial-error'),
  serialList:      () => ipcRenderer.invoke('iss-serial-list'),
  serialOpen:      (bi, opts) => ipcRenderer.invoke('iss-serial-open', { bi, opts }),
  serialClose:     (bi) => ipcRenderer.invoke('iss-serial-close', { bi }),
  serialSaved:     () => ipcRenderer.invoke('iss-serial-saved'),
  tcpOpen:         (bi, opts) => ipcRenderer.invoke('iss-tcp-open', { bi, opts }),
  tcpClose:        (bi) => ipcRenderer.invoke('iss-tcp-close', { bi }),
  tcpSaved:        () => ipcRenderer.invoke('iss-tcp-saved'),
  stateRead:       () => ipcRenderer.invoke('iss-state-read'),
  stateWrite:      (key, value) => ipcRenderer.invoke('iss-state-write', { key, value }),
  dataPaths:       () => ipcRenderer.invoke('iss-data-paths'),

  onSerialData:   (cb) => ipcRenderer.on('iss-serial-data',  (_e, p) => cb(p)),
  onSerialRaw:    (cb) => ipcRenderer.on('iss-serial-raw',   (_e, p) => cb(p)),
  onSerialStatus: (cb) => ipcRenderer.on('iss-serial-status',(_e, p) => cb(p)),

  // ---- backup / sync ----
  autoBackup:     (json) => ipcRenderer.invoke('iss-auto-backup', json),
  syncWrite:      (tx) => ipcRenderer.invoke('iss-sync-write', tx),
  syncRead:       () => ipcRenderer.invoke('iss-sync-read'),
  sharedPut:      (kind, id, obj) => ipcRenderer.invoke('iss-shared-put', { kind, id, obj }),
  sharedList:     (kind) => ipcRenderer.invoke('iss-shared-list', { kind }),
  sharedPutDoc:   (name, obj) => ipcRenderer.invoke('iss-shared-put-doc', { name, obj }),
  sharedDoc:      (name) => ipcRenderer.invoke('iss-shared-doc', { name }),
  sharedStatus:   () => ipcRenderer.invoke('iss-shared-status'),
  pickSyncFolder: () => ipcRenderer.invoke('iss-pick-sync-folder'),
  openBackupFolder: () => ipcRenderer.invoke('iss-open-backup-folder'),
});
