// Settings page (#settings/<tab>): General, Machines and Prices, with tabs on the left.
import { $, KINDS, S, api, esc, fmtAgo, fmtTok, kindLabel, modal, setTz, store, applyTheme } from './core.js';
import { LOCALES, setLocale, t } from './i18n.js';

const TABS = ['general', 'machines', 'prices'];
let ctx = null; // callbacks from app.js: { loadState, loadUsage, renderAll, startSync, log }
let current = 'general';

export function initSettings(c) {
  ctx = c;
}

export const settingsHash = (tab = 'general') => `#settings/${tab}`;

export function showSettings(tab) {
  current = TABS.includes(tab) ? tab : 'general';
  const view = $('#settings-view');
  view.innerHTML = `<div class="set-wrap">
    <header class="set-head">
      <button class="icon" id="set-back" aria-label="${esc(t('set.close'))}">←</button>
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
  ({ general: renderGeneral, machines: renderMachines, prices: renderPrices })[current]();
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

// ---------- Machines ----------
function machineForm(m = {}) {
  const off = m.type === 'local' ? 'disabled' : '';
  return `<div class="formgrid">
    <label class="f">${esc(t('m.name'))}<input name="name" value="${esc(m.name || '')}" placeholder="linux-box"></label>
    <label class="f wide">${esc(t('m.host'))}<input name="host" value="${esc(m.host || '')}" placeholder="192.168.1.23" ${off}></label>
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
    <div class="mlist">${S.machines
      .map((m) => {
        const where = m.type === 'local' ? t('m.local') : `ssh ${m.user ? m.user + '@' : ''}${m.host}${m.port ? ':' + m.port : ''}`;
        const meta = [where, m.lastAddress ? t('m.lastAddress', { a: m.lastAddress }) : '', t('m.synced', { ago: fmtAgo(m.lastSyncAt) })].filter(Boolean).join(' · ');
        return `<div class="mcard" data-id="${esc(m.id)}">
          <div class="mrow"><b>${esc(m.name)}</b>
            <span class="btns"><button data-act="sync">${esc(t('m.sync'))}</button><button data-act="edit">${esc(t('m.edit'))}</button>${
              m.type === 'local' ? '' : `<button data-act="del" class="danger">${esc(t('m.remove'))}</button>`
            }</span></div>
          <div class="meta">${esc(meta)}${m.fingerprint ? `<br>${esc(t('m.id', { id: m.fingerprint }))}` : ''}</div>
          ${m.lastError ? `<div class="err-text">${esc(m.lastError)}</div>` : ''}
          <div class="edit" hidden>${machineForm(m)}
            ${m.type === 'local' ? '' : `<label class="check"><input type="checkbox" name="resetFingerprint"> ${esc(t('m.resetFp'))}</label>`}
            <div class="foot"><button data-act="save" class="primary">${esc(t('m.save'))}</button></div></div>
        </div>`;
      })
      .join('')}</div>
    <div class="add-box">
      <button id="m-add-open">+ ${esc(t('m.addTitle'))}</button>
      <div id="add-form" hidden>
        <h3>${esc(t('m.addTitle'))}</h3>
        ${machineForm({})}
        <div class="foot"><button id="m-add-cancel">${esc(t('m.cancel'))}</button><button class="primary" id="m-add">${esc(t('m.add'))}</button></div>
      </div>
    </div>
    <p class="note">${esc(t('m.note'))}</p>
    <div class="err-text" id="m-err"></div>`;

  const showErr = (e) => ($('#m-err').textContent = e.message);
  $('#m-add-open').onclick = () => {
    $('#add-form').hidden = false;
    $('#m-add-open').hidden = true;
    $('#add-form input[name="name"]').focus();
  };
  $('#m-add-cancel').onclick = () => renderMachines();
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
        if (act === 'save') {
          await api('/api/machines/' + id, { method: 'PUT', body: formData($('.edit', card)) });
          await ctx.loadState();
          renderMachines();
        }
        if (act === 'del' && (await confirmDialog(t('m.confirmRemove'), t('m.remove')))) {
          await api('/api/machines/' + id, { method: 'DELETE' });
          await ctx.loadState();
          await ctx.loadUsage();
          renderMachines();
        }
        if (act === 'sync') ctx.startSync([id]);
      } catch (err) {
        showErr(err);
      }
    });
  });
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

// window.confirm() is unavailable in embedded browsers (it returns false at once), so use our own dialog.
function confirmDialog(message, okLabel) {
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
      <div class="foot"><button data-v="0">${esc(t('m.cancel'))}</button><button class="primary danger-fill" data-v="1">${esc(okLabel)}</button></div>`,
      { onClose: () => finish(false) },
    );
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => finish(b.dataset.v === '1')));
    el.querySelector('[data-v="0"]').focus();
  });
}
