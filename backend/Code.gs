/**
 * ✈ 機票查價中繼 v1.1（Google Apps Script Web App）
 * ------------------------------------------------------------
 * 手機 PWA → 本中繼 → 航班資料來源（依序輪替）→ 統一格式回傳
 * 不儲存查價結果（只有 30 分鐘的伺服器快取，省額度）；記錄各來源本月已用次數。
 *
 * 【Script Properties】（專案設定 → 指令碼屬性）
 *   APP_TOKEN        自訂密碼（手機端設定頁填同一組）
 *   SERPAPI_KEY      SerpApi 金鑰（免費 250 次／月）
 *   HASDATA_KEY      HasData 金鑰（免費約 67 次／月；格式未實測，標記為實驗性）
 *   HOMEPC_URL       （預留）家中電腦服務網址，例如 https://xxxx.ts.net
 *   HOMEPC_TOKEN     （預留）家中電腦密碼
 *   PROVIDER_ORDER   預設 "homepc,serpapi,hasdata"
 *   SERPAPI_QUOTA    預設 250
 *   HASDATA_QUOTA    預設 60
 *   CACHE_MIN        伺服器快取分鐘數，預設 30，設 0 關閉
 *   MAX_PER_DAY      每日最多允許的外部查詢次數（防密碼外洩時額度被耗盡），預設 40
 *   DEEP_SEARCH      "1" 時 SerpApi 用 deep_search（結果更完整但較慢，可能超過 GAS 60 秒），預設關閉
 *   TDX_CLIENT_ID    （選用）交通部 TDX 運輸資料平臺金鑰，免費註冊 tdx.transportdata.tw，啟用台灣機場即時航班
 *   TDX_CLIENT_SECRET（選用）同上
 *
 * 【部署】部署 → 新增部署作業 → 網頁應用程式 → 執行身分「我」、存取權「所有人」
 *
 * 【API】全部 GET
 *   ?action=ping|quota&token=...
 *   ?action=search&token=...&q=<JSON>[&force=1]
 *       q = {o:'TPE'|'TPE,TSA', d:'NRT', dep:'YYYY-MM-DD', ret:'YYYY-MM-DD'|null,
 *            adults, children, infants, cabin:1..4, nonstop:bool,
 *            include:[codes], exclude:[codes], currency:'TWD', maxDuration:(分)|null}
 *       ・單程（ret=null）：每筆有 bookingToken
 *       ・來回（ret 有值）：回傳「去程選項」，每筆有 departureToken，價格為來回總價
 *   ?action=returns&token=...&q=<JSON>&dt=<departureToken>   來回第二步：回程選項，每筆有 bookingToken
 *   ?action=booking&token=...&q=<JSON>&bt=<bookingToken>&src=<來源>   訂票管道（哪些可向航空公司直接訂）
 *   ?action=fids&token=...&ap=TPE&dir=dep|arr   台灣機場即時航班（TDX；需金鑰）
 *
 * 【統一回傳格式】（家中電腦 Python 服務也要回傳同樣格式）
 *   {ok:true, source, fetchedAt, currency, cached:bool, leg:'oneway'|'outbound'|'return',
 *    priceInsights:{lowest, level:'low'|'typical'|'high'|null, range:[lo,hi]|null} | null,
 *    flights:[{id, price, rank:'best'|'other', totalDuration,
 *              segments:[{airline, airlineName, flightNo, dep:{iata,name,time}, arr:{iata,name,time}, duration, aircraft, cabin, notes:[]}],
 *              layovers:[{iata,name,duration,overnight}],
 *              departureToken|null, bookingToken|null, carbonKg|null}],
 *    quota:{...}}
 */

// ─────────────────────── 設定 ───────────────────────
function P_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return (v === null || v === '') ? d : v; }
function CFG_() {
  return {
    token: P_('APP_TOKEN', ''),
    order: P_('PROVIDER_ORDER', 'homepc,serpapi,hasdata').split(',').map(function (s) { return s.trim(); }).filter(String),
    serpapi: { key: P_('SERPAPI_KEY', ''), quota: Number(P_('SERPAPI_QUOTA', 250)) },
    hasdata: { key: P_('HASDATA_KEY', ''), quota: Number(P_('HASDATA_QUOTA', 60)) },
    homepc: { url: P_('HOMEPC_URL', ''), token: P_('HOMEPC_TOKEN', '') },
    cacheMin: Number(P_('CACHE_MIN', 30)),
    maxPerDay: Number(P_('MAX_PER_DAY', 40)),
    deep: P_('DEEP_SEARCH', '0') === '1',
    tdx: { id: P_('TDX_CLIENT_ID', ''), secret: P_('TDX_CLIENT_SECRET', '') }
  };
}

