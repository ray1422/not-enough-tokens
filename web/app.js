// Web console: top bar, summary cards, chart, breakdown tables, sync + askpass.
import {
  $, KINDS, KIND_COLOR, H, RANGES, S, addInto, api, applyTheme, emptyAgg, esc, fmtAgo, fmtInt, fmtTok, fmtUsd,
  kindLabel, machineName, modal, nowWall, periodLabel, periodOf, setTz, shortProject, store, tok, totalCost,
  totalTok, unpricedTok, wallOf,
} from './core.js';
import { setLocale, t, translateDom } from './i18n.js';
import { initSettings, refreshSettings, showSettings } from './settings.js';

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

let groupCache = null; // { usage, mode, map: Map(mid -> Map(cwd -> group)) }
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
  const cur = { week: periodOf(nowWall(), 'week').key, month: periodOf(nowWall(), 'month').key };
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
const mainVisible = () => !$('#main-view').hidden;

function render() {
  if (!S.usage || !S.settings || !mainVisible()) return;
  last = aggregate();
  renderBanner(last.unpricedModels);
  renderHeroes(last);
  renderSegs();
  renderChart(last.list);
  renderTables(last);
}

// Everything that shows text: used after a language change.
function renderAll() {
  translateDom();
  renderChips();
  updateThemeButton();
  render();
}

// ----- top bar: machine chips, collapsing into a "+N" menu when they don't fit -----
function machineTitle(m) {
  return [
    m.type === 'local' ? t('chips.local') : `ssh ${m.user ? m.user + '@' : ''}${m.host}${m.port ? ':' + m.port : ''}`,
    m.lastAddress ? t('chips.lastAddress', { a: m.lastAddress }) : '',
    t('chips.synced', { ago: fmtAgo(m.lastSyncAt) }),
    m.lastError ? t('chips.error', { e: m.lastError }) : '',
  ].filter(Boolean).join('\n');
}
const machineState = (m) => (S.syncing.has(m.id) ? 'busy' : m.lastError ? 'err' : m.lastSyncAt ? 'ok' : '');
const chipHtml = (m) => {
  const on = S.selected.has(m.id);
  return `<label class="chip ${on ? '' : 'off'}" title="${esc(machineTitle(m))}">
    <input type="checkbox" data-id="${esc(m.id)}" ${on ? 'checked' : ''}>
    <span class="dot ${machineState(m)}"></span>${esc(m.name)}</label>`;
};

function renderChips() {
  const el = $('#machine-chips'), more = $('#chips-more');
  el.innerHTML = S.machines.map(chipHtml).join('');
  more.hidden = true;
  const chips = [...el.children];
  const avail = $('#chips-wrap').clientWidth;
  const gap = 6;
  const widths = chips.map((c) => c.offsetWidth + gap);
  if (widths.reduce((a, b) => a + b, 0) > avail) {
    more.hidden = false;
    let used = more.offsetWidth + gap, shown = 0;
    for (const w of widths) {
      if (used + w > avail) break;
      used += w;
      shown++;
    }
    chips.slice(shown).forEach((c) => (c.hidden = true));
    const rest = S.machines.slice(shown);
    const on = S.machines.filter((m) => S.selected.has(m.id)).length;
    // Nothing fits (phone): show "selected/total"; otherwise "+N" for the hidden ones.
    $('span', more).textContent = shown ? t('chips.more', { n: rest.length }) : t('chips.count', { on, n: S.machines.length });
    more.title = t('chips.moreTitle');
  }
  if (!$('#chips-pop').hidden) renderChipsPopover();

  const n = S.machines.filter((m) => S.selected.has(m.id)).length;
  const btn = $('#btn-sync');
  $('span', btn).textContent = S.syncing.size ? t('nav.syncing') : n < S.machines.length ? t('nav.syncN', { n }) : t('nav.sync');
  btn.disabled = S.syncing.size > 0 || n === 0;
  btn.classList.toggle('spinning', S.syncing.size > 0);
}

function renderChipsPopover() {
  const pop = $('#chips-pop');
  pop.innerHTML = `<div class="pop-head">
      <button class="link" data-act="all">${esc(t('chips.all'))}</button>
      <button class="link" data-act="none">${esc(t('chips.none'))}</button></div>
    <div class="pop-list">${S.machines
      .map(
        (m) => `<label class="pop-item" title="${esc(machineTitle(m))}">
        <input type="checkbox" data-id="${esc(m.id)}" ${S.selected.has(m.id) ? 'checked' : ''}>
        <span class="dot ${machineState(m)}"></span><span class="name">${esc(m.name)}</span>
        <span class="ago">${esc(fmtAgo(m.lastSyncAt))}</span></label>`,
      )
      .join('')}</div>
    <a class="pop-foot" href="#settings/machines">${esc(t('chips.manage'))}</a>`;
}

