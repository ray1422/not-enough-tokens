// The only bridge from the page to Electron: on Linux the window buttons are an
// overlay drawn by Electron over the top bar, and the page tells it the top bar's
// colors when the theme changes. Main validates the colors and the sender.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netApp', {
  setTitleBarColors: (color, symbolColor) => ipcRenderer.send('titlebar-colors', { color, symbolColor }),
});
