/*
 * 임장 체크리스트 — import-parser.js
 * "가져오기 코드"(Claude 가 네이버 부동산 매물 화면을 보고 답한 JSON)를 읽어 매물 후보로 바꾼다.
 *
 * - 브라우저: index.html 에서 data.js 다음, app.js 전에 일반 스크립트로 불러온다 → window.ImjangImport
 * - Node: tools/make-import-code.js 가 require 해서 앱과 같은 규칙으로 검사한다 → module.exports
 * - DOM 을 쓰지 않는다. 화면 표시는 app.js 가 맡는다. (ES module 이 아님: file:// 로 열어도 되도록)
 *
 * 코드 형식(사람이 아니라 Claude 가 손으로 정확히 쓸 수 있게 단순한 JSON)
 *   { "imjang": 1, "properties": [ { "name": "단지명", "dong": "101", "area": 84.97, "askPrice": 52000, ... } ] }
 *   - "imjang" 키가 없어도 properties 배열이 있으면 받는다. 매물 객체 하나(name 있음)나 배열만 와도 받는다.
 *   - 앞뒤 설명 문장, 코드 펜스(```json ```imjang ```)가 섞여 있어도 된다.
 *   - 코드 블록이 여러 개면(스크린샷마다 하나씩 등) 모두 읽어 이어 붙인다(1.2.1).
 *   - // 주석, 끝 쉼표, NaN 같은 Claude 의 흔한 실수는 고쳐서 읽는다(1.2.1).
 *   - 호수(ho)는 받지 않는다(네이버 부동산에 없음). 늘 사용자가 직접 입력한다.
 *
 * 보안: 붙여 넣은 글은 믿지 않는다. 아는 필드만 골라 읽고(길이·범위 검사), __proto__·constructor·prototype 키는
 *       버리고, 링크는 http/https 만 남긴다. 결과는 문자열·숫자뿐이며 화면에는 textContent 로만 넣는다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangImport = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var CODE_VERSION = 1; // "imjang": 1
  var LIMITS = {
    inputChars: 200 * 1024, // 붙여 넣은 글 전체 길이 상한(약 200KB)
    linkChars: 400 * 1024,  // 딥링크 c= 값(base64url) 길이 상한
    properties: 30,         // 한 번에 담을 수 있는 매물 수
    candidates: 100,        // 글 속에서 JSON 후보를 찾아보는 횟수 상한(코드 블록 여러 개를 모두 읽으므로 넉넉히)
    name: 80, dong: 20, floor: 20, direction: 20, tradeType: 10,
    agentName: 60, agentPhone: 30, memo: 2000, url: 2000, articleNo: 30, confirmedAt: 30
  };
  var RANGE = {
    area: [1, 1000],           // 전용면적 ㎡
    supplyArea: [1, 2000],     // 공급면적 ㎡
    price: [1, 10000000]       // 만원 (1천억까지)
  };
  var BAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
  var EXAMPLE_NAME = '단지명'; // 요청문 속 예시의 자리표시 이름
  var SOURCE_ID = 'claude-code';

  // Claude 채팅에 보낼 요청문. 앱 화면과 README 에 같은 문구가 들어간다(바꾸면 README 도 함께).
  var PROMPT = [
    '임장체크 앱에 넣을 매물 정보를 정리해 줘.',
    '첨부한 네이버 부동산 매물 화면(스크린샷·글·링크)에서 아래 형식의 JSON만 코드 블록으로 답해 줘.',
    '- 화면에 없는 값은 빼고, 추측하지 마.',
    '- 가격은 만원 단위 숫자 (예: 5억 2,000 → 52000).',
    '- 면적은 ㎡ 숫자 (전용면적은 area, 공급면적은 supplyArea).',
    '- 호수(ho)는 넣지 마. 동은 숫자만.',
    '- 매물이 여러 개면 properties에 모두 넣어 줘.',
    '```json',
    '{"imjang":1,"properties":[{"name":"단지명","dong":"101","area":84.97,"supplyArea":112.4,"askPrice":52000,"tradeType":"매매","floor":"12/25","direction":"남향","agentName":"","agentPhone":"","sourceUrl":"","articleNo":"","confirmedAt":"","memo":""}]}',
    '```'
  ].join('\n');

  var MESSAGES = {
    empty: '',
    'too-big': '붙여 넣은 글이 너무 길어요. Claude 답변의 코드 부분만 복사해 붙여 주세요.',
    notfound: '코드를 찾지 못했어요. Claude 답변 전체를 복사해 붙여 주세요.',
    broken: '코드가 잘렸거나 깨져 있어요. Claude 답변의 코드 블록 전체를 다시 복사해 붙여 주세요.',
    'too-many': '글에 코드 같은 부분이 너무 많아 끝까지 읽지 못했어요. Claude 답변의 코드 부분만 복사해 붙여 주세요.',
    comment: '코드 안에 설명(주석)이 섞여 있어 읽지 못했어요. Claude에게 "JSON만 다시 보내 줘"라고 해 보세요.',
    example: '요청문 속 예시만 있어요. Claude가 답한 코드를 복사해 붙여 주세요.',
    none: '코드에 매물이 없어요. 매물 화면이 잘 보이게 다시 캡처해서 Claude에게 보내 보세요.'
  };

  // ---------------- 작은 도구 ----------------
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  /** 자기 필드만 읽는다(프로토타입에 걸린 값은 보지 않음) */
  function get(o, k) { return isObj(o) && has(o, k) ? o[k] : undefined; }
  function cut(s, n) { return s.length > n ? s.slice(0, n) : s; }

  /** 한 줄 글: 숫자도 글로 받고, 제어 문자·연속 공백을 정리하고, 길이를 자른다 */
  function oneLine(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    return cut(v.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
  }
  /** 여러 줄 글(메모): 줄바꿈은 남기고 그 밖의 제어 문자는 지운다 */
  function multiLine(v, max) {
    if (typeof v !== 'string') return '';
    return cut(v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim(), max);
  }
  /** 참고 문구는 같은 말을 두 번 넣지 않는다 */
  function addNote(notes, text) { if (notes && notes.indexOf(text) < 0) notes.push(text); }
  /** 만원 → "5억 2,000만원" (경고 문구용) */
  function manwonText(n) {
    var eok = Math.floor(n / 10000);
    var rest = n % 10000;
    var restText = String(rest).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return eok ? eok + '억' + (rest ? ' ' + restText + '만원' : '원') : restText + '만원';
  }

  /** JSON.parse 에서 위험한 키를 버린다(되돌려 주는 값이 undefined 면 그 키가 지워짐) */
  function reviver(key, value) { return has(BAD_KEYS, key) ? undefined : value; }

  // ---------------- 글 속에서 코드(JSON) 찾기 ----------------
  /**
   * start 의 { 또는 [ 와 짝이 맞는 닫는 괄호 위치. 문자열 안의 괄호는 무시. 짝이 없으면 -1.
   * 문자열 밖의 // … 줄 끝, /* … *\/ 주석 안도 건너뛴다(주석 속 따옴표·괄호로 짝이 어긋나지 않게)
   */
  function matchEnd(t, start) {
    var depth = 0;
    var inStr = false;
    for (var i = start; i < t.length; i++) {
      var c = t.charAt(i);
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '/' && t.charAt(i + 1) === '/') {
        var nl = t.indexOf('\n', i);
        if (nl < 0) return -1;
        i = nl;
        continue;
      }
      if (c === '/' && t.charAt(i + 1) === '*') {
        var close = t.indexOf('*/', i + 2);
        if (close < 0) return -1;
        i = close + 1;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return i;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  /** 닫는 괄호 앞의 쉼표(Claude 가 가끔 남김)를 지운다. 문자열 안은 건드리지 않는다 */
  function dropTrailingCommas(s) {
    var out = '';
    var inStr = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        out += c;
        if (c === '\\' && i + 1 < s.length) { out += s.charAt(i + 1); i++; }
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === ',') {
        var j = i + 1;
        while (j < s.length && /\s/.test(s.charAt(j))) j++;
        if (s.charAt(j) === '}' || s.charAt(j) === ']') continue;
      }
      out += c;
    }
    return out;
  }

  /**
   * JSON 이 아닌 자바스크립트식 표기를 고친다(문자열 안은 그대로).
   * - // … 줄 끝, /* … *\/ 주석을 지운다 (Claude 가 "// 화면 기준" 같은 설명을 붙일 때)
   * - NaN, Infinity, -Infinity, undefined 를 null 로 바꾼다
   * 결과: { text, comments: 주석이 있었는지 }
   */
  function relaxJson(s) {
    var out = '';
    var inStr = false;
    var comments = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        out += c;
        if (c === '\\' && i + 1 < s.length) { out += s.charAt(i + 1); i++; }
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === '/' && s.charAt(i + 1) === '/') {
        comments = true;
        while (i + 1 < s.length && s.charAt(i + 1) !== '\n') i++;
        continue;
      }
      if (c === '/' && s.charAt(i + 1) === '*') {
        comments = true;
        var close = s.indexOf('*/', i + 2);
        i = close < 0 ? s.length : close + 1;
        out += ' ';
        continue;
      }
      if (/[A-Za-z]/.test(c) && !/[A-Za-z0-9_$]/.test(s.charAt(i - 1))) {
        var m = /^(?:NaN|Infinity|undefined)(?![A-Za-z0-9_$])/.exec(s.slice(i, i + 10));
        if (m) {
          if (m[0] === 'Infinity') out = out.replace(/-\s*$/, ''); // -Infinity
          out += 'null';
          i += m[0].length - 1;
          continue;
        }
      }
      out += c;
    }
    return { text: out, comments: comments };
  }

  /** JSON.parse. 실패하면 주석·NaN·끝 쉼표를 고쳐 한 번 더. { ok, value } 또는 { ok: false, comments } */
  function tryJson(seg) {
    try { return { ok: true, value: JSON.parse(seg, reviver) }; } catch (e) { /* 아래에서 한 번 더 */ }
    var relaxed = relaxJson(seg);
    var fixed = dropTrailingCommas(relaxed.text);
    if (fixed !== seg) {
      try { return { ok: true, value: JSON.parse(fixed, reviver) }; } catch (e2) { /* 실패 */ }
    }
    return { ok: false, comments: relaxed.comments };
  }

  /** 해석한 값에서 매물 목록을 꺼낸다. 알아볼 수 없는 모양이면 null */
  function listFrom(v) {
    if (Array.isArray(v)) return v.some(isObj) ? v : null;
    if (!isObj(v)) return null;
    var props = get(v, 'properties');
    if (Array.isArray(props)) return props;
    if (has(v, 'name')) return [v]; // 매물 객체 하나
    return null;
  }

  function isExampleOnly(list) {
    return list.length > 0 && list.every(function (p) { return isObj(p) && get(p, 'name') === EXAMPLE_NAME; });
  }

  // 코드처럼 보이는 시작: {"… 또는 [{… 또는 []
  var JSONISH_RE = /^(?:\{\s*"|\[\s*[{\]])/;

  /**
   * 한 가지 글에서 찾기. 글 끝까지 보면서 코드 블록을 모두 모은다
   * (Claude 는 스크린샷이 여러 장이면 블록을 나눠 답하기도 한다. 첫 블록만 담고 나머지를 조용히 버리지 않게).
   * 코드처럼 보이는 곳({"… [{…)만 짝을 맞춰 읽고, 설명 글 속 괄호("[참고]")는 한 글자씩 건너뛴다(횟수에 세지 않음).
   * 결과: { list, blocks(읽은 코드 수), incomplete(코드 후보가 너무 많아 끝까지 못 봄) }
   *       또는 { error: 'notfound' | 'broken' | 'comment' | 'example' | 'none' | 'too-many' }
   */
  function scan(t) {
    var i = 0;
    var tries = 0;
    var sawExample = false;
    var sawEmpty = false;
    var lists = [];
    var incomplete = false;
    var na = -2; // 다음 { 위치(-1: 더 없음). 매번 처음부터 찾지 않게 기억해 둔다
    var nb = -2; // 다음 [ 위치
    while (true) {
      if (na !== -1 && na < i) na = t.indexOf('{', i);
      if (nb !== -1 && nb < i) nb = t.indexOf('[', i);
      var start = na < 0 ? nb : (nb < 0 ? na : Math.min(na, nb));
      if (start < 0) break;
      if (!JSONISH_RE.test(t.slice(start, start + 40))) { i = start + 1; continue; }
      if (tries >= LIMITS.candidates) { incomplete = true; break; }
      tries++;
      var end = matchEnd(t, start);
      // 짝이 안 맞는 괄호: 잘린 코드. 안쪽 일부만 담는 일이 없도록 여기서 멈춘다
      if (end < 0) return { error: 'broken' };
      var r = tryJson(t.slice(start, end + 1));
      if (!r.ok) {
        // 깨진 코드가 하나라도 있으면 담지 않는다(그 블록의 매물만 빠진 채 담기지 않게)
        return { error: r.comments ? 'comment' : 'broken' };
      }
      var list = listFrom(r.value);
      if (list) {
        if (!list.length) sawEmpty = true;
        else if (isExampleOnly(list)) sawExample = true; // 요청문 예시는 건너뛴다
        else lists.push(list);
      }
      i = end + 1; // 이 덩어리 안쪽은 다시 보지 않는다
    }
    if (lists.length) {
      var all = [];
      lists.forEach(function (l) { for (var k = 0; k < l.length; k++) all.push(l[k]); });
      return { list: all, blocks: lists.length, incomplete: incomplete };
    }
    if (incomplete) return { error: 'too-many' };
    return { error: sawEmpty ? 'none' : (sawExample ? 'example' : 'notfound') };
  }

  /** 글에서 코드를 찾는다. 원문으로 먼저, 스마트 따옴표(“ ” ‘ ’)를 일반 따옴표로 바꿔 한 번 더 */
  function extract(src) {
    var t = src.replace(/^﻿/, '');
    var first = scan(t);
    var smart = t.replace(/[“”„‟″＂]/g, '"').replace(/[‘’‚‛′]/g, "'");
    if (smart === t) return first;
    var second = scan(smart);
    if (first.list) {
      // 블록마다 따옴표가 다를 때(일부만 스마트 따옴표): 바꿔 읽어 매물이 더 많이 나오면 그쪽을 쓴다
      return second.list && second.list.length > first.list.length ? second : first;
    }
    if (second.list) return second;
    if (second.error === 'broken' || second.error === 'comment' || second.error === 'none' || second.error === 'too-many') return second;
    return first;
  }

  // ---------------- 값 정리 ----------------
  /** 가격 글 → 만원. "52000", "5억 2,000", "5억2천만", "5.2억", "8,000만원", "1억/150"(월세는 앞부분) */
  function parseMoneyText(s) {
    s = String(s).split(/[\/~]/)[0];
    s = s.replace(/[^0-9.억천백십만]/g, '');
    if (!s) return null;
    if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
    var m = /^(?:(\d+(?:\.\d+)?)억)?(.*)$/.exec(s);
    var eok = m[1] ? parseFloat(m[1]) : 0;
    var rest = m[2].replace(/만$/, '');
    var small = 0;
    if (rest) {
      if (/^\d+(?:\.\d+)?$/.test(rest)) small = parseFloat(rest);
      else {
        var k = /^(?:(\d+)천)?(?:(\d+)백)?(?:(\d+)십)?(\d+)?$/.exec(rest);
        if (!k || !(k[1] || k[2] || k[3] || k[4])) return null;
        small = (+k[1] || 0) * 1000 + (+k[2] || 0) * 100 + (+k[3] || 0) * 10 + (+k[4] || 0);
      }
    } else if (!m[1]) return null;
    return eok * 10000 + small;
  }

  /**
   * 가격 → 만원 정수(또는 null). 이상한 값은 notes(참고)에 이유를 남기고,
   * 사람이 꼭 봐야 하는 값(억 단위로 보이는 소수, 아주 낮은 값)은 warns(경고: 기본 체크 해제)에 남긴다
   */
  function priceOf(v, label, notes, warns) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : (typeof v === 'string' ? parseMoneyText(v) : null);
    if (n === null || !isFinite(n) || n <= 0) { notes.push(label + ': 값을 읽지 못해 뺐어요'); return null; }
    var guessed = null;
    if (n >= RANGE.price[1]) { // 1천억(만원) 이상이면 원 단위로 적은 것으로 본다
      n = n / 10000;
      notes.push(label + ': 원 단위로 보여 만원으로 바꿨어요');
    } else if (n < 100 && n !== Math.floor(n)) {
      // 5.2 처럼 100 미만 소수: 만원 단위에는 소수가 없으니 억 단위로 적은 것으로 본다(반올림해 5만원이 되지 않게)
      guessed = n;
      n = n * 10000;
    }
    n = Math.round(n);
    if (n < RANGE.price[0] || n > RANGE.price[1]) { notes.push(label + ': 값이 이상해서 뺐어요'); return null; }
    if (guessed !== null) warns.push({ code: 'lowprice', text: label + ' ' + guessed + ' → ' + manwonText(n) + '으로 읽었어요(억 단위로 봄). 맞는지 확인하세요' });
    else if (n < 1000) warns.push({ code: 'lowprice', text: label + ' ' + manwonText(n) + '은 너무 낮아요. 만원 단위가 맞는지 확인하세요' });
    return n;
  }

  /**
   * 면적 → ㎡ 숫자(소수 둘째 자리). 숫자 또는 글("84.97㎡", "전용 84.97", "25평(84.97㎡)").
   * kind: '전용' 또는 '공급'. 글에 "전용 84.97"처럼 이름 붙은 숫자가 있으면 그것만 쓴다.
   * 평 숫자는 늘 버린다. 그래도 숫자가 여러 개면("112.4/84.97㎡") 어느 쪽인지 추측하지 않고 뺀다
   */
  function areaOf(v, range, label, kind, notes) {
    if (v === null || v === undefined || v === '') return null;
    var n = null;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string') {
      var s = v.replace(/,/g, '');
      var named = new RegExp(kind + '\\s*(?:면적)?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)').exec(s);
      if (named) n = parseFloat(named[1]);
      else {
        var nums = s.replace(/\d+(?:\.\d+)?\s*평/g, ' ').replace(/㎡|m²|m2|제곱미터/gi, ' ').match(/\d+(?:\.\d+)?/g) || [];
        if (!nums.length) { notes.push(label + (/평/.test(s) ? ': 평 단위라 뺐어요(㎡만 받아요)' : ': 값을 읽지 못해 뺐어요')); return null; }
        if (nums.length > 1) { notes.push(label + ': 숫자가 여러 개라 뺐어요(화면에서 확인)'); return null; }
        n = parseFloat(nums[0]);
      }
    }
    if (n === null || !isFinite(n) || n < range[0] || n > range[1]) { notes.push(label + ': 값이 이상해서 뺐어요'); return null; }
    return Math.round(n * 100) / 100;
  }

  /**
   * 동: "101", "101동", "제101동" → "101". 호수가 섞여 오면("101동 1203호", "101-1203") 동만 남기고 호수는 버린다
   * (호수는 늘 사용자가 직접 입력). "102동/103동", "103동(신축)"처럼 군말이 붙으면 첫 동 이름만.
   * notes 를 주면 바꾼 이유를 남긴다
   */
  function dongOf(v, notes) {
    var raw = oneLine(v, 60);
    var s = raw.replace(/\s+/g, '').replace(/^제(?=\d)/, '');
    if (!s) return '';
    var out;
    var hasHo = /\d\s*호/.test(s);
    var dash = /^(\d{1,4})-(\d{1,5})호?$/.exec(s); // "101-1203" = 101동 1203호
    var named = /^([0-9A-Za-z가-힣]+?)동/.exec(s);
    if (dash) { out = dash[1]; hasHo = true; }
    else if (named) out = named[1];
    else if (hasHo) out = ''; // 호수만 적혀 있음
    else out = s;
    if (hasHo) addNote(notes, '호수는 직접 입력해요');
    else if (named && named[0] !== s) addNote(notes, '동: "' + cut(raw, 20) + '"에서 ' + out + '동만 넣었어요');
    if (out && !/^[0-9A-Za-z가-힣]+$/.test(out)) addNote(notes, '동: 화면과 맞는지 확인해 주세요');
    return cut(out, LIMITS.dong);
  }

  var TRADE_CODES = { A1: '매매', B1: '전세', B2: '월세', B3: '단기임대' }; // 네이버 부동산 거래 종류 코드
  function tradeTypeOf(v) {
    var s = oneLine(v, 30).replace(/\s+/g, '');
    if (!s) return '';
    var up = s.toUpperCase();
    if (has(TRADE_CODES, up)) return TRADE_CODES[up];
    if (/매매/.test(s)) return '매매';
    if (/전세/.test(s) && !/반전세/.test(s)) return '전세';
    if (/월세|반전세/.test(s)) return '월세';
    if (/단기/.test(s)) return '단기임대';
    return cut(s, LIMITS.tradeType);
  }

  /** 절대 주소 중 http/https 만. 아이디·비밀번호 부분은 지운다. 아니면 '' */
  function httpUrl(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s || s.length > LIMITS.url || /\s/.test(s)) return '';
    try {
      var u = new URL(s); // 기준 주소 없이: 상대 주소는 받지 않는다
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      u.username = '';
      u.password = '';
      return u.href.length > LIMITS.url ? '' : u.href;
    } catch (e) { return ''; }
  }

  function articleNoOf(v) { return cut(oneLine(v, 60).replace(/[^0-9A-Za-z-]/g, ''), LIMITS.articleNo); }

  /** 네이버 부동산 링크에서 매물번호 꺼내기 (?articleNo=…, /article/info/…, /articles/…) */
  function articleNoFromUrl(href) {
    var u;
    try { u = new URL(href); } catch (e) { return ''; }
    if (!/(^|\.)naver\.com$/i.test(u.hostname)) return '';
    var q = /[?&]articleNo=(\d{5,20})(?:&|$)/.exec(u.search);
    if (q) return q[1];
    var m = /\/articles?\/(?:info\/)?(\d{5,20})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : '';
  }

  // 국내 전화번호: 02-555-1234, (02) 555-1234, 031)123-4567, 010-1234-5678, 0507-1234-5678, +82 10-1234-5678, 1588-1234
  var PHONE_RE = /(?:\+82[\s.-]?0?|\(0|\b0)\d{1,3}[\s.)-]{0,2}\d{3,4}[\s.-]{0,2}\d{4}(?!\d)|\b1[5-9]\d{2}[\s.-]?\d{4}(?!\d)/g;

  /**
   * 중개사 연락처 → { phone, others }. 번호가 여러 개면("대표 02-555-1234 / 휴대폰 010-…") 첫 번호만 phone 에 넣는다
   * (두 번호를 붙이면 [전화] 버튼이 엉뚱한 번호로 건다). 나머지는 others 로 돌려준다
   */
  function phoneOf(v) {
    var s = oneLine(v, 100);
    var found = s.match(PHONE_RE);
    if (!found) return { phone: cut(s.replace(/[^0-9+\-() ]/g, '').replace(/\s+/g, ' ').trim(), LIMITS.agentPhone), others: [] };
    var list = found.map(function (x) { return cut(x.replace(/\s+/g, ' ').trim(), LIMITS.agentPhone); });
    return { phone: list[0], others: list.slice(1) };
  }

  /** 매물 하나 정리 → { prop, notes, warnings } (아는 필드만, 알 수 없는 필드는 무시) */
  function cleanProperty(raw) {
    var notes = [];
    var warnings = [];
    var phone = phoneOf(get(raw, 'agentPhone'));
    var p = {
      name: oneLine(get(raw, 'name'), LIMITS.name),
      dong: dongOf(get(raw, 'dong'), notes),
      area: areaOf(get(raw, 'area'), RANGE.area, '전용면적', '전용', notes),
      supplyArea: areaOf(get(raw, 'supplyArea'), RANGE.supplyArea, '공급면적', '공급', notes),
      askPrice: priceOf(get(raw, 'askPrice'), '호가', notes, warnings),
      realPrice: priceOf(get(raw, 'realPrice'), '실거래가', notes, warnings),
      tradeType: tradeTypeOf(get(raw, 'tradeType')),
      floor: oneLine(get(raw, 'floor'), LIMITS.floor),
      direction: oneLine(get(raw, 'direction'), LIMITS.direction),
      agentName: oneLine(get(raw, 'agentName'), LIMITS.agentName),
      agentPhone: phone.phone,
      sourceUrl: '',
      articleNo: articleNoOf(get(raw, 'articleNo')),
      confirmedAt: oneLine(get(raw, 'confirmedAt'), LIMITS.confirmedAt),
      memo: multiLine(get(raw, 'memo'), LIMITS.memo)
    };
    if (phone.others.length) {
      p.memo = cut((p.memo ? p.memo + '\n' : '') + '다른 연락처: ' + phone.others.join(', '), LIMITS.memo);
      addNote(notes, '연락처: 첫 번호만 넣고 나머지는 메모에 적었어요');
    }
    var url = get(raw, 'sourceUrl');
    if (typeof url === 'string' && url.trim()) {
      p.sourceUrl = httpUrl(url);
      if (!p.sourceUrl) notes.push('링크: http/https 주소가 아니라 뺐어요');
    }
    if (!p.articleNo && p.sourceUrl) p.articleNo = articleNoFromUrl(p.sourceUrl);
    var ho = get(raw, 'ho');
    if ((typeof ho === 'string' && ho.trim()) || typeof ho === 'number') addNote(notes, '호수는 직접 입력해요');
    // 공급면적은 전용면적보다 늘 크다. 아니면 두 값이 바뀌었거나 잘못 읽은 것
    if (p.area && p.supplyArea && p.area >= p.supplyArea) {
      warnings.push({ code: 'swap', text: '전용면적이 공급면적보다 크거나 같아요. 화면에서 확인하세요' });
    }
    return { prop: p, notes: notes, warnings: warnings };
  }

  // ---------------- 중복 판단 ----------------
  /** 링크 비교용: 프로토콜·www·끝의 / 무시, 쿼리는 이름순 정렬(추적용 값·빈 값 제외) */
  function urlKey(href) {
    var u;
    try { u = new URL(href); } catch (e) { return ''; }
    var host = u.hostname.toLowerCase().replace(/^www\./, '');
    var path = u.pathname.replace(/\/+$/, '') || '/';
    var pairs = [];
    u.search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var val = i < 0 ? '' : kv.slice(i + 1);
      if (!val || /^(utm_.*|fbclid|gclid|igshid)$/i.test(k)) return;
      if (k === 'ms' && /land\.naver\.com$/.test(host)) return; // 지도 위치: 복사할 때마다 달라짐
      pairs.push(k + '=' + val);
    });
    pairs.sort();
    return cut(host + path + (pairs.length ? '?' + pairs.join('&') : ''), 300);
  }

  /**
   * 중복 판단에 쓰는 값. 저장된 매물(app.js)과 코드 속 매물 모두에 쓴다.
   * a: 매물번호(없으면 네이버 링크에서), u: 정규화한 링크, n: 단지명·동·전용면적·호가, f: 층
   */
  function dupInfo(p) {
    var info = { a: '', u: '', n: '', f: '' };
    if (!isObj(p)) return info;
    var url = typeof p.sourceUrl === 'string' ? p.sourceUrl : '';
    info.a = articleNoOf(p.articleNo) || (url ? articleNoFromUrl(url) : '');
    info.u = url ? urlKey(url) : '';
    var nm = oneLine(p.name, 200).toLowerCase().replace(/\s+/g, '');
    var area = typeof p.area === 'number' && isFinite(p.area) ? String(Math.round(p.area * 100) / 100) : '';
    var ask = typeof p.askPrice === 'number' && isFinite(p.askPrice) ? String(Math.round(p.askPrice)) : '';
    if (nm && nm !== '이름없는매물' && (area || ask)) info.n = [nm, dongOf(p.dong), area, ask].join('|');
    info.f = oneLine(p.floor, 40).replace(/\s+|층/g, '').toLowerCase();
    return info;
  }

  /**
   * 같은 매물인지 단계별로 판정한다(앞 단계가 정해지면 뒤는 보지 않음).
   * ① 양쪽 모두 매물번호가 있으면 매물번호만 본다(다르면 다른 매물)
   * ② 아니면, 양쪽 모두 링크가 있으면 링크만 본다
   * ③ 아니면 단지명·동·전용면적·호가가 같을 때 같은 매물. 단, 층이 양쪽에 있고 다르면 다른 매물
   * 결과: 같으면 판정한 단계('a' | 'u' | 'n'), 아니면 ''
   */
  function sameListing(x, y) {
    if (x.a && y.a) return x.a === y.a ? 'a' : '';
    if (x.u && y.u) return x.u === y.u ? 'u' : '';
    if (!x.n || x.n !== y.n) return '';
    return x.f && y.f && x.f !== y.f ? '' : 'n';
  }

  /** 저장된 매물 목록 → 찾아보기용 색인 { 'a:…' | 'u:…' | 'n:…': [ { info, prop } ] } */
  function indexProps(list) {
    var idx = {};
    (Array.isArray(list) ? list : []).forEach(function (p) {
      var info = dupInfo(p);
      ['a', 'u', 'n'].forEach(function (lv) {
        if (!info[lv]) return;
        var k = lv + ':' + info[lv];
        if (!has(idx, k)) idx[k] = [];
        idx[k].push({ info: info, prop: p });
      });
    });
    return idx;
  }

  /**
   * 지운 매물을 기억할 열쇠 하나: 'g:' + JSON [매물번호, 링크, 단지명 조합, 층] (app.js 가 state.goneKeys 에 지운 시각과 함께 남김).
   * 비교할 값이 없으면 ''
   */
  function goneKey(p) {
    var info = dupInfo(p);
    if (!info.a && !info.u && !info.n) return '';
    return 'g:' + JSON.stringify([info.a, info.u, info.n, info.f]);
  }

  /** state.goneKeys → 비교할 값 목록. 1.2.0 이 남긴 낱개 열쇠('a:…' 'u:…' 'n:…')도 읽는다 */
  function goneInfos(goneKeys) {
    var out = [];
    if (!isObj(goneKeys)) return out;
    Object.keys(goneKeys).forEach(function (k) {
      var kind = k.slice(0, 2);
      var val = k.slice(2);
      if (kind === 'g:') {
        try {
          var arr = JSON.parse(val);
          if (Array.isArray(arr)) out.push({ a: String(arr[0] || ''), u: String(arr[1] || ''), n: String(arr[2] || ''), f: String(arr[3] || '') });
        } catch (e) { /* 망가진 열쇠는 무시 */ }
      } else if (kind === 'a:' || kind === 'u:' || kind === 'n:') {
        var info = { a: '', u: '', n: '', f: '' };
        info[kind.charAt(0)] = val;
        out.push(info);
      }
    });
    return out;
  }

  /** 색인에서 같은 매물 찾기 → { prop, by } 또는 null */
  function lookup(idx, x) {
    var levels = ['a', 'u', 'n'];
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      if (!x[lv] || !has(idx, lv + ':' + x[lv])) continue;
      var recs = idx[lv + ':' + x[lv]];
      for (var j = 0; j < recs.length; j++) {
        var by = sameListing(x, recs[j].info);
        if (by) return { prop: recs[j].prop, by: by };
      }
    }
    return null;
  }

  /**
   * 중복 찾기. existingIdx: indexProps 결과, gone: state.goneKeys 또는 goneInfos 결과(지운 매물).
   * 결과: null | { kind: 'exists', prop, by } | { kind: 'gone', by }   (by: 'a' 매물번호, 'u' 링크, 'n' 단지명 조합)
   */
  function findDuplicate(prop, existingIdx, gone) {
    var x = dupInfo(prop);
    var hit = existingIdx ? lookup(existingIdx, x) : null;
    if (hit) return { kind: 'exists', prop: hit.prop, by: hit.by };
    var list = Array.isArray(gone) ? gone : goneInfos(gone);
    for (var i = 0; i < list.length; i++) {
      var by = sameListing(x, list[i]);
      if (by) return { kind: 'gone', by: by };
    }
    return null;
  }

  // ---------------- 해석(메인) ----------------
  /**
   * 붙여 넣은 글 해석.
   * opts: { existing: 저장된 매물 배열, goneKeys: { 열쇠: 시각 } }
   * 결과: { ok, error, message, entries: [ { index, prop, notes, warnings: [{code,text}], canImport, checked } ],
   *         total(코드 속 매물 수), truncated(30개를 넘어 뺀 수), skipped(읽을 수 없는 항목 수),
   *         blocks(읽은 코드 블록 수), incomplete(글이 길어 끝까지 못 읽음) }
   * warning code: noname(담을 수 없음) / notsale(매매 아님) / swap(전용≥공급) / lowprice(가격이 이상하게 낮음) /
   *               exists(이미 있음) / gone(전에 지움) / repeat(코드 안에서 겹침)
   */
  function parse(input, opts) {
    opts = opts || {};
    var res = { ok: false, error: '', message: '', entries: [], total: 0, truncated: 0, skipped: 0, blocks: 0, incomplete: false };
    var src = typeof input === 'string' ? input : '';
    if (!src.trim()) { res.error = 'empty'; return res; }
    if (src.length > LIMITS.inputChars) { res.error = 'too-big'; res.message = MESSAGES['too-big']; return res; }
    var found = extract(src);
    if (!found.list) { res.error = found.error; res.message = MESSAGES[found.error] || MESSAGES.notfound; return res; }

    var list = found.list;
    res.total = list.length;
    res.blocks = found.blocks || 1;
    res.incomplete = !!found.incomplete;
    res.truncated = Math.max(0, list.length - LIMITS.properties);
    var idx = indexProps(opts.existing);
    var gone = goneInfos(opts.goneKeys);
    var seen = []; // 코드 안 앞쪽 매물: { info, json }

    list.slice(0, LIMITS.properties).forEach(function (raw, i) {
      if (!isObj(raw)) { res.skipped++; return; }
      var c = cleanProperty(raw);
      var p = c.prop;
      var warnings = [];
      if (!p.name) warnings.push({ code: 'noname', text: '단지명이 없어 담을 수 없어요' });
      if (p.tradeType && p.tradeType !== '매매') warnings.push({ code: 'notsale', text: '매매 매물이 아니에요 (' + p.tradeType + ')' });
      Array.prototype.push.apply(warnings, c.warnings);
      if (p.name) {
        var dup = findDuplicate(p, idx, gone);
        if (dup && dup.kind === 'exists') {
          warnings.push({ code: 'exists', text: '이미 있는 매물이에요' + (dup.prop && dup.prop.status === 'dropped' ? ' (탈락)' : '') });
        } else if (dup) {
          warnings.push({ code: 'gone', text: '전에 지운 매물이에요' });
        }
        // 코드 안 중복: 같은 매물로 판정되거나, 정리한 값이 모두 같으면(같은 블록을 두 번 붙임 등)
        var info = dupInfo(p);
        var json = JSON.stringify(p);
        if (seen.some(function (s) { return s.json === json || sameListing(info, s.info); })) {
          warnings.push({ code: 'repeat', text: '코드 안에 같은 매물이 또 있어요' });
        }
        seen.push({ info: info, json: json });
      }
      var canImport = !!p.name;
      res.entries.push({
        index: i,
        prop: p,
        notes: c.notes,
        warnings: warnings,
        canImport: canImport,
        checked: canImport && !warnings.length // 경고가 하나라도 있으면 기본으로 빼 둔다
      });
    });
    if (!res.entries.length) { res.error = 'none'; res.message = MESSAGES.none; return res; }
    res.ok = true;
    return res;
  }

  /** 정리된 매물들 → 코드 객체(빈 값은 뺌, 호수 없음). tools/make-import-code.js 가 쓴다 */
  function toCode(props) {
    var order = ['name', 'dong', 'area', 'supplyArea', 'askPrice', 'realPrice', 'tradeType', 'floor', 'direction',
      'agentName', 'agentPhone', 'sourceUrl', 'articleNo', 'confirmedAt', 'memo'];
    return {
      imjang: CODE_VERSION,
      properties: (props || []).map(function (p) {
        var o = {};
        order.forEach(function (k) {
          var v = p[k];
          if (v === null || v === undefined || v === '') return;
          o[k] = v;
        });
        return o;
      })
    };
  }

  // ---------------- 딥링크 (#/import?c=<base64url(UTF-8 JSON)>) ----------------
  function bytesToBinary(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return bin;
  }
  function utf8ToBinary(s) {
    if (typeof TextEncoder !== 'undefined') return bytesToBinary(new TextEncoder().encode(s));
    return unescape(encodeURIComponent(s));
  }
  function binaryToUtf8(bin) {
    if (typeof TextDecoder !== 'undefined') {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    return decodeURIComponent(escape(bin));
  }
  function toBase64(bin) {
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(bin, 'binary').toString('base64'); // 오래된 Node
  }
  function fromBase64(b64) {
    if (typeof atob === 'function') return atob(b64);
    return Buffer.from(b64, 'base64').toString('binary');
  }

  /** 코드(객체 또는 JSON 글) → base64url */
  function encodeLink(code) {
    var json = typeof code === 'string' ? code : JSON.stringify(code);
    return toBase64(utf8ToBinary(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** base64url → 글. 읽을 수 없으면 null */
  function decodeLink(c) {
    var s = String(c === null || c === undefined ? '' : c).trim();
    if (!s || s.length > LIMITS.linkChars || /[^A-Za-z0-9_\-+\/=]/.test(s)) return null;
    s = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (s.length % 4 === 1) return null;
    while (s.length % 4) s += '=';
    try { return binaryToUtf8(fromBase64(s)); } catch (e) { return null; }
  }

  function linkFragment(code) { return '#/import?c=' + encodeLink(code); }

  return {
    CODE_VERSION: CODE_VERSION,
    SOURCE_ID: SOURCE_ID,
    LIMITS: LIMITS,
    PROMPT: PROMPT,
    MESSAGES: MESSAGES,
    parse: parse,
    toCode: toCode,
    dupInfo: dupInfo,
    sameListing: sameListing,
    goneKey: goneKey,
    indexProps: indexProps,
    findDuplicate: findDuplicate,
    parsePrice: function (v) { return priceOf(v, '가격', [], []); },
    dongOf: function (v) { return dongOf(v); },
    phoneOf: phoneOf,
    httpUrl: httpUrl,
    urlKey: urlKey,
    articleNoFromUrl: articleNoFromUrl,
    encodeLink: encodeLink,
    decodeLink: decodeLink,
    linkFragment: linkFragment
  };
});
