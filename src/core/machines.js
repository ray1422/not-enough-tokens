// machines.json: the list of machines we collect from.
//   { id, name, type: 'local' | 'ssh', host?, altHosts?, user?, port?, identityFile?, readMode?,
//     extraRoots?, fingerprint?, lastHost?, lastAddress?, lastSyncAt?, lastError?, twinOf? }
// `id` is ours and never changes, so a machine keeps its history when its IP changes.
// `fingerprint` (machine-id / IOPlatformUUID) guards against an address now
// pointing at a different box. `altHosts` are tried in order when `host` can't be
// reached (e.g. LAN address first, then the Tailscale name). `twinOf` marks a new
// entry whose first sync found an existing machine; mergeInto() folds it in.
//
// machines/<id>/identity.json records the fingerprint next to the data, so the data
// of a removed machine can be picked up again when the same box is added back.
// That matters: Claude Code deletes old transcripts, so the ledger may be the only
// record of past usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, readJson, writeJson } from './store.js';
import { machineDir } from './ledger.js';

const file = () => path.join(dataDir(), 'machines.json');

export function loadMachines() {
  const data = readJson(file(), { machines: [] });
  if (!data.machines.some((m) => m.type === 'local')) {
    data.machines.unshift({ id: 'local', name: os.hostname().replace(/\.local$/, ''), type: 'local' });
    writeJson(file(), data);
  }
  return data.machines;
}

export function saveMachines(machines) {
  writeJson(file(), { machines });
}

export function getMachine(id) {
  const m = loadMachines().find((x) => x.id === id);
  if (!m) throw new Error(`unknown machine ${id}`);
  return m;
}

const EDITABLE = ['name', 'host', 'altHosts', 'user', 'port', 'identityFile', 'readMode', 'extraRoots'];

function clean(input) {
  const out = {};
  for (const k of EDITABLE) if (input[k] !== undefined) out[k] = input[k];
  if (out.name != null) out.name = String(out.name).trim();
  if (out.host != null) out.host = String(out.host).trim();
  if (out.user != null) out.user = String(out.user).trim() || undefined;
  if (out.port != null) out.port = Number(out.port) || undefined;
  if (out.identityFile != null) out.identityFile = String(out.identityFile).trim() || undefined;
  if (out.readMode != null && !['auto', 'python', 'shell'].includes(out.readMode)) out.readMode = 'auto';
  if (out.extraRoots != null) {
    const r = Array.isArray(out.extraRoots) ? out.extraRoots : String(out.extraRoots).split('\n');
    out.extraRoots = r.map((s) => s.trim()).filter(Boolean);
  }
  if (out.altHosts != null) {
    const r = Array.isArray(out.altHosts) ? out.altHosts : String(out.altHosts).split(/[\n,]/);
    out.altHosts = r.map((s) => String(s).trim()).filter(Boolean);
  }
  for (const h of [out.host, ...(out.altHosts || [])]) if (h && /^-/.test(h)) throw new Error('host must not start with "-"');
  return out;
}

export function addMachine(input) {
  const machines = loadMachines();
  const m = { id: crypto.randomBytes(4).toString('hex'), type: 'ssh', ...clean(input) };
  if (!m.host) throw new Error('host is required');
  m.name ||= m.host;
  machines.push(m);
  saveMachines(machines);
  return m;
}

export function updateMachine(id, input) {
  const machines = loadMachines();
  const m = machines.find((x) => x.id === id);
  if (!m) throw new Error(`unknown machine ${id}`);
  Object.assign(m, clean(input));
  if (input.resetFingerprint) delete m.fingerprint;
  saveMachines(machines);
  return m;
}

export function removeMachine(id, { purge = false } = {}) {
  if (id === 'local') throw new Error('cannot remove the local machine');
  saveMachines(loadMachines().filter((m) => m.id !== id));
  if (purge) fs.rmSync(machineDir(id), { recursive: true, force: true });
}

// Folds entry `id` (a new address of an existing box) into `targetId`: its host
// becomes a fallback of the target, or the target's main host (the old main host
// then goes first among the fallbacks). The entry itself is removed; it never
// collected data, since its sync stopped at the duplicate check.
export function mergeInto(id, targetId, { asMain = false } = {}) {
  const machines = loadMachines();
  const m = machines.find((x) => x.id === id);
  const target = machines.find((x) => x.id === targetId);
  if (!m || !target || m === target || target.type !== 'ssh') throw new Error('unknown machine');
  const added = [m.host, ...(m.altHosts || [])].filter(Boolean);
  const all = asMain ? [...added, target.host, ...(target.altHosts || [])] : [target.host, ...(target.altHosts || []), ...added];
  const hosts = [...new Set(all.filter(Boolean))];
  target.host = hosts[0];
  target.altHosts = hosts.slice(1);
  saveMachines(machines.filter((x) => x !== m));
  if (!fs.existsSync(path.join(machineDir(id), 'usage_hourly.csv'))) fs.rmSync(machineDir(id), { recursive: true, force: true });
  return target;
}

const identityFile = (id) => path.join(machineDir(id), 'identity.json');

export function writeIdentity(id, fingerprint) {
  if (readJson(identityFile(id), {}).fingerprint === fingerprint) return;
  fs.mkdirSync(machineDir(id), { recursive: true });
  writeJson(identityFile(id), { fingerprint });
}

// Data folders of the same box left behind by removed machines, newest first.
export function findOrphans(fingerprint) {
  const root = path.join(dataDir(), 'machines');
  const live = new Set(loadMachines().map((m) => m.id));
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {}
  return dirs
    .filter((d) => !live.has(d) && readJson(identityFile(d), {}).fingerprint === fingerprint)
    .map((d) => ({ id: d, mtime: fs.statSync(path.join(root, d)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((o) => o.id);
}

// Moves an orphan's data under `id`. Only when `id` has no data of its own yet.
export function adoptOrphan(id, orphanId) {
  const dir = machineDir(id);
  if (fs.existsSync(path.join(dir, 'usage_hourly.csv')) || fs.existsSync(path.join(dir, 'cursors.json'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(machineDir(orphanId), dir);
  return true;
}

export function patchMachine(id, patch) {
  const machines = loadMachines();
  const m = machines.find((x) => x.id === id);
  if (m) Object.assign(m, patch);
  saveMachines(machines);
  return m;
}
