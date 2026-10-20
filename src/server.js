// Local HTTP server for the web console (also what Electron loads).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, readJson, writeAtomic, writeJson } from './core/store.js';
import { addMachine, loadMachines, mergeInto, patchMachine, removeMachine, updateMachine } from './core/machines.js';
import { KINDS, loadPrices, lookup, refreshPrices, savePrices } from './core/pricing.js';
import { COLS, Ledger, readUsageRows } from './core/ledger.js';
import { loadProjects } from './core/projects.js';
import { syncInWorker } from './core/sync-worker.js';
import { discover } from './core/discover.js';
import { testSsh } from './sources/ssh.js';
import { loadSettings, saveSettings } from './core/settings.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PRICE_MAX_AGE = 6 * 3600_000;
const VERSION = JSON.parse(fs.readFileSync(path.join(WEB, '..', 'package.json'), 'utf8')).version;

// ---------- events (SSE) ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- askpass ----------
// ssh runs askpass.sh, which POSTs the prompt here and blocks until the user answers.
const askToken = crypto.randomBytes(24).toString('hex');
const pendingAsks = new Map(); // id -> { prompt, machine, resolve }
let askpassConfig = null; // handed to each sync worker

function installAskpass(url) {
  const script = path.join(dataDir(), 'askpass.sh');
  writeAtomic(
    script,
    `#!/bin/sh
# Installed by not-enough-tokens: forwards ssh's prompt to the web console.
exec curl -sSf --max-time 900 -H "Authorization: Bearer $NET_ASKPASS_TOKEN" \\
  --data-urlencode "machine=$NET_ASKPASS_MACHINE" --data-urlencode "prompt=$1" "$NET_ASKPASS_URL"
`,
  );
  fs.chmodSync(script, 0o700);
  askpassConfig = { script, url: `${url}/api/askpass`, token: askToken };
}

// ---------- sync job ----------
let job = null; // { id, results }

async function runSync(ids) {
  const jobId = crypto.randomBytes(4).toString('hex');
  job = { id: jobId, running: new Set(ids), results: {} };
  broadcast('sync', { state: 'start', ids });
  const p = loadPrices();
  if (!p.fetchedAt || Date.now() - Date.parse(p.fetchedAt) > PRICE_MAX_AGE) {
    broadcast('log', { machine: '*', msg: 'refreshing price table' });
    const r = await refreshPrices();
    broadcast('log', { machine: '*', msg: r.lastError ? `price refresh failed: ${r.lastError}` : `prices updated (${Object.keys(r.auto).length} models)` });
  }
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const r = await syncInWorker(id, askpassConfig, (msg, extra) => broadcast('log', { machine: id, msg, ...extra }));
        job.results[id] = { ok: true, ...r };
      } catch (e) {
        job.results[id] = { ok: false, error: e.message };
        broadcast('log', { machine: id, msg: `failed: ${e.message}`, error: true });
      } finally {
        job.running.delete(id);
      }
    }),
  );
  broadcast('sync', { state: 'done', results: job.results });
  job = null;
}

// ---------- host key changed ----------
// Removes the main host's old key from the known_hosts file ssh named, so the next
// connection asks to trust the new key (and the fingerprint check still has to pass
// before anything is read). Only acts on what the last sync recorded, never on input.
function forgetHostKey(id) {
  const m = loadMachines().find((x) => x.id === id);
  const hk = m?.hostKeyIssue;
  if (!hk?.main || !hk.name || !hk.file || /^-/.test(hk.name)) throw new Error('nothing to forget');
  if (!fs.statSync(hk.file).isFile()) throw new Error('known_hosts file not found');
  return new Promise((resolve, reject) => {
    execFile('ssh-keygen', ['-R', hk.name, '-f', hk.file], (err, _out, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      patchMachine(id, { hostKeyIssue: null, lastError: null });
      resolve({ ok: true });
    });
  });
}

