// Settings page (#settings/<tab>): General, Machines and Prices, with tabs on the left.
import { $, KINDS, S, api, esc, fmtAgo, fmtDay, fmtTok, infoTip, kindLabel, machineSince, modal, setTz, store, applyTheme, applyZoom } from './core.js';
import { LOCALES, setLocale, t } from './i18n.js';
import { applyScrollbar, scrollbarPrefs } from './scrollbar.js';

const tabs = () => ['general', 'machines', 'prices', 'ui'];
const REPO = 'https://github.com/ray1422/not-enough-tokens';
let ctx = null; // callbacks from app.js: { loadState, loadUsage, renderAll, startSync, log }
let current = 'general';

export function initSettings(c) {
  ctx = c;
}

export const settingsHash = (tab = 'general') => `#settings/${tab}`;

export function showSettings(tab) {
  const TABS = tabs();
  current = TABS.includes(tab) ? tab : 'general';
  const view = $('#settings-view');
  view.innerHTML = `<div class="set-wrap">
    <header class="set-head">
      <button class="icon" id="set-back" aria-label="${esc(t('set.close'))}"><svg class="ic"><use href="#i-back"/></svg></button>
      <h2>${esc(t('set.title'))}</h2>
      <span class="saved" id="set-saved" hidden>${esc(t('set.saved'))}</span>
    </header>
    <div class="set-body">
      <nav class="set-tabs" role="tablist">${TABS.map(
        (k) => `<a role="tab" href="${settingsHash(k)}" class="${k === current ? 'on' : ''}" aria-selected="${k === current}">${esc(t('tab.' + k))}</a>`,
      ).join('')}</nav>
      <div class="set-pane" id="set-pane" role="tabpanel"></div>
    </div>
  </div>`;
  $('#set-back').onclick = () => (location.hash = '');
  ({ general: renderGeneral, machines: renderMachines, prices: renderPrices, ui: renderUi })[current]();
}

function flashSaved() {
  const el = $('#set-saved');
  if (!el) return;
  el.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => (el.hidden = true), 1500);
}

