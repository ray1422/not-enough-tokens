// Web console. All period math happens here from hourly buckets, so changing the
// timezone or week/month boundaries never needs a re-sync.

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const KIND_LABEL = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite5m: 'Cache write 5m', cacheWrite1h: 'Cache write 1h' };
const KIND_COLOR = { input: 'var(--s1)', output: 'var(--s2)', cacheRead: 'var(--s3)', cacheWrite5m: 'var(--s4)', cacheWrite1h: 'var(--s5)' };
const H = 3600_000, D = 24 * H;
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const RANGES = { day: [14, 30, 90, 0], week: [12, 26, 52, 0], month: [12, 0] };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
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

const S = {
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
};

async function api(path, opts = {}) {
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
function fmtTok(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e11 ? 0 : 2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function shortProject(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// ---------- periods (wall-clock arithmetic in the chosen timezone) ----------
let tzFmt = null, wallCache = new Map();
function setTz(tz) {
  tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  wallCache = new Map();
}
// epoch hour -> "wall" ms: the local date/time in the timezone, encoded as if UTC.
function wallOf(hour) {
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

// wall ms -> { key, start } where start is the period's first wall hour.
function periodOf(w, type) {
  const s = S.settings;
  if (type === 'day') {
    const t = w - s.dayStartHour * H;
    const start = floorDay(t) + s.dayStartHour * H;
    return { key: ymd(t), start };
  }
  if (type === 'week') {
    const t = w - s.weekStartHour * H;
    const delta = (new Date(t).getUTCDay() - s.weekStartDow + 7) % 7;
    const start = floorDay(t) - delta * D + s.weekStartHour * H;
    return { key: 'W' + ymd(start), start };
  }
  const t = w - s.monthStartHour * H;
  const d = new Date(t);
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
function periodLabel(p, type, long = false) {
  const s = S.settings;
  const d = new Date(p.start);
  const md = (x) => `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  const hh = (h) => (h ? ` ${String(h).padStart(2, '0')}:00` : '');
  if (type === 'day') return `${md(d)} (${DOW[d.getUTCDay()]})${long ? hh(s.dayStartHour) : ''}`;
  if (type === 'week') {
    const e = new Date(nextStart(p.start, 'week') - D);
    return long ? `${ymd(p.start)} (${DOW[d.getUTCDay()]})${hh(s.weekStartHour)} 起一週` : `${md(d)}–${md(e)}`;
  }
  if (s.monthStartDay === 1 && !s.monthStartHour) return p.key;
  return long ? `${ymd(p.start)}${hh(s.monthStartHour)} 起一個月` : `${md(d)} 起`;
}
const nowWall = () => wallOf(Math.floor(Date.now() / H));

// ---------- aggregation ----------
const emptyAgg = () => {
  const a = { msgs: 0 };
  for (const k of KINDS) a[k] = a['c_' + k] = a['u_' + k] = 0;
  return a;
};
function addInto(a, r, ix) {
  a.msgs += r[ix.msgs];
  for (const k of KINDS) {
    a[k] += r[ix[k]];
    a['c_' + k] += r[ix['c_' + k]];
    a['u_' + k] += r[ix['u_' + k]];
  }
}
const tok = (a, k) => a[k] + a['u_' + k];
const totalTok = (a) => KINDS.reduce((s, k) => s + tok(a, k), 0);
const totalCost = (a) => KINDS.reduce((s, k) => s + a['c_' + k], 0);
const unpricedTok = (a) => KINDS.reduce((s, k) => s + a['u_' + k], 0);

function* rows() {
  if (!S.usage) return;
  for (const [mid, rs] of Object.entries(S.usage.machines)) {
    if (!S.selected.has(mid)) continue;
    for (const r of rs) yield [mid, r];
  }
}

// ---------- project grouping ----------
// The server maps each cwd to its git repo root and origin URL (resolved on the
// machine that owns the path). Paths it couldn't resolve (deleted, not a repo,
// or living on another host) fall back to: strip ".claude/worktrees/<name>",
// then merge into the closest ancestor that also appears as a cwd.
function normRemote(u) {
  let s = u.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const x = new URL(s);
      s = x.hostname + x.pathname;
    } catch {}
  }
  return s.replace(/^github\.com\//, '');
}
const stripWorktree = (p) => p.replace(/\/\.claude\/worktrees\/[^/]+(\/.*)?$/, '');

let groupCache = null; // { usage, mode, map: Map(mid -> Map(cwd -> {key,label,title})) }
function projectGroupOf(mid, cwd) {
  if (!groupCache || groupCache.usage !== S.usage || groupCache.mode !== S.projGroup) {
    groupCache = { usage: S.usage, mode: S.projGroup, map: new Map() };
  }
  let m = groupCache.map.get(mid);
  if (!m) {
    m = new Map();
    groupCache.map.set(mid, m);
    const info = S.usage.projects?.[mid] || {};
    const ix = S.usage.cols.indexOf('project');
    const cwds = new Set((S.usage.machines[mid] || []).map((r) => r[ix]));
    const bases = new Set([...cwds].map(stripWorktree));
    const fallbackRoot = (cwd) => {
      let p = stripWorktree(cwd), best = p;
      for (let up = p.slice(0, p.lastIndexOf('/')); up.split('/').length > 3; up = up.slice(0, up.lastIndexOf('/'))) {
        if (bases.has(up)) best = up; // keeps going up: the shortest known ancestor wins
      }
      return best;
    };
    for (const cwd of cwds) {
      const i = info[cwd] || {};
      const root = i.root || fallbackRoot(cwd);
      const top = i.top || root;
      let g;
      if (S.projGroup === 'path') g = { key: cwd, label: shortProject(cwd), title: cwd, root, top };
      else if (S.projGroup === 'repo' && i.remote) {
        const r = normRemote(i.remote);
        g = { key: 'r:' + r, label: r, title: i.remote, root, top };
      } else g = { key: 'd:' + root, label: shortProject(root), title: root, root, top };
      m.set(cwd, g);
    }
  }
  return m.get(cwd) || { key: cwd, label: shortProject(cwd), title: cwd };
}

function aggregate() {
  const ix = Object.fromEntries(S.usage.cols.map((c, i) => [c, i]));
  const type = S.period;
  const per = new Map(), all = emptyAgg();
  const cur = {
    week: periodOf(nowWall(), 'week').key,
    month: periodOf(nowWall(), 'month').key,
  };
  const heroes = { week: emptyAgg(), month: emptyAgg(), all };
  const byModel = new Map(), byProject = new Map();
  const unpricedModels = new Map();
  let firstWall = null;
  for (const [mid, r] of rows()) {
    const w = wallOf(r[ix.hour]);
    if (firstWall == null || w < firstWall) firstWall = w;
    const p = periodOf(w, type);
    if (!per.has(p.key)) per.set(p.key, { ...p, agg: emptyAgg() });
    addInto(per.get(p.key).agg, r, ix);
    addInto(all, r, ix);
    if (periodOf(w, 'week').key === cur.week) addInto(heroes.week, r, ix);
    if (periodOf(w, 'month').key === cur.month) addInto(heroes.month, r, ix);
    if (!S.focus || p.key === S.focus) {
      const mk = r[ix.model], cwd = r[ix.project];
      if (!byModel.has(mk)) byModel.set(mk, emptyAgg());
      addInto(byModel.get(mk), r, ix);
      const g = projectGroupOf(mid, cwd);
      let pg = byProject.get(g.key);
      if (!pg) byProject.set(g.key, (pg = { key: g.key, label: g.label, title: g.title, a: emptyAgg(), children: new Map() }));
      addInto(pg.a, r, ix);
      const ck = S.selected.size > 1 ? `${mid}\t${cwd}` : cwd;
      if (!pg.children.has(ck)) pg.children.set(ck, { mid, cwd, root: g.root, top: g.top, a: emptyAgg() });
      addInto(pg.children.get(ck).a, r, ix);
    }
    const u = KINDS.reduce((s, k) => s + r[ix['u_' + k]], 0);
    if (u) unpricedModels.set(r[ix.model], (unpricedModels.get(r[ix.model]) || 0) + u);
  }

  // Continuous list of periods (empty ones included) for the chart and table.
  const n = S.range[type] ?? RANGES[type][0];
  const list = [];
  let p = periodOf(nowWall(), type);
  const stopAt = firstWall == null ? p.start : periodOf(firstWall, type).start;
  // Bounded on purpose: bad settings (NaN) or a non-decreasing step must never spin.
  for (let guard = 0; guard < 5000; guard++) {
    list.unshift(per.get(p.key) || { ...p, agg: emptyAgg() });
    if ((n && list.length >= n) || !(p.start > stopAt)) break;
    const prev = periodOf(p.start - H, type);
    if (!(prev.start < p.start)) break;
    p = prev;
  }
  return { list, heroes, cur, byModel, byProject, unpricedModels, periods: per };
}

// ---------- rendering ----------
let last = null;
function render() {
  if (!S.usage || !S.settings) return;
  last = aggregate();
  renderBanner(last.unpricedModels);
  renderHeroes(last);
  renderSegs();
  renderChart(last.list);
  renderTables(last);
}

function renderChips() {
  const el = $('#machine-chips');
  el.innerHTML = S.machines
    .map((m) => {
      const state = S.syncing.has(m.id) ? 'busy' : m.lastError ? 'err' : m.lastSyncAt ? 'ok' : '';
      const title = [
        m.type === 'local' ? 'this machine' : `ssh ${m.user ? m.user + '@' : ''}${m.host}${m.port ? ':' + m.port : ''}`,
        m.lastAddress ? `last address ${m.lastAddress}` : '',
        `synced ${fmtAgo(m.lastSyncAt)}`,
        m.lastError ? `error: ${m.lastError}` : '',
      ].filter(Boolean).join('\n');
      const on = S.selected.has(m.id);
      return `<label class="chip ${on ? '' : 'off'}" title="${esc(title)}">
        <input type="checkbox" data-id="${esc(m.id)}" ${on ? 'checked' : ''}>
        <span class="dot ${state}"></span>${esc(m.name)}</label>`;
    })
    .join('');
  const n = S.machines.filter((m) => S.selected.has(m.id)).length;
  const btn = $('#btn-sync');
  btn.textContent = S.syncing.size ? 'Syncing…' : `Sync${n < S.machines.length ? ` (${n})` : ''}`;
  btn.disabled = S.syncing.size > 0 || n === 0;
}

function renderBanner(unpriced) {
  const el = $('#unpriced-banner');
  if (!unpriced.size) return (el.hidden = true);
  el.hidden = false;
  const list = [...unpriced].map(([m, t]) => `<b>${esc(m)}</b> ${fmtTok(t)}`).join('、');
  el.innerHTML = `有 model 尚無牌價，這些 tokens 未計入費用：${list}。 <button class="link" id="banner-prices">設定價格</button>`;
  $('#banner-prices').onclick = openPrices;
}

function kindsBlock(a) {
  return `<div class="kinds">${KINDS.map(
    (k) => `<span class="k"><i class="sw" style="background:${KIND_COLOR[k]}"></i>${KIND_LABEL[k]}</span>
      <span class="v">${fmtTok(tok(a, k))}</span><span class="c">${fmtUsd(a['c_' + k])}</span>`,
  ).join('')}</div>`;
}

function renderHeroes(L) {
  const wk = periodOf(nowWall(), 'week'), mo = periodOf(nowWall(), 'month');
  const card = (title, range, a) => `<div class="hero">
    <div class="label"><span>${title}</span><span class="range">${esc(range)}</span></div>
    <div class="big">${fmtUsd(totalCost(a))}</div>
    <div class="sub">${fmtTok(totalTok(a))} tokens · ${fmtInt(a.msgs)} msgs${unpricedTok(a) ? ` · <span class="unpriced">${fmtTok(unpricedTok(a))} 未計價</span>` : ''}</div>
    ${kindsBlock(a)}</div>`;
  $('#heroes').innerHTML =
    card('本週', periodLabel(wk, 'week'), L.heroes.week) +
    card('本月', periodLabel(mo, 'month', S.settings.monthStartDay !== 1), L.heroes.month) +
    card('有史以來', `${S.selected.size} machine${S.selected.size === 1 ? '' : 's'}`, L.heroes.all);
}

function renderSegs() {
  for (const b of document.querySelectorAll('#seg-period button')) b.classList.toggle('on', b.dataset.v === S.period);
  for (const b of document.querySelectorAll('#seg-metric button')) b.classList.toggle('on', b.dataset.v === S.metric);
  const cur = S.range[S.period] ?? RANGES[S.period][0];
  const unit = { day: '天', week: '週', month: '月' }[S.period];
  $('#seg-range').innerHTML = RANGES[S.period]
    .map((n) => `<button data-v="${n}" class="${n === cur ? 'on' : ''}">${n ? `${n} ${unit}` : '全部'}</button>`)
    .join('');
  $('#legend').innerHTML = KINDS.map(
    (k) => `<button type="button" data-k="${k}" class="${S.hidden.has(k) ? 'off' : ''}" aria-pressed="${!S.hidden.has(k)}" title="點擊顯示/隱藏"><i class="sw" style="background:${KIND_COLOR[k]}"></i>${KIND_LABEL[k]}</button>`,
  ).join('');
}

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

function renderChart(list) {
  const el = $('#chart');
  const W = el.clientWidth || 800, Ht = el.clientHeight || 260;
  const padL = 56, padR = 8, padT = 10, padB = 24;
  const iw = W - padL - padR, ih = Ht - padT - padB;
  const val = (a, k) => (S.hidden.has(k) ? 0 : S.metric === 'cost' ? a['c_' + k] : tok(a, k));
  const totals = list.map((p) => KINDS.reduce((s, k) => s + val(p.agg, k), 0));
  const max = Math.max(...totals, 0);
  const step = niceStep(max || 1);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const y = (v) => padT + ih - (v / top) * ih;
  const band = iw / list.length;
  const bw = Math.max(2, Math.min(48, band * 0.72));
  const fmtAxis = S.metric === 'cost' ? (v) => '$' + (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : +v.toFixed(2)) : fmtTok;

  let svg = `<svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${S.metric === 'cost' ? 'Cost' : 'Tokens'} per ${S.period}">`;
  svg += '<g class="axis">';
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmtAxis(v)}</text>`;
  }
  const labelW = Math.max(...list.map((p) => periodLabel(p, S.period).length)) * 7 + 16;
  const every = Math.ceil(list.length / Math.max(1, Math.floor(iw / labelW)));
  list.forEach((p, i) => {
    if ((list.length - 1 - i) % every) return;
    svg += `<text x="${padL + band * i + band / 2}" y="${Ht - 6}" text-anchor="middle">${esc(periodLabel(p, S.period))}</text>`;
  });
  svg += '</g>';

  list.forEach((p, i) => {
    const x = padL + band * i + (band - bw) / 2;
    if (S.focus === p.key) svg += `<rect class="sel" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih}"/>`;
    let acc = 0;
    const segs = KINDS.map((k) => ({ k, v: val(p.agg, k) })).filter((s) => s.v > 0);
    segs.forEach((s, j) => {
      const y0 = y(acc), y1 = y(acc + s.v);
      acc += s.v;
      let h = y0 - y1 - (j > 0 ? 2 : 0); // 2px surface gap between stacked segments
      if (h < 0.5) h = 0.5;
      const yy = y0 - (j > 0 ? 2 : 0) - h;
      if (j === segs.length - 1 && h > 4) {
        const r = Math.min(4, bw / 2);
        svg += `<path fill="${KIND_COLOR[s.k]}" d="M${x},${yy + h}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${yy + h}Z"/>`;
      } else svg += `<rect fill="${KIND_COLOR[s.k]}" x="${x}" y="${yy}" width="${bw}" height="${h}"/>`;
    });
    svg += `<rect class="hit" data-i="${i}" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg>';
  el.innerHTML = svg;

  const tip = $('#tooltip');
  el.querySelectorAll('.hit').forEach((r) => {
    const p = list[+r.dataset.i];
    r.addEventListener('mousemove', (e) => {
      const a = p.agg;
      tip.innerHTML = `<div class="t">${esc(periodLabel(p, S.period, true))}</div>
        ${KINDS.map((k) => `<div class="row${S.hidden.has(k) ? ' dim' : ''}"><span><i class="sw" style="background:${KIND_COLOR[k]}"></i>${KIND_LABEL[k]}</span><span>${fmtTok(tok(a, k))} · ${fmtUsd(a['c_' + k])}</span></div>`).join('')}
        <div class="row" style="margin-top:4px"><span>Total</span><b>${fmtTok(totalTok(a))} · ${fmtUsd(totalCost(a))}</b></div>
        <div class="row"><span>Messages</span><span>${fmtInt(a.msgs)}</span></div>`;
      tip.hidden = false;
      const tx = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const ty = Math.max(8, e.clientY - tip.offsetHeight - 12);
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    });
    r.addEventListener('mouseleave', () => (tip.hidden = true));
    r.addEventListener('click', () => setFocus(S.focus === p.key ? null : p.key));
  });
}

function setFocus(key) {
  S.focus = key;
  render();
}

function table(id, cols, data, opts = {}) {
  const sort = S.sort[id] || { col: opts.defaultSort, dir: -1 };
  if (sort.col != null) {
    const c = cols.find((x) => x.key === sort.col);
    if (c?.sortVal) data = [...data].sort((a, b) => (c.sortVal(a) > c.sortVal(b) ? 1 : c.sortVal(a) < c.sortVal(b) ? -1 : 0) * sort.dir);
  }
  let html = '<table><thead><tr>';
  html += cols.map((c) => `<th data-col="${c.key}">${c.label}${sort.col === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  html += '</tr></thead><tbody>';
  const row = (r, cls, withKey) =>
    `<tr class="${cls}" ${withKey && opts.rowKey ? `data-k="${esc(opts.rowKey(r))}"` : ''}>${cols.map((c) => `<td title="${esc(c.title?.(r) ?? '')}">${c.cell(r)}</td>`).join('')}</tr>`;
  for (const r of data) {
    html += row(r, [opts.rowClass?.(r), opts.onRow ? 'clickable' : ''].filter(Boolean).join(' '), true);
    for (const c of opts.childrenOf?.(r) || []) html += row(c, 'child', false);
  }
  if (opts.total) html += `<tr class="total">${cols.map((c) => `<td>${c.cell(opts.total)}</td>`).join('')}</tr>`;
  html += '</tbody></table>';
  const el = $('#' + id);
  el.innerHTML = html;
  el.querySelectorAll('th').forEach((th) =>
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      S.sort[id] = { col, dir: sort.col === col ? -sort.dir : -1 };
      render();
    }),
  );
  if (opts.onRow) el.querySelectorAll('tbody tr[data-k]').forEach((tr) => tr.addEventListener('click', () => opts.onRow(tr.dataset.k)));
}

const costCell = (a) => {
  const u = unpricedTok(a);
  return fmtUsd(totalCost(a)) + (u ? ` <span class="unpriced" title="${fmtInt(u)} tokens without a price">+?</span>` : '');
};
const kindCols = (get) =>
  KINDS.map((k) => ({ key: k, label: KIND_LABEL[k], cell: (r) => fmtTok(tok(get(r), k)), sortVal: (r) => tok(get(r), k), title: (r) => fmtInt(tok(get(r), k)) }));

// Child path relative to the folder holding the repo, so clones and worktrees read
// alike: "cage-tiny/docs/plans", "cage-main/.claude/worktrees/wf_…".
function childLabel(c) {
  for (const base of [c.root, c.top]) {
    if (!base) continue;
    const parent = base.slice(0, base.lastIndexOf('/'));
    if (parent && c.cwd.startsWith(parent + '/')) return c.cwd.slice(parent.length + 1);
  }
  return shortProject(c.cwd);
}

function renderTables(L) {
  const scope = S.focus
    ? `${periodLabel(L.periods.get(S.focus) || L.list.find((p) => p.key === S.focus), S.period, true)} · <button class="link" id="clear-focus">全部期間</button>`
    : '全部期間';
  $('#scope-model').innerHTML = scope;
  $('#scope-project').innerHTML = scope;
  document.querySelectorAll('#clear-focus').forEach((b) => (b.onclick = () => setFocus(null)));

  const models = [...L.byModel].map(([name, a]) => ({ name, a }));
  table(
    'tbl-model',
    [
      { key: 'name', label: 'Model', cell: (r) => esc(r.name), sortVal: (r) => r.name },
      { key: 'msgs', label: 'Msgs', cell: (r) => fmtInt(r.a.msgs), sortVal: (r) => r.a.msgs },
      ...kindCols((r) => r.a),
      { key: 'cost', label: 'USD', cell: (r) => costCell(r.a), sortVal: (r) => totalCost(r.a) },
    ],
    models,
    { defaultSort: 'cost', total: totalRow(models) },
  );

  const projects = [...L.byProject.values()].map((g) => ({ ...g, name: g.label }));
  const machineName = (id) => S.machines.find((m) => m.id === id)?.name || id;
  const expandable = (g) => S.projGroup !== 'path' && g.children.size > 1;
  table(
    'tbl-project',
    [
      {
        key: 'name',
        label: 'Project',
        cell: (r) =>
          r.children
            ? `${expandable(r) ? `<span class="caret">${S.expanded.has(r.key) ? '▾' : '▸'}</span>` : '<span class="caret"></span>'}${esc(r.name)}${expandable(r) ? ` <span class="count">${r.children.size}</span>` : ''}`
            : esc(r.name),
        title: (r) => r.title || '',
        sortVal: (r) => r.name,
      },
      { key: 'msgs', label: 'Msgs', cell: (r) => fmtInt(r.a.msgs), sortVal: (r) => r.a.msgs },
      ...kindCols((r) => r.a),
      { key: 'cost', label: 'USD', cell: (r) => costCell(r.a), sortVal: (r) => totalCost(r.a) },
    ],
    projects,
    {
      defaultSort: 'cost',
      total: totalRow(projects),
      rowKey: (r) => r.key,
      onRow: (k) => {
        if (!expandable(L.byProject.get(k))) return;
        S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k);
        render();
      },
      childrenOf: (g) => {
        if (!expandable(g) || !S.expanded.has(g.key)) return [];
        const kids = [...g.children.values()].sort((x, y) => totalCost(y.a) - totalCost(x.a));
        const multi = new Set(kids.map((c) => c.mid)).size > 1;
        return kids.map((c) => ({ name: (multi ? `[${machineName(c.mid)}] ` : '') + childLabel(c), title: c.cwd, a: c.a }));
      },
    },
  );
  for (const b of document.querySelectorAll('#seg-proj button')) b.classList.toggle('on', b.dataset.v === S.projGroup);

  const periods = [...L.list].reverse().map((p) => ({ name: periodLabel(p, S.period, true), key: p.key, start: p.start, a: p.agg }));
  const curKey = periodOf(nowWall(), S.period).key;
  table(
    'tbl-period',
    [
      { key: 'start', label: 'Period', cell: (r) => esc(r.name), sortVal: (r) => r.start },
      { key: 'msgs', label: 'Msgs', cell: (r) => fmtInt(r.a.msgs), sortVal: (r) => r.a.msgs },
      ...kindCols((r) => r.a),
      { key: 'tok', label: 'Tokens', cell: (r) => fmtTok(totalTok(r.a)), sortVal: (r) => totalTok(r.a) },
      { key: 'cost', label: 'USD', cell: (r) => costCell(r.a), sortVal: (r) => totalCost(r.a) },
    ],
    periods,
    {
      defaultSort: 'start',
      rowKey: (r) => r.key,
      rowClass: (r) => [r.key === curKey ? 'current' : '', r.key === S.focus ? 'current' : ''].join(' '),
      onRow: (k) => setFocus(S.focus === k ? null : k),
      total: totalRow(periods),
    },
  );
}

function totalRow(list) {
  const a = emptyAgg();
  for (const r of list) {
    a.msgs += r.a.msgs;
    for (const k of KINDS) {
      a[k] += r.a[k];
      a['c_' + k] += r.a['c_' + k];
      a['u_' + k] += r.a['u_' + k];
    }
  }
  return { name: 'Total', key: '', start: 0, a };
}

// ---------- console log ----------
function log(msg, cls = '') {
  const el = $('#log');
  const t = new Date().toLocaleTimeString('en-GB');
  el.insertAdjacentHTML('beforeend', `<span class="${cls}">${esc(t)} ${msg}</span>\n`);
  el.scrollTop = el.scrollHeight;
  $('#console-status').textContent = el.lastElementChild?.textContent.slice(9, 90) || '';
}

// ---------- modals ----------
function modal(html, { onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
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

function machineForm(m = {}) {
  return `<div class="formgrid">
    <label class="f">名稱<input name="name" value="${esc(m.name || '')}" placeholder="linux-box"></label>
    <label class="f wide">Host（IP、hostname 或 ~/.ssh/config 的別名）<input name="host" value="${esc(m.host || '')}" placeholder="192.168.1.23" ${m.type === 'local' ? 'disabled' : ''}></label>
    <label class="f">Port<input name="port" value="${esc(m.port || '')}" placeholder="22" ${m.type === 'local' ? 'disabled' : ''}></label>
    <label class="f">User<input name="user" value="${esc(m.user || '')}" placeholder="(ssh 預設)" ${m.type === 'local' ? 'disabled' : ''}></label>
    <label class="f wide">Identity file（選填，ssh -i）<input name="identityFile" value="${esc(m.identityFile || '')}" placeholder="~/.ssh/id_ed25519" ${m.type === 'local' ? 'disabled' : ''}></label>
    <label class="f wide">讀取模式<select name="readMode" ${m.type === 'local' ? 'disabled' : ''}>${[
      ['auto', 'auto：有 python3 ≥ 3.6 就在遠端解析'],
      ['python', 'python：遠端解析，只傳回精簡紀錄'],
      ['shell', 'shell：只用 grep，傳回原始行'],
    ].map(([v, t]) => `<option value="${v}" ${(m.readMode || 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f full">額外路徑（每行一個 projects 目錄；預設已含 ~/.claude/projects 與 ~/.config/claude/projects）
      <textarea name="extraRoots" rows="2">${esc((m.extraRoots || []).join('\n'))}</textarea></label>
  </div>`;
}
const formData = (el) => Object.fromEntries([...el.querySelectorAll('input[name], textarea[name], select[name]')].filter((i) => !i.disabled).map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]));

function openMachines() {
  const { el, close } = modal(`<h3>Machines</h3>
    <div class="mlist">${S.machines
      .map(
        (m) => `<div class="mcard" data-id="${esc(m.id)}">
        <div class="row" style="margin:0;justify-content:space-between"><b>${esc(m.name)}</b>
          <span><button data-act="sync">Sync</button> <button data-act="edit">Edit</button>
          ${m.type === 'local' ? '' : '<button data-act="del" class="danger">Remove</button>'}</span></div>
        <div class="meta">${m.type === 'local' ? 'local' : `ssh ${esc(m.user ? m.user + '@' : '')}${esc(m.host)}${m.port ? ':' + esc(m.port) : ''}`}
          ${m.lastAddress ? ` · 上次連線 IP ${esc(m.lastAddress)}` : ''} · synced ${fmtAgo(m.lastSyncAt)}
          ${m.fingerprint ? `<br>id ${esc(m.fingerprint)}` : ''}</div>
        ${m.lastError ? `<div class="err-text">${esc(m.lastError)}</div>` : ''}
        <div class="edit" hidden>${machineForm(m)}
          ${m.type === 'local' ? '' : `<div class="row"><label><input type="checkbox" name="resetFingerprint"> 重設機器身分（host 換成另一台機器時才需要）</label></div>`}
          <div class="row"><button data-act="save" class="primary">Save</button></div></div>
      </div>`,
      )
      .join('')}</div>
    <h3 style="margin-top:18px">新增 SSH machine</h3>
    <div id="add-form">${machineForm({})}</div>
    <p class="note">對遠端只做唯讀操作（find / stat / tail / grep）。需要密碼、key passphrase 或確認 host key 時會在這裡跳出對話框。</p>
    <div class="err-text" id="m-err"></div>
    <div class="foot"><button id="m-close">Close</button><button class="primary" id="m-add">Add</button></div>`);
  $('#m-close', el).onclick = close;
  $('#m-add', el).onclick = async () => {
    try {
      const m = await api('/api/machines', { method: 'POST', body: formData($('#add-form', el)) });
      S.selected.add(m.id);
      store.set('selected', [...S.selected]);
      close();
      await loadState();
      openMachines();
    } catch (e) {
      $('#m-err', el).textContent = e.message;
    }
  };
  el.querySelectorAll('.mcard').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'edit') $('.edit', card).hidden = !$('.edit', card).hidden;
        if (act === 'save') {
          await api('/api/machines/' + id, { method: 'PUT', body: formData($('.edit', card)) });
          close();
          await loadState();
          openMachines();
        }
        if (act === 'del' && confirm('移除這台 machine 的設定？（已收集的資料會保留在磁碟上）')) {
          await api('/api/machines/' + id, { method: 'DELETE' });
          close();
          await loadState();
          openMachines();
        }
        if (act === 'sync') {
          close();
          startSync([id]);
        }
      } catch (err) {
        $('#m-err', el).textContent = err.message;
      }
    });
  });
}

async function openPrices() {
  const data = await api('/api/prices');
  const fmtP = (v) => (v == null ? '' : +v.toFixed(4));
  const rowsHtml = Object.entries(data.used)
    .map(([model, p]) => {
      const eff = p.manual || p.auto;
      const src = p.manual ? 'manual' : p.auto ? 'auto' : '<span class="unpriced">none</span>';
      const u = data.unpriced[model];
      return `<tr data-model="${esc(model)}">
        <td>${esc(model)}<br><span class="note">${src}${p.auto?.tiers ? ` · 長 context 加價 >${p.auto.tiers.map((t) => fmtTok(t.above)).join('/')}` : ''}</span></td>
        ${KINDS.map((k) => `<td><input data-k="${k}" value="${fmtP(eff?.[k])}" inputmode="decimal"></td>`).join('')}
        <td style="text-align:left">
          <button data-act="save">存為手動價</button>
          ${p.manual ? '<button data-act="clear">清除手動</button>' : ''}
          ${u ? `<br><button data-act="apply" class="primary" style="margin-top:4px">以此價格計算 ${fmtTok(u)} 未計價 tokens</button>` : ''}
        </td></tr>`;
    })
    .join('');
  const { el, close } = modal(`<h3>Prices <span class="note">USD / 1M tokens</span></h3>
    <p class="note">自動牌價來源：LiteLLM 價格表（社群維護，非 Anthropic 官方）。上次抓取：${data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : '尚未'}
      ${data.lastError ? `<br><span class="err-text">${esc(data.lastError)}</span>` : ''}<br>
      費用在匯入當下用當時的價格計算並凍結，之後改價不會重算舊資料。手動價格優先於自動價格，套用在之後的同步。</p>
    <div class="tbl-wrap"><table class="ptable"><thead><tr><th>Model</th>${KINDS.map((k) => `<th>${KIND_LABEL[k]}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="7">尚無資料，先 Sync 一次</td></tr>'}</tbody></table></div>
    <div class="err-text" id="p-err"></div>
    <div class="foot"><button id="p-refresh">重新抓取牌價</button><button id="p-close" class="primary">Close</button></div>`);
  $('#p-close', el).onclick = close;
  $('#p-refresh', el).onclick = async () => {
    await api('/api/prices/refresh', { method: 'POST' });
    close();
    openPrices();
  };
  el.querySelectorAll('tr[data-model]').forEach((tr) => {
    const model = tr.dataset.model;
    const price = () => Object.fromEntries([...tr.querySelectorAll('input[data-k]')].map((i) => [i.dataset.k, i.value === '' ? NaN : Number(i.value)]));
    tr.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'save') await api('/api/prices/manual', { method: 'PUT', body: { model, price: price() } });
        if (act === 'clear') await api('/api/prices/manual', { method: 'PUT', body: { model, price: null } });
        if (act === 'apply') {
          const r = await api('/api/prices/apply', { method: 'POST', body: { model, price: price() } });
          log(`priced ${r.buckets} buckets of ${esc(model)}`);
          await loadUsage();
        }
        close();
        openPrices();
      } catch (err) {
        $('#p-err', el).textContent = err.message;
      }
    });
  });
}

function openSettings() {
  const s = S.settings;
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const theme = store.get('theme', 'system');
  const { el, close } = modal(`<h3>Settings</h3>
    <div class="formgrid">
      <label class="f wide">時區<input name="timezone" list="tzlist" value="${esc(s.timezone)}"></label>
      <datalist id="tzlist">${tzs.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <label class="f wide">外觀<select name="theme">${['system', 'light', 'dark'].map((t) => `<option ${t === theme ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f">一天開始於<select name="dayStartHour">${hours(s.dayStartHour)}</select></label>
      <label class="f">一週開始於<select name="weekStartDow">${DOW.map((d, i) => `<option value="${i}" ${i === s.weekStartDow ? 'selected' : ''}>星期${d}</option>`).join('')}</select></label>
      <label class="f">&nbsp;<select name="weekStartHour">${hours(s.weekStartHour)}</select></label>
      <span></span>
      <label class="f">每月開始於<select name="monthStartDay">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i + 1 === s.monthStartDay ? 'selected' : ''}>${i + 1} 號</option>`).join('')}</select></label>
      <label class="f">&nbsp;<select name="monthStartHour">${hours(s.monthStartHour)}</select></label>
    </div>
    <p class="note">例如把一週設成 Claude 用量額度重置的星期與小時，「本週」就會對齊額度週期。資料以小時為單位儲存，改設定不需重新同步。</p>
    <p class="note">資料目錄：${esc(S.dataDir || '')}</p>
    <div class="err-text" id="s-err"></div>
    <div class="foot"><button id="s-cancel">Cancel</button><button class="primary" id="s-save">Save</button></div>`);
  $('#s-cancel', el).onclick = close;
  $('#s-save', el).onclick = async () => {
    const v = Object.fromEntries([...el.querySelectorAll('[name]')].map((i) => [i.name, i.value]));
    try {
      store.set('theme', v.theme);
      applyTheme();
      delete v.theme;
      for (const k of Object.keys(v)) if (k !== 'timezone') v[k] = Number(v[k]);
      S.settings = await api('/api/settings', { method: 'PUT', body: v });
      setTz(S.settings.timezone);
      S.focus = null;
      close();
      render();
    } catch (e) {
      $('#s-err', el).textContent = e.message;
    }
  };
}

// ---------- askpass ----------
let askOpen = null;
function showNextAsk() {
  if (askOpen || !S.asks.length) return;
  const a = S.asks[0];
  const yesNo = /\(yes\/no(\/\[fingerprint\])?\)/i.test(a.prompt);
  const secret = !yesNo && /pass(word|phrase)|PIN|token|verification code/i.test(a.prompt);
  askOpen = a.id;
  const { el, close } = modal(
    `<h3>SSH · ${esc(a.machine)}</h3>
    <pre class="prompt">${esc(a.prompt)}</pre>
    ${yesNo ? '<p class="note">第一次連到這台主機，請確認 fingerprint 正確再接受。</p>' : `<input id="ask-in" type="${secret ? 'password' : 'text'}" style="width:100%" autocomplete="off">`}
    <p class="note">${secret ? '密碼只會透過 SSH_ASKPASS 交給本機的 ssh，不會儲存。' : ''}</p>
    <div class="foot"><button id="ask-cancel">Cancel</button>
      ${yesNo ? '<button id="ask-no">No</button><button class="primary" id="ask-yes">Yes, connect</button>' : '<button class="primary" id="ask-ok">OK</button>'}</div>`,
    { onClose: () => answer(null) },
  );
  let answered = false;
  async function answer(v) {
    if (answered) return;
    answered = true;
    askOpen = null;
    S.asks = S.asks.filter((x) => x.id !== a.id);
    close();
    await api('/api/askpass/answer', { method: 'POST', body: v == null ? { id: a.id, cancel: true } : { id: a.id, answer: v } }).catch(() => {});
    showNextAsk();
  }
  $('#ask-cancel', el).onclick = () => answer(null);
  if (yesNo) {
    $('#ask-yes', el).onclick = () => answer('yes');
    $('#ask-no', el).onclick = () => answer('no');
  } else {
    const inp = $('#ask-in', el);
    inp.focus();
    $('#ask-ok', el).onclick = () => answer(inp.value);
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && answer(inp.value));
  }
  a.dismiss = () => {
    answered = true;
    askOpen = null;
    close();
  };
}

// ---------- data loading / events ----------
async function loadState() {
  const st = await api('/api/state');
  S.machines = st.machines;
  S.dataDir = st.dataDir;
  if (!S.settings || st.settings.timezone !== S.settings.timezone) setTz(st.settings.timezone);
  S.settings = st.settings;
  for (const id of st.syncing) S.syncing.add(id);
  if (!store.get('selected', null)) S.selected = new Set(S.machines.map((m) => m.id));
  for (const id of [...S.selected]) if (!S.machines.some((m) => m.id === id)) S.selected.delete(id);
  renderChips();
}

async function loadUsage() {
  S.usage = await api('/api/usage');
  render();
}

async function startSync(ids) {
  try {
    await api('/api/sync', { method: 'POST', body: { ids } });
  } catch (e) {
    log(esc(e.message), 'err');
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  const name = (id) => (id === '*' ? '*' : S.machines.find((m) => m.id === id)?.name || id);
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    log(`<span class="m">[${esc(name(d.machine))}]</span> ${esc(d.msg)}`, d.error ? 'err' : '');
    if (d.error) $('#console').classList.add('open');
  });
  es.addEventListener('sync', async (e) => {
    const d = JSON.parse(e.data);
    if (d.state === 'start') {
      d.ids.forEach((id) => S.syncing.add(id));
      $('#console').classList.add('open');
    } else {
      S.syncing.clear();
      await loadState();
      await loadUsage();
    }
    renderChips();
  });
  es.addEventListener('ask', (e) => {
    const a = JSON.parse(e.data);
    if (!S.asks.some((x) => x.id === a.id)) S.asks.push(a);
    showNextAsk();
  });
  es.addEventListener('ask-done', (e) => {
    const { id } = JSON.parse(e.data);
    const a = S.asks.find((x) => x.id === id);
    S.asks = S.asks.filter((x) => x.id !== id);
    if (a && askOpen === id) a.dismiss?.();
    showNextAsk();
  });
}

