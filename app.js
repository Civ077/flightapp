/* ✈ 機票查價 PWA — app.js v1.2
 * 資料只存在手機（localStorage）；查價經家中電腦（預留）→ GAS 中繼。
 * v1.2：繁中／英文介面、所有外部資料輸出一律跳脫（防 XSS）、面板點背景關閉、
 *       收藏全部重查前確認額度、外幣手續費提醒、PNG 圖示。
 */
(function () {
'use strict';
try {
const VERSION = '2.0.1', SCHEMA = 4, KEY = 'fp.v1';
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AP = Object.fromEntries(window.AIRPORTS.map(a => [a.i, a]));
const AL = Object.fromEntries(window.AIRLINES.map(a => [a.c, a]));
const TW_AIRPORTS = window.AIRPORTS.filter(a => a.co === 'TW').map(a => a.i);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

// ───────────── 狀態與遷移 ─────────────
const DEF = {
  v: SCHEMA,
  settings: {
    backend: '', token: '', homepc: '', homeToken: '', lang: 'zh',
    airlines: window.AIRLINES.map(a => a.c), excluded: [], knownAirlines: window.AIRLINES.map(a => a.c),
    airports: TW_AIRPORTS.concat(['NRT','HND','KIX','NGO','FUK','CTS','OKA','ICN','GMP','PUS','HKG','MFM','SIN','BKK','DMK','KUL','MNL','CEB','HAN','SGN','DAD','DPS']),
    defOrigin: 'TPE', currency: 'TWD', nonstop: false, minLayover: 60, staleHours: 6, cacheMin: 30,
    w: { price: 60, time: 30, slot: 10, stops: 10 }, theme: 'auto', font: 'm',
    fees: {}, paxPresets: [], fidsAp: 'TPE'
  },
  form: { trip: 'rt', rtMode: 'together', o: 'TPE', d: '', dep: '', ret: '', adults: 1, children: 0, infants: 0, cabin: 1, nonstop: false, maxHours: '', include: [] },
  emerg: { o: 'TPE', d: '' },
  last: null, favorites: [], cache: {}
};
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];
function deepMerge(a, b) { for (const k in b) { if (BAD_KEYS.includes(k)) continue; if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]); else a[k] = b[k]; } return a; }
let S = load();
let busy = false, cur = null, curTab = 'cheap', ctrl = null, reqSeq = 0, cancelled = false, apTarget = 'o', quotaCache = null;
let FLT = { slots: [], stops: null, bags: 0, seat: false, airlines: null };   // 結果篩選（不存檔）
function load() {
  let j = null;
  try { j = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  const s = j && typeof j === 'object' ? deepMerge(clone(DEF), j) : clone(DEF);
  migrate(s); return s;
}
function migrate(s) {
  if (!s.v) s.v = 1;
  const known = new Set(s.settings.knownAirlines || []);
  window.AIRLINES.forEach(a => { if (!known.has(a.c)) { known.add(a.c); if (!s.settings.excluded.includes(a.c) && !s.settings.airlines.includes(a.c)) s.settings.airlines.push(a.c); } });
  s.settings.knownAirlines = Array.from(known);
  if (s.v < 2) { if (s.settings.w.stops == null) s.settings.w.stops = 10; if (!s.form.rtMode) s.form.rtMode = 'together'; s.cache = s.cache || {}; }
  if (s.v < 3) { if (!s.settings.lang) s.settings.lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'; }
  if (s.v < 4) { s.settings.fees = s.settings.fees || {}; s.settings.paxPresets = s.settings.paxPresets || []; s.settings.fidsAp = s.settings.fidsAp || 'TPE'; }
  if (s.last && !s.last.legs) s.last = null;
  s.v = SCHEMA;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { pruneCache(true); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e2) { toast(t('save.fail')); } } }

// ───────────── i18n ─────────────
function L() { return S.settings.lang === 'en' ? 'en' : 'zh'; }
function t(k, vars) { let s = (window.I18N[L()] || {})[k]; if (s === undefined) s = (window.I18N.zh[k] !== undefined ? window.I18N.zh[k] : k); if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, (m, v) => vars[v] !== undefined ? vars[v] : m); return s; }
function applyLang() {
  document.documentElement.lang = L() === 'en' ? 'en' : 'zh-Hant-TW';
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $('#btnLang').textContent = t('langBtn');
}

