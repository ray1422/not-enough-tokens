// The only bridge from the page to Electron: on Linux the window buttons are an
// overlay drawn by Electron over the top bar, and the page tells it the top bar's
// colors when the theme changes; and the display scale (Settings -> UI tuning),
// which main also needs so the window buttons stay centered on the top bar. Main
// validates the values and the sender.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('netApp', {
  setTitleBarColors: (color, symbolColor) => ipcRenderer.send('titlebar-colors', { color, symbolColor }),
  setZoom: (factor) => {
    const z = Number(factor);
    if (!(z >= 0.5 && z <= 2)) return;
    webFrame.setZoomFactor(z);
    ipcRenderer.send('zoom', z);
  },
});
