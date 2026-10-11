/*
 * 임장 체크리스트 — registry-parser.js (1.6.0, 1.8.0 지난 기록 시기 구분)
 * 인터넷등기소에서 저장한 등기사항전부증명서(집합건물) PDF 의 글자를 읽어, 등기부 섹션 항목의 답 후보를 만든다.
 *
 * - 브라우저: window.ImjangRegistry (vendor/pdfjs/pdf.min.js 가 만든 window.pdfjsLib 와 함께 쓴다)
 * - Node: 시험에서 require 한다 → module.exports
 * - DOM·저장소를 쓰지 않는다. 받은 글자를 어디로도 보내지 않는다. 예외를 던지지 않는다(늘 { ok:false, error } 로 돌려준다).
 * - ES module 이 아님(file:// 로 열어도 되도록, 다른 파일과 같은 UMD 모양).
 *
 * 흐름
 *   readPdf(pdfjsLib, 바이트)   PDF.js 로 쪽마다 getTextContent() → { ok, pages:[{ pageNo, items }] } (Promise)
 *   extractRows(pages)          글자 조각(x·y 좌표)을 줄로 묶고, 표 머리 줄(순위번호·등기목적…)의 x 위치로 열을 나눠
 *                               표 행으로 다시 만든다. 쪽 머리말·꼬리말·"열 람 용" 워터마크는 걷어 내 meta 에 모은다.
 *                               순위번호 칸이 빈 줄은 앞 행에 붙이므로 쪽을 넘는 행도 하나로 이어진다.
 *   parseRegistry(rows|글)      표제부·갑구·을구를 읽어 소유자, 살아 있는 권리, 지난(말소) 기록, 답 후보를 만든다.
 *   parsePdf(pdfjsLib, 바이트)  위 셋을 차례로(Promise)
 *   diffRegistry(prev, next)    다시 뗀 등기부를 처음 등기부와 순위번호·접수번호로 비교한다(계약 전 재열람).
 *   classifyHistory(기록)       1.8.0: 지워진 지난 기록(reg-history 종류)을 지금 소유자가 산 날 전/후로 나눈다.
 *                               parseRegistry 결과·등기부 코드 기록·앱 저장 기록 모두 받는다(저장하지 않고 매번 계산).
 *   estimatePrincipal(최고액)   채권최고액을 110·120·130%로 나눠 원금을 짐작한다.
 *
 * 말소 판정(중요): 등기부의 빨간 실선은 글자가 아니라 그림이라 글자로는 보이지 않는다. 그래서
 *   "4번압류, 5번압류, 6번가압류 등기말소" 같은 말소 기록이 가리키는 순위번호를 말소로 보고,
 *   부기(1-1, 1-2…)는 주등기가 말소되면 함께 말소로 본다. 무엇을 지웠는지 못 찾으면 추측하지 않는다
 *   (warnings 에 넣고, 그 판단에 기대는 답은 비운다).
 * 소유자: 소유권보존·소유권이전·공유자전원지분전부이전·"N번OO지분전부이전"을 순서대로 적용한다.
 *   지분일부이전은 정확히 셈하지 못할 수 있어 warning. 등기명의인표시변경·경정은 이름만 고친다(주소는 보지 않음).
 * 답(answers): 등기부로 답할 수 없는 항목(위반건축물 = 건축물대장, 소유자≠매도인 = 매도인 이름이 있어야 함,
 *   표제부 일치 = 매물 동·호수가 있어야 함)은 opts 로 비교 값을 받았을 때만 답한다.
 *
 * 개인정보: 결과(owners, notes, 항목 text)에는 등기부의 이름이 그대로 들어간다. 앱은 이 기기 안에서만 쓴다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangRegistry = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 1;
  var LIMITS = {
    pdfBytes: 20 * 1024 * 1024, // PDF 파일 크기 상한(등기부는 보통 100KB 안팎)
    pages: 80,                  // 쪽 수 상한
    items: 80000,               // 글자 조각 수 상한
    textChars: 400 * 1024       // 붙여 넣은 글 길이 상한
  };

  // 위험 분류(살아 있는 기록 live / 지난 기록 history 의 열쇠)
  var KINDS = ['trust', 'seizure', 'injunction', 'auction', 'provisional', 'lease', 'mortgage', 'jeonse', 'other'];
  var KIND_LABEL = {
    trust: '신탁', seizure: '압류·가압류', injunction: '가처분', auction: '경매개시결정', provisional: '가등기',
    lease: '임차권등기', mortgage: '근저당', jeonse: '전세권', other: '그 밖의 기록'
  };
  // reg-history 로 세는 지난 기록(data.js: 말소된 압류·가압류·가처분·경매·임차권등기 같은 것. 분양 때 신탁·근저당 말소는 흔해서 빼고 봄)
  var HISTORY_KINDS = ['seizure', 'injunction', 'auction', 'lease', 'provisional'];
  var GAP_FLAGS = { trust: 'reg-trust', seizure: 'reg-seizure', injunction: 'reg-injunction', auction: 'reg-auction', provisional: 'reg-provisional' };
  var EUL_FLAGS = { mortgage: 'reg-mortgage', jeonse: 'reg-jeonse', lease: 'reg-lease' };
  // data.js 등기부 섹션 항목 id(이 해석기가 다루는 것)
  var ITEM_IDS = [
    'reg-view', 'reg-title', 'reg-land-separate', 'reg-owner-diff', 'reg-joint', 'reg-period', 'reg-trust',
    'reg-seizure', 'reg-injunction', 'reg-auction', 'reg-provisional', 'reg-frequent', 'reg-mortgage',
    'reg-jeonse', 'reg-lease', 'reg-history', 'reg-building', 'reg-date'
  ];

  var MESSAGES = {
    empty: '읽을 내용이 없어요.',
    'bad-input': '비교할 등기부 두 개가 모두 필요해요.',
    'not-pdf': 'PDF 파일이 아니거나 깨져 있어요. 인터넷등기소에서 저장한 PDF를 다시 골라 주세요.',
    password: '암호가 걸린 PDF는 읽지 못해요.',
    'too-big': '파일이 너무 커요(PDF 20MB, 글 400KB까지).',
    'too-many-pages': '쪽이 너무 많아요(80쪽까지).',
    'no-text': 'PDF에서 글자를 찾지 못했어요. 사진을 찍어 만든(스캔한) PDF는 읽지 못해요.',
    'not-registry': '등기사항증명서(등기부등본)가 아닌 것 같아요.',
    'no-pdfjs': 'PDF 읽기 도구를 불러오지 못했어요. 새로고침해 보세요.',
    different: '다른 집의 등기부예요(고유번호가 달라요).',
    timeout: 'PDF를 읽는 데 너무 오래 걸려요. 다시 해 보세요.',
    internal: '읽다가 문제가 생겼어요. 등기부를 직접 보고 답해 주세요.'
  };

  function fail(code, err) {
    var r = { ok: false, error: code, message: MESSAGES[code] || MESSAGES.internal };
    if (err) r.detail = String((err && err.message) || err).slice(0, 300);
    return r;
  }
  function copyFail(r) {
    var o = { ok: false, error: r.error || 'internal', message: r.message || MESSAGES[r.error] || MESSAGES.internal };
    if (r.detail) o.detail = r.detail;
    return o;
  }

  // ---------- 작은 도구 ----------

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function str(v) { return v == null ? '' : String(v); }
  function clean(s) { return str(s).replace(/[  -​　﻿]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function compact(s) { return str(s).replace(/[\s  -​　﻿]+/g, ''); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function filter(list, fn) { var o = []; for (var i = 0; i < list.length; i++) if (fn(list[i], i)) o.push(list[i]); return o; }
  function map(list, fn) { var o = []; for (var i = 0; i < list.length; i++) o.push(fn(list[i], i)); return o; }
  function some(list, fn) { for (var i = 0; i < list.length; i++) if (fn(list[i], i)) return true; return false; }
  function keys(o) { return Object.keys(o); }
  function median(arr) {
    if (!arr.length) return 10;
    var a = arr.slice().sort(function (p, q) { return p - q; });
    return a[a.length >> 1];
  }

  // "2020년1월2일" · "2026/10/10" → "2020-01-02" (못 읽으면 '')
  function kDate(s) {
    var t = str(s);
    var m = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(t) || /(\d{4})\s*[.\/\-]\s*(\d{1,2})\s*[.\/\-]\s*(\d{1,2})/.exec(t);
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  var DATE_RE = /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/;
  // "금120,000,000원" → 120000000
  function won(s) {
    var m = /금\s*([\d,]+)\s*원/.exec(str(s));
    if (!m) return null;
    var n = +m[1].replace(/,/g, '');
    return isFinite(n) && n > 0 ? n : null;
  }
  // 1억 6,560만 원
  function formatWon(n) {
    n = Math.round(+n);
    if (!isFinite(n) || n <= 0) return '';
    var eok = Math.floor(n / 1e8), man = Math.floor((n % 1e8) / 1e4), rest = n % 1e4, parts = [];
    if (eok) parts.push(comma(eok) + '억');
    if (man) parts.push(comma(man) + '만');
    if (rest) parts.push(comma(rest));
    return parts.join(' ') + (rest ? '원' : ' 원');
  }
  function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // 분수(지분)
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }
  function frac(n, d) {
    n = +n; d = +d;
    if (!(d > 0) || !(n >= 0) || n % 1 || d % 1 || d > 1e9) return null;
    var g = gcd(n, d);
    return { n: n / g, d: d / g };
  }
  function fracAdd(a, b) { return a && b ? frac(a.n * b.d + b.n * a.d, a.d * b.d) : null; }
  function fracSub(a, b) { if (!a || !b) return null; var n = a.n * b.d - b.n * a.d; return n >= 0 ? frac(n, a.d * b.d) : null; }
  function fracStr(f) { return f ? f.n + '/' + f.d : '?'; }

  // ---------- 1. PDF 글자 조각 → 표 행 ----------

  function pageItems(page) {
    var list = page && (isArray(page) ? page : page.items);
    var out = [];
    if (!isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it.str !== 'string') continue;
      var raw = it.str.replace(/[ 　]/g, ' ');
      var s = raw.trim();
      if (!s) continue;
      var t = it.transform;
      if (!isArray(t) || t.length < 6) continue;
      var x = +t[4], y = +t[5];
      if (!isFinite(x) || !isFinite(y)) continue;
      var size = Math.sqrt((+t[2]) * (+t[2]) + (+t[3]) * (+t[3])) || Math.abs(+it.height) || 10;
      if (!isFinite(size) || size <= 0) size = 10;
      var w = +it.width;
      if (!isFinite(w) || w <= 0) w = raw.length * size * 0.6;
      var lead = raw.length - raw.replace(/^\s+/, '').length;
      if (lead) x += w * lead / raw.length; // 앞 공백만큼 오른쪽에서 시작
      w = w * s.length / raw.length;
      out.push({ s: s, x: x, y: y, w: w, size: size, rot: Math.abs(+t[1]) > 0.01 || Math.abs(+t[2]) > 0.01 });
    }
    return out;
  }

  // 조각을 이어 붙인다. 글자 크기의 0.2배보다 벌어져 있으면 띄어 쓴다.
  function joinItems(items) {
    var out = '', end = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (end !== null && it.x - end > it.size * 0.2) out += ' ';
      out += it.s;
      end = it.x + it.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // y(기준선)가 가까운 조각끼리 한 줄로. 위 줄부터.
  function groupLines(items) {
    items.sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
    var lines = [], cur = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (cur && Math.abs(cur.y - it.y) <= Math.max(1.5, Math.min(cur.size, it.size) * 0.4)) cur.items.push(it);
      else { cur = { y: it.y, size: it.size, items: [it] }; lines.push(cur); }
    }
    each(lines, function (ln) {
      ln.items.sort(function (a, b) { return a.x - b.x; });
      ln.text = joinItems(ln.items);
      ln.compact = compact(ln.text);
    });
    return lines;
  }

  // 머리 글이 두 줄로 나뉘면 첫 줄만 보이므로("권리자 및" / "기타사항") 앞부분으로도 알아본다
  var HEADER_KEYS = [
    [/^(순위번호|표시번호)$/, 'rank'], [/^등기목적$/, 'purpose'], [/^접수$/, 'receipt'], [/^등기원인$/, 'cause'],
    [/^(권리자(및(기타(사항)?)?)?|등기원인및(기타(사항)?)?)$/, 'detail'], [/^소재지번,?건물명칭(및(번호)?)?$/, 'location'],
    [/^소재지번$/, 'location'], [/^건물내역$/, 'building'], [/^지목$/, 'landType'], [/^면적$/, 'landArea'],
    [/^건물번호$/, 'unitNo'], [/^대지권종류$/, 'rightType'], [/^대지권비율$/, 'ratio']
  ];
  function headerKey(label) {
    // 좁은 칸에서 "순위" / "번호" 또는 "순위번" / "호" 두 줄로 나뉜 머리(1.6.0 검토 반영: "순위번"도)
    if (/^(순위|표시)(번호?)?$/.test(label)) return 'rank';
    for (var i = 0; i < HEADER_KEYS.length; i++) if (HEADER_KEYS[i][0].test(label)) return HEADER_KEYS[i][1];
    return '';
  }
  // 두 줄로 나뉜 머리 글의 둘째 줄 조각(표 행으로 읽지 않음): "번호" / "호" / "기타사항" / "호 기타사항" 등
  var HEADER_TAIL = /^(?:(?:번?호)?(?:및)?(?:기타사항)?|건물명칭및번호)$/;
  // 표 머리 줄이면 열 목록. 열 i 는 "앞 열 머리 글자의 오른쪽 끝"부터 시작한다
  // (머리 글자는 칸 가운데, 내용은 칸 왼쪽에 붙어 있으므로 내용의 시작 x 는 늘 앞 머리 글자 끝보다 오른쪽).
  function headerColumns(line) {
    if (!/^(순위|표시)/.test(line.compact)) return null;
    var groups = [], g = null;
    each(line.items, function (it) {
      if (g && it.x - g.x1 <= it.size * 1.6) { g.text += it.s; g.x1 = it.x + it.w; }
      else { g = { text: it.s, x0: it.x, x1: it.x + it.w }; groups.push(g); }
    });
    if (groups.length < 3) return null;
    var cols = [], known = 0;
    for (var i = 0; i < groups.length; i++) {
      var label = compact(groups[i].text), key = headerKey(label);
      if (key) known++; else key = 'col' + i;
      cols.push({ key: key, label: label, x0: groups[i].x0, x1: groups[i].x1, start: i ? groups[i - 1].x1 - 2 : -Infinity });
    }
    if (known < 3 || cols[0].key !== 'rank') return null;
    return cols;
  }
  // 줄을 열로 나눈다. 글자마다 조각이 따로인 PDF(브라우저 인쇄 등)도 있어, 맞붙은 조각(간격이 글자 크기의
  // 0.45배 이하)을 한 덩이로 묶고 덩이의 시작 x 로 열을 정한다(한 칸 안의 글이 다음 열 머리 위치를 넘어가도 그대로).
  function splitCells(line, cols) {
    var buckets = [], cells = {}, runs = [], run = null;
    each(line.items, function (it) {
      if (run && it.x - run.end <= it.size * 0.45) { run.items.push(it); run.end = Math.max(run.end, it.x + it.w); }
      else { run = { x: it.x, end: it.x + it.w, items: [it] }; runs.push(run); }
    });
    each(runs, function (r) {
      var c = 0;
      for (var k = cols.length - 1; k > 0; k--) if (r.x >= cols[k].start) { c = k; break; }
      buckets[c] = (buckets[c] || []).concat(r.items);
    });
    for (var j = 0; j < cols.length; j++) if (buckets[j]) cells[cols[j].key] = joinItems(buckets[j]);
    return cells;
  }

  // 섹션 제목 줄("【 갑 구 】 ( 소유권에 관한 사항 )" 등)
  function sectionMarker(c) {
    if (!/^[【(\[]/.test(c) || c.length > 40) return null;
    if (c.indexOf('1동의건물의표시') >= 0) return 'building';
    if (c.indexOf('대지권의목적인토지의표시') >= 0) return 'land';
    if (c.indexOf('전유부분의건물의표시') >= 0) return 'unit';
    if (c.indexOf('대지권의표시') >= 0) return 'landRight';
    if (c.indexOf('소유권이외의권리에관한사항') >= 0 || /^【을구】/.test(c)) return 'eul';
    if (c.indexOf('소유권에관한사항') >= 0 || /^【갑구】/.test(c)) return 'gap';
    if (/^【표제부】/.test(c)) return 'title';
    return null;
  }

  function newMeta() {
    return {
      title: '', propertyKind: '', addressLine: '', uniqueNo: '', viewedAtText: '', issueDateText: '',
      watermark: false, viewMarks: 0, issueMarks: 0, pageNos: [], numPages: 0, complete: false,
      sections: {}, emptySections: {}, other: [],
      lost: {} // 1.6.0 검토 반영: 섹션 안인데 표 머리를 못 알아봐 칸으로 나누지 못한 줄 수 { 섹션: 줄 수 }
    };
  }

  // 쪽 머리말·꼬리말·안내문이면 meta 에 모으고 true. 이하여백이면 'end'.
  function takeMeta(ln, meta) {
    var t = ln.text, c = ln.compact, m;
    if ((m = /^\[(집합건물|건물|토지)\]\s*(.+)$/.exec(t))) {
      if (!meta.addressLine) { meta.addressLine = clean(m[2]); meta.propertyKind = m[1]; }
      return true;
    }
    if ((m = /고유번호\s*:?\s*(\d{4}-\d{4}-\d{6})/.exec(t))) { if (!meta.uniqueNo) meta.uniqueNo = m[1]; return true; }
    if ((m = /^열람일시\s*:?\s*(.+)$/.exec(t))) {
      if (!meta.viewedAtText) meta.viewedAtText = m[1];
      meta.viewMarks++;
      return true;
    }
    if (/^\d{1,3}\/\d{1,3}$/.test(c)) { meta.pageNos.push(c); return true; }
    if ((m = /발행일\s*:?\s*(\d{4}\s*[\/.\-년]\s*\d{1,2}\s*[\/.\-월]\s*\d{1,2}\s*일?)/.exec(t))) {
      if (!meta.issueDateText) meta.issueDateText = m[1];
      meta.issueMarks++;
      return true;
    }
    if (/등기사항(전부|일부)증명서/.test(c)) { if (!meta.title) meta.title = c; return true; }
    if (/^-?(집합건물|건물|토지)-?$/.test(c)) return true;
    if (c.indexOf('이하여백') >= 0) { meta.complete = true; return 'end'; }
    if (/^관할등기소/.test(c)) return true;
    if (/열람용이므로|실선으로그어진|기록사항없는갑구|컬러또는흑백|발급확인번호|발행번호|바코드|위·?변조|인터넷발급|iros\.go\.kr|법원행정처|등기정보중앙관리소|전산운영책임관|수수료.*영수|증명합니다|본등기사항증명서/.test(c)) {
      if (c.indexOf('열람용') >= 0) meta.viewMarks++;
      if (/발급확인번호|발행번호|인터넷발급/.test(c)) meta.issueMarks++;
      return true;
    }
    return false;
  }

  /**
   * extractRows(pages, opts) → { ok, kind:'registry-rows', rows, meta, warnings }
   *   pages: PDF.js getTextContent() 결과를 쪽 순서대로 — [{ items }] 또는 [[items]] (readPdf 결과의 pages 그대로)
   *   rows[i] = { section:'building'|'land'|'unit'|'landRight'|'gap'|'eul'|'title', rank:'1'|'1-1', prevRank:'전 1',
   *               page, cells:{ rank:[], purpose:[], receipt:[], cause:[], detail:[], … 열 이름: 줄 글 배열 } }
   */
  function extractRows(pages, opts) {
    try { return extractRowsInner(pages, opts || {}); }
    catch (e) { return fail('internal', e); }
  }
  function extractRowsInner(pages) {
    if (!isArray(pages) || !pages.length) return fail('empty');
    if (pages.length > LIMITS.pages) return fail('too-many-pages');
    var meta = newMeta(), rows = [], warnings = [], st = { section: null, cols: null, row: null };
    var itemCount = 0, textChars = 0, orphan = 0;
    meta.numPages = pages.length;
    for (var p = 0; p < pages.length; p++) {
      var items = pageItems(pages[p]);
      itemCount += items.length;
      if (itemCount > LIMITS.items) return fail('too-big');
      // 워터마크("열 람 용")처럼 본문보다 훨씬 큰 글자나 기울어진 글자는 걷어 낸다
      var med = median(map(items, function (it) { return it.size; }));
      var kept = [], big = '';
      each(items, function (it) {
        if (it.size > med * 2.5 || it.rot) big += it.s; else kept.push(it);
      });
      if (compact(big).indexOf('열람용') >= 0) meta.watermark = true;
      var lines = groupLines(kept);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        textChars += ln.compact.length;
        // 긴 주소의 머리말이 두 줄로 나뉜 경우: "[집합건물] …" 바로 다음 줄의 "제N동 제N층 제N호" 꼬리는 주소에 붙이고 넘긴다
        if (i > 0 && /^\[(집합건물|건물|토지)\]/.test(lines[i - 1].text) && /^(제?\S+동)?제?\S+층제?\S+호$/.test(ln.compact)) {
          if (meta.addressLine && !/호$/.test(compact(meta.addressLine))) meta.addressLine = clean(meta.addressLine + ' ' + ln.text);
          continue;
        }
        var sec = sectionMarker(ln.compact);
        if (sec) { st.section = sec; st.cols = null; st.row = null; meta.sections[sec] = true; continue; }
        var tm = takeMeta(ln, meta);
        if (tm === 'end') { st.section = null; st.cols = null; st.row = null; continue; }
        if (tm) continue;
        var cols = headerColumns(ln);
        if (cols) { st.cols = cols; st.afterHeader = true; continue; }
        if (st.afterHeader && HEADER_TAIL.test(ln.compact)) { st.afterHeader = false; continue; }
        st.afterHeader = false;
        if (st.section && ln.compact === '기록사항없음') { meta.emptySections[st.section] = true; continue; }
        if (!st.section || !st.cols) {
          // 섹션 안의 줄인데 열 머리를 못 알아봤으면 그 섹션 기록을 놓친 것이다(조용히 버리지 않고 센다 → 답을 낮춤)
          if (st.section) meta.lost[st.section] = (meta.lost[st.section] || 0) + 1;
          if (meta.other.length < 40) meta.other.push(ln.text);
          continue;
        }
        var cells = splitCells(ln, st.cols);
        var rk = compact(cells.rank || ''), m = /^(\d{1,4}(?:-\d{1,3})?)(\(전[\d\-]+\))?$/.exec(rk);
        if (m) {
          st.row = { section: st.section, rank: m[1], prevRank: m[2] ? m[2].slice(1, -1) : '', page: p + 1, cells: {} };
          rows.push(st.row);
          delete cells.rank;
        } else if (/^\(전[\d\-]+\)$/.test(rk)) {
          if (st.row && !st.row.prevRank) st.row.prevRank = rk.slice(1, -1);
          delete cells.rank;
        }
        if (!st.row) {
          orphan++;
          st.row = { section: st.section, rank: '', prevRank: '', page: p + 1, cells: {} };
          rows.push(st.row);
        }
        for (var k in cells) {
          if (!Object.prototype.hasOwnProperty.call(cells, k) || !cells[k]) continue;
          (st.row.cells[k] = st.row.cells[k] || []).push(cells[k]);
        }
      }
    }
    if (!itemCount || textChars < 10) return fail('no-text');
    if (orphan) warnings.push('순위번호 없이 시작하는 줄이 ' + orphan + '개 있어요. 표를 다 읽지 못했을 수 있어요.');
    return { ok: true, kind: 'registry-rows', source: 'pdf', rows: rows, meta: meta, warnings: warnings };
  }

  // ---------- 1'. 붙여 넣은 글(대체 경로, 신뢰도 낮음) ----------

  var PURPOSE_START = /^(소유권|공유자|\d{1,4}(-\d{1,3})?번|가압류|압류|가처분|가등기|임의경매|강제경매|근저당|저당|전세권|주택임차권|임차권|신탁|등기명의인|지상권|지역권|환매|금지)/;
  var DETAIL_LABELS = /(소유자|공유자|수탁자|합유자|지분\s*\d+\s*분\s*의\s*\d+|거래가액|채권최고액|채무자|근저당권자|저당권자|전세권자|임차권자|전세금|임차보증금|청구금액|채권자|권리자|신탁원부)/g;

  function rowsFromText(text) {
    if (!clean(text)) return fail('empty');
    if (text.length > LIMITS.textChars) return fail('too-big');
    var meta = newMeta(), rows = [], section = null, row = null, lines = String(text).split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var t = clean(lines[i]);
      if (!t) continue;
      var ln = { text: t, compact: compact(t) };
      var sec = sectionMarker(ln.compact);
      if (sec) { section = sec; row = null; meta.sections[sec] = true; continue; }
      var tm = takeMeta(ln, meta);
      if (tm === 'end') { section = null; row = null; continue; }
      if (tm) continue;
      if (/^(순위번호|표시번호)/.test(ln.compact)) continue;
      if (!section) { if (meta.other.length < 40) meta.other.push(t); continue; }
      if (ln.compact === '기록사항없음') { meta.emptySections[section] = true; continue; }
      var m = /^(\d{1,4}(?:-\d{1,3})?)(?:\s+(.*))?$/.exec(t);
      if (m && (section === 'gap' || section === 'eul' ? (!m[2] || PURPOSE_START.test(compact(m[2]))) : true)) {
        row = { section: section, rank: m[1], prevRank: '', page: 0, cells: { raw: m[2] ? [m[2]] : [] } };
        rows.push(row);
        continue;
      }
      var pm = /^\(전\s*([\d\-]+)\)\s*(.*)$/.exec(t);
      if (pm) { if (row) row.prevRank = '전 ' + pm[1]; t = pm[2]; if (!t) continue; }
      if (!row) { row = { section: section, rank: '', prevRank: '', page: 0, cells: { raw: [] } }; rows.push(row); }
      row.cells.raw.push(t);
    }
    each(rows, splitRawRow);
    return { ok: true, kind: 'registry-rows', source: 'text', rows: rows, meta: meta, warnings: [] };
  }
  // 한 줄로 이어진 글을 등기목적 / 접수 / 등기원인 / 권리자 및 기타사항으로 대충 나눈다
  function splitRawRow(row) {
    var full = (row.cells.raw || []).join(' ');
    if (row.section !== 'gap' && row.section !== 'eul') {
      row.cells = { building: [full], ratio: [full], unitNo: [full], detail: [full] };
      return;
    }
    var cells = { purpose: [], receipt: [], cause: [], detail: [] };
    var d1 = DATE_RE.exec(full);
    if (!d1) { cells.purpose.push(full); row.cells = cells; return; }
    cells.purpose.push(full.slice(0, d1.index));
    var rest = full.slice(d1.index + d1[0].length);
    var no = /^\s*(제\s*\d+\s*호)/.exec(rest);
    cells.receipt.push(d1[0]);
    if (no) { cells.receipt.push(no[1]); rest = rest.slice(no[0].length); }
    var d2 = /^\s*(\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일)\s*/.exec(rest);
    if (d2) { cells.cause.push(d2[1]); rest = rest.slice(d2[0].length); }
    var lab = rest.search(DETAIL_LABELS);
    var causeWords = lab >= 0 ? rest.slice(0, lab) : (d2 ? rest.replace(/\s.*$/, '') : '');
    if (causeWords) { cells.cause.push(causeWords.trim()); rest = rest.slice(causeWords.length); }
    cells.detail = filter(map(rest.replace(DETAIL_LABELS, '\n$1').split('\n'), clean), function (s) { return !!s; });
    row.cells = cells;
  }

  // ---------- 2. 표 행 → 등기부 ----------

  function cellLines(row, key) { return (row.cells && row.cells[key]) || []; }
  function cellDates(row, key) {
    var out = [], re = new RegExp(DATE_RE.source, 'g'), t = row ? cellLines(row, key).join(' ') : '', m;
    while ((m = re.exec(t))) out.push(kDate(m[0]));
    return out;
  }
  function rowText(row) {
    var out = [];
    for (var k in row.cells) if (Object.prototype.hasOwnProperty.call(row.cells, k) && k !== 'rank') out.push(row.cells[k].join(' '));
    return out.join(' ');
  }

  function viewedAtIso(meta) {
    var m = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(\d{1,2})\s*시\s*(\d{1,2})\s*분\s*(\d{1,2})\s*초/.exec(meta.viewedAtText || '');
    if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) + 'T' + pad2(+m[4]) + ':' + pad2(+m[5]) + ':' + pad2(+m[6]) + '+09:00';
    return kDate(meta.viewedAtText) || kDate(meta.issueDateText) || null;
  }

  function addressParts(addr) {
    var m = /제\s*([^\s제]+?)\s*동\s*제\s*([^\s]+?)\s*층\s*제\s*([^\s]+?)\s*호/.exec(addr) ||
      /([0-9A-Za-z가-힣\-]+?)\s*동\s+([0-9지하B\-]+?)\s*층\s+([0-9A-Za-z가-힣\-]+?)\s*호/.exec(addr);
    return m ? { dong: m[1], floor: m[2], ho: m[3] } : null;
  }

  // 갑구·을구 행 → 기록
  function entryFromRow(row) {
    var purposeLines = cellLines(row, 'purpose'), receipt = cellLines(row, 'receipt').join(' '),
      causeLines = cellLines(row, 'cause'), detail = map(cellLines(row, 'detail'), clean);
    var purpose = clean(purposeLines.join(''));
    var sub = /-/.test(row.rank);
    var e = {
      section: row.section, rank: row.rank, sub: sub, parent: sub ? row.rank.split('-')[0] : '', prevRank: row.prevRank || '',
      page: row.page, purpose: purpose, purposeC: compact(purpose),
      receiptDate: kDate(receipt), receiptNo: '', causeDate: '', cause: '',
      detail: detail, cancelled: false, cancelledBy: null, kind: '', text: ''
    };
    var no = /제\s*(\d+)\s*호/.exec(receipt);
    if (no) e.receiptNo = no[1];
    // 등기원인: 맨 앞 날짜(칸이 좁아 "2006년12월" / "28일"로 줄이 바뀌어도) + 나머지 글(줄 바꿈은 낱말 중간일 수 있어 붙임)
    var ct = causeLines.join('\n'), d = DATE_RE.exec(ct);
    if (d && !clean(ct.slice(0, d.index))) { e.causeDate = kDate(d[0]); ct = ct.slice(d.index + d[0].length); }
    e.cause = clean(ct.replace(/\s*\n\s*/g, ''));
    return e;
  }

  function classify(e) {
    var p = e.purposeC, c = compact(e.cause);
    if (/말소/.test(p) && !/말소회복/.test(p)) return 'cancel';
    if (e.sub) {
      if (/등기명의인표시(변경|경정)/.test(p)) return 'nameChange';
      if (/금지사항|환매/.test(p)) return 'other';
      return 'sub';
    }
    if (e.section === 'gap') {
      if (/등기명의인표시(변경|경정)/.test(p)) return 'nameChange';
      if (/가처분/.test(p)) return 'injunction';
      if (/경매개시결정/.test(p)) return 'auction';
      if (/가등기/.test(p)) return 'provisional';
      if (/압류/.test(p)) return 'seizure';
      if ((/신탁/.test(p) && !/신탁재산/.test(p)) || c === '신탁') return 'trust';
      // 1.6.0 검토 반영: 목적 칸에 "신탁" 줄이 없어도 등기원인에 신탁(신탁재산의 귀속·신탁 해지는 빼고)이 있거나
      // 권리자 칸에 수탁자·신탁원부가 있으면 신탁으로 본다(멈춤 신호를 "없음"으로 놓치지 않게)
      if (/소유권보존|소유권이전|지분.*이전|소유권일부이전/.test(p)) {
        if ((/신탁/.test(c) && !/신탁재산의?귀속|신탁해지|신탁종료/.test(c)) || /수탁자|신탁원부/.test(compact(e.detail.join(' ')))) return 'trust';
        return 'ownership';
      }
      return 'other';
    }
    if (/근저당권설정|^저당권설정/.test(p)) return 'mortgage';
    if (/전세권설정/.test(p)) return 'jeonse';
    // 1.6.0 검토 반영: 멈춤 신호 "임차권등기"는 주택(상가건물)임차권·임차권등기명령만. 합의로 한 "임차권설정"은
    // 그 밖의 기록(주의, 따로 경고)으로 둔다 — 을구 "없음" 답들은 확인 필요로 낮아진다
    if (/임차권/.test(p)) {
      if (/주택임차권|상가건물임차권|임차권등기명령/.test(p) || /임차권등기명령/.test(c)) return 'lease';
      e.leaseSet = true;
      return 'other';
    }
    return 'other';
  }

  function ownershipOp(p) {
    var m;
    if (/소유권보존/.test(p)) return { op: 'preserve' };
    if (/공유자전원지분전부이전/.test(p)) return { op: 'all' };
    if ((m = /^(?:(\d{1,4})번)?(.*?)지분전부이전/.exec(p))) return { op: 'shareAll', fromRank: m[1] || '', from: m[2] || '' };
    if ((m = /^(?:(\d{1,4})번)?(.*?)지분(?:중)?일부(?:\(.*?\))?이전/.exec(p))) return { op: 'sharePart', fromRank: m[1] || '', from: m[2] || '' };
    if (/소유권일부이전/.test(p)) return { op: 'sharePart', fromRank: '', from: '' };
    if (/소유권이전/.test(p)) return { op: 'transfer' };
    return null;
  }

  // "4번압류, 5번압류, 6번가압류 등기말소" → [4,5,6]. "1번 내지 3번" 도 받는다.
  // 1.6.0 검토 반영: "3, 4번가압류등기말소"·"3·4번"처럼 '번'을 마지막 숫자에만 붙인 나열도 받는다
  function cancelTargets(pc) {
    var out = [], seen = {}, m;
    var s = pc.replace(/(\d{1,4})번내지(\d{1,4})번/g, function (all, a, b) {
      a = +a; b = +b;
      if (b < a || b - a > 50) return all;
      var parts = [];
      for (var i = a; i <= b; i++) parts.push(i + '번');
      return parts.join(',');
    });
    s = s.replace(/(갑구|을구)?(\d{1,4}(?:-\d{1,3})?)((?:[,，·、및]\d{1,4}(?:-\d{1,3})?)+)번/g, function (all, sec, first, rest) {
      return map([first].concat(filter(rest.split(/[,，·、및]/), function (x) { return !!x; })), function (x) { return (sec || '') + x + '번'; }).join(',');
    });
    var re = /(갑구|을구)?(\d{1,4}(?:-\d{1,3})?)번/g;
    while ((m = re.exec(s))) {
      var t = { section: m[1] === '갑구' ? 'gap' : (m[1] === '을구' ? 'eul' : ''), rank: m[2] };
      var k = t.section + ':' + t.rank;
      if (!seen[k]) { seen[k] = 1; out.push(t); }
    }
    return out;
  }
  // 말소 기록의 등기목적에 나오는 종류(무엇을 지웠는지 못 찾을 때 영향 범위)
  function kindsIn(pc) {
    var o = [];
    if (/신탁/.test(pc)) o.push('trust');
    if (/압류/.test(pc)) o.push('seizure');
    if (/가처분/.test(pc)) o.push('injunction');
    if (/경매/.test(pc)) o.push('auction');
    if (/가등기/.test(pc)) o.push('provisional');
    if (/임차권/.test(pc)) o.push('lease');
    if (/저당/.test(pc)) o.push('mortgage');
    if (/전세권/.test(pc)) o.push('jeonse');
    return o;
  }

  // 권리자 칸에서 사람 이름(주민번호·생년월일 떼고)
  var NATION_RE = /^((?:미국|중국|일본|캐나다|영국|호주|독일|프랑스|러시아|베트남|필리핀|태국|대만|뉴질랜드|싱가포르|인도네시아|몽골|우즈베키스탄|외국)인)\s+(.+)$/;
  var REGNO_RE = /\d{6}\s*-\s*[\d*]{7}/;
  var BIRTH_RE = /\(?\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*생\)?/;
  function holderName(l) {
    var s = clean(l), m;
    // 이름 뒤의 주민·법인등록번호나 생년월일(외국인)부터는 버린다(같은 줄에 주소가 이어 붙은 글도 있음)
    if ((m = REGNO_RE.exec(s))) s = s.slice(0, m.index);
    else if ((m = BIRTH_RE.exec(s))) s = s.slice(0, m.index);
    s = clean(s);
    if (!s || /^[\d(\[\-]/.test(s) || !/[가-힣A-Za-z]/.test(s)) return null;
    var foreign = '';
    if ((m = NATION_RE.exec(s))) { foreign = m[1]; s = m[2]; }
    return { name: s, foreign: foreign };
  }
  // 주소 줄 같은지(이름을 기다리는 동안 건너뛸 때만 씀). 등록번호가 있는 줄은 이름 줄("홍길동 800101-…"의 '동'에 속지 않게)
  function looksAddress(l) {
    if (REGNO_RE.test(l) || BIRTH_RE.test(l)) return false;
    return /(특별시|광역시|특별자치|[가-힣]+(도|시|군|구)\s)/.test(l) || /(아파트|빌라|번길|\d+-\d+)/.test(l) ||
      (/\d/.test(l) && /[가-힣](동|리|로|길|가)\s*\d/.test(l));
  }
  // 소유권 기록의 권리자 칸 → [{ name, share }] + 거래가액
  // 이름은 "소유자 홍길동 …"처럼 이름표와 같은 줄이거나, 이름표·"지분 N분의 M" 줄 바로 다음 줄에 온다
  // (주소로 보이는 줄을 건너뛰지 않는다: "소유자 인천광역시" 같은 기관 이름이 있음)
  function parseHolders(lines) {
    var list = [], share = null, expect = false, inHolders = false, price = null;
    for (var i = 0; i < lines.length; i++) {
      var l = clean(lines[i]), m;
      if (!l) continue;
      if (/^거래가액/.test(l)) { price = won(l); expect = false; continue; }
      if (/^(매매목록|신탁원부|신탁조항)/.test(compact(l))) { expect = false; continue; }
      if ((m = /^(소유자|공유자|수탁자|합유자)\s*:?\s*(.*)$/.exec(l))) {
        inHolders = true; expect = true; l = m[2];
        if (!l) continue;
      }
      if (!inHolders) continue;
      if ((m = /^지분\s*(\d+)\s*분\s*의\s*(\d+)\s*(.*)$/.exec(l))) {
        share = frac(+m[2], +m[1]); expect = true; l = m[3];
        if (!l) continue;
      }
      if (!expect) continue;
      var nm = holderName(l);
      if (nm) { list.push({ name: nm.name, foreign: nm.foreign, share: share }); share = null; expect = false; }
    }
    return { list: list, price: price };
  }
  // 을구 기록(근저당 등)의 채권최고액·근저당권자·채무자
  function eulFields(e) {
    var lines = e.detail, want = '';
    for (var i = 0; i < lines.length; i++) {
      var l = clean(lines[i]), c = compact(l), m;
      if (/^채권최고액/.test(c)) { e.maxAmount = won(l); want = ''; continue; }
      if (/^(전세금|임차보증금|보증금)/.test(c)) { e.deposit = won(l); want = ''; continue; }
      if ((m = /^(근저당권자|저당권자|전세권자|임차권자|지상권자|질권자)\s*(.*)$/.exec(l))) {
        var h = holderName(m[2]);
        if (h) { e.holder = h.name; want = ''; } else want = 'holder';
        continue;
      }
      if ((m = /^채무자\s*(.*)$/.exec(l))) {
        var d = holderName(m[1]);
        if (d) { e.debtor = d.name; want = ''; } else want = 'debtor';
        continue;
      }
      if (want && !looksAddress(l)) {
        var n = holderName(l);
        if (n) { e[want] = n.name; want = ''; }
      }
    }
  }
  // 갑구 압류·가압류 등의 청구금액·권리자
  function gapRiskFields(e) {
    each(e.detail, function (l) {
      var c = compact(l), m;
      if (/^청구금액/.test(c)) e.amount = won(l);
      else if (!e.holder && (m = /^(채권자|권리자|가등기권자|근저당권자)\s*(.*)$/.exec(clean(l)))) {
        var h = holderName(m[2]);
        if (h) e.holder = h.name;
      }
    });
  }

  function entryText(e) {
    var parts = [e.purpose || '(부기)'];
    if (e.receiptDate) parts.push(e.receiptDate + ' 접수' + (e.receiptNo ? ' 제' + e.receiptNo + '호' : ''));
    if (e.cause) parts.push((e.causeDate ? e.causeDate + ' ' : '') + e.cause);
    var d = e.detail.join(' ');
    if (d) parts.push(d);
    var s = parts.join(' · ');
    return s.length > 300 ? s.slice(0, 299) + '…' : s;
  }
  function brief(e) {
    var b = { section: e.section, rank: e.rank, purpose: e.purpose, receiptDate: e.receiptDate, receiptNo: e.receiptNo };
    if (e.maxAmount) b.maxAmount = e.maxAmount;
    if (e.deposit) b.deposit = e.deposit;
    if (e.amount) b.amount = e.amount;
    if (e.holder) b.holder = e.holder;
    if (e.cancelledBy) b.cancelledBy = e.cancelledBy;
    return b;
  }
  function publicEntry(e) {
    var o = {
      rank: e.rank, purpose: e.purpose, kind: e.kind, receiptDate: e.receiptDate, receiptNo: e.receiptNo,
      causeDate: e.causeDate, cause: e.cause, text: e.text, detail: e.detail.slice(0, 40),
      cancelled: e.cancelled, cancelledBy: e.cancelledBy
    };
    if (e.sub) o.parent = e.parent;
    if (e.prevRank) o.prevRank = e.prevRank;
    if (e.section === 'eul') {
      o.maxAmount = e.maxAmount || null;
      o.holder = e.holder || '';
      o.debtor = e.debtor || '';
      if (e.deposit) o.deposit = e.deposit;
    } else {
      if (e.amount) o.amount = e.amount;
      if (e.holder) o.holder = e.holder;
    }
    return o;
  }

  // 소유자 계산(말소된 소유권 기록은 건너뜀)
  // 1.8.0 검토 반영: firstOf = 이름마다 소유자(지분 포함)가 된 가장 이른 접수일. 지금 소유자가 예전에도 이 집을 가졌으면
  // (담보신탁 뒤 신탁재산의 귀속으로 돌아옴, 팔았다가 다시 삼 등) owners[].firstSince 에 그 날을 둔다(since 는 마지막 취득일 그대로)
  function computeOwners(gap, warn) {
    var owners = [], uncertain = false, seen = false, firstOf = {};
    function noteFirst(h, e) {
      var k = compact(h.name);
      if (k && e.receiptDate && (!firstOf[k] || e.receiptDate < firstOf[k])) firstOf[k] = e.receiptDate;
    }
    for (var i = 0; i < gap.length; i++) {
      var e = gap[i];
      if (e.cancelled) continue;
      if (e.kind === 'nameChange') { applyRename(owners, e, warn, firstOf); continue; }
      if (!e.op) continue;
      var hs = parseHolders(e.detail), list = hs.list, op = e.op.op;
      each(list, function (h) { noteFirst(h, e); });
      if (op === 'preserve' || op === 'transfer' || op === 'all') {
        if (!list.length) { uncertain = true; warn('갑구 ' + e.rank + '번에서 새 소유자 이름을 찾지 못했어요.'); owners = []; continue; }
        if (list.length === 1 && !list[0].share) list[0].share = frac(1, 1);
        if (some(list, function (h) { return !h.share; })) { uncertain = true; warn('갑구 ' + e.rank + '번 공유자의 지분을 읽지 못했어요.'); }
        owners = map(list, function (h) { return ownerFrom(h, e, hs.price); });
        seen = true;
      } else if (op === 'shareAll') {
        var gone = takeOwner(owners, e.op.from, e.op.fromRank);
        if (!gone) {
          uncertain = true;
          warn('갑구 ' + e.rank + '번 "' + e.purpose + '"에서 지분을 넘긴 사람을 지금 소유자 중에서 찾지 못했어요.');
        }
        if (!list.length) { uncertain = true; warn('갑구 ' + e.rank + '번에서 지분을 받은 사람을 찾지 못했어요.'); continue; }
        if (list.length === 1 && !list[0].share && gone) list[0].share = gone;
        each(list, function (h) { owners.push(ownerFrom(h, e, hs.price)); });
        seen = true;
      } else if (op === 'sharePart') {
        uncertain = true;
        warn('갑구 ' + e.rank + '번은 지분 일부 이전이에요. 소유 지분을 앱이 정확히 셈하지 못할 수 있으니 원본을 직접 보세요.');
        each(list, function (h) {
          var src = findOwner(owners, e.op.from, e.op.fromRank);
          if (src && h.share && src.share) src.share = fracSub(src.share, h.share);
          else if (src) src.share = null;
          owners.push(ownerFrom(h, e, hs.price));
        });
        owners = filter(owners, function (o) { return !(o.share && o.share.n === 0); });
        seen = true;
      }
    }
    // 같은 이름은 합친다(같은 사람이 지분을 두 번 받은 경우)
    var merged = [], byName = {};
    each(owners, function (o) {
      var k = compact(o.name);
      if (byName[k]) {
        var m = byName[k];
        m.share = fracAdd(m.share, o.share);
        if (o.since && (!m.since || o.since < m.since)) { m.since = o.since; m.cause = o.cause; m.price = o.price; m.rank = o.rank; }
      } else { byName[k] = o; merged.push(o); }
    });
    each(merged, function (o) {
      var f = firstOf[compact(o.name)];
      if (f && o.since && f < o.since) o.firstSince = f;
    });
    var total = null, ok = true;
    each(merged, function (o) { if (!o.share) ok = false; else total = total ? fracAdd(total, o.share) : o.share; });
    if (seen && merged.length && !uncertain && (!ok || !total || total.n !== total.d)) {
      uncertain = true;
      warn('소유자 지분을 더하면 ' + (ok && total ? fracStr(total) : '?') + '이에요. 원본에서 지분을 직접 확인하세요.');
    }
    return { owners: merged, uncertain: uncertain, seen: seen };
  }
  function ownerFrom(h, e, price) {
    var o = { name: h.name, share: h.share, since: e.receiptDate, cause: e.cause, price: price || null, rank: e.rank };
    if (h.foreign) o.foreign = h.foreign;
    if (e.kind === 'trust') o.trustee = true;
    return o;
  }
  function findOwner(owners, name, rank) {
    var k = compact(name), hit = null;
    if (!k) return owners.length === 1 ? owners[0] : null;
    each(owners, function (o) { if (!hit && compact(o.name) === k && (!rank || o.rank === rank)) hit = o; });
    if (!hit) each(owners, function (o) { if (!hit && compact(o.name) === k) hit = o; });
    return hit;
  }
  function takeOwner(owners, name, rank) {
    var o = findOwner(owners, name, rank);
    if (!o) return null;
    owners.splice(owners.indexOf(o), 1);
    return o.share || frac(1, 1);
  }
  function applyRename(owners, e, warn, firstOf) {
    var t = e.detail.join(' ');
    if (!/성명/.test(t)) return; // 주소만 바뀐 것
    var m = /(\S+?)의\s*성명\s*(?:\(\s*명칭\s*\))?\s*(\S+)/.exec(t);
    if (!m) { warn('갑구 ' + e.rank + '번 이름 변경을 읽지 못했어요.'); return; }
    var from = compact(m[1]), to = clean(m[2]);
    // 1.8.0 검토 반영: 바뀐 이름으로도 처음 소유자가 된 날을 찾게
    var tk = compact(to);
    if (firstOf && firstOf[from] && (!firstOf[tk] || firstOf[from] < firstOf[tk])) firstOf[tk] = firstOf[from];
    each(owners, function (o) { if (compact(o.name) === from && (!e.parent || o.rank === e.parent)) o.name = to; });
    each(owners, function (o) { if (compact(o.name) === from) o.name = to; });
  }

  function emptyKinds() { var o = {}; each(KINDS, function (k) { o[k] = []; }); return o; }

  function newResult() {
    return {
      ok: true, error: null, version: VERSION, source: 'pdf',
      docType: null, includesCancelled: null, viewedAt: null, uniqueNo: '', address: '', dong: '', floor: '', ho: '',
      area: null, landShare: null, landSeparate: null, complete: false, ownersUncertain: false,
      owners: [], gap: [], eul: [], live: emptyKinds(), history: emptyKinds(),
      answers: {}, confidence: {}, notes: [], warnings: []
    };
  }

  /**
   * parseRegistry(rowsOrText, opts) → { ok, error, source, docType:'열람용'|'제출용'|null, includesCancelled, viewedAt,
   *     uniqueNo, address, dong, floor, ho, area, landShare:{num,den}, landSeparate, complete, owners:[{ name, share:'1/2',
   *     since, cause, price, rank, firstSince?(1.8.0: 예전에도 이 집 소유자였으면 처음 소유자가 된 접수일) }],
   *     ownersUncertain(소유자 계산이 불확실: 지분·이름·놓친 갑구 줄·모르는 소유권 말소),
   *     gap:[기록], eul:[기록 + maxAmount·holder·debtor], live:{종류:[…]}, history:{종류:[…]},
   *     answers:{ 'reg-xxx': 'yes'|'no'|true }, confidence:{ 'reg-xxx': 'high'|'low' }, notes:[], warnings:[] }
   *   rowsOrText: extractRows 결과 | readPdf 결과 | pages 배열 | 등기부 글(string, 신뢰도 낮음)
   *   opts.expect = { dong, ho, area }  매물 정보 — 주면 reg-title 을 비교해 답한다
   *   opts.seller = '매도인 이름'        주면 reg-owner-diff 를 비교해 답한다
   *   opts.today  = 'YYYY-MM-DD'        열람일시를 못 읽었을 때 reg-frequent 기준일
   */
  function parseRegistry(input, opts) {
    try { return parseInner(input, opts || {}); }
    catch (e) { return fail('internal', e); }
  }

  function parseInner(input, opts) {
    var ex;
    if (typeof input === 'string') ex = rowsFromText(input);
    else if (input && input.ok === false) return copyFail(input);
    else if (input && input.kind === 'registry-rows') ex = input;
    else if (input && isArray(input.pages)) ex = extractRows(input.pages, opts);
    else if (isArray(input) && input.length && input[0] && input[0].cells) ex = { ok: true, kind: 'registry-rows', source: 'rows', rows: input, meta: newMeta(), warnings: [] };
    else if (isArray(input) && input.length) ex = extractRows(input, opts);
    else return fail('empty');
    if (!ex || !ex.ok) return ex && ex.error ? copyFail(ex) : fail('internal');

    var meta = ex.meta || newMeta(), rows = ex.rows || [], R = newResult();
    var low = ex.source === 'text';
    R.source = ex.source === 'text' ? 'text' : 'pdf';
    function warn(s) { if (R.warnings.indexOf(s) < 0) R.warnings.push(s); }
    each(ex.warnings || [], warn);

    var gapRows = filter(rows, function (r) { return r.section === 'gap'; });
    var eulRows = filter(rows, function (r) { return r.section === 'eul'; });
    var titleC = compact(meta.title);
    if (!/등기사항(전부|일부)증명서/.test(titleC) && !gapRows.length) return fail('not-registry');

    // 문서 정보
    R.docType = (meta.watermark || meta.viewMarks) ? '열람용' : (meta.issueMarks ? '제출용' : null);
    R.includesCancelled = titleC.indexOf('말소사항포함') >= 0 ? true : (titleC.indexOf('현재유효사항') >= 0 ? false : null);
    R.viewedAt = viewedAtIso(meta);
    R.uniqueNo = meta.uniqueNo || '';
    R.address = meta.addressLine || '';
    R.complete = !!meta.complete;
    if (/일부증명서/.test(titleC)) warn('일부증명서예요. 전부증명서(말소사항 포함)로 열람해야 빠짐없이 볼 수 있어요.');
    if (R.includesCancelled === null) warn('말소사항 포함인지 현재 유효사항인지 제목에서 찾지 못했어요.');
    if (meta.propertyKind && meta.propertyKind !== '집합건물') warn('집합건물(아파트) 등기부가 아니에요. 앱은 아파트 등기부를 기준으로 읽어요.');
    var ap = addressParts(R.address);
    if (ap) { R.dong = ap.dong; R.floor = ap.floor; R.ho = ap.ho; }
    // 쪽 빠짐
    var pageTotal = 0, pageSeen = {};
    each(meta.pageNos || [], function (pn) { var m = /^(\d+)\/(\d+)$/.exec(pn); if (m) { pageSeen[m[1]] = 1; pageTotal = Math.max(pageTotal, +m[2]); } });
    var missingPages = [];
    for (var pi = 1; pi <= pageTotal; pi++) if (!pageSeen[pi]) missingPages.push(pi);
    if (missingPages.length) { R.complete = false; warn('빠진 쪽이 있어요(' + missingPages.join('·') + '쪽). 전체 PDF를 다시 골라 주세요.'); }
    else if (!R.complete && R.source === 'pdf') warn('끝 표시("이하여백")를 찾지 못했어요. 끝까지 읽었는지 몰라요.');

    // 표제부
    var titleRows = filter(rows, function (r) { return r.section === 'building' || r.section === 'land' || r.section === 'unit' || r.section === 'landRight' || r.section === 'title'; });
    var unitRows = filter(rows, function (r) { return r.section === 'unit'; });
    each(unitRows, function (r) {
      var b = (cellLines(r, 'building').length ? cellLines(r, 'building') : [rowText(r)]).join(' ');
      var m = /(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|제곱미터)/.exec(b);
      if (m) R.area = parseFloat(m[1]);
      var u = (cellLines(r, 'unitNo').length ? cellLines(r, 'unitNo') : [rowText(r)]).join(' ');
      var fm = /제?\s*([0-9지하B\-]+)\s*층\s*제?\s*([0-9A-Za-z가-힣\-]+?)\s*호/.exec(u);
      if (fm) { if (!R.floor) R.floor = fm[1]; if (!R.ho) R.ho = fm[2]; }
    });
    each(filter(rows, function (r) { return r.section === 'landRight'; }), function (r) {
      var t = (cellLines(r, 'ratio').length ? cellLines(r, 'ratio') : [rowText(r)]).join(' ');
      var m = /([\d.]+)\s*분\s*의\s*([\d.]+)/.exec(t);
      if (m) R.landShare = { num: parseFloat(m[2]), den: parseFloat(m[1]) };
    });
    if (titleRows.length) {
      var sepYes = false, sepGone = false;
      each(titleRows, function (r) {
        var c = compact(rowText(r));
        if (c.indexOf('별도등기') < 0) return;
        if (/별도등기[^있]{0,6}말소|별도등기말소/.test(c)) sepGone = true;
        if (/별도등기있음|토지별도등기(?!.*말소)/.test(c)) sepYes = true;
      });
      if (sepYes && sepGone) { R.landSeparate = null; warn('표제부에 토지별도등기와 그 말소가 함께 있어요. 지금도 남아 있는지 원본을 직접 보세요.'); }
      else R.landSeparate = sepYes;
    } else warn('표제부를 찾지 못했어요.');

    // 갑구·을구 기록
    var gap = map(gapRows, entryFromRow), eul = map(eulRows, entryFromRow), all = gap.concat(eul);
    var bySec = { gap: {}, eul: {} };
    var provFulfilled = false;
    each(all, function (e) {
      e.kind = classify(e);
      if (e.section === 'gap' && !e.sub) {
        if (e.kind === 'ownership' || e.kind === 'trust') e.op = ownershipOp(e.purposeC) || { op: 'transfer' };
        else if (e.kind === 'cancel') {
          // "소유권이전 / 2번신탁등기말소"(신탁재산의 귀속)처럼 한 행에 소유권이전과 말소가 함께 있는 경우
          var head = e.purposeC.split(/\d{1,4}(?:-\d{1,3})?번/)[0];
          if (/소유권(보존|이전)/.test(head)) e.op = ownershipOp(head);
        } else if (e.kind === 'provisional' && /가등기.*소유권이전/.test(e.purposeC)) {
          // 가등기에 기한 본등기(같은 순위번호 행 아래에 "소유권이전"): 가등기는 이미 실행됨 → 소유권 이전으로 본다
          e.fulfilled = true;
          e.op = { op: 'transfer' };
          var ds = cellDates(gapRows[gap.indexOf(e)], 'receipt');
          if (ds.length > 1) e.receiptDate = ds[ds.length - 1];
          provFulfilled = true;
          warn('갑구 ' + e.rank + '번은 가등기에 기한 본등기(소유권이전)가 함께 있어요. 앱은 가등기가 실행된 것으로 봤어요. 원본을 직접 보세요.');
        }
      }
      if (e.section === 'eul') eulFields(e);
      else if (e.kind !== 'ownership' && e.kind !== 'nameChange') gapRiskFields(e);
      if (!e.rank) warn((e.section === 'gap' ? '갑구' : '을구') + '에 순위번호를 못 읽은 행이 있어요.');
      else bySec[e.section][e.rank] = e;
    });
    // 부기는 주등기의 종류를 따른다
    each(all, function (e) {
      if (e.sub && e.kind === 'sub') {
        var p = bySec[e.section][e.parent];
        if (!p) warn((e.section === 'gap' ? '갑구 ' : '을구 ') + e.rank + '번의 주등기(' + e.parent + '번)를 찾지 못했어요.');
      }
    });
    // 말소 판정
    var unresolved = { gap: [], eul: [] };
    function mark(t, by) {
      if (t.cancelled) return;
      t.cancelled = true;
      t.cancelledBy = by;
    }
    each(all, function (e) {
      if (e.kind !== 'cancel') return;
      var ts = cancelTargets(e.purposeC), bad = !ts.length;
      each(ts, function (t) {
        var sec = t.section || e.section, target = bySec[sec][t.rank];
        var by = (sec !== e.section ? (e.section === 'gap' ? '갑구 ' : '을구 ') : '') + e.rank;
        if (!target || target === e) { bad = true; return; }
        mark(target, by);
        if (!target.sub) each(all, function (s) { if (s.section === sec && s.sub && s.parent === target.rank) mark(s, by); });
      });
      if (bad) {
        unresolved[e.section].push(e);
        warn((e.section === 'gap' ? '갑구 ' : '을구 ') + e.rank + '번 "' + e.purpose + '"이(가) 어느 기록을 지웠는지 찾지 못했어요. 그 종류는 직접 보세요.');
      }
    });
    // 부기 → 주등기 정보 갱신(근저당 이전·채무자 변경·최고액 변경)
    each(eul, function (e) {
      if (!e.sub || e.cancelled) return;
      var p = bySec.eul[e.parent];
      if (!p) return;
      if (/이전/.test(e.purposeC) && e.holder) p.holder = e.holder;
      if (/변경|경정/.test(e.purposeC)) {
        if (e.debtor) p.debtor = e.debtor;
        if (e.maxAmount) p.maxAmount = e.maxAmount;
      }
    });
    // 남은 기록 · 지난 기록
    var riskKinds = { trust: 1, seizure: 1, injunction: 1, auction: 1, provisional: 1, lease: 1, mortgage: 1, jeonse: 1, other: 1 };
    var otherLive = { gap: 0, eul: 0 };
    each(all, function (e) {
      e.text = entryText(e);
      var k = e.kind;
      if (e.sub && k === 'other') { /* 부기 금지사항·환매특약 등 */ }
      else if (e.sub || !riskKinds[k] || e.fulfilled) return;
      if (e.cancelled) R.history[k].push(brief(e));
      else {
        R.live[k].push(brief(e));
        if (k === 'other') {
          otherLive[e.section]++;
          if (e.leaseSet) warn('을구 ' + e.rank + '번 "' + e.purpose + '"은(는) 합의로 한 임차권 등기예요(임차권등기명령과 달라요). 임차인·보증금을 원본에서 직접 보세요.');
          else warn((e.section === 'gap' ? '갑구 ' : '을구 ') + e.rank + '번 "' + (e.purpose || '(목적 없음)') + '"은(는) 앱이 아는 종류가 아니에요. 원본을 직접 보세요.');
        }
      }
    });
    R.gap = map(gap, publicEntry);
    R.eul = map(eul, publicEntry);

    // 소유자
    var ow = computeOwners(gap, warn);
    R.owners = map(ow.owners, function (o) {
      var x = { name: o.name, share: fracStr(o.share), since: o.since || '', cause: o.cause || '', price: o.price || null, rank: o.rank };
      if (o.foreign) x.foreign = o.foreign;
      if (o.trustee) x.trustee = true;
      if (o.firstSince) x.firstSince = o.firstSince; // 1.8.0 검토 반영: 예전에도 이 집 소유자였음(처음 소유자가 된 접수일)
      return x;
    });

    // ---------- 답 ----------
    var A = R.answers, C = R.confidence;
    function set(id, v, conf) { A[id] = v; C[id] = low ? 'low' : conf; }
    var gapOk = gapRows.length > 0;
    // 1.6.0 검토 반영: 을구 제목만 보고 "없음"으로 답하지 않는다. 행을 읽었거나 "기록사항 없음"을 봤을 때만 을구를 안다
    var eulSeen = !!meta.sections.eul;
    var eulKnown = eulRows.length > 0 || !!meta.emptySections.eul;
    var partial = !R.complete;
    // 섹션 안인데 표 머리를 못 알아봐 칸으로 나누지 못한 줄(extractRows meta.lost): 그 섹션의 "없음"은 확신 낮음
    var lost = meta.lost || {};
    var titleLost = (lost.building || 0) + (lost.land || 0) + (lost.unit || 0) + (lost.landRight || 0) + (lost.title || 0);
    each([['gap', '갑구'], ['eul', '을구']], function (x) {
      if (lost[x[0]]) warn(x[1] + ' 표의 줄 ' + lost[x[0]] + '개를 칸으로 나누지 못했어요(표 머리를 못 알아봄). ' + x[1] + '의 "없음" 답은 확실하지 않아요. 원본을 직접 보세요.');
    });
    if (titleLost) warn('표제부 표의 줄 ' + titleLost + '개를 칸으로 나누지 못했어요. 표제부(토지별도등기·전유면적)는 원본을 직접 보세요.');
    // 소유자 계산이 불확실(지분 계산·이름 못 읽음 + 갑구 줄을 놓침 + 무엇을 지웠는지 모르는 소유권 말소): 앱이 매도인 비교로 "없음"을 넣지 않게
    var ownersUncertain = ow.uncertain || !!lost.gap || some(unresolved.gap, function (e) {
      return !kindsIn(e.purposeC).length || /소유권|지분/.test(e.purposeC);
    });
    R.ownersUncertain = !!ownersUncertain;

    set('reg-view', true, 'high');
    if (R.viewedAt) set('reg-date', true, 'high');

    // 표제부 일치(매물 정보를 받았을 때만)
    var ex2 = opts.expect;
    if (ex2 && (ex2.dong || ex2.ho || ex2.area)) {
      var diffs = [];
      var nd = function (v) { return compact(v).replace(/^제/, '').replace(/(동|호)$/, '').toUpperCase(); };
      if (ex2.dong && R.dong && nd(ex2.dong) !== nd(R.dong)) diffs.push('동(매물 ' + ex2.dong + ' / 등기부 ' + R.dong + ')');
      if (ex2.ho && R.ho && nd(ex2.ho) !== nd(R.ho)) diffs.push('호(매물 ' + ex2.ho + ' / 등기부 ' + R.ho + ')');
      if (ex2.area && R.area && Math.abs(+ex2.area - R.area) > 0.1) diffs.push('전용면적(매물 ' + ex2.area + '㎡ / 등기부 ' + R.area + '㎡)');
      var missing = (ex2.dong && !R.dong) || (ex2.ho && !R.ho) || (ex2.area && !R.area);
      if (diffs.length) warn('표제부가 매물 정보와 달라요: ' + diffs.join(', ') + '. 다른 집 등기부인지 확인하세요.');
      else if (!missing) set('reg-title', true, 'high');
    }

    // 토지별도등기
    if (R.landSeparate === true) set('reg-land-separate', 'yes', 'high');
    else if (R.landSeparate === false) set('reg-land-separate', 'no', partial || titleLost ? 'low' : 'high');

    // 소유자
    if (ow.seen && R.owners.length && !ownersUncertain) {
      set('reg-joint', true, 'high');
      if (!some(R.owners, function (o) { return !o.since; })) set('reg-period', true, 'high');
    }
    if (opts.seller && R.owners.length) {
      var sk = compact(opts.seller), hit = some(R.owners, function (o) { return compact(o.name) === sk; });
      if (hit) set('reg-owner-diff', 'no', R.owners.length === 1 && !ownersUncertain ? 'high' : 'low');
      else set('reg-owner-diff', 'yes', 'low');
    }

    // 갑구 멈춤 신호
    var gapUnres = unresolved.gap, eulUnres = unresolved.eul;
    function affected(list, kind) {
      return some(list, function (e) { var ks = kindsIn(e.purposeC); return !ks.length || ks.indexOf(kind) >= 0; });
    }
    function answerKind(kind, id, sectionOk, unres, otherCount, lostCount) {
      if (!sectionOk) return;
      if (R.live[kind].length) {
        // 살아 있는 것으로 읽었는데, 무엇을 지웠는지 모르는 말소 기록이 그 종류일 수 있으면 비움
        if (affected(unres, kind)) return;
        set(id, 'yes', 'high');
      } else {
        set(id, 'no', partial || otherCount || unres.length || lostCount ? 'low' : 'high');
      }
    }
    each(keys(GAP_FLAGS), function (k) { answerKind(k, GAP_FLAGS[k], gapOk, gapUnres, otherLive.gap, lost.gap); });
    if (provFulfilled && A['reg-provisional'] === 'no') C['reg-provisional'] = 'low';
    if (!gapOk) warn('갑구를 찾지 못했어요. 멈춤 신호는 직접 보고 답해 주세요.');

    // 을구
    if (eulKnown || (R.complete && !eulSeen)) {
      if (!eulKnown) R.notes.push('을구(근저당·전세권 등)가 없어요. 소유권 말고 다른 권리 기록이 없다는 뜻이지만, 원본에서도 을구가 없는지 한 번 보세요.');
      each(keys(EUL_FLAGS), function (k) {
        answerKind(k, EUL_FLAGS[k], true, eulUnres, otherLive.eul, lost.eul);
        if (!eulKnown && A[EUL_FLAGS[k]] === 'no') C[EUL_FLAGS[k]] = 'low'; // 을구 제목을 못 봤으면 "없음"도 확인 필요
      });
    } else if (eulSeen) warn('을구 제목은 있는데 을구 표를 읽지 못했어요. 근저당·전세권·임차권등기는 직접 보고 답해 주세요.');
    else warn('을구를 찾지 못했어요. 근저당·전세권·임차권등기는 직접 보고 답해 주세요.');

    // 지난 기록
    var histCount = 0;
    each(HISTORY_KINDS, function (k) { histCount += R.history[k].length; });
    if (R.includesCancelled === true) {
      if (histCount) set('reg-history', 'yes', 'high');
      else if (!some(HISTORY_KINDS, function (k) { return affected(gapUnres.concat(eulUnres), k); })) set('reg-history', 'no', partial || lost.gap || lost.eul || (eulSeen && !eulKnown) ? 'low' : 'high');
    } else if (R.includesCancelled === false) {
      R.notes.push('현재 유효사항으로 열람한 등기부라 지워진 지난 기록이 보이지 않아요. "지난 기록"은 말소사항 포함으로 다시 열람해 보세요.');
    }

    // 잦은 소유자 변경(열람일 기준 최근 2년 안 소유권 변경 2회 이상)
    var ref = (R.viewedAt || opts.today || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ref) && gapOk) {
      var from = (+ref.slice(0, 4) - 2) + ref.slice(4);
      var dates = {};
      each(gap, function (e) {
        if (e.cancelled || !e.op || e.op.op === 'preserve' || !e.receiptDate) return;
        // 신탁·신탁재산의 귀속은 새 아파트 분양 때 흔한 절차라 세지 않는다
        if (e.kind === 'trust' || /신탁/.test(compact(e.cause))) return;
        if (e.receiptDate >= from && e.receiptDate <= ref) dates[e.receiptDate] = 1;
      });
      var n = keys(dates).length;
      var ownersOld = R.owners.length && !some(R.owners, function (o) { return !o.since || o.since >= from; });
      if (n >= 2) set('reg-frequent', 'yes', 'high');
      else if (R.includesCancelled === false && !ownersOld) { /* 지난 소유권 기록이 안 보일 수 있어 비움 */ }
      else set('reg-frequent', 'no', partial || ownersUncertain ? 'low' : 'high');
      R.recentOwnerChanges = n;
    } else if (gapOk) warn('열람일시를 찾지 못해 "잦은 소유자 변경"은 답하지 않았어요.');

    // ---------- 사람이 읽을 요약 ----------
    buildNotes(R, ow, opts);
    return R;
  }

  function buildNotes(R, ow, opts) {
    var N = [];
    var head = [];
    if (R.includesCancelled === true) head.push('말소사항 포함');
    else if (R.includesCancelled === false) head.push('현재 유효사항');
    if (R.docType) head.push(R.docType);
    if (R.viewedAt) head.push(R.viewedAt.slice(0, 10) + (R.viewedAt.length > 10 ? ' ' + R.viewedAt.slice(11, 16) : '') + (R.docType === '제출용' ? ' 발행' : ' 열람'));
    if (head.length) N.push('등기사항전부증명서 · ' + head.join(' · '));
    var t = [];
    if (R.dong || R.ho) t.push((R.dong ? R.dong + '동 ' : '') + (R.floor ? R.floor + '층 ' : '') + (R.ho ? R.ho + '호' : ''));
    if (R.area) t.push('전용 ' + R.area + '㎡');
    if (R.landShare) t.push('대지권 ' + R.landShare.den + '분의 ' + R.landShare.num);
    if (t.length) N.push('표제부: ' + t.join(' · ') + (opts.expect ? '' : ' — 중개사가 말한 동·호수·전용면적과 같은지 보세요.'));
    if (R.landSeparate === true) N.push('표제부에 토지별도등기가 있어요. 땅에 걸린 권리를 따로 확인해야 해요.');
    if (R.owners.length) {
      var desc = map(R.owners, function (o) {
        return o.name + (o.foreign ? '(' + o.foreign + ')' : '') + ' ' + o.share + (o.trustee ? ' · 수탁자' : '');
      }).join(', ');
      var o0 = R.owners[0];
      var when = o0.since ? ' · ' + o0.since + (o0.cause ? ' ' + o0.cause : '') + '로 취득' : '';
      var price = o0.price ? ' · 거래가액 ' + formatWon(o0.price) : '';
      N.push((R.owners.length > 1 ? '공동명의 ' + R.owners.length + '명: ' : '소유자: ') + desc + (R.owners.length === 1 ? when + price : '') +
        (ow.uncertain ? ' (지분 계산이 불확실해요)' : ''));
      if (R.owners.length > 1) N.push('공동명의라 소유자 모두가 계약에 동의해야 해요(못 오는 사람은 위임장·인감증명서).');
      if (!opts.seller) N.push('중개사가 말한 매도인 이름이 위 소유자와 같은지 직접 비교하세요(소유자 ≠ 매도인).');
    }
    each(['trust', 'seizure', 'injunction', 'auction', 'provisional', 'lease'], function (k) {
      if (!R.live[k].length) return;
      N.push('멈춤 신호 · 살아 있는 ' + KIND_LABEL[k] + ': ' + map(R.live[k], function (b) {
        return (b.section === 'gap' ? '갑구 ' : '을구 ') + b.rank + '번 ' + b.purpose + (b.receiptDate ? '(' + b.receiptDate + ' 접수' + (b.amount ? ', ' + formatWon(b.amount) : '') + ')' : '');
      }).join(', '));
    });
    if (R.live.mortgage.length) {
      var total = 0;
      N.push('근저당 ' + R.live.mortgage.length + '건: ' + map(R.live.mortgage, function (b) {
        if (b.maxAmount) total += b.maxAmount;
        var est = b.maxAmount ? estimatePrincipal(b.maxAmount) : null;
        return '을구 ' + b.rank + '번 채권최고액 ' + (b.maxAmount ? formatWon(b.maxAmount) : '?') + (b.holder ? '(' + b.holder + ')' : '') +
          (est && est.ok && est.likely ? ' — ' + est.likely.percent + '%로 보면 원금 약 ' + formatWon(est.likely.principal) : '');
      }).join(', ') + '. 실제 남은 빚은 매도인의 대출 잔액 증명서로 확인하세요.');
    }
    if (R.live.jeonse.length) N.push('전세권 ' + R.live.jeonse.length + '건: ' + map(R.live.jeonse, function (b) { return '을구 ' + b.rank + '번' + (b.deposit ? ' 전세금 ' + formatWon(b.deposit) : ''); }).join(', '));
    var hist = [];
    each(HISTORY_KINDS, function (k) { if (R.history[k].length) hist.push(KIND_LABEL[k] + ' ' + R.history[k].length + '건(' + map(R.history[k], function (b) { return (b.section === 'gap' ? '갑구 ' : '을구 ') + b.rank + '번'; }).join('·') + ')'); });
    if (hist.length) N.push('지난 기록(말소됨): ' + hist.join(', ') + '. 지금은 풀렸지만 언제 왜 생겼는지 물어보세요.');
    var common = R.history.mortgage.length + R.history.trust.length + R.history.jeonse.length;
    if (common) N.push('말소된 근저당·신탁·전세권 ' + common + '건은 흔한 기록이라 "지난 기록"으로 세지 않았어요.');
    N.push('위반건축물은 등기부에 나오지 않아요. 건축물대장(정부24·세움터)에서 따로 보세요.');
    Array.prototype.unshift.apply(R.notes, N);
  }

  // ---------- 3. 재열람 비교 ----------

  // 재열람 비교에서 "없음"을 말하려면 새 등기부의 멈춤 신호(등기부로 답하는 것)가 모두 확실해야 한다
  var STOP_IDS = ['reg-trust', 'reg-seizure', 'reg-injunction', 'reg-auction', 'reg-provisional', 'reg-lease'];
  /**
   * diffRegistry(prev, next) → { ok, newEntries, newRisks, cancelledSince, ownerChanged, changed, unsure, answer, summary, warnings }
   *   prev·next: parseRegistry 결과(또는 같은 모양: gap·eul 기록, owners, uniqueNo, viewedAt). 같은 순위번호인데 접수번호가 다르면 새 기록.
   *   순위번호가 없는 새 기록은 버리지 않는다: 앞 등기부에 같은 종류·접수일·목적의 기록이 없으면 새 기록으로 센다.
   *   changed = 살아 있는 새 기록(말소 기록 제외)이 있거나 소유자가 바뀜 → answer 'yes'(fin-reg-*-changed 후보)
   *   1.6.0 검토 반영 unsure = 새 등기부를 다 읽지 못함(next.complete === false, next.unsure, 또는 next.answers 가 있는데
   *     멈춤 신호 중 확신 낮음·빈칸이 있음). 그때 바뀐 것이 없으면 answer 는 null("없음"을 말하지 않는다)
   */
  function diffRegistry(prev, next) {
    try { return diffInner(prev, next); }
    catch (e) { return fail('internal', e); }
  }
  function nextUnsure(next) {
    if (next.complete === false || next.unsure === true) return true;
    var A = next.answers, C = next.confidence || {};
    if (!A || typeof A !== 'object') return false;
    return some(STOP_IDS, function (id) { return (A[id] !== 'yes' && A[id] !== 'no') || C[id] === 'low'; });
  }
  function entryKey(sec, e) { return sec + ':' + (e.kind || '') + ':' + (e.receiptDate || '') + ':' + compact(e.purpose); }
  function diffInner(prev, next) {
    if (!prev || !next || !prev.ok || !next.ok) return fail('bad-input');
    if (prev.uniqueNo && next.uniqueNo && prev.uniqueNo !== next.uniqueNo) return fail('different');
    var warnings = [];
    if (prev.viewedAt && next.viewedAt && next.viewedAt < prev.viewedAt) warnings.push('나중 등기부의 열람일시가 처음 등기부보다 앞서요. 순서를 바꿔 넣었는지 보세요.');
    var pmap = {}, pkeyAll = {}, pkeyUnranked = {};
    each(['gap', 'eul'], function (sec) {
      each(prev[sec] || [], function (e) {
        var k = entryKey(sec, e);
        pkeyAll[k] = e;
        if (e.rank) pmap[sec + ':' + e.rank] = e;
        else pkeyUnranked[k] = e; // 순위번호 없는 앞 기록은 종류·접수일·목적으로만 맞춘다
      });
    });
    var newEntries = [], newRisks = [], cancelledSince = [];
    var prevView = (prev.viewedAt || '').slice(0, 10);
    each(['gap', 'eul'], function (sec) {
      each(next[sec] || [], function (e) {
        var p = e.rank ? (pmap[sec + ':' + e.rank] || pkeyUnranked[entryKey(sec, e)]) : pkeyAll[entryKey(sec, e)];
        var isNew = !p || (p.receiptNo && e.receiptNo && p.receiptNo !== e.receiptNo);
        if (isNew) {
          // 처음 것이 현재 유효사항이면 그때 이미 지워진 기록은 안 보였던 것
          if (prev.includesCancelled === false && (e.cancelled || e.kind === 'cancel') && e.receiptDate && prevView && e.receiptDate <= prevView) return;
          var b = { section: sec, rank: e.rank, purpose: e.purpose, kind: e.kind, receiptDate: e.receiptDate, receiptNo: e.receiptNo, cancelled: e.cancelled, text: e.text };
          newEntries.push(b);
          if (!e.cancelled && e.kind !== 'cancel') newRisks.push(b);
        } else if (p && !p.cancelled && e.cancelled) {
          cancelledSince.push({ section: sec, rank: e.rank, purpose: e.purpose, kind: e.kind, cancelledBy: e.cancelledBy });
        }
      });
    });
    function ownersKey(r) {
      return map(r.owners || [], function (o) { return compact(o.name) + '=' + o.share; }).sort().join('|');
    }
    var ownerChanged = ownersKey(prev) !== ownersKey(next);
    var changed = newRisks.length > 0 || ownerChanged;
    var unsure = nextUnsure(next);
    var parts = [];
    var label = function (b) { return (b.section === 'gap' ? '갑구 ' : '을구 ') + (b.rank ? b.rank + '번 ' : '') + (b.purpose || '(부기)') + (b.receiptDate ? '(' + b.receiptDate + ' 접수)' : ''); };
    if (newRisks.length) parts.push('새 기록 ' + newRisks.length + '건: ' + map(newRisks, label).join(', '));
    if (cancelledSince.length) parts.push('그 사이 말소 ' + cancelledSince.length + '건: ' + map(cancelledSince, label).join(', '));
    parts.push(ownerChanged ? '소유자가 바뀌었어요(' + map(prev.owners || [], function (o) { return o.name + ' ' + o.share; }).join(', ') + ' → ' + map(next.owners || [], function (o) { return o.name + ' ' + o.share; }).join(', ') + ')' : '소유자 그대로');
    var summary = (changed ? '달라진 기록이 있어요. '
      : unsure ? '비교가 확실하지 않아요(새 등기부를 다 읽지 못했어요). 전체 PDF로 다시 비교하세요. '
        : (cancelledSince.length ? '새로 생긴 기록은 없어요. ' : '달라진 기록이 없어요. ')) + parts.join(' · ');
    return {
      ok: true, newEntries: newEntries, newRisks: newRisks, cancelledSince: cancelledSince,
      ownerChanged: ownerChanged, changed: changed, unsure: unsure, answer: changed ? 'yes' : (unsure ? null : 'no'),
      prevViewedAt: prev.viewedAt || null, nextViewedAt: next.viewedAt || null,
      summary: summary, warnings: warnings
    };
  }

  // ---------- 3'. 지난 기록의 시기(1.8.0) ----------

  // 지워진 지난 기록(reg-history 로 세는 압류·가압류·가처분·경매개시결정·가등기·주택임차권등기)이 지금 소유자가 사기 전 일인지,
  // 지금 소유자 때 일인지. 사기 전이면 예전 주인의 일이라 참고만, 지금 소유자 때면 매도인의 돈 문제 흔적이라 잔금 전 새 압류 위험.
  var ERA_LABEL = { before: '지금 소유자 전', current: '지금 소유자 때', unknown: '확인 필요' };
  var ERA_CHECK = ' 갑구 마지막 소유권이전 접수일과 기록 접수일을 직접 비교하세요.';
  function dotDate(d) { return d ? String(d).replace(/-/g, '.') : ''; }
  /**
   * 지난 기록 → [{ kind, section, rank, purpose, date, gone? }]. { 종류: [기록] }(해석기·등기부 코드) 또는 [{ kind, … }](앱 저장 기록).
   * 근저당·신탁·전세권·그 밖은 뺀다. gone: 앱이 붙인 표시(앞 등기부에 살아 있다가 나중 등기부에서 사라진 기록)
   */
  function historyRecords(h) {
    var out = [];
    function add(e, k) {
      if (HISTORY_KINDS.indexOf(k) < 0) return;
      var o = e && typeof e === 'object' ? e : {};
      var sec = o.section || o.part || '';
      var r = {
        kind: k, section: sec === 'gap' || sec === 'eul' ? sec : '', rank: clean(o.rank).slice(0, 12),
        purpose: clean(o.purpose).slice(0, 80), date: kDate(o.receiptDate || o.date), era: 'unknown', i: out.length
      };
      if (o.gone === true) r.gone = true;
      out.push(r);
    }
    if (isArray(h)) each(h, function (e) { if (e && typeof e === 'object') add(e, e.kind); });
    else if (h && typeof h === 'object') each(HISTORY_KINDS, function (k) { if (isArray(h[k])) each(h[k], function (e) { add(e, k); }); });
    return out;
  }
  /** 신탁 중인지(살아 있는 신탁 기록·수탁자 소유자·reg-trust 있음). 그때 등기부의 소유자는 수탁자라 '지금 소유자'로 나눌 수 없다 */
  function inTrust(x) {
    var live = x.live;
    if (isArray(live) && some(live, function (e) { return e && e.kind === 'trust'; })) return true;
    if (live && !isArray(live) && typeof live === 'object' && isArray(live.trust) && live.trust.length) return true;
    if (isArray(x.owners) && some(x.owners, function (o) { return o && o.trustee === true; })) return true;
    return !!(x.answers && x.answers['reg-trust'] === 'yes');
  }

  /**
   * classifyHistory(input) → { ok, ownerSince:'YYYY-MM-DD'|'', ownerSinceBasis, records:[{ kind, section, rank, purpose, date, era }],
   *     counts:{ before, current, unknown, total }, verdict, reason, unsure, summary, notes:[] }
   *   input: parseRegistry 결과 | 등기부 코드 기록(import-parser parseRegistryBlock 의 snapshot) | 앱 저장 기록(normalizeSnapshot)
   *     — 쓰는 값: owners[{ name, since, firstSince? }], history({ 종류:[{ receiptDate|date }] } | [{ kind, date }]), ownersUncertain,
   *       includesCancelled, live(신탁 확인), answers·confidence·complete·unsure(다 읽었는지: diffRegistry 의 nextUnsure 와 같은 기준),
   *       truncated(1.8.0 검토 반영: 앱이 기록 수 상한으로 일부를 버렸을 수 있음), ownerChanged(더 최근 등기부에서 소유자가 바뀜)
   *   기준일(ownerSince): 지금 소유자가 소유권을 얻은 접수일. 공동 소유자의 날이 다르면 가장 이른 날(그 뒤는 지금 소유자 중 누군가의 때).
   *     1.8.0 검토 반영: 지금 소유자가 예전에도 이 집 소유자였으면(firstSince: 신탁 뒤 돌아옴·되사기) 그 처음 날.
   *   기록일: 그 기록의 접수일. 기록일 >= 기준일 → 'current'(같은 날도 지금 소유자 때로 봄), < → 'before', 어느 쪽이든 모르면 'unknown'.
   *     1.8.0 검토 반영: 등기목적에 지금 소유자 이름이 있는 기록("2번○○지분가압류")은 날짜와 관계없이 'current'.
   *   ownerSinceBasis: 'owner'(한 날) | 'earliest'(공동 소유자 날이 다름) | 'no-owner' | 'no-date'(취득일 없는 소유자가 있음)
   *     | 'uncertain'(ownersUncertain: 지분 일부 이전 등) | 'trust'(신탁 중) | 'owner-changed'. 뒤의 다섯이면 기록이 'unknown'.
   *   verdict: 'none'(지워진 기록 없음) | 'before-only'(모두 지금 소유자 전, 등기부를 다 읽음) | 'has-current'(지금 소유자 때가 하나라도)
   *     | 'unknown'(그 밖: 기준일·기록일을 모름, 다 읽지 못함(unsure), 말소사항 포함이 아님(not-included — 기록이 적혀 있어도),
   *       기록이 잘렸을 수 있음(truncated)). reason 에 까닭. 'before-only' 는 이런 까닭이 하나도 없을 때만 낸다.
   *   summary: 화면·메모에 쓰는 한 줄(사람 이름 없음). 기록의 purpose 에는 이름이 들어갈 수 있다(이 기기 화면에서만 쓸 것).
   */
  function classifyHistory(input) {
    try { return classifyInner(input || {}); }
    catch (e) { return fail('internal', e); }
  }
  function classifyInner(x) {
    var owners = isArray(x.owners) ? filter(x.owners, function (o) { return o && typeof o === 'object' && (o.name || o.since || o.share); }) : [];
    // 1.8.0 검토 반영: 예전에도 이 집 소유자였던 사람(firstSince < since)은 처음 소유자가 된 날부터를 지금 소유자 때로 본다
    var returned = 0;
    var dates = map(owners, function (o) {
      var s = kDate(o.since), f = kDate(o.firstSince);
      if (s && f && f < s) { returned++; return f; }
      return s;
    });
    var since = '', basis;
    if (!owners.length) basis = 'no-owner';
    else if (some(dates, function (d) { return !d; })) basis = 'no-date';
    else {
      since = dates.slice().sort()[0];
      basis = some(dates, function (d) { return d !== since; }) ? 'earliest' : 'owner';
    }
    var ok = !!since;
    if (owners.length && x.ownerChanged === true) { ok = false; basis = 'owner-changed'; }
    else if (ok && x.ownersUncertain === true) { ok = false; basis = 'uncertain'; }
    else if (ok && inTrust(x)) { ok = false; basis = 'trust'; }
    var unsure = nextUnsure(x);
    var recs = historyRecords(x.history);
    var c = { before: 0, current: 0, unknown: 0, total: recs.length };
    var sameDay = 0, named = 0;
    // 1.8.0 검토 반영: 등기목적에 지금 소유자 이름이 있으면("2번○○지분가압류") 그 사람의 일 → 지금 소유자 때(날짜·기준일과 관계없이).
    // 소유자가 바뀌었거나 신탁 중이면(등기부의 소유자가 지금 소유자가 아님) 쓰지 않는다
    var names = basis === 'owner-changed' || basis === 'trust' ? [] :
      filter(map(owners, function (o) { return compact(o.name); }), function (k) { return k.length >= 2; });
    each(recs, function (r) {
      r.era = !ok || !r.date ? 'unknown' : (r.date >= since ? 'current' : 'before');
      if (r.era !== 'current' && names.length) {
        var pc = compact(r.purpose);
        if (pc && some(names, function (k) { return pc.indexOf(k) >= 0; })) { r.era = 'current'; named++; }
      }
      if (ok && r.date && r.date === since) sameDay++;
      c[r.era]++;
    });
    // 날짜 순(모르는 날짜는 뒤로), 같으면 들어온 순서
    recs.sort(function (a, b) {
      if (a.date !== b.date) return !a.date ? 1 : !b.date ? -1 : (a.date < b.date ? -1 : 1);
      return a.i - b.i;
    });
    each(recs, function (r) { delete r.i; });

    // 1.8.0 검토 반영: 'before-only'(→ 앱이 '참고'로 셈)는 의심할 까닭이 하나도 없을 때만. 현재 유효사항(기록이 적혀 있어도),
    // 기록이 잘렸을 수 있음(truncated)도 'unknown' 이다. 지금 소유자 때 기록이 하나라도 보이면 늘 'has-current'
    var verdict, reason = '';
    if (!recs.length) {
      if (x.includesCancelled === false) { verdict = 'unknown'; reason = 'not-included'; }
      else if (x.truncated === true) { verdict = 'unknown'; reason = 'truncated'; }
      else if (x.includesCancelled !== true) { verdict = 'unknown'; reason = 'cancelled-unknown'; }
      else if (unsure) { verdict = 'unknown'; reason = 'unsure'; }
      else verdict = 'none';
    } else if (c.current) verdict = 'has-current';
    else if (x.includesCancelled === false) { verdict = 'unknown'; reason = 'not-included'; }
    else if (!ok) { verdict = 'unknown'; reason = basis; }
    else if (c.unknown) { verdict = 'unknown'; reason = 'no-record-date'; }
    else if (x.truncated === true) { verdict = 'unknown'; reason = 'truncated'; }
    else if (unsure) { verdict = 'unknown'; reason = 'unsure'; }
    else verdict = 'before-only';

    var D = dotDate(since), n = c.total, s;
    // 이름으로 '때'가 된 기록이 기준일보다 앞이면 "(기준일부터)"를 붙이지 않는다(날짜와 꼬리표가 어긋나 보이지 않게)
    var earlyCurrent = some(recs, function (r) { return r.era === 'current' && r.date && since && r.date < since; });
    if (verdict === 'before-only') {
      s = '지워진 기록 ' + n + '건' + (n > 1 ? ' 모두' : '은') + ' 지금 소유자가 사기 전(' + D + ' 전) 일이에요. 참고만 하면 돼요.';
    } else if (verdict === 'has-current') {
      s = (n === 1 ? '지워진 기록 1건은' : c.current === n ? '지워진 기록 ' + n + '건 모두' : '지워진 기록 ' + n + '건 중 ' + c.current + '건은') +
        ' 지금 소유자 때' + (D && !earlyCurrent ? '(' + D + '부터)' : '') + ' 생겼어요. 잔금 당일 등기부를 다시 떼고 "잔금 전 새 권리가 생기면 해제" 특약을 넣으세요.' +
        (c.unknown ? ' 접수일을 모르는 ' + c.unknown + '건은 직접 보세요.' : '');
    } else if (verdict === 'none') {
      s = '압류·가압류·가처분·경매·가등기·임차권의 지워진 기록이 없어요.';
    } else if (reason === 'not-included') {
      s = n ? '현재 유효사항 등기부인데 지워진 기록 ' + n + '건이 적혀 있어요. 누구 때 일인지 정하지 않았어요. 원본 제목이 "말소사항 포함"인지 보세요.'
        : '현재 유효사항 등기부라 지워진 지난 기록이 보이지 않아요. "말소사항 포함"으로 열람해야 볼 수 있어요.';
    } else if (reason === 'truncated') {
      s = n ? '기록이 많아 앱이 일부만 남겼어요. 남은 지워진 기록 ' + n + '건은 지금 소유자가 사기 전(' + D + ' 전) 일이지만, 빠진 기록이 있을 수 있어 단정할 수 없어요. 원본을 직접 보세요.'
        : '기록이 많아 앱이 일부만 남겨, 지워진 지난 기록이 없는지 확실하지 않아요. 원본을 직접 보세요.';
    } else if (reason === 'cancelled-unknown') {
      s = '말소사항 포함 등기부인지 몰라 지워진 지난 기록이 없는지 확실하지 않아요.';
    } else if (reason === 'unsure') {
      s = n ? '보이는 지워진 기록 ' + n + '건은 지금 소유자가 사기 전(' + D + ' 전) 일이지만, 앱이 확실히 읽지 못한 부분이 있어 단정할 수 없어요. 원본을 직접 보세요.'
        : '보이는 지워진 기록은 없지만 앱이 확실히 읽지 못한 부분이 있어 단정할 수 없어요.';
    } else if (reason === 'no-record-date') {
      s = '지워진 기록 ' + n + '건 중 ' + c.unknown + '건은 접수일을 몰라 누구 때 일인지 정하지 못했어요.' +
        (c.before ? ' 나머지 ' + c.before + '건은 지금 소유자가 사기 전(' + D + ' 전) 일이에요.' : '') + ERA_CHECK;
    } else {
      s = ({
        'no-owner': '지금 소유자를 읽지 못해',
        'no-date': '지금 소유자가 언제 샀는지(접수일) 몰라',
        uncertain: '소유자 계산이 확실하지 않아(지분 일부 이전 등)',
        trust: '신탁된 집이라(등기부의 소유자는 수탁자)',
        'owner-changed': '더 최근 등기부에서 소유자가 바뀌어'
      }[reason] || '기준일을 정하지 못해') + ' 지워진 기록 ' + n + '건이 누구 때 일인지 정하지 못했어요.' + ERA_CHECK;
    }
    var notes = [];
    if (ok && basis === 'earliest' && n) notes.push('공동 소유자가 산 날이 달라 가장 이른 날(' + D + ')을 기준으로 나눴어요.');
    if (ok && returned && n) notes.push('지금 소유자가 예전에도 이 집을 가진 적이 있어(신탁 뒤 돌려받음·다시 삼 등) 처음 소유자가 된 날(' + D + ')부터를 지금 소유자 때로 봤어요.');
    if (named) notes.push('등기목적에 지금 소유자 이름이 나오는 기록 ' + named + '건은 지금 소유자의 일이라 지금 소유자 때로 봤어요.');
    if (sameDay) notes.push('지금 소유자가 산 날과 같은 날 접수된 기록 ' + sameDay + '건은 지금 소유자 때로 봤어요(같은 날은 접수번호로 앞뒤를 봐야 해요).');
    return {
      ok: true, ownerSince: since, ownerSinceBasis: basis, records: recs, counts: c,
      verdict: verdict, reason: reason, unsure: !!unsure, summary: s, notes: notes
    };
  }

  // ---------- 4. 채권최고액 → 원금 짐작 ----------

  /**
   * estimatePrincipal(maxAmount) → { ok, maxAmount, rates:[{ percent:110|120|130, principal, round }], likely, text }
   *   round = 원금이 10만 원 단위로 딱 떨어짐. 딱 떨어지는 비율이 하나뿐이면 likely 로 둔다(은행이 잡은 비율일 가능성이 큼).
   */
  function estimatePrincipal(maxAmount) {
    try {
      var n = typeof maxAmount === 'string' ? (won(maxAmount) || +maxAmount.replace(/[^\d]/g, '')) : +maxAmount;
      if (!isFinite(n) || n <= 0 || n % 1 || n > 1e13) return fail('bad-input');
      var rates = map([110, 120, 130], function (pct) {
        var exact = (n * 100) % pct === 0;
        var principal = exact ? (n * 100) / pct : Math.round((n * 100) / pct);
        return { percent: pct, principal: principal, round: exact && principal % 100000 === 0 };
      });
      var rounds = filter(rates, function (r) { return r.round; });
      var likely = rounds.length === 1 ? rounds[0] : null;
      var text;
      if (likely) text = '채권최고액 ' + formatWon(n) + '은 ' + likely.percent + '%로 보면 원금 ' + formatWon(likely.principal) + '에 딱 떨어져요.';
      else if (rounds.length > 1) text = '채권최고액 ' + formatWon(n) + ': ' + map(rounds, function (r) { return r.percent + '%면 ' + formatWon(r.principal); }).join(', ') + ' 둘 다 딱 떨어져요.';
      else text = '채권최고액 ' + formatWon(n) + ': 딱 떨어지는 비율이 없어요(' + map(rates, function (r) { return r.percent + '% 약 ' + formatWon(Math.round(r.principal / 10000) * 10000); }).join(', ') + ').';
      return { ok: true, maxAmount: n, rates: rates, likely: likely, text: text + ' 실제 남은 빚은 대출 잔액 증명서로 확인하세요.' };
    } catch (e) { return fail('internal', e); }
  }

  // ---------- 5. PDF.js 연결 ----------

  function toBytes(data) {
    if (!data) return null;
    if (typeof Uint8Array !== 'undefined') {
      if (data instanceof Uint8Array) return data;
      if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
      if (data.buffer && typeof data.byteLength === 'number') return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    }
    return null;
  }
  function looksPdf(b) {
    var n = Math.min(b.length - 4, 1024);
    for (var i = 0; i < n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true; // %PDF
    return false;
  }
  function slimItem(it) { return { str: it.str, transform: it.transform, width: it.width, height: it.height }; }

  /**
   * readPdf(pdfjsLib, data, opts) → Promise<{ ok, pages:[{ pageNo, items }], numPages } | { ok:false, error }>
   *   data: ArrayBuffer | Uint8Array. opts.workerSrc(브라우저에서 아직 정하지 않았으면 정함), opts.cMapUrl(한글 cMap 이
   *   필요한 PDF 일 때만). isEvalSupported:false 로 연다(PDF 안 글꼴로 코드를 만들지 않게, pdf.js 3.x 보안 권고).
   */
  function readPdf(pdfjsLib, data, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var doc = null, task = null, finished = false, timer = null;
      function done(r) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        try { if (doc) doc.destroy(); else if (task && task.destroy) task.destroy(); } catch (e) { /* 무시 */ }
        resolve(r);
      }
      // 일꾼(worker) 파일을 못 불러오면 PDF 탓이 아니므로 따로 알린다
      function why(e) {
        if (e && e.name === 'PasswordException') return 'password';
        return /worker/i.test(String(e && e.message)) ? 'no-pdfjs' : 'not-pdf';
      }
      timer = setTimeout(function () { done(fail('timeout')); }, opts.timeoutMs > 0 ? opts.timeoutMs : 30000);
      try {
        if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') return done(fail('no-pdfjs'));
        var bytes = toBytes(data);
        if (!bytes || !bytes.length) return done(fail('empty'));
        if (bytes.length > LIMITS.pdfBytes) return done(fail('too-big'));
        if (!looksPdf(bytes)) return done(fail('not-pdf'));
        if (opts.workerSrc && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = opts.workerSrc;
        // 받은 바이트는 일꾼에게 넘어가며 비워지므로 복사본을 넘긴다(앱이 원본을 계속 쓸 수 있게)
        var params = { data: bytes.slice ? bytes.slice(0) : bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 };
        if (opts.cMapUrl) { params.cMapUrl = opts.cMapUrl; params.cMapPacked = true; }
        task = pdfjsLib.getDocument(params);
        task.promise.then(function (d) {
          doc = d;
          if (d.numPages > LIMITS.pages) return done(fail('too-many-pages'));
          var pages = [], i = 0;
          (function next() {
            if (i >= d.numPages) return done({ ok: true, pages: pages, numPages: d.numPages });
            i++;
            d.getPage(i).then(function (page) {
              return page.getTextContent().then(function (tc) {
                pages.push({ pageNo: i, items: map(tc.items || [], slimItem) });
                try { page.cleanup(); } catch (e) { /* 무시 */ }
                next();
              });
            }).then(null, function (e) { done(fail(why(e), e)); });
          })();
        }, function (e) {
          done(fail(why(e), e));
        });
      } catch (e) { done(fail('internal', e)); }
    });
  }

  // PDF 바이트 → parseRegistry 결과(Promise)
  function parsePdf(pdfjsLib, data, opts) {
    return readPdf(pdfjsLib, data, opts).then(function (r) {
      if (!r.ok) return r;
      var ex = extractRows(r.pages, opts);
      if (!ex.ok) return ex;
      return parseRegistry(ex, opts);
    }, function (e) { return fail('internal', e); });
  }

  return {
    VERSION: VERSION,
    LIMITS: LIMITS,
    MESSAGES: MESSAGES,
    ITEM_IDS: ITEM_IDS,
    KINDS: KINDS,
    KIND_LABEL: KIND_LABEL,
    HISTORY_KINDS: HISTORY_KINDS,
    readPdf: readPdf,
    parsePdf: parsePdf,
    extractRows: extractRows,
    parseRegistry: parseRegistry,
    diffRegistry: diffRegistry,
    classifyHistory: classifyHistory, // 1.8.0
    ERA_LABEL: ERA_LABEL,             // 1.8.0
    estimatePrincipal: estimatePrincipal,
    formatWon: formatWon,
    parseDate: kDate
  };
});
