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
 * 1.4.0: 네이버 부동산 매물 화면 글도 직접 읽는다(parseNaverText. Claude 없이).
 *   - 사용자가 매물 상세 화면 글을 전체 선택·복사하거나, iPad 단축어로 페이지 글(맨 앞 "URL: …" 줄)을 복사해 온다.
 *   - 앱 입력 칸과 도구는 parseText 를 쓴다: 가져오기 코드(JSON)를 먼저 찾고, 없거나 못 읽으면 네이버 글로 읽는다.
 *   - 이름표(라벨)로 필요한 블록만 읽는다. 사용자 프로필 이름·알림 수 같은 줄은 어떤 필드·메모에도 넣지 않는다.
 * 1.4.1(검토 반영): 제목은 제목 묶음 표시 줄(평당가·관심·공유) 위의 '거래 종류 + 가격'만 있는 줄에서 찾고(특징 글에 속지 않게),
 *   요약 줄의 층·향과 머리 줄 이름도 맞춰 본다. 상세 표시가 있는데 상세 매물을 못 읽으면 목록 매물을 기본 해제(detailFailed).
 *   목록 매물은 저장된 매물·지운 매물과 단지명·동·호가로 한 번 더 비교, 평에서 바꾼 면적은 "약"(근삿값),
 *   실거래 표의 가격 칸 모양 검사, 같은 면적 표가 아니면 실거래가는 메모에만, 붙은 전화번호를 못 나누면 메모로(확인 필요).
 *   tools/make-import-code.js 가 네이버 글로 만든 코드에는 "from":"naver-text" 를 넣는다(앱이 같은 주의를 보여 줌).
 * 1.6.0: "등기부 코드"도 읽는다. Claude 가 등기부등본 사진·PDF 를 읽고 답한 { "imjang": 1, "registry": { … } } 블록을
 *   parseRegistryBlock 으로 검사해 등기부 기록(snapshot: { id, source:'code', viewedAt, docType, includesCancelled, uniqueNo, area,
 *   owners, live, history, mortgages, answers, match, notes })으로 바꿔 결과의 registry 에 넣는다. properties 와 함께 와도 되고
 *   registry 만 와도 된다(그때 entries 는 빈 배열). 요청문은 REGISTRY_PROMPT. 주민등록번호처럼 보이는 글은 가린다.
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
    agentName: 60, agentPhone: 30, memo: 2000, url: 2000, articleNo: 30, confirmedAt: 30,
    // 1.6.0 등기부 코드
    regEntries: 30,   // 칸(근저당·압류 …)마다 기록 수
    regOwners: 20,    // 소유자 수
    regNotes: 10,     // Claude 가 남긴 참고 문장 수
    regNote: 300,     // 참고 문장·기록 메모 한 개 길이
    regHolder: 60,    // 권리자·채무자
    regPurpose: 40,   // 등기목적
    regOwnerName: 40, // 소유자 이름
    regBlocks: 5      // 한 글에서 살펴볼 등기부 블록 수(쓰는 것은 첫 번째뿐)
  };
  var RANGE = {
    area: [1, 1000],           // 전용면적 ㎡
    supplyArea: [1, 2000],     // 공급면적 ㎡
    price: [1, 10000000],      // 만원 (1천억까지)
    won: [1000, 1000000000000] // 1.6.0 등기부 금액: 원 (1천원 ~ 1조원)
  };
  var BAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
  var EXAMPLE_NAME = '단지명'; // 요청문 속 예시의 자리표시 이름
  var SOURCE_ID = 'claude-code';       // 가져오기 코드로 만든 매물(app.js 매물 source)
  var NAVER_SOURCE_ID = 'naver-text';  // 1.4.0: 네이버 매물 화면 글에서 읽어 만든 매물

  // Claude 채팅에 보낼 요청문. 앱 화면과 README 에 같은 문구가 들어간다(바꾸면 README 도 함께).
  var PROMPT = [
    '임장체크 앱에 넣을 매물 정보를 정리해 줘.',
    '첨부한 네이버 부동산 매물 화면(스크린샷이나 복사한 글)에서 아래 형식의 JSON만 코드 블록으로 답해 줘.',
    '- 화면에 없는 값은 빼고, 추측하지 마.',
    '- 링크만 있고 화면이나 글이 없으면 값을 만들지 말고, 화면을 보내 달라고 답해 줘.',
    '- 가격은 만원 단위 숫자 (예: 5억 2,000 → 52000).',
    '- 면적은 ㎡ 숫자 (전용면적은 area, 공급면적은 supplyArea).',
    '- 호수(ho)는 넣지 마. 동은 숫자만.',
    '- 매물이 여러 개면 properties에 모두 넣어 줘.',
    '```json',
    '{"imjang":1,"properties":[{"name":"단지명","dong":"101","area":84.97,"supplyArea":112.4,"askPrice":52000,"tradeType":"매매","floor":"12/25","direction":"남향","agentName":"","agentPhone":"","sourceUrl":"","articleNo":"","confirmedAt":"","memo":""}]}',
    '```'
  ].join('\n');

  // 1.6.0: 등기부등본 사진·PDF 를 Claude 에게 보낼 때 쓰는 요청문. README 에 같은 글이 들어간다(바꾸면 README 도 함께).
  // 예시의 이름(홍길동·김철수)·은행(○○은행)·고유번호(0000-…)는 자리표시다. match.name 이 "단지명"인 블록은 예시로 보고 건너뛴다
  var REGISTRY_PROMPT = [
    '임장체크 앱에 넣을 등기부등본 내용을 정리해 줘.',
    '첨부한 등기부등본(사진·PDF)을 읽고 아래 형식의 JSON만 코드 블록으로 답해 줘.',
    '- 빨간 실선이 그어진 기록은 말소된 것이야. 살아 있는 기록은 live, 말소된 기록은 history에 나눠 넣어.',
    '- 화면에 없는 값은 빼고, 추측하지 마. 흐리거나 잘려서 못 읽은 곳은 notes에 적어 줘.',
    '- 주민등록번호는 넣지 마(앞자리도). 권리자·채무자는 이름만 적고 등록번호·주소는 빼.',
    '- match: 표제부의 건물 이름(name), 동(dong)·호(ho)는 숫자만, 맨 위 고유번호(uniqueNo).',
    '- viewedAt: 아래쪽 "열람일시"(예: 2026-01-02T09:00). docType: "열람용" 또는 "제출용". includesCancelled: 제목에 "말소사항 포함"이 있으면 true, "현재 유효사항"이면 false.',
    '- area: 전유부분 건물 내역의 면적(㎡ 숫자, 적힌 그대로).',
    '- owners: 지금 소유자(갑구의 마지막 소유권 기록). share는 지분(혼자면 "1/1", "2분의 1"은 "1/2"), since는 그 기록의 접수일.',
    '- live·history 칸: trust(신탁) seizure(압류·가압류) injunction(가처분) auction(경매개시결정) provisional(가등기) mortgage(근저당) jeonse(전세권) lease(주택임차권) other(그 밖). 기록이 없는 칸은 빼. 소유권이전 기록과 "○번 등기말소" 줄은 넣지 마.',
    '- 기록 하나: rank(순위번호), date(접수일), purpose(등기목적), holder(권리자), amount(금액, 원 단위 숫자: 금23,400,000원 → 23400000). 근저당은 amount 대신 maxAmount(채권최고액)와 debtor(채무자). 1-1처럼 붙은 번호(부기)로 바뀐 금액·채무자·권리자는 본 기록에 반영하고 따로 넣지 마.',
    '- answers: 아래 항목마다 해당하면 "yes", 아니면 "no"(말소된 기록은 reg-history에서만 봐). 마지막 장의 "이하여백"까지 모두 보지 못했으면 "no"는 쓰지 말고 빼.',
    '  reg-land-separate(표제부 "토지별도등기 있음"), reg-trust, reg-seizure, reg-injunction, reg-auction, reg-provisional, reg-mortgage, reg-jeonse, reg-lease, reg-frequent(최근 1~2년에 소유자가 여러 번 바뀜), reg-history(말소된 압류·가압류·가처분·경매·가등기·임차권 기록이 있음. 말소사항 포함일 때만)',
    '- 위반건축물은 건축물대장에서 보는 것이라 넣지 마.',
    '```json',
    '{"imjang":1,"registry":{"match":{"name":"단지명","dong":"101","ho":"1203","uniqueNo":"0000-0000-000000"},"viewedAt":"2026-01-02T09:00","docType":"열람용","includesCancelled":true,"area":84.97,"owners":[{"name":"홍길동","share":"1/1","since":"2020-06-15"}],"live":{"mortgage":[{"rank":"3","date":"2020-06-15","purpose":"근저당권설정","maxAmount":252000000,"holder":"○○은행","debtor":"홍길동"}]},"history":{"mortgage":[{"rank":"1","date":"2012-03-02","purpose":"근저당권설정","maxAmount":97500000,"holder":"○○은행","debtor":"김철수"}]},"answers":{"reg-land-separate":"no","reg-trust":"no","reg-seizure":"no","reg-injunction":"no","reg-auction":"no","reg-provisional":"no","reg-mortgage":"yes","reg-jeonse":"no","reg-lease":"no","reg-frequent":"no","reg-history":"no"},"notes":[]}}',
    '```'
  ].join('\n');

  var MESSAGES = {
    empty: '',
    'too-big': '붙여 넣은 글이 너무 길어요(200KB까지). Claude 답변은 코드 부분만, 네이버 글은 매물 화면 하나만 복사해 붙여 주세요.',
    notfound: '코드를 찾지 못했어요. Claude 답변 전체를 복사해 붙여 주세요.',
    broken: '코드가 잘렸거나 깨져 있어요. Claude 답변의 코드 블록 전체를 다시 복사해 붙여 주세요.',
    'too-many': '글에 코드 같은 부분이 너무 많아 끝까지 읽지 못했어요. Claude 답변의 코드 부분만 복사해 붙여 주세요.',
    comment: '코드 안에 설명(주석)이 섞여 있어 읽지 못했어요. Claude에게 "JSON만 다시 보내 줘"라고 해 보세요.',
    example: '요청문 속 예시만 있어요. Claude가 답한 코드를 복사해 붙여 주세요.',
    none: '코드에 매물이 없어요. 매물 화면이 잘 보이게 다시 캡처해서 Claude에게 보내 보세요.',
    // 1.4.0 (parseText·parseNaverText)
    nothing: '코드나 네이버 매물 글을 찾지 못했어요. Claude 답변 전체나, 네이버 매물 상세 화면의 글 전체를 복사해 붙여 주세요.',
    naver: '네이버 글에서 매물을 찾지 못했어요. 매물 상세 화면을 연 채로 글 전체를 복사해 붙여 주세요.',
    // 1.4.1: 상세 화면 글은 있는데 제목·가격을 읽지 못함(다시 복사해도 같으므로 다른 방법을 안내)
    'naver-detail': '매물 상세 화면 글인데 단지명·가격을 읽지 못했어요. 네이버 화면 모양이 달라졌을 수 있어요. [매물 추가]로 직접 넣거나 Claude 방법을 써 주세요.',
    // 1.6.0: 등기부 코드("registry")는 있는데 읽을 수 있는 값이 하나도 없음(매물도 없음)
    'reg-empty': '등기부 코드에 읽을 수 있는 내용이 없어요. 등기부가 잘 보이게 다시 찍어(또는 PDF로) Claude에게 보내 보세요.'
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

  /**
   * 1.6.0: 해석한 값에서 등기부 블록(들)을 꺼낸다. { "registry": {…} }(배열이면 객체만), 또는 감싸지 않은 등기부 객체
   * (properties·name 이 없고 live·history·owners·match 중 하나가 있음). 없으면 빈 배열
   */
  function registryFrom(v) {
    if (!isObj(v)) return [];
    if (has(v, 'registry')) {
      var r = v.registry;
      if (isObj(r)) return [r];
      return Array.isArray(r) ? r.filter(isObj) : [];
    }
    if (has(v, 'properties') || has(v, 'name')) return [];
    return (has(v, 'live') || has(v, 'history') || has(v, 'owners') || has(v, 'match')) ? [v] : [];
  }
  /**
   * 요청문 속 등기부 예시: match.name 이 "단지명"이고 고유번호가 없거나 예시 값(0000-…)이다.
   * (Claude 가 건물 이름 자리에 "단지명"을 베껴 써도 진짜 고유번호가 있으면 답으로 읽는다)
   */
  function isRegistryExample(r) {
    var m = get(r, 'match');
    if (get(m, 'name') !== EXAMPLE_NAME) return false;
    var no = get(m, 'uniqueNo');
    return !uniqueNoOf(no === undefined || no === null || no === '' ? get(r, 'uniqueNo') : no);
  }

  // 코드처럼 보이는 시작: {"… 또는 [{… 또는 []
  var JSONISH_RE = /^(?:\{\s*"|\[\s*[{\]])/;

  /**
   * 한 가지 글에서 찾기. 글 끝까지 보면서 코드 블록을 모두 모은다
   * (Claude 는 스크린샷이 여러 장이면 블록을 나눠 답하기도 한다. 첫 블록만 담고 나머지를 조용히 버리지 않게).
   * 코드처럼 보이는 곳({"… [{…)만 짝을 맞춰 읽고, 설명 글 속 괄호("[참고]")는 한 글자씩 건너뛴다(횟수에 세지 않음).
   * 결과: { list, registry(1.6.0: 등기부 블록 원본 배열), blocks(읽은 코드 수), incomplete(코드 후보가 너무 많아 끝까지 못 봄),
   *         naver(네이버 글로 만든 코드가 있음, 1.4.1) }. 등기부 블록만 있으면 list 는 빈 배열
   *       또는 { error: 'notfound' | 'broken' | 'comment' | 'example' | 'none' | 'too-many' }
   */
  function scan(t) {
    var i = 0;
    var tries = 0;
    var sawExample = false;
    var sawEmpty = false;
    var lists = [];
    var regs = []; // 1.6.0: 등기부 블록(원본)
    var blocks = 0;
    var incomplete = false;
    var fromNaver = false; // 1.4.1: tools/make-import-code.js 가 네이버 글로 만든 코드("from":"naver-text")
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
      var used = false;
      if (list) {
        if (!list.length) sawEmpty = true;
        else if (isExampleOnly(list)) sawExample = true; // 요청문 예시는 건너뛴다
        else {
          lists.push(list);
          used = true;
          if (isObj(r.value) && get(r.value, 'from') === NAVER_SOURCE_ID) fromNaver = true;
        }
      }
      // 1.6.0: 등기부 블록. 같은 블록에 properties 와 함께 있어도 된다. 등기부 요청문 예시는 건너뛴다
      registryFrom(r.value).forEach(function (reg) {
        if (isRegistryExample(reg)) sawExample = true;
        else if (regs.length < LIMITS.regBlocks) { regs.push(reg); used = true; }
      });
      if (used) blocks++;
      i = end + 1; // 이 덩어리 안쪽은 다시 보지 않는다
    }
    if (lists.length || regs.length) {
      var all = [];
      lists.forEach(function (l) { for (var k = 0; k < l.length; k++) all.push(l[k]); });
      return { list: all, registry: regs, blocks: blocks, incomplete: incomplete, naver: fromNaver };
    }
    if (incomplete) return { error: 'too-many' };
    return { error: sawEmpty ? 'none' : (sawExample ? 'example' : 'notfound') };
  }

  /** scan 결과에서 찾은 것의 수(매물 + 등기부 블록) */
  function foundCount(f) { return (f.list ? f.list.length : 0) + (f.registry ? f.registry.length : 0); }

  /** 글에서 코드를 찾는다. 원문으로 먼저, 스마트 따옴표(“ ” ‘ ’)를 일반 따옴표로 바꿔 한 번 더 */
  function extract(src) {
    var t = src.replace(/^﻿/, '');
    var first = scan(t);
    var smart = t.replace(/[“”„‟″＂]/g, '"').replace(/[‘’‚‛′]/g, "'");
    if (smart === t) return first;
    var second = scan(smart);
    if (first.list) {
      // 블록마다 따옴표가 다를 때(일부만 스마트 따옴표): 바꿔 읽어 매물(1.6.0: + 등기부 블록)이 더 많이 나오면 그쪽을 쓴다
      return second.list && foundCount(second) > foundCount(first) ? second : first;
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

  /** 네이버 부동산 링크에서 매물번호 꺼내기 (?articleNo=…, ?articleId=…(1.4.0), /article/info/…, /articles/…) */
  function articleNoFromUrl(href) {
    var u;
    try { u = new URL(href); } catch (e) { return ''; }
    if (!/(^|\.)naver\.com$/i.test(u.hostname)) return '';
    var q = /[?&]article(?:No|Id)=(\d{5,20})(?:&|$)/.exec(u.search);
    if (q) return q[1];
    var m = /\/articles?\/(?:info\/)?(\d{5,20})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : '';
  }

  // 국내 전화번호: 02-555-1234, (02) 555-1234, 031)123-4567, 010-1234-5678, 0507-1234-5678, +82 10-1234-5678, 1588-1234
  var PHONE_RE = /(?:\+82[\s.-]?0?|\(0|\b0)\d{1,3}[\s.)-]{0,2}\d{3,4}[\s.-]{0,2}\d{4}(?!\d)|\b1[5-9]\d{2}[\s.-]?\d{4}(?!\d)/g;

  /**
   * 사이 없이 붙은 번호를 띄운다(1.4.0). 네이버 중개사 전화 칸을 복사하면 "032-551-4700010-8973-4700"처럼 붙어 온다.
   * 끝 네 자리 바로 뒤에 새 번호의 시작(0으로 시작하는 국번 + 구분 기호, 휴대폰 11자리, 15xx-)이 오면 그 사이를 띄운다
   */
  function splitGluedPhones(s) {
    return s.replace(/([-.\s)]\d{4})(?=0\d{1,3}[-.\s)]|01[016789]\d{7,8}(?!\d)|1[5-9]\d{2}[-.\s])/g, '$1 ');
  }

  // 구분 기호로 뚜렷이 나뉜 맨 앞 번호(02-555-1234). 뒤에 숫자가 바로 붙어 있어도 이 부분은 한 번호다(끝 네 자리)
  var PHONE_HEAD_RE = /^(?:\+82[\s.-]?0?|\(0|0)\d{1,3}[\s.)-]{1,2}\d{3,4}[\s.-]{1,2}\d{4}/;

  /**
   * 중개사 연락처 → { phone, others }. 번호가 여러 개면("대표 02-555-1234 / 휴대폰 010-…") 첫 번호만 phone 에 넣는다
   * (두 번호를 붙이면 [전화] 버튼이 엉뚱한 번호로 건다). 나머지는 others 로 돌려준다.
   * 1.4.1: 둘째 번호가 구분 기호 없이 붙어 나누지 못하면(숫자 13자리 이상) 숫자 덩어리를 통째로 넣지 않는다.
   * 맨 앞 번호가 구분 기호로 뚜렷하면 그것만 phone 이고 남은 글은 unsure(확인 필요, unsureOther). 아니면 phone 은 비우고 원문을 unsure 로
   */
  function phoneOf(v) {
    var s = splitGluedPhones(oneLine(v, 100));
    var found = s.match(PHONE_RE);
    if (!found) {
      if (s.replace(/\D/g, '').length > 12) {
        var head = PHONE_HEAD_RE.exec(s);
        if (head) return { phone: cut(head[0].replace(/\s+/g, ' ').trim(), LIMITS.agentPhone), others: [], unsure: cut(s.slice(head[0].length).trim(), 40), unsureOther: true };
        return { phone: '', others: [], unsure: cut(s, 60) };
      }
      return { phone: cut(s.replace(/[^0-9+\-() ]/g, '').replace(/\s+/g, ' ').trim(), LIMITS.agentPhone), others: [] };
    }
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
    if (phone.unsure) { // 1.4.1: 붙어 온 번호를 나누지 못함. 숫자 덩어리로 [전화]를 걸지 않게 메모로
      p.memo = cut((p.memo ? p.memo + '\n' : '') + (phone.unsureOther ? '다른 연락처(확인 필요): ' : '연락처(확인 필요): ') + phone.unsure, LIMITS.memo);
      addNote(notes, '연락처: 번호가 붙어 있어 나누지 못했어요. 메모를 보고 확인하세요');
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

  // ---------------- 등기부 코드 (1.6.0) ----------------
  // Claude 가 등기부등본 사진·PDF 를 읽고 답한 "registry" 블록 → 등기부 기록(snapshot). 모양은 registry-parser.js 가 PDF 글에서
  // 만드는 기록과 같고 출처만 source: 'code' 다.
  //   { id, source: 'code', viewedAt: 'YYYY-MM-DDTHH:MM' | 'YYYY-MM-DD' | '', docType: '열람용' | '제출용' | '',
  //     includesCancelled: true | false | null, uniqueNo: '0000-0000-000000' | '', area: ㎡ | null,
  //     owners: [{ name, share: '1/2', since: 'YYYY-MM-DD' }], live: { 칸: [기록] }, history: { 칸: [기록] },
  //     mortgages: [살아 있는 근저당(live.mortgage 사본)], answers: { 항목 id: 'yes' | 'no' | 'done' },
  //     match: { name, dong, ho }, notes: [Claude 가 남긴 참고 문장] }
  //   칸: trust seizure injunction auction provisional mortgage jeonse lease other. 코드에 있던 칸만 둔다(빈 배열도 그대로).
  //   기록: { section('gap'|'eul'), rank, date, purpose, holder, (근저당) maxAmount·debtor | (전세권·임차권) deposit | amount,
  //          (말소) cancelledAt, text } 값이 있는 키만. 금액은 원. 이름은 registry-parser.js 의 기록 요약(brief)과 맞췄다.
  //   앱(app.js normalizeSnapshot)이 이 기록을 저장 모양으로 다시 정리한다(viewedAt → ms, live·history → 줄 목록 등).
  // 믿지 않는 글이므로 아는 키만 골라 새 객체를 만들고(길이·범위·모양 검사), 모르는 항목 id·값은 버리고 참고 문구로 알린다.
  // 멈춤 신호를 놓치지 않게: 살아 있는 기록이 있는 칸의 항목은 Claude 가 "no"라고 했어도 "yes"로 바꾼다(경고 conflict).
  // "no"는 코드에 적힌 답만 쓴다(빈 칸·빠진 칸으로 "없음"을 짐작하지 않음).

  var REG_CATS = ['trust', 'seizure', 'injunction', 'auction', 'provisional', 'mortgage', 'jeonse', 'lease', 'other'];
  var REG_CAT_LABEL = { trust: '신탁', seizure: '압류·가압류', injunction: '가처분', auction: '경매개시결정', provisional: '가등기',
    mortgage: '근저당', jeonse: '전세권', lease: '임차권등기', other: '그 밖의 기록' };
  /** 칸 → 체크리스트 항목(data.js 등기부 섹션 flag). 살아 있는 기록이 있으면 그 항목이 "있음" */
  var REG_CAT_ITEM = { trust: 'reg-trust', seizure: 'reg-seizure', injunction: 'reg-injunction', auction: 'reg-auction',
    provisional: 'reg-provisional', mortgage: 'reg-mortgage', jeonse: 'reg-jeonse', lease: 'reg-lease' };
  /** Claude 가 칸 이름을 한글·복수형으로 적었을 때 */
  var REG_CAT_ALIAS = { '신탁': 'trust', seizures: 'seizure', '압류': 'seizure', '가압류': 'seizure', '압류·가압류': 'seizure',
    injunctions: 'injunction', '가처분': 'injunction', auctions: 'auction', '경매': 'auction', '경매개시결정': 'auction',
    '가등기': 'provisional', mortgages: 'mortgage', '근저당': 'mortgage', '근저당권': 'mortgage', '전세권': 'jeonse',
    leases: 'lease', '임차권': 'lease', '임차권등기': 'lease', '주택임차권': 'lease', others: 'other', '기타': 'other' };
  /** 칸 → 등기부의 구(registry-parser.js brief 의 section 과 같은 값. 앱 기록 줄의 part). other 는 어느 쪽인지 몰라 비움 */
  var REG_CAT_SECTION = { trust: 'gap', seizure: 'gap', injunction: 'gap', auction: 'gap', provisional: 'gap',
    mortgage: 'eul', jeonse: 'eul', lease: 'eul' };
  /** 말소된 이 칸의 기록이 있으면 reg-history(지난 기록) "있음". 분양 때 신탁·갚고 지운 근저당·전세권은 흔해서 세지 않는다(data.js reg-history tip) */
  var REG_HISTORY_CATS = ['seizure', 'injunction', 'auction', 'provisional', 'lease'];
  /** 코드로 받는 답 [id, type, 짧은 이름](data.js 순서). flag 는 'yes'/'no', check 는 'done'(확인함)만 */
  var REG_ANSWERS = [
    ['reg-view', 'check', '열람'], ['reg-land-separate', 'flag', '토지별도등기'], ['reg-joint', 'check', '공동명의 확인'],
    ['reg-period', 'check', '소유 기간 확인'], ['reg-trust', 'flag', '신탁'], ['reg-seizure', 'flag', '압류·가압류'],
    ['reg-injunction', 'flag', '가처분'], ['reg-auction', 'flag', '경매개시결정'], ['reg-provisional', 'flag', '가등기'],
    ['reg-frequent', 'flag', '잦은 소유자 변경'], ['reg-mortgage', 'flag', '근저당'], ['reg-jeonse', 'flag', '전세권'],
    ['reg-lease', 'flag', '임차권등기'], ['reg-history', 'flag', '지난 기록'], ['reg-date', 'check', '열람 일시 기록']
  ];
  var REG_ANSWER_TYPES = {};
  var REG_ANSWER_LABEL = {};
  REG_ANSWERS.forEach(function (a) { REG_ANSWER_TYPES[a[0]] = a[1]; REG_ANSWER_LABEL[a[0]] = a[2]; });
  /** 등기부 섹션 항목이지만 등기부 코드로는 답하지 않는 것 → 버리며 남길 참고 문구 */
  var REG_ANSWER_SKIP = {
    'reg-title': '표제부: 중개사 설명과 비교하는 항목이라 코드 답은 뺐어요(직접 확인)',
    'reg-owner-diff': '소유자 ≠ 매도인: 매도인과 비교하는 항목이라 코드 답은 뺐어요(직접 확인)',
    'reg-building': '위반건축물: 건축물대장에서 보는 항목이라 코드 답은 뺐어요'
  };
  var REG_WHERE_LABEL = { live: '살아 있는 기록', history: '말소된 기록' };

  // 주민등록번호(가린 것 포함: "800101-1******", "800101-*******"). 법인등록번호도 같은 모양이라 함께 가려진다(괜찮음)
  var RRN_RE = /\d{6}\s*-\s*[\d*]{7}/g;
  // 붙여 쓴 13자리: 앞 6자리가 날짜 모양이고 7번째가 1~8 (ES5: 뒤돌아보기 없이 앞 글자를 잡아 되돌림)
  var RRN_BARE_RE = /(^|[^\d])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[1-8][\d*]{6}(?!\d)/g;
  var RRN_MASK = '******-*******';
  /** 주민등록번호처럼 보이는 글을 ******-******* 로 가린다 */
  function maskRrn(s) {
    return String(s).replace(RRN_RE, RRN_MASK).replace(RRN_BARE_RE, function (m, pre) { return pre + RRN_MASK; });
  }
  /** 등기부 한 줄 글: 주민등록번호를 먼저 가리고(자른 자리에 앞자리만 남지 않게) 길이를 자른다. 가렸으면 ctx.rrn */
  function regText(v, max, ctx) {
    var s = oneLine(v, LIMITS.inputChars);
    if (!s) return '';
    var masked = maskRrn(s);
    if (masked !== s && ctx) ctx.rrn = true;
    return cut(masked, max);
  }
  /** "없음"·"none" 같은 말(빈 칸으로 본다) */
  function noneWord(v) { return typeof v === 'string' && /^(없음|없다|해당없음|none|no|n\/a|-)$/i.test(v.replace(/\s+/g, '')); }

  var REG_DATE_RE = /^(\d{4})\s*(?:[.\-\/]|년)\s*(\d{1,2})\s*(?:[.\-\/]|월)\s*(\d{1,2})\s*(?:일|\.)?/;
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  /** 날짜 → 'YYYY-MM-DD'. "2020-01-02", "2020.1.2.", "2020년1월2일" 모두. 없는 날짜·범위 밖(1900~2100)은 '' */
  function regDate(v) {
    var m = REG_DATE_RE.exec(oneLine(v, 40));
    if (!m) return '';
    var y = +m[1];
    var mo = +m[2];
    var d = +m[3];
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  /** 열람 일시 → 'YYYY-MM-DDTHH:MM'(시각이 없으면 'YYYY-MM-DD'). "2026년1월2일 09시00분00초"도 받는다(초는 버림) */
  function regDateTime(v) {
    var s = oneLine(v, 40);
    var date = regDate(s);
    if (!date) return '';
    var t = /^\s*T?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})/.exec(s.slice(REG_DATE_RE.exec(s)[0].length));
    return t && +t[1] < 24 && +t[2] < 60 ? date + 'T' + pad2(+t[1]) + ':' + pad2(+t[2]) : date;
  }
  /** 원 → "120,000,000원" (경고 문구용) */
  function wonText(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; }
  /**
   * 등기부 금액 → 원 정수(또는 null). 숫자, "금120,000,000원", "120,000,000", "1억 2,000만원" 모두 받는다.
   * 범위(1천원~1조원) 밖이거나 읽을 수 없으면 빼고 참고 문구. warnBelow 보다 작으면 경고 smallamount(만원 단위로 적은 실수 등)
   */
  function wonOf(v, label, ctx, warnBelow) {
    if (v === null || v === undefined || v === '') return null;
    var n = null;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string') {
      var s = v.replace(/\s+/g, '');
      if (/[억만천]/.test(s)) {
        var mw = parseMoneyText(s); // 만원
        n = mw === null ? null : mw * 10000;
      } else if (/^금?\d[\d,]*(?:\.\d+)?원?$/.test(s)) n = parseFloat(s.replace(/[^\d.]/g, ''));
    }
    if (n === null || !isFinite(n) || n < RANGE.won[0] || n > RANGE.won[1]) {
      addNote(ctx.notes, label + ': 금액이 이상해서 뺐어요');
      return null;
    }
    n = Math.round(n);
    if (warnBelow && n < warnBelow) {
      ctx.warnings.push({ code: 'smallamount', text: label + ' ' + wonText(n) + '은 너무 작아요. 원 단위가 맞는지 확인하세요' });
    }
    return n;
  }
  /** 순위번호: "5", "1-1", "1 (전 1)" → 앞의 번호만 */
  function rankOf(v) {
    var m = /^\d{1,4}(?:-\d{1,4}){0,3}/.exec(oneLine(v, 30).replace(/\s+/g, '').replace(/^제/, ''));
    return m ? m[0] : '';
  }
  /** 호: "1203", "제1203호", "101동 1203호", "제12층 제1203호", "101-1203" → 호 번호만. 못 읽으면 '' */
  function hoOf(v) {
    var s = oneLine(v, 30).replace(/\s+/g, '').replace(/^제(?=\d)/, '');
    if (!s) return '';
    var d = /^\d{1,4}-(\d{1,5})호?$/.exec(s);
    if (d) return d[1];
    var m = /^(?:제?[0-9A-Za-z가-힣]+동)?(?:제?\d{1,3}층)?제?([0-9A-Za-z]{1,8})호?$/.exec(s);
    return m ? m[1] : '';
  }
  /** 고유번호: 4-4-6 자리(붙여 써도 됨). 모두 0(요청문 예시)이면 '' */
  function uniqueNoOf(v) {
    var m = /^(\d{4})-?(\d{4})-?(\d{6})$/.exec(oneLine(v, 40).replace(/\s+/g, ''));
    if (!m || /^0+$/.test(m[1] + m[2] + m[3])) return '';
    return m[1] + '-' + m[2] + '-' + m[3];
  }
  function docTypeOf(v) {
    var s = oneLine(v, 20).replace(/\s+/g, '');
    if (/열람/.test(s)) return '열람용';
    if (/제출|발급/.test(s)) return '제출용';
    return '';
  }
  /** 말소사항 포함 여부: true / false / 모름 null */
  function cancelledOf(v) {
    if (typeof v === 'boolean') return v;
    var s = oneLine(v, 20).replace(/\s+/g, '').toLowerCase();
    if (/^(true|yes|예|포함|말소사항포함)$/.test(s)) return true;
    if (/^(false|no|아니오|아니요|미포함|현재유효사항)$/.test(s)) return false;
    return null;
  }
  /** 지분: "1/2", "2분의 1" → "1/2", "단독" → "1/1". 모양이 다르면 '' */
  function shareOf(v) {
    var s = oneLine(v, 30).replace(/\s+/g, '').replace(/^지분/, '');
    if (!s) return '';
    if (/^(단독(소유)?|전부|1)$/.test(s)) return '1/1';
    var a;
    var b;
    var m = /^(\d{1,6})\/(\d{1,6})$/.exec(s);
    if (m) { a = +m[1]; b = +m[2]; }
    else if ((m = /^(\d{1,6})분의(\d{1,6})$/.exec(s))) { a = +m[2]; b = +m[1]; }
    else return '';
    return a > 0 && b > 0 && a <= b ? a + '/' + b : '';
  }

  /**
   * 기록 하나 → { section, rank, date, purpose, holder, maxAmount·debtor(근저당) | deposit(전세권·임차권) | amount, cancelledAt(말소), text }
   * 또는 null(읽을 값 없음). section('gap'|'eul')은 칸에서 정한다. 이름은 registry-parser.js 의 brief 와 맞췄다
   * (앱 normalizeSnapshot 이 둘을 같은 기록 줄로 바꾼다. 글 한 줄로 온 기록은 text 로)
   */
  function regEntry(raw, cat, where, ctx) {
    var e = regEntryBody(raw, cat, where, ctx);
    if (!e || !has(REG_CAT_SECTION, cat)) return e;
    var o = { section: REG_CAT_SECTION[cat] };
    Object.keys(e).forEach(function (k) { o[k] = e[k]; });
    return o;
  }
  function regEntryBody(raw, cat, where, ctx) {
    if (typeof raw === 'string') { // "2023-01-05 가압류 ○○보증" 처럼 글로 적은 기록
      var only = regText(raw, LIMITS.regNote, ctx);
      return only ? { text: only } : null;
    }
    if (!isObj(raw)) return null;
    var e = {};
    var live = where === 'live';
    var rank = rankOf(get(raw, 'rank'));
    if (rank) e.rank = rank;
    var date = regDate(get(raw, 'date'));
    if (date) e.date = date;
    var purpose = regText(get(raw, 'purpose'), LIMITS.regPurpose, ctx);
    if (purpose) e.purpose = purpose;
    var holder = regText(get(raw, 'holder'), LIMITS.regHolder, ctx);
    if (holder) e.holder = holder;
    var label = (live ? '' : '말소된 ') + REG_CAT_LABEL[cat] + (rank ? ' ' + rank + '번' : '');
    var amt;
    if (cat === 'mortgage') {
      amt = get(raw, 'maxAmount');
      if (amt === undefined || amt === null || amt === '') amt = get(raw, 'amount');
      var max = wonOf(amt, label + ' 채권최고액', ctx, live ? 1000000 : 0);
      if (max !== null) e.maxAmount = max;
      var debtor = regText(get(raw, 'debtor'), LIMITS.regHolder, ctx);
      if (debtor) e.debtor = debtor;
    } else {
      // 금액 이름은 아무거나 받는다(amount·deposit·maxAmount). 전세권·임차권은 보증금(deposit), 그 밖은 amount 로 둔다
      var keys = ['amount', 'deposit', 'maxAmount'];
      for (var i = 0; i < keys.length; i++) {
        amt = get(raw, keys[i]);
        if (amt !== undefined && amt !== null && amt !== '') break;
      }
      var dep = cat === 'jeonse' || cat === 'lease';
      var amount = wonOf(amt, label + (dep ? ' 보증금' : ' 금액'), ctx, live ? (dep ? 1000000 : 10000) : 0);
      if (amount !== null) e[dep ? 'deposit' : 'amount'] = amount;
    }
    if (!live) {
      var cancelledAt = regDate(get(raw, 'cancelledAt'));
      if (cancelledAt) e.cancelledAt = cancelledAt;
    }
    var t = get(raw, 'text');
    var text = regText(t === undefined || t === null || t === '' ? get(raw, 'note') : t, LIMITS.regNote, ctx);
    if (text) e.text = text;
    return Object.keys(e).length ? e : null;
  }

  /** live / history → { 칸: [기록] }. 모르는 칸·목록이 아닌 값·읽지 못한 기록은 빼고 참고 문구 */
  function regLists(raw, where, ctx) {
    var out = {};
    if (raw === undefined || raw === null) return out;
    var wl = REG_WHERE_LABEL[where];
    if (!isObj(raw)) { addNote(ctx.notes, wl + ': 모양이 달라 뺐어요'); return out; }
    Object.keys(raw).forEach(function (k) {
      if (has(BAD_KEYS, k)) return;
      var cat = has(REG_CAT_LABEL, k) ? k : (has(REG_CAT_ALIAS, k) ? REG_CAT_ALIAS[k] : '');
      if (!cat) { addNote(ctx.notes, wl + ': 모르는 칸이라 뺐어요 "' + regText(k, 20, ctx) + '"'); return; }
      var v = raw[k];
      if (v === null || v === undefined || noneWord(v)) v = [];
      else if (isObj(v) || typeof v === 'string') v = [v];
      if (!Array.isArray(v)) { addNote(ctx.notes, wl + ' ' + REG_CAT_LABEL[cat] + ': 목록이 아니라 뺐어요'); return; }
      var list = has(out, cat) ? out[cat] : (out[cat] = []);
      var bad = 0;
      var over = 0;
      v.forEach(function (x) {
        if (noneWord(x) || (isObj(x) && !Object.keys(x).length)) return; // "없음", {} 는 조용히 건너뜀
        var e = regEntry(x, cat, where, ctx);
        if (!e) { bad++; return; }
        if (list.length >= LIMITS.regEntries) { over++; return; }
        list.push(e);
      });
      if (bad) addNote(ctx.notes, wl + ' ' + REG_CAT_LABEL[cat] + ': 읽지 못한 기록 ' + bad + '개는 뺐어요');
      if (over) addNote(ctx.notes, wl + ' ' + REG_CAT_LABEL[cat] + ': ' + LIMITS.regEntries + '개까지만 넣었어요');
    });
    return out;
  }

  /** owners → [{ name, share, since }]. 이름 뒤에 붙은 주민등록번호(가린 것 포함)는 지운다 */
  function regOwners(raw, ctx) {
    var out = [];
    if (raw === undefined || raw === null) return out;
    if (isObj(raw) || typeof raw === 'string') raw = [raw];
    if (!Array.isArray(raw)) { addNote(ctx.notes, '소유자: 목록이 아니라 뺐어요'); return out; }
    var over = 0;
    raw.forEach(function (o) {
      if (typeof o === 'string') o = { name: o };
      if (!isObj(o)) return;
      var w = {};
      var name = regText(get(o, 'name'), LIMITS.regOwnerName + 20, ctx)
        .replace(/\(?\s*\*{6}-\*{7}\s*\)?/g, ' ').replace(/\s+/g, ' ').trim();
      if (name) w.name = cut(name, LIMITS.regOwnerName);
      var rawShare = get(o, 'share');
      var share = shareOf(rawShare);
      if (share) w.share = share;
      else if (oneLine(rawShare, 30)) addNote(ctx.notes, '소유자 지분: 모양이 달라 뺐어요');
      var since = regDate(get(o, 'since'));
      if (since) w.since = since;
      if (!Object.keys(w).length) return;
      if (out.length >= LIMITS.regOwners) { over++; return; }
      out.push(w);
    });
    if (over) addNote(ctx.notes, '소유자: ' + LIMITS.regOwners + '명까지만 넣었어요');
    return out;
  }

  /** flag: 'yes'/'no', check: 'done'. 답 없음(모름·빈 값·check 의 "no")은 '', 알 수 없는 값은 null */
  function answerOf(type, v) {
    var s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : oneLine(v, 20).replace(/\s+/g, '').toLowerCase();
    if (!s || /^(null|unknown|모름|확인못함|못봄|-)$/.test(s)) return '';
    if (type === 'flag') {
      if (/^(yes|y|있음|있다|true)$/.test(s)) return 'yes';
      if (/^(no|n|없음|없다|false)$/.test(s)) return 'no';
      return null;
    }
    if (/^(done|yes|y|true|확인|확인함|했음)$/.test(s)) return 'done';
    if (/^(no|n|false|안함|안했음)$/.test(s)) return '';
    return null;
  }
  /** answers → { 항목 id: 값 }. 모르는 id(다른 섹션 포함)·코드로 답하지 않는 항목·알 수 없는 값은 빼고 참고 문구 */
  function regAnswers(raw, ctx) {
    var out = {};
    if (raw === undefined || raw === null) return out;
    if (!isObj(raw)) { addNote(ctx.notes, '답(answers): 모양이 달라 뺐어요'); return out; }
    Object.keys(raw).forEach(function (k) {
      if (has(BAD_KEYS, k)) return;
      var id = oneLine(k, 40);
      if (has(REG_ANSWER_SKIP, id)) { addNote(ctx.notes, REG_ANSWER_SKIP[id]); return; }
      if (!has(REG_ANSWER_TYPES, id)) { addNote(ctx.notes, '등기부 항목이 아니라 뺐어요: "' + regText(k, 30, ctx) + '"'); return; }
      var v = answerOf(REG_ANSWER_TYPES[id], raw[k]);
      if (v) out[id] = v;
      else if (v === null) addNote(ctx.notes, REG_ANSWER_LABEL[id] + ': 답 "' + regText(raw[k], 20, ctx) + '"을 알 수 없어 뺐어요');
    });
    return out;
  }

  /** Claude 가 남긴 참고 문장(notes) → 문자열 배열(주민등록번호는 가림) */
  function regNotes(raw, ctx) {
    if (raw === undefined || raw === null) return [];
    var list = typeof raw === 'string' ? [raw] : (Array.isArray(raw) ? raw : null);
    if (!list) { addNote(ctx.notes, '참고(notes): 모양이 달라 뺐어요'); return []; }
    var out = [];
    list.forEach(function (x) {
      var s = regText(x, LIMITS.regNote, ctx);
      if (s && out.length < LIMITS.regNotes && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /** 등기부 기록 id: 'rg-' + 시각(36진수) + '-' + 임의 8자 */
  function regId() {
    var rand = '';
    try {
      var c = typeof crypto !== 'undefined' ? crypto : null;
      if (c && c.getRandomValues) {
        var b = new Uint8Array(4);
        c.getRandomValues(b);
        for (var i = 0; i < b.length; i++) rand += (b[i] < 16 ? '0' : '') + b[i].toString(16);
      }
    } catch (e) { rand = ''; }
    if (!rand) rand = Math.random().toString(16).slice(2, 10);
    return 'rg-' + Date.now().toString(36) + '-' + rand;
  }
  function copyJson(v) { return JSON.parse(JSON.stringify(v)); }

  /**
   * 등기부 코드 블록 하나 → { snapshot, notes(앱이 보여 줄 참고 문구), warnings([{ code, text }]) }.
   * raw 는 registry 객체(또는 { registry: {…} } 코드 전체). 읽을 값(고유번호·열람 일시·면적·소유자·기록·답)이 하나도 없으면 snapshot 은 null.
   * opts.id: 기록 id(없으면 새로 만듦)
   * warning code: conflict(살아 있는 기록이 있는데 답이 "no" → "yes"로 바꿈) / smallamount(금액이 너무 작음: 단위 확인)
   * 답 채우기: 살아 있는 기록이 있는 칸 → 그 항목 "yes", 말소된 압류·가압류·가처분·경매·가등기·임차권 → reg-history "yes",
   *   말소사항 포함이 아니면(false) reg-history "no"는 버림, 확인 항목 reg-view(늘)·reg-date(열람 일시)·reg-joint(소유자)·
   *   reg-period(소유자 모두 접수일) → "done"
   */
  function parseRegistryBlock(raw, opts) {
    opts = opts || {};
    var ctx = { notes: [], warnings: [], rrn: false };
    if (isObj(raw) && has(raw, 'registry') && isObj(raw.registry)) raw = raw.registry;
    if (!isObj(raw)) return { snapshot: null, notes: ['등기부: 모양이 달라 읽지 못했어요'], warnings: [] };

    var m = get(raw, 'match');
    if (m !== undefined && m !== null && !isObj(m)) { addNote(ctx.notes, '건물(match): 모양이 달라 뺐어요'); m = null; }
    var match = { name: regText(get(m, 'name'), LIMITS.name, ctx), dong: dongOf(get(m, 'dong')), ho: hoOf(get(m, 'ho')) };
    if (match.name === EXAMPLE_NAME) match.name = ''; // 요청문 예시의 자리표시를 베껴 쓴 것
    if (!match.ho && oneLine(get(m, 'ho'), 30)) addNote(ctx.notes, '호: 모양이 달라 뺐어요');
    var rawNo = get(m, 'uniqueNo');
    if (rawNo === undefined || rawNo === null || rawNo === '') rawNo = get(raw, 'uniqueNo');
    var uniqueNo = uniqueNoOf(rawNo);
    if (!uniqueNo && oneLine(rawNo, 40)) addNote(ctx.notes, '고유번호: 모양이 달라 뺐어요(0000-0000-000000 모양)');
    var viewedAt = regDateTime(get(raw, 'viewedAt'));
    if (!viewedAt && oneLine(get(raw, 'viewedAt'), 40)) addNote(ctx.notes, '열람 일시: 날짜를 읽지 못해 뺐어요');
    var docType = docTypeOf(get(raw, 'docType'));
    var includesCancelled = cancelledOf(get(raw, 'includesCancelled'));
    var area = null;
    var rawArea = get(raw, 'area');
    if (rawArea !== undefined && rawArea !== null && rawArea !== '') {
      var am = typeof rawArea === 'number' ? [0, String(rawArea)]
        : /^\s*(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|제곱미터)?\s*$/i.exec(typeof rawArea === 'string' ? rawArea.replace(/,/g, '') : '');
      var an = am ? parseFloat(am[1]) : NaN;
      if (isFinite(an) && an >= RANGE.area[0] && an <= RANGE.area[1]) area = Math.round(an * 1000) / 1000; // 등기부는 소수 셋째 자리까지 적음
      else addNote(ctx.notes, '전용면적: 값이 이상해서 뺐어요');
    }
    var owners = regOwners(get(raw, 'owners'), ctx);
    var live = regLists(get(raw, 'live'), 'live', ctx);
    var history = regLists(get(raw, 'history'), 'history', ctx);
    var answers = regAnswers(get(raw, 'answers'), ctx);
    var notes = regNotes(get(raw, 'notes'), ctx);

    var substantive = uniqueNo || viewedAt || area !== null || owners.length || Object.keys(live).length ||
      Object.keys(history).length || Object.keys(answers).length;
    if (!substantive) {
      addNote(ctx.notes, '등기부: 읽을 수 있는 내용이 없어 뺐어요');
      return { snapshot: null, notes: ctx.notes, warnings: [] };
    }

    // 살아 있는 기록이 있는 칸 → 그 항목 "있음"(멈춤 신호를 놓치지 않게 Claude 의 "no"보다 앞선다)
    REG_CATS.forEach(function (cat) {
      var id = has(REG_CAT_ITEM, cat) ? REG_CAT_ITEM[cat] : '';
      var n = id && has(live, cat) ? live[cat].length : 0;
      if (!n) return;
      if (answers[id] === 'no') {
        ctx.warnings.push({ code: 'conflict', text: REG_CAT_LABEL[cat] + ': 살아 있는 기록이 ' + n + '개 있는데 답이 "없음"이라 "있음"으로 바꿨어요' });
      }
      answers[id] = 'yes';
    });
    var past = 0;
    REG_HISTORY_CATS.forEach(function (cat) { if (has(history, cat)) past += history[cat].length; });
    if (past) {
      if (answers['reg-history'] === 'no') {
        ctx.warnings.push({ code: 'conflict', text: '지난 기록: 말소된 압류·가압류·가처분·경매·가등기·임차권 기록이 ' + past + '개 있는데 답이 "없음"이라 "있음"으로 바꿨어요' });
      }
      answers['reg-history'] = 'yes';
    } else if (includesCancelled === false && answers['reg-history'] === 'no') {
      delete answers['reg-history'];
      addNote(ctx.notes, '지난 기록: 말소사항 포함 등기부가 아니라 "없음" 답은 뺐어요');
    }
    if (includesCancelled === false) addNote(ctx.notes, '현재 유효사항만 나온 등기부라 말소된 지난 기록은 알 수 없어요');
    // 확인(check) 항목: 코드에 그 값이 있으면 확인한 것으로 본다
    answers['reg-view'] = 'done';
    if (viewedAt) answers['reg-date'] = 'done';
    if (owners.length) answers['reg-joint'] = 'done';
    if (owners.length && owners.every(function (o) { return !!o.since; })) answers['reg-period'] = 'done';
    var ordered = {};
    REG_ANSWERS.forEach(function (a) { if (has(answers, a[0])) ordered[a[0]] = answers[a[0]]; });
    if (ctx.rrn) addNote(ctx.notes, '주민등록번호처럼 보이는 글은 가렸어요');

    return {
      snapshot: {
        id: typeof opts.id === 'string' && opts.id ? cut(opts.id, 60) : regId(),
        source: 'code',
        viewedAt: viewedAt,
        docType: docType,
        includesCancelled: includesCancelled,
        uniqueNo: uniqueNo,
        area: area,
        owners: owners,
        live: live,
        history: history,
        mortgages: has(live, 'mortgage') ? copyJson(live.mortgage) : [],
        answers: ordered,
        match: match,
        notes: notes
      },
      notes: ctx.notes,
      warnings: ctx.warnings
    };
  }

  /** 등기부 기록(snapshot) → 코드의 registry 객체(빈 값은 뺌). tools/make-import-code.js 가 쓴다 */
  function registryToCode(s) {
    if (!isObj(s)) return null;
    var o = {};
    var mt = {};
    var sm = isObj(s.match) ? s.match : {};
    ['name', 'dong', 'ho'].forEach(function (k) { if (typeof sm[k] === 'string' && sm[k]) mt[k] = sm[k]; });
    if (s.uniqueNo) mt.uniqueNo = s.uniqueNo;
    if (Object.keys(mt).length) o.match = mt;
    if (s.viewedAt) o.viewedAt = s.viewedAt;
    if (s.docType) o.docType = s.docType;
    if (typeof s.includesCancelled === 'boolean') o.includesCancelled = s.includesCancelled;
    if (typeof s.area === 'number') o.area = s.area;
    if (Array.isArray(s.owners) && s.owners.length) o.owners = copyJson(s.owners);
    if (isObj(s.live) && Object.keys(s.live).length) o.live = copyJson(s.live);
    if (isObj(s.history) && Object.keys(s.history).length) o.history = copyJson(s.history);
    if (isObj(s.answers) && Object.keys(s.answers).length) o.answers = copyJson(s.answers);
    if (Array.isArray(s.notes) && s.notes.length) o.notes = s.notes.slice();
    return o;
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
   * 붙여 넣은 글 해석(가져오기 코드만. 딥링크 검사도 이것을 쓴다). 앱 입력 칸은 parseText(코드 → 네이버 글 순서).
   * opts: { existing: 저장된 매물 배열, goneKeys: { 열쇠: 시각 } }
   * 결과: { ok, error, message, entries: [ { index, prop, notes, warnings: [{code,text}], canImport, checked, fromList } ],
   *         total(코드 속 매물 수), truncated(30개를 넘어 뺀 수), skipped(읽을 수 없는 항목 수),
   *         blocks(읽은 코드 블록 수), incomplete(글이 길어 끝까지 못 읽음), source('code'),
   *         registry(1.6.0: 등기부 기록 snapshot 또는 null), registryNotes(참고 문구), registryWarnings([{code,text}]) }
   * warning code: noname(담을 수 없음) / notsale(매매 아님) / swap(전용≥공급) / lowprice(가격이 이상하게 낮음) /
   *               exists(이미 있음) / gone(전에 지움) / repeat(코드 안에서 겹침)
   * 1.6.0: 등기부 코드만 있으면 ok 이고 entries 는 빈 배열(registry 만 있음). 등기부 블록이 있는데 읽을 값이 없고 매물도 없으면 'reg-empty'
   */
  function parse(input, opts) {
    opts = opts || {};
    var res = { ok: false, error: '', message: '', entries: [], total: 0, truncated: 0, skipped: 0, blocks: 0, incomplete: false, source: 'code',
      registry: null, registryNotes: [], registryWarnings: [] };
    var src = typeof input === 'string' ? input : '';
    if (!src.trim()) { res.error = 'empty'; return res; }
    if (src.length > LIMITS.inputChars) { res.error = 'too-big'; res.message = MESSAGES['too-big']; return res; }
    var found = extract(src);
    if (!found.list) { res.error = found.error; res.message = MESSAGES[found.error] || MESSAGES.notfound; return res; }

    res.blocks = found.blocks || 1;
    res.incomplete = !!found.incomplete;
    // 1.4.1: 네이버 글로 만든 코드(tools/make-import-code.js 가 "from":"naver-text" 를 넣음)는 앱이 직접 읽은 글과 같게
    // 주의를 보여 주고 출처를 'naver-text' 로 남긴다(값은 코드 그대로)
    if (found.naver) { res.source = 'naver'; res.kind = 'code'; }
    readRegistry(res, found.registry || []);
    fillEntries(res, found.list, opts, null);
    if (!res.entries.length) {
      if (res.registry) { res.ok = true; return res; } // 1.6.0: 등기부만 있는 코드
      res.error = found.registry && found.registry.length ? 'reg-empty' : 'none';
      res.message = MESSAGES[res.error];
      return res;
    }
    res.ok = true;
    return res;
  }

  /** 1.6.0: 등기부 블록들 → res.registry(처음으로 읽힌 것), registryNotes, registryWarnings */
  function readRegistry(res, raws) {
    var extra = 0;
    var emptyNotes = null;
    raws.forEach(function (raw) {
      if (res.registry) { extra++; return; }
      var r = parseRegistryBlock(raw);
      if (r.snapshot) {
        res.registry = r.snapshot;
        res.registryNotes = r.notes;
        res.registryWarnings = r.warnings;
      } else if (!emptyNotes) emptyNotes = r.notes;
    });
    if (!res.registry && emptyNotes) res.registryNotes = emptyNotes;
    if (extra) res.registryNotes.push('등기부 코드가 ' + (extra + 1) + '개 있어 첫 번째만 읽었어요');
  }

  // ---- 느슨한 중복(1.4.1, 네이버 글) ----
  // 목록 카드에는 면적·매물번호·링크가 없어 단지명 조합(n)이 상세에서 담은 매물과 맞지 않는다. 그래서 한쪽에 면적이 없으면
  // 단지명·동·호가·거래 종류(+ 층이 양쪽에 있으면 층)로 한 번 더 본다. 맞으면 "~일 수 있어요" 경고로 기본 해제만 한다
  /** 거래 종류: 필드가 없으면 메모 첫 줄 "거래 종류: 전세"(앱이 매매가 아닌 매물을 담을 때 넣음), 그것도 없으면 매매 */
  function tradeOfProp(p) {
    var t = tradeTypeOf(get(p, 'tradeType'));
    if (t) return t;
    var m = /^거래 종류:\s*(\S+)/.exec(typeof p.memo === 'string' ? p.memo : '');
    return m ? tradeTypeOf(m[1]) : '매매';
  }
  function looseInfo(p) {
    var d = dupInfo(p);
    return {
      nm: oneLine(p.name, 200).toLowerCase().replace(/\s+/g, ''),
      dong: dongOf(p.dong),
      ask: typeof p.askPrice === 'number' && isFinite(p.askPrice) ? String(Math.round(p.askPrice)) : '',
      area: typeof p.area === 'number' && isFinite(p.area) ? String(Math.round(p.area * 100) / 100) : '',
      f: d.f, a: d.a, u: d.u, trade: tradeOfProp(p)
    };
  }
  function looseSame(x, y) {
    if (!x.nm || x.nm === '이름없는매물' || x.nm !== y.nm || x.dong !== y.dong || !x.ask || x.ask !== y.ask) return false;
    if ((x.area && y.area) || (x.a && y.a) || (x.u && y.u)) return false; // 양쪽에 있으면 엄격한 규칙(sameListing)이 이미 정했다
    if (x.trade && y.trade && x.trade !== y.trade) return false;
    return !(x.f && y.f && x.f !== y.f);
  }
  /** 저장된 매물(looseList: looseInfo 목록)과 지운 매물(gone: goneInfos 결과)에서 느슨하게 같은 것 → { kind, prop } 또는 null */
  function looseDuplicate(p, existing, looseList, gone) {
    var x = looseInfo(p);
    if (!x.nm || !x.ask) return null;
    for (var i = 0; i < looseList.length; i++) {
      if (looseList[i] && looseSame(x, looseList[i])) return { kind: 'exists', prop: existing[i] };
    }
    for (var j = 0; j < gone.length; j++) {
      if (!gone[j].n) continue;
      var parts = gone[j].n.split('|'); // 단지명|동|전용면적|호가 (dupInfo)
      var y = { nm: parts[0] || '', dong: parts[1] || '', area: parts[2] || '', ask: parts[3] || '', f: gone[j].f, a: gone[j].a, u: gone[j].u, trade: '' };
      if (looseSame(x, y)) return { kind: 'gone' };
    }
    return null;
  }

  /**
   * 매물 후보 목록 → res.entries(값 정리·경고·중복 판단·기본 체크). parse 와 parseNaverText 가 함께 쓴다.
   * extras[i](네이버 글): { notes: 앞에 붙일 참고 문구, fromList: 목록 카드에서 읽음, unchecked: 경고가 없어도 기본 해제,
   *                       loose: 느슨한 중복도 봄(1.4.1), approx: { area, supplyArea } 평에서 바꾼 근삿값(1.4.1) }
   */
  function fillEntries(res, list, opts, extras) {
    res.total = list.length;
    res.truncated = Math.max(0, list.length - LIMITS.properties);
    var idx = indexProps(opts.existing);
    var gone = goneInfos(opts.goneKeys);
    var existing = Array.isArray(opts.existing) ? opts.existing : [];
    var looseList = null; // 느슨한 중복용(처음 쓸 때 만든다)
    var seen = []; // 앞쪽 매물: { info, json }

    list.slice(0, LIMITS.properties).forEach(function (raw, i) {
      if (!isObj(raw)) { res.skipped++; return; }
      var x = extras && extras[i] ? extras[i] : null;
      var c = cleanProperty(raw);
      var p = c.prop;
      if (x && x.notes && x.notes.length) {
        var notes = x.notes.slice();
        c.notes.forEach(function (n) { addNote(notes, n); });
        c.notes = notes;
      }
      var warnings = [];
      if (!p.name) warnings.push({ code: 'noname', text: '단지명이 없어 담을 수 없어요' });
      if (p.tradeType && p.tradeType !== '매매') warnings.push({ code: 'notsale', text: '매매 매물이 아니에요 (' + p.tradeType + ')' });
      Array.prototype.push.apply(warnings, c.warnings);
      if (p.name) {
        var dup = findDuplicate(p, idx, gone);
        var loose = false;
        if (!dup && x && x.loose) {
          if (!looseList) looseList = existing.map(function (e) { return isObj(e) ? looseInfo(e) : null; });
          dup = looseDuplicate(p, existing, looseList, gone);
          loose = !!dup;
        }
        if (dup && dup.kind === 'exists') {
          warnings.push({ code: 'exists', text: (loose ? '이미 있는 매물일 수 있어요(단지·동·호가가 같아요)' : '이미 있는 매물이에요') + (dup.prop && dup.prop.status === 'dropped' ? ' (탈락)' : '') });
        } else if (dup) {
          warnings.push({ code: 'gone', text: loose ? '전에 지운 매물일 수 있어요(단지·동·호가가 같아요)' : '전에 지운 매물이에요' });
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
        fromList: !!(x && x.fromList),
        approx: x && x.approx ? x.approx : null, // 1.4.1: 평에서 바꾼 면적(미리보기에 "약")
        // 경고가 하나라도 있으면 기본으로 빼 둔다. 네이버 상세+목록 글의 목록 매물도 빼 둔다(사용자가 고름)
        checked: canImport && !warnings.length && !(x && x.unchecked)
      });
    });
  }

  // ---------------- 네이버 부동산 매물 화면 글 (1.4.0) ----------------
  // 사용자가 네이버페이 부동산 매물 상세 화면의 글을 전체 선택·복사하거나, iPad 단축어로 페이지 글을 복사해 붙여 넣는다.
  // 그 글에는 왼쪽 '최근조회/관심' 목록, 사용자 프로필 이름·알림 수 같은 줄도 섞인다. 그래서
  //  - 상세 매물: '기본 정보'(없으면 '매물번호') 줄을 기준으로, 그 앞에서 거꾸로 찾은 첫 '거래 종류 + 가격' 줄의 바로 앞 줄을
  //    제목으로 본다(왼쪽 목록의 같은 모양 줄에 속지 않게). 값은 이름표(공급면적·전용면적·해당층/총층 …) 바로 다음 값만 읽는다.
  //  - 목록 매물: '매물' 줄로 시작하는 카드 모양(이름 / 거래 / 가격 / 유형 / 평 / 층 / 향 / 확인매물 / 중개사)만 읽는다.
  //  - 모양이 맞지 않는 값은 비운다(추측하지 않음). 이름표 밖의 줄은 어떤 필드·메모에도 넣지 않는다.
  var PYEONG_M2 = 400 / 121; // 1평 = 400/121 ㎡ (약 3.3058)
  var TRADE_WORD_RE = /^(매매|전세|월세|단기임대)$/;
  var TRADE_PRICE_RE = /^(매매|전세|월세|단기임대)\s*(\d.*)$/;
  var ANCHOR_RE = /^(기본 ?정보|매물 ?정보)$/;
  // 상세 화면의 다른 묶음 제목. 이름표를 찾을 범위를 여기서 끊는다(같은 이름표 '위치'·'관리비'가 여러 묶음에 있음)
  var BASIC_END_RE = /^(매물 ?소개|대출 ?정보|매물 ?분포|실거래가|단지 ?정보|중개사|중개 ?보수|주변 ?대중교통|학군 ?정보|시세)$/;
  var DEAL_END_RE = /^(단지 ?정보|중개사|중개 ?보수|관리비|주변 ?대중교통|학군 ?정보|매물 ?소개|대출 ?정보|매물 ?분포)$/;
  var COMPLEX_END_RE = /^(중개사|중개 ?보수|관리비|주변 ?대중교통|학군 ?정보|실거래가|매물 ?소개|대출 ?정보|매물 ?분포|시세)$/;
  var AGENT_END_RE = /^(중개 ?보수|관리비|주변 ?대중교통|학군 ?정보|단지 ?정보|실거래가|매물 ?소개|대출 ?정보|매물 ?분포|시세)$/;
  // 제목·이름으로 보면 안 되는 화면 글(버튼·탭 이름)
  var UI_LINE_RE = /^(창닫기|닫기|공유하기|공유|매물|단지|아파트|오피스텔|최근조회|관심부동산|관심매물|공지사항|알림설정|편집|다음|이전|더보기|상세보기|지도|목록)$/;
  // 1.4.1: 상세 제목 묶음에서 '거래 종류 + 가격' 줄 아래에 오는 표시 줄(평당가·알림/관심·공유). 제목 가격 줄은 이 줄들보다 위에만 찾는다
  // (그 아래 중개사가 쓴 특징 글 "매매 1억 6,000 급매 …"를 제목 가격 줄로 잘못 보지 않게)
  var TITLE_MARK_RE = /평당가|^(알림)?관심(매물)?$|^공유(하기)?$/;
  // 1.4.1: 제목 가격 줄의 가격 뒤에 붙어도 되는 글(가격 변동 표시). 그 밖의 글이 붙으면 특징 글로 보고 제목 가격 줄로 쓰지 않는다
  var PRICE_TAIL_OK_RE = /^(?:변동|상승|하락|내역|보기|\s)*$/;
  // 목록 카드의 유형 줄. 아파트 매수와 상관없는 상가·사무실·토지 등은 뺀다(분양·단지 카드는 '매물' 줄로 시작하지 않아 애초에 읽지 않음)
  var LIST_TYPE_RE = /^(아파트|오피스텔|빌라|연립|다세대|단독|다가구|주상복합|재건축|재개발|분양권|아파트분양권|오피스텔분양권|전원주택|한옥주택|도시형생활주택|상가|상가점포|상가주택|사무실|토지|공장|창고|지식산업센터|건물|빌딩|숙박)/;
  var LIST_SKIP_TYPE_RE = /상가|사무|점포|토지|공장|창고|지식산업|건물|빌딩|숙박/;
  // 목록 카드의 매물 정보 제공처(중개사가 아님)
  var PROVIDER_RE = /제공$|^(매경부동산|부동산뱅크|부동산써브|한경부동산|한국경제|조인스랜드|부동산114|부동산포스|스피드공실|교차로|산업일보|선방|더피플|부동산플래닛)$/;
  // 네이버 매물 글로 보이는 표시(둘 이상 있으면 '네이버 글인데 매물을 못 찾음'으로 안내)
  var NAVER_MARKS = [/^매물번호/, ANCHOR_RE, /^(매매가|전세가|보증금)/, /^전용면적/, /^해당층\/총층/, /확인매물/, /^매물 보러가기$/, /^(최근조회|관심부동산)$/, /^중개 ?보수$/, /^실거래가$/];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 화면 글 → 줄 목록. 줄바꿈(\r\n)·특수 공백을 맞추고 앞뒤 공백을 지운다(표의 탭은 남김) */
  function naverLines(text) {
    return text.replace(/\r\n?/g, '\n')
      .replace(/[   　]/g, ' ')
      .replace(/[​-‍⁠﻿]/g, '')
      .split('\n')
      .map(function (l) { return l.replace(/ {2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, ''); });
  }
  /** 비교용 한 줄(탭·연속 공백 → 공백 하나) */
  function flat(l) { return String(l || '').replace(/\s+/g, ' ').trim(); }
  function findLine(L, from, re) {
    for (var i = Math.max(0, from); i < L.length; i++) if (re.test(flat(L[i]))) return i;
    return -1;
  }
  /** from 부터 re 에 맞는 묶음 제목 앞까지(최대 max 줄) */
  function blockEnd(L, from, re, max) {
    for (var i = from; i < L.length && i < from + max; i++) if (re.test(flat(L[i]))) return i;
    return Math.min(L.length, from + max);
  }
  function nextFilled(L, from, to) {
    for (var i = Math.max(0, from); i < to && i < L.length; i++) if (flat(L[i])) return i;
    return -1;
  }
  function prevFilled(L, from, min) {
    for (var i = from; i >= min && i >= 0; i--) if (flat(L[i])) return i;
    return -1;
  }

  /**
   * [from, to) 안에서 이름표의 값. "이름표 ↵ 값" 또는 "이름표 값"(탭·공백·쌍점) 모양.
   * 값은 이름표 다음의 빈 줄이 아닌 첫 줄(3줄 아래까지)만. 결과 { label, value, at } 또는 null
   */
  function labelAt(L, from, to, labels) {
    for (var i = Math.max(0, from); i < to && i < L.length; i++) {
      var f = flat(L[i]);
      if (!f) continue;
      for (var k = 0; k < labels.length; k++) {
        var lb = labels[k];
        if (f === lb) {
          var j = nextFilled(L, i + 1, Math.min(to, i + 4));
          return { label: lb, value: j < 0 ? '' : flat(L[j]), at: i };
        }
        if (f.indexOf(lb) === 0 && /^[\s:：]/.test(f.charAt(lb.length))) {
          return { label: lb, value: f.slice(lb.length).replace(/^[\s:：]+/, ''), at: i };
        }
      }
    }
    return null;
  }
  function labelValue(L, from, to, labels) {
    var r = labelAt(L, from, to, labels);
    return r ? r.value : '';
  }

  /** 가격 글의 "만원"·"원"을 지운다: "1억 6,000만원" → "1억 6,000", "2,000만원/85만원" → "2,000/85" */
  function bareMoney(s) { return String(s).replace(/(\d)\s*만\s*원?/g, '$1').replace(/(\d)\s*원/g, '$1'); }
  var PRICE_PART = '\\d[\\d,]*(?:\\.\\d+)?\\s*억(?:\\s*\\d[\\d,]*)?|\\d[\\d,]*';
  var PRICE_HEAD_RE = new RegExp('^(' + PRICE_PART + ')(?:\\s*\\/\\s*(' + PRICE_PART + '))?');
  /**
   * 가격으로 시작하는 글 → { deposit, monthly, rest }. "1억 9,000변동상승내역 보기" → deposit '1억 9,000', rest '변동상승내역 보기'.
   * "2,000/85"(월세) → deposit '2,000', monthly '85'. "1억 5,000 ~ 4억"(단지 카드의 가격 범위)는 rest 가 '~'로 시작. 숫자로 시작하지 않으면 null
   */
  function priceHead(s) {
    var t = bareMoney(flat(s));
    var m = PRICE_HEAD_RE.exec(t);
    if (!m) return null;
    return { deposit: m[1].trim(), monthly: m[2] ? m[2].trim() : '', rest: t.slice(m[0].length).trim() };
  }
  /** 가격 글 → 만원 정수(또는 null) */
  function moneyOf(s) {
    var n = s ? parseMoneyText(s) : null;
    return n !== null && isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  function priceText(ph) {
    var dep = moneyOf(ph.deposit);
    var mon = moneyOf(ph.monthly);
    return dep ? manwonText(dep) + (mon ? ' / 월 ' + manwonText(mon) : '') : '';
  }

  var AREA_RE = /(\d+(?:\.\d+)?)\s*(평|㎡|m²|m2|제곱미터)/g;
  /** "15.55평면적 단위 변경㎡" → [{ m2: 51.4, py: '15.55' }], "51.4㎡" → [{ m2: 51.4, py: '' }]. 단위가 붙은 숫자만 */
  function areaValues(s) {
    var out = [];
    var t = String(s || '').replace(/,/g, '');
    var m;
    AREA_RE.lastIndex = 0;
    while ((m = AREA_RE.exec(t))) {
      var n = parseFloat(m[1]);
      out.push(m[2] === '평' ? { m2: Math.round(n * PYEONG_M2 * 100) / 100, py: m[1] } : { m2: Math.round(n * 100) / 100, py: '' });
    }
    return out;
  }

  /** "2026. 10. 02." / "2026.10.02" / "26.10.02." → "2026-10-02". 아니면 '' */
  function naverDate(s) {
    var m = /(\d{4}|\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?!\d)/.exec(String(s || ''));
    if (!m) return '';
    var mo = +m[2];
    var d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return (m[1].length === 2 ? '20' + m[1] : m[1]) + '-' + pad2(mo) + '-' + pad2(d);
  }

  /**
   * 제목·카드 이름 "용종마을신대진 204동" → { name: '용종마을신대진', dong: '204' }. 동이 없으면 dong ''.
   * 1.4.1: 이름 부분이 숫자가 아닌 글자로 끝나고 글자(한글·영문)가 있어야 한다("204동" → 이름 '2', 동 '04'가 되지 않게)
   */
  function nameDong(s) {
    var t = flat(s);
    var m = /^(.*?\D)\s*(?:제\s*)?(\d{1,4})동$/.exec(t) || /^(.+?)\s+([A-Za-z]\d{0,3}|[가-힣])동$/.exec(t);
    if (m && !/[가-힣A-Za-z]/.test(m[1])) m = null;
    return m ? { name: m[1].trim(), dong: m[2] } : { name: t, dong: '' };
  }
  /**
   * 제목·이름으로 쓸 수 있는 줄인지(버튼 이름·거래 종류·숫자뿐인 줄·알림·프로필 줄이 아님).
   * 1.4.1: 화면 글('면적 단위 변경㎡', '단지 보러가기', 평당가·도움말·확인매물), 요약 줄(층 + 평/㎡), 동만 있는 줄('204동')도 아님
   */
  function titleOk(s) {
    var t = flat(s);
    return t.length >= 2 && t.length <= 80 && /[가-힣A-Za-z]/.test(t) && !UI_LINE_RE.test(t) && !TRADE_WORD_RE.test(t) &&
      !TRADE_PRICE_RE.test(t) && !/님$|알림|로그인|로그아웃|마이페이지|관심매물$/.test(t) && !/^[\d\s.,\/~억만원%㎡평()-]+$/.test(t) &&
      !/면적 ?단위|보러가기|평당가|도움말|확인매물/.test(t) && !(/층/.test(t) && /평|㎡/.test(t)) && !/^제?\s*\d+\s*(동|호)$/.test(t);
  }
  /**
   * 상세 제목 아래의 특징 글(예: "급매 조망권굿 내부수리깨끗")로 쓸 수 있는 줄인지. 화면 버튼·요약 줄·알림 줄은 아님.
   * 1.4.1: "전세 1억 끼고 매매"처럼 거래 종류·가격으로 시작해도 뒤에 글이 있으면 특징 글(찾는 범위가 제목 가격 줄 아래라 겹치지 않음)
   */
  function tagOk(s) {
    var t = flat(s);
    var tp = TRADE_PRICE_RE.exec(t);
    var tph = tp ? priceHead(tp[2]) : null;
    return t.length >= 2 && t.length <= 100 && /[가-힣]/.test(t) && !UI_LINE_RE.test(t) &&
      !/평당가|도움말|알림|관심|공유|면적 ?단위|확인매물|신고|최초게재|제공|님$|로그인|로그아웃|마이페이지|보러가기|더보기/.test(t) &&
      !(/층/.test(t) && /평|㎡/.test(t)) && !(tp && (!tph || PRICE_TAIL_OK_RE.test(tph.rest))) && !/^[\d\s.,\/~억만원%㎡평()-]+$/.test(t);
  }
  /** 제목 가격 줄로 쓸 수 있는 가격인지: 범위('~')가 아니고 가격 뒤에 다른 글(특징 글)이 붙지 않음 */
  function plainPrice(ph) { return !!ph && !/^~/.test(ph.rest) && PRICE_TAIL_OK_RE.test(ph.rest); }

  var DEAL_DATE = '\\d{1,2}월\\s*\\d{1,2}일|\\d{2,4}\\s*[.\\-/]\\s*\\d{1,2}\\s*[.\\-/]\\s*\\d{1,2}\\.?';
  var DEAL_DATE_RE = new RegExp('^(?:' + DEAL_DATE + ')');
  // 1.4.1: 실거래 표의 가격 칸은 '억'이 있거나 천 단위 쉼표가 있는 모양만(층 숫자 "2"를 2만원으로 읽지 않게)
  var DEAL_PRICE = '\\d{1,4}(?:\\.\\d+)?\\s*억(?:\\s*\\d{1,3}(?:,\\d{3})*)?|\\d{1,3}(?:,\\d{3})+';
  var DEAL_PRICE_RE = new RegExp('억|\\d,\\d{3}');
  var DEAL_ROW_MAX = 200; // 표 한 줄 글자 수 상한(이보다 길면 표 줄이 아님. 정규식이 긴 글에서 오래 걸리지 않게)
  // 실거래 표 한 줄: 계약일 [등기일|미등록] [층("2층", "2", "B1", "지하1층", "저")] [최고|최저]가격 [군말]
  // 1.4.1: 층 칸은 길이를 정한 모양만(예전 '\S*\d+층'은 긴 숫자 덩어리에서 아주 오래 걸렸다)
  // 1.4.2: 가격 앞 표시 '직거래'·'중개거래'(중개 없이/중개로 거래)·'해제'(취소된 거래)도 읽는다. 예: "직거래1억 6,000"
  var DEAL_ROW_RE = new RegExp('^(' + DEAL_DATE + ')\\s+(?:(미등록|-|' + DEAL_DATE + ')\\s+)?(?:([A-Za-z가-힣]{0,4}\\d{1,3}층?|[저중고]층?)\\s+)?' +
    '(?:(?:최고|최저)\\s*)?((?:(?:직거래|중개거래|해제|취소)\\s*)?)(?:(?:최고|최저)\\s*)?(' + DEAL_PRICE + ')(?:\\s*만\\s*원?)?(?:\\s+\\D.*)?$');
  /**
   * '실거래가' 묶음 [from, to) → 표의 첫 줄 { price(만원), memo, same(같은 면적 표) } 또는 null.
   * 표 머리("계약일 등기일 층 가격")가 탭으로 한 줄이든 칸마다 한 줄이든 읽는다. 표의 거래 종류가 매물과 다르면 읽지 않는다.
   * 1.4.1: 가격 칸은 '억'이나 천 단위 쉼표가 있는 모양만. 칸마다 한 줄이면 가격 칸이 나올 때까지(6칸) 이어 붙이고, 없으면 null
   */
  function naverDeal(L, from, to, trade) {
    var year = '';
    var same = false;
    var head = -1;
    for (var i = from; i < to; i++) {
      var f = flat(L[i]);
      if (/^동일\s*면적/.test(f)) same = true;
      var y = /^(\d{4})년\s*계약/.exec(f);
      if (y && !year) year = y[1];
      if (/실거래가?\s*표$/.test(f)) {
        var t = /(매매|전세|월세)/.exec(f);
        if (t && trade && t[1] !== trade && !(trade === '단기임대' && t[1] === '월세')) return null;
      }
      if (/^계약일(\s|$)/.test(f)) { head = i; break; }
    }
    if (head < 0) return null;
    var k = head + 1;
    while (k < to && /^(등기일|층|가격|거래금액|계약일|)$/.test(flat(L[k]))) k++; // 칸마다 한 줄인 머리, 빈 줄
    if (k >= to) return null;
    var row = flat(L[k]);
    if (!DEAL_DATE_RE.test(row) || row.length > DEAL_ROW_MAX) return null;
    // 칸마다 한 줄이면 가격 칸이 나올 때까지(최대 6칸: 계약일·등기일·층·최고/최저·가격 + 여유) 이어 붙인다
    if (!DEAL_PRICE_RE.test(row.replace(DEAL_DATE_RE, ''))) {
      var parts = [row];
      for (var j = k + 1; j < to && parts.length < 6; j++) {
        var c = flat(L[j]);
        if (!c) continue;
        parts.push(c);
        if (DEAL_PRICE_RE.test(c)) break;
      }
      row = parts.join(' ');
      if (row.length > DEAL_ROW_MAX) return null;
    }
    var m = DEAL_ROW_RE.exec(row);
    if (!m) return null;
    var label = (m[4] || '').replace(/\s+/g, '');
    if (/해제|취소/.test(label)) return null; // 취소된 거래는 실거래가로 쓰지 않는다
    var ph = priceHead(m[5]);
    var price = ph ? moneyOf(ph.deposit) : null;
    if (!price) return null;
    var date = m[1].replace(/\s+/g, ' ');
    if (year && /월/.test(date)) date = year + '년 ' + date;
    var reg = m[2] || '';
    var fl = m[3] || '';
    if (/\d$/.test(fl)) fl += '층'; // 층 칸에 "층"이 없던 표("2")
    var bits = [date, fl, priceText(ph), label, reg === '미등록' ? '미등록' : (reg && reg !== '-' ? '등기 ' + reg : '')];
    // 같은 면적 표가 아니면(다른 평형·전체 면적 표를 보고 있을 때) 실거래가 칸에는 넣지 않고 메모에만 남긴다(naverDetail)
    return { price: price, same: same, memo: '최근 실거래' + (same ? '(같은 면적)' : '(면적 확인 필요)') + ': ' + bits.filter(Boolean).join(' · ') };
  }

  /**
   * 상세 매물 → { raw(cleanProperty 에 넘길 후보), notes, approx } 또는 null.
   * 기준 줄·제목·가격을 찾지 못하거나, 제목 줄 가격과 '기본 정보'의 가격이 다르면(다른 줄을 제목으로 잘못 봄) null.
   * 1.4.1: 요약 줄("아파트15평 (전용11)16/16층동향")의 층·향이 '해당층/총층'·'향'과 다르거나, 머리 줄(창닫기 위의 이름)이
   * 제목과 다르면 null(다른 매물의 줄을 제목으로 잘못 봄)
   */
  function naverDetail(L) {
    var anchor = findLine(L, 0, ANCHOR_RE);
    if (anchor < 0) anchor = findLine(L, 0, /^매물번호(\s|$)/);
    if (anchor < 0) return null;

    // 제목: 기준 줄 앞에서 거꾸로 찾은 첫 '거래 종류 + 가격' 줄(또는 '거래 종류' ↵ '가격' 두 줄)의 바로 앞 줄.
    // 1.4.1: 제목 묶음의 표시 줄(평당가·관심·공유)이 가까이(25줄 안) 있으면 그 위에서만 찾는다. 가격 뒤에 다른 글이 붙은 줄
    // ("매매 1억 6,000 급매 …", "전세 1억 끼고 매매")은 중개사가 쓴 특징 글이라 제목 가격 줄로 보지 않는다
    var from = anchor - 1;
    for (var i = anchor - 1; i >= 0 && i >= anchor - 25; i--) {
      if (TITLE_MARK_RE.test(flat(L[i]))) { from = i - 1; break; }
    }
    var tradeAt = -1;
    var priceEnd = -1;
    var trade = '';
    var price = null;
    for (i = from; i >= 0 && i >= anchor - 60; i--) {
      var f = flat(L[i]);
      var m = TRADE_PRICE_RE.exec(f);
      var ph = m ? priceHead(m[2]) : null;
      if (plainPrice(ph)) { tradeAt = i; priceEnd = i + 1; trade = m[1]; price = ph; break; }
      if (TRADE_WORD_RE.test(f)) {
        var nx = nextFilled(L, i + 1, anchor);
        ph = nx >= 0 ? priceHead(L[nx]) : null;
        if (plainPrice(ph)) { tradeAt = i; priceEnd = nx + 1; trade = f; price = ph; break; }
      }
    }
    if (tradeAt < 0) return null;
    var ti = prevFilled(L, tradeAt - 1, tradeAt - 3);
    if (ti < 0) return null;
    var nd;
    var dongOnly = /^제?\s*(\d{1,4})\s*동$/.exec(flat(L[ti]));
    if (dongOnly) {
      // 1.4.1: 단지명과 동이 두 줄로 나뉜 화면("용종마을신대진 ↵ 204동")
      var ni = prevFilled(L, ti - 1, ti - 2);
      if (ni < 0 || !titleOk(L[ni])) return null;
      nd = { name: flat(L[ni]), dong: dongOnly[1] };
      ti = ni;
    } else {
      if (!titleOk(L[ti])) return null;
      nd = nameDong(L[ti]);
    }
    // 머리 줄: 제목 위에 "이름 ↵ 창닫기"가 있으면(PC 화면) 그 이름(단지명·동)이 제목과 같아야 한다
    var closeAt = prevFilled(L, ti - 1, ti - 3);
    if (closeAt >= 0 && /^(창닫기|닫기)$/.test(flat(L[closeAt]))) {
      var hi = prevFilled(L, closeAt - 1, closeAt - 3);
      var hd = hi >= 0 && titleOk(L[hi]) ? nameDong(L[hi]) : null;
      if (hd && (hd.name.replace(/\s+/g, '') !== nd.name.replace(/\s+/g, '') || hd.dong !== nd.dong)) return null;
    }

    // '기본 정보' 묶음의 이름표 값
    var bEnd = blockEnd(L, anchor + 1, BASIC_END_RE, 150);
    function basic(labels) { return labelValue(L, anchor, bEnd, labels); }
    var pl = labelAt(L, anchor, bEnd, ['매매가', '전세가', '보증금/월세', '월세가', '보증금', '월세']);
    if (pl && pl.value) {
      var lp = priceHead(pl.value);
      if (lp && moneyOf(lp.deposit) !== moneyOf(price.deposit)) return null;
      var lt = /^매매/.test(pl.label) ? '매매' : (/^전세/.test(pl.label) ? '전세' : '월세');
      if (trade !== lt && !(trade === '단기임대' && lt === '월세')) return null;
      if (!price.monthly && lp && lp.monthly) price.monthly = lp.monthly;
    }
    var notes = [];
    var memo = [];
    if ((trade === '월세' || trade === '단기임대') && price.monthly) memo.push(trade + ': 보증금 ' + priceText(price));

    // 면적: 평으로 보이면 ㎡로 바꾼다(1평 = 400/121㎡, 소수 둘째 자리)
    var supply = areaValues(basic(['공급면적', '계약면적']))[0] || null;
    var excl = areaValues(basic(['전용면적']))[0] || null;
    if (!supply && !excl) {
      var both = areaValues(basic(['공급/전용면적', '계약/전용면적']));
      if (both.length === 2) { supply = both[0]; excl = both[1]; }
    }
    var pys = [supply && supply.py ? '공급 ' + supply.py + '평' : '', excl && excl.py ? '전용 ' + excl.py + '평' : ''].filter(Boolean);

    var fm = /^([0-9]+|[저중고]|B\d+|지하\d*)\s*층?\s*\/\s*(\d+)\s*층?$/.exec(basic(['해당층/총층', '층/총층', '층수']));
    var dm = /(남동|남서|북동|북서|동|서|남|북)향/.exec(basic(['향', '방향']));
    var an = /\d{5,20}/.exec(basic(['매물번호']));
    // 1.4.1: 제목 아래 요약 줄(층 + 평/㎡)의 층·향이 이름표 값과 다르면 다른 매물의 제목을 잡은 것
    for (i = priceEnd; i < anchor; i++) {
      var sm = flat(L[i]);
      if (!/층/.test(sm) || !/평|㎡/.test(sm)) continue;
      var sf = /([0-9]+|[저중고]|B\d+)\s*\/\s*(\d+)\s*층/.exec(sm);
      var sd = /(남동|남서|북동|북서|동|서|남|북)향\s*$/.exec(sm);
      if (sf && fm && (sf[1] + '/' + sf[2]) !== (fm[1] + '/' + fm[2])) return null;
      if (sd && dm && sd[1] !== dm[1]) return null;
      break;
    }

    // 확인매물 날짜와 특징 글: 가격 줄과 기준 줄 사이(제목 묶음)에서만
    var confirmedAt = '';
    var confAt = -1;
    for (i = priceEnd; i < anchor; i++) {
      var ci = L[i].indexOf('확인매물');
      if (ci >= 0) { confirmedAt = naverDate(L[i].slice(ci + 4)); if (confirmedAt) { confAt = i; break; } }
    }
    if (!confirmedAt) confirmedAt = naverDate(basic(['확인매물', '집주인확인매물', '매물확인일']));
    // 특징 글: 확인매물 줄(없으면 기준 줄) 바로 위의 한 줄만. 버튼·요약 줄이면 쓰지 않는다
    var tagAt = prevFilled(L, (confAt >= 0 ? confAt : anchor) - 1, priceEnd);
    if (tagAt >= 0 && tagOk(L[tagAt])) memo.push('특징: ' + flat(L[tagAt]));

    var rooms = /(\d+)\s*\/\s*(\d+)/.exec(basic(['방수/욕실수', '방/욕실', '방 수/욕실 수']));
    var moveIn = basic(['입주가능일', '입주 가능일']);
    var fee = /(\d[\d,.]*\s*만(?:\s*\d[\d,]*)?\s*원|\d[\d,]*\s*원)/.exec(basic(['관리비', '월관리비', '월 관리비']));
    var extra = [
      rooms ? '방 ' + rooms[1] + ' / 욕실 ' + rooms[2] : '',
      moveIn && moveIn.length <= 30 && !/[:：]/.test(moveIn) && /[가-힣\d]/.test(moveIn) && !BASIC_END_RE.test(moveIn) ? '입주가능일 ' + moveIn : '',
      fee ? '관리비 ' + fee[1].replace(/\s+/g, ' ') : ''
    ].filter(Boolean);
    if (extra.length) memo.push(extra.join(' · '));
    // 1.4.3: 매물에 적힌 융자금(대출). 중개사·매도인이 적은 값이라 등기부 을구(근저당)로 꼭 확인하게 안내
    var loan = flat(basic(['융자금', '융자']));
    if (loan && loan.length <= 30 && /없음|있음|\d|미만|이상|이하|시세|대비/.test(loan) && !BASIC_END_RE.test(loan)) {
      memo.push('융자금(매물 표시): ' + loan + ' → 등기부 을구(근저당)에서 꼭 확인');
    }

    // 단지 정보
    var cxAt = findLine(L, anchor, /^단지 ?정보$/);
    if (cxAt >= 0) {
      var cxEnd = blockEnd(L, cxAt + 1, COMPLEX_END_RE, 60);
      var cx = [];
      var addr = labelValue(L, cxAt + 1, cxEnd, ['위치', '주소', '소재지']);
      if (addr && addr.length <= 60 && /(시|도|구|군|동|읍|면|리|로|길)(\s|\d|$)/.test(addr)) cx.push(addr);
      var ok = /(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})\.?\s*(\(\d+년차\))?/.exec(labelValue(L, cxAt + 1, cxEnd, ['사용승인일', '사용승인', '준공년도']));
      if (ok) cx.push('사용승인 ' + ok[1] + '.' + pad2(+ok[2]) + '.' + pad2(+ok[3]) + (ok[4] || ''));
      var hh = /^(\d[\d,]*)\s*세대(?:\s*\(\s*해당\s*면적\s*(\d[\d,]*)\s*세대\s*\))?/.exec(labelValue(L, cxAt + 1, cxEnd, ['세대수', '총세대수']));
      if (hh) cx.push(hh[1] + '세대' + (hh[2] ? '(해당 면적 ' + hh[2] + '세대)' : ''));
      var door = /^([가-힣]{2,4}식|타워형|판상형|혼합형)/.exec(labelValue(L, cxAt + 1, cxEnd, ['현관구조']));
      if (door) cx.push(door[1]);
      var heat = /^([가-힣]{2,6}난방)/.exec(labelValue(L, cxAt + 1, cxEnd, ['난방', '난방방식']));
      if (heat) cx.push(heat[1]);
      var park = labelValue(L, cxAt + 1, cxEnd, ['주차', '주차대수']);
      var pk = /세대당\s*([\d.]+)\s*대/.exec(park);
      var pn = /^(\d[\d,]*)\s*대/.exec(park);
      if (pk) cx.push('주차 세대당 ' + pk[1] + '대');
      else if (pn) cx.push('주차 ' + pn[1] + '대');
      if (cx.length) memo.push('단지: ' + cx.join(' · '));
    }

    // 실거래가: 표의 첫 줄(가장 최근 계약). 1.4.1: '동일면적' 표가 아니면 실거래가 칸은 비우고 메모에만
    var dealAt = findLine(L, anchor, /^실거래가$/);
    var deal = dealAt >= 0 ? naverDeal(L, dealAt + 1, blockEnd(L, dealAt + 1, DEAL_END_RE, 80), trade) : null;
    if (deal) memo.push(deal.memo);
    if (deal && !deal.same) notes.push('실거래가: 같은 면적 표인지 몰라 메모에만 적었어요');
    if (pys.length) {
      // 1.4.1: 네이버가 소수 둘째 자리로 반올림한 평에서 바꾼 값이라 실제 ㎡와 0.01–0.02 다를 수 있다(근삿값)
      memo.push('면적: 화면의 평 표기(' + pys.join(', ') + ')를 ㎡로 바꿨어요(1평 = 400/121㎡). 0.02㎡까지 다를 수 있어요. ' +
        '등기부·건축물대장 숫자로 고치거나, 네이버에서 면적 단위를 ㎡로 바꾸고 다시 복사하면 정확해요');
      notes.push('면적: 평을 ㎡로 바꾼 근삿값이에요(0.02㎡까지 다를 수 있음)');
    }

    // 중개사: '중개사' 묶음 안에서만. 사무소 이름(…공인중개사사무소·…부동산)과 중개사 이름(한글 2–4자), 전화 칸
    var agentName = '';
    var agentPhone = '';
    var agAt = findLine(L, anchor, /^(중개사|중개사 정보|중개업소|중개업소 정보)$/);
    if (agAt >= 0) {
      var agEnd = blockEnd(L, agAt + 1, AGENT_END_RE, 40);
      var telAt = -1;
      for (i = agAt + 1; i < agEnd; i++) { if (/^(전화|대표번호|전화번호|연락처|휴대폰)(\s|$)/.test(flat(L[i]))) { telAt = i; break; } }
      var office = '';
      var person = '';
      for (i = agAt + 1; i < (telAt >= 0 ? telAt : agEnd); i++) {
        f = flat(L[i]);
        if (!f || /이미지|프로필|매물|보수|보기|등록번호|^중개소$|^중개사$/.test(f)) continue;
        if (!office && /공인중개|중개사무소|중개법인|부동산|중개/.test(f) && f.length <= 40) { office = f; continue; }
        if (!person && /^[가-힣]{2,4}$/.test(f) && !/^(대표|소장|실장|중개사|중개소|공인중개사)$/.test(f)) person = f;
      }
      agentName = [office, person].filter(Boolean).join(' ');
      if (telAt >= 0) {
        var tel = labelValue(L, telAt, telAt + 4, ['전화', '대표번호', '전화번호', '연락처', '휴대폰']);
        if (/\d{2,4}[\s.)-]*\d{3,4}[\s.-]*\d{4}/.test(tel)) agentPhone = tel;
      }
    }

    return {
      notes: notes,
      approx: { area: !!(excl && excl.py), supplyArea: !!(supply && supply.py) },
      raw: {
        name: nd.name,
        dong: nd.dong,
        area: excl ? excl.m2 : null,
        supplyArea: supply ? supply.m2 : null,
        askPrice: moneyOf(price.deposit),
        realPrice: deal && deal.same ? deal.price : null,
        tradeType: trade,
        floor: fm ? fm[1] + '/' + fm[2] : '',
        direction: dm ? dm[0] : '',
        agentName: agentName,
        agentPhone: agentPhone, // 번호가 붙어 있어도 cleanProperty(phoneOf)가 나눠 첫 번호만 넣고 나머지는 메모로
        articleNo: an ? an[0] : '',
        confirmedAt: confirmedAt,
        memo: memo.join('\n')
      }
    };
  }

  /** "15평 (전용11)" → "15평(전용 11평)" */
  function listAreaText(s) {
    var m = /(\d+(?:\.\d+)?)\s*(평|㎡)\s*\(\s*전용\s*(\d+(?:\.\d+)?)\s*(평|㎡)?\s*\)/.exec(s);
    return m ? m[1] + m[2] + '(전용 ' + m[3] + (m[4] || m[2]) + ')' : cut(flat(s), 40);
  }

  /**
   * 목록 카드 하나(i: '매물' 줄) → { end(다음에 볼 줄), card } . 카드 모양이 아니거나 뺄 유형이면 card 없음.
   * 카드: 매물 / 이름+동 / 거래 / 가격 / 유형 / N평 (전용M) / 층 / 향 / 집주인확인매물 날짜 / 중개사 / 제공처 / 매물 보러가기
   */
  function naverCard(L, i) {
    var end = i + 1;
    while (end < L.length && end < i + 20) {
      var g = flat(L[end]);
      if (g === '매물 보러가기') { end++; break; }
      if (g === '매물') break;
      end++;
    }
    var out = { end: end, card: null };
    var k = nextFilled(L, i + 1, end);
    if (k < 0 || !titleOk(L[k])) return out;
    var t = nextFilled(L, k + 1, end);
    if (t < 0) return out;
    var f = flat(L[t]);
    var trade = '';
    var ph = null;
    var after = -1;
    var m = TRADE_PRICE_RE.exec(f);
    if (m) { trade = m[1]; ph = priceHead(m[2]); after = t + 1; }
    else if (TRADE_WORD_RE.test(f)) {
      var pk = nextFilled(L, t + 1, end);
      if (pk >= 0) { trade = f; ph = priceHead(L[pk]); after = pk + 1; }
    }
    if (!trade || !ph || /^~/.test(ph.rest)) return out; // 가격 범위(단지 카드) 등
    var nd = nameDong(L[k]);
    var c = { name: nd.name, dong: nd.dong, trade: trade, price: ph, area: '', floor: '', direction: '', confirmedAt: '', agent: '' };
    var others = [];
    for (var j = after; j < end; j++) {
      g = flat(L[j]);
      if (!g || g === '매물 보러가기' || /관심매물$/.test(g)) continue;
      if (LIST_TYPE_RE.test(g)) { if (LIST_SKIP_TYPE_RE.test(g)) return out; continue; }
      if (/^계약\s*\d/.test(g)) return out; // 상가의 계약면적
      if (!c.area && /\d\s*(평|㎡)/.test(g) && /\(\s*전용/.test(g)) { c.area = g; continue; }
      var fl = /^([0-9]+|[저중고]|B\d+)\s*\/\s*(\d+)\s*층$/.exec(g);
      if (!c.floor && fl) { c.floor = fl[1] + '/' + fl[2]; continue; }
      if (!c.direction && /^(남동|남서|북동|북서|동|서|남|북)향$/.test(g)) { c.direction = g; continue; }
      if (/확인매물/.test(g)) { if (!c.confirmedAt) c.confirmedAt = naverDate(g.slice(g.indexOf('확인매물') + 4)); continue; }
      others.push(g);
    }
    for (j = 0; j < others.length; j++) {
      if (/공인중개|중개사|중개법인|중개|부동산/.test(others[j]) && !PROVIDER_RE.test(others[j]) && others[j].length <= 40) { c.agent = others[j]; break; }
    }
    var memo = ['네이버 목록에서 읽었어요(상세 화면은 안 봄)'];
    if ((trade === '월세' || trade === '단기임대') && ph.monthly) memo.push(trade + ': 보증금 ' + priceText(ph));
    if (c.area) memo.push('면적: 목록 표기 ' + listAreaText(c.area) + '. 반올림 값이라 비워 뒀어요(상세 화면에서 확인)');
    var ch = /(상승|하락)/.exec(ph.rest);
    if (ch) memo.push('목록에 가격 변동(' + ch[1] + ') 표시');
    out.card = {
      c: c,
      raw: {
        name: c.name, dong: c.dong, askPrice: moneyOf(ph.deposit), tradeType: trade,
        floor: c.floor, direction: c.direction, agentName: c.agent, confirmedAt: c.confirmedAt,
        memo: memo.join('\n')
      }
    };
    return out;
  }

  /** 맨 앞 줄(빈 줄 건너뜀)이 "URL: https://…"(iPad 단축어가 붙임)이면 그 줄을 지우고 링크를 돌려준다(http/https 만) */
  function takeUrlLine(L) {
    for (var i = 0; i < L.length; i++) {
      var f = flat(L[i]);
      if (!f) continue;
      var m = /^URL\s*[:：]\s*(\S+)/i.exec(f);
      if (!m) return '';
      L[i] = '';
      return httpUrl(m[1]);
    }
    return '';
  }

  function looksNaver(L, url) {
    var host = '';
    try { host = url ? new URL(url).hostname : ''; } catch (e) { host = ''; }
    if (/(^|\.)land\.naver\.com$/i.test(host)) return true;
    var hit = 0;
    NAVER_MARKS.forEach(function (re) { if (findLine(L, 0, re) >= 0) hit++; });
    return hit >= 2;
  }

  /**
   * 네이버 부동산 매물 화면 글 해석(1.4.0). opts·결과 모양은 parse 와 같고 source: 'naver', kind, detailFailed 를 더한다.
   * kind: 'detail'(상세 매물 하나) | 'list'(관심·최근조회 목록 카드만) | 'mixed'(상세 + 목록. 목록 매물은 기본 해제)
   * detailFailed(1.4.1): 상세 화면 표시('기본 정보'·'매물번호' 줄, 링크의 매물번호)가 있는데 상세 매물을 읽지 못함.
   *   이때 목록 매물은 기본 해제(사용자는 상세 매물 하나를 담으려던 것이므로), 매물이 없으면 'naver-detail' 문구
   * 오류: empty / too-big / naver(네이버 글로 보이는데 매물을 못 찾음) / notfound(네이버 글이 아님)
   */
  function parseNaverText(input, opts) {
    opts = opts || {};
    var res = { ok: false, error: '', message: '', entries: [], total: 0, truncated: 0, skipped: 0, blocks: 0, incomplete: false, source: 'naver', kind: '', detailFailed: false };
    var src = typeof input === 'string' ? input : '';
    if (!src.trim()) { res.error = 'empty'; return res; }
    if (src.length > LIMITS.inputChars) { res.error = 'too-big'; res.message = MESSAGES['too-big']; return res; }
    var L = naverLines(src);
    var url = takeUrlLine(L);
    var detail = naverDetail(L);
    var detailFailed = !detail && (findLine(L, 0, ANCHOR_RE) >= 0 || findLine(L, 0, /^매물번호(\s|$)/) >= 0 || !!(url && articleNoFromUrl(url)));
    var list = [];
    var extras = [];
    if (detail) {
      // 단축어가 붙인 링크는 상세 매물의 링크로. 링크의 매물번호가 화면과 다르면(다른 매물 주소) 넣지 않는다
      var urlNo = url ? articleNoFromUrl(url) : '';
      if (url && urlNo && detail.raw.articleNo && urlNo !== detail.raw.articleNo) detail.notes.push('링크의 매물번호가 화면과 달라 링크는 뺐어요');
      else if (url) detail.raw.sourceUrl = url;
      list.push(detail.raw);
      extras.push({ notes: detail.notes, fromList: false, unchecked: false, loose: true, approx: detail.approx });
    }
    for (var i = 0; i < L.length; i++) {
      if (flat(L[i]) !== '매물') continue;
      var r = naverCard(L, i);
      i = r.end - 1;
      if (!r.card) continue;
      var d = detail && detail.raw;
      // 상세 매물과 같은 카드(왼쪽 목록에도 떠 있음)는 한 번만
      if (d && r.card.raw.name.replace(/\s+/g, '') === d.name.replace(/\s+/g, '') && r.card.raw.dong === d.dong &&
        r.card.raw.askPrice === d.askPrice && r.card.raw.tradeType === d.tradeType && (!r.card.raw.floor || !d.floor || r.card.raw.floor === d.floor)) continue;
      list.push(r.card.raw);
      extras.push({ notes: ['목록에서 읽어 면적은 비워 뒀어요'], fromList: true, unchecked: !!detail || detailFailed, loose: true });
    }
    res.detailFailed = detailFailed;
    if (!list.length) {
      res.error = detailFailed || looksNaver(L, url) ? 'naver' : 'notfound';
      res.message = detailFailed ? MESSAGES['naver-detail'] : (res.error === 'naver' ? MESSAGES.naver : MESSAGES.nothing);
      return res;
    }
    res.kind = detail ? (list.length > 1 ? 'mixed' : 'detail') : 'list';
    res.blocks = 1;
    fillEntries(res, list, opts, extras);
    if (!res.entries.length) { res.error = 'naver'; res.message = MESSAGES.naver; return res; }
    res.ok = true;
    return res;
  }

  /**
   * 앱 입력 칸·도구용 해석(1.4.0): 가져오기 코드(JSON)를 먼저 찾고, 없거나 못 읽으면 네이버 매물 화면 글로 읽는다.
   * 코드와 네이버 글이 함께 있으면 코드를 쓴다. 둘 다 아니면 코드 쪽 오류(코드를 못 찾았으면 'nothing' 문구로)
   */
  function parseText(input, opts) {
    var r = parse(input, opts);
    if (r.ok || r.error === 'empty' || r.error === 'too-big') return r;
    var n = parseNaverText(input, opts);
    if (n.ok || n.error === 'naver') return n;
    if (r.error === 'notfound') r.message = MESSAGES.nothing;
    return r;
  }

  /**
   * 정리된 매물들 → 코드 객체(빈 값은 뺌, 호수 없음). tools/make-import-code.js 가 쓴다.
   * opts.from: 'naver-text'(1.4.1) 이면 최상위에 "from" 을 넣는다. 앱(parse)이 보고 네이버 글 주의·출처를 쓴다
   * opts.registry(1.6.0): 등기부 기록(snapshot)이면 "registry" 로 넣는다(registryToCode). 매물이 없으면 properties 는 뺀다
   */
  function toCode(props, opts) {
    var order = ['name', 'dong', 'area', 'supplyArea', 'askPrice', 'realPrice', 'tradeType', 'floor', 'direction',
      'agentName', 'agentPhone', 'sourceUrl', 'articleNo', 'confirmedAt', 'memo'];
    var code = { imjang: CODE_VERSION };
    if (opts && opts.from === NAVER_SOURCE_ID) code.from = NAVER_SOURCE_ID;
    code.properties = (props || []).map(function (p) {
      var o = {};
      order.forEach(function (k) {
        var v = p[k];
        if (v === null || v === undefined || v === '') return;
        o[k] = v;
      });
      return o;
    });
    if (opts && opts.registry) {
      if (!code.properties.length) delete code.properties;
      code.registry = registryToCode(opts.registry);
    }
    return code;
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
    NAVER_SOURCE_ID: NAVER_SOURCE_ID,
    LIMITS: LIMITS,
    PROMPT: PROMPT,
    REGISTRY_PROMPT: REGISTRY_PROMPT, // 1.6.0
    MESSAGES: MESSAGES,
    parse: parse,
    parseText: parseText,           // 1.4.0: 코드 → 네이버 글 순서(앱 입력 칸·도구)
    parseNaverText: parseNaverText, // 1.4.0
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
    linkFragment: linkFragment,
    // 1.6.0 등기부 코드
    parseRegistryBlock: parseRegistryBlock,
    registryToCode: registryToCode,
    maskRrn: maskRrn,
    REGISTRY_ANSWERS: REG_ANSWERS.map(function (a) { return { id: a[0], type: a[1], label: a[2] }; }),
    REGISTRY_CATEGORIES: REG_CATS.map(function (c) {
      return { key: c, label: REG_CAT_LABEL[c], item: has(REG_CAT_ITEM, c) ? REG_CAT_ITEM[c] : '' };
    })
  };
});
