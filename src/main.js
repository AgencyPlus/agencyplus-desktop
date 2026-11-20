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
  Menu, Tray, nativeImage, dialog, Notification, net,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { autoUpdater } = require('electron-updater');

// ── Configuration ─────────────────────────────────────────────────────────────
// The live website. AGENCYPLUS_URL overrides it (another domain, or a test
// site); the dev override lets you point at localhost:3000 during development.
const APP_URL  = process.env.AGENCYPLUS_URL || 'https://agencyplus.com.et';
const IS_DEV   = !app.isPackaged;
const ICON_PATH = path.join(__dirname, '../assets/icon.png');

let mainWindow = null;
let tray       = null;

// ── v1.0.2 — this computer's notifications ───────────────────────────────────
// A browser receives its alerts from a push service even with the page shut.
// The desktop app has none, so this process checks the server itself about
// once a minute and shows each alert as a normal system notification. It
// keeps doing so after the person signs out — the computer stays bound to the
// last person who signed in on it (each staff member has their own computer),
// like a bank app keeps alerting the phone it knows. Signing in as someone
// else hands the computer over to them.
//
// The device token is random, made here once and kept in this computer's app
// data; the server only ever stores its hash.
const DEVICE_FILE = () => path.join(app.getPath('userData'), 'device.json');
let device = { token: null, apiBase: null, startAtLogin: true };
let feedTimer = null;
let feedDelay = 60 * 1000;

function loadDevice() {
  try { device = { ...device, ...JSON.parse(fs.readFileSync(DEVICE_FILE(), 'utf8')) }; } catch { /* first run */ }
  if (!device.token || !/^[A-Za-z0-9_-]{32,200}$/.test(device.token)) {
    device.token = crypto.randomBytes(32).toString('base64url');
    saveDevice();
  }
}
function saveDevice() {
  try { fs.writeFileSync(DEVICE_FILE(), JSON.stringify(device, null, 2), 'utf8'); } catch { /* read-only profile */ }
}

/** Open the app on a page (a notification's link). */
function openAt(url) {
  const origin = new URL(APP_URL).origin;
  const target = url && String(url).startsWith('/') ? `${origin}${url}` : origin;
  if (!mainWindow) createWindow(target);
  else {
    if (url) mainWindow.loadURL(target);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function showItem(item) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: String(item.title || 'AgencyPlus').slice(0, 120),
    body: String(item.body || '').slice(0, 300),
    icon: ICON_PATH,
    silent: false,
  });
  n.on('click', () => openAt(item.url || '/notifications'));
  n.show();
}

async function checkFeed() {
  if (!device.apiBase || !device.token) return;
  try {
    const res = await net.fetch(`${device.apiBase.replace(/\/+$/, '')}/device/feed`, {
      headers: { 'X-Device-Token': device.token, Accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 401) { feedDelay = 5 * 60 * 1000; return; }   // not registered yet
    if (res.status === 429) { feedDelay = 3 * 60 * 1000; return; }
    if (!res.ok) { feedDelay = 2 * 60 * 1000; return; }
    feedDelay = 60 * 1000;
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    // Many at once (the computer was asleep): the newest few, then one summary.
    items.slice(-4).forEach(showItem);
    if (items.length > 4) showItem({ title: 'AgencyPlus', body: `${items.length - 4} more notifications`, url: '/notifications' });
    if (process.platform === 'darwin' && items.length) app.dock.bounce('informational');
  } catch {
    feedDelay = 2 * 60 * 1000;   // offline — try again later
  }
}

function scheduleFeed() {
  clearTimeout(feedTimer);
  feedTimer = setTimeout(async () => { await checkFeed(); scheduleFeed(); }, feedDelay);
}

function applyStartAtLogin() {
  if (IS_DEV || process.platform === 'linux') return;
  try { app.setLoginItemSettings({ openAtLogin: !!device.startAtLogin, openAsHidden: true, args: ['--hidden'] }); } catch { /* not allowed */ }
}

// ── Window creation ───────────────────────────────────────────────────────────
function createWindow(startUrl) {
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
    mainWindow.loadURL(startUrl || APP_URL);
  }

  // Show only after the first paint so there's no flash of a white window.
  // Started with the computer (--hidden): stay in the tray, keep notifying.
  const startHidden = process.argv.includes('--hidden') && !startUrl;
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
    if (IS_DEV) mainWindow.maximize();
  });

  // v1.0.2 — closing the window keeps AgencyPlus in the tray, so this
  // computer's notifications keep arriving. Quit from the tray menu.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
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
      { label: 'Notifications', click: () => openAt('/notifications') },
      { type: 'separator' },
      {
        label: 'Start when the computer starts', type: 'checkbox', checked: !!device.startAtLogin,
        click: (item) => { device.startAtLogin = item.checked; saveDevice(); applyStartAtLogin(); },
      },
      { label: 'Check for updates…', click: () => autoUpdater.checkForUpdatesAndNotify() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('AgencyPlus');
    tray.setContextMenu(menu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
    tray.on('click', () => { if (process.platform === 'win32') { if (mainWindow) mainWindow.show(); else createWindow(); } });
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
// v1.0.2 — the web app registers this computer for the person who signed in
// (it sends the token to the server with their login) and tells this process
// where the API is, so the background check can run after they sign out.
ipcMain.handle('device:token', () => device.token);
ipcMain.handle('device:set-api', (_, apiBase) => {
  const base = String(apiBase || '');
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return false;
  if (device.apiBase !== base) { device.apiBase = base; saveDevice(); }
  feedDelay = 5 * 1000;   // check soon after a sign-in
  scheduleFeed();
  return true;
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
// One running copy: a second launch just brings the window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
}

app.whenReady().then(() => {
  // Windows shows notifications only for an app with an id.
  if (process.platform === 'win32') app.setAppUserModelId('com.agencyplus.desktop');
  loadDevice();
  applyStartAtLogin();
  buildMenu();
  createWindow();
  createTray();
  setupAutoUpdater();
  scheduleFeed();

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
