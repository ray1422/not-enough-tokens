// Finds machines to add, from two passive sources (no port scans):
//   mdns       services announced on the LAN: _ssh._tcp / _sftp-ssh._tcp (SSH is
//              on), plus _companion-link._tcp and _airplay._tcp so Apple devices
//              show without SSH too; the AirPlay TXT model tells Macs (which can
//              turn it on) apart. Linux hosts only show with avahi announcing ssh.
//   tailscale  peers from `tailscale status --json`
// macOS answers mDNS through mDNSResponder (`dns-sd`, via net-disclaim so Local
// Network privacy allows it); elsewhere we send the queries ourselves over UDP, so
// no avahi is needed.
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { disclaimed } from './disclaim.js';

const SSH = ['_ssh._tcp', '_sftp-ssh._tcp'];
const APPLE = ['_companion-link._tcp', '_airplay._tcp'];
const isMac = (model) => /^(Mac|iMac|MacBook|Macmini|MacPro)/.test(model || '');
const usable = (a) => a !== '127.0.0.1' && a !== '::1' && !/^fe80:/i.test(a);
const SERVICES = [...SSH, ...APPLE];

const short = (h) => String(h || '').replace(/\.$/, '').replace(/\.local$/i, '').toLowerCase();

// ---------- mDNS over UDP ----------
function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function query(questions) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(questions.length, 4);
  const qs = questions.map(([name, type]) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // IN
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([head, ...qs]);
}

function readName(buf, off) {
  const labels = [];
  let jumped = false;
  let end = off;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[off];
    if (len === undefined) throw new Error('truncated');
    if (len === 0) {
      if (!jumped) end = off + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = buf.readUInt16BE(off) & 0x3fff;
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), end];
}

// Every record in a response: { name, type, data }.
export function parseMdns(buf) {
  const out = [];
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  for (let i = 0; i < rr; i++) {
    const [name, o] = readName(buf, off);
    const type = buf.readUInt16BE(o);
    const len = buf.readUInt16BE(o + 8);
    const at = o + 10;
    off = at + len;
    let data = null;
    if (type === 12) data = readName(buf, at)[0]; // PTR
    else if (type === 33) data = { port: buf.readUInt16BE(at + 4), target: readName(buf, at + 6)[0] }; // SRV
    else if (type === 16) {
      data = [];
      for (let p = at; p < at + len; p += 1 + buf[p]) data.push(buf.toString('utf8', p + 1, p + 1 + buf[p]));
    } // TXT
    else if (type === 1 && len === 4) data = [...buf.subarray(at, at + 4)].join('.'); // A
    else if (type === 28 && len === 16) data = buf.subarray(at, at + 16).toString('hex').match(/.{4}/g).join(':').replace(/(^|:)0{1,3}/g, '$1'); // AAAA
    else continue;
    out.push({ name, type, data });
  }
  return out;
}

// Legacy unicast queries (from a random port, so answers come straight back).
function mdnsUdp(ms) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const recs = [];
    sock.on('message', (m) => {
      try {
        recs.push(...parseMdns(m));
      } catch {}
    });
    sock.on('error', reject);
    const send = (qs) => sock.send(query(qs), 5353, '224.0.0.251');
    sock.bind(0, () => {
      sock.setMulticastTTL(255);
      const ask = () => send(SERVICES.map((s) => [`${s}.local`, 12]));
      ask();
      // Ask again, and for the addresses of hosts we have no A record for yet.
      setTimeout(() => {
        ask();
        const have = new Set(recs.filter((r) => r.type === 1).map((r) => r.name.toLowerCase()));
        const want = [...new Set(recs.filter((r) => r.type === 33).map((r) => r.data.target))].filter((t) => !have.has(t.toLowerCase()));
        if (want.length) send(want.map((t) => [t, 1]));
      }, ms / 2);
      setTimeout(() => {
        sock.close();
        resolve(recs);
      }, ms);
    });
  });
}

// ---------- mDNS via dns-sd (macOS) ----------
const unescape = (s) => s.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d))).replace(/\\(.)/g, '$1');