// ---------- usage ----------
function usagePayload(ids) {
  const cols = COLS;
  const out = {};
  for (const id of ids) {
    out[id] = readUsageRows(id).map((r) => cols.map((c) => (c === 'project' || c === 'model' ? r[c] : Number(r[c]) || 0)));
  }
  const projects = Object.fromEntries(ids.map((id) => [id, loadProjects(id)]));
  return { cols, machines: out, projects };
}

function unpricedModels() {
  const res = {};
  for (const m of loadMachines()) {
    for (const r of readUsageRows(m.id)) {
      const t = KINDS.reduce((s, k) => s + (Number(r['u_' + k]) || 0), 0);
      if (t) res[r.model] = (res[r.model] || 0) + t;
    }
  }
  return res;
}

function pricesPayload() {
  const p = loadPrices();
  const models = new Set();
  for (const m of loadMachines()) for (const r of readUsageRows(m.id)) models.add(r.model);
  const used = {};
  for (const name of [...models].sort()) {
    used[name] = { auto: p.auto?.[name] || lookup({ auto: p.auto, manual: {} }, name), manual: p.manual?.[name] || null };
  }
  return { fetchedAt: p.fetchedAt, lastError: p.lastError || null, source: p.source, used, unpriced: unpricedModels() };
}

function parsePrice(x) {
  const out = {};
  for (const k of KINDS) {
    const v = Number(x?.[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid price for ${k}`);
    out[k] = v;
  }
  return out;
}

// ---------- http plumbing ----------
// Only our own scripts/styles; Google Fonts is the one outside origin (fonts are optional).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// ---------- access token ----------
// The server binds to loopback only, but other local programs and web pages in a
// browser can still reach 127.0.0.1. Every request therefore needs a secret: it is
// handed over once as ?token=... (URL printed by the CLI / opened by Electron) and
// then kept in an HttpOnly, SameSite=Strict cookie. Stored 0600 in the data dir so
// bookmarks survive restarts.
function loadOrCreateToken() {
  const file = path.join(dataDir(), 'server-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  writeAtomic(file, t + '\n');
  fs.chmodSync(file, 0o600);
  return t;
}

const safeEqual = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>Not Enough Tokens</title>
<body style="font:15px system-ui;padding:40px;max-width:560px">
<h2>Access token required</h2>
<p>Open the console from the link printed by <code>node src/cli.js serve</code>, or from the app.</p>
<p>請使用 <code>node src/cli.js serve</code> 印出的網址開啟，或直接開 App。</p>`;

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(s));
  }
  return JSON.parse(s);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  // DNS-rebinding guard: only accept our own Host.
  const host = (req.headers.host || '').toLowerCase();
  if (!ctx.allowedHosts.has(host)) return send(res, 403, { error: 'bad host' });

  const isAskpass = p === '/api/askpass' && method === 'POST';
  if (!isAskpass) {
    const given = url.searchParams.get('token');
    if (given != null) {
      if (!safeEqual(given, ctx.token)) return send(res, 401, DENIED, 'text/html; charset=utf-8');
      // Trade the URL token for a cookie and drop it from the address bar.
      url.searchParams.delete('token');
      return send(res, 302, '', 'text/plain', {
        'Set-Cookie': `${ctx.cookie}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        Location: url.pathname + url.search,
      });
    }
    if (!safeEqual(cookieValue(req, ctx.cookie), ctx.token)) {
      return p.startsWith('/api/') ? send(res, 401, { error: 'unauthorized' }) : send(res, 401, DENIED, 'text/html; charset=utf-8');
    }
  }

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  // askpass callback from the ssh helper (its own bearer token, form-encoded)
  if (isAskpass) {
    if (req.headers.authorization !== `Bearer ${askToken}`) return send(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    const id = crypto.randomBytes(6).toString('hex');
    const ask = { id, machine: b.machine || '', prompt: String(b.prompt || '').trim() };
    const answer = await new Promise((resolve) => {
      pendingAsks.set(id, { ...ask, resolve });
      broadcast('ask', ask);
      req.on('close', () => {
        if (pendingAsks.has(id)) {
          pendingAsks.delete(id);
          broadcast('ask-done', { id });
          resolve(null);
        }
      });
    });
    if (answer == null) return send(res, 410, 'cancelled\n', 'text/plain');
    return send(res, 200, answer + '\n', 'text/plain');
  }

  // Everything else that changes state needs our custom header (blocks cross-site POSTs).
  if (method !== 'GET' && req.headers['x-net'] !== '1') return send(res, 403, { error: 'missing header' });

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ syncing: job ? [...job.running] : [] })}\n\n`);
    for (const a of pendingAsks.values()) res.write(`event: ask\ndata: ${JSON.stringify({ id: a.id, machine: a.machine, prompt: a.prompt })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (p === '/api/askpass/answer' && method === 'POST') {
    const b = await body(req);
    const a = pendingAsks.get(b.id);
    if (!a) return send(res, 404, { error: 'no such prompt' });
    pendingAsks.delete(b.id);
    broadcast('ask-done', { id: b.id });
    a.resolve(b.cancel ? null : String(b.answer ?? ''));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/state' && method === 'GET') {
    const pr = loadPrices();
    return send(res, 200, {
      machines: loadMachines(),
      settings: loadSettings(),
      prices: { fetchedAt: pr.fetchedAt, lastError: pr.lastError || null },
      syncing: job ? [...job.running] : [],
      dataDir: dataDir(),
      version: VERSION,
      hostname: os.hostname(),
    });
  }

  // One BatchMode ssh attempt with the given (unsaved) settings.
  // `known` is the machine with the same fingerprint, if any.
  // An untrusted host key may still be a known machine under another name (a
  // Tailscale name for a LAN box): retry with each machine's host as HostKeyAlias,
  // the way fallback hosts connect; only a matching key gets in. The retry counts
  // only if the login then reads that machine's fingerprint; anything less (a
  // shared or cloned host key, or no login) keeps the plain "host key not trusted",
  // since saved as its own machine it wouldn't connect with that alias.
  if (p === '/api/test-connection' && method === 'POST') {
    const input = await body(req);
    const machines = loadMachines();
    let r = await testSsh({ ...input, hostKeyAlias: undefined });
    if (r.result === 'hostkey') {
      for (const m of machines.filter((x) => x.type === 'ssh' && x.fingerprint && x.host)) {
        const again = await testSsh({ ...input, hostKeyAlias: m.host });
        if (again.result === 'ok' && again.fingerprint === m.fingerprint) {
          r = again;
          break;
        }
      }
    }
    r.known = (r.fingerprint && machines.find((m) => m.fingerprint === r.fingerprint)?.id) || null;
    return send(res, 200, r);
  }

  // Machines found over mDNS / Tailscale, each marked with the machine it already is.
  if (p === '/api/discover' && method === 'GET') {
    const sources = (url.searchParams.get('sources') || 'mdns,tailscale').split(',').filter((s) => ['mdns', 'tailscale'].includes(s));
    const r = await discover({ sources });
    const norm = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
    const known = new Map();
    const machines = loadMachines();
    for (const m of machines) for (const h of [m.host, ...(m.altHosts || []), m.lastHost, m.lastAddress]) if (h) known.set(norm(h), m.id);
    // Known only by an address it was found under; names prove nothing. Testing the
    // connection reads the fingerprint and settles it.
    for (const d of r.machines) {
      const names = [d.mdns?.host, ...(d.mdns?.addrs || []), d.tailscale?.host, ...(d.tailscale?.ips || [])];
      d.known = names.map((h) => known.get(norm(h))).find(Boolean) || null;
    }
    return send(res, 200, r);
  }

  if (p === '/api/usage' && method === 'GET') {
    const all = loadMachines().map((m) => m.id);
    const want = (url.searchParams.get('machines') || '').split(',').filter((x) => all.includes(x));
    return send(res, 200, usagePayload(want.length ? want : all));
  }

  if (p === '/api/sync' && method === 'POST') {
    if (job) return send(res, 409, { error: 'a sync is already running' });
    const b = await body(req);
    const all = loadMachines().map((m) => m.id);
    const ids = (b.ids?.length ? b.ids : all).filter((x) => all.includes(x));
    runSync(ids);
    return send(res, 202, { ids });
  }

  if (p === '/api/settings' && method === 'PUT') {
    const b = await body(req);
    const s = loadSettings();
    if (b.timezone != null) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone });
      } catch {
        return send(res, 400, { error: 'unknown timezone' });
      }
      s.timezone = b.timezone;
    }
    if (b.locale != null) {
      if (!['auto', 'zh-TW', 'en'].includes(b.locale)) return send(res, 400, { error: 'unknown locale' });
      s.locale = b.locale;
    }
    if (b.zoom != null) {
      const z = Number(b.zoom);
      if (!(z >= 0.5 && z <= 2)) return send(res, 400, { error: 'zoom must be 0.5..2' });
      s.zoom = z;
    }
    const int = (k, lo, hi) => {
      if (b[k] == null) return;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be ${lo}..${hi}`);
      s[k] = v;
    };
    int('dayStartHour', 0, 23);
    int('weekStartDow', 0, 6);
    int('weekStartHour', 0, 23);
    int('monthStartDay', 1, 28);
    int('monthStartHour', 0, 23);
    saveSettings(s);
    return send(res, 200, s);
  }

  if (p === '/api/machines' && method === 'POST') return send(res, 200, addMachine(await body(req)));
  const fh = /^\/api\/machines\/([\w-]+)\/forget-hostkey$/.exec(p);
  if (fh && method === 'POST') return send(res, 200, await forgetHostKey(fh[1]));
  const mm = /^\/api\/machines\/([\w-]+)\/merge$/.exec(p);
  if (mm && method === 'POST') {
    const b = await body(req);
    return send(res, 200, mergeInto(mm[1], String(b.into), { asMain: !!b.asMain }));
  }
  let m = /^\/api\/machines\/([\w-]+)$/.exec(p);
  if (m && method === 'PUT') return send(res, 200, updateMachine(m[1], await body(req)));
  if (m && method === 'DELETE') {
    removeMachine(m[1], { purge: url.searchParams.get('purge') === '1' });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/prices' && method === 'GET') return send(res, 200, pricesPayload());
  if (p === '/api/prices/refresh' && method === 'POST') {
    await refreshPrices();
    return send(res, 200, pricesPayload());
  }
  if (p === '/api/prices/manual' && method === 'PUT') {
    const b = await body(req);
    if (!b.model) return send(res, 400, { error: 'model required' });
    const pr = loadPrices();
    pr.manual ||= {};
    if (b.price == null) delete pr.manual[b.model];
    else pr.manual[b.model] = parsePrice(b.price);
    savePrices(pr);
    return send(res, 200, pricesPayload());
  }
  // "以多少價格計算": price the stored unpriced tokens of one model (all machines).
  if (p === '/api/prices/apply' && method === 'POST') {
    if (job) return send(res, 409, { error: 'wait for the sync to finish' });
    const b = await body(req);
    const price = parsePrice(b.price);
    let buckets = 0;
    for (const mc of loadMachines()) {
      const l = new Ledger(mc.id);
      const n = l.priceUnpriced(b.model, price);
      if (n) l.save();
      buckets += n;
    }
    return send(res, 200, { buckets, ...pricesPayload() });
  }

  return send(res, 404, { error: 'not found' });
}

export function startServer({ port = 4777, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const ctx = { allowedHosts: new Set(), token: loadOrCreateToken(), cookie: null };
    const server = http.createServer((req, res) => {
      handle(req, res, ctx).catch((e) => {
        if (!res.headersSent) send(res, 400, { error: e.message });
      });
    });
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      for (const h of [host, '127.0.0.1', 'localhost']) ctx.allowedHosts.add(`${h}:${actual}`);
      ctx.cookie = `net_token_${actual}`; // cookies ignore ports; keep instances apart
      const url = `http://127.0.0.1:${actual}`;
      installAskpass(url);
      resolve({ server, url, port: actual, openUrl: `${url}/?token=${ctx.token}` });
    });
  });
}
