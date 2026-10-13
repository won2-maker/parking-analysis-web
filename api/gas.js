/**
 * api/gas.js — BQ + Kakao + Sheets direct router (replaces GAS proxy)
 */

const PROJECT = 'moduparking';
const BQ_LOC = 'asia-northeast3';
const KAKAO_KEY = process.env.KAKAO_KEY || '4cd2110ba8cbb8cc0d260725460ec9f6';
const SHEET_ID = '1fx7OvuBr-TE4CuuF-bYkFrPFhgcSAtOAc_vnjkTRF_k';
const SOLDOUT_SHEET_ID = '1M-xkj0gUIQZGskQxCBznUSdrofb-2q8tAfC4qs9nNlc';
const SOLDOUT_SHEET_GID = 1648275154;
const PERF_SHEET_ID = '1OuvWGVIQBw1kqQCU5LqAYbSHpMwoRQUCyEuQVbjyM_c';

// BQ token cache (warm between invocations on same instance)
let _bqTok = null, _bqExp = 0;

// Sheets token cache (server-side, spreadsheets scope)
let _shTok = null, _shExp = 0;

async function getSheetsToken() {
  if (_shTok && Date.now() < _shExp) return _shTok;
  var rt = process.env.SHEETS_REFRESH_TOKEN;
  if (!rt) return null;
  try {
    var r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.BQ_CLIENT_ID,
        client_secret: process.env.BQ_CLIENT_SECRET,
        refresh_token: rt
      })
    });
    var d = await r.json();
    if (!d.access_token) return null;
    _shTok = d.access_token;
    _shExp = Date.now() + ((d.expires_in || 3600) - 60) * 1000;
    return _shTok;
  } catch (e) { return null; }
}

async function getBqToken() {
  if (_bqTok && Date.now() < _bqExp) return _bqTok;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.BQ_CLIENT_ID,
      client_secret: process.env.BQ_CLIENT_SECRET,
      refresh_token: process.env.BQ_REFRESH_TOKEN
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('BQ token refresh failed: ' + JSON.stringify(d));
  _bqTok = d.access_token;
  _bqExp = Date.now() + ((d.expires_in || 3600) - 60) * 1000;
  return _bqTok;
}

async function runBQ(sql, tms) {
  tms = tms || 30000;
  const tok = await getBqToken();
  const r = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: tms, maxResults: 5000, location: BQ_LOC })
    }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  if (d.jobComplete) return parseRows(d.schema ? d.schema.fields : [], d.rows || []);
  const jobId = d.jobReference && d.jobReference.jobId;
  if (!jobId) throw new Error('No jobId returned from BQ');
  for (var i = 0; i < 20; i++) {
    await sleep(2000);
    const pr = await fetch(
      'https://bigquery.googleapis.com/bigquery/v2/projects/' + PROJECT + '/queries/' + jobId + '?timeoutMs=5000&maxResults=5000&location=' + BQ_LOC,
      { headers: { Authorization: 'Bearer ' + tok } }
    );
    const pd = await pr.json();
    if (pd.jobComplete) return parseRows(pd.schema ? pd.schema.fields : [], pd.rows || []);
  }
  throw new Error('BQ query timeout after polling');
}

