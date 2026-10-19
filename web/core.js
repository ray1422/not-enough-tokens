// Shared state, helpers and period math for the console and the settings page.
// All period math happens client-side from hourly/daily buckets, so changing the
// timezone or week/month boundaries never needs a re-sync.
import { t } from './i18n.js';

export const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
export const KIND_COLOR = { input: 'var(--s1)', output: 'var(--s2)', cacheRead: 'var(--s3)', cacheWrite5m: 'var(--s4)', cacheWrite1h: 'var(--s5)' };
export const kindLabel = (k) => t('kind.' + k);
export const H = 3600_000, D = 24 * H;
export const RANGES = { day: [14, 30, 90, 0], week: [12, 26, 52, 0], month: [12, 0] };

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Per-viewer UI preferences only; anything shared lives on the server.
export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('net.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('net.' + k, JSON.stringify(v));
    } catch {}
  },
};

export const S = {
  machines: [],
  settings: null,
  selected: new Set(store.get('selected', [])),
  usage: null,
  period: store.get('period', 'week'),
  metric: store.get('metric', 'cost'),
  range: store.get('range', {}),
  focus: null, // period key selected by clicking a bar
  syncing: new Set(),
  asks: [],
  sort: {},
  projGroup: store.get('projGroup', 'repo'), // 'repo' | 'dir' | 'path'
  expanded: new Set(),
  hidden: new Set(store.get('hidden', [])), // token kinds hidden from the chart
  dataDir: '',
};

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-NET': '1', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- formatting ----------
export function fmtTok(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e11 ? 0 : 2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
export const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export function fmtAgo(iso) {
  if (!iso) return t('ago.never');
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return t('ago.now');
  if (s < 5400) return t('ago.min', { n: Math.round(s / 60) });
  if (s < 129600) return t('ago.h', { n: Math.round(s / 3600) });
  return t('ago.d', { n: Math.round(s / 86400) });
}
export function shortProject(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}
export const machineName = (id) => S.machines.find((m) => m.id === id)?.name || id;

// ---------- periods (wall-clock arithmetic in the chosen timezone) ----------
let tzFmt = null, wallCache = new Map();
export function setTz(tz) {
  tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  wallCache = new Map();
}
// epoch hour -> "wall" ms: the local date/time in the timezone, encoded as if UTC.
export function wallOf(hour) {
  let w = wallCache.get(hour);
  if (w == null) {
    const p = Object.fromEntries(tzFmt.formatToParts(new Date(hour * H)).map((x) => [x.type, x.value]));
    w = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24);
    wallCache.set(hour, w);
  }
  return w;
}
const ymd = (w) => new Date(w).toISOString().slice(0, 10);
const floorDay = (w) => Math.floor(w / D) * D;
export const nowWall = () => wallOf(Math.floor(Date.now() / H));
const dow = (i) => t('dow').split(',')[i];

// wall ms -> { key, start } where start is the period's first wall hour.
export function periodOf(w, type) {
  const s = S.settings;
  if (type === 'day') {
    const x = w - s.dayStartHour * H;
    return { key: ymd(x), start: floorDay(x) + s.dayStartHour * H };
  }
  if (type === 'week') {
    const x = w - s.weekStartHour * H;
    const delta = (new Date(x).getUTCDay() - s.weekStartDow + 7) % 7;
    const start = floorDay(x) - delta * D + s.weekStartHour * H;
    return { key: 'W' + ymd(start), start };
  }
  const x = w - s.monthStartHour * H;
  const d = new Date(x);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() < s.monthStartDay) m -= 1;
  const start = Date.UTC(y, m, s.monthStartDay) + s.monthStartHour * H;
  const sd = new Date(start);
  return { key: `${sd.getUTCFullYear()}-${String(sd.getUTCMonth() + 1).padStart(2, '0')}`, start };
}
function nextStart(start, type) {
  if (type === 'day') return start + D;
  if (type === 'week') return start + 7 * D;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours());
}
export function periodLabel(p, type, long = false) {
  const s = S.settings;
  const d = new Date(p.start);
  const md = (x) => `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  const hh = (h) => (h ? ` ${String(h).padStart(2, '0')}:00` : '');
  if (type === 'day') return `${md(d)} (${dow(d.getUTCDay())})${long ? hh(s.dayStartHour) : ''}`;
  if (type === 'week') {
    const e = new Date(nextStart(p.start, 'week') - D);
    return long ? t('period.weekFrom', { d: `${ymd(p.start)} (${dow(d.getUTCDay())})${hh(s.weekStartHour)}` }) : `${md(d)}–${md(e)}`;
  }
  if (s.monthStartDay === 1 && !s.monthStartHour) return p.key;
  return long ? t('period.monthFrom', { d: `${ymd(p.start)}${hh(s.monthStartHour)}` }) : t('period.from', { d: md(d) });
}

// ---------- aggregation helpers ----------
export const emptyAgg = () => {
  const a = { msgs: 0 };
  for (const k of KINDS) a[k] = a['c_' + k] = a['u_' + k] = 0;
  return a;
};
export function addInto(a, r, ix) {
  a.msgs += r[ix.msgs];
  for (const k of KINDS) {
    a[k] += r[ix[k]];
    a['c_' + k] += r[ix['c_' + k]];
    a['u_' + k] += r[ix['u_' + k]];
  }
}
export const tok = (a, k) => a[k] + a['u_' + k];
export const totalTok = (a) => KINDS.reduce((s, k) => s + tok(a, k), 0);
export const totalCost = (a) => KINDS.reduce((s, k) => s + a['c_' + k], 0);
export const unpricedTok = (a) => KINDS.reduce((s, k) => s + a['u_' + k], 0);

// ---------- dialogs ----------
export function modal(html, { onClose, cls = '' } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => {
    bg.remove();
    onClose?.();
  };
  bg.addEventListener('mousedown', (e) => e.target === bg && close());
  bg.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  $('#modal-root').appendChild(bg);
  bg.querySelector('input, button')?.focus();
  return { el: bg.firstElementChild, close };
}

export function applyTheme() {
  const th = store.get('theme', 'system');
  if (th === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = th;
}
