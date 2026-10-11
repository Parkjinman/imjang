/*
 * 임장 체크리스트 — merge.js
 * 두 기록(state)을 항목 단위로 합친다. 백업 불러오기 [합치기]와 여러 탭 동기화가 같은 규칙을 쓴다.
 *
 * - 브라우저: index.html 에서 import-parser.js 다음, app.js 전에 일반 스크립트로 불러온다 → window.ImjangMerge
 * - Node: 단위 시험에서 require 한다 → module.exports
 * - DOM·저장소를 쓰지 않는다. 받은 객체는 고치지 않고 새 객체를 돌려준다(fillTimes 만 받은 매물을 고쳐 쓴다).
 *
 * 변경 시각(1.3.0, 모두 ms)
 *   items[항목id].t        항목이 마지막으로 바뀐 시각(status·memo·answer·date·done 중 무엇이든). 값을 모두 지워도
 *                          { t, ft } 로 남긴다(지운 것도 기록해야 다른 기기의 예전 값이 되살아나지 않는다)
 *   items[항목id].ft       { 값 이름: 시각 } 항목 안의 값마다 바뀐 시각(예: 한 기기에서 '주의', 다른 기기에서 메모를
 *                          고쳐도 둘 다 남게). ft 가 없는 항목(예전 모양)은 모든 값이 t 에 바뀐 것으로 본다.
 *                          ft 에 없는 값은 그 매물의 legacyAt(없으면 0)에 바뀐 것으로 본다(1.3.1)
 *   fieldsAt[필드]         기본 정보(단지명·동·호·면적·가격·중개사·메모·링크·층·방향·공급면적)가 바뀐 시각. 필드마다 따로
 *   statusAt               진행 상태·탈락 사유가 바뀐 시각
 *   sectionMemoAt[섹션id]  섹션 메모가 바뀐 시각(지워도 남김)
 *   legacyAt(1.3.1)        시각이 없는 예전 기록(1.2.x 이하)을 처음 읽은 때의 updatedAt. "이 사본은 그때의 값을 모두
 *                          알고 있었다"는 뜻이라, 이 사본에 없는 항목·섹션 메모는 그때 비어 있던 것으로 본다.
 *                          그래서 1.2.x 에서 지운 항목(키째 사라짐)이 다른 기기의 예전 값으로 되살아나지 않는다
 *   시각이 없는 예전 기록(1.2.x 이하)은 legacyAt(= 그 매물의 updatedAt)으로 채운다.
 *
 * 시각 찍기(1.3.1): 새 시각은 늘 바꾸는 값의 시각보다 나중으로 찍는다(after). 그래서 한 기기의 시계가 늦어도
 * 합친 뒤에 고친 값·지운 매물이 방금 받은 값에 지지 않는다.
 *
 * 합치는 규칙
 *   - 기본 정보는 필드마다, 상태는 상태+탈락 사유 묶음으로, 항목은 항목 안의 값마다, 섹션 메모는 섹션마다
 *     더 나중 시각 쪽을 남긴다. 시각이 같으면 내 것(local).
 *   - 한쪽에만 있는 항목·섹션 메모는 그대로 남긴다(합집합). 단, 다른 쪽이 예전 기록(legacyAt)이고 그보다 전에
 *     바뀐 것이면 다른 쪽에서 지운 것으로 본다(1.2.x 의 "더 나중에 고친 매물이 이김"과 같은 결과).
 *   - 매물번호·확인매물·가져온 시각·출처는 비어 있지 않은 쪽, 둘 다 있으면 더 나중에 고친 매물 쪽.
 *   - 1.6.0 매도인 이름(sellerName)은 기본 정보처럼 fieldsAt 으로 비교한다. 다만 나중에 늘어난 칸이라, 시각이 없는 빈 값은
 *     "아직 몰랐다"(시각 0)로 본다(LATE_FIELDS) — 예전 버전 기기·탭의 사본이 다른 기기에서 먼저 적은 이름을 지우지 않게.
 *   - 1.6.0 등기부 해석 기록(registrySnapshots: [{ id, …, t }])은 id 합집합. 같은 id 는 t(없으면 addedAt)가 큰 쪽(같으면 내 것).
 *     지운 기록은 registrySnapshotsRemoved { 기록id: 지운 시각 } 합집합(큰 시각)으로 전하고, 지운 시각 뒤에 고친 기록이 아니면 뺀다.
 *     1.6.0 검토 반영: 열람 일시·고유번호·서류 종류가 같은 겹친 기록(두 기기에서 같은 PDF 를 따로 올림)은 하나로 줄인다(dedupeSnapshots).
 *   - 1.7.0 대출·비용 칸(KB시세·협상가·리모델링비·공시가격·네이버 참고값)은 기본 정보처럼 fieldsAt 으로 비교하고 모두 LATE_FIELDS.
 *     KB시세의 기준일·출처(kbAt·kbSource)는 KB시세를 고른 쪽 것을 같이 쓴다(FIELD_GROUPS). 값 이력(kbHistory·askHistory)은 합집합,
 *     syncAt({ 칸: 가져오기로 값을 넣은 시각 })은 칸마다 큰 쪽. 전역 대출 조건(state.settings)은 financeAt 이 더 나중인 쪽(mergeSettings).
 *   - 매물 삭제는 deleted { 매물id: 지운 시각 } 로 전한다. 지운 시각보다 나중에 고친 매물은 지우지 않고 남긴다.
 *     전체 삭제·[덮어쓰기]로 지운 것(app.js localDeleted)은 이 기기 일이라 여기서 다루지 않는다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangMerge = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // 기본 정보(폼에서 고치는 칸 + 가져오기 코드의 공급면적). fieldsAt 의 키
  // 1.6.0: sellerName(매도인 이름. 등기부 소유자와 비교에 씀) 추가
  // 1.7.0: 대출·비용 칸. KB시세(kbPrice, 만원)·협상가(dealPrice)·리모델링비(remodelCost)·공시가격(publicPrice)은 사용자가 넣거나 고치고,
  //   네이버 참고값(대출 한도·금리·관리비·세금)은 가져오기와 [바꾸기](다시 붙여넣기)가 바꾼다. 모두 필드마다 더 나중에 바꾼 쪽
  var FIN_FIELDS = ['kbPrice', 'dealPrice', 'remodelCost', 'publicPrice', 'naverLoanLimit', 'naverRate',
    'feeMonthly', 'feeAvg', 'feeSummer', 'feeWinter', 'feeRecent', 'acqTaxNaver', 'propertyTaxNaver'];
  var FIELDS = ['name', 'dong', 'ho', 'area', 'supplyArea', 'floor', 'direction', 'askPrice', 'realPrice',
    'agentName', 'agentPhone', 'memo', 'sourceUrl', 'sellerName'].concat(FIN_FIELDS);
  // 1.6.0: FIELDS 가운데 나중에 늘어난 칸. 시각(fieldsAt)이 없는 빈 값은 "그때 비어 있었다"가 아니라 "아직 몰랐다"(시각 0)로 본다.
  // 그러지 않으면 예전 버전(1.5.x) 기기·탭이 쓴 사본의 빈 값이 그 사본의 updatedAt 을 시각으로 얻어, 다른 기기에서 먼저 적은 이름을 지운다
  // 1.7.0: 대출·비용 칸도 모두 나중에 늘어난 칸(예전 버전 사본은 이 칸을 모른다)
  var LATE_FIELDS = { sellerName: 1 };
  FIN_FIELDS.forEach(function (f) { LATE_FIELDS[f] = 1; });
  // 1.7.0: 함께 움직이는 칸. KB시세를 고른 쪽의 기준일(kbAt)·출처(kbSource)를 같이 쓴다(값과 날짜가 엇갈리지 않게)
  var FIELD_GROUPS = { kbPrice: ['kbAt', 'kbSource'] };
  // 1.7.0: 값 이력(KB시세·호가). [{ value, at('YYYY-MM-DD'), source('naver'|'code'|'manual'), t(ms, 있으면) }] 합집합.
  // 날짜·값·출처·시각이 모두 같은 것만 하나로, 순서는 시각(t) → 날짜 → 값. 최근 HISTORY_MAX 개만
  var HISTORY_FIELDS = ['kbHistory', 'askHistory'];
  var HISTORY_MAX = 20;
  // 1.7.0: { 칸: ms } 꼴의 시각 묶음. 칸마다 큰 쪽(합집합). syncAt = 가져오기·다시 붙여넣기가 그 칸에 값을 마지막으로 넣은 시각
  // (fieldsAt 이 그보다 나중이면 손으로 고친 값 → 다시 붙여넣기가 덮어쓰기 전에 묻는다)
  var TIME_MAP_FIELDS = ['syncAt'];
  // 진행 상태 묶음. statusAt 하나로 함께 움직인다(탈락 사유는 상태와 같이 정해지므로)
  var STATUS_FIELDS = ['status', 'dropReason'];
  // 가져오기 코드가 채우는 값. 사용자가 고치지 않으므로 시각 없이 "비어 있지 않은 쪽"
  // 1.5.0: importNotes(가져오기 참고, 문자열 배열) 추가. 빈 배열은 빈 값으로, 같은 내용의 배열은 같은 값으로 본다(blank·sameVal)
  var OTHER_FIELDS = ['articleNo', 'confirmedAt', 'importedAt', 'source', 'importNotes'];
  // 항목 상태의 값 필드(t·ft 는 시각)
  var ITEM_FIELDS = ['status', 'memo', 'answer', 'date', 'done'];
  var KEEP_MS = 180 * 24 * 60 * 60 * 1000; // 삭제 표시·지운 매물 열쇠 보관 기간(app.js TOMBSTONE_KEEP_MS 와 같음)
  var GONE_KEYS_MAX = 600;                  // 지운 매물 열쇠 최대 개수(app.js GONE_KEYS_MAX 와 같음)
  var BAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };

  // ---------------- 작은 도구 ----------------
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return hasOwn(o, k) ? o[k] : undefined; }
  /** 시각(ms) 값: 양수만 받고 그 밖은 0 */
  function ms(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
    return isFinite(n) && n > 0 ? n : 0;
  }
  /**
   * 새로 찍을 시각: now 와, 앞선 시각들보다 1ms 나중 중 큰 값(1.3.1).
   * 고친 값이 늘 그 값이 바꾼 값보다 나중 시각을 갖게 한다(기기 시계가 다른 기기보다 늦어도 마지막에 고친 값이 이김)
   */
  function after(now) {
    var t = ms(now) || Date.now();
    for (var i = 1; i < arguments.length; i++) {
      var p = ms(arguments[i]);
      if (p && p >= t) t = p + 1;
    }
    return t;
  }
  function blank(v) { return v === '' || v === null || v === undefined || v === false || (Array.isArray(v) && !v.length); }
  /** 빈 값('' null undefined false 빈 배열)끼리는 같다고 본다. 1.5.0: 문자열 배열(importNotes)은 내용이 같으면 같다 */
  function sameVal(a, b) {
    if (a === b || (blank(a) && blank(b))) return true;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    if (isObj(a) && isObj(b)) return stable(a) === stable(b); // 1.7.0: 작은 객체 값(naverRate·feeRecent)은 내용으로
    return false;
  }
  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function set(o, k, v) { if (v === undefined) delete o[k]; else o[k] = v; }

  /** 여러 객체의 키 합집합(앞 객체의 순서 먼저). 위험한 키는 뺀다 */
  function unionKeys() {
    var out = [];
    var seen = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!isObj(o)) continue;
      Object.keys(o).forEach(function (k) {
        if (BAD_KEYS[k] || hasOwn(seen, k)) return;
        seen[k] = true;
        out.push(k);
      });
    }
    return out;
  }

  /** 항목 상태에서 값만(시각 빼고) */
  function itemContent(v) {
    var o = {};
    if (!isObj(v)) return o;
    ITEM_FIELDS.forEach(function (f) { if (!blank(v[f])) o[f] = v[f]; });
    return o;
  }
  function hasContent(v) { return Object.keys(itemContent(v)).length > 0; }
  function sameItem(a, b) {
    var x = itemContent(a);
    var y = itemContent(b);
    return ITEM_FIELDS.every(function (f) { return sameVal(x[f], y[f]); });
  }

  /** 두 매물의 내용이 같은지(시각·id 는 보지 않음) */
  function sameProperty(a, b) {
    if (!isObj(a) || !isObj(b)) return a === b;
    var keys = FIELDS.concat(STATUS_FIELDS, OTHER_FIELDS, FIELD_GROUPS.kbPrice);
    for (var i = 0; i < keys.length; i++) if (!sameVal(a[keys[i]], b[keys[i]])) return false;
    for (var tm = 0; tm < TIME_MAP_FIELDS.length; tm++) { // 1.7.0
      if (stable(timeMap(a[TIME_MAP_FIELDS[tm]], 0)) !== stable(timeMap(b[TIME_MAP_FIELDS[tm]], 0))) return false;
    }
    for (var h = 0; h < HISTORY_FIELDS.length; h++) { // 1.7.0: 값 이력
      if (stable(histList(a[HISTORY_FIELDS[h]])) !== stable(histList(b[HISTORY_FIELDS[h]]))) return false;
    }
    var ik = unionKeys(a.items, b.items);
    for (var j = 0; j < ik.length; j++) if (!sameItem(own(a.items, ik[j]), own(b.items, ik[j]))) return false;
    var mk = unionKeys(a.sectionMemos, b.sectionMemos);
    for (var m = 0; m < mk.length; m++) if (!sameVal(own(a.sectionMemos, mk[m]), own(b.sectionMemos, mk[m]))) return false;
    return sameSnapshots(a, b); // 1.6.0: 등기부 해석 기록과 지운 기록 표시
  }

  // ---------------- 1.6.0 등기부 해석 기록(registrySnapshots) ----------------
  /** 기록 목록: 배열이고 id 가 있는 객체만(없으면 빈 배열) */
  function snapList(v) {
    return Array.isArray(v) ? v.filter(function (s) { return isObj(s) && !blank(s.id) && !BAD_KEYS[s.id]; }) : [];
  }
  /** 기록이 마지막으로 바뀐 시각(t, 없으면 addedAt) */
  function snapT(s) { return ms(s.t) || ms(s.addedAt); }
  /** 키 순서와 상관없이 같은 내용이면 같은 글자(비교용) */
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function snapKey(list) {
    return stable(list.slice().sort(function (x, y) { return str(x.id) < str(y.id) ? -1 : str(x.id) > str(y.id) ? 1 : 0; }));
  }
  function sameSnapshots(a, b) {
    return snapKey(snapList(a.registrySnapshots)) === snapKey(snapList(b.registrySnapshots)) &&
      stable(timeMap(a.registrySnapshotsRemoved, 0)) === stable(timeMap(b.registrySnapshotsRemoved, 0));
  }
  /**
   * 두 사본의 등기부 해석 기록 합치기 → { list, removed, n(받은 쪽 덕분에 들어오거나 바뀐 기록 수) }.
   * id 합집합, 같은 id 는 t 가 큰 쪽(같으면 내 것). 지운 기록 표시(removed)도 합집합(큰 시각)이고,
   * 지운 시각 이후에 고친(t 가 더 큰) 기록이 아니면 뺀다. 순서는 만든 시각(addedAt)·id 순(어느 쪽에서 합쳐도 같게)
   */
  function mergeSnapshots(L, I) {
    var removed = unionMax(timeMap(L.registrySnapshotsRemoved, 0), timeMap(I.registrySnapshotsRemoved, 0));
    var pick = {};
    var fromI = {};
    snapList(L.registrySnapshots).forEach(function (s) { if (!hasOwn(pick, s.id)) pick[s.id] = s; });
    snapList(I.registrySnapshots).forEach(function (s) {
      var cur = own(pick, s.id);
      if (!cur || snapT(s) > snapT(cur)) {
        if (!cur || stable(cur) !== stable(s)) fromI[s.id] = true;
        pick[s.id] = s;
      }
    });
    var list = [];
    Object.keys(pick).forEach(function (id) {
      var s = pick[id];
      if (own(removed, id) && removed[id] >= snapT(s)) return;
      list.push(clone(s));
    });
    // 1.6.0 검토 반영: 두 기기에서 같은 등기부를 따로 올려 생긴 겹친 기록은 하나로
    list = dedupeSnapshots(list);
    var n = 0;
    list.forEach(function (s) { if (fromI[s.id]) n++; });
    list.sort(function (x, y) { return (ms(x.addedAt) - ms(y.addedAt)) || (str(x.id) < str(y.id) ? -1 : str(x.id) > str(y.id) ? 1 : 0); });
    return { list: list, removed: removed, n: n };
  }
  /**
   * 1.6.0 검토 반영: 같은 등기부를 두 기기에서(또는 한 기기에서 두 번) 따로 올려 생긴 겹친 기록 — 열람 일시·고유번호·서류 종류가
   * 같고 id 만 다른 것 — 을 하나로 줄인다(열람 일시가 없는 기록은 줄이지 않음). 남는 것은 t 가 큰 쪽(같으면 id 가 작은 쪽).
   * 남는 기록에 서류(docId)가 없으면 버리는 쪽 것을 잇고, 앱이 넣은 답 표시(applied)는 항목마다 시각이 큰 것을 합친다.
   * 어느 기기에서, 어떤 순서로 합쳐도 같은 결과가 나온다. 결과: 새 배열(합친 기록만 사본, 나머지는 받은 객체 그대로)
   */
  function dedupeSnapshots(list) {
    var groups = {};
    var order = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (!isObj(s)) return;
      var v = ms(s.viewedAt);
      var k = v ? 'v' + v + '|' + str(s.uniqueNo) + '|' + str(s.docType) : 'i' + str(s.id);
      if (!hasOwn(groups, k)) { groups[k] = []; order.push(k); }
      groups[k].push(s);
    });
    var out = [];
    order.forEach(function (k) {
      var g = groups[k];
      if (g.length === 1) { out.push(g[0]); return; }
      g.sort(function (x, y) { return (snapT(y) - snapT(x)) || (str(x.id) < str(y.id) ? -1 : str(x.id) > str(y.id) ? 1 : 0); });
      var keep = clone(g[0]);
      g.slice(1).forEach(function (s) {
        if (!keep.docId && s.docId) keep.docId = s.docId;
        if (!isObj(s.applied)) return;
        if (!isObj(keep.applied)) keep.applied = {};
        Object.keys(s.applied).forEach(function (id) {
          var a = s.applied[id];
          var b = own(keep.applied, id);
          if (BAD_KEYS[id] || !isObj(a)) return;
          if (!isObj(b) || ms(a.t) > ms(b.t)) keep.applied[id] = clone(a);
        });
        if (ms(s.appliedAt) > ms(keep.appliedAt)) keep.appliedAt = s.appliedAt;
      });
      out.push(keep);
    });
    return out;
  }

  // ---------------- 1.7.0 값 이력(kbHistory·askHistory) ----------------
  var HIST_SOURCES = { naver: 1, code: 1, manual: 1 };
  /** 이력 목록: 배열이고 value 가 유한한 수인 객체만(없으면 빈 배열) */
  function histList(v) {
    return Array.isArray(v) ? v.filter(function (e) { return isObj(e) && typeof e.value === 'number' && isFinite(e.value); }) : [];
  }
  // 같은 기록인지: 날짜·값·출처·시각(t). 같은 날 값이 돌아온 것(2억 3,000 → 2억 3,450 → 2억 3,000)도 따로 남는다
  function histKey(e) { return str(e.at) + '|' + e.value + '|' + (HIST_SOURCES[e.source] ? e.source : '') + '|' + ms(e.t); }
  function histCmp(x, y) {
    return (ms(x.t) - ms(y.t)) || (str(x.at) < str(y.at) ? -1 : str(x.at) > str(y.at) ? 1 : 0) || (x.value - y.value) ||
      (str(x.source) < str(y.source) ? -1 : str(x.source) > str(y.source) ? 1 : 0);
  }
  /**
   * 두 이력의 합집합. 날짜·값·출처·시각이 같은 기록은 하나로, 순서는 t → 날짜 → 값 → 출처.
   * 어느 기기에서 어떤 순서로 합쳐도 같은 결과. 넘치면 최근 HISTORY_MAX 개. 결과는 새 배열(사본)
   */
  function mergeHistory(a, b) {
    var pick = {};
    histList(a).concat(histList(b)).forEach(function (e) {
      var k = histKey(e);
      if (!hasOwn(pick, k) || histCmp(e, pick[k]) < 0) pick[k] = e;
    });
    var out = Object.keys(pick).map(function (k) { return clone(pick[k]); });
    out.sort(histCmp);
    return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
  }

  /**
   * 1.7.0: 전역 대출 조건(state.settings = { finance: {…}, financeAt: ms }) 두 사본 중 더 나중에 바꾼 쪽.
   * 결과 { value(사본, 둘 다 없으면 undefined), fromI(받은 쪽을 골랐으면 true), localNewer(내 쪽이 더 나중) }. 시각이 같으면 내 것
   */
  function mergeSettings(a, b) {
    var ta = isObj(a) ? ms(a.financeAt) : 0;
    var tb = isObj(b) ? ms(b.financeAt) : 0;
    if (tb > ta) return { value: clone(b), fromI: true, localNewer: false };
    return { value: isObj(a) ? clone(a) : undefined, fromI: false, localNewer: ta > tb };
  }

  // ---------------- 항목 안의 값별 시각(ft) ----------------
  /** ft 정리: 아는 값 이름과 양수 시각만. 남는 것이 없으면 null(= 예전 항목처럼 t 하나로 봄) */
  function cleanFt(ft) {
    if (!isObj(ft)) return null;
    var out = {};
    var n = 0;
    ITEM_FIELDS.forEach(function (f) {
      var t = ms(own(ft, f));
      if (t) { out[f] = t; n++; }
    });
    return n ? out : null;
  }
  function maxFt(ft) {
    var m = 0;
    if (ft) Object.keys(ft).forEach(function (f) { if (ft[f] > m) m = ft[f]; });
    return m;
  }
  /**
   * 항목 안의 값 f 가 바뀐 시각.
   * - ft 가 있는 항목: ft[f]. ft 에 없으면 floor(그 매물의 legacyAt: 예전 기록을 처음 읽은 때 이 값을 알고 있었음), 없으면 0
   * - ft 가 없는 예전 모양: 모든 값이 t 에 바뀐 것으로 본다(t 도 없으면 base = 매물 updatedAt)
   */
  function valueTime(item, f, floor, base) {
    var ft = cleanFt(item.ft);
    if (ft) return ft[f] || floor || 0;
    return ms(item.t) || base || floor || 0;
  }
  function itemTimes(item, floor, base) {
    var T = {};
    ITEM_FIELDS.forEach(function (f) { T[f] = valueTime(item, f, floor, base); });
    return T;
  }
  /** 항목 전체의 시각(t). t 가 없으면 값 시각 중 가장 나중, 그것도 없으면 base·floor */
  function itemT(item, floor, base) { return ms(item.t) || maxFt(cleanFt(item.ft)) || base || floor || 0; }
  function maxOf(T) {
    var m = 0;
    Object.keys(T).forEach(function (f) { if (T[f] > m) m = T[f]; });
    return m;
  }
  /**
   * 값별 시각 T 를 저장 모양 ft 로(1.3.1).
   * 모든 값이 t 에 바뀌었으면 ft 없이(예전 모양: t 하나). 아니면 floor 와 다른 시각만 적는다
   * (ft 에 없는 값은 읽을 때 floor 로 보므로 뜻은 같고 크기가 준다. 예전 항목을 처음 고칠 때 ft 가 5개로 늘지 않게).
   */
  function packFt(T, t, floor) {
    var allT = true;
    var ft = {};
    var n = 0;
    ITEM_FIELDS.forEach(function (f) {
      var x = T[f] || 0;
      if (x !== t) allT = false;
      if (x && x !== floor) { ft[f] = x; n++; }
    });
    if (allT) return null;
    // 모든 값이 floor 인데 t 만 다르면, ft 를 비우면 예전 모양(모두 t)으로 읽히므로 그대로 적어 둔다
    if (!n) ITEM_FIELDS.forEach(function (f) { if (T[f]) { ft[f] = T[f]; n++; } });
    return n ? ft : null;
  }

  /**
   * 항목 상태를 고친 새 객체를 만든다(app.js setItemState 가 부른다).
   * 빈 값('' false null)은 지우고, 고친 값의 시각(ft)과 항목 시각(t)을 남긴다. 값을 모두 지워도 { t, ft } 로 남는다.
   * floor: 그 매물의 legacyAt. 새 시각은 now 와 "지금 값들의 시각·floor 보다 1ms 뒤" 중 큰 값(after):
   * 기기 시계가 늦어도 방금 고친 값이 그 전 값(다른 기기에서 받은 값 포함)을 이긴다.
   * 예전 항목(ft 없음)을 처음 고치면 다른 값들은 그 항목의 t 에 바뀐 것으로 남긴다(floor 와 같으면 적지 않음).
   */
  function editItem(cur, patch, now, floor) {
    cur = isObj(cur) ? cur : {};
    patch = isObj(patch) ? patch : {};
    floor = ms(floor);
    var keys = Object.keys(patch).filter(function (f) { return ITEM_FIELDS.indexOf(f) >= 0; });
    if (!keys.length) return clone(cur); // 고친 값이 없으면 시각도 그대로
    var T = itemTimes(cur, floor, 0);
    var t = after(now, cur.t, floor, maxOf(T));
    var out = {};
    ITEM_FIELDS.forEach(function (f) {
      var v = hasOwn(patch, f) ? patch[f] : cur[f];
      if (!blank(v)) out[f] = v;
    });
    keys.forEach(function (f) { T[f] = t; });
    out.t = t;
    var ft = packFt(T, t, floor);
    if (ft) out.ft = ft;
    return out;
  }

  /**
   * 같은 항목의 두 사본 합치기: 값마다 더 나중 시각 쪽(같으면 a). 결과는 새 객체.
   * aBase·bBase: 각 매물의 updatedAt(시각 없는 항목의 대체값), aFloor·bFloor: 각 매물의 legacyAt,
   * outFloor: 결과 매물의 legacyAt(기본: 둘 중 큰 값). 둘 다 예전 항목(ft 없음)이면 결과도 ft 없이 t 하나.
   */
  function mergeItem(a, b, aBase, bBase, aFloor, bFloor, outFloor) {
    aFloor = ms(aFloor);
    bFloor = ms(bFloor);
    if (outFloor === undefined) outFloor = Math.max(aFloor, bFloor);
    var o = {};
    var T = {};
    ITEM_FIELDS.forEach(function (f) {
      var at = valueTime(a, f, aFloor, aBase);
      var bt = valueTime(b, f, bFloor, bBase);
      var src = bt > at ? b : a;
      if (!blank(src[f])) o[f] = src[f];
      T[f] = Math.max(at, bt);
    });
    var t = Math.max(itemT(a, aFloor, aBase), itemT(b, bFloor, bBase));
    if (t) {
      o.t = t;
      var ft = packFt(T, t, ms(outFloor));
      if (ft) o.ft = ft;
    }
    return o;
  }

  /** 한쪽에만 있는 항목을 옮길 때(다른 쪽에 legacyAt 이 없을 때): 값과 시각만, 시각이 없으면 매물의 updatedAt */
  function copyItem(v, base, floor) {
    var o = itemContent(v);
    var ft = cleanFt(v.ft);
    var t = itemT(v, floor, base);
    if (t) o.t = t;
    if (ft) o.ft = ft;
    return o;
  }

  // ---------------- 시각 채우기 ----------------
  /**
   * 매물의 변경 시각 필드를 검사하고 빈 곳을 채운다. app.js normalizeProperty 가 부른다. p 를 고쳐 쓰고 돌려준다.
   * 시각이 하나도 없는 예전 기록(fieldsAt 이 없음 = 1.2.x 이하가 쓴 기록)은 legacyAt 을 그 매물의 updatedAt 으로 정하고,
   * 비어 있는 시각을 모두 legacyAt 으로 채운다. 한 번 채워 저장해 두면, 뒤에 다른 항목을 고쳐 updatedAt 이 올라가도
   * 이 값은 그대로라서 다른 기기에서 그 사이에 고친 값을 잘못 이기지 않는다.
   * (items 의 값 필드는 app.js normalizeItems 가 이미 정리했다고 보고, 여기서는 t·ft 만 다룬다)
   */
  function fillTimes(p) {
    var base = ms(p.updatedAt);
    var rawFa = p.fieldsAt;
    var legacy = !isObj(rawFa) && typeof rawFa !== 'number';
    var floor = ms(p.legacyAt) || (legacy ? base : 0);
    if (floor) p.legacyAt = floor; else delete p.legacyAt;
    var fill = floor || base; // 비어 있는 시각을 채우는 값
    var fa = {};
    FIELDS.forEach(function (f) {
      var t = typeof rawFa === 'number' ? ms(rawFa) : ms(own(rawFa, f));
      // 1.6.0: 나중에 늘어난 칸(매도인 이름)은 시각이 없고 비어 있으면 채우지 않는다(= 아직 모름, 시각 0)
      if (!t && LATE_FIELDS[f] && blank(p[f])) return;
      if (t || fill) fa[f] = t || fill;
    });
    p.fieldsAt = fa;
    var st = ms(p.statusAt) || fill;
    if (st) p.statusAt = st; else delete p.statusAt;

    var items = {};
    if (isObj(p.items)) {
      Object.keys(p.items).forEach(function (k) {
        if (BAD_KEYS[k]) return;
        var v = p.items[k];
        if (!isObj(v)) return;
        var o = itemContent(v);
        var ft = cleanFt(v.ft);
        var t = ms(v.t) || maxFt(ft) || (Object.keys(o).length ? fill : 0);
        if (t) o.t = t;
        if (ft) o.ft = ft;
        if (Object.keys(o).length) items[k] = o; // 값도 시각도 없으면 버린다
      });
    }
    p.items = items;

    var memoAt = {};
    var rawAt = isObj(p.sectionMemoAt) ? p.sectionMemoAt : {};
    Object.keys(rawAt).forEach(function (k) {
      if (!BAD_KEYS[k] && ms(rawAt[k])) memoAt[k] = ms(rawAt[k]);
    });
    if (isObj(p.sectionMemos) && fill) {
      Object.keys(p.sectionMemos).forEach(function (k) {
        if (!BAD_KEYS[k] && !blank(p.sectionMemos[k]) && !memoAt[k]) memoAt[k] = fill;
      });
    }
    p.sectionMemoAt = memoAt;
    return p;
  }

  // ---------------- 매물 하나 합치기 ----------------
  /**
   * 같은 매물의 두 사본을 합친다. 둘 다 고치지 않고 새 매물을 만든다.
   * 결과: { prop, changed(내 것과 내용이 다름), sameAsIncoming(받은 것과 내용이 같음),
   *         fields(받은 쪽에서 가져온 기본 정보 수), status(상태를 가져왔는지), items(가져온 항목 수),
   *         memos(가져온 섹션 메모 수), other(채운 그 밖 필드 수), snapshots(1.6.0: 가져온 등기부 해석 기록 수) }
   */
  function mergeProperty(local, incoming) {
    var L = isObj(local) ? local : {};
    var I = isObj(incoming) ? incoming : {};
    var lBase = ms(L.updatedAt);
    var iBase = ms(I.updatedAt);
    var out = {};
    Object.keys(L).forEach(function (k) { if (!BAD_KEYS[k]) out[k] = L[k]; }); // 모르는 필드는 내 것 유지
    var sum = { fields: 0, status: false, items: 0, memos: 0, other: 0 };

    // 1) 기본 정보: 필드마다 더 나중에 고친 쪽
    var fa = {};
    FIELDS.forEach(function (f) {
      // 1.6.0: 나중에 늘어난 칸은 시각 없는 빈 값을 "아직 모름"(0)으로 본다(LATE_FIELDS)
      var late = !!LATE_FIELDS[f];
      var lt = ms(own(L.fieldsAt, f)) || (late && blank(L[f]) ? 0 : lBase);
      var it = ms(own(I.fieldsAt, f)) || (late && blank(I[f]) ? 0 : iBase);
      var grp = hasOwn(FIELD_GROUPS, f) ? FIELD_GROUPS[f] : [];
      if (it > lt) {
        set(out, f, I[f]);
        fa[f] = it;
        var diff = !sameVal(L[f], I[f]);
        grp.forEach(function (g) { set(out, g, I[g]); if (!sameVal(L[g], I[g])) diff = true; }); // 1.7.0: KB 기준일·출처도 같은 쪽
        if (diff) sum.fields++;
      } else {
        set(out, f, L[f]);
        grp.forEach(function (g) { set(out, g, L[g]); });
        if (lt) fa[f] = lt;
      }
    });
    out.fieldsAt = fa;

    // 2) 진행 상태: 상태와 탈락 사유를 함께
    var lst = ms(L.statusAt) || lBase;
    var ist = ms(I.statusAt) || iBase;
    var stSrc = ist > lst ? I : L;
    STATUS_FIELDS.forEach(function (f) {
      set(out, f, stSrc[f]);
      if (stSrc === I && !sameVal(L[f], I[f])) sum.status = true;
    });
    set(out, 'statusAt', Math.max(lst, ist) || undefined);

    // 3) 그 밖(가져오기 코드 값): 비어 있지 않은 쪽, 둘 다 있으면 더 나중에 고친 매물 쪽(같으면 내 것)
    var newer = iBase > lBase ? I : L;
    OTHER_FIELDS.forEach(function (f) {
      var a = L[f];
      var b = I[f];
      var v;
      if (sameVal(a, b)) v = a === undefined ? b : a;
      else if (blank(a)) v = b;
      else if (blank(b)) v = a;
      else v = newer[f];
      if (!sameVal(v, a)) sum.other++;
      set(out, f, v);
    });

    // 4) 항목: 항목id 합집합. 양쪽에 있으면 항목 안의 값마다 더 나중 시각 쪽(같으면 내 것), 한쪽에만 있으면 그것.
    //    단, 다른 쪽이 예전 기록(legacyAt)이면 "그때 그 항목은 비어 있었다"로 보고 값마다 비교한다
    //    (1.2.x 에서 지운 항목이 다른 기기의 예전 값으로 되살아나지 않게).
    //    시각이 없는 예전 기록은 대체 시각(updatedAt)을 박아 둔다(다음에 다시 합쳐도 같은 결과)
    var lF = ms(L.legacyAt);
    var iF = ms(I.legacyAt);
    var oF = Math.max(lF, iF);
    var li = isObj(L.items) ? L.items : {};
    var ii = isObj(I.items) ? I.items : {};
    var items = {};
    unionKeys(li, ii).forEach(function (k) {
      var a = own(li, k);
      var b = own(ii, k);
      var hasA = isObj(a);
      var hasB = isObj(b);
      var o;
      if (hasA && hasB) o = mergeItem(a, b, lBase, iBase, lF, iF, oF);
      else if (hasA) o = iF ? mergeItem(a, { t: iF }, lBase, iBase, lF, iF, oF) : copyItem(a, lBase, lF);
      else if (hasB) o = lF ? mergeItem({ t: lF }, b, lBase, iBase, lF, iF, oF) : copyItem(b, iBase, iF);
      else return;
      if (!sameItem(a, o)) sum.items++; // 받은 쪽 덕분에 바뀐 항목
      if (!Object.keys(o).length) return;
      if (oF && !hasContent(o) && ms(o.t) <= oF) return; // 비었고 legacyAt 이 이미 말해 주는 지움 기록은 남기지 않는다
      items[k] = o;
    });
    out.items = items;

    // 5) 섹션 메모: 메모나 시각이 있는 쪽끼리 비교. 지운 메모도 시각(sectionMemoAt)으로 이긴다.
    //    메모도 시각도 없는 쪽은 legacyAt(없으면 0)에 비어 있던 것으로 본다
    var lm = isObj(L.sectionMemos) ? L.sectionMemos : {};
    var im = isObj(I.sectionMemos) ? I.sectionMemos : {};
    var lma = isObj(L.sectionMemoAt) ? L.sectionMemoAt : {};
    var ima = isObj(I.sectionMemoAt) ? I.sectionMemoAt : {};
    var memos = {};
    var memoAt = {};
    unionKeys(lm, im, lma, ima).forEach(function (k) {
      var lv = own(lm, k);
      var iv = own(im, k);
      var lt = ms(own(lma, k)) || (!blank(lv) ? lBase : lF);
      var it = ms(own(ima, k)) || (!blank(iv) ? iBase : iF);
      var pickI = it > lt;
      var v = pickI ? iv : lv;
      var t = Math.max(lt, it);
      if (!blank(v)) memos[k] = v;
      if (t && (!blank(v) || t > oF)) memoAt[k] = t;
      if (pickI && !sameVal(lv, iv)) sum.memos++;
    });
    out.sectionMemos = memos;
    out.sectionMemoAt = memoAt;
    set(out, 'legacyAt', oF || undefined);

    // 5') 1.6.0 등기부 해석 기록: id 합집합(같은 id 는 더 나중에 바꾼 쪽), 지운 기록 표시도 합집합.
    //     어느 쪽에도 없으면(예전 기록끼리) 키를 만들지 않는다
    var snapN = 0;
    if (hasOwn(L, 'registrySnapshots') || hasOwn(I, 'registrySnapshots') ||
      hasOwn(L, 'registrySnapshotsRemoved') || hasOwn(I, 'registrySnapshotsRemoved')) {
      var ms5 = mergeSnapshots(L, I);
      out.registrySnapshots = ms5.list;
      set(out, 'registrySnapshotsRemoved', Object.keys(ms5.removed).length ? ms5.removed : undefined);
      snapN = ms5.n;
    }

    // 5'') 1.7.0 값 이력(KB시세·호가): 합집합(한쪽에만 있어도 남김). 어느 쪽에도 키가 없으면(예전 기록끼리) 만들지 않는다.
    //      가져오기 시각(syncAt { 칸: ms })은 칸마다 큰 쪽
    HISTORY_FIELDS.forEach(function (f) {
      if (!hasOwn(L, f) && !hasOwn(I, f)) return;
      var m = mergeHistory(L[f], I[f]);
      if (stable(m) !== stable(histList(L[f]))) sum.other++;
      out[f] = m;
    });
    TIME_MAP_FIELDS.forEach(function (f) {
      if (!hasOwn(L, f) && !hasOwn(I, f)) return;
      var a = timeMap(L[f], 0);
      var m = unionMax(a, timeMap(I[f], 0));
      if (stable(m) !== stable(a)) sum.other++;
      out[f] = m;
    });

    // 6) 나머지: id 는 내 것, 만든 시각은 이른 쪽, 고친 시각은 늦은 쪽
    set(out, 'id', L.id !== undefined ? L.id : I.id);
    var c1 = ms(L.createdAt);
    var c2 = ms(I.createdAt);
    set(out, 'createdAt', c1 && c2 ? Math.min(c1, c2) : (c1 || c2 || L.createdAt));
    set(out, 'updatedAt', Math.max(lBase, iBase) || L.updatedAt);

    var changed = !sameProperty(L, out);
    return {
      prop: out,
      changed: changed,
      sameAsIncoming: sameProperty(I, out),
      fields: sum.fields,
      status: sum.status,
      items: sum.items,
      memos: sum.memos,
      other: sum.other,
      snapshots: snapN // 1.6.0: 받은 쪽에서 들어오거나 바뀐 등기부 해석 기록 수
    };
  }

  // ---------------- 기록 전체 합치기 ----------------
  /** { 열쇠: 시각 } 정리: 위험한 키·잘못된 값·보관 기간이 지난 것은 뺀다 */
  function timeMap(m, cutoff) {
    var out = {};
    if (!isObj(m)) return out;
    Object.keys(m).forEach(function (k) {
      if (BAD_KEYS[k]) return;
      var t = ms(m[k]);
      if (t && t > cutoff) out[k] = t;
    });
    return out;
  }
  /** 두 { 열쇠: 시각 } 의 합집합. 같은 열쇠는 큰 시각 */
  function unionMax(a, b) {
    var out = {};
    unionKeys(a, b).forEach(function (k) { out[k] = Math.max(own(a, k) || 0, own(b, k) || 0); });
    return out;
  }
  /** 개수가 넘치면 최근 것만 남긴다(시각이 같으면 열쇠 순서로, 어느 쪽에서 합쳐도 같게) */
  function capNewest(m, max) {
    var keys = Object.keys(m);
    if (keys.length <= max) return m;
    keys.sort(function (x, y) { return (m[y] - m[x]) || (x < y ? -1 : x > y ? 1 : 0); });
    var out = {};
    keys.slice(0, max).forEach(function (k) { out[k] = m[k]; });
    return out;
  }
  function brief(p) { return { id: str(p.id), name: str(p.name) }; }

  /**
   * 두 기록(state)을 합친다. localState 는 이 기기, incomingState 는 백업 파일(또는 다른 탭).
   * 받은 객체는 고치지 않는다. ui(기기 설정)와 그 밖의 최상위 필드(localDeleted 등)는 이 기기 것을 그대로 쓴다.
   * opts: { now(ms: 보관 기간 계산, 남긴 매물의 시각), keepMs(삭제 표시 보관, 기본 180일), goneMax(지운 매물 열쇠 최대, 기본 600),
   *         allowDelete({ 매물id: true }: 있으면 받은 쪽 삭제 표시로 이 매물들만 지운다(1.3.1). 나머지는 지우지 않고
   *         "지운 뒤에 고친 것"으로 시각을 올려 남긴다 → keptLocal. 없으면 모두 지운다) }
   * 결과: { state, report }
   *   report: { added(새로 넣은 매물 수), merged(양쪽 내용을 합친 매물 수), updated(받은 쪽으로 바뀐 매물 수),
   *             deleted(지운 매물 수), unchanged(그대로인 매물 수), items(받은 쪽에서 가져온 항목 수),
   *             removed[](지운 매물), keptAfterDelete[](받은 쪽에서 지웠지만 이 기기에서 그 뒤에 고쳐 남긴 매물),
   *             keptLocal[](받은 쪽에서 지웠지만 allowDelete 에 없어 남긴 매물),
   *             revived[](이 기기에서 지웠지만 받은 쪽에서 그 뒤에 고쳐 되살린 매물),
   *             skipped[](이 기기에서 지운 매물이라 넣지 않은 것),
   *             incomingBehind(합친 결과에 받은 쪽에 없던 내용이 있음 → 그쪽 기기도 맞추려면 이 기기에서 백업해 가야 함) }
   *   목록은 { id, name }
   */
  function mergeStates(localState, incomingState, opts) {
    opts = opts || {};
    var now = ms(opts.now) || Date.now();
    var cutoff = now - (ms(opts.keepMs) || KEEP_MS);
    var goneMax = ms(opts.goneMax) || GONE_KEYS_MAX;
    var allow = isObj(opts.allowDelete) ? opts.allowDelete : null;
    var L = isObj(localState) ? localState : {};
    var I = isObj(incomingState) ? incomingState : {};

    var dL = timeMap(L.deleted, cutoff);
    var dI = timeMap(I.deleted, cutoff);
    var deleted = unionMax(dL, dI);
    var gone = capNewest(unionMax(timeMap(L.goneKeys, cutoff), timeMap(I.goneKeys, cutoff)), goneMax);
    var report = {
      added: 0, merged: 0, updated: 0, deleted: 0, unchanged: 0, items: 0,
      removed: [], keptAfterDelete: [], keptLocal: [], revived: [], skipped: [], incomingBehind: false,
      settings: false // 1.7.0: 받은 쪽의 대출 조건을 가져왔으면 true
    };

    var lProps = Array.isArray(L.properties) ? L.properties : [];
    var iProps = Array.isArray(I.properties) ? I.properties : [];
    var iById = {};
    iProps.forEach(function (p) {
      if (!isObj(p) || blank(p.id) || BAD_KEYS[p.id] || hasOwn(iById, p.id)) return;
      iById[p.id] = p;
    });
    var seen = {};
    var props = [];

    /**
     * 삭제 표시(d)로 지울 매물: 허락한 것만 지우고, 아니면 "지운 뒤에 고친 것"으로 시각을 올려 남긴다.
     * inIncoming: 받은 쪽에 그 매물이 아직 있음(지워도 받은 쪽과 달라짐)
     */
    function removeOrKeep(lp, p, d, inIncoming) {
      if (!allow || hasOwn(allow, lp.id)) {
        report.deleted++;
        report.removed.push(brief(lp));
        if (inIncoming) report.incomingBehind = true;
        return;
      }
      report.incomingBehind = true; // 받은 쪽에서는 지웠는데 여기서는 남긴다
      var kept = clone(p);
      kept.updatedAt = after(now, kept.updatedAt, d); // 양쪽을 다시 맞추면 그 기기에서도 되살아난다
      report.keptLocal.push(brief(lp));
      props.push(kept);
    }

    // 이 기기의 매물: 받은 쪽에도 있으면 합치고, 받은 쪽에서 지웠으면 지운 시각과 비교
    lProps.forEach(function (lp) {
      if (!isObj(lp) || blank(lp.id) || BAD_KEYS[lp.id] || hasOwn(seen, lp.id)) return;
      seen[lp.id] = true;
      var d = own(deleted, lp.id) || 0;
      var ip = own(iById, lp.id);
      if (ip) {
        var r = mergeProperty(lp, ip);
        if (d && ms(r.prop.updatedAt) <= d) { removeOrKeep(lp, r.prop, d, true); return; }
        if (!r.sameAsIncoming) report.incomingBehind = true;
        if (!r.changed) report.unchanged++;
        else if (r.sameAsIncoming) report.updated++;
        else report.merged++;
        report.items += r.items;
        props.push(r.prop);
        return;
      }
      if (d && ms(lp.updatedAt) <= d) { removeOrKeep(lp, lp, d, false); return; }
      if (own(dI, lp.id)) report.keptAfterDelete.push(brief(lp)); // 받은 쪽에서 지운 뒤에 여기서 고쳤다
      else report.unchanged++;
      report.incomingBehind = true; // 이 기기에만 있는 매물
      props.push(clone(lp));
    });

    // 받은 쪽에만 있는 매물: 이 기기에서 지웠으면 지운 시각과 비교
    iProps.forEach(function (ip) {
      if (!isObj(ip) || blank(ip.id) || BAD_KEYS[ip.id] || hasOwn(seen, ip.id)) return;
      seen[ip.id] = true;
      var d = own(deleted, ip.id) || 0;
      var dl = own(dL, ip.id) || 0;
      if (d && ms(ip.updatedAt) <= d) {
        if (dl && ms(ip.updatedAt) <= dl) {
          report.skipped.push(brief(ip));
          report.incomingBehind = true; // 받은 쪽에는 아직 있다
        }
        return;
      }
      if (dl) report.revived.push(brief(ip)); // 여기서 지운 뒤에 받은 쪽에서 고쳤다
      else report.added++;
      props.push(clone(ip));
    });

    var state = {};
    Object.keys(L).forEach(function (k) { if (!BAD_KEYS[k]) state[k] = L[k]; });
    state.properties = props;
    state.deleted = deleted;
    state.goneKeys = gone;
    state.ui = isObj(L.ui) ? clone(L.ui) : {};
    // 1.7.0: 전역 대출 조건은 더 나중에 바꾼 쪽(기기 설정 ui 와 달리 기록의 일부로 함께 맞춘다)
    var sm = mergeSettings(L.settings, I.settings);
    if (sm.value !== undefined) state.settings = sm.value;
    report.settings = sm.fromI;
    if (sm.localNewer) report.incomingBehind = true;
    return { state: state, report: report };
  }

  return {
    after: after,
    FIELDS: FIELDS,
    LATE_FIELDS: LATE_FIELDS,
    FIN_FIELDS: FIN_FIELDS,         // 1.7.0
    FIELD_GROUPS: FIELD_GROUPS,     // 1.7.0
    HISTORY_FIELDS: HISTORY_FIELDS, // 1.7.0
    HISTORY_MAX: HISTORY_MAX,       // 1.7.0
    mergeHistory: mergeHistory,     // 1.7.0
    mergeSettings: mergeSettings,   // 1.7.0
    STATUS_FIELDS: STATUS_FIELDS,
    OTHER_FIELDS: OTHER_FIELDS,
    ITEM_FIELDS: ITEM_FIELDS,
    KEEP_MS: KEEP_MS,
    GONE_KEYS_MAX: GONE_KEYS_MAX,
    fillTimes: fillTimes,
    editItem: editItem,
    mergeItem: mergeItem,
    mergeProperty: mergeProperty,
    mergeSnapshots: mergeSnapshots,
    dedupeSnapshots: dedupeSnapshots,
    mergeStates: mergeStates,
    sameProperty: sameProperty,
    sameItem: sameItem
  };
});