// ─────────────────────── 入口 ───────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  var cfg = CFG_();
  try {
    if (!cfg.token) return out_({ ok: false, error: 'CONFIG', message: 'GAS 尚未設定 APP_TOKEN' });
    if (p.token !== cfg.token) return out_({ ok: false, error: 'AUTH', message: '密碼錯誤' });
    var q = p.q ? JSON.parse(p.q) : {};
    switch (p.action) {
      case 'ping': return out_({ ok: true, version: '1.1', time: new Date().toISOString(), providers: providerStatus_(cfg) });
      case 'quota': return out_({ ok: true, providers: providerStatus_(cfg) });
      case 'search': return out_(withCache_('S', q, p.force === '1', cfg, function () { return search_(q, cfg); }));
      case 'returns': return out_(withCache_('R' + p.dt, q, p.force === '1', cfg, function () { return returns_(q, p.dt, cfg); }));
      case 'booking': return out_(booking_(q, p.bt, p.src, cfg));
      case 'fids': return out_(fids_(p.ap, p.dir, cfg));
      default: return out_({ ok: false, error: 'BAD_ACTION', message: '未知的 action' });
    }
  } catch (err) {
    return out_({ ok: false, error: 'EXCEPTION', message: String(err && err.message || err) });
  }
}
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ─────────────────────── 伺服器快取（省額度） ───────────────────────
function cacheKey_(prefix, q) {
  var s = prefix + JSON.stringify([q.o, q.d, q.dep, q.ret, q.adults, q.children, q.infants, q.cabin, !!q.nonstop, (q.include || []).slice().sort(), (q.exclude || []).slice().sort(), q.currency, q.maxDuration]);
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)).slice(0, 40);
}
function withCache_(prefix, q, force, cfg, fn) {
  if (!cfg.cacheMin) return fn();
  var cache = CacheService.getScriptCache(), key = cacheKey_(prefix, q);
  if (!force) {
    var hit = cache.get(key);
    if (hit) { try { var j = JSON.parse(hit); j.cached = true; j.quota = providerStatus_(cfg); return j; } catch (e) {} }
  }
  var r = fn();
  if (r && r.ok) {
    try { var s = JSON.stringify(r); if (s.length < 30000) cache.put(key, s, Math.min(21600, cfg.cacheMin * 60)); } catch (e) {}
  }
  return r;
}

