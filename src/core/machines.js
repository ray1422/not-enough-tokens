// machines.json: the list of machines we collect from.
//   { id, name, type: 'local' | 'ssh', host?, user?, port?, identityFile?, readMode?, extraRoots?,
//     fingerprint?, lastAddress?, lastSyncAt?, lastError? }
// `id` is ours and never changes, so a machine keeps its history when its IP changes.
// `fingerprint` (machine-id / IOPlatformUUID) guards against an address now
// pointing at a different box.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, readJson, writeJson } from './store.js';

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

const EDITABLE = ['name', 'host', 'user', 'port', 'identityFile', 'readMode', 'extraRoots'];

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
  if (out.host && /^-/.test(out.host)) throw new Error('host must not start with "-"');
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

export function removeMachine(id) {
  if (id === 'local') throw new Error('cannot remove the local machine');
  saveMachines(loadMachines().filter((m) => m.id !== id));
}

export function patchMachine(id, patch) {
  const machines = loadMachines();
  const m = machines.find((x) => x.id === id);
  if (m) Object.assign(m, patch);
  saveMachines(machines);
  return m;
}