// ───────────── 工具 ─────────────
function toast(msg, ms) { const tt = $('#toast'); tt.textContent = msg; tt.hidden = false; tt.onclick = null; clearTimeout(tt._t); tt._t = setTimeout(() => tt.hidden = true, ms || 2600); }
function undoToast(msg, undo) { const tt = $('#toast'); tt.innerHTML = `${esc(msg)}　<b style="text-decoration:underline">${esc(t('fav.undo'))}</b>`; tt.hidden = false; tt.onclick = () => { undo(); tt.hidden = true; tt.onclick = null; }; clearTimeout(tt._t); tt._t = setTimeout(() => { tt.hidden = true; tt.onclick = null; }, 5000); }
function codes(s) { return String(s || '').split(',').filter(Boolean); }
function cityOf(a) { return L() === 'en' ? a.ce : a.c; }
function nameOf(a) { return L() === 'en' ? a.en : a.zh; }
function apLabel(i) { const cs = codes(i); if (!cs.length) return '—'; const a = AP[cs[0]]; const city = a ? cityOf(a) : cs[0]; return cs.length > 1 ? `${city}（${cs.join('/')}）` : `${city}（${cs[0]}）`; }
function apSub(i) { const cs = codes(i); if (cs.length !== 1) return cs.map(c => AP[c] ? nameOf(AP[c]) : c).join(L() === 'en' ? ', ' : '、'); const a = AP[cs[0]]; return a ? (L() === 'en' ? `${a.en} · ${a.zh}` : `${a.zh} · ${a.en}`) : ''; }
function apBoth(i, fallbackName) { const a = AP[i]; return a ? (L() === 'en' ? `${a.en} ${a.zh}` : `${a.zh} ${a.en}`) : (fallbackName || i); }
function apFull(i, fallbackName) { return `${apBoth(i, fallbackName)} (${i})`; }
function apCity(i, fallbackName) { const a = AP[i]; return a ? cityOf(a) : (fallbackName || i); }
function alName(c, fallback) { const a = AL[c]; return a ? nameOf(a) : (fallback || c); }
function alFull(c, fallback) { const a = AL[c]; return a ? (L() === 'en' ? `${a.en} ${a.zh} (${c})` : `${a.zh} ${a.en} (${c})`) : (fallback ? `${fallback} (${c})` : c); }
function countryZh(co) { return L() === 'en' ? co : (window.COUNTRY_ZH[co] || co); }
function money(n, cur) { cur = cur || S.settings.currency; return (cur === 'TWD' ? 'NT$' : cur + ' ') + Math.round(n).toLocaleString(L() === 'en' ? 'en-US' : 'zh-TW'); }
function hm(min) { min = Number(min) || 0; const h = Math.floor(min / 60), m = min % 60; if (!h) return t('m', { m }); return m ? t('hm', { h, m }) : t('h', { h }); }
function tm(s) { return (s || '').slice(11, 16) || '--:--'; }
function dOf(s) { return (s || '').slice(0, 10); }
function dayDiff(a, b) { if (!a || !b) return 0; return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); }
function fmtAt(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function wk(d) { return d ? t('wk')[new Date(d + 'T00:00:00').getDay()] : ''; }
function hol(d) { const n = window.TW_HOLIDAYS && window.TW_HOLIDAYS[d]; return n ? t('hol', { n }) : ''; }
function wkh(d) { return [wk(d), hol(d)].filter(Boolean).join(' '); }
function applyTheme() { const r = document.documentElement; if (S.settings.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.settings.theme); r.setAttribute('data-font', S.settings.font); }
function hasBackend() { return !!(S.settings.backend || S.settings.homepc); }
function paxOnly(q) { const p = [t('pax.a', { n: q.adults })]; if (q.children) p.push(t('pax.c', { n: q.children })); if (q.infants) p.push(t('pax.i', { n: q.infants })); return p.join(L() === 'en' ? ', ' : '、'); }
function paxTextQ(q) { return paxOnly(q) + '・' + t('cabin.' + (q.cabin || 1)); }
function minPrice(r) { return r && r.flights && r.flights.length ? Math.min(...r.flights.map(x => x.price)) : null; }
function kindLabel(k) { return t('kind.' + k); }

// ───────────── 分頁切換 ─────────────
function showView(name) {
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  window.scrollTo(0, 0);
  if (name === 'fav') renderFavs();
  if (name === 'settings') renderSettings();
  if (name === 'emerg') renderEmerg();
  if (name === 'search') renderSearch();
}
$$('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));
$('#btnLang').onclick = () => { S.settings.lang = L() === 'en' ? 'zh' : 'en'; save(); applyLang(); renderSearch(); };

// ───────────── 查價表單 ─────────────
function renderSearch() {
  const f = S.form; delete $('#searchHint').dataset.sticky;
  if (!f.o) f.o = S.settings.defOrigin;
  if (!f.dep || f.dep < today()) f.dep = addDays(today(), 14);
  if (f.trip === 'rt' && (!f.ret || f.ret < f.dep)) f.ret = addDays(f.dep, 5);
  $('#setupCard').hidden = hasBackend();
  $('#quickBackend').value = S.settings.backend; $('#quickToken').value = S.settings.token;
  $$('#tripType button').forEach(b => b.classList.toggle('on', b.dataset.v === f.trip));
  $('#rtMode').hidden = f.trip !== 'rt';
  $$('#rtMode button').forEach(b => b.classList.toggle('on', b.dataset.v === f.rtMode));
  $('#retWrap').style.visibility = f.trip === 'rt' ? 'visible' : 'hidden';
  $('#originVal').textContent = apLabel(f.o); $('#originSub').textContent = apSub(f.o);
  $('#destVal').textContent = f.d ? apLabel(f.d) : t('pick'); $('#destSub').textContent = f.d ? apSub(f.d) : t('pick.hint');
  $('#depDate').value = f.dep; $('#depDate').min = today(); $('#depDate').max = addDays(today(), 330); $('#depWk').textContent = wkh(f.dep);
  $('#retDate').value = f.ret; $('#retDate').min = f.dep; $('#retDate').max = addDays(today(), 345); $('#retWk').textContent = f.trip === 'rt' ? wkh(f.ret) : '';
  $('#paxVal').textContent = paxOnly(f);
  $('#cabin').value = f.cabin;
  $('#nonstop').checked = !!f.nonstop;
  $('#maxHours').value = f.maxHours || '';
  renderIncludeChips(); renderAdvSummary(); validateForm(); renderLastCard(); renderQuotaBadge();
}
function renderAdvSummary() {
  const f = S.form, parts = [];
  if (f.nonstop) parts.push(t('nonstop')); if (f.maxHours) parts.push(`≤${f.maxHours}h`); if (f.include.length) parts.push(f.include.join(','));
  $('#advSum').textContent = parts.length ? '（' + parts.join('・') + '）' : '';
}
function activeAirlines() { return S.settings.airlines.filter(c => !S.settings.excluded.includes(c)); }
function unqueriedAirlines() { return window.AIRLINES.map(a => a.c).filter(c => !S.settings.airlines.includes(c) || S.settings.excluded.includes(c)); }
function renderIncludeChips() {
  const box = $('#includeChips'); box.innerHTML = '';
  S.form.include = S.form.include.filter(c => activeAirlines().includes(c));
  activeAirlines().forEach(c => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (S.form.include.includes(c) ? ' on' : ''); b.textContent = `${nameOf(AL[c])} ${c}`;
    b.onclick = () => { const i = S.form.include.indexOf(c); i >= 0 ? S.form.include.splice(i, 1) : S.form.include.push(c); save(); renderIncludeChips(); renderAdvSummary(); };
    box.appendChild(b);
  });
  if (!activeAirlines().length) box.innerHTML = `<div class="hint err">${esc(t('al.noneOn'))}</div>`;
}
function validateForm() {
  const f = S.form, errs = [];
  if (!hasBackend()) errs.push(t('v.conn'));
  if (!f.d) errs.push(t('v.dest'));
  if (f.o && f.d && f.o === f.d) errs.push(t('v.same'));
  if (!f.dep || f.dep < today()) errs.push(t('v.dep'));
  if (f.trip === 'rt' && f.ret < f.dep) errs.push(t('v.ret'));
  if (f.dep > addDays(today(), 330)) errs.push(t('v.range'));
  if (f.infants > f.adults) errs.push(t('v.inf'));
  if (!activeAirlines().length) errs.push(t('v.al'));
  const h = $('#searchHint');
  if (errs.length) { h.textContent = errs.join('\n'); h.className = 'hint err'; delete h.dataset.sticky; }
  else if (!h.dataset.sticky) { h.textContent = ''; h.className = 'hint'; }
  $('#btnSearch').disabled = errs.length > 0 || busy;
  $('#btnSearch').textContent = f.trip === 'rt' ? (f.rtMode === 'split' ? t('btn.search.split') : t('btn.search.rt')) : t('btn.search.ow');
  return !errs.length;
}
$$('#tripType button').forEach(b => b.onclick = () => { S.form.trip = b.dataset.v; save(); renderSearch(); });
$$('#rtMode button').forEach(b => b.onclick = () => { S.form.rtMode = b.dataset.v; save(); renderSearch(); });
$('#btnSwap').onclick = () => { const f = S.form; if (!f.d) return toast(t('err.swap')); [f.o, f.d] = [f.d, f.o]; save(); renderSearch(); };
$('#depDate').onchange = e => { const v = e.target.value; if (!v) return renderSearch(); S.form.dep = v; if (S.form.ret < S.form.dep) S.form.ret = addDays(S.form.dep, 5); save(); renderSearch(); };
$('#retDate').onchange = e => { const v = e.target.value; if (!v) return renderSearch(); S.form.ret = v; save(); renderSearch(); };
$('#cabin').onchange = e => { S.form.cabin = Number(e.target.value); save(); };
$('#nonstop').onchange = e => { S.form.nonstop = e.target.checked; save(); renderAdvSummary(); };
$('#maxHours').onchange = e => { S.form.maxHours = e.target.value ? Math.min(72, Math.max(1, Number(e.target.value) || 1)) : ''; save(); renderSearch(); };
$('#btnOrigin').onclick = () => openAirport('o');
$('#btnDest').onclick = () => openAirport('d');
$('#btnPax').onclick = () => openPax();
$('#btnSearch').onclick = () => { if (validateForm()) startSearch(buildBaseQuery(), S.form.trip === 'rt' ? S.form.rtMode : 'oneway', 'normal', false); };
$('#quickTest').onclick = async () => {
  S.settings.backend = $('#quickBackend').value.trim(); S.settings.token = $('#quickToken').value.trim(); save();
  const h = $('#quickHint');
  if (!S.settings.backend) { h.textContent = t('q.needUrl'); h.className = 'hint err'; return; }
  h.textContent = t('testing'); h.className = 'hint';
  try { const j = await api('ping', {}, { quick: true }); const sp = (j.providers || {}).serpapi; h.textContent = t('q.ok') + (sp && sp.configured ? (sp.valid === false ? '\n' + t('conn.keyBad', { m: sp.accountError || '' }) : sp.left != null ? '\n' + t('conn.keyOk', { n: sp.left }) : '') : '\n' + t('conn.noKey')); h.className = sp && sp.valid === false ? 'hint err' : 'hint ok'; renderQuotaBadge(j.providers); setTimeout(renderSearch, 800); }
  catch (e) { h.textContent = t('q.fail', { m: e.message }); h.className = 'hint err'; }
};
function buildBaseQuery() {
  const f = S.form;
  return {
    o: f.o, d: f.d, dep: f.dep, ret: f.trip === 'rt' ? f.ret : null,
    adults: f.adults, children: f.children, infants: f.infants, cabin: f.cabin,
    nonstop: !!f.nonstop, include: f.include.slice(),
    exclude: Array.from(new Set(S.settings.excluded.concat(f.include.length ? [] : unqueriedAirlines()))),
    currency: S.settings.currency, maxDuration: f.maxHours ? Number(f.maxHours) * 60 : null
  };
}
function renderLastCard() {
  const c = $('#lastResultCard'); const rec = S.last;
  if (!rec || !rec.legs || !rec.legs[0] || !rec.legs[0].result) { c.hidden = true; return; }
  const q = rec.query, min = minPrice(rec.legs[0].result);
  $('#lastResultText').textContent = `${apLabel(q.o)} → ${apLabel(q.d)}　${q.dep}${q.ret ? ' ～ ' + q.ret : ''}　${kindLabel(rec.kind)}\n${min != null ? money(min, rec.legs[0].result.currency) : '—'}　${fmtAt(rec.at)}`;
  c.hidden = false;
}
$('#btnShowLast').onclick = () => { if (S.last) renderResults(S.last); };
$('#btnRedoLast').onclick = () => { if (S.last) startSearch(S.last.query, S.last.kind, 'normal', true); };

// ───────────── 面板（點背景關閉） ─────────────
$$('.sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) sh.hidden = true; }));

// ───────────── 機場選擇 ─────────────
function openAirport(tg) { apTarget = tg; $('#apTitle').textContent = t('ap.t.' + tg); $('#apSearch').value = ''; renderApList(''); $('#sheetAirport').hidden = false; setTimeout(() => $('#apSearch').focus(), 120); }
$('#apClose').onclick = () => $('#sheetAirport').hidden = true;
$('#apSearch').oninput = e => renderApList(e.target.value.trim());
function matchAp(a, q) { q = q.toLowerCase(); return a.i.toLowerCase().includes(q) || a.zh.includes(q) || a.en.toLowerCase().includes(q) || a.c.includes(q) || a.ce.toLowerCase().includes(q) || (window.COUNTRY_ZH[a.co] || '').includes(q); }
function apRowHtml(a) { return L() === 'en' ? `<b>${esc(a.en)}</b><small>${esc(a.zh)} · ${esc(a.ce)} ${esc(a.c)} · ${esc(a.co)}</small>` : `<b>${esc(a.zh)}</b><small>${esc(a.en)} · ${esc(a.c)} ${esc(a.ce)} · ${esc(window.COUNTRY_ZH[a.co] || a.co)}</small>`; }
function renderApList(q) {
  const box = $('#apList'); box.innerHTML = '';
  const fav = S.settings.airports;
  const list = window.AIRPORTS.filter(a => !q || matchAp(a, q));
  if (!list.length) { box.innerHTML = `<div class="empty">${esc(t('ap.none'))}</div>`; return; }
  [[t('ap.fav'), list.filter(a => fav.includes(a.i))], [t('ap.other'), list.filter(a => !fav.includes(a.i))]].forEach(([title, arr]) => {
    if (!arr.length) return;
    const h = document.createElement('div'); h.className = 'aphead'; h.textContent = title; box.appendChild(h);
    arr.forEach(a => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ap';
      b.innerHTML = `<span class="code">${a.i}</span><span class="nm">${apRowHtml(a)}</span>${fav.includes(a.i) ? '<span class="star">★</span>' : ''}`;
      b.onclick = () => pickAirport(a.i); box.appendChild(b);
    });
  });
}
function pickAirport(i) {
  if (apTarget === 'o') { if (i === S.form.d) return toast(t('err.sameAp')); S.form.o = i; }
  if (apTarget === 'd') { if (i === S.form.o) return toast(t('err.sameAp')); S.form.d = i; }
  if (apTarget === 'eo') { if (i === S.emerg.d) return toast(t('err.sameAp')); S.emerg.o = i; }
  if (apTarget === 'ed') { if (i === S.emerg.o) return toast(t('err.sameAp')); S.emerg.d = i; }
  save(); $('#sheetAirport').hidden = true; renderSearch(); renderEmerg();
}

// ───────────── 人數 ─────────────
function openPax() { renderPax(); $('#sheetPax').hidden = false; }
function renderPaxPresets() {
  const box = $('#paxPresets'); box.innerHTML = '';
  S.settings.paxPresets.forEach((p, idx) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = `${p.name}（${p.adults}/${p.children}/${p.infants}）`;
    b.onclick = () => { Object.assign(S.form, { adults: p.adults, children: p.children, infants: p.infants }); save(); renderPax(); };
    b.oncontextmenu = e => { e.preventDefault(); if (confirm(t('pax.del', { n: p.name }))) { S.settings.paxPresets.splice(idx, 1); save(); renderPaxPresets(); } };
    box.appendChild(b);
  });
}
$('#paxSave').onclick = () => { const name = (prompt(t('pax.name')) || '').trim(); if (!name) return; const f = S.form; S.settings.paxPresets = S.settings.paxPresets.filter(p => p.name !== name).concat([{ name, adults: f.adults, children: f.children, infants: f.infants }]).slice(-8); save(); renderPaxPresets(); toast(t('pax.saved')); };
function renderPax() {
  renderPaxPresets();
  const f = S.form; $('#nAdults').textContent = f.adults; $('#nChildren').textContent = f.children; $('#nInfants').textContent = f.infants;
  $$('#sheetPax .stepper button').forEach(b => {
    const p = b.dataset.p, d = Number(b.dataset.d), v = f[p] + d, total = f.adults + f.children + f.infants;
    b.disabled = (p === 'adults' && v < 1) || (p !== 'adults' && v < 0) || (p === 'infants' && v > f.adults) || (d > 0 && total >= 9);
  });
}
$$('#sheetPax .stepper button').forEach(b => b.onclick = () => { S.form[b.dataset.p] += Number(b.dataset.d); if (S.form.infants > S.form.adults) S.form.infants = S.form.adults; save(); renderPax(); });
$('#paxDone').onclick = () => { $('#sheetPax').hidden = true; renderSearch(); };

