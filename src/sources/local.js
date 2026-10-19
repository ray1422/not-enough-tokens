// Reads this machine's transcripts directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { LineSplitter, mayHaveUsage } from '../core/lines.js';

export function defaultRoots() {
  const home = os.homedir();
  const roots = [path.join(home, '.claude', 'projects'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude', 'projects')];
  if (process.env.CLAUDE_CONFIG_DIR) roots.unshift(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  return [...new Set(roots)];
}

const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export function localFingerprint() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = /"IOPlatformUUID" = "([^"]+)"/.exec(out);
      if (m) return m[1];
    } else {
      return fs.readFileSync('/etc/machine-id', 'utf8').trim();
    }
  } catch {}
  return `host:${os.hostname()}`;
}

export function createLocalSource(machine) {
  const roots = [...defaultRoots(), ...(machine.extraRoots || []).map(expand)];

  return {
    async info() {
      return { fingerprint: localFingerprint(), address: null };
    },

    // Runs a POSIX sh script locally (same scripts as on remotes).
    exec(script, onData) {
      return new Promise((resolve, reject) => {
        const c = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] });
        c.stdout.on('data', onData);
        c.on('error', reject);
        c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`sh exited with ${code}`))));
        c.stdin.end(script);
      });
    },

    async list() {
      const out = [];
      const walk = (dir) => {
        let ents;
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && e.name.endsWith('.jsonl')) {
            try {
              const st = fs.statSync(p);
              out.push({ path: p, ino: String(st.ino), size: st.size });
            } catch {}
          }
        }
      };
      for (const r of new Set(roots)) walk(r);
      return out;
    },

    // For each {path, offset, len}: calls onLine(i, lineString) for candidate lines
    // and onDone(i, newOffset) where newOffset stops at the last complete line.
    async read(todo, onLine, onDone) {
      for (let i = 0; i < todo.length; i++) {
        const t = todo[i];
        const sp = new LineSplitter((buf) => {
          if (mayHaveUsage(buf)) onLine(i, buf.toString('utf8'));
        });
        try {
          await new Promise((resolve, reject) => {
            fs.createReadStream(t.path, { start: t.offset, end: t.offset + t.len - 1, highWaterMark: 1 << 20 })
              .on('data', (c) => sp.push(c))
              .on('end', resolve)
              .on('error', reject);
          });
        } catch (e) {
          if (e.code === 'ENOENT') continue; // deleted while syncing
          throw e;
        }
        await onDone(i, t.offset + t.len - sp.pending);
      }
    },
  };
}