function toggleChipsPopover(open) {
  const pop = $('#chips-pop');
  open ??= pop.hidden;
  pop.hidden = !open;
  $('#chips-more').setAttribute('aria-expanded', String(open));
  if (open) renderChipsPopover();
}

function setSelected(ids) {
  S.selected = new Set(ids);
  store.set('selected', [...S.selected]);
  renderChips();
  render();
}

// ----- theme toggle: system -> light -> dark -----
const THEMES = ['system', 'light', 'dark'];
function updateThemeButton() {
  const th = store.get('theme', 'system');
  $('#btn-theme use').setAttribute('href', { system: '#i-auto', light: '#i-sun', dark: '#i-moon' }[th]);
  const label = t({ system: 'gen.themeSystem', light: 'gen.themeLight', dark: 'gen.themeDark' }[th]);
  $('#btn-theme').title = `${t('gen.theme')}: ${label}`;
}

// ----- main view -----
function renderBanner(unpriced) {
  const el = $('#unpriced-banner');
  if (!unpriced.size) return (el.hidden = true);
  el.hidden = false;
  const list = [...unpriced].map(([m, n]) => `<b>${esc(m)}</b> ${fmtTok(n)}`).join(', ');
  el.innerHTML = `${t('banner.unpriced', { list })} <a href="#settings/prices">${esc(t('banner.setPrices'))}</a>`;
}

function kindsBlock(a) {
  return `<div class="kinds">${KINDS.map(
    (k) => `<span class="k"><i class="sw" style="background:${KIND_COLOR[k]}"></i>${esc(kindLabel(k))}</span>
      <span class="v">${fmtTok(tok(a, k))}</span><span class="c">${fmtUsd(a['c_' + k])}</span>`,
  ).join('')}</div>`;
}

function renderHeroes(L) {
  const wk = periodOf(nowWall(), 'week'), mo = periodOf(nowWall(), 'month');
  const card = (title, range, a) => `<div class="hero">
    <div class="label"><span>${esc(title)}</span><span class="range">${esc(range)}</span></div>
    <div class="big">${fmtUsd(totalCost(a))}</div>
    <div class="sub">${esc(t('hero.sub', { tok: fmtTok(totalTok(a)), msgs: fmtInt(a.msgs) }))}${
      unpricedTok(a) ? ` · <span class="unpriced">${esc(t('hero.unpriced', { tok: fmtTok(unpricedTok(a)) }))}</span>` : ''
    }</div>
    ${kindsBlock(a)}</div>`;
  $('#heroes').innerHTML =
    card(t('hero.week'), periodLabel(wk, 'week'), L.heroes.week) +
    card(t('hero.month'), periodLabel(mo, 'month', S.settings.monthStartDay !== 1), L.heroes.month) +
    card(t('hero.all'), t('hero.machines', { n: S.selected.size }), L.heroes.all);
}

