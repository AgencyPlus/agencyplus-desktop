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
});
