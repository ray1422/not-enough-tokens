// Runs one machine's sync in a child process. A first sync allocates a lot
// (hundreds of MB of short-lived objects while parsing); a worker thread frees its
// heap on exit but the process keeps the pages, so only a separate process really
// gives the memory back. The long-running server/Electron process stays small.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchMachine } from './machines.js';

const CHILD_FLAG = '--net-sync-child';

export function syncInWorker(id, askpass, log = () => {}) {
  return new Promise((resolve, reject) => {
    // Under Electron, execPath is the Electron binary: run the child as plain Node.
    const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let settled = false;
    const settle = (fn, v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };
    child.on('message', (m) => {
      if (m.type === 'log') log(m.msg, m.extra);
      else if (m.type === 'patch') patchMachine(id, m.patch);
      else if (m.type === 'done') settle(resolve, m.result);
      else if (m.type === 'error') settle(reject, new Error(m.error));
    });
    child.on('error', (e) => settle(reject, e));
    child.on('exit', (code) => settle(reject, new Error(`sync process exited with code ${code}`)));
    child.send({ id, askpass });
  });
}

if (process.argv.includes(CHILD_FLAG) && process.send) {
  process.once('message', async ({ id, askpass }) => {
    const { configureAskpass } = await import('../sources/ssh.js');
    const { syncMachine } = await import('./sync.js');
    if (askpass) configureAskpass(askpass);
    const send = (m) => new Promise((res) => process.send(m, res));
    try {
      const result = await syncMachine(
        id,
        (msg, extra) => process.send({ type: 'log', msg, extra }),
        (_id, patch) => process.send({ type: 'patch', patch }),
      );
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message });
    }
    process.disconnect();
  });
}