function renderSegs() {
  for (const b of document.querySelectorAll('#seg-period button')) b.classList.toggle('on', b.dataset.v === S.period);
  for (const b of document.querySelectorAll('#seg-metric button')) b.classList.toggle('on', b.dataset.v === S.metric);
  const cur = S.range[S.period] ?? RANGES[S.period][0];
  $('#seg-range').innerHTML = RANGES[S.period]
    .map((n) => `<button data-v="${n}" class="${n === cur ? 'on' : ''}">${esc(n ? t('range.' + S.period, { n }) : t('range.all'))}</button>`)
    .join('');
  $('#legend').innerHTML = KINDS.map(
    (k) =>
      `<button type="button" data-k="${k}" class="${S.hidden.has(k) ? 'off' : ''}" aria-pressed="${!S.hidden.has(k)}" title="${esc(t('legend.toggle'))}"><i class="sw" style="background:${KIND_COLOR[k]}"></i>${esc(kindLabel(k))}</button>`,
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

  let svg = `<svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${esc(S.metric === 'cost' ? t('metric.cost') : t('metric.tokens'))}">`;
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
      const y0 = y(acc);
      acc += s.v;
      let h = y0 - y(acc) - (j > 0 ? 2 : 0); // 2px surface gap between stacked segments
      if (h < 0.5) h = 0.5;
      const yy = y0 - (j > 0 ? 2 : 0) - h;
      const r = Math.min(6, bw / 2);
      if (j === segs.length - 1 && h > r) {
        // Cubic with both handles at the corner: curvature is 0 where it meets the
        // straight sides, so the rounded top is G2 like the CSS squircles.
        svg += `<path fill="${KIND_COLOR[s.k]}" d="M${x},${yy + h}V${yy + r}C${x},${yy} ${x},${yy} ${x + r},${yy}H${x + bw - r}C${x + bw},${yy} ${x + bw},${yy} ${x + bw},${yy + r}V${yy + h}Z"/>`;
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
        ${KINDS.map((k) => `<div class="row${S.hidden.has(k) ? ' dim' : ''}"><span><i class="sw" style="background:${KIND_COLOR[k]}"></i>${esc(kindLabel(k))}</span><span>${fmtTok(tok(a, k))} · ${fmtUsd(a['c_' + k])}</span></div>`).join('')}
        <div class="row" style="margin-top:4px"><span>${esc(t('tip.total'))}</span><b>${fmtTok(totalTok(a))} · ${fmtUsd(totalCost(a))}</b></div>
        <div class="row"><span>${esc(t('tip.messages'))}</span><span>${fmtInt(a.msgs)}</span></div>`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 12) + 'px';
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
  html += cols.map((c) => `<th data-col="${c.key}">${esc(c.label)}${sort.col === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
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
  return fmtUsd(totalCost(a)) + (u ? ` <span class="unpriced" title="${esc(t('cost.unpricedTitle', { n: fmtInt(u) }))}">+?</span>` : '');
};
const kindCols = (get) =>
  KINDS.map((k) => ({ key: k, label: kindLabel(k), cell: (r) => fmtTok(tok(get(r), k)), sortVal: (r) => tok(get(r), k), title: (r) => fmtInt(tok(get(r), k)) }));
const msgsCol = { key: 'msgs', label: '', cell: (r) => fmtInt(r.a.msgs), sortVal: (r) => r.a.msgs };
const usdCol = { key: 'cost', label: 'USD', cell: (r) => costCell(r.a), sortVal: (r) => totalCost(r.a) };

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
    ? `${esc(periodLabel(L.periods.get(S.focus) || L.list.find((p) => p.key === S.focus), S.period, true))} · <button class="link clear-focus">${esc(t('scope.all'))}</button>`
    : esc(t('scope.all'));
  $('#scope-model').innerHTML = scope;
  $('#scope-project').innerHTML = scope;
  document.querySelectorAll('.clear-focus').forEach((b) => (b.onclick = () => setFocus(null)));
  const msgs = { ...msgsCol, label: t('col.msgs') };
  const usd = { ...usdCol, label: t('col.usd') };

  const models = [...L.byModel].map(([name, a]) => ({ name, a }));
  table(
    'tbl-model',
    [{ key: 'name', label: t('col.model'), cell: (r) => esc(r.name), sortVal: (r) => r.name }, msgs, ...kindCols((r) => r.a), usd],
    models,
    { defaultSort: 'cost', total: totalRow(models) },
  );

  const projects = [...L.byProject.values()].map((g) => ({ ...g, name: g.label }));
  const expandable = (g) => S.projGroup !== 'path' && g.children.size > 1;
  table(
    'tbl-project',
    [
      {
        key: 'name',
        label: t('col.project'),
        cell: (r) =>
          r.children
            ? `${expandable(r) ? `<span class="caret">${S.expanded.has(r.key) ? '▾' : '▸'}</span>` : '<span class="caret"></span>'}${esc(r.name)}${expandable(r) ? ` <span class="count">${r.children.size}</span>` : ''}`
            : esc(r.name),
        title: (r) => r.title || '',
        sortVal: (r) => r.name,
      },
      msgs,
      ...kindCols((r) => r.a),
      usd,
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
      { key: 'start', label: t('col.period'), cell: (r) => esc(r.name), sortVal: (r) => r.start },
      msgs,
      ...kindCols((r) => r.a),
      { key: 'tok', label: t('col.tokens'), cell: (r) => fmtTok(totalTok(r.a)), sortVal: (r) => totalTok(r.a) },
      usd,
    ],
    periods,
    {
      defaultSort: 'start',
      rowKey: (r) => r.key,
      rowClass: (r) => (r.key === curKey || r.key === S.focus ? 'current' : ''),
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
  return { name: t('row.total'), key: '', start: 0, a };
}

// ---------- console log ----------
function log(msg, cls = '') {
  const el = $('#log');
  const time = new Date().toLocaleTimeString('en-GB');
  el.insertAdjacentHTML('beforeend', `<span class="${cls}">${esc(time)} ${msg}</span>\n`);
  el.scrollTop = el.scrollHeight;
  $('#console-status').textContent = el.lastElementChild?.textContent.slice(9, 90) || '';
}

// ---------- askpass ----------
let askOpen = null;
function showNextAsk() {
  if (askOpen || !S.asks.length) return;
  const a = S.asks[0];
  const yesNo = /\(yes\/no(\/\[fingerprint\])?\)/i.test(a.prompt);
  const secret = !yesNo && /pass(word|phrase)|PIN|token|verification code/i.test(a.prompt);
  askOpen = a.id;
  let answered = false;
  const { el, close } = modal(
    `<h3>SSH · ${esc(a.machine)}</h3>
    <pre class="prompt">${esc(a.prompt)}</pre>
    ${yesNo ? `<p class="note">${esc(t('ask.firstConnect'))}</p>` : `<input id="ask-in" type="${secret ? 'password' : 'text'}" style="width:100%" autocomplete="off">`}
    ${secret ? `<p class="note">${esc(t('ask.secretNote'))}</p>` : ''}
    <div class="foot"><button id="ask-cancel">${esc(t('ask.cancel'))}</button>
      ${yesNo ? `<button id="ask-no">${esc(t('ask.no'))}</button><button class="primary" id="ask-yes">${esc(t('ask.yes'))}</button>` : `<button class="primary" id="ask-ok">${esc(t('ask.ok'))}</button>`}</div>`,
    { onClose: () => answer(null) },
  );
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
  if (!S.settings || st.settings.locale !== S.settings.locale) {
    setLocale(st.settings.locale);
    translateDom();
  }
  S.settings = st.settings;
  for (const id of st.syncing) S.syncing.add(id);
  if (!store.get('selected', null)) S.selected = new Set(S.machines.map((m) => m.id));
  for (const id of [...S.selected]) if (!S.machines.some((m) => m.id === id)) S.selected.delete(id);
  renderChips();
  refreshSettings();
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
  const name = (id) => (id === '*' ? '*' : machineName(id));
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

// ---------- routing: "#settings/<tab>" shows the settings page ----------
function route() {
  const m = /^#settings(?:\/(\w+))?/.exec(location.hash);
  $('#main-view').hidden = !!m;
  $('#settings-view').hidden = !m;
  toggleChipsPopover(false);
  if (m) showSettings(m[1]);
  else render();
  window.scrollTo(0, 0);
}

// ---------- wiring ----------
function wire() {
  const onChipChange = (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    const next = new Set(S.selected);
    e.target.checked ? next.add(id) : next.delete(id);
    setSelected(next);
  };
  $('#machine-chips').addEventListener('change', onChipChange);
  $('#chips-pop').addEventListener('change', onChipChange);
  $('#chips-pop').addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'all') setSelected(S.machines.map((m) => m.id));
    if (act === 'none') setSelected([]);
  });
  $('#chips-more').onclick = (e) => {
    e.stopPropagation();
    toggleChipsPopover();
  };
  document.addEventListener('mousedown', (e) => {
    if (!$('#chips-pop').hidden && !e.target.closest('#chips-pop, #chips-more')) toggleChipsPopover(false);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && toggleChipsPopover(false));

  $('#btn-sync').onclick = () => startSync(S.machines.filter((m) => S.selected.has(m.id)).map((m) => m.id));
  $('#btn-theme').onclick = () => {
    const th = store.get('theme', 'system');
    store.set('theme', THEMES[(THEMES.indexOf(th) + 1) % THEMES.length]);
    applyTheme();
    updateThemeButton();
    if (!$('#settings-view').hidden && /general/.test(location.hash)) showSettings('general');
  };
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
  window.addEventListener('hashchange', route);
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      renderChips();
      if (last && mainVisible()) renderChart(last.list);
    }, 100);
  });
}

applyTheme();
initSettings({ loadState, loadUsage, renderAll, startSync, log });
wire();
await loadState();
updateThemeButton();
translateDom();
await loadUsage();
connectEvents();
route();
log(esc(t('console.ready')));
