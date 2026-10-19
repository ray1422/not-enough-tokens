// Per-machine aggregate store:
//   machines/<id>/usage_hourly.csv  hourly buckets by (project, model)
//   machines/<id>/seen.json         per-message counts already added (dedupe, max-merge)
//   machines/<id>/cursors.json      per-file read position
//
// Cost is frozen at ingest time with whatever price was current then.
// Tokens of models without a price go to the u_* columns until priced manually.
import path from 'node:path';
import { dataDir, readCsv, readJson, toCsv, writeAtomic, writeJson } from './store.js';
import { KINDS, costParts, lookup } from './pricing.js';
import { maxCounts } from './parse.js';
import { dayStartHour, loadSettings } from './settings.js';

const HOUR = 3600_000;
export const SEEN_RETENTION_DAYS = 90;
// Buckets newer than this stay hourly (so week/month boundaries can be cut at any
// hour); older ones are squashed into one bucket per local day, so the file stops
// growing by the hour. 35 days keeps the whole current month hourly.
export const HOURLY_DAYS = 35;

// <kind> = priced tokens, c_<kind> = their USD cost, u_<kind> = tokens still without a price.
// span = 1 (hourly bucket) or 24 (daily bucket starting at `hour`).
export const COLS = ['hour', 'span', 'project', 'model', 'msgs', ...KINDS, ...KINDS.map((k) => 'c_' + k), ...KINDS.map((k) => 'u_' + k)];

export function machineDir(id) {
  return path.join(dataDir(), 'machines', id);
}

export class Ledger {
  constructor(machineId) {
    this.dir = machineDir(machineId);
    this.cursors = readJson(path.join(this.dir, 'cursors.json'), {});
    this.seen = readJson(path.join(this.dir, 'seen.json'), {});
    this.buckets = new Map();
    for (const r of readCsv(path.join(this.dir, 'usage_hourly.csv'))) {
      const row = { hour: Number(r.hour), span: Number(r.span) || 1, project: r.project, model: r.model };
      for (const c of COLS.slice(4)) row[c] = Number(r[c]) || 0;
      this.buckets.set(bucketKey(row.hour, row.project, row.model), row);
    }
    this.added = 0;
  }

  bucket(hour, project, model) {
    const key = bucketKey(hour, project, model);
    let b = this.buckets.get(key);
    if (!b) {
      b = { hour, span: 1, project, model };
      for (const c of COLS.slice(4)) b[c] = 0;
      this.buckets.set(key, b);
    }
    return b;
  }

  // opts.minTs: ignore never-seen messages older than this (used when re-reading a
  // rewritten file whose old lines may have fallen out of the seen window).
  add(rec, prices, opts = {}) {
    const prev = this.seen[rec.id];
    if (!prev && opts.minTs && rec.ts < opts.minTs) return;
    const prevT = prev ? unpack(prev) : null;
    const next = prevT ? maxCounts(prevT, rec.tokens) : rec.tokens;
    const hour = prev ? prev[0] : Math.floor(rec.ts / HOUR);
    let changed = false;
    for (const k of KINDS) if (next[k] !== (prevT ? prevT[k] : 0)) changed = true;
    if (!changed && prev) return;

    const b = this.bucket(hour, rec.project, rec.model);
    if (!prev) b.msgs += 1;
    const price = lookup(prices, rec.model);
    const now = price && costParts(price, next);
    const before = price && prevT && costParts(price, prevT);
    for (const k of KINDS) {
      const d = next[k] - (prevT ? prevT[k] : 0);
      if (price) {
        b[k] += d;
        b['c_' + k] += now[k] - (before ? before[k] : 0);
      } else b['u_' + k] += d;
    }
    this.seen[rec.id] = [hour, ...KINDS.map((k) => next[k])];
    this.added += 1;
  }

  // "Price these unpriced tokens at X": tiers can't apply to aggregates, so base price only.
  priceUnpriced(model, price) {
    let n = 0;
    const flat = { ...price, tiers: undefined };
    for (const b of this.buckets.values()) {
      if (b.model !== model) continue;
      const t = Object.fromEntries(KINDS.map((k) => [k, b['u_' + k]]));
      if (!KINDS.some((k) => t[k])) continue;
      const c = costParts(flat, t);
      for (const k of KINDS) {
        b['c_' + k] += c[k];
        b[k] += t[k];
        b['u_' + k] = 0;
      }
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  pruneSeen(now = Date.now()) {
    const minHour = Math.floor((now - SEEN_RETENTION_DAYS * 86400_000) / HOUR);
    for (const [id, v] of Object.entries(this.seen)) if (v[0] < minHour) delete this.seen[id];
  }

  rows() {
    return [...this.buckets.values()].sort((a, b) => a.hour - b.hour || cmp(a.project, b.project) || cmp(a.model, b.model));
  }

  // Squash hourly buckets older than HOURLY_DAYS into local-day buckets.
  compact(now = Date.now(), settings = loadSettings()) {
    const cutoff = Math.floor(now / HOUR) - HOURLY_DAYS * 24;
    const old = [...this.buckets.values()].filter((b) => b.hour < cutoff && b.span !== 24);
    // Remove first: a day's start hour can share its key with one of these.
    for (const b of old) this.buckets.delete(bucketKey(b.hour, b.project, b.model));
    for (const b of old) {
      const t = this.bucket(dayStartHour(b.hour, settings), b.project, b.model);
      t.span = 24;
      for (const c of COLS.slice(4)) t[c] += b[c];
    }
    if (old.length) this.dirty = true;
    return old.length;
  }

  save() {
    this.compact();
    if (!this.added && !this.dirty) {
      // Nothing new: only cursors may have moved (e.g. lines without usage).
      writeJson(path.join(this.dir, 'cursors.json'), this.cursors);
      return;
    }
    this.pruneSeen();
    writeAtomic(path.join(this.dir, 'usage_hourly.csv'), toCsv(COLS, this.rows().map(roundCost)));
    writeJson(path.join(this.dir, 'cursors.json'), this.cursors);
    writeAtomic(path.join(this.dir, 'seen.json'), JSON.stringify(this.seen));
  }
}

const bucketKey = (h, p, m) => `${h}\t${p}\t${m}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unpack = (v) => Object.fromEntries(KINDS.map((k, i) => [k, v[i + 1]]));
const roundCost = (r) => {
  const o = { ...r };
  for (const k of KINDS) o['c_' + k] = Math.round(r['c_' + k] * 1e9) / 1e9;
  return o;
};

export function readUsageRows(machineId) {
  return readCsv(path.join(machineDir(machineId), 'usage_hourly.csv'));
}
