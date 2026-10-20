// Reads a remote machine's transcripts over the system `ssh` (so ~/.ssh/config,
// agents, ProxyJump etc. all work). The remote side only runs read-only POSIX
// tools (find, stat, tail, head, grep, awk, od, gzip), or python3 in python read
// mode (remote_reader.py, sent over stdin). Nothing is installed or written there.
//
// Passwords / passphrases / host-key questions go through SSH_ASKPASS, which
// calls back into our HTTP server so the web console can show a prompt.
// A ControlMaster socket keeps the session open so the user is asked once per sync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { LineSplitter } from '../core/lines.js';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const remotePath = (p) => (p.startsWith('~/') ? `"$HOME"/${q(p.slice(2))}` : q(p));

let askpass = null; // { script, url, token }
export function configureAskpass(cfg) {
  askpass = cfg;
}

// In the macOS app, ssh runs through net-disclaim (packaging/mac/disclaim.c) so
// Local Network privacy doesn't block LAN hosts. It sits in the outer app's
// Contents/MacOS; the sync worker runs as Electron's Helper (fork from the main
// process uses it on macOS), nested inside Contents/Frameworks, so look from the
// outermost .app in execPath. Elsewhere ssh runs directly.
const disclaim = (() => {
  if (process.platform !== 'darwin') return null;
  const app = /^(.*?\.app)\//.exec(process.execPath)?.[1];
  const p = app && path.join(app, 'Contents', 'MacOS', 'net-disclaim');
  return p && fs.existsSync(p) ? p : null;
})();

function controlDir() {
  const dir = path.join('/tmp', `net-ssh-${process.getuid?.() ?? 'u'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sshArgs(machine, { connectTimeout = 15 } = {}) {
  const a = [
    '-T',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlDir()}/%C`,
    '-o', 'ControlPersist=300',
  ];
  if (machine.port) a.push('-p', String(machine.port));
  if (machine.user) a.push('-l', machine.user);
  if (machine.identityFile) a.push('-i', machine.identityFile.replace(/^~(?=\/)/, os.homedir()));
  for (const o of machine.sshOptions || []) a.push('-o', o);
  a.push('--', machine.host, 'sh -s');
  return a;
}

// Runs `script` on the remote with `sh -s`; streams (possibly gzipped) stdout to onData.
function runRemote(machine, script, onData, opts) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (askpass) {
      Object.assign(env, {
        SSH_ASKPASS: askpass.script,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: env.DISPLAY || ':0',
        NET_ASKPASS_URL: askpass.url,
        NET_ASKPASS_TOKEN: askpass.token,
        NET_ASKPASS_MACHINE: machine.name || machine.host,
      });
    }
    // detached: no controlling tty, so ssh must use SSH_ASKPASS instead of the terminal.
    const [cmd, args] = disclaim ? [disclaim, ['ssh', ...sshArgs(machine, opts)]] : ['ssh', sshArgs(machine, opts)];
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    let failed = null;
    const deliver = (c) => {
      if (failed) return;
      try {
        onData(c);
      } catch (e) {
        failed = e;
        child.kill();
      }
    };
    // Output is gzip when the remote has gzip; sniff the magic bytes.
    let gunzip = null, sniffed = false;
    const gunzipDone = new Promise((res) => {
      child.stdout.on('data', (chunk) => {
        if (!sniffed) {
          sniffed = true;
          if (chunk[0] === 0x1f && chunk[1] === 0x8b) {
            gunzip = zlib.createGunzip();
            gunzip.on('data', deliver);
            gunzip.on('end', res);
            gunzip.on('error', (e) => {
              failed ??= e;
              res();
            });
          }
        }
        if (gunzip) gunzip.write(chunk);
        else deliver(chunk);
      });
      child.stdout.on('end', () => (gunzip ? gunzip.end() : res()));
    });
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', async (code) => {
      await gunzipDone;
      if (failed) return reject(failed);
      if (code !== 0) {
        const msg = stderr.trim().split('\n').slice(-3).join(' | ') || `ssh exited with ${code}`;
        const err = Object.assign(new Error(msg), { sshFailed: code === 255 }); // 255: ssh itself failed
        const hk = code === 255 && hostKeyChanged(stderr);
        if (hk) Object.assign(err, { message: `the host key of ${hk.name} has changed`, hostKeyChanged: hk });
        return reject(err);
      }
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// ssh refuses outright (no prompt) when a known host answers with another key: the
// address may now belong to someone else, or the box was reinstalled. Pull out what
// the console needs to explain it and, if the user says so, forget the old key.
export function hostKeyChanged(stderr) {
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) return null;
  const fp = /sent by the remote host is\s+(SHA256:[A-Za-z0-9+/=]+)/.exec(stderr);
  const off = /Offending \S+ key in (.+):(\d+)\s*$/m.exec(stderr);
  const name = /Host key for (\S+) has changed/.exec(stderr);
  return { fingerprint: fp?.[1] || null, file: off?.[1] || null, line: off ? Number(off[2]) : null, name: name?.[1] || null };
}