// ─────────────────────── 額度 ───────────────────────
function monthKey_() { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMM'); }
function used_(prov) { return Number(P_('used_' + prov + '_' + monthKey_(), 0)); }
function dayKey_() { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd'); }
function usedToday_() { return Number(P_('day_' + dayKey_(), 0)); }
function bump_(prov) {
  var ps = PropertiesService.getScriptProperties();
  ps.setProperty('used_' + prov + '_' + monthKey_(), String(used_(prov) + 1));
  ps.setProperty('day_' + dayKey_(), String(usedToday_() + 1));
}
function checkDaily_(cfg) { if (cfg.maxPerDay > 0 && usedToday_() >= cfg.maxPerDay) throw new Error('今日查詢已達上限 ' + cfg.maxPerDay + ' 次（防護機制，可在 GAS 屬性 MAX_PER_DAY 調整）'); }
// SerpApi 帳戶 API（不扣查詢次數）：取得真實剩餘額度，快取 5 分鐘
function serpapiAccount_(cfg) {
  if (!cfg.serpapi.key) return null;
  var cache = CacheService.getScriptCache(), hit = cache.get('serpapi_account');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  try {
    var res = UrlFetchApp.fetch('https://serpapi.com/account.json?api_key=' + encodeURIComponent(cfg.serpapi.key), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { valid: false, error: 'HTTP ' + res.getResponseCode() };
    var j = JSON.parse(res.getContentText());
    var acc = { valid: !j.error, left: Number(j.plan_searches_left != null ? j.plan_searches_left : j.total_searches_left), used: Number(j.this_month_usage || 0), perMonth: Number(j.searches_per_month || 0), plan: j.plan_name || '', error: j.error || null };
    cache.put('serpapi_account', JSON.stringify(acc), 300);
    return acc;
  } catch (e) { return { valid: false, error: String(e.message || e) }; }
}
function providerStatus_(cfg) {
  var acc = serpapiAccount_(cfg);
  return {
    homepc: { configured: !!cfg.homepc.url, used: used_('homepc'), quota: null },
    serpapi: { configured: !!cfg.serpapi.key, used: acc && acc.valid && acc.used ? acc.used : used_('serpapi'), quota: acc && acc.valid && acc.perMonth ? acc.perMonth : cfg.serpapi.quota, left: acc && acc.valid && !isNaN(acc.left) ? acc.left : null, valid: acc ? acc.valid : null, accountError: acc && acc.error || null },
    hasdata: { configured: !!cfg.hasdata.key, used: used_('hasdata'), quota: cfg.hasdata.quota, experimental: true },
    tdx: { configured: !!(cfg.tdx.id && cfg.tdx.secret) },
    order: cfg.order, month: monthKey_(), cacheMin: cfg.cacheMin, today: usedToday_(), maxPerDay: cfg.maxPerDay
  };
}
function available_(prov, cfg) {
  if (prov === 'homepc') return !!cfg.homepc.url;
  if (prov === 'serpapi') { if (!cfg.serpapi.key) return false; var acc = serpapiAccount_(cfg); if (acc && acc.valid && !isNaN(acc.left)) return acc.left > 0; return used_('serpapi') < cfg.serpapi.quota; }
  if (prov === 'hasdata') return !!cfg.hasdata.key && used_('hasdata') < cfg.hasdata.quota;
  return false;
}

// ─────────────────────── 驗證 ───────────────────────
function validate_(q) {
  var code = /^[A-Z]{3}(,[A-Z]{3})*$/;
  if (!q.o || !q.d) throw new Error('缺少出發或抵達機場');
  if (!code.test(q.o) || !code.test(q.d)) throw new Error('機場代碼格式錯誤');
  if (q.o === q.d) throw new Error('出發與抵達機場相同');
  var oo = q.o.split(','), dd = q.d.split(',');
  if (oo.some(function (x) { return dd.indexOf(x) >= 0; })) throw new Error('出發與抵達機場重疊');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.dep || '')) throw new Error('去程日期格式錯誤');
  if (q.ret && !/^\d{4}-\d{2}-\d{2}$/.test(q.ret)) throw new Error('回程日期格式錯誤');
  if (q.ret && q.ret < q.dep) throw new Error('回程早於去程');
  q.adults = Math.min(9, Math.max(1, Number(q.adults || 1)));
  q.children = Math.min(8, Math.max(0, Number(q.children || 0)));
  q.infants = Math.min(8, Math.max(0, Number(q.infants || 0)));
  if (q.infants > q.adults) throw new Error('嬰兒人數不得多於成人');
  q.cabin = Math.min(4, Math.max(1, Number(q.cabin || 1)));
  q.currency = /^[A-Z]{3}$/.test(q.currency || '') ? q.currency : 'TWD';
  q.include = Array.isArray(q.include) ? q.include.slice(0, 60) : [];
  q.exclude = Array.isArray(q.exclude) ? q.exclude.slice(0, 80) : [];
  q.maxDuration = q.maxDuration ? Math.min(4320, Math.max(60, Number(q.maxDuration))) : null;
  return q;
}

// ─────────────────────── 搜尋（輪替來源） ───────────────────────
function search_(q, cfg) { return runProviders_(q, cfg, function (prov) {
  if (prov === 'homepc') return homepcGet_('search', { q: JSON.stringify(q) }, cfg);
  if (prov === 'serpapi') return serpapiSearch_(q, null, cfg);
  if (prov === 'hasdata') return hasdataSearch_(q, cfg);
}); }
function returns_(q, dt, cfg) {
  if (!dt) return { ok: false, error: 'BAD_REQUEST', message: '缺少去程 token' };
  if (!q.ret) return { ok: false, error: 'BAD_REQUEST', message: '單程沒有回程選項' };
  return runProviders_(q, cfg, function (prov) {
    if (prov === 'homepc') return homepcGet_('returns', { q: JSON.stringify(q), dt: dt }, cfg);
    if (prov === 'serpapi') return serpapiSearch_(q, dt, cfg);
    return { ok: false, message: prov + ' 不支援回程選項' };
  });
}
function runProviders_(q, cfg, fn) {
  q = validate_(q); checkDaily_(cfg);
  var tried = [];
  for (var i = 0; i < cfg.order.length; i++) {
    var prov = cfg.order[i];
    if (!available_(prov, cfg)) continue;
    try {
      var r = fn(prov);
      if (r && r.ok) { r.tried = tried; r.quota = providerStatus_(cfg); return r; }
      tried.push(prov + ': ' + ((r && r.message) || '無資料'));
    } catch (err) { tried.push(prov + ': ' + err.message); }
  }
  return { ok: false, error: 'NO_PROVIDER', message: tried.length ? tried.join('；') : '沒有可用的資料來源（額度用完或未設定金鑰）', tried: tried, quota: providerStatus_(cfg) };
}

// ─────────────────────── 來源 A：家中電腦（預留） ───────────────────────
function homepcGet_(action, params, cfg) {
  params.token = cfg.homepc.token;
  var url = cfg.homepc.url.replace(/\/$/, '') + '/' + action + '?' + qs_(params);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) return { ok: false, message: 'homepc HTTP ' + res.getResponseCode() };
  var j = JSON.parse(res.getContentText());
  if (!j.ok) return j;
  bump_('homepc');
  j.source = j.source || 'homepc'; j.fetchedAt = j.fetchedAt || new Date().toISOString();
  return j;
}

