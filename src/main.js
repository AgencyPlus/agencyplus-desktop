/**
 * AgencyPlus Desktop — Electron main process
 *
 * This shell loads the live AgencyPlus web app in a native window. Because the
 * UI lives on Netlify, every frontend deploy is instantly reflected here with
 * no desktop-app release needed. The only thing this process owns is the
 * window chrome, the auto-updater, and a handful of OS-level conveniences.
 *
 * ARCHITECTURE
 *   renderer → preload bridge → main process
 *
 * The renderer (the web page) never gets Node.js access directly. Any
 * privileged action (badge count, notifications, deep-link open) goes through
 * the contextBridge in preload.js. This keeps the security model of a browser
 * while adding the desktop features the web cannot reach.
 */

const {
  app, BrowserWindow, shell, ipcMain,
  Menu, Tray, nativeImage, dialog,
} = require('electron');
const path    = require('path');
const { autoUpdater } = require('electron-updater');

// ── Configuration ─────────────────────────────────────────────────────────────
// Change APP_URL to your live Netlify domain before building.
// The dev override lets you point at localhost:3000 during development.
const APP_URL  = process.env.AGENCYPLUS_URL || 'https://agencyplus.com.et';
const IS_DEV   = !app.isPackaged;
const ICON_PATH = path.join(__dirname, '../assets/icon.png');

let mainWindow = null;
let tray       = null;

// ── Window creation ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  900,
    minHeight: 600,
    icon: ICON_PATH,
    title: 'AgencyPlus',
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Allow the web app to read its cookies and localStorage normally.
      // The partition keeps this window's session separate from any other
      // Electron app the user might have open.
      partition: 'persist:agencyplus',
    },
    // Start maximised on large screens; the minWidth/minHeight guard tablets.
    show: false,
  });

  // ── Load the app ────────────────────────────────────────────────────────────
  if (IS_DEV && process.env.AGENCYPLUS_DEV_URL) {
    mainWindow.loadURL(process.env.AGENCYPLUS_DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(APP_URL);
  }

  // Show only after the first paint so there's no flash of a white window.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.maximize();
  });

  // ── Navigation guard ────────────────────────────────────────────────────────
  // External links (Cloudinary, WhatsApp, email) open in the system browser.
  // Everything on the same origin stays in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL) || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const origin = new URL(APP_URL).origin;
    if (!url.startsWith(origin) && !url.startsWith('http://localhost')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
// Keeps AgencyPlus reachable even when the window is closed — useful for
// agencies that want to leave it running for incoming notifications.
function createTray() {
  try {
    const icon = nativeImage.createFromPath(ICON_PATH);
    tray       = new Tray(icon.resize({ width: 16, height: 16 }));
    const menu = Menu.buildFromTemplate([
      { label: 'Open AgencyPlus', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => autoUpdater.checkForUpdatesAndNotify() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('AgencyPlus');
    tray.setContextMenu(menu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
  } catch {
    // Tray icon is a nice-to-have; don't crash if it fails (headless CI, etc.)
  }
}

// ── App menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => autoUpdater.checkForUpdatesAndNotify() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Reload',  accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow?.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit',  submenu: [{ role:'undo' },{ role:'redo' },{ type:'separator' },{ role:'cut' },{ role:'copy' },{ role:'paste' },{ role:'selectAll' }] },
    { label: 'View',  submenu: [{ role:'resetZoom' },{ role:'zoomIn' },{ role:'zoomOut' },{ type:'separator' },{ role:'togglefullscreen' }] },
    { label: 'Window',submenu: [{ role:'minimize' },{ role:'zoom' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Open in Browser', click: () => shell.openExternal(APP_URL) },
        { label: 'Check for Updates…', click: () => autoUpdater.checkForUpdatesAndNotify() },
        ...(!IS_DEV ? [] : [{ type:'separator' },{ label:'DevTools', accelerator:'F12', click:()=>mainWindow?.webContents.toggleDevTools() }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Downloads silently, then prompts once the download is ready.
// Since the UI is served live, app-level updates here are rare — they only
// apply to the Electron wrapper itself (new native features, security patches).
function setupAutoUpdater() {
  if (IS_DEV) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: `AgencyPlus Desktop ${info.version} has been downloaded.`,
      detail:  'It will be installed when you quit the app. Restart now?',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) { app.isQuitting = true; autoUpdater.quitAndInstall(); }
    });
  });

  autoUpdater.on('error', (err) => {
    // Log silently — update failures must not interrupt the user.
    console.error('[auto-updater]', err?.message);
  });

  // Check on launch, then every 4 hours.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
// The preload exposes these to the renderer via contextBridge.
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:check-update', () => autoUpdater.checkForUpdatesAndNotify().catch(() => null));
ipcMain.on('app:badge', (_, count) => {
  if (process.platform === 'darwin') app.dock.setBadge(count > 0 ? String(count) : '');
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  createTray();
  setupAutoUpdater();

  app.on('activate', () => {
    // macOS: re-open when clicking the dock icon with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep running in the tray on Windows/Linux when all windows are closed.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => { app.isQuitting = true; });