// ---------- General ----------
function renderGeneral() {
  const s = S.settings;
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const theme = store.get('theme', 'system');
  const dows = t('dow').split(',');
  $('#set-pane').innerHTML = `
    <section class="set-section">
      <div class="formgrid">
        <label class="f wide">${esc(t('gen.language'))}<select name="locale">
          <option value="auto" ${!s.locale || s.locale === 'auto' ? 'selected' : ''}>${esc(t('gen.langAuto'))}</option>
          ${LOCALES.map(([v, label]) => `<option value="${v}" ${s.locale === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
        <label class="f wide">${esc(t('gen.theme'))}<select name="theme">${[
          ['system', 'gen.themeSystem'],
          ['light', 'gen.themeLight'],
          ['dark', 'gen.themeDark'],
        ].map(([v, k]) => `<option value="${v}" ${v === theme ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select></label>
      </div>
    </section>
    <section class="set-section">
      <h3>${esc(t('gen.periods'))}</h3>
      <div class="formgrid">
        <label class="f wide">${esc(t('gen.timezone'))}<input name="timezone" list="tzlist" value="${esc(s.timezone)}"></label>
        <datalist id="tzlist">${tzs.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
        <label class="f">${esc(t('gen.dayStart'))}<select name="dayStartHour">${hours(s.dayStartHour)}</select></label>
        <span></span>
        <label class="f">${esc(t('gen.weekStart'))}<select name="weekStartDow">${dows.map((d, i) => `<option value="${i}" ${i === s.weekStartDow ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
        <label class="f">&nbsp;<select name="weekStartHour">${hours(s.weekStartHour)}</select></label>
        <label class="f">${esc(t('gen.monthStart'))}<select name="monthStartDay">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i + 1 === s.monthStartDay ? 'selected' : ''}>${esc(t('gen.monthDay', { n: i + 1 }))}</option>`).join('')}</select></label>
        <label class="f">&nbsp;<select name="monthStartHour">${hours(s.monthStartHour)}</select></label>
      </div>
      <p class="note">${esc(t('gen.periodsNote'))}</p>
    </section>
    <section class="set-section">
      <h3>${esc(t('gen.data'))}</h3>
      <p class="note">${esc(t('gen.dataDir'))}: <code>${esc(S.dataDir)}</code></p>
    </section>
    <section class="set-section about">
      <h3>${esc(t('gen.about'))}</h3>
      <div class="about-row">
        <img src="logo.svg" alt="" width="56" height="56">
        <div>
          <div class="about-name">Not Enough Tokens <span class="num">${esc(S.version)}</span></div>
          <p class="note">${esc(t('gen.aboutDesc'))}</p>
          <p class="note">${esc(t('gen.license'))} · <a href="${REPO}" target="_blank" rel="noopener">GitHub</a></p>
        </div>
      </div>
    </section>
    <div class="err-text" id="g-err"></div>`;

  // Every change saves right away.
  $('#set-pane').addEventListener('change', async (e) => {
    const name = e.target.name;
    if (!name) return;
    try {
      if (name === 'theme') {
        store.set('theme', e.target.value);
        applyTheme();
      } else {
        const v = name === 'timezone' || name === 'locale' ? e.target.value : Number(e.target.value);
        S.settings = await api('/api/settings', { method: 'PUT', body: { [name]: v } });
        if (name === 'timezone') setTz(S.settings.timezone);
        if (name === 'locale') {
          setLocale(S.settings.locale);
          showSettings('general');
        }
        S.focus = null;
        ctx.renderAll();
      }
      $('#g-err').textContent = '';
      flashSaved();
    } catch (err) {
      $('#g-err').textContent = err.message;
    }
  });
}

// ---------- UI tuning ----------
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
function renderUi() {
  const p = scrollbarPrefs(store);
  const z = S.settings.zoom || 1;
  // Display scale only in the desktop app; a browser has its own (Ctrl/⌘ +/-).
  $('#set-pane').innerHTML = `${window.netApp?.setZoom ? `
    <section class="set-section">
      <div class="formgrid">
        <label class="f wide">${esc(t('ui.zoom'))}<select name="zoom">${ZOOMS.map((v) => `<option value="${v}" ${v === z ? 'selected' : ''}>${Math.round(v * 100)}%</option>`).join('')}</select></label>
      </div>
    </section>` : ''}
    <section class="set-section">
      <label class="check"><input type="checkbox" name="customScrollbar" ${p.custom ? 'checked' : ''}> ${esc(t('ui.customScrollbar'))}</label>
      <div class="formgrid">
        <label class="f wide">${esc(t('ui.scrollbar'))}<select name="scrollbar" ${p.custom ? '' : 'disabled'}>${[
          ['auto', 'ui.sbAuto'],
          ['always', 'ui.sbAlways'],
        ].map(([v, k]) => `<option value="${v}" ${v === p.mode ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select></label>
      </div>
    </section>`;
  $('#set-pane').addEventListener('change', (e) => {
    const { name } = e.target;
    if (name === 'zoom') {
      api('/api/settings', { method: 'PUT', body: { zoom: Number(e.target.value) } }).then((s) => {
        S.settings = s;
        applyZoom(s.zoom);
        flashSaved();
      });
      return;
    }
    if (name === 'customScrollbar') {
      store.set('customScrollbar', e.target.checked);
      $('#set-pane select[name=scrollbar]').disabled = !e.target.checked;
    } else if (name === 'scrollbar') store.set('scrollbar', e.target.value);
    else return;
    applyScrollbar(scrollbarPrefs(store));
    flashSaved();
  });
}

// ---------- Machines ----------
// Meta parts wrap between each other, not inside one (unless it alone is too long).
// Each part carries its "·" in front, and the one starting a line is clipped off.
const metaItems = (parts) => `<span class="mis">${parts.map((p) => `<span class="mi">${esc(p)}</span>`).join('')}</span>`;

function machineForm(m = {}) {
  const off = m.type === 'local' ? 'disabled' : '';
  return `<div class="formgrid">
    <label class="f">${esc(t('m.name'))}<input name="name" value="${esc(m.name || '')}" placeholder="linux-box"></label>
    <label class="f wide">${esc(t('m.host'))}<input name="host" value="${esc(m.host || '')}" placeholder="192.168.1.23" ${off}></label>
    ${m.type === 'local' ? '' : `<label class="f full">${esc(t('m.altHosts'))}
      <textarea name="altHosts" rows="2" placeholder="my-box.tailnet.ts.net">${esc((m.altHosts || []).join('\n'))}</textarea></label>`}
    <label class="f">${esc(t('m.port'))}<input name="port" value="${esc(m.port || '')}" placeholder="22" ${off}></label>
    <label class="f">${esc(t('m.user'))}<input name="user" value="${esc(m.user || '')}" placeholder="${esc(t('m.userPh'))}" ${off}></label>
    <label class="f wide">${esc(t('m.identity'))}<input name="identityFile" value="${esc(m.identityFile || '')}" placeholder="~/.ssh/id_ed25519" ${off}></label>
    <label class="f wide">${esc(t('m.readMode'))}<select name="readMode" ${off}>${[
      ['auto', 'm.modeAuto'],
      ['python', 'm.modePython'],
      ['shell', 'm.modeShell'],
    ].map(([v, k]) => `<option value="${v}" ${(m.readMode || 'auto') === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select></label>
    <label class="f full">${esc(t('m.extraRoots'))}
      <textarea name="extraRoots" rows="2">${esc((m.extraRoots || []).join('\n'))}</textarea></label>
  </div>`;
}
const formData = (el) =>
  Object.fromEntries(
    [...el.querySelectorAll('input[name], textarea[name], select[name]')].filter((i) => !i.disabled).map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]),
  );

function renderMachines() {
  const pane = $('#set-pane');
  pane.innerHTML = `
    <div class="pane-head">
      <button id="m-discover" class="with-icon"><svg class="ic"><use href="#i-network"/></svg>${esc(t('d.title'))}</button>
      <button id="m-add-open" class="primary">+ ${esc(t('m.addTitle'))}</button>
    </div>
    <div id="add-form" class="mcard" hidden>
      <h3>${esc(t('m.addTitle'))}</h3>
      ${machineForm({})}
      <div class="foot"><button id="m-add-test" class="test">${esc(t('m.test'))}</button><span class="status"></span><button id="m-add-cancel">${esc(t('m.cancel'))}</button><button class="primary" id="m-add">${esc(t('m.add'))}</button></div>
    </div>
    <div class="mlist">${S.machines
      .map((m) => {
        const where = m.type === 'local' ? t('m.local') : `ssh ${m.user ? m.user + '@' : ''}${m.host}${m.port ? ':' + m.port : ''}`;
        const via = m.lastHost && m.lastHost !== m.host ? t('m.via', { h: m.lastHost }) : '';
        const meta = [where, via, m.lastAddress ? t('m.lastAddress', { a: m.lastAddress }) : '', t('m.synced', { ago: fmtAgo(m.lastSyncAt) }), machineSince(m.id) != null ? t('m.since', { d: fmtDay(machineSince(m.id)) }) : ''].filter(Boolean);
        return `<div class="mcard" data-id="${esc(m.id)}">
          <div class="mrow"><b>${esc(m.name)}</b>
            <span class="btns">${m.twinOf ? `<button data-act="merge" class="primary">${esc(t('m.merge'))}</button>` : ''}${
              m.hostKeyIssue ? `<button data-act="hostkey" class="danger">${esc(t('m.hostKey'))}</button>` : ''
            }<button data-act="sync">${esc(t('m.sync'))}</button><button data-act="edit">${esc(t('m.edit'))}</button>${
              m.type === 'local' ? '' : `<button data-act="del" class="danger">${esc(t('m.remove'))}</button>`
            }</span></div>
          <div class="meta">${metaItems(meta)}${m.fingerprint ? metaItems([t('m.id', { id: m.fingerprint })]) : ''}</div>
          ${m.lastError ? `<div class="err-text">${esc(m.lastError)}</div>` : ''}
          <div class="edit" hidden>${machineForm(m)}
            ${m.type === 'local' ? '' : `<label class="check"><input type="checkbox" name="resetFingerprint"> ${esc(t('m.resetFp'))}</label>`}
            <div class="foot">${m.type === 'local' ? '' : `<button data-act="test" class="test">${esc(t('m.test'))}</button><span class="status"></span>`}<button data-act="save" class="primary">${esc(t('m.save'))}</button></div></div>
        </div>`;
      })
      .join('')}</div>
    <div class="err-text" id="m-err"></div>`;

  const showErr = (e) => ($('#m-err').textContent = e.message);
  // Opens the add form, optionally filled in from a discovered machine.
  const openAdd = (fill = {}) => {
    const form = $('#add-form');
    for (const [k, v] of Object.entries(fill)) {
      const el = form.querySelector(`[name="${k}"]`);
      if (el) el.value = v;
    }
    form.hidden = false;
    $('#m-add-open').disabled = true;
    form.querySelector(fill.name ? 'input[name="user"]' : 'input[name="name"]').focus();
  };
  $('#m-add-open').onclick = () => openAdd();
  $('#m-discover').onclick = () => openDiscover(openAdd);
  $('#m-add-cancel').onclick = () => renderMachines();
  $('#m-add-test').onclick = () => testForm($('#add-form'));
  $('#m-add').onclick = async () => {
    try {
      const m = await api('/api/machines', { method: 'POST', body: formData($('#add-form')) });
      S.selected.add(m.id);
      store.set('selected', [...S.selected]);
      await ctx.loadState();
      renderMachines();
    } catch (e) {
      showErr(e);
    }
  };
  pane.querySelectorAll('.mcard').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'edit') $('.edit', card).hidden = !$('.edit', card).hidden;
        if (act === 'test') testForm($('.edit', card), id);
        if (act === 'save') {
          await api('/api/machines/' + id, { method: 'PUT', body: formData($('.edit', card)) });
          await ctx.loadState();
          renderMachines();
        }
        const del = act === 'del' && (await confirmDialog(t('m.confirmRemove'), t('m.remove'), t('m.purge')));
        if (del) {
          await api('/api/machines/' + id + (del.checked ? '?purge=1' : ''), { method: 'DELETE' });
          await ctx.loadState();
          await ctx.loadUsage();
          renderMachines();
        }
        if (act === 'sync') ctx.startSync([id]);
        if (act === 'merge') await askMerge(S.machines.find((x) => x.id === id));
        if (act === 'hostkey') await askHostKey(S.machines.find((x) => x.id === id));
      } catch (err) {
        showErr(err);
      }
    });
  });
}