// ─────────────────────── 來源 B：SerpApi（Google Flights） ───────────────────────
function serpapiSearch_(q, departureToken, cfg) {
  var params = {
    engine: 'google_flights', api_key: cfg.serpapi.key,
    departure_id: q.o, arrival_id: q.d, outbound_date: q.dep,
    type: q.ret ? '1' : '2', adults: q.adults, children: q.children, infants_in_seat: 0, infants_on_lap: q.infants,
    travel_class: q.cabin, currency: q.currency, hl: 'zh-TW', gl: 'tw'
  };
  if (cfg.deep) params.deep_search = 'true';
  if (q.ret) params.return_date = q.ret;
  if (q.nonstop) params.stops = '1';
  if (q.include.length) params.include_airlines = q.include.join(',');
  else if (q.exclude.length) params.exclude_airlines = q.exclude.join(',');   // SerpApi 不允許兩者同時給
  if (q.maxDuration) params.max_duration = q.maxDuration;
  if (departureToken) params.departure_token = departureToken;
  bump_('serpapi');
  var res = UrlFetchApp.fetch('https://serpapi.com/search.json?' + qs_(params), { muteHttpExceptions: true });
  var j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, message: 'serpapi 回應不是 JSON' }; }
  if (res.getResponseCode() !== 200 || j.error) return { ok: false, message: 'serpapi: ' + (j.error || ('HTTP ' + res.getResponseCode())) };
  var r = normalizeGoogleShape_(j, 'serpapi', q);
  if (r.ok) {
    r.leg = !q.ret ? 'oneway' : (departureToken ? 'return' : 'outbound');
    // include 與 exclude 同時存在時，exclude 以本地過濾補上
    if (q.include.length && q.exclude.length) r.flights = filterAirlines_(r.flights, [], q.exclude);
  }
  return r;
}

// ─────────────────────── 來源 C：HasData（實驗性，格式未實測） ───────────────────────
function hasdataSearch_(q, cfg) {
  var params = { departureId: q.o, arrivalId: q.d, outboundDate: q.dep, currency: q.currency, hl: 'zh-TW', gl: 'tw', adults: q.adults, children: q.children, travelClass: q.cabin };
  if (q.ret) params.returnDate = q.ret;
  if (q.nonstop) params.stops = 1;
  bump_('hasdata');
  var res = UrlFetchApp.fetch('https://api.hasdata.com/scrape/google-flights?' + qs_(params), { muteHttpExceptions: true, headers: { 'x-api-key': cfg.hasdata.key } });
  if (res.getResponseCode() !== 200) return { ok: false, message: 'hasdata HTTP ' + res.getResponseCode() };
  var j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, message: 'hasdata 回應不是 JSON' }; }
  var r = normalizeGoogleShape_(j.data || j, 'hasdata', q);
  if (r.ok) { r.leg = q.ret ? 'outbound' : 'oneway'; r.flights = filterAirlines_(r.flights, q.include, q.exclude); if (!r.flights.length) return { ok: false, message: 'hasdata: 過濾後無航班' }; }
  return r;
}
function filterAirlines_(flights, include, exclude) {
  return flights.filter(function (f) {
    var codes = f.segments.map(function (s) { return s.airline; });
    if (exclude.length && codes.some(function (c) { return exclude.indexOf(c) >= 0; })) return false;
    if (include.length && !codes.every(function (c) { return include.indexOf(c) >= 0; })) return false;
    return true;
  });
}

