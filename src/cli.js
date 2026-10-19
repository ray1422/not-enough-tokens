#!/usr/bin/env node
// net serve [--port N] [--host H]   start the web console
// net sync [machineId...]           sync machines (default: all)
// net prices                        refresh the auto price table
import { loadMachines } from './core/machines.js';
import { refreshPrices } from './core/pricing.js';
import { syncMachine } from './core/sync.js';
import { dataDir } from './core/store.js';

const [cmd = 'serve', ...args] = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

if (cmd === 'serve') {
  const { startServer } = await import('./server.js');
  const { url } = await startServer({ port: Number(flag('port', 4777)), host: flag('host', '127.0.0.1') });
  console.log(`console: ${url}\ndata:    ${dataDir()}`);
} else if (cmd === 'sync') {
  const p = await refreshPrices();
  if (p.lastError) console.error(`price refresh failed, using last snapshot: ${p.lastError}`);
  const ids = args.length ? args : loadMachines().map((m) => m.id);
  let failed = 0;
  for (const id of ids) {
    try {
      await syncMachine(id, (msg) => console.log(`[${id}] ${msg}`));
    } catch (e) {
      failed++;
      console.error(`[${id}] failed: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === 'prices') {
  const p = await refreshPrices();
  console.log(p.lastError ? `failed: ${p.lastError}` : `${Object.keys(p.auto).length} models, fetched ${p.fetchedAt}`);
} else {
  console.error('usage: net [serve|sync|prices]');
  process.exit(2);
}