// ---------- Test connection ----------
// Shows a test's outcome in the box's .status (created at the top right if missing).
// self: the machine being edited, if any. A login that reads another known machine's
// fingerprint says so, so the same box isn't added twice.
const nameOf = (id) => S.machines.find((m) => m.id === id)?.name;
function describeTest(r, self) {
  if (r.result === 'ok' && r.known && r.known !== self) return self === undefined ? [t('tc.isKnown', { name: nameOf(r.known) }), 'ok'] : [t('tc.already', { name: nameOf(r.known) }), 'warn'];
  return [t('tc.' + r.result, { e: r.detail }), r.result === 'ok' ? 'ok' : r.result === 'auth' || r.result === 'hostkey' ? 'warn' : 'bad'];
}
function showTest(box, promise, { self, then, host } = {}) {
  let el = box.querySelector('.status');
  if (!el) {
    el = document.createElement('span');
    el.className = 'status';
    (box.querySelector('.top') || box).append(el);
  }
  el.className = 'status';
  el.textContent = t('tc.testing');
  el.removeAttribute('title');
  promise.then(
    (r) => {
      const [text, cls] = describeTest(r, self);
      el.textContent = text;
      el.classList.add(cls);
      if (r.detail) el.title = r.detail;
      // Also in the console, which keeps it after the modal or form is gone.
      ctx.log(esc(t('tc.log', { host: host || '?', r: text }) + (r.detail ? ` — ${r.detail}` : '')), cls === 'bad' ? 'err' : '');
      then?.(r);
    },
    (e) => {
      el.textContent = e.message;
      el.classList.add('bad');
      ctx.log(esc(t('tc.log', { host: host || '?', r: e.message })), 'err');
    },
  );
}
const testForm = (box, self = null) => {
  const body = formData(box);
  showTest(box, api('/api/test-connection', { method: 'POST', body }), { self, host: body.host });
};