// ─────────────────────── 正規化（Google Flights 形狀；同時接受 snake_case 與 camelCase） ───────────────────────
function pick_(o, a, b) { if (!o) return undefined; return o[a] !== undefined ? o[a] : o[b]; }
function normalizeGoogleShape_(j, source, q) {
  var best = pick_(j, 'best_flights', 'bestFlights') || [];
  var other = pick_(j, 'other_flights', 'otherFlights') || [];
  var pi = pick_(j, 'price_insights', 'priceInsights') || null;
  var flights = [];
  function conv(list, rank) {
    (list || []).forEach(function (it, idx) {
      var segs = (it.flights || it.segments || []).map(function (s) {
        var fn = String(pick_(s, 'flight_number', 'flightNumber') || '').trim();
        var m = fn.match(/^([A-Z0-9]{2})\s*(\d+)/i);
        var code = m ? m[1].toUpperCase() : '';
        var da = pick_(s, 'departure_airport', 'departureAirport') || {};
        var aa = pick_(s, 'arrival_airport', 'arrivalAirport') || {};
        return {
          airline: code, airlineName: s.airline || '', flightNo: m ? (m[1].toUpperCase() + ' ' + m[2]) : fn,
          dep: { iata: da.id || '', name: da.name || '', time: da.time || '' },
          arr: { iata: aa.id || '', name: aa.name || '', time: aa.time || '' },
          duration: Number(s.duration || 0), aircraft: s.airplane || '', cabin: pick_(s, 'travel_class', 'travelClass') || '',
          notes: (s.extensions || []).slice(0, 4)
        };
      });
      if (!segs.length) return;
      var price = Number(it.price || 0);
      if (!(price > 0)) return;   // Google 偶爾回傳沒有價格的選項，略過
      var lays = (it.layovers || []).map(function (l) { return { iata: l.id || '', name: l.name || '', duration: Number(l.duration || 0), overnight: !!l.overnight }; });
      var ce = pick_(it, 'carbon_emissions', 'carbonEmissions');
      flights.push({
        id: source + '-' + rank + '-' + idx,
        price: price, rank: rank,
        totalDuration: Number(pick_(it, 'total_duration', 'totalDuration') || 0) || segs.reduce(function (a, s) { return a + s.duration; }, 0) + lays.reduce(function (a, l) { return a + l.duration; }, 0),
        segments: segs, layovers: lays,
        departureToken: pick_(it, 'departure_token', 'departureToken') || null,
        bookingToken: pick_(it, 'booking_token', 'bookingToken') || null,
        carbonKg: ce && pick_(ce, 'this_flight', 'thisFlight') ? Math.round(pick_(ce, 'this_flight', 'thisFlight') / 1000) : null
      });
    });
  }
  conv(best, 'best'); conv(other, 'other');
  if (!flights.length) return { ok: false, message: source + ': 無航班資料' };
  var range = pi ? (pick_(pi, 'typical_price_range', 'typicalPriceRange') || null) : null;
  return {
    ok: true, source: source, fetchedAt: new Date().toISOString(), currency: q.currency, cached: false, query: q,
    priceInsights: pi ? { lowest: Number(pick_(pi, 'lowest_price', 'lowestPrice') || 0) || null, level: pick_(pi, 'price_level', 'priceLevel') || null, range: (Array.isArray(range) && range.length === 2) ? range : null } : null,
    flights: flights
  };
}

