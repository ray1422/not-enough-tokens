// Electron shell: runs the same HTTP server in-process on a random loopback port
// and shows the console in a locked-down window. Works with a bundled Electron
// (macOS .app) or the system one on Linux (`electron /usr/lib/not-enough-tokens`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, ipcMain, nativeTheme, session, shell } from 'electron';
import { startServer } from '../src/server.js';

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null; // { url, openUrl }

const isHttp = (u) => /^https?:\/\//i.test(u);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOP_BAR = 52; // .app-linux .topbar min-height

// The top bar doubles as the title bar. macOS draws its traffic lights over it;
// on Linux Electron draws the window buttons as an overlay, in the order the
// desktop's button layout gives, and the page leaves room via env(titlebar-area-*).
function titleBar() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } };
  if (process.platform !== 'linux') return {};
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#141413' : '#faf9f5', symbolColor: dark ? '#c2c0b6' : '#5e5d59', height: TOP_BAR },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 480,
    title: 'Not Enough Tokens',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#faf9f5',
    ...titleBar(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(HERE, 'preload.cjs'),
    },
  });

  // Only our own origin renders in the window; everything else opens in the browser.
  const origin = new URL(server.url).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin === origin) return;
    e.preventDefault();
    if (isHttp(url)) shell.openExternal(url);
  });
  win.on('closed', () => (win = null));
  win.loadURL(server.openUrl);
}

app.whenReady().then(async () => {
  // Off macOS the default menu bar only holds Electron's own items; About lives in
  // Settings. macOS dispatches ⌘C/⌘V/⌘W/⌘M through the menu (hidden items lose
  // them), so it keeps the app, Edit and Window menus; Close moves from the dropped
  // File menu into Window.
  const windowMenu = { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }] };
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, windowMenu]) : null);
  const hex = /^#[0-9a-f]{6}$/i;
  ipcMain.on('titlebar-colors', (e, c) => {
    if (!win || e.sender !== win.webContents || process.platform !== 'linux') return;
    if (hex.test(c?.color) && hex.test(c?.symbolColor)) win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor });
  });
  // The page needs no camera, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  server = await startServer({ port: 0, host: '127.0.0.1' });
  createWindow();
});

app.on('second-instance', () => {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on('activate', () => {
  if (server && !win) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