// ---------- Discover ----------
// Machines found over mDNS and Tailscale, one row per source (never merged by name);
// source tags filter the list, Add fills the add form, and Test tells by fingerprint
// which known machine a row is, offering its address as a fallback.
const SOURCES = ['mdns', 'tailscale'];
// Addresses to use for a found machine, from the sources being shown only: the LAN
// IP (a .local name needs avahi + nss-mdns to resolve on Linux) and the Tailscale
// name. For a known machine m, skips any it already lists, by name or by an IP
// the source reported, so the same box isn't added twice under another spelling.
// LAN address preference: a regular IPv4, then link-local 169.254 (self-assigned,
// e.g. a Thunderbolt bridge), then the .local name.
const lanRank = (a) => (!/^\d+\.\d+\.\d+\.\d+$/.test(a) ? 2 : a.startsWith('169.254.') ? 1 : 0);
function offer(d, shown, m) {
  const have = new Set([m?.host, ...(m?.altHosts || []), m?.lastAddress].filter(Boolean).map((h) => String(h).toLowerCase()));
  const out = [];
  if (shown.has('mdns') && d.mdns) {
    const ip = [...d.mdns.addrs, d.mdns.host].sort((a, b) => lanRank(a) - lanRank(b))[0];
    if (![d.mdns.host, ...d.mdns.addrs].some((h) => have.has(h.toLowerCase()))) out.push(ip);
  }
  if (shown.has('tailscale') && d.tailscale && ![d.tailscale.host, ...d.tailscale.ips].some((h) => have.has(h.toLowerCase()))) out.push(d.tailscale.host);
  return out;
}
function openDiscover(onAdd) {
  const shown = new Set(SOURCES);
  let data = null;
  const { el, close } = modal(
    `<h3>${esc(t('d.title'))}</h3>
    <div class="src-tags"></div>
    <div class="disc-list"></div>
    <div class="foot"><button data-act="close">${esc(t('set.close'))}</button><button data-act="rescan">${esc(t('d.rescan'))}</button></div>`,
    { cls: 'discover' },
  );
  const tags = () => {
    $('.src-tags', el).innerHTML = SOURCES.map((s) => {
      const st = data?.sources[s];
      const err = st && !st.ok && st.error;
      return `<button class="tag ${shown.has(s) && !err ? 'on' : ''}" data-src="${s}" aria-pressed="${shown.has(s) && !err}" ${err ? `disabled title="${esc(err)}"` : ''}>${
        s === 'mdns' ? '<svg class="ic sm"><use href="#i-network"/></svg>' : ''
      }${esc(t('d.' + s))}${err ? ` <span class="why">${esc(t('d.unavailable', { e: t('d.' + st.reason) }))}</span>` : ''}</button>`;
    }).join('');
  };
  const list = () => {
    if (!data) return ($('.disc-list', el).innerHTML = `<p class="note">${esc(t('d.searching'))}</p>`);
    const rows = data.machines.filter((d) => (shown.has('mdns') && d.mdns) || (shown.has('tailscale') && d.tailscale));
    $('.disc-list', el).innerHTML = rows.length
      ? rows.map((d) => {
          const via = [d.mdns && t('d.mdns'), d.tailscale && t('d.tailscale')].filter(Boolean).join(' · ');
          const where = [d.mdns && [d.mdns.host, ...d.mdns.addrs].join(' '), d.tailscale && `${d.tailscale.host}${d.tailscale.online ? '' : ` (${t('d.offline')})`}`].filter(Boolean);
          const device = d.mdns?.kind === 'device' || /^(iOS|android|tvOS)$/i.test(d.tailscale?.os || '');
          // [short status, explanation for the (i)]; mDNS only tells what a host announces.
          const [hint, why] =
            d.mdns?.ssh != null ? [t('d.ssh', { p: d.mdns.ssh }), '']
            : d.mdns?.kind === 'mac' ? [t('d.noSshShort'), t('d.macHint')]
            : device ? [t('d.notComputerShort'), d.mdns?.kind === 'device' ? t('d.notComputer') : t('d.notComputerTs', { os: d.tailscale.os })]
            : d.mdns ? [t('d.noSshShort'), t('d.noSsh')]
            : ['', ''];
          const known = d.known && S.machines.find((m) => m.id === d.known);
          const alt = known ? offer(d, shown, known) : [];
          const acts = known
            ? alt.length ? `<button data-alt="${esc(d.key)}" title="${esc(alt.join(', '))}">${esc(t('d.addAlt'))}</button>` : ''
            : `<button data-test="${esc(d.key)}">${esc(t('d.test'))}</button><button data-add="${esc(d.key)}">${esc(t('m.add'))}</button>`;
          const status = known ? t('d.known', { name: known.name }) : hint;
          return `<div class="disc-row" data-key="${esc(d.key)}">
            <div class="top"><b>${esc(d.name)}</b><span class="via">${esc(via)}</span>
              ${status ? `<span class="status ${!known && d.mdns?.ssh != null ? 'ok' : ''}">${esc(status)}${!known && why ? ` ${infoTip(why)}` : ''}</span>` : ''}</div>
            <div class="meta">${where.map(esc).join('<br>')}</div>
            <div class="acts">${acts}</div>
          </div>`;
        }).join('')
      : `<p class="note">${esc(t('d.none'))}</p>`;
  };
  const scan = async () => {
    data = null;
    tags();
    list();
    try {
      data = await api('/api/discover');
    } catch (e) {
      data = { sources: {}, machines: [] };
      $('.disc-list', el).innerHTML = `<p class="err-text">${esc(e.message)}</p>`;
      ctx.log(esc(t('d.logFail', { e: e.message })), 'err');
      return tags();
    }
    const off = SOURCES.filter((s) => data.sources[s] && !data.sources[s].ok && !data.sources[s].off)
      .map((s) => `${t('d.' + s)}: ${t('d.' + data.sources[s].reason)} (${data.sources[s].error})`);
    ctx.log(esc([t('d.log', { n: data.machines.length }), ...off].join(' — ')));
    tags();
    list();
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close') close();
    if (b.dataset.act === 'rescan') scan();
    if (b.dataset.src) {
      shown.has(b.dataset.src) ? shown.delete(b.dataset.src) : shown.add(b.dataset.src);
      tags();
      list();
    }
    if (b.dataset.test) {
      const d = data.machines.find((x) => x.key === b.dataset.test);
      const row = b.closest('.disc-row');
      // Same address Add would use: the LAN IP, since .local may not resolve here.
      const host = offer(d, new Set(SOURCES))[0] || d.mdns?.host || d.tailscale?.host;
      showTest(row, api('/api/test-connection', { method: 'POST', body: { host, port: d.mdns?.ssh || '' } }), {
        host,
        // Now we know which machine it is: offer the names it was found under as fallbacks.
        then: (r) => {
          const m = r.result === 'ok' && r.known && S.machines.find((x) => x.id === r.known);
          if (!m) return;
          d.known = m.id;
          const alt = offer(d, shown, m);
          $('.acts', row).innerHTML = alt.length ? `<button data-alt="${esc(d.key)}" title="${esc(alt.join(', '))}">${esc(t('d.addAlt'))}</button>` : '';
        },
      });
    }
    if (b.dataset.alt) {
      const d = data.machines.find((x) => x.key === b.dataset.alt);
      const m = S.machines.find((x) => x.id === d.known);
      b.disabled = true;
      api('/api/machines/' + m.id, { method: 'PUT', body: { altHosts: [...(m.altHosts || []), ...offer(d, shown, m)] } })
        .then(async () => {
          await ctx.loadState();
          const st = b.closest('.disc-row').querySelector('.status');
          if (st) (st.textContent = t('d.altAdded')), st.classList.add('ok');
          b.remove();
        })
        .catch((e) => ((b.disabled = false), showTest(b.closest('.disc-row'), Promise.reject(e))));
    }
    const d = b.dataset.add && data.machines.find((x) => x.key === b.dataset.add);
    if (d) {
      close();
      const [host = '', ...alts] = offer(d, shown);
      onAdd({
        name: d.name,
        host,
        altHosts: alts.join('\n'),
        port: d.mdns?.ssh && d.mdns.ssh !== 22 ? String(d.mdns.ssh) : '',
      });
    }
  });
  scan();
}