function listScript(extraRoots) {
  const roots = ['~/.claude/projects', '${XDG_CONFIG_HOME:-$HOME/.config}/claude/projects', ...extraRoots];
  const rootArgs = roots.map((r) => (r.startsWith('${') ? `"${r}"` : remotePath(r))).join(' ');
  return `
fp=$(cat /etc/machine-id 2>/dev/null)
[ -n "$fp" ] || fp=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
[ -n "$fp" ] || fp="host:$(hostname)"
echo "@@NET FP $fp"
echo "@@NET ADDR \${SSH_CONNECTION:-}"
os=$(uname -s)
# Python mode needs a real python3 >= 3.6. On macOS without the Command Line
# Tools, /usr/bin/python3 is a stub that pops an install dialog, so skip it there.
py=$(command -v python3 2>/dev/null)
if [ -n "$py" ] && [ "$os" = Darwin ] && [ "$py" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then py=; fi
if [ -n "$py" ]; then
  "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null && echo "@@NET PY $py"
fi
for r in ${rootArgs}; do
  [ -d "$r" ] || continue
  if [ "$os" = Darwin ]; then
    find "$r" -type f -name '*.jsonl' -exec stat -f '%i %z %N' {} +
  else
    find "$r" -type f -name '*.jsonl' -exec stat -c '%i %s %n' {} +
  fi
done
`;
}

function readScript(todo) {
  const calls = todo.map((t, i) => `emit ${i} ${q(t.path)} ${t.offset} ${t.len}`).join('\n');
  return `
emit() {
  p=$2; off=$3; len=$4
  if [ ! -f "$p" ]; then echo "@@NET GONE $1"; return; fi
  last=$(tail -c +$((off + len)) "$p" 2>/dev/null | head -c 1 | od -An -tx1 | tr -d ' \\n')
  part=0
  if [ "$last" != "0a" ]; then
    part=$(tail -c +$((off + 1)) "$p" | head -c "$len" | LC_ALL=C awk 'END { print length($0) }')
  fi
  n=$((len - part))
  echo "@@NET F $1 $((off + n))"
  if [ "$n" -gt 0 ]; then
    tail -c +$((off + 1)) "$p" | head -c "$n" | LC_ALL=C grep -a -F '"usage"'
  fi
  echo "@@NET E $1"
}
run() {
${calls}
}
if command -v gzip >/dev/null 2>&1; then run | gzip -1 -c; else run; fi
`;
}

// Python mode: parse on the remote and send back one small record per message.
const PY_READER = fs.readFileSync(new URL('./remote_reader.py', import.meta.url), 'utf8');
function pyScript(python, todo) {
  const list = Buffer.from(JSON.stringify(todo.map((t) => [t.path, t.offset, t.len]))).toString('base64');
  return `
run() {
${q(python)} - <<'NET_PY_EOF'
${PY_READER.replace('@@TODO@@', list)}
NET_PY_EOF
}
if command -v gzip >/dev/null 2>&1; then run | gzip -1 -c; else run; fi
`;
}

const MARK = '@@NET ';

