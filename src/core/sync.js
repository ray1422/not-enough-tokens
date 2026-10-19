// Incremental sync of one machine: only bytes past each file's cursor are read.
import { Ledger, SEEN_RETENTION_DAYS } from './ledger.js';
import { getMachine, loadMachines, patchMachine } from './machines.js';
import { parseLine, projectFromPath } from './parse.js';
import { loadPrices } from './pricing.js';
import { resolveNewProjects } from './projects.js';
import { createLocalSource } from '../sources/local.js';
import { createSshSource } from '../sources/ssh.js';

const running = new Set();

// `patch` updates machines.json; a worker passes one that forwards to the main thread
// so parallel syncs never race on that file.
export async function syncMachine(id, log = () => {}, patch = patchMachine) {
  if (running.has(id)) throw new Error('already syncing');
  running.add(id);
  const started = Date.now();
  try {
    const m = getMachine(id);
    const src = m.type === 'local' ? createLocalSource(m) : createSshSource(m);
    log(m.type === 'local' ? 'scanning local files' : `connecting to ${m.host}`);

    const info = await src.info();
    if (m.fingerprint && info.fingerprint !== m.fingerprint) {
      throw new Error(
        `${m.host} is now a different machine (id ${info.fingerprint}, expected ${m.fingerprint}). ` +
          'Fix the host, or reset its identity in the machine settings.',
      );
    }
    const twin = loadMachines().find((x) => x.id !== id && x.fingerprint && x.fingerprint === info.fingerprint);
    if (twin) throw new Error(`this is the same machine as "${twin.name}"; not syncing it twice`);
    patch(id, { fingerprint: info.fingerprint, ...(info.address ? { lastAddress: info.address } : {}) });
    if (info.mode) log(`read mode: ${info.mode}`);

    const files = await src.list();
    const ledger = new Ledger(id);
    const minTs = Date.now() - SEEN_RETENTION_DAYS * 86400_000;
    const todo = [];
    for (const f of files) {
      const cur = ledger.cursors[f.path];
      const reset = !!cur && (cur.ino !== f.ino || f.size < cur.offset);
      const start = cur && !reset ? cur.offset : 0;
      if (f.size > start) todo.push({ path: f.path, ino: f.ino, offset: start, len: f.size - start, reset });
    }
    const live = new Set(files.map((f) => f.path));
    for (const p of Object.keys(ledger.cursors)) if (!live.has(p)) delete ledger.cursors[p];

    const total = todo.reduce((s, t) => s + t.len, 0);
    log(`${files.length} files, ${todo.length} changed, ${fmtBytes(total)} to read`);
    const prices = loadPrices();
    let done = 0, lastSave = Date.now(), lastLog = 0;
    await src.read(
      todo,
      (i, line, parsed) => {
        const t = todo[i];
        const rec = parsed || parseLine(line, projectFromPath(t.path));
        if (rec) ledger.add(rec, prices, t.reset ? { minTs } : {});
      },
      (i, offset) => {
        const t = todo[i];
        ledger.cursors[t.path] = { ino: t.ino, offset };
        done += t.len;
        if (Date.now() - lastLog > 1000) {
          lastLog = Date.now();
          log(`read ${fmtBytes(done)} / ${fmtBytes(total)}`, { progress: total ? done / total : 1 });
        }
        if (Date.now() - lastSave > 30_000) {
          ledger.save();
          lastSave = Date.now();
        }
      },
    );
    ledger.save();
    try {
      const cwds = [...ledger.buckets.values()].map((b) => b.project);
      const n = await resolveNewProjects(id, cwds, (script, onData) => src.exec(script, onData));
      if (n) log(`mapped ${n} new project paths to git repos`);
    } catch (e) {
      log(`project grouping skipped: ${e.message}`);
    }
    const result = { files: files.length, changed: todo.length, bytes: total, messages: ledger.added, ms: Date.now() - started };
    patch(id, { lastSyncAt: new Date().toISOString(), lastError: null });
    log(`done: ${result.messages} message updates in ${(result.ms / 1000).toFixed(1)}s`, { progress: 1 });
    return result;
  } catch (e) {
    patch(id, { lastError: e.message });
    throw e;
  } finally {
    running.delete(id);
  }
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}