function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- wiring ----------
function wire() {
  $('#machine-chips').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    e.target.checked ? S.selected.add(id) : S.selected.delete(id);
    store.set('selected', [...S.selected]);
    renderChips();
    render();
  });
  $('#btn-sync').onclick = () => startSync(S.machines.filter((m) => S.selected.has(m.id)).map((m) => m.id));
  $('#btn-machines').onclick = openMachines;
  $('#btn-prices').onclick = openPrices;
  $('#btn-settings').onclick = openSettings;
  $('#console-toggle').onclick = () => $('#console').classList.toggle('open');
  $('#seg-period').onclick = (e) => {
    if (!e.target.dataset.v) return;
    S.period = e.target.dataset.v;
    S.focus = null;
    store.set('period', S.period);
    render();
  };
  $('#seg-metric').onclick = (e) => {
    if (!e.target.dataset.v) return;
    S.metric = e.target.dataset.v;
    store.set('metric', S.metric);
    render();
  };
  $('#seg-proj').onclick = (e) => {
    if (!e.target.dataset.v) return;
    S.projGroup = e.target.dataset.v;
    S.expanded.clear();
    store.set('projGroup', S.projGroup);
    render();
  };
  $('#legend').onclick = (e) => {
    const k = e.target.closest('button[data-k]')?.dataset.k;
    if (!k) return;
    S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k);
    store.set('hidden', [...S.hidden]);
    renderSegs();
    renderChart(last.list);
  };
  $('#seg-range').onclick = (e) => {
    if (e.target.dataset.v == null) return;
    S.range[S.period] = Number(e.target.dataset.v);
    store.set('range', S.range);
    render();
  };
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => last && renderChart(last.list), 100);
  });
}

applyTheme();
wire();
await loadState();
await loadUsage();
connectEvents();
log('ready');
