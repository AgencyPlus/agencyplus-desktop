/**
 * preload.js — runs in the renderer's process but with Node access.
 * Everything exposed here is reachable by the web app via window.agencyPlusDesktop.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agencyPlusDesktop', {
  /** App version string, e.g. "1.0.2" */
  getVersion: () => ipcRenderer.invoke('app:version'),

  /** Trigger a manual update check */
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),

  /** Set the dock/taskbar badge (unread notification count) */
  setBadge: (count) => ipcRenderer.send('app:badge', count),

  /** True when running inside Electron — the web app uses this to show
   *  "You're on the desktop app" messaging and hide the download banner. */
  isDesktop: true,

  // ── v1.0.2 — this computer's notifications ───────────────────────────────
  /** This computer's own random token (registered with the person's login). */
  getDeviceToken: () => ipcRenderer.invoke('device:token'),
  /** Where the API is, so the background check can run after sign-out. */
  setApiBase: (apiBase) => ipcRenderer.invoke('device:set-api', apiBase),
  /** The background check is available in this version. */
  backgroundNotifications: true,
});
