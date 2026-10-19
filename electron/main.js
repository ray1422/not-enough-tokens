// Electron shell: runs the same HTTP server in-process on a random loopback port
// and shows the console in a locked-down window. Works with a bundled Electron
// (macOS .app) or the system one on Linux (`electron /usr/lib/not-enough-tokens`).
import { BrowserWindow, app, nativeTheme, session, shell } from 'electron';
import { startServer } from '../src/server.js';

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null; // { url, openUrl }

const isHttp = (u) => /^https?:\/\//i.test(u);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 480,
    title: 'Not Enough Tokens',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#faf9f5',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
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