// Called by app.js when machine state changes (sync finished, etc.).
export function refreshSettings() {
  if (!$('#settings-view').hidden && current === 'machines' && !$('#set-pane .edit:not([hidden]), #add-form:not([hidden])')) renderMachines();
}

// ---------- Prices ----------
async function renderPrices() {
  const pane = $('#set-pane');
  const data = await api('/api/prices');
  if (current !== 'prices') return;
  const fmtP = (v) => (v == null ? '' : +v.toFixed(4));
  const rowsHtml = Object.entries(data.used)
    .map(([model, p]) => {
      const eff = p.manual || p.auto;
      const src = p.manual ? esc(t('p.manual')) : p.auto ? esc(t('p.auto')) : `<span class="unpriced">${esc(t('p.none'))}</span>`;
      const u = data.unpriced[model];
      const tiers = p.auto?.tiers ? ` · ${esc(t('p.tiers', { t: p.auto.tiers.map((x) => fmtTok(x.above)).join('/') }))}` : '';
      return `<tr data-model="${esc(model)}">
        <td>${esc(model)}<br><span class="note">${src}${tiers}</span></td>
        ${KINDS.map((k) => `<td><input data-k="${k}" value="${fmtP(eff?.[k])}" inputmode="decimal" aria-label="${esc(model)} ${esc(kindLabel(k))}"></td>`).join('')}
        <td class="acts">
          <button data-act="save">${esc(t('p.saveManual'))}</button>
          ${p.manual ? `<button data-act="clear">${esc(t('p.clearManual'))}</button>` : ''}
          ${u ? `<button data-act="apply" class="primary">${esc(t('p.apply', { tok: fmtTok(u) }))}</button>` : ''}
        </td></tr>`;
    })
    .join('');
  pane.innerHTML = `
    <section class="set-section">
      <p class="note">${esc(t('p.source', { at: data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : t('p.never') }))}
        ${data.lastError ? `<br><span class="err-text">${esc(data.lastError)}</span>` : ''}</p>
      <p class="note">${esc(t('p.frozen'))}</p>
      <div class="row-r"><span class="note">${esc(t('p.unit'))}</span><button id="p-refresh">${esc(t('p.refresh'))}</button></div>
      <div class="tbl-wrap"><table class="ptable"><thead><tr><th>${esc(t('col.model'))}</th>${KINDS.map((k) => `<th>${esc(kindLabel(k))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="7">${esc(t('p.empty'))}</td></tr>`}</tbody></table></div>
    </section>
    <div class="err-text" id="p-err"></div>`;
  $('#p-refresh').onclick = async () => {
    await api('/api/prices/refresh', { method: 'POST' });
    renderPrices();
  };
  pane.querySelectorAll('tr[data-model]').forEach((tr) => {
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
          ctx.log(esc(t('p.applied', { n: r.buckets, model })));
          await ctx.loadUsage();
        }
        flashSaved();
        renderPrices();
      } catch (err) {
        $('#p-err').textContent = err.message;
      }
    });
  });
}