// ───────────── 本機快取 ─────────────
function cacheKey(action, q, extra) { return action + '|' + JSON.stringify([q.o, q.d, q.dep, q.ret, q.adults, q.children, q.infants, q.cabin, !!q.nonstop, (q.include || []).slice().sort(), (q.exclude || []).slice().sort(), q.currency, q.maxDuration, extra || '']); }
function getCache(key) { const c = S.cache[key]; if (!c) return null; if (Date.now() - new Date(c.at) > S.settings.cacheMin * 6e4) return null; return c; }
function putCache(key, result) { S.cache[key] = { at: new Date().toISOString(), result }; pruneCache(false); }
function pruneCache(hard) {
  const keys = Object.keys(S.cache).sort((a, b) => new Date(S.cache[a].at) - new Date(S.cache[b].at));
  const max = hard ? 5 : 25, ttl = 12 * 36e5;
  keys.forEach((k, i) => { if (i < keys.length - max || Date.now() - new Date(S.cache[k].at) > ttl) delete S.cache[k]; });
}

// ───────────── API（家中電腦優先 → GAS；可取消） ─────────────
async function api(action, params, opts) {
  opts = opts || {};
  const chain = [];
  if (S.settings.homepc) chain.push({ name: 'homepc', base: S.settings.homepc.replace(/\/$/, '') + '/' + action, token: S.settings.homeToken, style: 'path' });
  if (S.settings.backend) chain.push({ name: 'gas', base: S.settings.backend, token: S.settings.token, style: 'gas' });
  if (!chain.length) throw new Error(t('e.noBackend'));
  let lastErr;
  for (const c of chain) {
    const who = t(c.name === 'gas' ? 'w.gas' : 'w.homepc');
    let u; try { u = new URL(c.base); } catch (e) { lastErr = new Error(t('e.badUrl', { w: who })); continue; }
    if (c.style === 'gas') u.searchParams.set('action', action);
    u.searchParams.set('token', c.token || '');
    Object.entries(params || {}).forEach(([k, v]) => { if (v === undefined || v === null || v === false) return; u.searchParams.set(k, typeof v === 'string' ? v : (v === true ? '1' : JSON.stringify(v))); });
    const my = new AbortController(); ctrl = my;
    const timer = setTimeout(() => my.abort(), c.name === 'homepc' ? (opts.quick ? 4000 : 45000) : 60000);
    try {
      const r = await fetch(u.toString(), { signal: my.signal, redirect: 'follow', cache: 'no-store' });
      clearTimeout(timer);
      let j; try { j = await r.json(); } catch (e) { throw new Error(t('e.notJson', { w: who })); }
      if (j && j.ok) { j.via = c.name; return j; }
      lastErr = new Error((j && j.message) || `${c.name}: ${t('e.fail')}`);
      if (j && (j.error === 'AUTH' || j.error === 'CONFIG')) throw lastErr;
    } catch (e) {
      clearTimeout(timer);
      if (cancelled) throw new Error(t('e.cancelled'));
      if (e.name === 'AbortError') lastErr = new Error(t(c.name === 'homepc' ? 'e.homepcTimeout' : 'e.timeout'));
      else if (e.message && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) lastErr = new Error(t('e.net'));
      else lastErr = e;
      if (/密碼錯誤|APP_TOKEN|AUTH/.test(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr || new Error(t('e.fail'));
}
$('#btnCancel').onclick = () => { cancelled = true; if (ctrl) ctrl.abort(); };
async function fetchSearch(q, force) {
  const key = cacheKey('search', q);
  const hit = force ? null : getCache(key);
  if (hit) { const r = clone(hit.result); r.cachedLocal = true; r.cachedAt = hit.at; return r; }
  const r = await api('search', { q, force: !!force });
  if (r.quota) renderQuotaBadge(r.quota);
  putCache(key, r); return r;
}
async function fetchReturns(q, dt, force) {
  const key = cacheKey('returns', q, dt);
  const hit = force ? null : getCache(key);
  if (hit) { const r = clone(hit.result); r.cachedLocal = true; r.cachedAt = hit.at; return r; }
  const r = await api('returns', { q, dt, force: !!force });
  if (r.quota) renderQuotaBadge(r.quota);
  putCache(key, r); return r;
}

// ───────────── 執行查價 ─────────────
function setBusy(on, text) { busy = on; cancelled = false; $('#loadingText').textContent = text || t('ld.search'); $('#loading').hidden = !on; $('#btnEmerg').disabled = on; $('#btnRefresh').disabled = on; try { validateForm(); } catch (e) {} }
function suggestRelax(q) { const a = []; if (q.nonstop) a.push(t('relax.nonstop')); if (q.include && q.include.length) a.push(t('relax.include')); if (q.maxDuration) a.push(t('relax.dur')); return a.length ? '\n' + t('relax') + a.join(L() === 'en' ? ', ' : '、') : ''; }
function showErr(mode, msg) { const h = mode === 'emerg' ? $('#emergHint') : $('#searchHint'); h.textContent = msg; h.className = 'hint err'; h.dataset.sticky = '1'; toast(msg.split('\n')[0], 4000); }
function isCancel(e) { return e && e.message === t('e.cancelled'); }

async function startSearch(q, kind, mode, force) {
  if (busy) return;
  if (navigator.onLine === false) toast(t('offline'));
  if (kind !== 'oneway' && !q.ret) kind = 'oneway';
  const seq = ++reqSeq;
  setBusy(true, kind === 'split' ? t('ld.out') : (mode === 'emerg' ? t('ld.emerg') : t('ld.search')));
  try {
    const rec = { mode, kind, query: q, at: new Date().toISOString(), legs: [], legIdx: 0, compare: null };
    if (kind === 'split') {
      const qOut = Object.assign({}, q, { ret: null }), qBack = Object.assign({}, q, { o: q.d, d: q.o, dep: q.ret, ret: null });
      const r1 = await fetchSearch(qOut, force); if (seq !== reqSeq) return;
      $('#loadingText').textContent = t('ld.back');
      const r2 = await fetchSearch(qBack, force); if (seq !== reqSeq) return;
      rec.legs = [{ name: 'out', q: qOut, result: r1 }, { name: 'back', q: qBack, result: r2 }];
    } else {
      const r = await fetchSearch(q, force); if (seq !== reqSeq) return;
      rec.legs = [{ name: kind === 'together' ? 'out' : null, q, result: r }];
    }
    if (mode !== 'emerg') S.last = rec;
    updateFavPrice(rec); save();
    renderResults(rec);
  } catch (e) {
    if (seq !== reqSeq || isCancel(e)) { toast(t('e.cancelled')); return; }
    showErr(mode, t('e.search', { m: e.message }) + suggestRelax(q));
  } finally { if (seq === reqSeq) setBusy(false); }
}
async function chooseOutbound(f) {
  if (busy || !cur || cur.kind !== 'together') return;
  if (!f.departureToken) return toast(t('e.noRet'), 4000);
  const seq = ++reqSeq; setBusy(true, t('ld.ret'));
  try {
    const r = await fetchReturns(cur.query, f.departureToken, false); if (seq !== reqSeq) return;
    cur.legs = [cur.legs[0], { name: 'back', q: cur.query, result: r, chosenId: f.id, chosen: f }];
    cur.legIdx = 1; if (S.last && S.last.at === cur.at) S.last = cur; save();
    renderResults(cur);
  } catch (e) {
    if (seq !== reqSeq || isCancel(e)) { toast(t('e.cancelled')); return; }
    toast(t('e.ret', { m: e.message }), 4000);
  } finally { if (seq === reqSeq) setBusy(false); }
}
async function compareTogether() {
  if (busy || !cur || cur.kind !== 'split') return;
  const seq = ++reqSeq; setBusy(true, t('ld.cmp'));
  try { const r = await fetchSearch(cur.query, false); if (seq !== reqSeq) return; cur.compare = { at: new Date().toISOString(), min: minPrice(r), currency: r.currency }; if (S.last && S.last.at === cur.at) S.last = cur; save(); renderResults(cur); }
  catch (e) { if (seq === reqSeq && !isCancel(e)) toast(t('e.cmp', { m: e.message }), 4000); }
  finally { if (seq === reqSeq) setBusy(false); }
}

// ───────────── 結果 ─────────────
function annotate(f, q) {
  const segs = f.segments, first = segs[0], last = segs[segs.length - 1], warns = [];
  f.layovers.forEach(l => {
    if (l.duration && l.duration < S.settings.minLayover) warns.push({ t: t('wn.short', { m: l.duration }), red: true });
    if (l.overnight) warns.push({ t: t('wn.overnight') });
    if (l.duration >= 360) warns.push({ t: t('wn.long', { d: hm(l.duration) }) });
  });
  for (let i = 1; i < segs.length; i++) if (segs[i - 1].arr.iata && segs[i].dep.iata && segs[i - 1].arr.iata !== segs[i].dep.iata) warns.push({ t: t('wn.changeAp', { a: segs[i - 1].arr.iata, b: segs[i].dep.iata }), red: true });
  const cs = [...new Set(segs.map(s => s.airline).filter(Boolean))];
  if (cs.length > 1) warns.push({ t: t('wn.multi') });
  const depH = Number(tm(first.dep.time).slice(0, 2));
  const redEye = depH < 6 || depH >= 23; if (redEye) warns.push({ t: t('wn.redeye') });
  const destCo = new Set(codes(q.d).map(c => (AP[c] || {}).co).filter(Boolean));
  if (segs.slice(0, -1).some(s => ['US', 'CA'].includes((AP[s.arr.iata] || {}).co)) && !destCo.has('US') && !destCo.has('CA')) warns.push({ t: t('wn.transit') });
  const depTs = new Date((first.dep.time || '').replace(' ', 'T')).getTime() || 0;
  if (depTs) { const hrs = (depTs - Date.now()) / 36e5; if (hrs < 0 && hrs > -24) warns.push({ t: t('wn.departed'), red: true }); else if (hrs >= 0 && hrs < 3) warns.push({ t: t('wn.soon', { h: 3 }), red: true }); }
  f._warns = warns; f._plus = dayDiff(dOf(first.dep.time), dOf(last.arr.time)); f._codes = cs; f._depTs = depTs;
  f._arrTs = new Date((last.arr.time || '').replace(' ', 'T')).getTime() || 0;
  f._slotBad = redEye ? 1 : 0;
}
function levelOf(price, ins, minP) {
  if (ins && ins.range) { if (price <= ins.range[0]) return 'low'; if (price <= ins.range[1]) return 'mid'; return 'high'; }
  if (price <= minP * 1.1) return 'low'; if (price <= minP * 1.4) return 'mid'; return 'high';
}
function curLeg() { return cur.legs[cur.legIdx] || cur.legs[0]; }
function feeOf(code, kind) { const f = S.settings.fees[code]; const v = f && Number(f[kind]); return Number.isFinite(v) && v > 0 ? v : null; }
function totalOf(f, q) {
  if (!FLT.bags && !FLT.seat) return { total: f.price, unknown: [] };
  const pax = (q.adults || 1) + (q.children || 0); let extra = 0; const unknown = new Set();
  f.segments.forEach(s => {
    if (FLT.bags) { const b = feeOf(s.airline, 'bag'); if (b == null) { if (s.airline && (AL[s.airline] || {}).t === 'LCC') unknown.add(s.airline); } else extra += b * FLT.bags * pax; }
    if (FLT.seat) { const v = feeOf(s.airline, 'seat'); if (v == null) { if (s.airline && (AL[s.airline] || {}).t === 'LCC') unknown.add(s.airline); } else extra += v * pax; }
  });
  return { total: f.price + extra, unknown: Array.from(unknown) };
}
function passesFilter(f) {
  if (FLT.stops != null && f.layovers.length > FLT.stops) return false;
  if (FLT.airlines && !f._codes.every(c => FLT.airlines.includes(c))) return false;
  if (FLT.slots.length) { const h = Number(tm(f.segments[0].dep.time).slice(0, 2)); const slot = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; if (!FLT.slots.includes(slot)) return false; }
  return true;
}
function renderFilterBar(r) {
  const bar = $('#filterBar'); bar.innerHTML = '';
  const chip = (label, on, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (on ? ' on' : ''); b.textContent = label; b.onclick = () => { fn(); renderList(); renderFilterBar(r); }; bar.appendChild(b); };
  [['morning', 'flt.morning'], ['afternoon', 'flt.afternoon'], ['evening', 'flt.evening'], ['night', 'flt.night']].forEach(([k, key]) => chip(t(key), FLT.slots.includes(k), () => { const i = FLT.slots.indexOf(k); i >= 0 ? FLT.slots.splice(i, 1) : FLT.slots.push(k); }));
  chip(t('flt.nonstop'), FLT.stops === 0, () => { FLT.stops = FLT.stops === 0 ? null : 0; });
  chip(t('flt.onestop'), FLT.stops === 1, () => { FLT.stops = FLT.stops === 1 ? null : 1; });
  const sep = document.createElement('span'); sep.className = 'sep'; bar.appendChild(sep);
  chip(t('flt.bags1'), FLT.bags === 1, () => { FLT.bags = FLT.bags === 1 ? 0 : 1; });
  chip(t('flt.bags2'), FLT.bags === 2, () => { FLT.bags = FLT.bags === 2 ? 0 : 2; });
  chip(t('flt.seat'), FLT.seat, () => { FLT.seat = !FLT.seat; });
  const codesIn = [...new Set(r.flights.flatMap(f => f._codes))];
  if (codesIn.length > 1) { const sep2 = document.createElement('span'); sep2.className = 'sep'; bar.appendChild(sep2); codesIn.forEach(c => chip(alName(c, (r.flights.flatMap(f => f.segments).find(s => s.airline === c) || {}).airlineName), !FLT.airlines || FLT.airlines.includes(c), () => { if (!FLT.airlines) FLT.airlines = codesIn.filter(x => x !== c); else { const i = FLT.airlines.indexOf(c); i >= 0 ? FLT.airlines.splice(i, 1) : FLT.airlines.push(c); if (FLT.airlines.length === codesIn.length) FLT.airlines = null; } })); }
  const active = FLT.slots.length || FLT.stops != null || FLT.bags || FLT.seat || FLT.airlines;
  if (active) chip(t('flt.reset'), false, () => { FLT = { slots: [], stops: null, bags: 0, seat: false, airlines: null }; });
}
function renderPriceStrip(list, all) {
  const box = $('#priceStrip'); if (all.length < 3) { box.hidden = true; return; }
  const ps = all.map(f => f._total != null ? f._total : f.price), mn = Math.min(...ps), mx = Math.max(...ps);
  const byTime = all.slice().sort((x, y) => x._depTs - y._depTs);
  box.innerHTML = byTime.map(f => { const p = f._total != null ? f._total : f.price; const h = mx > mn ? 15 + 85 * (p - mn) / (mx - mn) : 50; return `<i style="height:${h}%" class="${p === mn ? 'low' : ''}${list.includes(f) ? '' : ' dim'}" title="${esc(tm(f.segments[0].dep.time))} ${esc(money(p))}"></i>`; }).join('');
  box.hidden = false;
}
function renderResults(rec) {
  cur = rec; const leg = curLeg(), r = leg.result, q = rec.query;
  r.flights = (r.flights || []).filter(f => f && Array.isArray(f.segments) && f.segments.length && f.price > 0);
  r.flights.forEach(f => annotate(f, leg.q));
  $('#resTitle').textContent = `${apLabel(q.o)} → ${apLabel(q.d)}`;
  const stale = (Date.now() - new Date(rec.at)) / 36e5 > S.settings.staleHours;
  const srcKey = 'src.' + r.source, src = t(srcKey) !== srcKey ? t(srcKey) : (r.source || r.via || '');
  $('#resMeta').innerHTML = `${esc(q.dep)}（${esc(wk(q.dep))}）${q.ret ? ' ～ ' + esc(q.ret) + '（' + esc(wk(q.ret)) + '）' : '　' + esc(t('meta.ow'))}　${esc(paxTextQ(q))}　${esc(kindLabel(rec.kind))}<br>${esc(t('meta.at', { t: fmtAt(r.cachedAt || rec.at), s: src }))}${r.cachedLocal || r.cached ? `　<span class="cached">${esc(t('meta.cached'))}</span>` : ''}${stale ? '　' + esc(t('meta.stale', { h: S.settings.staleHours })) : ''}`;
  $('#resMeta').className = 'resmeta' + (stale ? ' stale' : '');
  if (rec._fltKey !== rec.at + cur.legIdx) { FLT = { slots: [], stops: null, bags: FLT.bags, seat: FLT.seat, airlines: null }; rec._fltKey = rec.at + cur.legIdx; }
  renderLegBar(rec); renderCombo(rec); renderDayStrip(rec); renderFilterBar(r);
  const grpO = nearbyCodes(codes(q.o)), grpD = nearbyCodes(codes(q.d));
  $('#btnNearby').hidden = rec.mode === 'emerg' || (grpO === q.o && grpD === q.d);
  $('#btnDays').hidden = rec.mode === 'emerg';
  const ins = r.priceInsights, insBox = $('#insights');
  if (ins && (ins.range || ins.lowest)) {
    const lvKey = 'ins.' + ins.level, lv = ins.level && t(lvKey) !== lvKey ? t(lvKey) : '';
    insBox.innerHTML = esc(t('ins')) + (ins.range ? esc(t('ins.range', { a: money(ins.range[0], r.currency), b: money(ins.range[1], r.currency) })) : '') + (ins.lowest ? esc(t('ins.lowest', { p: money(ins.lowest, r.currency) })) : '') + (lv ? `　<b>${esc(lv)}</b>` : '');
    insBox.hidden = false;
  } else insBox.hidden = true;
  if (rec.mode === 'emerg') curTab = 'early';
  $$('#resTabs button').forEach(b => b.classList.toggle('on', b.dataset.v === curTab));
  $('#btnFav').textContent = isFav(q, rec.kind) ? '★' : '☆';
  $('#btnFav').hidden = rec.mode === 'emerg';
  $('#lnkGrid').href = gflightsUrl(q);
  renderList();
  $$('.view').forEach(v => v.hidden = v.id !== 'view-results');
  window.scrollTo(0, 0);
}
function renderLegBar(rec) {
  const bar = $('#legBar');
  if (rec.kind === 'oneway') { bar.hidden = true; return; }
  bar.hidden = false; bar.innerHTML = '';
  if (rec.kind === 'together') {
    const chosen = rec.legs[1] && rec.legs[1].chosen;
    bar.innerHTML = `<div class="step ${rec.legIdx === 0 ? 'on' : 'done'}"><b>${esc(t('leg.1'))}</b><small>${chosen ? esc(t('leg.1.chosen', { f: chosen.segments.map(s => s.flightNo).join('/'), t: tm(chosen.segments[0].dep.time) })) : esc(t('leg.1.sub'))}</small></div><span class="arrow">›</span><div class="step ${rec.legIdx === 1 ? 'on' : ''}"><b>${esc(t('leg.2'))}</b><small>${rec.legs[1] ? esc(t('leg.2.n', { n: rec.legs[1].result.flights.length })) : esc(t('leg.2.wait'))}</small></div>`;
    $$('.step.done', bar).forEach(el => el.onclick = () => { rec.legIdx = 0; renderResults(rec); });
  } else {
    bar.innerHTML = `<div class="legtabs" style="flex:1;margin:0"><button data-i="0" class="${rec.legIdx === 0 ? 'on' : ''}">${esc(t('leg.out'))} ${esc(apLabel(rec.query.o))} → ${esc(apLabel(rec.query.d))}</button><button data-i="1" class="${rec.legIdx === 1 ? 'on' : ''}">${esc(t('leg.back'))} ${esc(apLabel(rec.query.d))} → ${esc(apLabel(rec.query.o))}</button></div>`;
    $$('button', bar).forEach(b => b.onclick = () => { rec.legIdx = Number(b.dataset.i); renderResults(rec); });
  }
}
function renderCombo(rec) {
  const box = $('#comboBox');
  if (rec.kind !== 'split' || rec.legs.length < 2) { box.hidden = true; return; }
  const a = minPrice(rec.legs[0].result), b = minPrice(rec.legs[1].result), cu = rec.legs[0].result.currency;
  let html = t('combo', { t: money(a + b, cu), a: money(a, cu), b: money(b, cu) });
  if (rec.compare) { const d = rec.compare.min - (a + b); html += t('combo.cmp', { p: money(rec.compare.min, rec.compare.currency), d: d > 0 ? t('combo.splitCheaper', { d: money(d, cu) }) : d < 0 ? t('combo.rtCheaper', { d: money(-d, cu) }) : t('combo.same') }); }
  else html += `\n<button class="link" id="btnCompare">${esc(t('combo.btn'))}</button>`;
  box.innerHTML = html; box.hidden = false;
  const bc = $('#btnCompare'); if (bc) bc.onclick = compareTogether;
}
function nearbyCodes(cs) { const out = new Set(); cs.forEach(c => { const g = (AP[c] || {}).g; if (g) window.AIRPORTS.filter(x => x.g === g).forEach(x => out.add(x.i)); else out.add(c); }); return Array.from(out).join(','); }
$('#btnNearby').onclick = () => {
  if (!cur || busy) return;
  const q = cur.query, o = nearbyCodes(codes(q.o)), d = nearbyCodes(codes(q.d));
  if (o === q.o && d === q.d) return toast(t('nearby.none'));
  if (!confirm(t('nearby.confirm'))) return;
  startSearch(Object.assign({}, q, { o, d }), cur.kind, cur.mode, false);
};
function queriesPerDay(kind) { return kind === 'split' ? 2 : 1; }
$('#btnDays').onclick = async () => {
  if (!cur || busy) return;
  const rec = cur, q = rec.query;
  const offsets = [-3, -2, -1, 1, 2, 3].filter(k => addDays(q.dep, k) >= today());
  const pending = offsets.filter(k => !(rec.days && rec.days[k]));
  if (!pending.length) { renderDayStrip(rec); return; }
  if (!confirm(t('days.confirm', { q: pending.length * queriesPerDay(rec.kind) }))) return;
  const seq = ++reqSeq; let n = 0; setBusy(true, t('days.loading', { a: 0, b: pending.length }));
  rec.days = rec.days || {}; rec.days[0] = { dep: q.dep, min: favPriceOf(rec) };
  try {
    for (const k of pending) {
      if (seq !== reqSeq) return;
      const q2 = Object.assign({}, q, { dep: addDays(q.dep, k), ret: q.ret ? addDays(q.ret, k) : null });
      try {
        let min;
        if (rec.kind === 'split') { const a = await fetchSearch(Object.assign({}, q2, { ret: null }), false); const b = await fetchSearch(Object.assign({}, q2, { o: q2.d, d: q2.o, dep: q2.ret, ret: null }), false); min = minPrice(a) + minPrice(b); }
        else { const r = await fetchSearch(q2, false); min = minPrice(r); }
        rec.days[k] = { dep: q2.dep, min };
      } catch (e) { if (isCancel(e)) throw e; rec.days[k] = { dep: q2.dep, min: null, err: true }; }
      n++; $('#loadingText').textContent = t('days.loading', { a: n, b: pending.length }); save(); renderDayStrip(rec);
    }
  } catch (e) { toast(t('e.cancelled')); } finally { if (seq === reqSeq) setBusy(false); }
};
function renderDayStrip(rec) {
  const box = $('#dayStrip'); if (!rec.days) { box.hidden = true; return; }
  const q = rec.query, cur_ = rec.legs[0].result.currency;
  const ks = [-3, -2, -1, 0, 1, 2, 3];
  const vals = ks.map(k => rec.days[k] && rec.days[k].min).filter(v => v != null), best = vals.length ? Math.min(...vals) : null;
  const compact = v => Math.round(v).toLocaleString(L() === 'en' ? 'en-US' : 'zh-TW');
  box.innerHTML = '<div class="dcs">' + ks.map(k => {
    const d = addDays(q.dep, k), info = rec.days[k], past = d < today();
    const cls = ['dc', k === 0 ? 'cur' : '', info && info.min != null && info.min === best ? 'best' : '', hol(d) ? 'hol' : '', (past || !info || info.min == null) ? 'na' : ''].join(' ');
    return `<div class="${cls}" data-k="${k}"><span>${esc(wk(d).replace('週', ''))}</span><b>${esc(d.slice(5))}</b><span class="p">${past ? esc(t('days.past')) : info && info.min != null ? esc(compact(info.min)) : esc(t('days.na'))}</span></div>`;
  }).join('') + `</div><div class="hint" style="margin-top:4px">${esc(t('days.hint'))}　${esc(cur_)}</div>`;
  box.hidden = false;
  $$('.dc', box).forEach(el => el.onclick = () => { const k = Number(el.dataset.k); const info = rec.days[k]; if (k === 0 || !info || info.min == null || busy) return; const q2 = Object.assign({}, q, { dep: addDays(q.dep, k), ret: q.ret ? addDays(q.ret, k) : null }); startSearch(q2, rec.kind, rec.mode, false).then(() => { if (cur && cur !== rec) { cur.days = {}; ks.forEach(j => { const src = rec.days[j + k]; if (src) cur.days[j] = src; }); cur.days[0] = { dep: q2.dep, min: favPriceOf(cur) }; save(); renderDayStrip(cur); } }); });
}
function icsOf(f, chosenOut) {
  const segs = (chosenOut ? chosenOut.segments : []).concat(f.segments);
  const fmt = s => (s || '').replace(/[-: ]/g, '').slice(0, 13) + '00';
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const ev = segs.map((s, i) => ['BEGIN:VEVENT', `UID:fp-${Date.now()}-${i}@flightapp`, `DTSTAMP:${now}`, `DTSTART:${fmt(s.dep.time)}`, `DTEND:${fmt(s.arr.time)}`, `SUMMARY:${s.flightNo} ${s.dep.iata}→${s.arr.iata}`, `LOCATION:${apFull(s.dep.iata, s.dep.name).replace(/,/g, ' ')}`, `DESCRIPTION:${alFull(s.airline, s.airlineName)} / ${s.dep.iata} ${tm(s.dep.time)} → ${s.arr.iata} ${tm(s.arr.time)} (local times)`, 'BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', `DESCRIPTION:Check-in ${s.flightNo}`, 'END:VALARM', 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//flightapp//TW', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
}
function gflightsUrl(q) {
  const s = `Flights from ${codes(q.o)[0]} to ${codes(q.d)[0]} on ${q.dep}${q.ret ? ' through ' + q.ret : ' one way'}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(s)}&hl=${L() === 'en' ? 'en' : 'zh-TW'}&curr=${q.currency || 'TWD'}`;
}
$$('#resTabs button').forEach(b => b.onclick = () => { curTab = b.dataset.v; $$('#resTabs button').forEach(x => x.classList.toggle('on', x === b)); renderList(); });
$('#btnBack').onclick = () => { if (cur && cur.kind === 'together' && cur.legIdx === 1) { cur.legIdx = 0; renderResults(cur); return; } showView(cur && cur.mode === 'emerg' ? 'emerg' : 'search'); };
$('#btnRefresh').onclick = () => { if (cur) startSearch(cur.query, cur.kind, cur.mode, true); };
$('#btnFav').onclick = () => { toggleFav(cur); $('#btnFav').textContent = isFav(cur.query, cur.kind) ? '★' : '☆'; };
function sorted(list) {
  const arr = list.slice();
  const P = x => x._total != null ? x._total : x.price;
  if (curTab === 'cheap') arr.sort((a, b) => P(a) - P(b) || a.totalDuration - b.totalDuration);
  else if (curTab === 'early') arr.sort((a, b) => a._arrTs - b._arrTs || a.price - b.price);
  else {
    const w = S.settings.w, ps = arr.map(P), ds = arr.map(x => x.totalDuration);
    const pmin = Math.min(...ps), pmax = Math.max(...ps), dmin = Math.min(...ds), dmax = Math.max(...ds), maxStops = Math.max(1, ...arr.map(x => x.layovers.length));
    arr.forEach(x => { const pn = pmax > pmin ? (P(x) - pmin) / (pmax - pmin) : 0, dn = dmax > dmin ? (x.totalDuration - dmin) / (dmax - dmin) : 0; x._score = w.price * pn + w.time * dn + w.slot * x._slotBad + w.stops * (x.layovers.length / maxStops); });
    arr.sort((a, b) => a._score - b._score);
  }
  return arr;
}
function renderList() {
  const leg = curLeg(), r = leg.result, box = $('#resList'); box.innerHTML = '';
  r.flights.forEach(f => { f._total = totalOf(f, leg.q).total; });
  const visible = r.flights.filter(passesFilter), list = sorted(visible), minP = minPrice(r);
  renderPriceStrip(visible, r.flights);
  if (!list.length) { box.innerHTML = `<div class="empty">${esc(t('empty.res'))}</div>`; return; }
  list.forEach(f => box.appendChild(flightCard(f, r, minP, leg)));
  const hiddenN = r.flights.length - visible.length;
  if (hiddenN > 0) { const d = document.createElement('div'); d.className = 'hint'; d.style.textAlign = 'center'; d.textContent = t('flt.hidden', { n: hiddenN }); box.appendChild(d); }
}
function flightCard(f, r, minP, leg) {
  const first = f.segments[0], last = f.segments[f.segments.length - 1];
  const lv = levelOf(f.price, r.priceInsights, minP);
  const outboundStep = cur.kind === 'together' && cur.legIdx === 0;
  const el = document.createElement('div'); el.className = 'fc' + (cur.legs[1] && cur.legs[1].chosenId === f.id && cur.legIdx === 0 ? ' chosen' : '');
  const stops = f.layovers.length ? t('stops', { n: f.layovers.length, a: f.layovers.map(l => l.iata).join('、') }) : t('nonstop');
  const below = r.priceInsights && r.priceInsights.range && f.price < r.priceInsights.range[0];
  const tot = totalOf(f, leg.q); f._total = tot.total;
  const totalHtml = (FLT.bags || FLT.seat) ? `<div class="total">${esc(t('total.bags', { b: FLT.bags, s: FLT.seat ? t('total.seat') : '', t: money(tot.total, r.currency) }))}${tot.unknown.length ? esc(t('total.unknown', { a: tot.unknown.join('/') })) : ''}</div>` : '';
  const airlines = f._codes.length ? f._codes.map(c => alName(c, (f.segments.find(s => s.airline === c) || {}).airlineName)).join(' ＋ ') : (first.airlineName || '');
  el.innerHTML = `
    <div class="head"><div>${leg.name ? `<span class="tag">${esc(t('leg.' + leg.name))}</span>` : ''}<span class="price">${esc(money(f.price, r.currency))}</span><span class="lv ${lv}">${esc(t('lv.' + lv))}</span>${outboundStep ? `<span class="ap">${esc(t('rtTotal'))}</span>` : ''}</div><div class="ap">${esc(hm(f.totalDuration))}</div></div>
    <div class="al">${esc(airlines)}　${esc(f.segments.map(s => s.flightNo).filter(Boolean).join(' / '))}</div>
    <div class="times">
      <div><div class="t">${esc(tm(first.dep.time))}</div><div class="ap">${esc(first.dep.iata)} ${esc(apCity(first.dep.iata, first.dep.name))}</div></div>
      <div class="mid">${esc(stops)}</div>
      <div><div class="t">${esc(tm(last.arr.time))}${f._plus ? `<small>+${f._plus}</small>` : ''}</div><div class="ap">${esc(last.arr.iata)} ${esc(apCity(last.arr.iata, last.arr.name))}</div></div>
    </div>
    ${totalHtml}
    ${f._warns.length || below ? `<div class="warns">${below ? `<span class="warn ok">${esc(t('wn.belowRange'))}</span>` : ''}${f._warns.map(w => `<span class="warn${w.red ? ' red' : ''}">${esc(w.t)}</span>`).join('')}</div>` : ''}
    <div class="segs">${segsHtml(f)}</div>
    <div class="acts"><button type="button" class="more">${esc(t('card.more'))}</button><button type="button" class="go">${esc(outboundStep ? t('card.pickOut') : t('card.go'))}</button></div>`;
  $('.more', el).onclick = () => { el.classList.toggle('open'); $('.more', el).textContent = el.classList.contains('open') ? t('card.less') : t('card.more'); };
  $('.go', el).onclick = () => outboundStep ? chooseOutbound(f) : openBooking(f, r, leg);
  return el;
}
function segsHtml(f) {
  let h = '';
  f.segments.forEach((s, i) => {
    h += `<div class="seg-row"><b>${esc(alFull(s.airline, s.airlineName))}</b>　${esc(s.flightNo)}${s.aircraft ? '　' + esc(s.aircraft) : ''}${s.cabin ? '　' + esc(s.cabin) : ''}
      <div class="line"><span>${esc(dOf(s.dep.time))} <b>${esc(tm(s.dep.time))}</b> ${esc(t('seg.dep'))}</span><span>${esc(dOf(s.arr.time))} <b>${esc(tm(s.arr.time))}</b> ${esc(t('seg.arr'))}</span></div>
      <div class="line apn"><span>${esc(s.dep.iata)} ${esc(apBoth(s.dep.iata, s.dep.name))}</span><span>${esc(s.arr.iata)} ${esc(apBoth(s.arr.iata, s.arr.name))}</span></div>
      <div class="apn">${esc(t('seg.fly', { d: hm(s.duration) }))}${s.notes && s.notes.length ? '・' + esc(s.notes.join('・')) : ''}</div></div>`;
    if (f.layovers[i]) { const l = f.layovers[i]; h += `<div class="lay">${esc(t('seg.lay', { ap: `${l.iata} ${apCity(l.iata, l.name)}`, d: hm(l.duration) }))}${l.overnight ? esc(t('seg.overnight')) : ''}</div>`; }
  });
  return h;
}

// ───────────── 官網訂票面板 ─────────────
async function openBooking(f, r, leg) {
  const q = leg.q, body = $('#bkBody');
  const chosenOut = cur.kind === 'together' && cur.legs[1] && cur.legs[1].chosen;
  const summary = bookingSummary(f, q, r, chosenOut);
  const cs = allCodes(f, chosenOut);
  body.innerHTML = `<div class="note">${esc(t('bk.note', { t: fmtAt(r.cachedAt || cur.at) }))}</div>
    <div class="bk-sum">${esc(summary)}</div>
    <div class="row2"><button type="button" class="secondary" id="bkCopy">${esc(t('bk.copy'))}</button><a class="secondary" style="display:flex;align-items:center;justify-content:center;text-decoration:none" target="_blank" rel="noopener" href="${esc(gflightsUrl(q))}">${esc(t('bk.gfl'))}</a></div>
    <div class="row2"><button type="button" class="secondary" id="bkCal">📅 ${esc(t('bk.cal'))}</button><button type="button" class="secondary" id="bkShare">↗ ${esc(t('bk.share'))}</button></div>
    <div class="lbl">${esc(t('bk.sites'))}</div>
    ${cs.map(c => { const a = AL[c]; return a ? `<div class="bk-air"><div class="nm"><b>${esc(nameOf(a))}</b><small>${esc(L() === 'en' ? a.zh : a.en)} · ${esc(c)} · ${esc(a.t === 'LCC' ? t('bk.lcc') : t('bk.fsc'))}</small></div><a href="${esc(a.site)}" target="_blank" rel="noopener" data-copy="1">${esc(t('bk.open'))}</a></div>` : `<div class="bk-air"><div class="nm"><b>${esc((f.segments.find(s => s.airline === c) || {}).airlineName || c)}</b><small>${esc(c)} · ${esc(t('bk.notInDb'))}</small></div></div>`; }).join('')}
    ${cs.length > 1 ? `<div class="note">${esc(t('bk.multi'))}</div>` : ''}
    <div class="hint">${esc(t('bk.fx'))}</div>
    <div class="lbl">${esc(t('bk.opts'))}</div><div id="bkOpts" class="hint">${esc(t('bk.loading'))}</div>`;
  const doCopy = async () => { try { await navigator.clipboard.writeText(summary); toast(t('copied')); } catch (e) { toast(t('copyFail')); } };
  $('#bkCopy').onclick = doCopy;
  $('#bkCal').onclick = () => { const blob = new Blob([icsOf(f, chosenOut)], { type: 'text/calendar;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `flight-${f.segments[0].flightNo.replace(/\s/g, '')}.ics`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  $('#bkShare').onclick = async () => { if (navigator.share) { try { await navigator.share({ title: 'Flight', text: summary }); } catch (e) {} } else { await doCopy(); toast(t('share.fail')); } };
  $$('a[data-copy]', body).forEach(a => a.addEventListener('click', doCopy));
  $('#sheetBook').hidden = false;
  const ob = $('#bkOpts');
  if (!f.bookingToken) { ob.textContent = t('bk.noToken'); return; }
  try {
    const j = await api('booking', { q, bt: f.bookingToken, src: r.source || 'serpapi' }, { quick: true });
    const opts = j.options || [];
    if (!opts.length) { ob.textContent = t('bk.none'); return; }
    ob.innerHTML = opts.map(o => `<div class="bk-opt${o.isAirline ? ' air' : ''}">${o.isAirline ? '✈ ' : ''}${esc(o.bookWith)}${o.price ? '　' + esc(money(o.price, r.currency)) : ''}${o.separate ? esc(t('bk.sep')) : ''}${o.baggage && o.baggage.length ? `<div class="apn">🧳 ${esc(o.baggage.join('・'))}</div>` : ''}</div>`).join('') + `<div class="hint">${esc(t('bk.optsHint'))}</div>`;
    renderQuotaBadge(j.quota);
  } catch (e) { ob.textContent = t('bk.optsFail', { m: e.message }); }
}
function allCodes(f, chosenOut) { return [...new Set((chosenOut ? chosenOut._codes || [] : []).concat(f._codes))]; }
function bookingSummary(f, q, r, chosenOut) {
  const lines = [`${apFull(codes(q.o)[0])} → ${apFull(codes(q.d)[0])}`, `${t(q.ret ? 'sum.rt' : 'sum.ow')}　${paxTextQ(q)}`];
  const seg = s => `${s.flightNo} ${alFull(s.airline, s.airlineName)}\n  ${dOf(s.dep.time)} ${tm(s.dep.time)} ${s.dep.iata} → ${dOf(s.arr.time)} ${tm(s.arr.time)} ${s.arr.iata}`;
  if (chosenOut) { lines.push(t('sum.out')); chosenOut.segments.forEach(s => lines.push(seg(s))); lines.push(t('sum.back')); }
  f.segments.forEach(s => lines.push(seg(s)));
  lines.push(t('sum.price', { p: money(f.price, r.currency) }) + (chosenOut ? t('sum.rtTotal') : '') + '　' + fmtAt(r.cachedAt || cur.at));
  return lines.join('\n');
}
$('#bkClose').onclick = () => $('#sheetBook').hidden = true;

// ───────────── 緊急模式 ─────────────
function renderEmerg() {
  if (!S.emerg.o) S.emerg.o = S.settings.defOrigin;
  renderFidsSel(); renderFids();
  $('#eOriginVal').textContent = apLabel(S.emerg.o);
  $('#eDestVal').textContent = S.emerg.d ? apLabel(S.emerg.d) : t('pick');
  const twAir = window.AIRLINES.filter(a => a.co === 'TW');
  const a = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  $('#emergLinks').innerHTML = [
    a('https://www.cwa.gov.tw/V8/C/P/Typhoon/ty.html', t('em.l.typhoon')),
    a('https://www.taoyuan-airport.com/flight_depart', t('em.l.tpe')),
    a('https://www.kia.gov.tw/', t('em.l.khh')),
    a('https://www.tca.gov.tw/', t('em.l.rmq')),
    ...twAir.map(x => a(x.status, t('em.l.status', { a: nameOf(x) }))),
    a('https://www.flightaware.com/', t('em.l.fa'))
  ].join('');
}
// ── TDX 台灣機場即時航班 ──
const TW_FIDS = ['TPE', 'TSA', 'RMQ', 'KHH', 'TNN', 'HUN', 'TTT', 'MZG', 'KNH'];
let fidsDir = 'dep', fidsRows = null, fidsAt = null;
function renderFidsSel() { const s = $('#fidsAp'); s.innerHTML = TW_FIDS.map(i => `<option value="${i}">${esc(apLabel(i))}</option>`).join(''); s.value = S.settings.fidsAp || 'TPE'; }
$('#fidsAp').onchange = e => { S.settings.fidsAp = e.target.value; save(); fidsRows = null; renderFids(); };
$$('#fidsDir button').forEach(b => b.onclick = () => { fidsDir = b.dataset.v; $$('#fidsDir button').forEach(x => x.classList.toggle('on', x === b)); fidsRows = null; renderFids(); });
$('#fidsFilter').oninput = () => renderFids();
$('#btnFids').onclick = async () => {
  const h = $('#fidsHint'); h.textContent = t('fids.loading'); h.className = 'hint';
  try { const j = await api('fids', { ap: S.settings.fidsAp || 'TPE', dir: fidsDir }, { quick: true }); fidsRows = j.rows || []; fidsAt = j.fetchedAt; h.textContent = ''; renderFids(); }
  catch (e) { fidsRows = null; renderFids(); h.textContent = /TDX_CLIENT|CONFIG/.test(e.message) ? t('fids.noKey') : e.message; h.className = 'hint err'; }
};
function fidsClass(remark) { const r = String(remark || ''); if (/取消|cancel/i.test(r)) return 'cancel'; if (/延誤|delay/i.test(r)) return 'delay'; if (/準時|on ?time|出發|離站|抵達|到達|departed|arrived/i.test(r)) return 'ontime'; return ''; }
function renderFids() {
  const box = $('#fidsList'); box.innerHTML = '';
  if (!fidsRows) return;
  const q = ($('#fidsFilter').value || '').trim().toUpperCase().replace(/\s+/g, '');
  const rows = fidsRows.filter(r => !q || (r.flightNo + r.airline + r.from + r.to).toUpperCase().replace(/\s+/g, '').includes(q));
  const hdr = document.createElement('div'); hdr.className = 'hint'; hdr.textContent = `${t('fids.count', { n: rows.length })}　${fidsAt ? t('fids.at', { t: fmtAt(fidsAt) }) : ''}`; box.appendChild(hdr);
  if (!rows.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = t('fids.none'); box.appendChild(d); return; }
  rows.forEach(r => {
    const other = fidsDir === 'dep' ? r.to : r.from;
    const el = document.createElement('div'); el.className = 'fr ' + fidsClass(r.remark);
    el.innerHTML = `<span class="fn">${esc(r.flightNo)}</span><span class="rt">${esc(alName(r.airline, r.airline))}<small>${esc(other)} ${esc(apCity(other, ''))}${r.gate ? '　' + esc(t('fids.gate')) + ' ' + esc(r.gate) : ''}${r.terminal ? ' T' + esc(r.terminal) : ''}</small></span><span class="tm"><b>${esc(tm(r.actual || r.est || r.sched))}</b>${(r.est || r.actual) && tm(r.est || r.actual) !== tm(r.sched) ? `<s>${esc(tm(r.sched))}</s>` : ''}</span><span class="st">${esc(r.remark || '')}</span>`;
    box.appendChild(el);
  });
}
$('#btnEOrigin').onclick = () => openAirport('eo');
$('#btnEDest').onclick = () => openAirport('ed');
$('#btnEmerg').onclick = () => {
  const e = S.emerg, h = $('#emergHint'); h.className = 'hint err';
  if (!e.o || !e.d) return (h.textContent = t('em.v.pick'));
  if (e.o === e.d) return (h.textContent = t('em.v.same'));
  if (!hasBackend()) return (h.textContent = t('em.v.backend'));
  h.textContent = '';
  const nearby = $('#eNearby').checked;
  const grp = i => { const g = (AP[i] || {}).g; return nearby && g ? window.AIRPORTS.filter(x => x.g === g).map(x => x.i).join(',') : i; };
  const o = grp(e.o), d = grp(e.d);
  if (codes(o).some(x => codes(d).includes(x))) return (h.textContent = t('em.v.overlap'));
  const q = { o, d, dep: $('#eTomorrow').checked ? addDays(today(), 1) : today(), ret: null, adults: 1, children: 0, infants: 0, cabin: 1, nonstop: false, include: [], exclude: S.settings.excluded.slice(), currency: S.settings.currency, maxDuration: null };
  startSearch(q, 'oneway', 'emerg', true);
};

// ───────────── 收藏 ─────────────
function favId(q, kind) { return `${q.o}-${q.d}-${kind}`; }
function isFav(q, kind) { return S.favorites.some(f => f.id === favId(q, kind)); }
function favPriceOf(rec) { if (rec.kind === 'split' && rec.legs.length > 1) return minPrice(rec.legs[0].result) + minPrice(rec.legs[1].result); return minPrice(rec.legs[0].result); }
function toggleFav(rec) {
  const q = rec.query, id = favId(q, rec.kind), i = S.favorites.findIndex(f => f.id === id);
  if (i >= 0) { S.favorites.splice(i, 1); toast(t('fav.rm')); }
  else { S.favorites.push({ id, o: q.o, d: q.d, kind: rec.kind, params: clone(q), lastPrice: favPriceOf(rec), prevPrice: null, lastAt: new Date().toISOString(), currency: rec.legs[0].result.currency }); toast(t('fav.add')); }
  save();
}
function updateFavPrice(rec) {
  const f = S.favorites.find(x => x.id === favId(rec.query, rec.kind)); if (!f) return;
  const p = favPriceOf(rec); if (p == null) return;
  f.prevPrice = f.lastPrice; f.lastPrice = p; f.lastAt = new Date().toISOString(); f.currency = rec.legs[0].result.currency; f.params = clone(rec.query);
}
function renderFavs() {
  const box = $('#favList'); box.innerHTML = ''; $('#favEmpty').hidden = S.favorites.length > 0; $('#btnFavAll').hidden = !S.favorites.length;
  S.favorites.forEach(f => {
    const el = document.createElement('div'); el.className = 'fav';
    const d = f.prevPrice != null ? f.lastPrice - f.prevPrice : null;
    const expired = f.params && f.params.dep < today();
    el.innerHTML = `<div class="route"><b>${esc(apLabel(f.o))} → ${esc(apLabel(f.d))}</b><small>${esc(kindLabel(f.kind))}・${esc(f.params ? f.params.dep + (f.params.ret ? '～' + f.params.ret : '') : '')}${expired ? esc(t('fav.expired')) : ''}・${esc(t('fav.at', { t: fmtAt(f.lastAt) }))}</small></div>
      <div class="pr"><b>${esc(money(f.lastPrice, f.currency))}</b>${d != null ? `<span class="delta ${d < 0 ? 'down' : d > 0 ? 'up' : ''}">${d < 0 ? '▼' : d > 0 ? '▲' : '－'} ${esc(money(Math.abs(d), f.currency))}</span>` : `<span class="delta">${esc(t('fav.first'))}</span>`}</div>
      <button type="button" class="del" aria-label="remove">✕</button>`;
    const go = () => { const p = f.params || {}; Object.assign(S.form, { o: f.o, d: f.d, trip: f.kind === 'oneway' ? 'ow' : 'rt', rtMode: f.kind === 'split' ? 'split' : 'together', dep: p.dep && p.dep >= today() ? p.dep : '', ret: p.ret || '', adults: p.adults || 1, children: p.children || 0, infants: p.infants || 0, cabin: p.cabin || 1, nonstop: !!p.nonstop }); save(); showView('search'); toast(t(expired ? 'fav.goExpired' : 'fav.go')); };
    $('.route', el).onclick = go; $('.pr', el).onclick = go;
    $('.del', el).onclick = () => { const bak = S.favorites.slice(); S.favorites = S.favorites.filter(x => x.id !== f.id); save(); renderFavs(); undoToast(t('fav.rm'), () => { S.favorites = bak; save(); renderFavs(); }); };
    box.appendChild(el);
  });
}
$('#btnFavAll').onclick = async () => {
  if (busy) return;
  const list = S.favorites.filter(f => f.params && f.params.dep >= today());
  if (!list.length) return toast(t('fav.none'));
  if (!hasBackend()) return toast(t('em.v.backend'));
  const qn = list.reduce((a, f) => a + (f.kind === 'split' ? 2 : 1), 0);
  if (!confirm(t('fav.confirm', { n: list.length, q: qn }))) return;
  const seq = ++reqSeq; let n = 0, fail = 0;
  setBusy(true, t('ld.fav', { a: 0, b: list.length }));
  try {
    for (const f of list) {
      if (seq !== reqSeq) return;
      try {
        const rec = { mode: 'fav', kind: f.kind, query: f.params, at: new Date().toISOString(), legs: [] };
        if (f.kind === 'split') { const qo = Object.assign({}, f.params, { ret: null }), qb = Object.assign({}, f.params, { o: f.params.d, d: f.params.o, dep: f.params.ret, ret: null }); rec.legs = [{ q: qo, result: await fetchSearch(qo, false) }, { q: qb, result: await fetchSearch(qb, false) }]; }
        else rec.legs = [{ q: f.params, result: await fetchSearch(f.params, false) }];
        updateFavPrice(rec); n++;
      } catch (e) { if (isCancel(e)) throw e; fail++; }
      $('#loadingText').textContent = t('ld.fav', { a: n + fail, b: list.length }); save(); renderFavs();
    }
    toast(t('fav.done', { n }) + (fail ? t('fav.failed', { n: fail }) : ''));
  } catch (e) { toast(t('e.cancelled')); } finally { if (seq === reqSeq) setBusy(false); }
};

// ───────────── 設定 ─────────────
function renderSettings() {
  const s = S.settings;
  $('#setBackend').value = s.backend; $('#setToken').value = s.token; $('#setHomePc').value = s.homepc; $('#setHomeToken').value = s.homeToken;
  $('#setCurrency').value = s.currency; $('#setNonstop').checked = s.nonstop; $('#setMinLayover').value = s.minLayover; $('#setStaleHours').value = s.staleHours; $('#setCacheMin').value = s.cacheMin;
  $('#wPrice').value = s.w.price; $('#wTime').value = s.w.time; $('#wSlot').value = s.w.slot; $('#wStops').value = s.w.stops;
  $('#setTheme').value = s.theme; $('#setFont').value = s.font; $('#setLang').value = L();
  const so = $('#setDefOrigin'); so.innerHTML = s.airports.map(i => `<option value="${esc(i)}">${esc(apLabel(i))}</option>`).join(''); so.value = s.defOrigin;
  renderAirlineList(); renderAirportList($('#airportFilter').value || ''); renderFeeList();
  $('#verInfo').textContent = t('ver', { v: VERSION, n: Object.keys(S.cache).length });
}
function renderFeeList() {
  const box = $('#feeList'); if (!box) return; box.innerHTML = '';
  window.AIRLINES.filter(a => S.settings.airlines.includes(a.c) && !S.settings.excluded.includes(a.c)).sort((x, y) => (x.t === 'LCC' ? 0 : 1) - (y.t === 'LCC' ? 0 : 1)).forEach(a => {
    const fee = S.settings.fees[a.c] || {};
    const row = document.createElement('div'); row.className = 'cl';
    row.innerHTML = `<span class="code">${esc(a.c)}</span><span class="nm">${esc(nameOf(a))}<small>${esc(a.t === 'LCC' ? t('al.lccTag') : t('al.fscTag'))}</small></span><label class="apn" style="font-size:.75em">${esc(t('fees.bag'))}<br><input class="fee" type="number" min="0" inputmode="numeric" data-k="bag" value="${fee.bag != null ? esc(fee.bag) : ''}"></label><label class="apn" style="font-size:.75em">${esc(t('fees.seat'))}<br><input class="fee" type="number" min="0" inputmode="numeric" data-k="seat" value="${fee.seat != null ? esc(fee.seat) : ''}"></label>`;
    $$('input', row).forEach(inp => inp.onchange = e => { const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0); S.settings.fees[a.c] = Object.assign({}, S.settings.fees[a.c] || {}, { [e.target.dataset.k]: v }); save(); });
    box.appendChild(row);
  });
}
function renderAirlineList() {
  const box = $('#airlineList'); box.innerHTML = '';
  window.AIRLINES.forEach(a => {
    const on = S.settings.airlines.includes(a.c), ex = S.settings.excluded.includes(a.c);
    const row = document.createElement('label'); row.className = 'cl';
    row.innerHTML = `<input type="checkbox" ${on && !ex ? 'checked' : ''} ${ex ? 'disabled' : ''}><span class="code">${esc(a.c)}</span><span class="nm">${esc(nameOf(a))}<small>${esc(L() === 'en' ? a.zh : a.en)} · ${esc(t(a.t === 'LCC' ? 'al.lccTag' : 'al.fscTag'))} · ${esc(countryZh(a.co))}</small></span><button type="button" class="ex${ex ? ' on' : ''}">${esc(ex ? t('al.exd') : t('al.ex'))}</button>`;
    $('input', row).onchange = e => { const i = S.settings.airlines.indexOf(a.c); if (e.target.checked) { if (i < 0) S.settings.airlines.push(a.c); } else if (i >= 0) S.settings.airlines.splice(i, 1); save(); };
    $('.ex', row).onclick = e => { e.preventDefault(); const i = S.settings.excluded.indexOf(a.c); i >= 0 ? S.settings.excluded.splice(i, 1) : S.settings.excluded.push(a.c); save(); renderAirlineList(); };
    box.appendChild(row);
  });
}
$$('[data-air]').forEach(b => b.onclick = () => {
  const m = b.dataset.air, all = window.AIRLINES;
  if (m === 'all') S.settings.airlines = all.map(a => a.c);
  if (m === 'none') S.settings.airlines = [];
  if (m === 'tw') S.settings.airlines = all.filter(a => a.co === 'TW').map(a => a.c);
  if (m === 'lcc') S.settings.airlines = all.filter(a => a.t === 'LCC').map(a => a.c);
  save(); renderAirlineList(); toast(t('al.updated'));
});
function renderAirportList(q) {
  const box = $('#airportList'); box.innerHTML = '';
  window.AIRPORTS.filter(a => !q || matchAp(a, q)).forEach(a => {
    const row = document.createElement('label'); row.className = 'cl';
    row.innerHTML = `<input type="checkbox" ${S.settings.airports.includes(a.i) ? 'checked' : ''}><span class="code">${esc(a.i)}</span><span class="nm">${apRowHtml(a)}</span>`;
    $('input', row).onchange = e => { const i = S.settings.airports.indexOf(a.i); if (e.target.checked) { if (i < 0) S.settings.airports.push(a.i); } else if (i >= 0) S.settings.airports.splice(i, 1); if (!S.settings.airports.includes(S.settings.defOrigin)) S.settings.defOrigin = S.settings.airports[0] || 'TPE'; save(); };
    box.appendChild(row);
  });
}
$('#airportFilter').oninput = e => renderAirportList(e.target.value.trim());
const bind = (id, key, conv) => { $(id).onchange = e => { S.settings[key] = conv ? conv(e.target) : e.target.value.trim(); save(); applyTheme(); }; };
bind('#setBackend', 'backend'); bind('#setToken', 'token'); bind('#setHomePc', 'homepc'); bind('#setHomeToken', 'homeToken');
bind('#setCurrency', 'currency'); bind('#setNonstop', 'nonstop', x => x.checked); bind('#setTheme', 'theme'); bind('#setFont', 'font');
bind('#setMinLayover', 'minLayover', x => Math.min(180, Math.max(30, Number(x.value) || 60)));
bind('#setStaleHours', 'staleHours', x => Math.min(72, Math.max(1, Number(x.value) || 6)));
bind('#setCacheMin', 'cacheMin', x => Math.min(720, Math.max(0, Number(x.value) || 0)));
bind('#setDefOrigin', 'defOrigin');
$('#setLang').onchange = e => { S.settings.lang = e.target.value; save(); applyLang(); renderSettings(); };
[['wPrice', 'price'], ['wTime', 'time'], ['wSlot', 'slot'], ['wStops', 'stops']].forEach(([id, k]) => $('#' + id).onchange = e => { S.settings.w[k] = Math.min(100, Math.max(0, Number(e.target.value) || 0)); save(); });
$('#btnTestConn').onclick = async () => {
  const h = $('#connHint'); h.textContent = t('testing'); h.className = 'hint';
  try { const j = await api('ping', {}, { quick: true }); const sp = (j.providers || {}).serpapi; h.textContent = t('conn.ok', { via: t(j.via === 'homepc' ? 'via.homepc' : 'via.gas'), v: j.version || '1.0' }) + (sp && sp.configured ? (sp.valid === false ? '\n' + t('conn.keyBad', { m: sp.accountError || '' }) : sp.left != null ? '\n' + t('conn.keyOk', { n: sp.left }) : '') : '\n' + t('conn.noKey')); h.className = sp && sp.valid === false ? 'hint err' : 'hint ok'; renderQuotaBadge(j.providers); }
  catch (e) { h.textContent = t('q.fail', { m: e.message }); h.className = 'hint err'; }
};
$('#btnQuota').onclick = async () => {
  const h = $('#connHint'); h.textContent = t('quota.q'); h.className = 'hint';
  try { const j = await api('quota', {}, { quick: true }); h.textContent = quotaText(j.providers || {}); h.className = 'hint'; renderQuotaBadge(j.providers); }
  catch (e) { h.textContent = t('quota.fail', { m: e.message }); h.className = 'hint err'; }
};
function provName(k) { const s = t('prov.' + k); return s === 'prov.' + k ? k : s; }
function quotaText(p) { return Object.entries(p).filter(([k, v]) => v && typeof v === 'object' && 'used' in v).map(([k, v]) => (v.configured ? t('quota.line', { p: provName(k), u: v.used, q: v.quota ? ' / ' + v.quota : '' }) + (v.left != null ? t('quota.leftReal', { n: v.left }) : '') + (v.valid === false ? t('quota.invalid', { m: v.accountError || '' }) : '') : t('quota.unset', { p: provName(k) }))).join('\n') + '\n' + t('quota.tail', { m: p.month || '', o: (p.order || []).map(provName).join(' → '), c: p.cacheMin != null ? p.cacheMin : '—' }); }
function renderQuotaBadge(p) {
  if (p) quotaCache = p;
  const b = $('#quotaBadge'); if (!quotaCache) { b.textContent = ''; return; }
  b.textContent = Object.entries(quotaCache).filter(([k, v]) => v && typeof v === 'object' && v.configured && (v.quota || v.left != null)).map(([k, v]) => t('quota.left', { p: provName(k), n: v.left != null ? v.left : Math.max(0, v.quota - v.used) })).join('・');
}
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'flight-price-pwa', version: VERSION, v: SCHEMA, settings: S.settings, favorites: S.favorites, emerg: S.emerg, form: S.form }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `flight-settings-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(t('exp.ok'));
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j.settings || !Array.isArray(j.settings.airlines)) throw new Error(t('imp.bad'));
    if (!confirm(t('imp.confirm'))) return;
    S.settings = deepMerge(clone(DEF.settings), j.settings); S.favorites = Array.isArray(j.favorites) ? j.favorites : []; S.emerg = j.emerg || S.emerg; S.form = j.form ? deepMerge(clone(DEF.form), j.form) : S.form;
    migrate(S); save(); applyTheme(); applyLang(); renderSettings(); toast(t('imp.ok'));
  } catch (err) { toast(t('imp.fail', { m: err.message }), 4000); }
  e.target.value = '';
};
$('#btnClearCache').onclick = () => { S.cache = {}; save(); renderSettings(); toast(t('cache.cleared')); };
$('#btnClear').onclick = () => { if (confirm(t('clr.1'))) { if (confirm(t('clr.2'))) { localStorage.removeItem(KEY); S = clone(DEF); migrate(S); applyTheme(); applyLang(); showView('search'); toast(t('clr.ok')); } } };

// ───────────── 啟動 ─────────────
applyTheme(); applyLang();
showView('search');
window.addEventListener('online', () => toast(t('online')));
window.addEventListener('offline', () => toast(t('offline2')));
if (navigator.serviceWorker && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
if (/iphone|ipad/i.test(navigator.userAgent) && !window.navigator.standalone && !sessionStorage.getItem('a2hs')) { sessionStorage.setItem('a2hs', '1'); setTimeout(() => toast(t('a2hs'), 5000), 1500); }
} catch (e) {
  const el = document.getElementById('boot-error');
  if (el) { el.hidden = false; el.textContent = 'App 啟動失敗 / failed to start: ' + (e && e.message || e) + '\n請更新手機系統或瀏覽器後再試。Please update your OS/browser and retry.'; }
  console.error(e);
}
})();
