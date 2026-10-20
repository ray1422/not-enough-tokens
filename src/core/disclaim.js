// In the macOS app, LAN tools (ssh, dns-sd) run through net-disclaim
// (packaging/mac/disclaim.c) so Local Network privacy doesn't block them. It sits
// in the outer app's Contents/MacOS; the sync worker runs as Electron's Helper
// (fork from the main process uses it on macOS), nested inside
// Contents/Frameworks, so look from the outermost .app in execPath. Elsewhere,
// and when run from source, commands run directly.
import fs from 'node:fs';
import path from 'node:path';

const helper = (() => {
  if (process.platform !== 'darwin') return null;
  const app = /^(.*?\.app)\//.exec(process.execPath)?.[1];
  const p = app && path.join(app, 'Contents', 'MacOS', 'net-disclaim');
  return p && fs.existsSync(p) ? p : null;
})();

// [command, args] to pass to spawn/execFile.
export const disclaimed = (cmd, args) => (helper ? [helper, [cmd, ...args]] : [cmd, args]);