// A new entry whose first sync found an existing machine (`twinOf`): offer to fold
// its address into that machine instead of keeping a duplicate.
export async function askMerge(m) {
  const twin = m && S.machines.find((x) => x.id === m.twinOf);
  if (!twin) return;
  const choice = await new Promise((resolve) => {
    const { el, close } = modal(
      `<h3>${esc(t('m.twinTitle'))}</h3>
      <p>${esc(t('m.twinMsg', { host: m.host, name: twin.name }))}</p>
      <div class="foot"><button data-v="">${esc(t('m.cancel'))}</button><button data-v="main">${esc(t('m.twinMain'))}</button><button class="primary" data-v="alt">${esc(t('m.twinAlt'))}</button></div>`,
      { onClose: () => resolve('') },
    );
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => (resolve(b.dataset.v), close())));
    el.querySelector('[data-v="alt"]').focus();
  });
  if (!choice) return;
  await api(`/api/machines/${m.id}/merge`, { method: 'POST', body: { into: twin.id, asMain: choice === 'main' } });
  S.selected.delete(m.id);
  store.set('selected', [...S.selected]);
  await ctx.loadState();
  refreshSettings();
  ctx.renderAll();
}

// ssh refused because a known address now answers with another host key: a floating
// IP handed to someone else, or a reinstall. Explain, and only for the main host offer
// to forget the old key; the next connection then asks to trust the new one, and the
// machine fingerprint must still match before anything is read.
export async function askHostKey(m) {
  const hk = m?.hostKeyIssue;
  if (!hk) return;
  const forget = await new Promise((resolve) => {
    const { el, close } = modal(
      `<h3>${esc(t('hk.title'))}</h3>
      <p>${esc(t('hk.msg', { host: hk.host, name: m.name }))}</p>
      ${hk.fingerprint ? `<pre class="prompt">${esc(t('hk.newKey'))}\n${esc(hk.fingerprint)}</pre>` : ''}
      <p class="note">${esc(t(hk.main ? 'hk.mainNote' : 'hk.altNote'))}</p>
      <div class="foot"><button class="primary" data-v="0">${esc(t('m.cancel'))}</button>${
        hk.main ? `<button class="danger" data-v="1">${esc(t('hk.forget'))}</button>` : ''
      }</div>`,
      { onClose: () => resolve(false) },
    );
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => (resolve(b.dataset.v === '1'), close())));
    el.querySelector('[data-v="0"]').focus();
  });
  if (!forget) return;
  await api(`/api/machines/${m.id}/forget-hostkey`, { method: 'POST' });
  await ctx.loadState();
  refreshSettings();
  ctx.startSync([m.id]);
}

// window.confirm() is unavailable in embedded browsers (it returns false at once), so use our own dialog.
// Resolves false, or { checked } for the optional checkbox.
function confirmDialog(message, okLabel, checkLabel) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const { el, close } = modal(
      `<p>${esc(message)}</p>
      ${checkLabel ? `<label class="check"><input type="checkbox" id="cd-check"> ${esc(checkLabel)}</label>` : ''}
      <div class="foot"><button data-v="0">${esc(t('m.cancel'))}</button><button class="primary danger-fill" data-v="1">${esc(okLabel)}</button></div>`,
      { onClose: () => finish(false) },
    );
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => finish(b.dataset.v === '1' && { checked: !!el.querySelector('#cd-check')?.checked })));
    el.querySelector('[data-v="0"]').focus();
  });
}