function parseRows(fields, rawRows) {
  if (!rawRows || !fields) return [];
  return rawRows.map(function(row) {
    var obj = {};
    (row.f || []).forEach(function(cell, i) { obj[fields[i] ? fields[i].name : i] = cell.v; });
    return obj;
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function geocodeKakao(address) {
  var h = { Authorization: 'KakaoAK ' + KAKAO_KEY };
  var r1 = await fetch('https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(address), { headers: h });
  var d1 = await r1.json();
  if (d1.documents && d1.documents.length) return { lat: parseFloat(d1.documents[0].y), lng: parseFloat(d1.documents[0].x) };
  var r2 = await fetch('https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(address), { headers: h });
  var d2 = await r2.json();
  if (d2.documents && d2.documents.length) return { lat: parseFloat(d2.documents[0].y), lng: parseFloat(d2.documents[0].x) };
  return null;
}

var SH_HEADERS = { 'x-goog-user-project': 'moduparking' };

async function sheetsRead(sheetId, range, tok) {
  if (!tok) return null;
  var r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range), { headers: Object.assign({ Authorization: 'Bearer ' + tok }, SH_HEADERS) });
  var d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.values || [];
}

async function sheetsAppend(sheetId, range, values, tok) {
  if (!tok) return null;
  var r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    headers: Object.assign({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, SH_HEADERS),
    body: JSON.stringify({ values: values })
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

async function sheetsUpdateCell(sheetId, range, values, tok) {
  if (!tok) return null;
  var r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED', {
    method: 'PUT',
    headers: Object.assign({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, SH_HEADERS),
    body: JSON.stringify({ values: values })
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

// ── Main handler ──
module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-GToken, Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var p = {};
  try {
    var parsed = new URL(req.url, 'http://localhost');
    parsed.searchParams.forEach(function(v, k) { p[k] = v; });
  } catch (e) {
    var qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    qs.split('&').forEach(function(kv) {
      var eq = kv.indexOf('=');
      if (eq < 0) return;
      try { p[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, ' ')); }
      catch (de) { p[kv.slice(0, eq)] = kv.slice(eq + 1); }
    });
  }

  var action = p.action || '';
  var gToken = req.headers['x-gtoken'] || null;
  var result;

  try {
    switch (action) {
      case 'geocodeForWeb': result = await h_geocodeForWeb(p); break;
      case 'webAnalyzeFull': result = await h_webAnalyzeFull(p); break;
      case 'webGetPartnerList': result = await h_webGetPartnerList(); break;
      case 'webGetPartnerStats': result = await h_webGetPartnerStats(p); break;
      case 'webGetDailyStats': result = await h_webGetDailyStats(p); break;
      case 'webGetPartnerInsights': result = await h_webGetPartnerInsights(); break;
      case 'webGetPartnerRevForRange': result = await h_webGetPartnerRevForRange(p); break;
      case 'webGetFollowUpLots': result = await h_webGetFollowUpLots(); break;
      case 'webGetCouponEffectAnalysis': result = await h_webGetCouponEffectAnalysis(p); break;
      case 'webGetEarlySoldoutAlert': result = await h_webGetEarlySoldoutAlert(); break;
      case 'webGetSoldoutTimes': result = await h_webGetSoldoutTimes(p); break;
      case 'webGetSalesComparison': result = await h_webGetSalesComparison(p); break;
      case 'webLoadTickets': result = await h_webLoadTickets(p); break;
      case 'webLoadAptList': result = await h_webLoadAptList(p, gToken); break;
      case 'webLoadRanking': result = await h_webLoadRanking(p, gToken); break;
      case 'webBatchAnalyze': result = { error: '배치 분석은 현재 웹에서 지원되지 않습니다', results: [], processed: 0, total: 0, remaining: 0, done: true }; break;
      case 'webGetSalesLots': result = await h_webGetSalesLots(gToken); break;
      case 'webSetSalesLot': result = await h_webSetSalesLot(p, gToken); break;
      case 'webUpdateSalesperson': result = await h_webUpdateSalesperson(p, gToken); break;
      case 'webLoadAptPerfData': result = await h_webLoadAptPerfData(gToken); break;
      case 'webGetSheetSoldout': result = await h_webGetSheetSoldout(gToken); break;
      case 'getSearchHistory': result = await h_getSearchHistory(gToken); break;
      case 'saveSearchHistory': result = await h_saveSearchHistory(p, gToken); break;
      default: result = { error: 'unknown action: ' + action };
    }
  } catch (e) {
    result = { error: e.message };
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};

module.exports.config = { maxDuration: 60 };

// ── BQ Handlers ──

async function h_geocodeForWeb(p) {
  var coord = await geocodeKakao(p.address || '');
  if (!coord) return { error: '주소를 찾을 수 없습니다' };
  return { lat: coord.lat, lng: coord.lng, name: p.address };
}

async function h_webAnalyzeFull(p) {
  var lat = parseFloat(p.lat), lng = parseFloat(p.lng), radius = parseInt(p.radius) || 500;
  if (!lat || !lng) return { error: '좌표가 없습니다' };

  var mainSQL =
    'WITH nearby AS (' +
    '  SELECT p.parkinglotSeq AS id, p.parkinglotName AS name, p.numberOfParkingspace AS spots,' +
    '  p.refined_addr AS addr, p.companyName AS company, p.refined_lat AS lat, p.refined_lng AS lng,' +
    '  ROUND(ST_DISTANCE(ST_GEOGPOINT(p.refined_lng,p.refined_lat),ST_GEOGPOINT(' + lng + ',' + lat + '))) AS dist' +
    '  FROM `moduparking.ParkingData.parkinglot_info` p' +
    '  WHERE p.refined_lat IS NOT NULL AND p.refined_lng IS NOT NULL AND p.pklCategory="제휴"' +
    '  AND ST_DISTANCE(ST_GEOGPOINT(p.refined_lng,p.refined_lat),ST_GEOGPOINT(' + lng + ',' + lat + '))<=' + radius +
    ')' +
    ' SELECT n.*,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 MONTH) AND pay.bm LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS mr1,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 MONTH) AND pay.bm LIKE "%정기%" THEN 1 ELSE 0 END) AS mc1,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 MONTH) AND pay.bm NOT LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS or1,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 MONTH) AND pay.bm NOT LIKE "%정기%" THEN 1 ELSE 0 END) AS oc1,' +
    ' COUNT(DISTINCT CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 MONTH) THEN pay.userSeq END) AS u1,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 6 MONTH) AND pay.bm LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS mr6,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 6 MONTH) AND pay.bm LIKE "%정기%" THEN 1 ELSE 0 END) AS mc6,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 6 MONTH) AND pay.bm NOT LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS or6,' +
    ' SUM(CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 6 MONTH) AND pay.bm NOT LIKE "%정기%" THEN 1 ELSE 0 END) AS oc6,' +
    ' COUNT(DISTINCT CASE WHEN pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 6 MONTH) THEN pay.userSeq END) AS u6,' +
    ' SUM(CASE WHEN pay.bm LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS mr12,' +
    ' SUM(CASE WHEN pay.bm LIKE "%정기%" THEN 1 ELSE 0 END) AS mc12,' +
    ' SUM(CASE WHEN pay.bm NOT LIKE "%정기%" THEN pay.paymentAmount ELSE 0 END) AS or12,' +
    ' SUM(CASE WHEN pay.bm NOT LIKE "%정기%" THEN 1 ELSE 0 END) AS oc12,' +
    ' COUNT(DISTINCT pay.userSeq) AS u12' +
    ' FROM nearby n LEFT JOIN `moduparking.ParkingData.payment` pay' +
    ' ON n.id=pay.parkinglotSeq AND pay.paymentDate>=DATE_SUB(CURRENT_DATE(),INTERVAL 1 YEAR) AND pay.paymentStatus=2' +
    ' GROUP BY 1,2,3,4,5,6,7,8 ORDER BY dist';

  var mainRows = await runBQ(mainSQL, 30000);
  if (!mainRows.length) return { error: '반경 ' + radius + 'm 내 제휴주차장 없음' };

  var SPACE_OV = { '265818': 55 };
  var NUM_F = ['dist','spots','lat','lng','mr1','mc1','or1','oc1','u1','mr6','mc6','or6','oc6','u6','mr12','mc12','or12','oc12','u12'];
  var lots = [], lotSeqs = [];
  mainRows.forEach(function(r) {
    var obj = {};
    Object.keys(r).forEach(function(k) { obj[k] = NUM_F.indexOf(k) >= 0 ? (Number(r[k]) || 0) : (r[k] || ''); });
    if (SPACE_OV[String(obj.id)] && !obj.spots) obj.spots = SPACE_OV[String(obj.id)];
    lots.push(obj);
    lotSeqs.push(r.id);
  });
  var seqStr = lotSeqs.join(',');

  var revSQL =
    "WITH raw AS (" +
    "  SELECT p.parkinglotSeq, p.parkinglotName, p.couponName, p.userSeq, p.paymentAmount, p.paymentDate, p.bm," +
    "  CASE WHEN EXTRACT(DAYOFWEEK FROM p.paymentDate) IN (1,7)" +
    "    OR DATE(p.paymentDate) IN ('2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-01','2026-03-02','2026-05-05','2026-05-24','2026-05-25','2026-06-03','2026-06-06','2026-08-15','2026-08-17','2026-09-24','2026-09-25','2026-09-26','2026-10-03','2026-10-05','2026-10-09','2026-12-25')" +
    "  THEN '휴일' ELSE '평일' END AS day_type" +
    "  FROM `moduparking.ParkingData.payment` p" +
    "  WHERE p.paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH)" +
    "  AND p.paymentStatus = 2 AND p.parkinglotSeq IN (" + seqStr + ")" +
    ")," +
    "sales AS (" +
    "  SELECT parkinglotSeq, parkinglotName, couponName, day_type," +
    "  COUNT(*) AS ticket_cnt, SUM(paymentAmount) AS revenue, ROUND(AVG(paymentAmount)) AS avg_price" +
    "  FROM raw GROUP BY 1,2,3,4" +
    ")," +
    "limits AS (" +
    "  SELECT parkinglotSeq, ticketName AS couponName, MAX(ticketLimit) AS ticket_limit" +
    "  FROM `moduparking.ParkingData.tblSoldout`" +
    "  WHERE parkinglotSeq IN (" + seqStr + ") AND ticketLimit > 0" +
    "  GROUP BY 1,2" +
    ")" +
    " SELECT s.parkinglotName AS lot_name, s.couponName, s.day_type, s.ticket_cnt, s.revenue, s.avg_price," +
    " IFNULL(l.ticket_limit, 0) AS ticket_limit" +
    " FROM sales s LEFT JOIN limits l ON s.parkinglotSeq = l.parkinglotSeq AND s.couponName = l.couponName" +
    " ORDER BY s.revenue DESC";

  var trSQL =
    "WITH lot_info AS (" +
    "  SELECT parkinglotSeq AS id, numberOfParkingspace AS spots" +
    "  FROM `moduparking.ParkingData.parkinglot_info`" +
    "  WHERE parkinglotSeq IN (" + seqStr + ")" +
    ")," +
    "sales AS (" +
    "  SELECT p.parkinglotSeq AS id, p.couponName AS ticket, p.bm," +
    "  COUNT(*) AS cnt, SUM(p.paymentAmount) AS rev, ROUND(AVG(p.paymentAmount)) AS price" +
    "  FROM `moduparking.ParkingData.payment` p" +
    "  WHERE p.paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH)" +
    "  AND p.paymentStatus = 2 AND p.parkinglotSeq IN (" + seqStr + ")" +
    "  GROUP BY 1,2,3" +
    ")," +
    "limits AS (" +
    "  SELECT parkinglotSeq AS id, ticketName AS ticket, MAX(ticketLimit) AS lim" +
    "  FROM `moduparking.ParkingData.tblSoldout`" +
    "  WHERE parkinglotSeq IN (" + seqStr + ") AND ticketLimit > 0" +
    "  GROUP BY 1,2" +
    ")," +
    "combined AS (" +
    "  SELECT s.ticket, s.bm, s.cnt, s.rev, s.price, l.spots," +
    "  IFNULL(lm.lim, 0) AS lim," +
    "  CASE WHEN lm.lim > 0 THEN ROUND(s.cnt / lm.lim * 100 / 30, 1) ELSE NULL END AS daily_fill" +
    "  FROM sales s" +
    "  JOIN lot_info l ON s.id = l.id" +
    "  LEFT JOIN limits lm ON s.id = lm.id AND s.ticket = lm.ticket" +
    ")" +
    " SELECT ticket, bm," +
    " ROUND(AVG(price)) AS avg_price," +
    " ROUND(SUM(cnt) / NULLIF(SUM(CASE WHEN spots > 0 THEN spots END), 0), 3) AS cnt_per_space," +
    " ROUND(AVG(CASE WHEN lim > 0 THEN lim END) / NULLIF(AVG(CASE WHEN lim > 0 AND spots > 0 THEN spots END), 0), 3) AS lim_per_space," +
    " ROUND(AVG(daily_fill), 1) AS avg_fill," +
    " SUM(cnt) AS total_cnt, SUM(rev) AS total_rev," +
    " COUNT(DISTINCT ticket) AS variants" +
    " FROM combined GROUP BY ticket, bm ORDER BY total_rev DESC";

  var both = await Promise.all([runBQ(revSQL, 30000), runBQ(trSQL, 30000)]);
  var revenueRows = both[0], trRows = both[1];

  var revenue = revenueRows.map(function(r) {
    return {
      lot_name: r.lot_name || '', couponName: r.couponName, day_type: r.day_type || '평일',
      ticket_cnt: parseInt(r.ticket_cnt), revenue: parseInt(r.revenue),
      avg_price: parseInt(r.avg_price || 0), ticket_limit: parseInt(r.ticket_limit || 0)
    };
  });

  var TR_N = ['avg_price','cnt_per_space','lim_per_space','avg_fill','total_cnt','total_rev','variants'];
  var ticketRatios = trRows.map(function(r) {
    var o = {};
    Object.keys(r).forEach(function(k) { o[k] = TR_N.indexOf(k) >= 0 ? (Number(r[k]) || 0) : (r[k] || ''); });
    return o;
  });

  var knownSpaces = 0, knownRev = 0, unknownLots = [];
  lots.forEach(function(l, i) {
    var rev = (Number(l.mr1) || 0) + (Number(l.or1) || 0);
    if (l.spots > 0) { knownSpaces += l.spots; knownRev += rev; }
    else if (rev > 0) unknownLots.push({ idx: i, rev: rev });
  });
  var revPerSpace = knownSpaces > 0 ? knownRev / knownSpaces : 0;
  var estimatedSpaces = 0;
  unknownLots.forEach(function(u) {
    var est = revPerSpace > 0 ? Math.max(1, Math.round(u.rev / revPerSpace)) : 1;
    lots[u.idx].spots = est;
    lots[u.idx].spotsEstimated = true;
    estimatedSpaces += est;
  });

  return {
    lat: lat, lng: lng, lots: lots, revenue: revenue, ticketRatios: ticketRatios,
    totalSpaces: knownSpaces + estimatedSpaces, knownSpaces: knownSpaces,
    estimatedSpaces: estimatedSpaces, estimatedCount: unknownLots.length
  };
}

async function h_webGetPartnerList() {
  var rows = await runBQ(
    'WITH pay AS (' +
    '  SELECT parkinglotSeq,' +
    '    SUM(paymentAmount) AS rev6m, COUNT(*) AS cnt6m,' +
    '    ROUND(AVG(paymentAmount)) AS avg_price,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) THEN paymentAmount ELSE 0 END) AS rev1w,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS cnt1w,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) THEN paymentAmount ELSE 0 END) AS rev1m,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS cnt1m,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY) THEN paymentAmount ELSE 0 END) AS rev2m,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY) THEN 1 ELSE 0 END) AS cnt2m,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) THEN paymentAmount ELSE 0 END) AS rev3m,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) THEN 1 ELSE 0 END) AS cnt3m,' +
    '    SUM(CASE WHEN paymentDate = CURRENT_DATE() THEN paymentAmount ELSE 0 END) AS rev_d0,' +
    '    SUM(CASE WHEN paymentDate = CURRENT_DATE() THEN 1 ELSE 0 END) AS cnt_d0,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) THEN paymentAmount ELSE 0 END) AS rev_d1,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS cnt_d1,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY) THEN paymentAmount ELSE 0 END) AS rev_d2,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY) THEN 1 ELSE 0 END) AS cnt_d2,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY) THEN paymentAmount ELSE 0 END) AS rev_d3,' +
    '    SUM(CASE WHEN paymentDate = DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY) THEN 1 ELSE 0 END) AS cnt_d3,' +
    '    SUM(CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)' +
    '             AND paymentDate < DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) THEN paymentAmount ELSE 0 END) AS rev_prev30' +
    '  FROM `moduparking.ParkingData.payment`' +
    '  WHERE paymentStatus = 2 AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)' +
    '  GROUP BY parkinglotSeq' +
    ')' +
    ' SELECT i.parkinglotSeq, i.parkinglotName, i.companyName,' +
    '  COALESCE(pay.rev6m,0) AS rev6m, COALESCE(pay.cnt6m,0) AS cnt6m,' +
    '  COALESCE(pay.avg_price,0) AS avg_price,' +
    '  COALESCE(pay.rev1w,0) AS rev1w, COALESCE(pay.cnt1w,0) AS cnt1w,' +
    '  COALESCE(pay.rev1m,0) AS rev1m, COALESCE(pay.cnt1m,0) AS cnt1m,' +
    '  COALESCE(pay.rev2m,0) AS rev2m, COALESCE(pay.cnt2m,0) AS cnt2m,' +
    '  COALESCE(pay.rev3m,0) AS rev3m, COALESCE(pay.cnt3m,0) AS cnt3m,' +
    '  COALESCE(pay.rev_d0,0) AS rev_d0, COALESCE(pay.cnt_d0,0) AS cnt_d0,' +
    '  COALESCE(pay.rev_d1,0) AS rev_d1, COALESCE(pay.cnt_d1,0) AS cnt_d1,' +
    '  COALESCE(pay.rev_d2,0) AS rev_d2, COALESCE(pay.cnt_d2,0) AS cnt_d2,' +
    '  COALESCE(pay.rev_d3,0) AS rev_d3, COALESCE(pay.cnt_d3,0) AS cnt_d3,' +
    '  COALESCE(pay.rev1m,0) AS rev30, COALESCE(pay.rev_prev30,0) AS rev_prev30' +
    ' FROM `moduparking.ParkingData.parkinglot_info` i' +
    ' LEFT JOIN pay ON i.parkinglotSeq = pay.parkinglotSeq' +
    ' WHERE i.pklCategory = "제휴" AND i.parkinglotName IS NOT NULL' +
    ' ORDER BY rev6m DESC, i.parkinglotName'
  );
  return rows.map(function(r) {
    return {
      seq: parseInt(r.parkinglotSeq) || 0, name: r.parkinglotName, company: r.companyName || '',
      rev6m: parseInt(r.rev6m) || 0, cnt6m: parseInt(r.cnt6m) || 0, avg_price: parseInt(r.avg_price) || 0,
      rev1w: parseInt(r.rev1w) || 0, cnt1w: parseInt(r.cnt1w) || 0,
      rev1m: parseInt(r.rev1m) || 0, cnt1m: parseInt(r.cnt1m) || 0,
      rev2m: parseInt(r.rev2m) || 0, cnt2m: parseInt(r.cnt2m) || 0,
      rev3m: parseInt(r.rev3m) || 0, cnt3m: parseInt(r.cnt3m) || 0,
      rev_d0: parseInt(r.rev_d0) || 0, cnt_d0: parseInt(r.cnt_d0) || 0,
      rev_d1: parseInt(r.rev_d1) || 0, cnt_d1: parseInt(r.cnt_d1) || 0,
      rev_d2: parseInt(r.rev_d2) || 0, cnt_d2: parseInt(r.cnt_d2) || 0,
      rev_d3: parseInt(r.rev_d3) || 0, cnt_d3: parseInt(r.cnt_d3) || 0,
      rev30: parseInt(r.rev30) || 0, rev_prev30: parseInt(r.rev_prev30) || 0,
      soldout_days: 0
    };
  });
}

async function h_webGetPartnerStats(p) {
  var seq = parseInt(p.lotSeq);
  if (!seq) return { error: '잘못된 lotSeq' };

  var results = await Promise.all([
    runBQ('SELECT CAST(FLOOR(DATE_DIFF(CURRENT_DATE(), paymentDate, DAY) / 7) AS INT64) AS wk,' +
      '  EXTRACT(DAYOFWEEK FROM paymentDate) AS dn, couponName AS cn,' +
      '  SUM(paymentAmount) AS rev, COUNT(*) AS cnt, ROUND(AVG(paymentAmount)) AS price' +
      ' FROM `moduparking.ParkingData.payment`' +
      ' WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
      ' AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 20 DAY)' +
      ' AND paymentDate <= CURRENT_DATE()' +
      ' GROUP BY 1,2,3 ORDER BY 1,2,3'),
    runBQ('SELECT FORMAT_DATE("%Y-%m", paymentDate) AS ym, COUNT(*) AS cnt, SUM(paymentAmount) AS rev' +
      ' FROM `moduparking.ParkingData.payment`' +
      ' WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
      ' AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 18 MONTH)' +
      ' GROUP BY 1 ORDER BY 1'),
    runBQ('WITH daily AS (' +
      '  SELECT paymentDate, couponName, COUNT(*) AS sold' +
      '  FROM `moduparking.ParkingData.payment`' +
      '  WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
      '  AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)' +
      '  GROUP BY 1,2' +
      '), lims AS (' +
      '  SELECT ticketName, ROUND(AVG(ticketLimit)) AS lim' +
      '  FROM `moduparking.ParkingData.tblSoldout`' +
      '  WHERE parkinglotSeq = ' + seq + ' AND ticketLimit > 0' +
      '  GROUP BY 1' +
      ')' +
      ' SELECT d.paymentDate AS date, d.couponName, CAST(d.sold AS INT64) AS sold,' +
      '  CAST(l.lim AS INT64) AS lim, ROUND(SAFE_DIVIDE(d.sold, l.lim), 3) AS rate' +
      ' FROM daily d JOIN lims l ON d.couponName = l.ticketName' +
      ' WHERE l.lim > 0 ORDER BY d.paymentDate DESC'),
    runBQ('SELECT couponName, SUM(paymentAmount) AS rev, COUNT(*) AS cnt,' +
      '  ROUND(AVG(paymentAmount)) AS avg_price' +
      ' FROM `moduparking.ParkingData.payment`' +
      ' WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
      ' AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)' +
      ' GROUP BY couponName ORDER BY rev DESC')
  ]);

  var limits = {};
  results[2].forEach(function(r) { if (!limits[r.couponName]) limits[r.couponName] = parseInt(r.lim) || 0; });
  return { weekly: results[0], monthly: results[1], limits: limits, tickets: results[3], soldoutRaw: results[2] };
}

async function h_webGetDailyStats(p) {
  var seq = parseInt(p.lotSeq);
  var dateFrom = p.dateFrom, dateTo = p.dateTo;
  if (!seq || !dateFrom || !dateTo) return { error: '파라미터 오류' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return { error: '날짜 형식 오류' };
  var rows = await runBQ(
    'SELECT FORMAT_DATE("%Y-%m-%d", paymentDate) AS date, couponName,' +
    '  SUM(paymentAmount) AS rev, COUNT(*) AS cnt' +
    ' FROM `moduparking.ParkingData.payment`' +
    ' WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
    " AND paymentDate BETWEEN '" + dateFrom + "' AND '" + dateTo + "'" +
    ' GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC'
  );
  return { rows: rows };
}

async function h_webGetPartnerInsights() {
  var rows = await runBQ(
    'WITH d AS (' +
    '  SELECT parkinglotSeq, paymentDate, couponName, COUNT(*) AS day_sold' +
    '  FROM `moduparking.ParkingData.payment`' +
    '  WHERE paymentStatus = 2 AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)' +
    '  GROUP BY 1,2,3' +
    '), l AS (' +
    '  SELECT parkinglotSeq, ticketName, ROUND(AVG(ticketLimit)) AS avg_lim' +
    '  FROM `moduparking.ParkingData.tblSoldout`' +
    '  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) AND ticketLimit > 0' +
    '  GROUP BY 1,2' +
    ')' +
    ' SELECT d.parkinglotSeq, COUNT(DISTINCT d.paymentDate) AS soldout_days' +
    ' FROM d JOIN l ON d.parkinglotSeq = l.parkinglotSeq AND d.couponName = l.ticketName' +
    ' WHERE d.day_sold >= l.avg_lim' +
    ' GROUP BY 1'
  );
  return rows.map(function(r) { return { seq: parseInt(r.parkinglotSeq) || 0, soldout_days: parseInt(r.soldout_days) || 0 }; });
}

async function h_webGetPartnerRevForRange(p) {
  var startDate = p.dateFrom, endDate = p.dateTo;
  var rows = await runBQ(
    'SELECT p.parkinglotSeq AS seq,' +
    '  CAST(SUM(p.paymentAmount) AS INT64) AS rev, COUNT(*) AS cnt' +
    ' FROM `moduparking.ParkingData.payment` p' +
    ' JOIN `moduparking.ParkingData.parkinglot_info` i ON p.parkinglotSeq = i.parkinglotSeq' +
    ' WHERE p.paymentStatus = 2 AND i.pklCategory = "제휴"' +
    '   AND DATE(p.paymentDate) >= "' + startDate + '"' +
    '   AND DATE(p.paymentDate) <= "' + endDate + '"' +
    ' GROUP BY 1'
  );
  return rows.map(function(r) { return { seq: parseInt(r.seq) || 0, rev: parseInt(r.rev) || 0, cnt: parseInt(r.cnt) || 0 }; });
}

async function h_webGetFollowUpLots() {
  var rows = await runBQ(
    'WITH base AS (' +
    '  SELECT p.parkinglotSeq AS seq, p.couponName,' +
    '    DATE(p.paymentDate) AS d, p.paymentAmount AS amt' +
    '  FROM `moduparking.ParkingData.payment` p' +
    '  JOIN `moduparking.ParkingData.parkinglot_info` i ON p.parkinglotSeq = i.parkinglotSeq' +
    '  WHERE p.paymentStatus = 2 AND i.pklCategory = "제휴"' +
    '    AND p.paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY)' +
    '),' +
    'coupon_first AS (' +
    '  SELECT seq, couponName, MIN(d) AS first_seen FROM base GROUP BY 1, 2' +
    '),' +
    'coupon_old AS (' +
    '  SELECT DISTINCT seq, couponName FROM base' +
    '  WHERE d < DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)' +
    '),' +
    'new_coupons AS (' +
    '  SELECT cf.seq, cf.couponName, cf.first_seen AS change_date' +
    '  FROM coupon_first cf' +
    '  LEFT JOIN coupon_old co ON cf.seq = co.seq AND cf.couponName = co.couponName' +
    '  WHERE cf.first_seen >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) AND co.seq IS NULL' +
    '),' +
    'lot_rev AS (' +
    '  SELECT seq,' +
    '    ROUND(SUM(CASE WHEN d >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) THEN amt ELSE 0 END)) AS rev_m1,' +
    '    ROUND(SUM(CASE WHEN d >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY) AND d < DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) THEN amt ELSE 0 END)) AS rev_m2,' +
    '    ROUND(SUM(CASE WHEN d >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) AND d < DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY) THEN amt ELSE 0 END)) AS rev_m3' +
    '  FROM base GROUP BY 1' +
    '),' +
    'coupon_stats AS (' +
    '  SELECT b.seq, b.couponName, COUNT(*) AS cnt, ROUND(AVG(b.amt)) AS avg_price' +
    '  FROM base b' +
    '  JOIN new_coupons nc ON b.seq = nc.seq AND b.couponName = nc.couponName' +
    '  GROUP BY 1, 2' +
    ')' +
    ' SELECT nc.seq, i.parkinglotName AS name, i.companyName AS company,' +
    '  nc.couponName, "new" AS change_type,' +
    '  FORMAT_DATE("%Y-%m-%d", nc.change_date) AS change_date,' +
    '  DATE_DIFF(CURRENT_DATE(), nc.change_date, DAY) AS days_since,' +
    '  CAST(COALESCE(cs.avg_price, 0) AS INT64) AS recent_price,' +
    '  CAST(COALESCE(cs.cnt, 0) AS INT64) AS recent_cnt,' +
    '  CAST(COALESCE(lr.rev_m1, 0) AS INT64) AS rev_m1,' +
    '  CAST(COALESCE(lr.rev_m2, 0) AS INT64) AS rev_m2,' +
    '  CAST(COALESCE(lr.rev_m3, 0) AS INT64) AS rev_m3' +
    ' FROM new_coupons nc' +
    ' JOIN `moduparking.ParkingData.parkinglot_info` i ON nc.seq = i.parkinglotSeq' +
    ' LEFT JOIN lot_rev lr ON nc.seq = lr.seq' +
    ' LEFT JOIN coupon_stats cs ON nc.seq = cs.seq AND nc.couponName = cs.couponName' +
    ' ORDER BY nc.change_date DESC, i.parkinglotName'
  );
  return {
    rows: rows.map(function(r) {
      return {
        seq: parseInt(r.seq) || 0, name: r.name, company: r.company || '',
        couponName: r.couponName, change_type: r.change_type, change_date: r.change_date,
        days_since: parseInt(r.days_since) || 0, recent_price: parseInt(r.recent_price) || 0,
        recent_cnt: parseInt(r.recent_cnt) || 0, rev_m1: parseInt(r.rev_m1) || 0,
        rev_m2: parseInt(r.rev_m2) || 0, rev_m3: parseInt(r.rev_m3) || 0
      };
    })
  };
}

async function h_webGetCouponEffectAnalysis(p) {
  var seq = parseInt(p.lotSeq);
  if (!seq) return { changes: [] };
  var changeRows = await runBQ(
    'WITH daily AS (' +
    '  SELECT historyDate, couponName,' +
    '    MAX(couponQuantity) AS qty, MAX(couponPrice) AS price, MAX(ifSalesOn) AS salesOn' +
    '  FROM `moduparking.ParkingData_History.tblCouponHistory`' +
    '  WHERE parkinglotSeq = ' + seq +
    '  AND historyDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)' +
    '  GROUP BY 1, 2' +
    '), prev AS (' +
    '  SELECT historyDate, couponName, qty, price, salesOn,' +
    '    LAG(qty) OVER (PARTITION BY couponName ORDER BY historyDate) AS prev_qty,' +
    '    LAG(price) OVER (PARTITION BY couponName ORDER BY historyDate) AS prev_price,' +
    '    LAG(salesOn) OVER (PARTITION BY couponName ORDER BY historyDate) AS prev_salesOn' +
    '  FROM daily' +
    ')' +
    ' SELECT historyDate, couponName,' +
    '  CAST(qty AS INT64) AS qty, CAST(price AS INT64) AS price, salesOn,' +
    '  CAST(prev_qty AS INT64) AS prev_qty, CAST(prev_price AS INT64) AS prev_price, prev_salesOn' +
    ' FROM prev' +
    ' WHERE prev_salesOn IS NOT NULL' +
    '   AND (qty!=prev_qty OR price!=prev_price OR salesOn!=prev_salesOn)' +
    ' ORDER BY historyDate DESC LIMIT 20'
  );
  if (!changeRows.length) return { changes: [] };

  var dateSet = {};
  changeRows.forEach(function(r) { dateSet[r.historyDate] = true; });
  var dates = Object.keys(dateSet).sort();
  var minDate = dates[0], maxDate = dates[dates.length - 1];
  var dateList = dates.map(function(d) { return '"' + d + '"'; }).join(',');

  var revRows = await runBQ(
    'WITH pay AS (' +
    '  SELECT paymentDate, paymentAmount FROM `moduparking.ParkingData.payment`' +
    '  WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
    '  AND paymentDate >= DATE_SUB(DATE("' + minDate + '"), INTERVAL 30 DAY)' +
    '  AND paymentDate < DATE_ADD(DATE("' + maxDate + '"), INTERVAL 30 DAY)' +
    '),cd AS (SELECT d FROM UNNEST([' + dateList + ']) AS d)' +
    ' SELECT cd.d AS change_date,' +
    '  CASE WHEN p.paymentDate >= DATE(cd.d) THEN "after" ELSE "before" END AS period,' +
    '  SUM(p.paymentAmount) AS rev, COUNT(*) AS cnt' +
    ' FROM cd CROSS JOIN pay p' +
    ' WHERE p.paymentDate >= DATE_SUB(DATE(cd.d), INTERVAL 30 DAY)' +
    '   AND p.paymentDate < DATE_ADD(DATE(cd.d), INTERVAL 30 DAY)' +
    ' GROUP BY 1, 2'
  );

  var revMap = {};
  revRows.forEach(function(r) {
    if (!revMap[r.change_date]) revMap[r.change_date] = { before: { rev: 0, cnt: 0 }, after: { rev: 0, cnt: 0 } };
    revMap[r.change_date][r.period] = { rev: parseInt(r.rev) || 0, cnt: parseInt(r.cnt) || 0 };
  });

  var changes = [];
  changeRows.forEach(function(r) {
    var types = [];
    if (r.salesOn !== r.prev_salesOn) types.push(r.salesOn === '판매중' ? '신규' : '판매중단');
    if (r.price !== r.prev_price) types.push('단가 ' + (parseInt(r.prev_price) || 0) + '→' + (parseInt(r.price) || 0) + '원');
    if (r.qty !== r.prev_qty) types.push('한도 ' + (parseInt(r.prev_qty) || 0) + '→' + (parseInt(r.qty) || 0) + '매');
    if (!types.length) return;
    var rv = revMap[r.historyDate] || { before: { rev: 0, cnt: 0 }, after: { rev: 0, cnt: 0 } };
    changes.push({
      date: r.historyDate, coupon: r.couponName, types: types,
      beforeRev: rv.before.rev, beforeCnt: rv.before.cnt,
      afterRev: rv.after.rev, afterCnt: rv.after.cnt,
      revDelta: rv.before.rev > 0 ? Math.round((rv.after.rev - rv.before.rev) / rv.before.rev * 100) : null,
      cntDelta: rv.before.cnt > 0 ? Math.round((rv.after.cnt - rv.before.cnt) / rv.before.cnt * 100) : null
    });
  });
  return { changes: changes };
}

async function h_webGetEarlySoldoutAlert() {
  var rows = await runBQ(
    'WITH ranked AS (' +
    '  SELECT parkinglotSeq, parkinglotName, paymentDate, paymentAt, couponName, hour, couponLimit,' +
    '    EXTRACT(DAYOFWEEK FROM paymentDate) AS dow,' +
    '    ROW_NUMBER() OVER (PARTITION BY parkinglotSeq, paymentDate, couponName ORDER BY paymentAt) AS rn' +
    '  FROM `moduparking.ParkingData.payment`' +
    '  WHERE paymentStatus = 2' +
    '  AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)' +
    '  AND couponLimit > 0' +
    '), info AS (' +
    '  SELECT parkinglotSeq FROM `moduparking.ParkingData.parkinglot_info` WHERE pklCategory = "제휴"' +
    ')' +
    ' SELECT r.parkinglotSeq, r.parkinglotName, r.couponName, r.paymentDate,' +
    '  FORMAT_DATETIME("%H:%M", r.paymentAt) AS soldout_time, r.hour AS soldout_hour, r.dow' +
    ' FROM ranked r JOIN info i ON r.parkinglotSeq = i.parkinglotSeq' +
    ' WHERE r.rn = r.couponLimit' +
    '   AND ((r.dow BETWEEN 2 AND 6 AND r.hour < 8) OR ((r.dow = 1 OR r.dow = 7) AND r.hour < 12))' +
    ' ORDER BY r.paymentDate DESC, r.parkinglotName'
  );
  return rows.map(function(r) {
    return {
      seq: parseInt(r.parkinglotSeq) || 0, name: r.parkinglotName, coupon: r.couponName,
      date: r.paymentDate, time: r.soldout_time, hour: parseInt(r.soldout_hour) || 0,
      dow: parseInt(r.dow) || 0, isWeekend: parseInt(r.dow) === 1 || parseInt(r.dow) === 7
    };
  });
}

async function h_webGetSoldoutTimes(p) {
  var seq = parseInt(p.lotSeq);
  if (!seq) return [];
  var rows = await runBQ(
    'WITH ranked AS (' +
    '  SELECT paymentDate, paymentAt, couponName, hour, couponLimit,' +
    '    ROW_NUMBER() OVER (PARTITION BY paymentDate, couponName ORDER BY paymentAt) AS rn' +
    '  FROM `moduparking.ParkingData.payment`' +
    '  WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
    '  AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)' +
    '  AND couponLimit > 0' +
    ')' +
    ' SELECT paymentDate, couponName, couponLimit AS lim,' +
    '  FORMAT_DATETIME("%H:%M", paymentAt) AS soldout_time, hour AS soldout_hour,' +
    '  EXTRACT(DAYOFWEEK FROM paymentDate) AS dow' +
    ' FROM ranked WHERE rn = couponLimit' +
    ' ORDER BY paymentDate DESC, couponName'
  );
  return rows.map(function(r) {
    var h = parseInt(r.soldout_hour) || 0, dow = parseInt(r.dow) || 0;
    var isWeekend = dow === 1 || dow === 7;
    return { date: r.paymentDate, coupon: r.couponName, lim: parseInt(r.lim) || 0,
      time: r.soldout_time, hour: h, dow: dow, isWeekend: isWeekend, earlyAlert: isWeekend ? h < 12 : h < 8 };
  });
}

async function h_webGetSalesComparison(p) {
  var seq = parseInt(p.lotSeq);
  if (!seq) return { rows: [] };
  var rows = await runBQ(
    'SELECT' +
    '  CASE WHEN paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 21 DAY) THEN "after" ELSE "before" END AS period,' +
    '  couponName, COUNT(*) AS cnt, ROUND(AVG(paymentAmount)) AS avg_price, SUM(paymentAmount) AS rev' +
    ' FROM `moduparking.ParkingData.payment`' +
    ' WHERE paymentStatus = 2 AND parkinglotSeq = ' + seq +
    ' AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 42 DAY)' +
    ' AND paymentDate <= CURRENT_DATE()' +
    ' GROUP BY 1, 2 ORDER BY 1 DESC, 5 DESC'
  );
  return { rows: rows };
}

async function h_webLoadTickets(p) {
  var pklId = parseInt(p.pklId);
  var period = p.period || '1m';
  var interval = period === '6m' ? '6 MONTH' : period === '1y' ? '1 YEAR' : '1 MONTH';
  var both = await Promise.all([
    runBQ('SELECT couponName AS ticket, bm, COUNT(*) AS cnt, SUM(paymentAmount) AS rev,' +
      '  ROUND(AVG(paymentAmount)) AS price' +
      ' FROM `moduparking.ParkingData.payment`' +
      ' WHERE parkinglotSeq = ' + pklId +
      ' AND paymentDate >= DATE_SUB(CURRENT_DATE(), INTERVAL ' + interval + ')' +
      ' AND paymentStatus = 2' +
      ' GROUP BY 1,2 ORDER BY rev DESC'),
    runBQ('SELECT ticketName AS ticket, MAX(ticketLimit) AS lim' +
      ' FROM `moduparking.ParkingData.tblSoldout`' +
      ' WHERE parkinglotSeq = ' + pklId + ' AND ticketLimit > 0 GROUP BY 1')
  ]);
  var limMap = {};
  both[1].forEach(function(r) { limMap[String(r.ticket || '')] = parseInt(r.lim) || 0; });
  return both[0].map(function(r) {
    var t = String(r.ticket || '');
    return { ticket: t, bm: String(r.bm || ''), cnt: parseInt(r.cnt) || 0,
      rev: parseInt(r.rev) || 0, price: parseInt(r.price) || 0,
      lim: limMap[t] || 0, so_rate: 0 };
  });
}

// ── Sheets Handlers (use user's X-GToken) ──

async function h_webLoadAptList(p, gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return [];
  var typeFilter = p.typeFilter || '전체';
  var sheetDefs = [
    { name: '임대아파트 list 서울', region: '서울', type: '아파트' },
    { name: '임대아파트 list 경기', region: '경기', type: '아파트' },
    { name: '부설주차장_교회_서울', region: '서울', type: '교회' },
    { name: '부설주차장_교회_경기', region: '경기', type: '교회' },
    { name: '부설주차장_기타_서울', region: '서울', type: '기타' },
    { name: '부설주차장_기타_경기', region: '경기', type: '기타' }
  ];
  var defs = typeFilter !== '전체' ? sheetDefs.filter(function(d) { return d.type === typeFilter; }) : sheetDefs;
  var result = [];
  for (var s = 0; s < defs.length; s++) {
    try {
      var def = defs[s];
      var rows = await sheetsRead(SHEET_ID, "'" + def.name + "'", tok);
      if (!rows || rows.length < 2) continue;
      var c0 = String(rows[0][0] || '').trim();
      var co = c0 === '유형' ? 1 : 0;
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        var name = row[co], addr = row[co + 1];
        if (!name || !addr) continue;
        var item = { name: String(name).trim(), addr: String(addr).trim(), region: def.region, type: def.type };
        if (def.type === '아파트') {
          item.built = String(row[co + 2] || '').slice(0, 10);
          item.owner = String(row[co + 3] || '').trim();
          item.contact = ''; item.manager = ''; item.spaces = ''; item.note = '';
        } else {
          item.built = ''; item.owner = '';
          item.contact = String(row[co + 2] || '').trim();
          item.manager = String(row[co + 3] || '').trim();
          item.spaces = String(row[co + 4] || '').trim();
          item.note = String(row[co + 5] || '').trim();
        }
        result.push(item);
      }
    } catch (e) { result.push({ _err: e.message, _sheet: defs[s] ? defs[s].name : '?' }); }
  }
  return result;
}

async function h_webLoadRanking(p, gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return null;
  var tf = p.typeFilter || '전체';
  var region = p.region || '전체';
  var sheetName = tf === '전체' ? '랭킹_' + region : '랭킹_' + tf + '_' + region;
  try {
    var rows = await sheetsRead(SHEET_ID, "'" + sheetName + "'", tok);
    if (!rows || rows.length < 2) return null;
    var data = rows.slice(1).map(function(row, i) {
      return {
        rank: Number(row[0]) || i + 1, name: String(row[1] || ''), addr: String(row[2] || ''),
        lot_cnt: Number(row[3]) || 0, avg_rev: Number(row[4]) || 0,
        est_monthly: Number(row[5]) || 0, est_m: Number(row[6]) || 0, est_o: Number(row[7]) || 0,
        avg_price: Number(row[8]) || 0, m_rev: Number(row[9]) || 0, m_cnt: Number(row[10]) || 0,
        o_rev: Number(row[11]) || 0, o_cnt: Number(row[12]) || 0, total_rev: Number(row[13]) || 0,
        users: Number(row[14]) || 0
      };
    });
    return { data: data, updated: '' };
  } catch (e) { return null; }
}

async function h_webGetSalesLots(gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return {};
  try {
    var rows = await sheetsRead(SHEET_ID, '영업_등록', tok);
    if (!rows || rows.length < 2) return {};
    var result = {};
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var seq = String(parseInt(row[0]) || 0);
      if (seq !== '0') result[seq] = { name: String(row[1] || ''), date: String(row[2] || ''), sp: String(row[3] || '') };
    }
    return result;
  } catch (e) { return {}; }
}

async function h_webSetSalesLot(p, gToken) {
  if (!gToken) return { ok: false, error: 'no_token' };
  var seq = String(parseInt(p.seq) || 0);
  if (seq === '0') return { ok: false };
  var remove = p.remove === 'true';
  try {
    var rows = await sheetsRead(SHEET_ID, '영업_등록!A:D', gToken);
    var foundRow = -1;
    if (rows) {
      for (var i = 1; i < rows.length; i++) {
        if (String(parseInt(rows[i][0]) || 0) === seq) { foundRow = i + 1; break; }
      }
    }
    if (foundRow > 0 && !remove) return { ok: true };
    if (!remove && foundRow < 0) {
      var today = new Date().toISOString().slice(0, 10);
      await sheetsAppend(SHEET_ID, '영업_등록', [[parseInt(seq), p.name || '', today, '']], gToken);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function h_webUpdateSalesperson(p, gToken) {
  if (!gToken) return { ok: false, error: 'no_token' };
  var seq = String(parseInt(p.seq) || 0);
  if (seq === '0') return { ok: false };
  try {
    var rows = await sheetsRead(SHEET_ID, '영업_등록!A:D', gToken);
    if (!rows) return { ok: false };
    for (var i = 1; i < rows.length; i++) {
      if (String(parseInt(rows[i][0]) || 0) === seq) {
        await sheetsUpdateCell(SHEET_ID, '영업_등록!D' + (i + 1), [[p.sp || '']], gToken);
        return { ok: true };
      }
    }
    return { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function h_webLoadAptPerfData(gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return [{ name: '독립문극동아파트', spaces: 55, barrierCost: 3000000, months: [] }];
  var partnerLots = [{ gid: 739887865, name: '독립문극동아파트', spaces: 55, barrierCost: 3000000 }];
  var results = [];
  var curYM = new Date().toISOString().slice(0, 7);
  for (var li = 0; li < partnerLots.length; li++) {
    var lot = partnerLots[li];
    try {
      var metaR = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + PERF_SHEET_ID + '?fields=sheets.properties', { headers: Object.assign({ Authorization: 'Bearer ' + tok }, SH_HEADERS) });
      var meta = await metaR.json();
      if (meta.error) throw new Error(meta.error.message);
      var sheet = null;
      for (var si = 0; si < (meta.sheets || []).length; si++) {
        if (meta.sheets[si].properties && meta.sheets[si].properties.sheetId === lot.gid) { sheet = meta.sheets[si]; break; }
      }
      if (!sheet) { results.push(Object.assign({}, lot, { months: [], error: '시트 없음' })); continue; }
      var sheetTitle = sheet.properties.title;
      var data = await sheetsRead(PERF_SHEET_ID, "'" + sheetTitle + "'", tok);
      if (!data) { results.push(Object.assign({}, lot, { months: [] })); continue; }
      var headerRow = -1;
      for (var r = 0; r < Math.min(10, data.length); r++) {
        var cnt = data[r].filter(function(c) { return /^\d{4}-\d{2}$/.test(String(c)); }).length;
        if (cnt >= 3) { headerRow = r; break; }
      }
      if (headerRow < 0) { results.push(Object.assign({}, lot, { months: [], error: '헤더 없음' })); continue; }
      var monthCols = {}, ymList = [];
      for (var c = 0; c < data[headerRow].length; c++) {
        var cell = String(data[headerRow][c]);
        if (/^\d{4}-\d{2}$/.test(cell)) { monthCols[cell] = c; ymList.push(cell); }
      }
      ymList.sort();
      var monthTotals = {};
      ymList.forEach(function(ym) { monthTotals[ym] = 0; });
      for (var rr = headerRow + 1; rr < data.length; rr++) {
        var label = String(data[rr][0] || '').trim();
        if (!label || /총계|합계/.test(label)) continue;
        ymList.forEach(function(ym) {
          var v = data[rr][monthCols[ym]];
          var n = typeof v === 'number' ? v : (parseInt(String(v).replace(/[^0-9]/g, '')) || 0);
          monthTotals[ym] += Math.max(0, n);
        });
      }
      var months = ymList.filter(function(ym) { return ym <= curYM && (monthTotals[ym] !== 0 || ym === curYM); })
        .map(function(ym) { return { ym: ym, gmv: monthTotals[ym], isPartial: ym === curYM }; });
      results.push(Object.assign({}, lot, { months: months }));
    } catch (e) { results.push(Object.assign({}, lot, { months: [], error: e.message })); }
  }
  return results;
}

async function h_webGetSheetSoldout(gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return { rows: [], updated: '' };
  try {
    var metaR = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SOLDOUT_SHEET_ID + '?fields=sheets.properties', { headers: Object.assign({ Authorization: 'Bearer ' + tok }, SH_HEADERS) });
    var meta = await metaR.json();
    if (meta.error) throw new Error(meta.error.message);
    var sheet = null;
    for (var si = 0; si < (meta.sheets || []).length; si++) {
      if (meta.sheets[si].properties && meta.sheets[si].properties.sheetId === SOLDOUT_SHEET_GID) { sheet = meta.sheets[si]; break; }
    }
    if (!sheet && meta.sheets && meta.sheets.length) sheet = meta.sheets[meta.sheets.length - 1];
    if (!sheet) return { rows: [], updated: '' };
    var sheetTitle = sheet.properties.title;
    var data = await sheetsRead(SOLDOUT_SHEET_ID, "'" + sheetTitle + "'", tok);
    if (!data) return { rows: [], updated: '' };
    var hIdx = 0;
    for (var r = 0; r < Math.min(10, data.length); r++) {
      if (String(data[r][0]).indexOf('이용일') >= 0) { hIdx = r; break; }
    }
    var rows = [];
    for (var r2 = hIdx + 1; r2 < data.length; r2++) {
      var row = data[r2];
      var dateVal = row[0];
      if (!dateVal || !row[4]) continue;
      var dateStr = String(dateVal).slice(0, 10);
      if (!dateStr || dateStr.length < 8) continue;
      rows.push({
        date: dateStr, dday: String(row[1] || ''), company: String(row[2] || ''),
        name: String(row[4] || ''), region2: String(row[6] || ''),
        coupon: String(row[8] || ''), price: parseInt(row[9]) || 0,
        lim: parseInt(row[10]) || 0, rev: parseInt(row[11]) || 0,
        cnt: parseInt(row[12]) || 0, sameDayCnt: parseInt(row[13]) || 0,
        soldout: String(row[15] || '').indexOf('매진') >= 0
      });
    }
    var now = new Date();
    var updated = (now.getMonth() + 1) + '/' + now.getDate() + ' ' + now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
    return { rows: rows, updated: updated };
  } catch (e) { return { error: e.message, rows: [] }; }
}

async function h_getSearchHistory(gToken) {
  var tok = gToken || await getSheetsToken();
  if (!tok) return [];
  try {
    var rows = await sheetsRead(SHEET_ID, '검색기록', tok);
    if (!rows || rows.length < 2) return [];
    var seen = {}, result = [];
    for (var i = rows.length - 1; i >= 1; i--) {
      var r = rows[i];
      var name = String(r[2] || '');
      if (!name || seen[name]) continue;
      seen[name] = true;
      result.push({ time: Number(r[0]) || 0, email: String(r[1] || ''), name: name,
        lat: Number(r[3]), lng: Number(r[4]), radius: Number(r[5]) || 500 });
      if (result.length >= 50) break;
    }
    return result;
  } catch (e) { return []; }
}

async function h_saveSearchHistory(p, gToken) {
  if (!gToken) return { ok: true };
  try {
    var item = JSON.parse(p.item || '{}');
    if (!item.name || !item.lat || !item.lng) return { ok: true };
    var t = item.time || Date.now();
    await sheetsAppend(SHEET_ID, '검색기록', [[t, '', String(item.name), Number(item.lat), Number(item.lng), Number(item.radius) || 500]], gToken);
  } catch (e) { /* silent */ }
  return { ok: true };
}