// ─────────────────────── 訂票管道 ───────────────────────
function booking_(q, bt, src, cfg) {
  q = validate_(q);
  if (!bt) return { ok: false, message: '缺少 booking token' };
  if (src === 'homepc' && cfg.homepc.url) return homepcGet_('booking', { q: JSON.stringify(q), bt: bt }, cfg);
  checkDaily_(cfg);
  if (!available_('serpapi', cfg)) return { ok: false, message: 'SerpApi 額度已用完或未設定，請直接前往官網' };
  var params = {
    engine: 'google_flights', api_key: cfg.serpapi.key,
    departure_id: q.o, arrival_id: q.d, outbound_date: q.dep, type: q.ret ? '1' : '2',
    adults: q.adults, children: q.children, infants_on_lap: q.infants, travel_class: q.cabin,
    currency: q.currency, hl: 'zh-TW', gl: 'tw', booking_token: bt
  };
  if (q.ret) params.return_date = q.ret;
  bump_('serpapi');
  var res = UrlFetchApp.fetch('https://serpapi.com/search.json?' + qs_(params), { muteHttpExceptions: true });
  var j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, message: 'serpapi 回應不是 JSON' }; }
  if (j.error) return { ok: false, message: 'serpapi: ' + j.error };
  var opts = (j.booking_options || []).map(function (o) {
    var t = o.together || o.departing || {};
    var br = t.booking_request || {};
    return { bookWith: t.book_with || '', marketedAs: t.marketed_as || [], price: Number(t.price || 0), url: br.url || '', phone: t.booking_phone || t.book_with_phone || '', baggage: t.baggage_prices || [], separate: !o.together, isAirline: !!(t.airline_logos && t.airline_logos.length) };
  });
  return { ok: true, source: 'serpapi', options: opts, quota: providerStatus_(cfg) };
}

// ─────────────────────── TDX 台灣機場即時航班（免費，不計入 SerpApi 額度） ───────────────────────
var TW_AP_ = ['TPE', 'TSA', 'RMQ', 'KHH', 'TNN', 'HUN', 'TTT', 'MZG', 'KNH', 'MFK', 'CYI', 'PIF', 'LZN', 'KYD', 'GNI', 'WOT', 'CMJ'];
function tdxToken_(cfg) {
  if (!cfg.tdx.id || !cfg.tdx.secret) return null;
  var cache = CacheService.getScriptCache(), hit = cache.get('tdx_token');
  if (hit) return hit;
  var res = UrlFetchApp.fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: cfg.tdx.id, client_secret: cfg.tdx.secret }
  });
  if (res.getResponseCode() !== 200) throw new Error('TDX 取得 token 失敗 HTTP ' + res.getResponseCode());
  var j = JSON.parse(res.getContentText());
  var ttl = Math.max(60, Math.min(21600, Number(j.expires_in || 3600) - 300));
  cache.put('tdx_token', j.access_token, ttl);
  return j.access_token;
}
function fids_(ap, dir, cfg) {
  ap = String(ap || '').toUpperCase(); dir = dir === 'arr' ? 'arr' : 'dep';
  if (TW_AP_.indexOf(ap) < 0) return { ok: false, error: 'BAD_REQUEST', message: 'TDX 僅支援台灣機場' };
  if (!cfg.tdx.id || !cfg.tdx.secret) return { ok: false, error: 'CONFIG', message: 'GAS 尚未設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET' };
  var cache = CacheService.getScriptCache(), key = 'fids_' + ap + '_' + dir, hit = cache.get(key);
  if (hit) { try { var c = JSON.parse(hit); c.cached = true; return c; } catch (e) {} }
  var token = tdxToken_(cfg);
  var url = 'https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/' + (dir === 'arr' ? 'Arrival' : 'Departure') + '/' + ap + '?%24format=JSON&%24top=300';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, 'Accept-Encoding': 'gzip' } });
  if (res.getResponseCode() === 401) { CacheService.getScriptCache().remove('tdx_token'); return { ok: false, message: 'TDX 授權失效，請再試一次' }; }
  if (res.getResponseCode() !== 200) return { ok: false, message: 'TDX HTTP ' + res.getResponseCode() };
  var arr = [];
  try { arr = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, message: 'TDX 回應不是 JSON' }; }
  if (!Array.isArray(arr)) arr = arr.value || arr.data || [];
  var rows = arr.filter(function (x) { return !x.IsCargo; }).map(function (x) {
    var sched = dir === 'arr' ? x.ScheduleArrivalTime : x.ScheduleDepartureTime;
    var est = dir === 'arr' ? x.EstimatedArrivalTime : x.EstimatedDepartureTime;
    var act = dir === 'arr' ? x.ActualArrivalTime : x.ActualDepartureTime;
    var remark = dir === 'arr' ? x.ArrivalRemark : x.DepartureRemark;
    var al = String(x.AirlineID || ''), fn = String(x.FlightNumber || '');
    return { flightNo: (al + ' ' + fn).trim(), airline: al, from: x.DepartureAirportID || '', to: x.ArrivalAirportID || '', sched: sched || '', est: est || '', actual: act || '', remark: remark || '', gate: x.Gate || '', terminal: x.Terminal || '', date: x.FlightDate || '', updated: x.UpdateTime || '' };
  });
  rows.sort(function (a, b) { return (a.sched || '').localeCompare(b.sched || ''); });
  var r = { ok: true, airport: ap, dir: dir, fetchedAt: new Date().toISOString(), rows: rows };
  try { var s = JSON.stringify(r); if (s.length < 30000) cache.put(key, s, 120); } catch (e) {}
  return r;
}