function runFor(cmd, args, ms) {
  return new Promise((resolve) => {
    const [c, a] = disclaimed(cmd, args);
    let out = '';
    const p = spawn(c, a, { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(''));
    setTimeout(() => {
      p.kill();
      resolve(out);
    }, ms);
  });
}

async function mdnsDnsSd(ms) {
  const recs = [];
  const zones = await Promise.all(SERVICES.map((s) => runFor('dns-sd', ['-Z', s, 'local'], ms * 0.6)));
  zones.forEach((z, i) => {
    for (const line of z.split('\n')) {
      const txt = /^(.+?)\.(_[\w-]+\._(?:tcp|udp))\s+TXT\s+(.*)$/.exec(line);
      if (txt) recs.push({ name: `${unescape(txt[1])}.${SERVICES[i]}.local`, type: 16, data: [...txt[3].matchAll(/"([^"]*)"/g)].map((x) => x[1]) });
      const m = /^(.+?)\.(_[\w-]+\._(?:tcp|udp))\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const inst = `${unescape(m[1])}.${SERVICES[i]}.local`;
      recs.push({ name: `${SERVICES[i]}.local`, type: 12, data: inst });
      recs.push({ name: inst, type: 33, data: { port: Number(m[3]), target: m[4].replace(/\.$/, '') } });
    }
  });
  const targets = [...new Set(recs.filter((r) => r.type === 33).map((r) => r.data.target))];
  const addrs = await Promise.all(targets.map((h) => runFor('dns-sd', ['-G', 'v4', h], ms * 0.4)));
  addrs.forEach((out, i) => {
    for (const m of out.matchAll(/\s(\d+\.\d+\.\d+\.\d+)\s/g)) recs.push({ name: targets[i], type: 1, data: m[1] });
  });
  return recs;
}

// Records -> one entry per host.
function hostsFrom(recs) {
  const inst = new Map(); // instance -> { service, label }
  for (const r of recs) {
    const service = r.type === 12 && SERVICES.find((s) => r.name.startsWith(s));
    if (service) inst.set(r.data, { service, label: r.data.split('.')[0] });
  }
  const model = new Map(); // instance -> TXT model
  for (const r of recs) for (const kv of r.type === 16 ? r.data : []) if (kv.startsWith('model=')) model.set(r.name, kv.slice(6));
  const hosts = new Map();
  for (const r of recs) {
    if (r.type !== 33 || !inst.has(r.name)) continue;
    const { service, label } = inst.get(r.name);
    const host = r.data.target.replace(/\.$/, '');
    const h = hosts.get(host.toLowerCase()) || { host, label, addrs: [], ssh: null, model: null, apple: false };
    if (SSH.includes(service)) h.ssh = h.ssh ?? r.data.port;
    if (APPLE.includes(service)) (h.apple = true), (h.model = model.get(r.name) || h.model), (h.label = label);
    hosts.set(host.toLowerCase(), h);
  }
  for (const r of recs) {
    const h = (r.type === 1 || r.type === 28) && hosts.get(r.name.replace(/\.$/, '').toLowerCase());
    if (h && usable(r.data) && !h.addrs.includes(r.data)) h.addrs.push(r.data);
  }
  return [...hosts.values()];
}

async function fromMdns(ms) {
  const recs = process.platform === 'darwin' ? await mdnsDnsSd(ms) : await mdnsUdp(ms);
  return hostsFrom(recs);
}

// ---------- Tailscale ----------
const TAILSCALE = ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
// The macOS app binary only acts as the CLI when it looks run from a shell (TERM or
// SHLVL set); launched from our app it would start as a second GUI and never exit.
const cliEnv = () => (process.env.TERM || process.env.SHLVL ? process.env : { ...process.env, TERM: 'dumb' });

function tailscaleStatus() {
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= TAILSCALE.length) return reject(Object.assign(new Error('tailscale not found'), { reason: 'missing' }));
      if (TAILSCALE[i].startsWith('/') && !fs.existsSync(TAILSCALE[i])) return tryAt(i + 1);
      execFile(TAILSCALE[i], ['status', '--json'], { timeout: 4000, maxBuffer: 8 << 20, env: cliEnv() }, (err, out, stderr) => {
        if (err?.code === 'ENOENT') return tryAt(i + 1);
        // It exits non-zero when stopped but still prints the status.
        try {
          return resolve(JSON.parse(out));
        } catch {}
        reject(new Error(String(stderr || err?.message || 'no status').trim().split('\n').pop()));
      });
    };
    tryAt(0);
  });
}

async function fromTailscale() {
  const st = await tailscaleStatus();
  if (st.BackendState && st.BackendState !== 'Running') throw Object.assign(new Error(`Tailscale is ${st.BackendState}`), { reason: 'stopped' });
  return Object.values(st.Peer || {}).map((p) => ({
    host: String(p.DNSName || '').replace(/\.$/, ''),
    // iOS reports HostName "localhost"; its DNS name is the useful one.
    label: !p.HostName || p.HostName === 'localhost' ? String(p.DNSName || '').split('.')[0] : p.HostName,
    ips: p.TailscaleIPs || [],
    os: p.OS || '',
    online: !!p.Online,
  }));
}

// ---------- merge ----------
// { sources: { mdns: {ok, error?}, tailscale: {...} }, machines: [...] }
export async function discover({ sources = ['mdns', 'tailscale'], ms = 2500, includeSelf = false } = {}) {
  const want = new Set(sources);
  const [md, ts] = await Promise.allSettled([
    want.has('mdns') ? fromMdns(ms) : Promise.resolve(null),
    want.has('tailscale') ? fromTailscale() : Promise.resolve(null),
  ]);
  // reason: 'missing' | 'stopped' | 'error'; error is the detail.
  const status = (r, on) =>
    !on ? { ok: false, off: true } : r.status === 'fulfilled' ? { ok: true } : { ok: false, reason: r.reason?.reason || 'error', error: r.reason?.message || String(r.reason) };

  // One entry per source and host, never merged: names prove nothing, and testing
  // the connection reads the fingerprint to tell which machine an entry really is.
  const self = new Set([short(os.hostname())]);
  const selfIps = new Set(Object.values(os.networkInterfaces()).flat().map((i) => i.address));
  const machines = [];
  for (const h of (md.status === 'fulfilled' && md.value) || []) {
    if (!includeSelf && (self.has(short(h.host)) || h.addrs.some((a) => selfIps.has(a)))) continue;
    // kind: 'mac' can turn SSH on; 'device' is an Apple phone/tablet/TV (no SSH, not a Mac).
    const kind = isMac(h.model) ? 'mac' : h.apple && h.ssh == null ? 'device' : 'host';
    machines.push({ key: `mdns:${short(h.host)}`, name: h.label, mdns: { host: h.host, addrs: h.addrs, ssh: h.ssh, kind, model: h.model }, tailscale: null });
  }
  for (const p of (ts.status === 'fulfilled' && ts.value) || []) {
    const key = short(p.host.split('.')[0]);
    if (!includeSelf && self.has(key)) continue;
    machines.push({ key: `ts:${key}`, name: p.label, mdns: null, tailscale: { host: p.host, ips: p.ips, os: p.os, online: p.online } });
  }
  return {
    sources: { mdns: status(md, want.has('mdns')), tailscale: status(ts, want.has('tailscale')) },
    machines: machines.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