export function createSshSource(machine, { log = () => {} } = {}) {
  // `host`, then `altHosts` in order. The first one that answers is used for the
  // rest of the sync; one that answers as a different machine is skipped.
  const hosts = [machine.host, ...(machine.altHosts || [])].filter(Boolean);
  let target = { ...machine, host: hosts[0] };
  return {
    async info() {
      const r = await this._list();
      return { fingerprint: r.fingerprint, address: r.address, host: target.host, mode: this._mode(r) };
    },

    async _list() {
      if (this._cached) return this._cached;
      const errors = [];
      let hostKeyIssue = null;
      for (const [n, host] of hosts.entries()) {
        const last = n === hosts.length - 1;
        // A fallback is declared to be the same box, so verify it against the host key
        // already trusted for the main host instead of asking again for every address.
        // A different key still fails.
        const alias = n > 0 && !(machine.sshOptions || []).some((o) => /^HostKeyAlias\b/i.test(o));
        target = { ...machine, host, sshOptions: [...(machine.sshOptions || []), ...(alias ? [`HostKeyAlias=${hosts[0]}`] : [])] };
        log(`connecting to ${host}`);
        try {
          // Fail over quickly when another address is left to try.
          const r = await this._listFrom(target, last ? 15 : 6);
          if (!last && machine.fingerprint && r.fingerprint !== machine.fingerprint) {
            errors.push(`${host}: a different machine (id ${r.fingerprint})`);
            log(`${host} is a different machine; trying the next address`);
            continue;
          }
          this._cached = r;
          return r;
        } catch (e) {
          if (e.hostKeyChanged) {
            // Fallbacks share the main host's key entry (HostKeyAlias), so only the main
            // host's entry can be forgotten from the console.
            Object.assign(e.hostKeyChanged, { host, main: n === 0 });
            hostKeyIssue ??= e.hostKeyChanged;
          }
          if (last || !e.sshFailed) {
            const out = hosts.length > 1 ? new Error([...errors, `${host}: ${e.message}`].join('; ')) : e;
            out.hostKeyChanged = hostKeyIssue;
            throw out;
          }
          errors.push(`${host}: ${e.message}`);
          log(e.hostKeyChanged ? `${host}: host key changed; trying the next address` : `${host} unreachable; trying the next address`);
        }
      }
    },

    async _listFrom(t, connectTimeout) {
      const files = new Map();
      let fingerprint = null, address = null, python = null;
      const sp = new LineSplitter((buf) => {
        const s = buf.toString('utf8');
        if (s.startsWith(MARK + 'FP ')) fingerprint = s.slice(MARK.length + 3).trim();
        else if (s.startsWith(MARK + 'ADDR ')) address = s.slice(MARK.length + 5).trim().split(/\s+/)[2] || null;
        else if (s.startsWith(MARK + 'PY ')) python = s.slice(MARK.length + 3).trim();
        else {
          const m = /^(\d+) (\d+) (.+)$/.exec(s);
          if (m) files.set(m[3], { path: m[3], ino: m[1], size: Number(m[2]) });
        }
      });
      await runRemote(t, listScript(machine.extraRoots || []), (c) => sp.push(c), { connectTimeout });
      return { fingerprint, address, python, files: [...files.values()] };
    },

    // machine.readMode: 'auto' (default) | 'python' | 'shell'
    _mode(r) {
      if (machine.readMode === 'shell') return 'shell';
      if (r.python) return 'python';
      if (machine.readMode === 'python') throw new Error('python3 >= 3.6 not found on the remote');
      return 'shell';
    },

    async list() {
      return (await this._list()).files;
    },

    exec(script, onData) {
      return runRemote(target, script, onData);
    },

    // onLine(i, line) for raw lines (shell mode) or onLine(i, null, record) (python mode).
    async read(todo, onLine, onDone) {
      const listed = await this._list();
      const mode = this._mode(listed);
      // Keep each ssh round trip bounded so a first sync makes visible progress.
      const BATCH_BYTES = (mode === 'python' ? 1024 : 256) << 20;
      let i = 0;
      while (i < todo.length) {
        let j = i, bytes = 0;
        while (j < todo.length && (j === i || bytes + todo[j].len <= BATCH_BYTES)) bytes += todo[j++].len;
        const base = i;
        let cur = -1;
        const newOffset = new Map(); // idx -> offset, filled by "F", confirmed by "E"
        const ended = [];
        const sp = new LineSplitter((buf) => {
          if (buf[0] === 0x40 && buf.subarray(0, MARK.length).toString() === MARK) {
            const [kind, idx, off] = buf.toString().slice(MARK.length).split(' ');
            if (kind === 'F') {
              cur = Number(idx);
              newOffset.set(cur, Number(off));
            } else if (kind === 'E') {
              ended.push(Number(idx));
              cur = -1;
            }
            return;
          }
          if (cur < 0) return;
          if (mode === 'shell') return onLine(base + cur, buf.toString('utf8'));
          const r = JSON.parse(buf.toString('utf8'));
          const ts = Date.parse(r[1]);
          if (!Number.isFinite(ts)) return;
          onLine(base + cur, null, {
            id: r[0],
            ts,
            model: r[2],
            project: r[3],
            tokens: { input: r[4], output: r[5], cacheRead: r[6], cacheWrite5m: r[7], cacheWrite1h: r[8] },
          });
        });
        const batch = todo.slice(i, j);
        const script = mode === 'python' ? pyScript(listed.python, batch) : readScript(batch);
        await runRemote(target, script, (c) => sp.push(c));
        // Cursors only move after the whole batch arrived; a broken connection just
        // means those bytes get read again (dedupe makes that harmless).
        for (const idx of ended) await onDone(base + idx, newOffset.get(idx));
        i = j;
      }
    },
  };
}