// ─────────────────────── 工具 ───────────────────────
function qs_(o) {
  return Object.keys(o).filter(function (k) { return o[k] !== undefined && o[k] !== null && o[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
}
// 編輯器手動執行：測試單程
function TEST_search() {
  var dep = Utilities.formatDate(new Date(Date.now() + 30 * 864e5), 'Asia/Taipei', 'yyyy-MM-dd');
  var r = search_({ o: 'TPE', d: 'NRT', dep: dep, ret: null, adults: 1, cabin: 1, currency: 'TWD' }, CFG_());
  Logger.log(JSON.stringify(r).slice(0, 3000));
}
// 編輯器手動執行：測試來回兩步驟（會用 2 次額度）
function TEST_roundtrip() {
  var cfg = CFG_(), dep = Utilities.formatDate(new Date(Date.now() + 30 * 864e5), 'Asia/Taipei', 'yyyy-MM-dd'), ret = Utilities.formatDate(new Date(Date.now() + 35 * 864e5), 'Asia/Taipei', 'yyyy-MM-dd');
  var q = { o: 'TPE', d: 'NRT', dep: dep, ret: ret, adults: 1, cabin: 1, currency: 'TWD' };
  var a = search_(q, cfg); Logger.log('去程 ' + (a.flights || []).length + ' 筆, leg=' + a.leg);
  if (a.ok && a.flights[0].departureToken) { var b = returns_(q, a.flights[0].departureToken, cfg); Logger.log('回程 ' + (b.flights || []).length + ' 筆, 有 bookingToken=' + !!(b.flights && b.flights[0].bookingToken)); }
}

// 編輯器手動執行：部署前自我檢查（不扣查詢額度）
function TEST_selfcheck() {
  var cfg = CFG_(), out = [];
  out.push('APP_TOKEN: ' + (cfg.token ? '已設定（' + cfg.token.length + ' 字）' : '❌ 未設定'));
  out.push('SERPAPI_KEY: ' + (cfg.serpapi.key ? '已設定' : '❌ 未設定'));
  var acc = serpapiAccount_(cfg);
  if (acc) out.push('SerpApi 帳戶: ' + (acc.valid ? '✅ 有效，本月剩餘 ' + acc.left + ' 次（方案 ' + acc.plan + '）' : '❌ ' + acc.error));
  out.push('HASDATA_KEY: ' + (cfg.hasdata.key ? '已設定（實驗性）' : '未設定（可略）'));
  out.push('HOMEPC_URL: ' + (cfg.homepc.url || '未設定（可略）'));
  out.push('TDX: ' + (cfg.tdx.id && cfg.tdx.secret ? '已設定（台灣機場即時航班可用）' : '未設定（可略；緊急頁改用連結）'));
  out.push('來源順序: ' + cfg.order.join(' → ') + '　伺服器快取 ' + cfg.cacheMin + ' 分　deep_search ' + (cfg.deep ? '開' : '關'));
  Logger.log(out.join('\n'));
}

// 編輯器手動執行：測試 TDX 桃園機場出境（不扣 SerpApi 額度）
function TEST_tdx() {
  var r = fids_('TPE', 'dep', CFG_());
  Logger.log(r.ok ? ('✅ ' + r.rows.length + ' 筆，第一筆：' + JSON.stringify(r.rows[0])) : ('❌ ' + r.message));
}
