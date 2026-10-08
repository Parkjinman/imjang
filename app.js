/*
 * 임장 체크리스트 — app.js
 * 순수 자바스크립트(빌드·프레임워크·외부 라이브러리 없음). data.js 다음에 로드된다.
 *
 * 구성
 *   1. 상수
 *   2. 작은 도구(숫자·날짜·환경)
 *   3. 체크리스트 데이터 정리 (data.js 의 window.CHECKLIST)
 *   4. 저장소: 매물·체크 상태 (localStorage 'imjang.v1')
 *   5. 사진 저장소 (IndexedDB 'imjang-photos')
 *   6. 계산: 진행률·위험 신호·요약
 *   7. 공통 UI: DOM 헬퍼, 아이콘, 진행 막대, 토스트, 대화상자, 사진 크게 보기
 *   8. 화면: 홈 / 매물 폼 / 상세 / 요약 / 비교 / 용어 / 설정 / 코드로 매물 추가(Claude 가져오기 코드)
 *   9. 라우터·시작
 *
 * 보안: 사용자 입력은 항상 textContent(또는 value)로만 화면에 넣는다. innerHTML 은 고정 아이콘 SVG 에만 쓴다.
 * 가져오기 코드 해석은 import-parser.js(window.ImjangImport)가 맡는다. data.js 다음, 이 파일 전에 로드된다.
 * 두 기록 합치기(백업 [합치기]·여러 탭)는 merge.js(window.ImjangMerge)가 맡는다. import-parser.js 다음, 이 파일 전에 로드된다.
 */
(function () {
  'use strict';

  // =====================================================
  // 1. 상수
  // =====================================================
  var APP_VERSION = '1.3.2';
  var STORAGE_KEY = 'imjang.v1';
  var DRAFT_KEY = 'imjang.v1.draft'; // 새 매물 폼 임시 저장(앱이 내려가도 남도록 localStorage)
  var SCHEMA_VERSION = 1;
  var PHOTO_DB_NAME = 'imjang-photos';
  var PHOTO_STORE = 'photos';
  var PHOTO_MAX_EDGE = 1600;
  var PHOTO_QUALITY = 0.8;
  var SAVE_DELAY_MS = 400;
  var TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60 * 1000; // 지운 매물 표시(다른 탭과 맞추기용) 보관 기간
  var SW_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  var BACKUP_APP_ID = 'imjang-checklist';
  // 가져오기 코드 해석기(import-parser.js). 파일이 없으면 null 이고, 그때는 '코드로 매물 추가' 화면만 안내로 바뀐다
  var IMP = window.ImjangImport || null;
  var IMPORT_TEXT_KEY = 'imjang.import.text'; // 붙여 넣은 글(sessionStorage). Claude 앱에 다녀와도 남게
  var GONE_KEYS_MAX = 600; // 지운 매물 열쇠(goneKeys) 최대 개수
  // 두 기록 합치기(merge.js). 파일이 없으면 null 이고, 그때는 탭끼리 매물 단위로 합치고(1.2.x 방식) 백업 [합치기]만 막는다
  var MG = window.ImjangMerge || null;
  var DEVICE_NAME_MAX = 20; // 기기 이름 최대 글자 수

  var STATUSES = [
    { id: 'review', label: '검토 중' },
    { id: 'planned', label: '임장 예정' },
    { id: 'visited', label: '임장 완료' },
    { id: 'contract', label: '계약 검토' },
    { id: 'dropped', label: '탈락' }
  ];
  var STATUS_LABEL = {};
  STATUSES.forEach(function (s) { STATUS_LABEL[s.id] = s.label; });

  var ITEM_TYPES = ['check', 'rate', 'flag', 'ask', 'visit'];

  // 빈 화면에 보여 줄 올바른 순서 (등기부가 임장보다 먼저)
  var FLOW_STEPS = [
    { title: '단지 고르기', desc: '실거래가(실제로 거래된 가격)를 보고 예산에 맞는 단지를 고릅니다. 아직 집을 보러 가지 않아요.' },
    { title: '동·호수 받기', desc: '중개사에게 실제로 나온 매물의 정확한 동·호수를 받습니다. 그래야 그 집의 등기부를 볼 수 있어요.' },
    { title: '등기부 먼저', desc: '등기부등본(집 주인과 빚 기록이 적힌 공식 서류)을 인터넷등기소에서 열람해요. 신탁·가압류 같은 문제가 있으면 그 집은 보러 갈 필요가 없어요.', key: true },
    { title: '임장', desc: '임장(현장에 직접 가서 보는 것)으로 동네·단지·집 안을 확인하고, 시간대를 바꿔 한 번 더 가 봐요.' },
    { title: '계약 전 재확인', desc: '가계약금(정식 계약 전에 먼저 보내는 돈)을 보내기 전에 오늘 날짜로 등기부를 다시 떼고, 계약일·잔금일 아침에도 또 확인해요.' }
  ];

  var DISCLAIMER = '이 앱은 교육·참고용 체크리스트이며 법률·세무 자문이 아니에요. 계약 전에는 공인중개사·법무사 등 전문가에게 꼭 확인하세요.';
  var INSTALL_TIP = '공유(또는 ⋯ → 공유) → 홈 화면에 추가하면 데이터가 더 안전하게 보관돼요(Safari는 오래 안 쓴 사이트 데이터를 지울 수 있어요). 백업도 해 두세요.';
  var INSTALL_TIP_MOVE = '홈 화면 앱은 Safari와 저장 공간이 따로예요. 이미 입력한 기록이 있으니, 추가하기 전에 설정 → 백업 파일 만들기를 하고 홈 화면 앱에서 불러오세요.';

  // 고정 아이콘 (24x24, 선 아이콘). 사용자 입력이 아니므로 innerHTML 사용 가능
  var ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5.5h4V20"/>',
    compare: '<rect x="3.5" y="4" width="7" height="16" rx="1.5"/><rect x="13.5" y="4" width="7" height="16" rx="1.5"/><path d="M6 9h2M16 9h2M6 13h2M16 13h2"/>',
    book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7.5h6M9 11h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.6"/><path d="M12 17.2h.01"/>',
    share: '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    phone: '<path d="M5 4h3.5l2 5-2.4 1.5a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    note: '<path d="M6 3.5h12v17H6z"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.3h.01"/>',
    paste: '<path d="M9 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="3" width="6" height="3.5" rx="1"/><path d="M9 12h6M9 16h4"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="1.5"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>'
  };

  // =====================================================
  // 2. 작은 도구
  // =====================================================
  function $(sel, root) { return (root || document).querySelector(sel); }

  function uid() {
    var rand = '';
    try {
      var a = new Uint8Array(6);
      window.crypto.getRandomValues(a);
      rand = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) {
      rand = Math.random().toString(16).slice(2, 14);
    }
    return Date.now().toString(36) + '-' + rand;
  }

  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function parseIntInput(text) {
    var digits = String(text || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    var n = parseInt(digits, 10);
    return isFinite(n) ? n : null;
  }
  function parseDecimalInput(text) {
    var s = String(text || '').replace(/,/g, '').replace(/[^\d.]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function domId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatNumber(n) { return Number(n).toLocaleString('ko-KR'); }

  /** 만원 단위 숫자 → "8억 5,000만원" */
  function formatManwon(n) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    n = Math.round(n);
    var neg = n < 0;
    n = Math.abs(n);
    var eok = Math.floor(n / 10000);
    var rest = n % 10000;
    var out;
    if (eok > 0 && rest > 0) out = eok + '억 ' + formatNumber(rest) + '만원';
    else if (eok > 0) out = eok + '억원';
    else out = formatNumber(rest) + '만원';
    return (neg ? '-' : '') + out;
  }

  /** 호가가 실거래가보다 몇 % 높은지 (둘 다 있어야 계산) */
  function diffPercent(ask, real) {
    if (!ask || !real) return null;
    return ((ask - real) / real) * 100;
  }
  function pctText(p) {
    if (p === null || p === undefined) return '-';
    var r = Math.round(p * 10) / 10;
    return (r > 0 ? '+' : '') + r.toFixed(1) + '%';
  }
  function diffSentence(ask, real) {
    var p = diffPercent(ask, real);
    if (p === null) return '';
    var abs = Math.abs(Math.round(p * 10) / 10).toFixed(1);
    if (abs === '0.0') return '호가가 최근 실거래가와 거의 같아요.';
    var gap = formatManwon(Math.abs(ask - real));
    return '호가가 최근 실거래가보다 ' + abs + '% ' + (p > 0 ? '높아요' : '낮아요') + ' (' + gap + ' ' + (p > 0 ? '더 비쌈' : '더 쌈') + ').';
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function formatDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /** 짧은 날짜·시각: "10월 9일 21:10" (올해가 아니면 앞에 "2025년 ") */
  function shortDateTime(ts) {
    var d = new Date(ts);
    var y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '년 ' : '';
    return y + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function formatISODate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? m[1] + '.' + m[2] + '.' + m[3] : str(iso);
  }
  function bytesText(n) {
    if (!isFinite(n)) return '-';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + 'GB';
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() { return window.navigator.standalone === true; }
  /** 기기 이름 기본값(설정에서 바꾸지 않았을 때): iPad / iPhone / Mac / 기타 */
  function defaultDeviceName() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return 'iPad';
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
      // iPadOS 는 Mac 처럼 보인다. iPhone Safari 의 "데스크톱 웹사이트 요청"도 같게 보여서 화면 짧은 변으로 가른다
      var short = Math.min(window.screen.width || 0, window.screen.height || 0);
      return short && short < 600 ? 'iPhone' : 'iPad';
    }
    if (/iPhone|iPod/.test(ua)) return 'iPhone';
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
    return '기타';
  }
  /** 저장·표시용 기기 이름: 줄바꿈·제어 문자를 빼고 앞뒤 공백을 지운 20자 */
  function cleanDeviceName(v) {
    return str(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
  }
  function deviceName() { return (state && state.ui.deviceName) || defaultDeviceName(); }
  /** 파일 이름에 넣을 기기 이름: 영문·숫자·한글·-·_ 만 남긴다(나머지는 -) */
  function fileSafeName(v) {
    var s = str(v);
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(/[^A-Za-z0-9가-힣_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  }
  /** 카카오톡·네이버 앱 등 앱 안 브라우저(WebView). 홈 화면 추가 메뉴가 없고 저장 공간이 쉽게 지워진다 */
  function inAppBrowser() {
    var ua = navigator.userAgent || '';
    var m = /KAKAOTALK|NAVER\(inapp|NAVER|DaumApps|Instagram|FBAN|FBAV|Line\//i.exec(ua);
    if (!m) return null;
    var k = m[0].toUpperCase();
    if (k === 'KAKAOTALK') return '카카오톡';
    if (k.indexOf('NAVER') === 0) return '네이버 앱';
    if (k === 'DAUMAPPS') return '다음 앱';
    if (k === 'INSTAGRAM') return '인스타그램';
    if (k === 'FBAN' || k === 'FBAV') return '페이스북';
    return '라인';
  }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function sessionGet(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
  function sessionSet(key, val) { try { sessionStorage.setItem(key, val); } catch (e) { /* 무시 */ } }
  function sessionRemove(key) { try { sessionStorage.removeItem(key); } catch (e) { /* 무시 */ } }
  function localGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function localSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
  function localRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* 무시 */ } }

  function unitText(p) {
    var parts = [];
    if (p.dong) parts.push(p.dong.replace(/\s*동$/, '') + '동');
    if (p.ho) parts.push(p.ho.replace(/\s*호$/, '') + '호');
    return parts.join(' ');
  }
  function telHref(phone) {
    var digits = str(phone).replace(/[^\d+]/g, '');
    return digits.length >= 3 ? 'tel:' + digits : null;
  }
  function safeUrl(url) {
    try {
      var u = new URL(url, location.href);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (e) { return null; }
  }
  /** 매물 링크: 절대 주소 중 http/https 만(상대 주소·javascript: 등은 버림). 아니면 '' */
  function httpUrlOrEmpty(v) {
    var s = str(v).trim();
    if (!s || /\s/.test(s)) return '';
    try {
      var u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch (e) { return ''; }
  }
  function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  /** 빈 값('' null undefined)끼리는 같다고 보는 비교 */
  function sameValue(a, b) {
    return a === b || ((a === '' || a === null || a === undefined) && (b === '' || b === null || b === undefined));
  }
  /** 층 표시: "12/25" → "12/25층". 이미 '층'으로 끝나면 그대로 */
  function floorText(f) {
    var s = str(f).trim();
    return !s ? '' : (/층$/.test(s) ? s : s + '층');
  }
  /** 매물 한 줄 정보: 동·호 · 전용면적 · 층 · 방향 */
  function propLine(p) {
    return [unitText(p), p.area ? '전용 ' + p.area + '㎡' : '', floorText(p.floor), str(p.direction).trim()].filter(Boolean).join(' · ');
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function blobToArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }
  function readFileText(file) {
    if (file.text) return file.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }
  function dataURLToBlob(dataUrl) {
    var m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!m) throw new Error('잘못된 사진 데이터');
    var type = m[1] || 'image/jpeg';
    var bytes;
    if (m[2]) {
      var bin = atob(m[3]);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    }
    return new Blob([bytes], { type: type });
  }

  // =====================================================
  // 3. 체크리스트 데이터 정리
  //    data.js 구조만 믿고, 섹션·항목 수에 의존하지 않는다.
  // =====================================================
  function normalizeChecklist(raw) {
    var out = { ok: false, version: '', sections: [], glossary: [], links: [], itemById: {}, sectionById: {} };
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return out;
    out.ok = true;
    out.version = str(raw.version);
    var seenItem = {};
    var seenSec = {};
    raw.sections.forEach(function (s, si) {
      if (!s || typeof s !== 'object') return;
      var secId = str(s.id) || ('section-' + si);
      if (seenSec[secId]) secId = secId + '-' + si;
      seenSec[secId] = true;
      var sec = {
        id: secId,
        title: str(s.title) || '이름 없는 섹션',
        when: str(s.when),
        desc: str(s.desc),
        gate: s.gate === true,
        // rate 항목 "주의"를 요약에서 어디로 모을지: 'contract'(협상·특약 후보) | 'reference'(가격 판단 참고)
        cautionUse: s.cautionUse === 'reference' ? 'reference' : 'contract',
        items: []
      };
      (Array.isArray(s.items) ? s.items : []).forEach(function (it, ii) {
        if (!it || typeof it !== 'object' || !it.text) return;
        var id = str(it.id) || (secId + '-' + ii);
        if (seenItem[id]) id = secId + '__' + id + '__' + ii; // id 중복 방지
        seenItem[id] = true;
        var type = ITEM_TYPES.indexOf(it.type) >= 0 ? it.type : 'check'; // 모르는 type 은 check
        sec.items.push({
          id: id,
          type: type,
          text: str(it.text),
          help: str(it.help),
          tip: str(it.tip),
          group: str(it.group),
          severity: type === 'flag' ? (it.severity === 'stop' ? 'stop' : 'caution') : '',
          sectionId: secId
        });
      });
      out.sections.push(sec);
    });
    // gate 표시가 없으면 id 'registry' 를 등기부(게이트) 섹션으로 본다
    if (!out.sections.some(function (s) { return s.gate; })) {
      out.sections.forEach(function (s) { if (s.id === 'registry') s.gate = true; });
    }
    // 등기부(게이트) 섹션은 항상 맨 위. 나머지는 data.js 순서 그대로
    out.sections = out.sections.filter(function (s) { return s.gate; })
      .concat(out.sections.filter(function (s) { return !s.gate; }));
    out.sections.forEach(function (s) {
      out.sectionById[s.id] = s;
      s.items.forEach(function (it) { out.itemById[it.id] = it; });
    });
    out.glossary = (Array.isArray(raw.glossary) ? raw.glossary : [])
      .filter(function (g) { return g && g.term; })
      .map(function (g) { return { term: str(g.term), desc: str(g.desc) }; });
    out.links = (Array.isArray(raw.links) ? raw.links : [])
      .map(function (l) { return l && { label: str(l.label) || str(l.url), url: safeUrl(str(l.url)), desc: str(l.desc) }; })
      .filter(function (l) { return l && l.url; });
    return out;
  }

  var CL = normalizeChecklist(window.CHECKLIST);

  function gateSections() { return CL.sections.filter(function (s) { return s.gate; }); }

  // =====================================================
  // 4. 저장소 (localStorage)
  //    - 바뀐 것이 있을 때만(dirty) 저장한다. 화면을 떠날 때도 dirty 일 때만 쓴다.
  //    - Safari 탭(창)이 여러 개 열려 있어도 기록이 사라지지 않도록, 쓰기 직전에 저장소의 rev 를 읽어
  //      다른 탭이 먼저 쓴 내용이 있으면 합친 뒤 쓴다. 1.3.0 부터 항목 단위(merge.js mergeProperty):
  //      항목·기본 정보 필드·상태·섹션 메모마다 바뀐 시각(t, fieldsAt, statusAt, sectionMemoAt)이 더 나중인 쪽을 남긴다.
  //      백업 [합치기](두 기기 맞추기)도 같은 규칙(merge.js mergeStates)을 쓴다.
  //    - 다른 탭에서 지운 매물은 deleted { id: 지운 시각 } 로 맞춘다. 백업에 실려 다른 기기 [합치기]에서도 지운다.
  //    - 전체 삭제·[덮어쓰기]는 "이 기기 초기화"라 localDeleted { id: 시각 } 에 따로 남긴다(1.3.1). 이 기기의 다른 탭만
  //      맞추고(그 시각 전의 예전 사본을 버림), 백업에는 넣지 않아 다른 기기 매물을 지우지 않는다.
  //    - 새 시각은 늘 바꾸는 값의 시각보다 나중으로 찍는다(stampAfter). 기기 시계가 늦어도 마지막에 고친 값이 이긴다.
  //    - 지운 매물의 중복 판단 열쇠(매물번호·링크·단지명 조합·층)는 goneKeys { 열쇠: 지운 시각 } 에 남겨,
  //      가져오기 코드에 같은 매물이 다시 오면 "전에 지운 매물이에요"라고 알려 준다.
  //    - 업데이트 전에 열어 둔 1.1.0 탭이 저장하면 1.2.0 매물 필드가 키째 빠진다. 합칠 때 키가 없으면 내 값을 지킨다.
  // =====================================================
  var BAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
  var loadProblem = null; // 'blocked' | 'broken'

  function emptyState() {
    return { version: SCHEMA_VERSION, rev: '', properties: [], deleted: {}, localDeleted: {}, goneKeys: {}, ui: { dismissedInstallTip: false, lastBackupAt: null, deviceName: '', deviceNameAt: null } };
  }

  var ITEM_VALUE_KEYS = ['status', 'memo', 'answer', 'date', 'done']; // 항목 상태의 값 이름(merge.js ITEM_FIELDS 와 같음)

  function normalizeItems(items) {
    var out = {};
    if (!items || typeof items !== 'object') return out;
    Object.keys(items).forEach(function (k) {
      if (BAD_KEYS[k]) return;
      var v = items[k];
      if (!v || typeof v !== 'object') return;
      var o = {};
      if (v.status) o.status = str(v.status);
      if (v.memo) o.memo = str(v.memo);
      if (v.answer) o.answer = str(v.answer);
      if (v.date) o.date = str(v.date);
      if (v.done) o.done = true;
      // 1.3.0: 바뀐 시각. t 는 항목 전체, ft 는 값마다 { status: ms, … }.
      // 값을 모두 지운 항목도 { t, ft } 로 남긴다(다른 기기의 예전 값이 합칠 때 되살아나지 않게)
      var t = numOrNull(v.t);
      if (t > 0) o.t = t;
      if (v.ft && typeof v.ft === 'object') {
        var ft = {};
        ITEM_VALUE_KEYS.forEach(function (f) { var x = numOrNull(v.ft[f]); if (x > 0) ft[f] = x; });
        if (Object.keys(ft).length) o.ft = ft;
      }
      if (Object.keys(o).length) out[k] = o;
    });
    return out;
  }

  function normalizeMemos(memos) {
    var out = {};
    if (!memos || typeof memos !== 'object') return out;
    Object.keys(memos).forEach(function (k) {
      if (BAD_KEYS[k]) return;
      if (memos[k]) out[k] = str(memos[k]);
    });
    return out;
  }

  function normalizeDeleted(d) {
    var out = {};
    if (!d || typeof d !== 'object') return out;
    var cutoff = Date.now() - TOMBSTONE_KEEP_MS;
    Object.keys(d).forEach(function (k) {
      if (BAD_KEYS[k]) return;
      var t = numOrNull(d[k]);
      if (t && t > cutoff) out[k] = t;
    });
    return out;
  }

  /**
   * 새로 찍을 시각(1.3.1): now 와, 앞선 시각들(바꾸는 값의 지금 시각 등)보다 1ms 뒤 중 큰 값(merge.js after 와 같음).
   * 이 기기 시계가 다른 기기보다 늦어도, 합친 뒤에 고친 값·지운 매물이 방금 받은 값에 지지 않게 한다
   */
  function stampAfter(now) {
    var t = now;
    for (var i = 1; i < arguments.length; i++) {
      var p = numOrNull(arguments[i]);
      if (p > 0 && p >= t) t = p + 1;
    }
    return t;
  }

  /** { 키: 양수 시각 } 만 남긴다(merge.js 를 못 불러왔을 때 저장된 변경 시각을 버리지 않으려고) */
  function timeMapOf(m) {
    var out = {};
    if (!m || typeof m !== 'object') return out;
    Object.keys(m).forEach(function (k) {
      if (BAD_KEYS[k]) return;
      var t = numOrNull(m[k]);
      if (t > 0) out[k] = t;
    });
    return out;
  }

  function normalizeProperty(p) {
    var now = Date.now();
    var np = {
      id: str(p.id) || uid(),
      name: str(p.name).trim() || '이름 없는 매물',
      dong: str(p.dong),
      ho: str(p.ho),
      area: numOrNull(p.area),
      supplyArea: numOrNull(p.supplyArea), // 공급면적 ㎡ (가져오기 코드)
      floor: str(p.floor),                 // 층 (예: "12/25", "중/25")
      direction: str(p.direction),         // 방향 (예: "남향")
      askPrice: numOrNull(p.askPrice),
      realPrice: numOrNull(p.realPrice),
      agentName: str(p.agentName),
      agentPhone: str(p.agentPhone),
      memo: str(p.memo),
      sourceUrl: httpUrlOrEmpty(p.sourceUrl), // 매물 링크(http/https 만)
      articleNo: str(p.articleNo),            // 네이버 부동산 매물번호
      confirmedAt: str(p.confirmedAt),        // 확인매물 날짜(화면에 적힌 그대로)
      status: STATUS_LABEL[p.status] ? p.status : 'review',
      dropReason: str(p.dropReason), // 상태를 바꿔도 지우지 않고 보관(탈락일 때만 보여 줌)
      createdAt: numOrNull(p.createdAt) || now,
      updatedAt: numOrNull(p.updatedAt) || now,
      importedAt: numOrNull(p.importedAt), // 가져오기 코드로 만든 시각(직접 입력이면 null)
      source: str(p.source),               // 'claude-code': 가져오기 코드로 만든 매물
      items: normalizeItems(p.items),
      sectionMemos: normalizeMemos(p.sectionMemos),
      // 1.3.0 변경 시각(두 기기 합치기용). 검사와 빈 곳 채우기(예전 기록은 legacyAt)는 merge.js fillTimes
      fieldsAt: p.fieldsAt,          // { 필드: ms } 기본 정보가 바뀐 시각
      statusAt: p.statusAt,          // ms 진행 상태·탈락 사유가 바뀐 시각
      sectionMemoAt: p.sectionMemoAt, // { 섹션id: ms } 섹션 메모가 바뀐 시각(지워도 남김)
      legacyAt: p.legacyAt           // 1.3.1. ms 시각 없는 예전 기록(1.2.x)을 처음 읽은 때. 그때의 값은 모두 알고 있었다는 뜻
    };
    if (MG) return MG.fillTimes(np);
    // merge.js 를 못 불러왔을 때: 저장된 시각은 검사만 하고 그대로 둔다(버리면 다음 합치기에서 예전 값이 새 값을 이길 수 있음).
    // 비어 있는 시각은 채우지 않는다(다음에 merge.js 가 뜨면 fillTimes 가 legacyAt 으로 채움)
    var legacy = !p.fieldsAt || typeof p.fieldsAt !== 'object';
    np.fieldsAt = timeMapOf(p.fieldsAt);
    np.statusAt = numOrNull(p.statusAt) > 0 ? numOrNull(p.statusAt) : np.updatedAt;
    np.sectionMemoAt = timeMapOf(p.sectionMemoAt);
    np.legacyAt = numOrNull(p.legacyAt) > 0 ? numOrNull(p.legacyAt) : (legacy ? np.updatedAt : null);
    if (!np.legacyAt) delete np.legacyAt;
    return np;
  }

  /** 저장된 데이터를 현재 스키마로 맞춘다. (나중에 version 이 바뀌면 여기서 변환) */
  function normalizeState(data) {
    var s = emptyState();
    if (!data || typeof data !== 'object') return s;
    s.rev = str(data.rev);
    s.deleted = normalizeDeleted(data.deleted);
    s.localDeleted = normalizeDeleted(data.localDeleted); // 1.3.1: 이 기기 초기화(전체 삭제·덮어쓰기)로 지운 매물
    s.goneKeys = normalizeDeleted(data.goneKeys); // 모양이 같다({ 열쇠: 시각 }, 180일 보관)
    var list = Array.isArray(data.properties) ? data.properties : [];
    var seen = {};
    list.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var np = normalizeProperty(p);
      if (seen[np.id]) np.id = uid();
      seen[np.id] = true;
      if (s.deleted[np.id] && s.deleted[np.id] >= np.updatedAt) return; // 지운 뒤 남은 사본
      s.properties.push(np);
    });
    if (data.ui && typeof data.ui === 'object') {
      s.ui.dismissedInstallTip = !!data.ui.dismissedInstallTip;
      s.ui.lastBackupAt = numOrNull(data.ui.lastBackupAt);
      s.ui.deviceName = cleanDeviceName(data.ui.deviceName); // 1.3.0: 사용자가 정한 기기 이름(비면 자동)
      s.ui.deviceNameAt = numOrNull(data.ui.deviceNameAt);
    }
    return s;
  }

  function parseStored(raw) {
    try {
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  var knownRev = ''; // 내 state 가 바탕으로 삼은 저장본의 rev

  function loadState() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      loadProblem = 'blocked';
      return emptyState();
    }
    if (!raw) return emptyState();
    var obj = parseStored(raw);
    if (!obj) {
      // 망가진 데이터는 지우지 않고 다른 이름으로 보관해 둔다
      try { localStorage.setItem(STORAGE_KEY + '.broken.' + Date.now(), raw); } catch (_) { /* 무시 */ }
      loadProblem = 'broken';
      return emptyState();
    }
    var s = normalizeState(obj);
    knownRev = s.rev;
    return s;
  }

  var state = loadState();
  var saveTimer = null;
  var saveFailed = false;
  var dirty = false;
  var lastSavedAt = null;

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    updateSaveState();
  }

  // 1.2.0 에서 늘어난 매물 필드. 업데이트 전에 열어 둔 1.1.0 탭(서비스 워커 캐시)은 이 키를 모른 채 저장한다
  var FIELDS_120 = ['sourceUrl', 'floor', 'direction', 'supplyArea', 'articleNo', 'confirmedAt', 'importedAt', 'source'];
  var needResave = false; // 합치면서 예전 탭이 지운 필드를 되살렸으면 다시 저장해 저장본에도 되돌려 놓는다

  /**
   * 저장본 원문에서 1.3.0 시각(fieldsAt)이 아예 없는 매물 { id: true }.
   * 업데이트 전에 열어 둔 1.2.x 이하 탭이 쓴 매물이다. 이 탭은 항목을 지울 때 키째 지우고 시각도 남기지 않으므로,
   * 항목 단위로 합치면 그 탭에서 지운 값이 되살아날 수 있다. 그래서 이런 매물은 예전처럼 매물 단위로 합친다.
   */
  function oldTabProps(raw) {
    var out = {};
    (raw && Array.isArray(raw.properties) ? raw.properties : []).forEach(function (p) {
      if (!p || typeof p !== 'object' || !p.id || BAD_KEYS[p.id]) return;
      if (!hasOwn(p, 'fieldsAt')) out[str(p.id)] = true;
    });
    return out;
  }

  /** 저장본 원문에서 매물별로 아예 없는 1.2.0 필드 키 { id: [키…] } (빈 값과 구분: 키가 없을 때만) */
  function missingNewFields(raw) {
    var out = {};
    (raw && Array.isArray(raw.properties) ? raw.properties : []).forEach(function (p) {
      if (!p || typeof p !== 'object' || !p.id || BAD_KEYS[p.id]) return;
      var miss = FIELDS_120.filter(function (k) { return !hasOwn(p, k); });
      if (miss.length) out[str(p.id)] = miss;
    });
    return out;
  }

  /**
   * 다른 탭이 저장한 내용(incoming)을 내 state 에 합친다.
   * 매물 객체를 바꿔치기하지 않고 내용만 고쳐 써서, 화면이 쥐고 있는 매물 참조가 그대로 유효하다.
   * 같은 매물은 항목 단위로 합친다(merge.js mergeProperty: 항목·필드마다 더 나중에 고친 쪽).
   * oldTab: oldTabProps 결과. 예전 버전 탭이 쓴 매물은 예전처럼 매물 단위로 더 나중 것을 쓴다.
   * missing: missingNewFields 결과. 그중 1.1.0 탭이 쓴 매물은 1.2.0 필드를 내 값으로 지킨다.
   * 내 state 의 내용이 바뀌었으면 true.
   */
  function mergeInto(target, incoming, missing, oldTab) {
    var changed = false;
    // 1.3.1: 다른 탭이 이 기기를 초기화(전체 삭제·덮어쓰기)했는데 내가 아직 몰랐으면, 그 전의 내 사본은 버린다.
    // 저장본에 같은 매물이 있으면(덮어쓰기로 바뀐 것, 초기화 뒤 합치기로 들어온 것) 그것으로 바꾼다(참조는 그대로).
    // 초기화 뒤에 이 탭에서 고친 매물(updatedAt 이 더 나중)만 아래에서 평소처럼 합친다
    var ld = Object.assign({}, target.localDeleted);
    var reset = {};
    Object.keys(incoming.localDeleted || {}).forEach(function (id) {
      var t = incoming.localDeleted[id];
      if (!ld[id] || t > ld[id]) { ld[id] = t; reset[id] = t; }
    });
    target.localDeleted = ld;
    if (Object.keys(reset).length) {
      var inc = {};
      incoming.properties.forEach(function (p) { inc[p.id] = p; });
      target.properties = target.properties.filter(function (mine) {
        var id = mine.id;
        if (!hasOwn(reset, id) || (mine.updatedAt || 0) > reset[id]) return true;
        changed = true;
        if (!hasOwn(inc, id)) return false;
        Object.keys(mine).forEach(function (k) { delete mine[k]; });
        Object.assign(mine, inc[id]);
        return true;
      });
    }
    var del = Object.assign({}, target.deleted);
    Object.keys(incoming.deleted || {}).forEach(function (id) {
      if (!del[id] || incoming.deleted[id] > del[id]) del[id] = incoming.deleted[id];
    });
    target.deleted = del;
    var gone = Object.assign({}, target.goneKeys);
    Object.keys(incoming.goneKeys || {}).forEach(function (k) {
      if (!gone[k] || incoming.goneKeys[k] > gone[k]) { gone[k] = incoming.goneKeys[k]; changed = true; }
    });
    target.goneKeys = gone;
    var byId = {};
    target.properties.forEach(function (p) { byId[p.id] = p; });
    incoming.properties.forEach(function (p) {
      var mine = byId[p.id];
      if (!mine) { target.properties.push(p); byId[p.id] = p; changed = true; return; }
      if (MG && !(oldTab && hasOwn(oldTab, p.id))) {
        // 항목 단위: 양쪽에서 고친 다른 항목이 모두 남고, 같은 항목은 더 나중에 고친 쪽
        var r = MG.mergeProperty(mine, p);
        Object.assign(mine, r.prop);
        if (r.changed) changed = true;
        return;
      }
      // 예전 버전 탭이 쓴 매물(또는 merge.js 를 못 불러옴): 매물 단위로 더 나중 것
      if ((p.updatedAt || 0) > (mine.updatedAt || 0)) {
        var keep = {};
        (missing && hasOwn(missing, p.id) ? missing[p.id] : []).forEach(function (k) {
          if (mine[k] !== '' && mine[k] !== null && mine[k] !== undefined) keep[k] = mine[k];
        });
        Object.assign(mine, p, keep);
        if (Object.keys(keep).length) needResave = true;
        changed = true;
      }
    });
    var before = target.properties.length;
    target.properties = target.properties.filter(function (p) { return !(del[p.id] && del[p.id] >= (p.updatedAt || 0)); });
    if (target.properties.length !== before) changed = true;
    var a = numOrNull(target.ui.lastBackupAt);
    var b = numOrNull(incoming.ui.lastBackupAt);
    var last = a && b ? Math.max(a, b) : (a || b || null);
    if (last !== target.ui.lastBackupAt) { target.ui.lastBackupAt = last; changed = true; }
    if (incoming.ui.dismissedInstallTip && !target.ui.dismissedInstallTip) { target.ui.dismissedInstallTip = true; changed = true; }
    // 기기 이름: 더 나중에 바꾼 쪽(같은 기기의 다른 탭에서 바꾼 이름이 예전 이름으로 돌아가지 않게)
    var na = numOrNull(target.ui.deviceNameAt) || 0;
    var nb = numOrNull(incoming.ui.deviceNameAt) || 0;
    if (nb > na) { target.ui.deviceName = incoming.ui.deviceName; target.ui.deviceNameAt = nb; changed = true; }
    return changed;
  }

  /** 저장소에 다른 탭이 쓴 새 내용이 있으면 합친다. 합쳐서 내 state 가 바뀌면 true */
  function pullFromStorage() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var obj = parseStored(raw);
    if (!obj || !obj.rev || str(obj.rev) === knownRev) return false;
    var changed = mergeInto(state, normalizeState(obj), missingNewFields(obj), oldTabProps(obj));
    knownRev = str(obj.rev);
    return changed;
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    var pulled = false;
    try {
      pulled = pullFromStorage(); // 다른 탭이 먼저 쓴 내용을 덮어쓰지 않도록 합친 뒤 쓴다
      needResave = false;         // 지금 통째로 쓰므로 되살린 필드도 함께 저장된다
      state.version = SCHEMA_VERSION;
      state.rev = uid();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      knownRev = state.rev;
      dirty = false;
      lastSavedAt = Date.now();
      if (saveFailed) { saveFailed = false; showSaveError(null); }
      return true;
    } catch (e) {
      saveFailed = true;
      showSaveError(e);
      return false;
    } finally {
      updateSaveState();
      if (pulled) refreshViewSoon();
    }
  }

  /** 화면을 떠나거나 앱을 내릴 때: 바뀐 것이 있을 때만 저장 */
  function flushIfDirty() { if (dirty) saveNow(); }

  /** 새 state 후보를 저장소에 먼저 써 본다. 성공해야 true (메모리의 state 는 바꾸지 않음) */
  function tryWriteState(candidate) {
    try {
      candidate.version = SCHEMA_VERSION;
      candidate.rev = uid();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      knownRev = candidate.rev;
      return true;
    } catch (e) {
      showSaveError(e);
      return false;
    }
  }

  function showSaveError(err) {
    var el = $('#save-error');
    if (!el) return;
    if (!err) { el.hidden = true; el.textContent = ''; return; }
    var name = err && err.name;
    var quota = name === 'QuotaExceededError' || err.code === 22 || err.code === 1014;
    var blocked = loadProblem === 'blocked' || name === 'SecurityError';
    el.textContent = quota
      ? '저장 공간이 부족해 방금 입력한 내용을 저장하지 못했어요. 설정에서 백업한 뒤 필요 없는 매물이나 사진을 지워 주세요.'
      : blocked
        ? '이 기기에서 기록을 저장할 수 없어요. iPhone 설정 → Safari → "모든 쿠키 차단"이 켜져 있으면 꺼 주세요. 지금 입력한 내용은 이 화면을 닫으면 사라져요.'
        : '기록을 저장하지 못했어요. 다음 입력 때 다시 저장해 볼게요. 계속 이 안내가 보이면 설정에서 백업해 두세요. 이 화면을 닫으면 방금 입력한 내용이 사라질 수 있어요.';
    el.hidden = false;
  }

  /** 상세 화면의 '자동 저장됨' 표시 */
  function updateSaveState() {
    var el = document.getElementById('save-state');
    if (!el) return;
    var t = lastSavedAt ? new Date(lastSavedAt) : null;
    el.textContent = saveFailed ? '저장 안 됨 · 화면 위 빨간 안내를 확인하세요'
      : dirty ? '저장 중…'
        : t ? '자동 저장됨 · ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes())
          : '입력하면 바로 자동 저장돼요';
    el.classList.toggle('is-error', saveFailed);
  }

  /**
   * 매물이 바뀌었음을 표시하고 자동 저장(디바운스). now: 같은 변경의 다른 시각(t, fieldsAt 등)과 맞출 때.
   * updatedAt 은 줄지 않는다(stampAfter): 지운 시각·다른 기기의 시각과 비교하는 값이라 늘 가장 나중 변경 이상이어야 한다
   */
  function touch(prop, now) {
    prop.updatedAt = stampAfter(now || Date.now(), prop.updatedAt);
    scheduleSave();
  }

  /** 진행 상태(와 탈락 사유)를 바꾼다. reason 이 undefined 면 탈락 사유는 그대로 */
  function setPropStatus(prop, status, reason) {
    var now = stampAfter(Date.now(), prop.statusAt, prop.legacyAt);
    prop.status = status;
    if (reason !== undefined) prop.dropReason = reason;
    prop.statusAt = now; // 두 기기 합치기: 상태는 더 나중에 바꾼 쪽
    touch(prop, now);
  }

  function findProp(id) {
    for (var i = 0; i < state.properties.length; i++) if (state.properties[i].id === id) return state.properties[i];
    return null;
  }

  function getItemState(prop, itemId) {
    return Object.prototype.hasOwnProperty.call(prop.items, itemId) ? prop.items[itemId] : {};
  }

  /** 지운 매물의 중복 판단 열쇠를 남긴다(가져오기 코드에서 "전에 지운 매물이에요" 표시용) */
  function rememberGone(prop, when) {
    if (!IMP) return;
    var k = IMP.goneKey(prop); // 'g:' + [매물번호, 링크, 단지명 조합, 층] (단계별로 비교하려고 한 열쇠에 담음)
    if (k && !BAD_KEYS[k]) state.goneKeys[k] = when;
    var keys = Object.keys(state.goneKeys);
    if (keys.length > GONE_KEYS_MAX) { // 오래된 것부터 버린다
      keys.sort(function (a, b) { return state.goneKeys[b] - state.goneKeys[a]; });
      keys.slice(GONE_KEYS_MAX).forEach(function (k) { delete state.goneKeys[k]; });
    }
  }

  /**
   * 항목 상태를 고친다. 바뀐 시각을 함께 남긴다: t(항목 전체), ft(고친 값마다).
   * 두 기기를 합칠 때 항목 안의 값마다 더 나중에 고친 쪽을 남기려고(merge.js editItem·mergeItem).
   * 값을 모두 지워도 항목을 없애지 않고 { t, ft } 만 남긴다. 그래야 다른 기기의 예전 값이 합칠 때 되살아나지 않는다.
   */
  function setItemState(prop, itemId, patch) {
    if (BAD_KEYS[itemId]) return;
    var cur = getItemState(prop, itemId);
    var next;
    if (MG) {
      // 새 시각은 그 항목의 지금 시각·legacyAt 보다 늘 나중(기기 시계가 늦어도 방금 고친 값이 이김)
      next = MG.editItem(cur, patch, Date.now(), prop.legacyAt);
    } else {
      // merge.js 를 못 불러왔을 때도 값별 시각(ft)은 버리지 않고 고친 값만 갱신한다(merge.js editItem 과 같은 뜻)
      var now = stampAfter(Date.now(), cur.t, prop.legacyAt);
      var ft = cur.ft && typeof cur.ft === 'object' ? Object.assign({}, cur.ft) : null;
      if (!ft) { // 예전 모양(ft 없음): 다른 값들은 그 항목의 t 에 바뀐 것으로
        ft = {};
        if (cur.t && cur.t !== prop.legacyAt) ITEM_VALUE_KEYS.forEach(function (k) { ft[k] = cur.t; });
      }
      next = {};
      ITEM_VALUE_KEYS.forEach(function (k) {
        var v = hasOwn(patch, k) ? patch[k] : cur[k];
        if (v !== '' && v !== false && v !== null && v !== undefined) next[k] = v;
        if (hasOwn(patch, k)) ft[k] = now;
      });
      next.t = now;
      next.ft = ft;
    }
    prop.items[itemId] = next;
    touch(prop, next.t);
  }

  // =====================================================
  // 5. 사진 저장소 (IndexedDB)
  //    레코드: { id, propertyId, itemId|null, sectionId|null, blob, createdAt }
  // =====================================================
  var Photos = (function () {
    var dbPromise = null;
    var currentDb = null;

    function forget() {
      // iOS 에서 앱을 오래 내려 두면 IndexedDB 연결이 끊길 수 있다 → 다음 요청 때 새로 연다
      if (currentDb) { try { currentDb.close(); } catch (e) { /* 무시 */ } }
      currentDb = null;
      dbPromise = null;
    }

    function isConnectionError(err) {
      if (!err) return false;
      return err.name === 'InvalidStateError' || err.name === 'UnknownError' ||
        /connection|closing|closed/i.test(String(err.message || ''));
    }

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('이 브라우저는 IndexedDB 를 지원하지 않아요')); return; }
        var req;
        try { req = indexedDB.open(PHOTO_DB_NAME, 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(PHOTO_STORE)) {
            var st = db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
            st.createIndex('propertyId', 'propertyId', { unique: false });
          }
        };
        req.onsuccess = function () {
          var db = req.result;
          currentDb = db;
          db.onversionchange = function () { forget(); };
          db.onclose = function () { if (currentDb === db) { currentDb = null; dbPromise = null; } };
          resolve(db);
        };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('사진 저장소가 다른 창에서 사용 중이에요')); };
      });
      dbPromise.catch(function () { dbPromise = null; });
      return dbPromise;
    }

    /** 트랜잭션 하나를 열어 fn(store, setResult) 을 실행하고, 완료되면 결과를 돌려준다 */
    function runOnce(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx;
          var store;
          try {
            tx = db.transaction(PHOTO_STORE, mode);
            store = tx.objectStore(PHOTO_STORE);
          } catch (e) { reject(e); return; }
          var result;
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error('사진 저장이 취소됐어요')); };
          try { fn(store, function (v) { result = v; }); } catch (e) { try { tx.abort(); } catch (_) { /* 무시 */ } reject(e); }
        });
      });
    }

    /** 연결이 끊겨 실패하면 연결을 새로 열어 한 번 더 시도한다 */
    function run(mode, fn) {
      return runOnce(mode, fn).catch(function (err) {
        if (!isConnectionError(err)) throw err;
        forget();
        return runOnce(mode, fn);
      });
    }

    function onResult(req, set) { req.onsuccess = function () { set(req.result); }; }

    // 오래된 Safari 처럼 Blob 저장이 안 되면 ArrayBuffer 로 저장한 레코드를 다시 Blob 으로
    function fromStored(rec) {
      if (rec && !rec.blob && rec.data) rec.blob = new Blob([rec.data], { type: rec.type || 'image/jpeg' });
      return rec;
    }

    return {
      /** 사진 저장소를 쓸 수 있는지 (파일로 열었거나 막혀 있으면 false) */
      probe: function () {
        return open().then(function () { return true; }, function () { return false; });
      },
      put: function (rec) {
        return run('readwrite', function (st) { st.put(rec); }).catch(function (err) {
          if (!rec.blob) throw err;
          // 오래된 Safari 처럼 Blob 을 그대로 저장하지 못하면(UnknownError 등) ArrayBuffer 로 바꿔 저장.
          // run() 이 끊긴 연결을 새로 열기 때문에 같은 끊긴 연결을 다시 쓰지 않는다.
          console.warn('사진 Blob 저장 실패, 다른 방식으로 다시 시도', err);
          return blobToArrayBuffer(rec.blob).then(function (buf) {
            var alt = Object.assign({}, rec, { blob: null, data: buf, type: rec.blob.type || 'image/jpeg' });
            return run('readwrite', function (st) { st.put(alt); });
          });
        });
      },
      get: function (id) {
        return run('readonly', function (st, set) { onResult(st.get(id), set); }).then(function (r) { return r ? fromStored(r) : null; });
      },
      byProperty: function (pid) {
        return run('readonly', function (st, set) { onResult(st.index('propertyId').getAll(pid), set); })
          .then(function (list) { return (list || []).map(fromStored); });
      },
      all: function () {
        return run('readonly', function (st, set) { onResult(st.getAll(), set); })
          .then(function (list) { return (list || []).map(fromStored); });
      },
      count: function () {
        return run('readonly', function (st, set) { onResult(st.count(), set); });
      },
      remove: function (id) {
        return run('readwrite', function (st) { st.delete(id); });
      },
      removeByProperty: function (pid) {
        return run('readwrite', function (st) {
          var req = st.index('propertyId').openCursor(pid);
          req.onsuccess = function () {
            var c = req.result;
            if (c) { c.delete(); c.continue(); }
          };
        });
      },
      clear: function () {
        return run('readwrite', function (st) { st.clear(); });
      }
    };
  })();

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('사진을 읽을 수 없어요')); };
      img.src = src;
    });
  }

  /** 사진을 긴 변 1600px JPEG(품질 0.8)로 줄인다. (iOS Safari 는 사진 방향(EXIF)을 자동으로 맞춰 그림) */
  function resizeImage(file) {
    var url = URL.createObjectURL(file);
    return loadImage(url).then(function (img) {
      var w = img.naturalWidth || img.width;
      var hgt = img.naturalHeight || img.height;
      if (!w || !hgt) throw new Error('사진 크기를 알 수 없어요');
      var scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, hgt));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(hgt * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          canvas.width = 0; canvas.height = 0; // iOS 캔버스 메모리 바로 해제
          if (blob) resolve(blob); else reject(new Error('사진을 줄이지 못했어요'));
        }, 'image/jpeg', PHOTO_QUALITY);
      });
    }).then(function (blob) {
      URL.revokeObjectURL(url);
      return blob;
    }, function (err) {
      URL.revokeObjectURL(url);
      var e = err instanceof Error ? err : new Error(String(err));
      e.stage = 'decode'; // 사진을 읽거나 줄이는 단계에서 실패(HEIC 원본 등)
      throw e;
    });
  }

  // 화면에 띄운 사진의 임시 주소(object URL) 관리
  var photoUrls = {};
  function photoUrl(rec) {
    if (!photoUrls[rec.id]) photoUrls[rec.id] = URL.createObjectURL(rec.blob);
    return photoUrls[rec.id];
  }
  function revokePhotoUrl(id) {
    if (photoUrls[id]) { URL.revokeObjectURL(photoUrls[id]); delete photoUrls[id]; }
  }
  function revokeAllPhotoUrls() { Object.keys(photoUrls).forEach(revokePhotoUrl); }
  function photoKey(rec) { return rec.itemId ? 'i:' + rec.itemId : 's:' + (rec.sectionId || ''); }

  // =====================================================
  // 6. 계산
  // =====================================================
  function isItemDone(item, st) {
    switch (item.type) {
      case 'rate': return st.status === 'good' || st.status === 'caution';
      case 'flag': return st.status === 'yes' || st.status === 'no';
      case 'ask': return !!(st.answer && st.answer.trim()) || !!st.done;
      default: return !!st.done; // check, visit
    }
  }

  function progressOf(prop, items) {
    var done = 0;
    items.forEach(function (it) { if (isItemDone(it, getItemState(prop, it.id))) done++; });
    var total = items.length;
    return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
  }
  function sectionProgress(prop, sec) { return progressOf(prop, sec.items); }
  function allItems() {
    var list = [];
    CL.sections.forEach(function (s) { list = list.concat(s.items); });
    return list;
  }
  function overallProgress(prop) { return progressOf(prop, allItems()); }

  function isGateItem(it) {
    var s = CL.sectionById[it.sectionId];
    return !!(s && s.gate);
  }

  /**
   * 등기부(게이트) 섹션의 멈춤 신호 답변 상태.
   * 멈춤 신호가 없는 데이터라면, 게이트 항목을 하나라도 끝냈는지로 대신 판단한다.
   */
  function gateStopState(prop) {
    var stops = [];
    var any = false;
    gateSections().forEach(function (s) {
      s.items.forEach(function (it) {
        if (it.type === 'flag' && it.severity === 'stop') stops.push(it);
        if (isItemDone(it, getItemState(prop, it.id))) any = true;
      });
    });
    var yes = 0;
    var unanswered = 0;
    stops.forEach(function (it) {
      var st = getItemState(prop, it.id).status;
      if (st === 'yes') yes++;
      else if (st !== 'no') unanswered++;
    });
    if (!stops.length) unanswered = any || !gateSections().length ? 0 : 1;
    return { total: stops.length, yes: yes, unanswered: unanswered };
  }

  /** '있음'으로 표시한 위험 신호 (severity: 'stop' | 'caution') */
  function flagsYes(prop, severity) {
    return allItems().filter(function (it) {
      return it.type === 'flag' && it.severity === severity && getItemState(prop, it.id).status === 'yes';
    });
  }
  function rateCautions(prop) {
    return allItems().filter(function (it) {
      return it.type === 'rate' && getItemState(prop, it.id).status === 'caution';
    });
  }
  /** 주의 개수 = 현장 평가 '주의' + 등기부 '주의' 신호 */
  function cautionCount(prop) { return rateCautions(prop).length + flagsYes(prop, 'caution').length; }

  function registryResult(prop) {
    var gs = gateSections();
    if (!gs.length) return { code: 'none', label: '-' };
    var items = [];
    gs.forEach(function (s) { items = items.concat(s.items); });
    var prog = progressOf(prop, items);
    var stops = 0;
    var cautions = 0;
    items.forEach(function (it) {
      if (it.type !== 'flag' || getItemState(prop, it.id).status !== 'yes') return;
      if (it.severity === 'stop') stops++; else cautions++;
    });
    if (stops) return { code: 'stop', label: '멈춤 신호 ' + stops + '건' };
    if (prog.done === 0) return { code: 'todo', label: '아직 안 봄' };
    if (cautions) return { code: 'caution', label: '주의 ' + cautions + '건' + (prog.done < prog.total ? ' · 확인 중' : '') };
    if (prog.done < prog.total) return { code: 'progress', label: '확인 중 ' + prog.done + '/' + prog.total };
    return { code: 'ok', label: '체크 항목 이상 없음' };
  }

  function suggestedDropReason(prop) {
    var stops = flagsYes(prop, 'stop');
    if (!stops.length) return '';
    return '멈춤 신호: ' + stops.map(function (it) { return it.text; }).join(' / ');
  }

  /** 멈춤 신호가 임장 뒤(계약 단계)에 나왔는지: 그렇다면 '돈을 보내지 말고 멈추세요' */
  function stopIsLate(prop, stops) {
    if (prop.status === 'visited' || prop.status === 'contract') return true;
    return stops.some(function (it) { return !isGateItem(it); });
  }

  // =====================================================
  // 7. 공통 UI
  // =====================================================

  /**
   * DOM 요소 만들기. 문자열 자식은 텍스트 노드로 넣어 XSS 를 막는다.
   * props: class, text, on<event>, value/checked/selected(속성 대신 프로퍼티), 그 밖은 setAttribute
   */
  function h(tag, props) {
    var el = document.createElement(tag);
    var deferred = null;
    if (props) {
      Object.keys(props).forEach(function (key) {
        var val = props[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class') el.className = val;
        else if (key === 'text') el.textContent = val;
        else if (key === 'value' || key === 'checked' || key === 'selected') (deferred || (deferred = {}))[key] = val;
        else if (key.slice(0, 2) === 'on' && typeof val === 'function') el.addEventListener(key.slice(2), val);
        else el.setAttribute(key, val === true ? '' : String(val));
      });
    }
    for (var i = 2; i < arguments.length; i++) appendKid(el, arguments[i]);
    if (deferred) Object.keys(deferred).forEach(function (k) { el[k] = deferred[k]; });
    return el;
  }
  function appendKid(el, c) {
    if (c === null || c === undefined || c === false || c === '') return;
    if (Array.isArray(c)) { c.forEach(function (x) { appendKid(el, x); }); return; }
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }

  function icon(name, cls) {
    var span = document.createElement('span');
    span.className = 'ic' + (cls ? ' ' + cls : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + (ICONS[name] || '') + '</svg>';
    return span;
  }

  function statusChip(status) {
    return h('span', { class: 'chip chip-' + status, text: STATUS_LABEL[status] || status });
  }

  /** 진행 막대. set(pct, label) 로 갱신 */
  function makeBar(pct, label, opts) {
    opts = opts || {};
    var fill = h('i');
    var bar = h('span', {
      class: 'bar' + (opts.thin ? ' is-thin' : ''),
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-label': opts.ariaLabel || '진행률'
    }, fill);
    var lab = label !== null && label !== undefined ? h('span', { class: 'bar-label' }) : null;
    var el = lab ? h('span', { class: 'bar-wrap' }, bar, lab) : bar;
    function set(p, l) {
      fill.style.width = p + '%';
      bar.setAttribute('aria-valuenow', String(p));
      if (lab && l !== undefined && l !== null) lab.textContent = l;
    }
    set(pct, label);
    return { el: el, set: set };
  }

  // ---- 토스트 ----
  var toastTimer = null;
  /** opts: { action: { label, fn }, duration(ms, 0 이면 직접 닫을 때까지) } */
  function toast(msg, opts) {
    opts = opts || {};
    var el = $('#toast');
    if (!el) return;
    el.textContent = '';
    el.append(h('span', { text: msg }));
    if (opts.action) {
      el.append(h('button', {
        type: 'button', class: 'toast-btn',
        onclick: function () { hideToast(); opts.action.fn(); }
      }, opts.action.label));
    }
    // 버튼이 없는 토스트는 터치를 막지 않는다(아래쪽 항목을 가리지 않게)
    el.classList.toggle('has-action', !!opts.action);
    el.classList.add('show');
    clearTimeout(toastTimer);
    if (opts.duration !== 0) toastTimer = setTimeout(hideToast, opts.duration || 2800);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    var el = $('#toast');
    if (el) el.classList.remove('show', 'has-action');
  }

  // ---- 대화상자 ----
  var openDialogs = [];

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.offsetParent !== null; }
    );
  }
  function trapTab(e, root) {
    var list = focusables(root);
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /**
   * 하단 시트 형태의 대화상자. 결과: Promise<{ value, text }>
   * opts: { title, message, content(Node), input: { placeholder, value, label, match, multiline },
   *         buttons: [{ label, value, kind: 'primary'|'danger'|'danger-ghost'|'secondary'|'accent', needsMatch, action, keepOpen }] }
   *   'danger-ghost' 은 위험하지만 주 버튼이 아닌 동작(테두리만 빨강). 첫 초점은 'danger' 일 때만 취소로 간다
   */
  function openDialog(opts) {
    return new Promise(function (resolve) {
      var root = $('#overlay-root');
      var prevFocus = document.activeElement;
      var titleId = 'dlg-' + uid();
      var msgId = titleId + '-msg';
      var inputEl = null;
      var actions = h('div', { class: 'modal-actions' });
      // 설명: 메시지와 내용(content) 모두. 내용만 있는 대화상자(합치기 결과 등)도 VoiceOver 가 열 때 읽게
      if (opts.content && !opts.content.id) opts.content.id = titleId + '-body';
      var describedBy = [opts.message ? msgId : '', opts.content ? opts.content.id : ''].filter(Boolean).join(' ');
      var card = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': describedBy || null },
        h('h2', { class: 'modal-title', id: titleId, text: opts.title }),
        opts.message ? h('p', { class: 'modal-msg', id: msgId, text: opts.message }) : null,
        opts.content || null
      );
      if (opts.input) {
        var multi = !!opts.input.multiline;
        inputEl = h(multi ? 'textarea' : 'input', {
          class: 'input',
          type: multi ? null : 'text',
          rows: multi ? 3 : null,
          placeholder: opts.input.placeholder || '',
          'aria-label': opts.input.label || opts.title,
          value: opts.input.value || '',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: 'false'
        });
        card.append(inputEl);
      }
      card.append(actions);
      var overlay = h('div', { class: 'modal-overlay' }, card);
      var done = false;

      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        openDialogs = openDialogs.filter(function (f) { return f !== cancel; });
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
          try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
        }
        resolve({ value: value, text: inputEl ? inputEl.value : '' });
      }
      function cancel() { finish(null); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Tab') trapTab(e, card);
      }

      var matchBtns = [];
      (opts.buttons || []).forEach(function (b) {
        var cls = { danger: 'btn-danger', 'danger-ghost': 'btn-danger-ghost', secondary: 'btn-ghost', accent: 'btn-accent' }[b.kind] || '';
        var btn = h('button', { type: 'button', class: 'btn btn-block ' + cls }, b.label);
        btn.addEventListener('click', function () {
          if (b.action) b.action(); // 공유·복사처럼 사용자 동작 안에서 바로 실행해야 하는 일
          if (!b.keepOpen) finish(b.value === undefined ? true : b.value);
        });
        if (b.needsMatch) { btn.disabled = true; matchBtns.push(btn); }
        actions.append(btn);
      });
      if (inputEl && opts.input.match) {
        inputEl.addEventListener('input', function () {
          var ok = inputEl.value.trim() === opts.input.match;
          matchBtns.forEach(function (b) { b.disabled = !ok; });
        });
      }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) cancel(); });
      document.addEventListener('keydown', onKey, true);
      openDialogs.push(cancel);
      root.append(overlay);
      // 지우기 같은 위험한 대화상자는 실수로 Enter 를 눌러도 안전하도록 '취소'에 먼저 초점
      var hasDanger = (opts.buttons || []).some(function (b) { return b.kind === 'danger'; });
      setTimeout(function () {
        var target = inputEl ||
          (hasDanger ? actions.querySelector('.btn-ghost:not([disabled])') : null) ||
          actions.querySelector('button:not([disabled])');
        if (target) try { target.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
      }, 40);
    });
  }

  function confirmDialog(o) {
    return openDialog({
      title: o.title,
      message: o.message,
      input: o.match ? { placeholder: o.match, label: '확인하려면 "' + o.match + '" 를 입력하세요', match: o.match } : null,
      buttons: [
        { label: o.confirmText || '확인', value: true, kind: o.danger ? 'danger' : 'primary', needsMatch: !!o.match },
        { label: o.cancelText || '취소', value: false, kind: 'secondary' }
      ]
    }).then(function (r) { return r.value === true; });
  }

  function alertDialog(title, message) {
    return openDialog({ title: title, message: message, buttons: [{ label: '확인', value: true }] });
  }

  function closeAllDialogs() { openDialogs.slice().forEach(function (c) { c(); }); }

  // ---- 사진 크게 보기 ----
  var closeLightbox = null;

  function openLightbox(rec, caption, onDeleted) {
    if (closeLightbox) closeLightbox();
    var prevFocus = document.activeElement;
    var closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '사진 닫기' }, icon('close'));
    var delBtn = h('button', { type: 'button', class: 'btn btn-small lb-del', 'aria-label': '이 사진 지우기' }, icon('trash', 'ic-sm'), '사진 지우기');
    var lb = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '사진 크게 보기' },
      h('div', { class: 'lb-bar' },
        closeBtn,
        h('p', { class: 'lb-caption', text: caption || '' }),
        h('span', { style: 'width:44px;flex:none', 'aria-hidden': 'true' })
      ),
      h('div', { class: 'lb-img' }, h('img', { src: photoUrl(rec), alt: caption ? caption + ' — 첨부 사진' : '첨부 사진' })),
      h('div', { class: 'lb-foot' },
        h('p', { class: 'small', style: 'align-self:center;opacity:.8', text: formatDateTime(rec.createdAt) }),
        delBtn
      )
    );
    function onKey(e) {
      if (e.key === 'Escape' && !openDialogs.length) close();
      else if (e.key === 'Tab') trapTab(e, lb);
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      lb.remove();
      closeLightbox = null;
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
        try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
      }
    }
    closeBtn.addEventListener('click', close);
    delBtn.addEventListener('click', function () {
      confirmDialog({ title: '이 사진을 지울까요?', message: '지운 사진은 되돌릴 수 없어요.', confirmText: '지우기', danger: true })
        .then(function (ok) {
          if (!ok) return;
          return Photos.remove(rec.id).then(function () {
            close();
            revokePhotoUrl(rec.id);
            if (onDeleted) onDeleted(rec);
            toast('사진을 지웠어요');
          });
        })
        .catch(function () { toast('사진을 지우지 못했어요'); });
    });
    document.addEventListener('keydown', onKey, true);
    $('#overlay-root').append(lb);
    closeLightbox = close;
    setTimeout(function () { closeBtn.focus(); }, 30);
  }

  // =====================================================
  // 8. 화면
  // =====================================================

  // 현재 화면의 상태와 갱신용 참조
  var view = { name: '', prop: null, refs: {}, photos: null };

  function newView(name, prop) {
    view = { name: name, prop: prop || null, refs: { secs: {}, chips: {}, hints: [], strips: {} }, photos: null, photosReady: null };
    return view;
  }

  function resetMain() {
    var m = $('#main');
    m.textContent = '';
    return m;
  }

  /** 상단 바 제목 아래 앱 버전. 새 버전을 받아 두었으면 누르면 바로 적용되는 [업데이트] 버튼으로 바뀐다 */
  function versionBadge() {
    if (SW.updateReady) {
      return h('button', {
        type: 'button', class: 'tb-ver tb-ver-update', 'aria-label': '새 버전이 준비됐어요. 눌러서 새로고침',
        onclick: reloadForUpdate
      }, '업데이트');
    }
    return h('span', { class: 'tb-ver', 'aria-label': '앱 버전 ' + APP_VERSION, text: 'v' + APP_VERSION });
  }

  function refreshVersionBadge() {
    var old = document.querySelector('#topbar .tb-ver');
    if (old) old.replaceWith(versionBadge());
  }

  function setTopbar(o) {
    var bar = $('#topbar');
    bar.textContent = '';
    var left = h('div', { class: 'tb-left' });
    if (o.back) {
      left.append(h('button', { type: 'button', class: 'tb-btn', 'aria-label': '뒤로 가기', onclick: function () { goBack(o.back); } },
        icon('back'), h('span', { text: '뒤로' })));
    }
    // tabindex=-1: 화면이 바뀌면 이 제목으로 초점을 옮겨 VoiceOver 가 새 화면 이름을 읽게 한다
    bar.append(left, h('div', { class: 'tb-center' },
      h('h1', { class: 'tb-title', id: 'tb-title', tabindex: '-1', text: o.title }),
      versionBadge()
    ), h('div', { class: 'tb-right' }, o.actions || []));
    document.title = o.title && o.title !== '임장 체크리스트' ? o.title + ' · 임장체크' : '임장 체크리스트';
  }

  function dataWarning() {
    if (CL.ok) return null;
    return h('div', { class: 'notice', role: 'alert' },
      h('strong', { text: '체크리스트 내용(data.js)을 불러오지 못했어요.' }),
      h('p', { text: 'data.js 파일이 index.html 과 같은 폴더에 있는지 확인해 주세요. 매물 정보 입력과 백업은 그대로 쓸 수 있어요.' })
    );
  }

  function flowList() {
    return h('ol', { class: 'flow', role: 'list' }, FLOW_STEPS.map(function (s, i) {
      return h('li', { class: s.key ? 'is-key' : null },
        h('span', { class: 'flow-num', 'aria-hidden': 'true', text: String(i + 1) }),
        h('p', { class: 'flow-step-title' },
          h('span', { class: 'sr-only', text: (i + 1) + '단계, ' }),
          s.title,
          s.key ? h('span', { class: 'flow-key-note', text: '문제 있으면 여기서 탈락' }) : null),
        h('p', { class: 'flow-step-desc', text: s.desc })
      );
    }));
  }

  /** 카카오톡 등 앱 안 브라우저 경고 (홈 화면 추가 메뉴가 없고 기록이 쉽게 지워짐) */
  function inAppWarning() {
    var app = inAppBrowser();
    if (!app) return null;
    return h('div', { class: 'notice notice-stop', role: 'alert' },
      h('strong', { text: app + ' 안에서 열었어요. Safari로 열어 주세요' }),
      h('p', { text: '여기서 입력한 기록은 앱을 닫거나 정리할 때 사라질 수 있어요. 화면의 ⋯(또는 공유) 메뉴에서 "Safari로 열기"(또는 "다른 브라우저로 열기")를 누른 뒤 사용하세요.' })
    );
  }

  function installTip() {
    if (!isIOS() || isStandalone() || inAppBrowser() || state.ui.dismissedInstallTip) return null;
    var hasData = state.properties.length > 0;
    var card = h('div', { class: 'tip-card', role: 'note' },
      h('div', { class: 'tip-body' },
        h('strong', { text: '홈 화면에 추가해서 쓰세요' }),
        h('p', { text: INSTALL_TIP }),
        hasData ? h('p', { class: 'tip-move', text: INSTALL_TIP_MOVE }) : null,
        hasData ? h('a', { class: 'btn btn-small btn-secondary', href: '#/settings', style: 'margin-top:8px' }, '지금 백업하기') : null
      ),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': '홈 화면 추가 안내 닫기',
        onclick: function () {
          state.ui.dismissedInstallTip = true;
          saveNow();
          card.remove();
        }
      }, icon('close'))
    );
    return card;
  }

  // ---------------- 홈: 매물 목록 ----------------
  function propertyCard(p) {
    var prog = overallProgress(p);
    var cautions = cautionCount(p);
    var reg = registryResult(p);
    var dropped = p.status === 'dropped';
    var stopList = flagsYes(p, 'stop');
    var stops = stopList.length;
    var diff = diffPercent(p.askPrice, p.realPrice);
    var unit = unitText(p);
    return h('a', {
      class: 'pcard' + (dropped ? ' is-dropped' : '') + (stops && !dropped ? ' has-stop' : ''),
      href: '#/p/' + encodeURIComponent(p.id)
    },
      h('div', { class: 'pcard-top' },
        h('div', {},
          h('strong', { class: 'pcard-name', text: p.name }),
          (unit || p.area) ? h('span', { class: 'pcard-unit', text: [unit, p.area ? '전용 ' + p.area + '㎡' : ''].filter(Boolean).join(' · ') }) : null
        ),
        statusChip(p.status)
      ),
      h('p', { class: 'pcard-price' },
        p.askPrice ? '호가 ' + formatManwon(p.askPrice) : '호가 입력 안 함',
        diff !== null ? h('span', { class: 'pcard-diff', text: ' · 실거래 대비 ' + pctText(diff) }) : null
      ),
      makeBar(prog.pct, '진행 ' + prog.pct + '%', { ariaLabel: '체크리스트 진행률' }).el,
      h('div', { class: 'pcard-meta' },
        // 호수가 없으면 등기부를 열람할 수 없다(가져오기 코드로 만든 매물은 늘 비어 있음)
        !p.ho && !dropped ? h('span', { class: 'meta-chip need-ho', text: '호수 입력 필요' }) : null,
        h('span', { class: 'meta-chip reg-' + reg.code, text: '등기부: ' + reg.label }),
        cautions ? h('span', { class: 'meta-chip warn', text: '주의 ' + cautions + '개' }) : h('span', { class: 'meta-chip', text: '주의 0개' }),
        stops && !dropped ? h('span', { class: 'meta-chip reg-stop', text: stopIsLate(p, stopList) ? '진행 멈춤' : '임장 불필요' }) : null
      ),
      dropped ? h('p', { class: 'pcard-drop', text: '탈락' + (p.dropReason ? ' · ' + p.dropReason : '') }) : null
    );
  }

  function renderHome() {
    newView('home');
    setTopbar({
      title: '임장 체크리스트',
      actions: [h('a', { class: 'tb-btn', href: '#/new', 'aria-label': '매물 추가' }, icon('plus'))]
    });
    updateTabbar('home');
    var main = resetMain();
    appendKid(main, dataWarning());
    appendKid(main, inAppWarning());
    appendKid(main, installTip());
    appendKid(main, draftCard());

    var props = state.properties.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

    if (!props.length) {
      // 홈 화면 앱을 처음 열면 Safari 와 저장 공간이 따로라서 비어 보인다 → 불러오기 안내
      if (isStandalone()) {
        main.append(h('div', { class: 'tip-card', role: 'note' },
          h('div', { class: 'tip-body' },
            h('strong', { text: 'Safari에서 쓰던 기록이 있나요?' }),
            h('p', { text: '홈 화면 앱은 Safari와 저장 공간이 따로라서 처음에는 비어 있어요. Safari에서 설정 → 백업 파일 만들기를 한 뒤, 여기서 불러오면 그대로 이어서 쓸 수 있어요.' }),
            h('a', { class: 'btn btn-small btn-secondary', href: '#/settings', style: 'margin-top:8px' }, '백업 불러오기')
          )));
      }
      main.append(h('section', { class: 'card flow-card', 'aria-labelledby': 'flow-title' },
        h('h2', { class: 'flow-title', id: 'flow-title', text: '처음이라면 이 순서대로' }),
        h('p', { class: 'flow-sub', text: '집을 보러 가기 전에 등기부등본부터 봐요. 문제가 있는 집은 보러 갈 필요가 없어요.' }),
        flowList(),
        h('a', { class: 'btn btn-accent btn-block flow-cta', href: '#/new' }, icon('plus'), '첫 매물 추가하기'),
        h('a', { class: 'btn btn-secondary btn-block', href: '#/import' }, icon('paste'), '코드로 추가'),
        h('p', { class: 'muted small', style: 'text-align:center', text: '중개사에게 동·호수를 받았다면 매물을 추가하고 등기부 체크부터 시작하세요.' }),
        h('p', { class: 'muted small', style: 'text-align:center', text: '네이버 부동산 매물은 화면을 Claude에게 보내고, 받은 코드로 한 번에 추가할 수 있어요.' })
      ));
      return;
    }

    var active = props.filter(function (p) { return p.status !== 'dropped'; });
    var dropped = props.filter(function (p) { return p.status === 'dropped'; });

    main.append(h('h2', { class: 'h2', style: 'margin-top:4px' }, '내 매물', h('span', { class: 'count', text: active.length + '개' })));
    if (active.length) {
      main.append(h('div', { class: 'plist' }, active.map(propertyCard)));
    } else {
      main.append(h('p', { class: 'muted', text: '검토 중인 매물이 없어요.' }));
    }
    main.append(h('div', { class: 'btn-row add-row' },
      h('a', { class: 'btn btn-accent', href: '#/new' }, icon('plus'), '매물 추가'),
      h('a', { class: 'btn btn-secondary', href: '#/import' }, icon('paste'), '코드로 추가')
    ));

    if (dropped.length) {
      main.append(h('h2', { class: 'h2' }, '탈락한 매물', h('span', { class: 'count', text: dropped.length + '개' })));
      main.append(h('div', { class: 'plist' }, dropped.map(propertyCard)));
    }

    main.append(h('details', { class: 'flow-details card' },
      h('summary', {}, '올바른 순서 다시 보기'),
      flowList()
    ));
  }

  // ---------------- 매물 추가·수정 폼 ----------------
  // 새 매물 폼은 제출 전까지 매물이 없으므로, 입력을 임시 저장(DRAFT_KEY)해 둔다.
  // 전화 걸기·실거래가 찾기로 다른 앱에 다녀오는 사이 iOS 가 앱을 내려도 입력이 남는다.
  var DRAFT_FIELDS = ['name', 'dong', 'ho', 'area', 'floor', 'direction', 'ask', 'real', 'agentName', 'agentPhone', 'sourceUrl', 'memo', 'dropReason'];
  var pendingFocus = null; // 다음에 그릴 수정 폼에서 초점을 줄 칸('ho'). 가져오기 직후·상세의 [입력하기]

  /** 폼의 링크 칸: 앞에 http(s):// 가 없으면 붙여 보고, http/https 주소만 받는다 */
  function formUrl(text) {
    var t = str(text).trim();
    if (!t) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[^\s/]+\.[^\s]+/.test(t)) t = 'https://' + t;
    return httpUrlOrEmpty(t);
  }

  function readDraft() {
    var raw = localGet(DRAFT_KEY);
    var d = raw ? parseStored(raw) : null;
    if (!d) return null;
    var out = { status: STATUS_LABEL[d.status] ? d.status : 'review', savedAt: numOrNull(d.savedAt) };
    DRAFT_FIELDS.forEach(function (k) { out[k] = str(d[k]); });
    return out;
  }
  function draftHasContent(d) {
    return !!d && DRAFT_FIELDS.some(function (k) { return d[k] && String(d[k]).trim(); });
  }
  function writeDraft(d) {
    if (draftHasContent(d)) localSet(DRAFT_KEY, JSON.stringify(d));
    else localRemove(DRAFT_KEY);
  }

  /** 홈: 작성 중이던 새 매물이 있으면 이어서 쓰기 안내 */
  function draftCard() {
    var d = readDraft();
    if (!draftHasContent(d)) return null;
    var card = h('div', { class: 'tip-card', role: 'note' },
      h('div', { class: 'tip-body' },
        h('strong', { text: '작성 중이던 매물이 있어요' }),
        h('p', { text: (d.name || '단지명 없음') + (d.savedAt ? ' · ' + formatDateTime(d.savedAt) + '에 임시 저장' : '') }),
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          h('a', { class: 'btn btn-small btn-secondary', href: '#/new' }, '이어서 쓰기'),
          h('button', {
            type: 'button', class: 'btn btn-small btn-ghost',
            onclick: function () { localRemove(DRAFT_KEY); card.remove(); toast('임시 저장한 내용을 지웠어요'); }
          }, '버리기'))
      ));
    return card;
  }

  function renderForm(id) {
    var editing = id ? findProp(id) : null;
    if (id && !editing) return renderNotFound();
    newView('form', editing);
    setTopbar({ title: editing ? '매물 정보 수정' : '매물 추가', back: editing ? '/p/' + id : '/' });
    updateTabbar('home');
    var main = resetMain();
    var draft = editing ? null : readDraft();
    var restored = !editing && draftHasContent(draft);
    var src = editing || (restored ? {
      name: draft.name, dong: draft.dong, ho: draft.ho, area: draft.area, floor: draft.floor, direction: draft.direction,
      askPrice: draft.ask, realPrice: draft.real, agentName: draft.agentName, agentPhone: draft.agentPhone,
      sourceUrl: draft.sourceUrl, memo: draft.memo, status: draft.status, dropReason: draft.dropReason
    } : { status: 'review' });
    // 호수 칸 강조: 가져오기 코드로 만든 매물(호수가 늘 비어 있음)이거나 [입력하기]로 들어왔을 때
    var focusHo = !!editing && pendingFocus === 'ho';
    pendingFocus = null;
    var needHo = !!editing && !editing.ho && (!!editing.importedAt || focusHo);

    function field(labelText, inputEl, opts) {
      opts = opts || {};
      return h('div', { class: 'field' },
        h('label', { for: inputEl.id }, labelText, opts.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null),
        opts.unit ? h('div', { class: 'input-unit' }, inputEl, h('span', { class: 'unit', 'aria-hidden': 'true', text: opts.unit })) : inputEl,
        opts.live || null,
        opts.error || null,
        opts.hint ? h('p', { class: 'field-hint', id: inputEl.id + '-hint', text: opts.hint }) : null
      );
    }
    function val(v) { return v !== null && v !== undefined ? String(v) : ''; }

    var f = {};
    f.name = h('input', { class: 'input', id: 'f-name', type: 'text', value: val(src.name), placeholder: '예: 행복마을 1단지', autocomplete: 'off', enterkeyhint: 'next', required: true, 'aria-required': 'true', 'aria-describedby': 'f-name-err', maxlength: 80 });
    f.dong = h('input', { class: 'input', id: 'f-dong', type: 'text', value: val(src.dong), placeholder: '예: 101', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20 });
    f.ho = h('input', { class: 'input', id: 'f-ho', type: 'text', value: val(src.ho), placeholder: '예: 1203', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20, 'aria-describedby': needHo ? 'f-ho-need' : null });
    f.area = h('input', { class: 'input', id: 'f-area', type: 'text', inputmode: 'decimal', enterkeyhint: 'next', value: val(src.area), placeholder: '예: 84.97', autocomplete: 'off', 'aria-describedby': 'f-area-hint' });
    f.floor = h('input', { class: 'input', id: 'f-floor', type: 'text', value: val(src.floor), placeholder: '예: 12/25', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20, 'aria-describedby': 'f-floor-hint' });
    f.direction = h('input', { class: 'input', id: 'f-dir', type: 'text', value: val(src.direction), placeholder: '예: 남향', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20 });
    f.ask = h('input', { class: 'input', id: 'f-ask', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'next', value: val(src.askPrice), placeholder: '예: 85000', autocomplete: 'off', 'aria-describedby': 'f-ask-live f-ask-hint' });
    f.real = h('input', { class: 'input', id: 'f-real', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'next', value: val(src.realPrice), placeholder: '예: 82000', autocomplete: 'off', 'aria-describedby': 'f-real-live f-real-hint' });
    f.agentName = h('input', { class: 'input', id: 'f-agent', type: 'text', value: val(src.agentName), placeholder: '예: 행복공인중개사 김OO', autocomplete: 'off', enterkeyhint: 'next', maxlength: 60 });
    f.agentPhone = h('input', { class: 'input', id: 'f-phone', type: 'tel', inputmode: 'tel', enterkeyhint: 'next', value: val(src.agentPhone), placeholder: '예: 010-1234-5678', autocomplete: 'off', maxlength: 30 });
    f.sourceUrl = h('input', { class: 'input', id: 'f-url', type: 'url', inputmode: 'url', enterkeyhint: 'next', value: val(src.sourceUrl), placeholder: '예: https://new.land.naver.com/…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 2000, 'aria-describedby': 'f-url-err f-url-hint' });
    f.memo = h('textarea', { class: 'input', id: 'f-memo', rows: 3, value: val(src.memo), placeholder: '예: 남향, 2026년 12월 입주 가능하다고 함' });
    f.dropReason = h('textarea', { class: 'input', id: 'f-drop', rows: 2, value: val(src.dropReason), placeholder: '예: 등기부에 신탁 기록' });
    // Return(다음) 키를 눌렀을 때 옮겨 갈 순서
    var order = [f.name, f.dong, f.ho, f.area, f.floor, f.direction, f.ask, f.real, f.agentName, f.agentPhone, f.sourceUrl, f.memo];

    var nameErr = h('p', { class: 'field-error', id: 'f-name-err', hidden: true, text: '단지명을 입력해 주세요.' });
    var urlErr = h('p', { class: 'field-error', id: 'f-url-err', hidden: true, text: 'http:// 또는 https:// 로 시작하는 주소만 저장돼요.' });
    var hoBanner = needHo ? h('div', { class: 'notice notice-ho', role: 'note' },
      h('strong', { text: '호수만 입력하면 돼요' }),
      h('p', { id: 'f-ho-need', text: '등기부 열람에 꼭 필요해요. 네이버 부동산에는 호수가 없으니 중개사에게 받아 적어 주세요.' })) : null;
    var hoField = field('호', f.ho, { unit: '호' });
    var askLive = h('p', { class: 'field-live', id: 'f-ask-live', 'aria-live': 'polite' });
    var realLive = h('p', { class: 'field-live', id: 'f-real-live', 'aria-live': 'polite' });
    var diffBox = h('div', { class: 'diff-box', 'aria-live': 'polite' });
    var telLink = h('a', { class: 'btn btn-small btn-secondary', style: 'margin-top:8px', 'aria-label': '중개사에게 전화 걸기' }, icon('phone', 'ic-sm'), '전화 걸기');

    var statusSet = h('fieldset', { class: 'radio-chips' },
      h('legend', { text: '진행 상태' }),
      STATUSES.map(function (s) {
        return h('label', { class: 'radio-chip' },
          h('input', { type: 'radio', name: 'f-status', value: s.id, checked: (src.status || 'review') === s.id }),
          h('span', { text: s.label }));
      })
    );
    var statusWarn = h('p', { class: 'field-warn', role: 'note', hidden: true });
    var dropField = field('탈락 사유', f.dropReason, { hint: '나중에 비교할 때 왜 뺐는지 기억할 수 있어요.' });

    function currentStatus() {
      var c = statusSet.querySelector('input:checked');
      return c ? c.value : 'review';
    }

    function refreshLive() {
      var ask = parseIntInput(f.ask.value);
      var real = parseIntInput(f.real.value);
      askLive.textContent = ask ? '= ' + formatManwon(ask) : '';
      realLive.textContent = real ? '= ' + formatManwon(real) : '';
      diffBox.textContent = '';
      if (ask && real) {
        var p = diffPercent(ask, real);
        diffBox.append(h('strong', { class: p > 0 ? 'diff-up' : 'diff-down', text: '실거래 대비 ' + pctText(p) }), h('br'), diffSentence(ask, real));
        diffBox.hidden = false;
      } else {
        diffBox.append('호가와 최근 실거래가를 모두 넣으면 몇 % 차이 나는지 자동으로 보여 드려요.');
      }
      var href = telHref(f.agentPhone.value);
      telLink.hidden = !href;
      if (href) telLink.setAttribute('href', href);
      urlErr.hidden = !f.sourceUrl.value.trim() || !!formUrl(f.sourceUrl.value);
      f.sourceUrl.setAttribute('aria-invalid', urlErr.hidden ? 'false' : 'true');
      if (hoField) hoField.classList.toggle('need-ho', needHo && !f.ho.value.trim());
      if (hoBanner) hoBanner.hidden = !!f.ho.value.trim(); // 호수를 입력하면 '호수만 입력하면 돼요' 안내를 닫는다
      var st = currentStatus();
      dropField.hidden = st !== 'dropped';
      // 등기부 멈춤 신호를 다 확인하기 전에 임장 예정·완료·계약 검토로 바꾸면 알려 준다
      var gs = gateStopState(editing || { items: {} });
      var early = (st === 'planned' || st === 'visited' || st === 'contract') && gs.unanswered > 0;
      statusWarn.hidden = !early;
      if (early) statusWarn.textContent = '등기부 멈춤 신호 ' + gs.unanswered + '개를 아직 확인하지 않았어요. 신탁·가압류 같은 문제가 있으면 보러 갈 필요가 없으니, 저장한 뒤 등기부부터 확인하세요.';
    }

    function readForm() {
      return {
        name: f.name.value.trim(),
        dong: f.dong.value.trim(),
        ho: f.ho.value.trim(),
        area: parseDecimalInput(f.area.value),
        floor: f.floor.value.trim(),
        direction: f.direction.value.trim(),
        askPrice: parseIntInput(f.ask.value),
        realPrice: parseIntInput(f.real.value),
        agentName: f.agentName.value.trim(),
        agentPhone: f.agentPhone.value.trim(),
        sourceUrl: formUrl(f.sourceUrl.value), // 주소가 아니면 빈 값(아래에 안내)
        memo: f.memo.value,
        status: currentStatus(),
        dropReason: f.dropReason.value.trim() // 탈락이 아니어도 지우지 않고 보관
      };
    }

    function validateName(show) {
      var ok = !!f.name.value.trim();
      nameErr.hidden = ok || !show;
      f.name.setAttribute('aria-invalid', ok ? 'false' : 'true');
      return ok;
    }

    // 수정 화면: 입력 즉시 자동 저장 (단지명이 비면 이전 이름 유지)
    // 새 매물 화면: 입력을 임시 저장(앱이 내려가도 남음)
    function applyChange() {
      if (!editing) {
        writeDraft({
          name: f.name.value, dong: f.dong.value, ho: f.ho.value, area: f.area.value, floor: f.floor.value, direction: f.direction.value,
          ask: f.ask.value, real: f.real.value, agentName: f.agentName.value, agentPhone: f.agentPhone.value,
          sourceUrl: f.sourceUrl.value, memo: f.memo.value,
          status: currentStatus(), dropReason: f.dropReason.value, savedAt: Date.now()
        });
        return;
      }
      // 이 화면에서 실제로 고친 칸만 반영하고 바뀐 시각을 남긴다(두 기기 합치기: 필드마다 더 나중에 고친 쪽).
      // 폼을 연 사이 다른 탭이 고친 칸은 입력 칸에 예전 값이 남아 있어도 덮어쓰지 않는다.
      var v = readForm();
      var now = Date.now();
      var last = 0; // 이번에 찍은 가장 나중 시각
      Object.keys(v).forEach(function (k) {
        if (sameValue(formBase[k], v[k])) return; // 이 화면에서 손대지 않은 칸
        formBase[k] = v[k];
        if (k === 'name' && !v.name) return;     // 단지명이 비면 이전 이름 유지
        if (sameValue(editing[k], v[k])) return;
        editing[k] = v[k];
        // 새 시각은 그 칸의 지금 시각보다 늘 나중(기기 시계가 늦어도 방금 고친 칸이 이김)
        var t;
        if (k === 'status' || k === 'dropReason') t = editing.statusAt = stampAfter(now, editing.statusAt, editing.legacyAt);
        else t = editing.fieldsAt[k] = stampAfter(now, editing.fieldsAt[k], editing.legacyAt);
        if (t > last) last = t;
      });
      if (last) touch(editing, last); // input 뒤 change 처럼 같은 값이 다시 오면 고친 시각을 올리지 않는다
    }

    function submit() {
      if (!validateName(true)) { f.name.focus(); return; }
      if (editing) {
        applyChange();
        saveNow();
        goBack('/p/' + editing.id, true);
        return;
      }
      // fieldsAt: {} → 새 매물(예전 기록이 아님). 칸 시각은 만든 시각으로 채워진다
      var p = normalizeProperty(Object.assign({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), fieldsAt: {} }, readForm()));
      state.properties.unshift(p);
      dirty = true;
      saveNow();
      localRemove(DRAFT_KEY);
      toast('매물을 추가했어요. 등기부부터 확인하세요.');
      navigate('/p/' + p.id, true);
    }

    // 폼 안에 submit 버튼을 두지 않는다(type=button). 그래서 iPhone 키보드의 Return(다음) 키로
    // 폼이 제출되지 않고, 아래 keydown 처리로 다음 칸으로 넘어간다.
    var submitBtn = h('button', { type: 'button', class: 'btn btn-block', onclick: submit }, editing ? '완료' : '저장하고 체크 시작');
    var form = h('form', { class: 'form', novalidate: true, autocomplete: 'off' },
      restored ? h('div', { class: 'notice notice-info', role: 'status' },
        h('strong', { text: '작성 중이던 내용을 불러왔어요' }),
        h('p', { text: '입력은 저장 버튼을 누르기 전에도 이 기기에 임시로 보관돼요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-ghost', style: 'margin-top:8px',
          onclick: function () { localRemove(DRAFT_KEY); renderForm(null); }
        }, '비우고 새로 쓰기')) : null,
      hoBanner,
      field('단지명', f.name, { required: true, error: nameErr }),
      h('div', { class: 'field-row' }, field('동', f.dong, { unit: '동' }), hoField),
      field('전용면적', f.area, { unit: '㎡', hint: '실제로 쓰는 집 안 면적이에요. 등기부·건축물대장에 나오는 숫자를 적어요. 광고의 "34평"은 공용 면적까지 더한 숫자라 달라요. (예: 84.97)' }),
      h('div', { class: 'field-row' }, field('층', f.floor, { hint: '예: 12/25 (25층 중 12층)' }), field('방향', f.direction)),
      field('호가', f.ask, { unit: '만원', live: askLive, hint: '호가: 파는 사람이 부르는 가격. 만원 단위로 적어요. (8억 5천 → 85000)' }),
      field('최근 실거래가', f.real, { unit: '만원', live: realLive, hint: '실거래가: 실제로 거래돼 신고된 가격. 국토교통부 실거래가 공개시스템에서 같은 단지·비슷한 면적의 최근 거래를 찾아 적어요. 다른 앱에 다녀와도 입력은 남아 있어요.' }),
      diffBox,
      field('중개사 이름', f.agentName),
      h('div', { class: 'field' }, h('label', { for: f.agentPhone.id, text: '중개사 연락처' }), f.agentPhone, telLink),
      field('매물 링크', f.sourceUrl, { error: urlErr, hint: '네이버 부동산 등 매물 페이지 주소. 상세 화면에서 바로 열 수 있어요.' }),
      field('메모', f.memo),
      statusSet,
      statusWarn,
      dropField,
      h('div', { class: 'form-actions' },
        submitBtn,
        h('p', { class: 'muted small', style: 'text-align:center', text: editing ? '고친 내용은 바로 저장돼요.' : '저장하기 전 입력도 임시로 보관돼요.' })
      )
    );

    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (!t || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 조합만 끝낸다
      e.preventDefault();
      var i = order.indexOf(t);
      if (i >= 0 && i < order.length - 1) {
        try { order[i + 1].focus(); } catch (_) { /* 무시 */ }
      } else if (t.blur) {
        t.blur(); // 키보드 닫기
      }
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); }); // 혹시 모를 제출 막기
    var formBase = null; // 수정 화면: 이 화면이 마지막으로 반영한 값(applyChange 가 비교). 화면에 붙인 뒤 읽는다
    form.addEventListener('input', function (e) {
      if (e.target === f.name) validateName(!!editing || nameErr.hidden === false); // 수정 중에는 바로 알려 줌
      refreshLive();
      applyChange();
    });
    form.addEventListener('change', function () { refreshLive(); applyChange(); });

    main.append(dataWarning() || '', h('div', { class: 'card' }, form));
    if (editing) formBase = readForm();

    if (editing) {
      main.append(h('div', { class: 'danger-zone' },
        h('button', {
          type: 'button', class: 'btn btn-danger-ghost btn-block',
          onclick: function () { deleteProperty(editing); }
        }, icon('trash', 'ic-sm'), '이 매물 삭제')
      ));
    }
    refreshLive();
    if (!editing) setTimeout(function () { try { f.name.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }, 50);
    // 가져오기 직후(또는 상세의 [입력하기]): 호수 칸으로. navigateNow 로 클릭 처리 안에서 그려지므로
    // 여기서 바로 초점을 줘야 iOS 가 키보드를 띄운다(setTimeout 이나 hashchange 뒤에 주면 커서만 가거나 무시됨)
    if (focusHo) { try { f.ho.focus(); } catch (e) { /* 무시 */ } }
    return editing && !focusHo ? null : 'focused'; // 새 매물은 단지명, 호수 입력은 호수 칸에 초점을 주므로 제목으로 옮기지 않는다
  }

  function deleteProperty(prop) {
    confirmDialog({
      title: '이 매물을 삭제할까요?',
      message: '"' + prop.name + '"의 체크 기록과 사진이 모두 지워지고 되돌릴 수 없어요.',
      confirmText: '삭제',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.properties = state.properties.filter(function (p) { return p.id !== prop.id; });
      // 다른 탭·다른 기기에도 지운 것을 알린다. 이 매물의 마지막 변경(다른 기기에서 받은 것 포함)보다 늘 나중 시각
      state.deleted[prop.id] = stampAfter(Date.now(), prop.updatedAt);
      rememberGone(prop, state.deleted[prop.id]); // 같은 매물을 코드로 다시 가져오면 알려 주려고
      dirty = true;
      saveNow();
      // 사진 정리가 실패해도(연결 끊김 등) 다음에 앱을 열 때 지운 매물의 사진을 다시 정리한다(cleanDeletedPhotos)
      Photos.removeByProperty(prop.id).catch(function (err) { console.warn('사진 정리 실패(다음에 다시 시도)', err); });
      try { sessionStorage.removeItem('imjang.open.' + prop.id); } catch (e) { /* 무시 */ }
      toast('매물을 삭제했어요');
      navigate('/', true);
    });
  }

  // ---------------- 매물 상세 ----------------
  function renderDetail(id) {
    var prop = findProp(id);
    if (!prop) return renderNotFound();
    var v = newView('detail', prop);
    setTopbar({
      title: prop.name,
      back: '/',
      actions: [
        h('a', { class: 'tb-btn tb-text', href: '#/p/' + encodeURIComponent(id) + '/summary', 'aria-label': '요약 보기' }, '요약'),
        h('a', { class: 'tb-btn', href: '#/p/' + encodeURIComponent(id) + '/edit', 'aria-label': '매물 정보 수정' }, icon('edit'))
      ]
    });
    updateTabbar('home');
    var main = resetMain();
    appendKid(main, dataWarning());
    // 호수가 없으면 등기부를 열람할 수 없다(가져오기 코드로 만든 매물은 호수가 비어 있음)
    if (!prop.ho && prop.status !== 'dropped') {
      main.append(h('div', { class: 'notice notice-ho', role: 'note' },
        h('strong', { text: '호수를 입력해야 등기부를 볼 수 있어요' }),
        h('p', { text: '등기부등본은 동·호수까지 알아야 열람할 수 있어요. 중개사에게 받아 적어 주세요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-accent',
          onclick: function () { pendingFocus = 'ho'; navigateNow('/p/' + prop.id + '/edit'); } // 클릭 안에서 그려야 iOS 가 키보드를 띄움
        }, '입력하기')
      ));
    }
    main.append(detailHeader(prop));

    v.refs.alerts = h('div', { class: 'alerts', id: 'd-alerts' });
    // 화면을 처음 그릴 때는 경고를 다시 읽어 주지 않는다(새로 '있음'을 누를 때만 role=alert)
    v.refs.prevStopCount = prop.status === 'dropped' ? 0 : flagsYes(prop, 'stop').length;
    main.append(v.refs.alerts);
    renderAlerts(prop);

    // 사진 저장소를 쓸 수 없는 환경(파일로 열기 등)이면 사진 버튼 대신 이 안내가 보인다(CSS .no-photos)
    main.append(h('p', { class: 'notice photo-off-note', role: 'note', text: '이 환경에서는 사진을 저장할 수 없어요. HTTPS 주소(또는 홈 화면 앱)로 열면 사진을 붙일 수 있어요. 메모는 그대로 저장돼요.' }));

    if (CL.sections.length) {
      main.append(sectionChips(prop));
      v.refs.sectionsWrap = h('div', { class: 'sections' + (prop.status === 'dropped' ? ' prop-dropped' : '') }, CL.sections.map(function (sec) { return sectionEl(prop, sec); }));
      main.append(v.refs.sectionsWrap);
    }

    main.append(h('div', { class: 'detail-foot' },
      h('a', { class: 'btn btn-secondary btn-block', href: '#/p/' + encodeURIComponent(id) + '/summary' }, '요약 보기 · 협상·특약 후보 정리'),
      h('a', { class: 'btn btn-ghost btn-block', href: '#/p/' + encodeURIComponent(id) + '/edit' }, icon('edit', 'ic-sm'), '매물 정보 수정')
    ));

    // 열려 있던 섹션 복원. 처음이면 아직 덜 끝난 첫 섹션(보통 등기부)을 연다
    var open = null;
    try { open = JSON.parse(sessionGet('imjang.open.' + prop.id) || 'null'); } catch (e) { open = null; }
    if (!Array.isArray(open)) {
      var first = CL.sections.filter(function (s) { var p = sectionProgress(prop, s); return p.done < p.total; })[0] || CL.sections[0];
      open = first ? [first.id] : [];
    }
    open.forEach(function (sid) { if (v.refs.secs[sid]) toggleSection(sid, true); });

    loadPhotosInto(v, prop.id);
  }

  /** 매물 페이지 열기(새 창) + 도메인. 링크가 없으면 null */
  function sourceLink(prop) {
    if (!prop.sourceUrl) return null;
    return h('div', { class: 'dh-src' },
      h('a', { class: 'btn btn-small btn-secondary', href: prop.sourceUrl, target: '_blank', rel: 'noopener noreferrer' },
        icon('external', 'ic-sm'), '매물 페이지 열기', h('span', { class: 'sr-only', text: '(새 창)' })),
      h('span', { class: 'dh-host', text: hostOf(prop.sourceUrl) }));
  }

  function detailHeader(prop) {
    var v = view;
    var line = propLine(prop);
    var extra = [prop.supplyArea ? '공급 ' + prop.supplyArea + '㎡' : '', prop.articleNo ? '매물번호 ' + prop.articleNo : '',
      prop.confirmedAt ? '확인매물 ' + prop.confirmedAt : ''].filter(Boolean).join(' · ');
    var diff = diffPercent(prop.askPrice, prop.realPrice);
    var dl = h('dl', { class: 'kv' },
      h('dt', { text: '호가' }), h('dd', { text: prop.askPrice ? formatManwon(prop.askPrice) : '입력 안 함' }),
      h('dt', { text: '최근 실거래가' }), h('dd', { text: prop.realPrice ? formatManwon(prop.realPrice) : '입력 안 함' }),
      diff !== null ? h('dt', { text: '차이' }) : null,
      diff !== null ? h('dd', { class: diff > 0 ? 'diff-up' : 'diff-down' }, '실거래 대비 ' + pctText(diff), h('span', { class: 'sub', text: diffSentence(prop.askPrice, prop.realPrice) })) : null
    );
    var tel = telHref(prop.agentPhone);
    var agent = (prop.agentName || prop.agentPhone) ? h('div', { class: 'dh-agent' },
      h('div', {},
        h('span', { class: 'muted small', text: '중개사 ' }),
        h('strong', { text: prop.agentName || prop.agentPhone })
      ),
      tel ? h('a', { class: 'btn btn-small btn-secondary', href: tel, 'aria-label': '중개사에게 전화 걸기' }, icon('phone', 'ic-sm'), '전화') : null
    ) : null;

    var sel = h('select', { class: 'select', id: 'd-status' }, STATUSES.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    sel.value = prop.status;
    sel.addEventListener('change', function () { changeStatus(prop, sel.value); });
    v.refs.statusSelect = sel;

    var o = overallProgress(prop);
    v.refs.overallBar = makeBar(o.pct, o.pct + '% (' + o.done + '/' + o.total + ')', { ariaLabel: '전체 진행률' });

    var saveState = h('p', { class: 'save-state', id: 'save-state' });
    var card = h('section', { class: 'card dh', 'aria-label': '매물 요약' },
      h('div', { class: 'dh-top' },
        h('div', {},
          h('h2', { class: 'dh-name', text: prop.name }),
          line ? h('p', { class: 'dh-unit', text: line }) : null,
          extra ? h('p', { class: 'dh-extra', text: extra }) : null
        )
      ),
      dl,
      sourceLink(prop),
      agent,
      prop.memo ? h('p', { class: 'dh-memo', text: prop.memo }) : null,
      h('div', { class: 'status-row' }, h('label', { for: 'd-status', text: '진행 상태' }), sel),
      h('div', {},
        h('div', { class: 'dh-progress-head' }, h('p', { class: 'small muted', style: 'font-weight:700', text: '전체 진행' }), saveState),
        v.refs.overallBar.el)
    );
    setTimeout(updateSaveState, 0); // 화면에 붙은 뒤 '자동 저장됨' 표시 채우기
    return card;
  }

  var EARLY_STATUSES = { planned: 1, visited: 1, contract: 1 };

  function changeStatus(prop, next) {
    var v = view;
    function revert() { if (v.refs.statusSelect) v.refs.statusSelect.value = prop.status; }
    if (next === 'dropped' && prop.status !== 'dropped') {
      openDialog({
        title: '탈락 처리할까요?',
        message: '탈락 사유를 남겨 두면 나중에 비교할 때 도움이 돼요. (비워 둬도 돼요)',
        input: { multiline: true, placeholder: '예: 등기부에 신탁 기록, 누수 흔적', value: prop.dropReason || suggestedDropReason(prop), label: '탈락 사유' },
        buttons: [{ label: '탈락 처리', value: 'ok', kind: 'danger' }, { label: '취소', value: null, kind: 'secondary' }]
      }).then(function (r) {
        if (r.value !== 'ok') { revert(); return; }
        setPropStatus(prop, 'dropped', r.text.trim());
        afterStatusChange(prop);
        toast('탈락 처리했어요');
      });
      return;
    }
    // 등기부 멈춤 신호를 다 보기 전에 임장 예정·완료·계약 검토로 바꾸려 하면 한 번 더 묻는다
    var gs = gateStopState(prop);
    if (EARLY_STATUSES[next] && !EARLY_STATUSES[prop.status] && (gs.unanswered > 0 || gs.yes > 0)) {
      var hasStop = gs.yes > 0;
      confirmDialog({
        title: hasStop ? '멈춤 신호가 있는 매물이에요' : '등기부 멈춤 신호를 먼저 확인하세요',
        message: hasStop
          ? '등기부에 멈춤 신호가 있다고 표시했어요. 이 집은 보러 갈 필요가 없어요. 그래도 상태를 "' + STATUS_LABEL[next] + '"(으)로 바꿀까요?'
          : '아직 확인하지 않은 멈춤 신호가 ' + gs.unanswered + '개 있어요. 신탁·가압류 같은 문제가 있으면 보러 갈 필요가 없어요. 그래도 상태를 "' + STATUS_LABEL[next] + '"(으)로 바꿀까요?',
        confirmText: '그래도 바꾸기',
        cancelText: '등기부 먼저 보기'
      }).then(function (ok) {
        if (!ok) {
          revert();
          var g = gateSections()[0];
          if (g && view === v) jumpToSection(g.id);
          return;
        }
        applyStatus(prop, next);
      });
      return;
    }
    applyStatus(prop, next);
  }

  function applyStatus(prop, next) {
    setPropStatus(prop, next); // 탈락 사유는 지우지 않고 보관(다시 탈락시킬 때 기본값으로 씀)
    afterStatusChange(prop);
    toast('상태: ' + STATUS_LABEL[next]);
  }

  function afterStatusChange(prop) {
    if (view.prop !== prop) return;
    if (view.refs.statusSelect) view.refs.statusSelect.value = prop.status;
    if (view.refs.sectionsWrap) view.refs.sectionsWrap.classList.toggle('prop-dropped', prop.status === 'dropped');
    renderAlerts(prop);
  }

  function dropProperty(prop) {
    setPropStatus(prop, 'dropped', suggestedDropReason(prop) || prop.dropReason);
    saveNow();
    afterStatusChange(prop);
    toast('탈락 처리했어요. 다른 매물을 찾아봐요.');
  }

  /** 상단 경고: 탈락 / 위험 신호(stop) / 주의 신호(caution) */
  function renderAlerts(prop) {
    var box = view.refs.alerts;
    if (!box || view.prop !== prop) return;
    box.textContent = '';
    var stops = flagsYes(prop, 'stop');
    var cautions = flagsYes(prop, 'caution');
    // 멈춤 신호가 0 → 1개 이상이 될 때만 VoiceOver 가 바로 읽게(role=alert). 바꿀 때마다 다시 읽지 않게 한다
    var prevStops = view.refs.prevStopCount || 0;
    view.refs.prevStopCount = prop.status === 'dropped' ? 0 : stops.length;

    if (prop.status === 'dropped') {
      box.append(h('div', { class: 'alert alert-dropped' },
        h('p', { class: 'alert-title' }, icon('alert'), '탈락 처리한 매물이에요'),
        h('p', { text: prop.dropReason ? '사유: ' + prop.dropReason : '사유를 적지 않았어요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-ghost',
          onclick: function () { changeStatus(prop, 'review'); }
        }, '다시 검토하기')
      ));
    } else if (stops.length) {
      var late = stopIsLate(prop, stops);
      box.append(h('div', { class: 'alert alert-stop', role: prevStops === 0 ? 'alert' : null },
        h('p', { class: 'alert-title' }, icon('alert'), late ? '돈을 보내지 말고 멈추세요' : '이 집은 임장할 필요가 없어요'),
        h('p', { text: late
          ? '아래 멈춤 신호가 있다고 표시했어요. 가계약금·계약금·잔금을 보내지 말고 멈춘 뒤, 법무사·공인중개사 등 전문가에게 꼭 확인하세요.'
          : '등기부(또는 건축물대장)에 아래 멈춤 신호가 있다고 표시했어요. 보러 가기 전에 이 매물은 빼는 것을 권해요.' }),
        h('ul', { class: 'alert-list' }, stops.map(function (it) { return h('li', { text: it.text }); })),
        h('button', { type: 'button', class: 'btn btn-small btn-on-red', onclick: function () { dropProperty(prop); } }, '탈락 처리')
      ));
    }

    if (cautions.length) {
      box.append(h('div', { class: 'alert alert-caution' },
        h('p', { class: 'alert-title' }, icon('alert'), '주의 신호 ' + cautions.length + '개 · 조심하며 진행'),
        h('ul', { class: 'alert-list' }, cautions.map(function (it) { return h('li', { text: it.text }); })),
        h('p', { class: 'alert-foot', text: '바로 탈락 사유는 아니지만, 계약 전에 해결 방법(예: 잔금일에 갚고 말소)을 확인하고 특약에 적어 두세요. 요약의 "협상·특약 후보"에 모여요.' })
      ));
    }
  }

  function sectionChips(prop) {
    var nav = h('nav', { class: 'sec-chips', 'aria-label': '섹션 바로가기' });
    CL.sections.forEach(function (sec) {
      var p = sectionProgress(prop, sec);
      var n = h('span', { class: 'n', text: p.done + '/' + p.total });
      var chip = h('button', {
        type: 'button',
        class: 'sec-chip' + (sec.gate ? ' is-gate' : '') + (p.total && p.done === p.total ? ' is-complete' : ''),
        onclick: function () { jumpToSection(sec.id); }
      }, sec.title, n);
      view.refs.chips[sec.id] = { el: chip, n: n };
      nav.append(chip);
    });
    return nav;
  }

  function sectionEl(prop, sec) {
    var p = sectionProgress(prop, sec);
    var bodyId = 'sec-body-' + domId(sec.id);
    var countEl = h('span', { class: 'sec-count' + (p.total && p.done === p.total ? ' is-complete' : ''), text: p.done + '/' + p.total });
    var bar = makeBar(p.pct, null, { thin: true, ariaLabel: sec.title + ' 진행률' });
    var head = h('button', { type: 'button', class: 'sec-head', 'aria-expanded': 'false', 'aria-controls': bodyId },
      h('span', { class: 'sec-head-main' },
        h('span', { class: 'sec-title' }, sec.gate ? h('span', { class: 'badge badge-first', text: '가장 먼저' }) : null, sec.title),
        sec.when ? h('span', { class: 'sec-when', text: '언제: ' + sec.when }) : null
      ),
      h('span', { class: 'sec-head-side' }, countEl, icon('chevron')),
      bar.el
    );
    var body = h('div', { class: 'sec-body', id: bodyId, hidden: true });
    var wrap = h('section', { class: 'sec' + (sec.gate ? ' sec-gate' : ''), id: 'sec-' + domId(sec.id) }, head, body);
    head.addEventListener('click', function () { toggleSection(sec.id); });
    view.refs.secs[sec.id] = { wrap: wrap, head: head, body: body, countEl: countEl, bar: bar, rendered: false };
    return wrap;
  }

  function toggleSection(secId, forceOpen) {
    var r = view.refs.secs[secId];
    var sec = CL.sectionById[secId];
    if (!r || !sec) return;
    var open = forceOpen === undefined ? r.body.hidden : !!forceOpen;
    if (open && !r.rendered) {
      renderSectionBody(view.prop, sec, r.body); // 처음 열 때만 그린다(빠르게)
      r.rendered = true;
    }
    r.body.hidden = !open;
    r.head.setAttribute('aria-expanded', String(open));
    r.wrap.classList.toggle('is-open', open);
    var openIds = Object.keys(view.refs.secs).filter(function (k) { return !view.refs.secs[k].body.hidden; });
    if (view.prop) sessionSet('imjang.open.' + view.prop.id, JSON.stringify(openIds));
  }

  function jumpToSection(secId) {
    toggleSection(secId, true);
    var r = view.refs.secs[secId];
    if (!r) return;
    r.wrap.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setTimeout(function () { try { r.head.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }, 350);
  }

  function renderSectionBody(prop, sec, body) {
    var gates = gateSections();
    if (!sec.gate && gates.length) {
      // 1) 등기부 멈춤 신호에 아직 답하지 않았을 때: 등기부부터 보세요
      var hintText = h('p');
      var hint = h('div', { class: 'hint', role: 'note' },
        h('strong', { text: '등기부부터 보세요' }),
        hintText,
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { jumpToSection(gates[0].id); } }, '등기부 섹션 열기')
      );
      // 2) 등기부 멈춤 신호가 '있음'일 때: 이 집은 보러 갈 필요가 없어요
      var stopLine = h('div', { class: 'stop-line', role: 'note' },
        h('strong', {}, icon('alert', 'ic-sm'), '멈춤 신호가 있어 이 집은 임장할 필요가 없어요'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-small btn-danger drop-btn', onclick: function () { dropProperty(prop); } }, '탈락 처리'),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { jumpToSection(gates[0].id); } }, '등기부 다시 보기'))
      );
      view.refs.hints.push({ hint: hint, text: hintText, stop: stopLine });
      body.append(stopLine, hint);
      refreshHints(prop);
    }
    if (sec.desc) body.append(h('p', { class: 'sec-desc', text: sec.desc }));

    var list = h('div', { class: 'items' });
    var lastGroup = '';
    var OTHER = '\u0000other';
    sec.items.forEach(function (it) {
      if (it.group && it.group !== lastGroup) {
        list.append(h('h3', { class: 'group-title', text: it.group }));
        lastGroup = it.group;
      } else if (!it.group && lastGroup && lastGroup !== OTHER) {
        // group 이 있는 항목 뒤에 group 없는 항목이 오면 앞 소제목에 섞여 보이지 않도록
        list.append(h('h3', { class: 'group-title', text: '그 밖에' }));
        lastGroup = OTHER;
      }
      list.append(itemEl(prop, sec, it));
    });
    body.append(list);
    body.append(sectionNotes(prop, sec));
  }

  /** 다른 섹션 맨 위의 '등기부부터 보세요' / '멈춤 신호가 있어요' 안내 갱신 */
  function refreshHints(prop) {
    var gs = gateStopState(prop);
    view.refs.hints.forEach(function (r) {
      r.stop.hidden = gs.yes === 0;
      r.hint.hidden = gs.yes > 0 || gs.unanswered === 0;
      r.text.textContent = gs.total
        ? '아직 등기부 멈춤 신호 ' + gs.unanswered + '개를 확인하지 않았어요. 신탁·가압류 같은 문제가 있으면 이 집은 보러 갈 필요가 없으니, 등기부를 먼저 확인하세요.'
        : '아직 등기부등본 기록이 없어요. 신탁·가압류 같은 문제가 있으면 이 집은 보러 갈 필요가 없으니, 등기부를 먼저 확인하세요.';
    });
  }

  function refreshProgress(prop) {
    if (view.prop !== prop) return;
    var r = view.refs;
    var o = overallProgress(prop);
    if (r.overallBar) r.overallBar.set(o.pct, o.pct + '% (' + o.done + '/' + o.total + ')');
    CL.sections.forEach(function (sec) {
      var p = sectionProgress(prop, sec);
      var complete = p.total > 0 && p.done === p.total;
      var s = r.secs[sec.id];
      if (s) {
        s.countEl.textContent = p.done + '/' + p.total;
        s.countEl.classList.toggle('is-complete', complete);
        s.bar.set(p.pct);
      }
      var c = r.chips[sec.id];
      if (c) {
        c.n.textContent = p.done + '/' + p.total;
        c.el.classList.toggle('is-complete', complete);
      }
    });
  }

  function applyItemClasses(el, it, st) {
    var cls = ['item', 'item-' + it.type];
    if (it.type === 'flag') cls.push('sev-is-' + it.severity);
    if (isItemDone(it, st)) cls.push('is-done');
    if (it.type === 'rate' && st.status) cls.push('st-' + st.status);
    if (it.type === 'flag' && st.status === 'yes') cls.push('st-yes-' + it.severity);
    if (it.type === 'flag' && st.status === 'no') cls.push('st-no');
    el.className = cls.join(' ');
  }

  function afterItemChange(prop, sec, it, el) {
    // 위쪽 경고 상자가 생기거나 사라져도 지금 누른 항목이 손가락 아래에 그대로 있도록 스크롤을 보정한다
    var before = el.getBoundingClientRect().top;
    applyItemClasses(el, it, getItemState(prop, it.id));
    refreshProgress(prop);
    if (it.type === 'flag') renderAlerts(prop);
    if (sec.gate) refreshHints(prop);
    var shift = el.getBoundingClientRect().top - before;
    if (Math.abs(shift) > 1) window.scrollBy(0, shift);
  }

  /** [양호][주의] 같은 세그먼트 버튼. 눌린 걸 다시 누르면 해제. 묶음 이름은 항목 문장(labelledby) */
  function segment(options, current, onChange, labelledby) {
    var group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelledby });
    var btns = options.map(function (o) {
      var b = h('button', { type: 'button', class: 'seg-btn seg-' + o.v, 'aria-pressed': String(current === o.v) },
        h('span', { class: 'seg-mark', 'aria-hidden': 'true' }), o.label);
      b.addEventListener('click', function () {
        var wasPressed = b.getAttribute('aria-pressed') === 'true';
        btns.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b && !wasPressed)); });
        onChange(wasPressed ? '' : o.v);
      });
      return b;
    });
    btns.forEach(function (b) { group.append(b); });
    return group;
  }

  function rowsFor(text) {
    var lines = (str(text).match(/\n/g) || []).length + 1;
    return Math.min(8, Math.max(2, lines + (str(text).length > 60 ? 1 : 0)));
  }

  function memoField(prop, it, placeholder) {
    var st = getItemState(prop, it.id);
    var id = 'memo-' + domId(it.id);
    var wrapId = id + '-wrap';
    var ta = h('textarea', { class: 'input', id: id, rows: rowsFor(st.memo), placeholder: placeholder, 'aria-label': '메모: ' + it.text, value: st.memo || '' });
    var wrap = h('div', { class: 'memo-wrap', id: wrapId, hidden: !st.memo }, ta);
    var label = h('span', { text: st.memo ? '메모 있음' : '메모' });
    var btn = h('button', { type: 'button', class: 'tool-btn', 'aria-expanded': String(!!st.memo), 'aria-controls': wrapId }, icon('note', 'ic-sm'), label);
    function setName(has) {
      label.textContent = has ? '메모 있음' : '메모';
      btn.setAttribute('aria-label', (has ? '메모 있음: ' : '메모: ') + it.text);
    }
    setName(!!st.memo);
    function setOpen(open, focus) {
      wrap.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open && focus) ta.focus();
    }
    btn.addEventListener('click', function () { setOpen(wrap.hidden, true); });
    ta.addEventListener('input', function () {
      setItemState(prop, it.id, { memo: ta.value });
      setName(!!ta.value.trim());
    });
    return { btn: btn, wrap: wrap, open: function () { setOpen(true, false); } };
  }

  /** 재방문 기록 표시: 다녀옴 / 예정 / 체크 안 함 */
  function visitLabel(st) {
    if (st.done) return '다녀옴';
    if (st.date && st.date > todayISO()) return '예정';
    return st.date ? '날짜만 적음(체크 안 함)' : '메모만 있음';
  }

  function itemEl(prop, sec, it) {
    var st = getItemState(prop, it.id);
    var el = h('div', { id: 'item-' + domId(it.id) });
    var helpId = 'help-' + domId(it.id);
    var textId = 'itxt-' + domId(it.id);
    var dateInput = null;
    var cb = null;

    var helpPanel = it.help ? h('div', { class: 'item-help', id: helpId, hidden: true, text: it.help }) : null;
    var helpBtn = it.help ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': '쉬운 설명: ' + it.text, 'aria-expanded': 'false', 'aria-controls': helpId }, icon('help')) : null;
    if (helpBtn) {
      helpBtn.addEventListener('click', function () {
        var open = helpPanel.hidden;
        helpPanel.hidden = !open;
        helpBtn.setAttribute('aria-expanded', String(open));
      });
    }

    // 머리 줄: check·visit 은 넓은 체크 버튼, 나머지는 문장
    var head;
    if (it.type === 'check' || it.type === 'visit') {
      cb = h('button', { type: 'button', class: 'check-btn', role: 'checkbox', 'aria-checked': String(!!st.done) },
        h('span', { class: 'check-box', 'aria-hidden': 'true' }),
        h('span', { class: 'item-text', id: textId, text: it.text }));
      cb.addEventListener('click', function () {
        var done = !getItemState(prop, it.id).done;
        var patch = { done: done };
        if (it.type === 'visit' && done && dateInput && !dateInput.value) {
          dateInput.value = todayISO(); // 다녀온 날짜 기본값: 오늘
          patch.date = dateInput.value;
        }
        setItemState(prop, it.id, patch);
        cb.setAttribute('aria-checked', String(done));
        afterItemChange(prop, sec, it, el);
      });
      head = h('div', { class: 'item-head' }, cb, helpBtn);
    } else {
      head = h('div', { class: 'item-head' }, h('p', { class: 'item-text', id: textId, text: it.text }), helpBtn);
    }

    var tags = it.type === 'flag'
      ? h('div', { class: 'item-tags' }, h('span', { class: 'sev sev-' + it.severity, text: it.severity === 'stop'
        ? (sec.gate ? '멈춤 신호 · 있으면 임장 불필요' : '멈춤 신호 · 있으면 돈 보내지 않기')
        : '주의 신호 · 있으면 조심해서 진행' }))
      : null;
    var tip = it.tip ? h('p', { class: 'item-tip' }, h('b', { text: '팁 ' }), it.tip) : null;

    var controls = null;
    var extra = null;
    var memo = null;
    var stopInline = null;

    if (it.type === 'rate') {
      memo = memoField(prop, it, sec.cautionUse === 'reference' ? '어떤 점이 아쉬운지 적어 두면 가격을 판단할 때 써요' : '어떤 점이 아쉬운지 적어 두면 협상·특약 때 써요');
      controls = segment([{ v: 'good', label: '양호' }, { v: 'caution', label: '주의' }], st.status, function (val) {
        setItemState(prop, it.id, { status: val });
        if (val === 'caution') memo.open();
        afterItemChange(prop, sec, it, el);
      }, textId);
    } else if (it.type === 'flag') {
      memo = memoField(prop, it, '예: 채권최고액, 접수 날짜, 권리자');
      controls = segment([{ v: 'yes', label: '있음' }, { v: 'no', label: '없음' }], st.status, function (val) {
        setItemState(prop, it.id, { status: val });
        afterItemChange(prop, sec, it, el);
      }, textId);
      if (it.severity === 'stop') {
        // '있음'을 누른 바로 그 자리에서 결과와 [탈락 처리]를 보여 준다(위쪽 배너는 화면 밖일 수 있음)
        stopInline = h('div', { class: 'stop-inline', role: 'note' },
          h('p', { text: sec.gate ? '멈춤 신호예요. 이 집은 임장할 필요가 없어요.' : '멈춤 신호예요. 돈을 보내지 말고 멈추세요.' }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger drop-btn', onclick: function () { dropProperty(prop); } }, '탈락 처리'));
      }
    } else if (it.type === 'ask') {
      var ansId = 'ans-' + domId(it.id);
      var ans = h('textarea', { class: 'input', id: ansId, rows: rowsFor(st.answer), placeholder: '받은 답변을 적어 두세요', value: st.answer || '', 'aria-describedby': textId });
      ans.addEventListener('input', function () {
        setItemState(prop, it.id, { answer: ans.value });
        afterItemChange(prop, sec, it, el);
      });
      extra = h('div', { class: 'answer-wrap' }, h('label', { class: 'inline-label', for: ansId, text: '답변' }), ans);
    } else if (it.type === 'visit') {
      var dId = 'date-' + domId(it.id);
      var vmId = 'vmemo-' + domId(it.id);
      dateInput = h('input', { type: 'date', class: 'input', id: dId, value: st.date || '', 'aria-describedby': textId });
      var onDate = function () {
        var patch = { date: dateInput.value };
        // 오늘이나 지난 날짜를 넣으면 다녀온 것으로 체크(체크를 깜빡해도 '예정'으로 보이지 않게)
        if (dateInput.value && dateInput.value <= todayISO() && !getItemState(prop, it.id).done) {
          patch.done = true;
          if (cb) cb.setAttribute('aria-checked', 'true');
        }
        setItemState(prop, it.id, patch);
        afterItemChange(prop, sec, it, el);
      };
      dateInput.addEventListener('change', onDate);
      var vmemo = h('textarea', { class: 'input', id: vmId, rows: rowsFor(st.memo), placeholder: '예: 밤 10시, 위층 발소리 거의 없음', value: st.memo || '', 'aria-describedby': textId });
      vmemo.addEventListener('input', function () { setItemState(prop, it.id, { memo: vmemo.value }); });
      extra = h('div', { class: 'visit-fields' },
        h('div', {}, h('label', { class: 'inline-label', for: dId, text: '다녀온 날짜 (갈 날을 미리 적어도 돼요)' }), dateInput),
        h('div', {}, h('label', { class: 'inline-label', for: vmId, text: '메모' }), vmemo)
      );
    } else {
      memo = memoField(prop, it, '메모');
    }

    var tools = h('div', { class: 'item-tools' }, memo ? memo.btn : null, photoAddButton(prop, { itemId: it.id }, it.text));
    el.append(head);
    appendKid(el, tags);
    appendKid(el, helpPanel);
    appendKid(el, tip);
    appendKid(el, controls);
    appendKid(el, stopInline);
    appendKid(el, extra);
    if (memo) el.append(memo.wrap);
    el.append(tools, photoStrip('i:' + it.id, it.text));
    applyItemClasses(el, it, st);
    return el;
  }

  function sectionNotes(prop, sec) {
    var id = 'secmemo-' + domId(sec.id);
    var memoVal = Object.prototype.hasOwnProperty.call(prop.sectionMemos, sec.id) ? prop.sectionMemos[sec.id] : '';
    var ta = h('textarea', { class: 'input', id: id, rows: rowsFor(memoVal), placeholder: '이 섹션에서 눈여겨본 점을 자유롭게 적어 두세요', value: memoVal });
    ta.addEventListener('input', function () {
      if (BAD_KEYS[sec.id]) return;
      var now = stampAfter(Date.now(), prop.sectionMemoAt[sec.id], prop.legacyAt);
      if (ta.value) prop.sectionMemos[sec.id] = ta.value;
      else delete prop.sectionMemos[sec.id];
      prop.sectionMemoAt[sec.id] = now; // 지운 것도 시각을 남긴다(두 기기 합치기)
      touch(prop, now);
    });
    return h('div', { class: 'sec-notes' },
      h('label', { class: 'field-label', for: id, text: '이 섹션 메모·사진' }),
      ta,
      h('div', { class: 'item-tools' }, photoAddButton(prop, { sectionId: sec.id }, sec.title)),
      photoStrip('s:' + sec.id, sec.title)
    );
  }

  // ---- 사진 첨부 UI ----
  function photoAddButton(prop, target, caption) {
    var input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-input', 'aria-label': '사진 추가: ' + caption });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (files.length) addPhotos(prop, target, files);
    });
    return h('label', { class: 'tool-btn photo-tool' }, icon('camera', 'ic-sm'), h('span', { text: '사진' }), input);
  }

  function addPhotos(prop, target, files) {
    var v = view;
    var key = target.itemId ? 'i:' + target.itemId : 's:' + target.sectionId;
    var total = files.length;
    var ok = 0;
    var decodeFail = 0;
    var storeFailed = []; // 저장 단계에서 실패한 원본(다시 시도용)
    var lastErr = null;
    function progress() {
      var n = ok + decodeFail + storeFailed.length;
      toast(total > 1 ? '사진 저장 중 ' + Math.min(n + 1, total) + '/' + total + '장…' : '사진 저장 중…', { duration: 0 });
    }
    progress();
    var chain = Promise.resolve(v.photosReady);
    files.forEach(function (file) {
      chain = chain.then(function () {
        progress();
        return resizeImage(file).then(function (blob) {
          var rec = { id: uid(), propertyId: prop.id, itemId: target.itemId || null, sectionId: target.sectionId || null, blob: blob, createdAt: Date.now() };
          return Photos.put(rec).then(function () {
            ok++;
            if (view === v && v.photos) {
              if (!v.photos[key]) v.photos[key] = [];
              v.photos[key].push(rec);
              renderStrip(key);
            }
          }, function (err) {
            err = err || new Error('사진 저장 실패');
            if (typeof err === 'object') err.stage = 'store';
            throw err;
          });
        }).catch(function (err) {
          lastErr = err;
          console.warn('사진 저장 실패', err);
          if (err && err.stage === 'decode') decodeFail++;
          else storeFailed.push(file);
        });
      });
    });
    chain.then(function () {
      if (ok) touch(prop);
      if (view === v) renderStrip(key);
      if (storeFailed.length) {
        // 카메라로 바로 찍은 사진은 사진 앱에 남지 않으므로, 버리지 말고 다시 시도할 수 있게 한다
        toast((ok ? '사진 ' + ok + '장은 저장했지만 ' : '') + storeFailed.length + '장을 저장하지 못했어요. 카메라로 바로 찍은 사진은 사진 앱에 남지 않으니 [다시 시도]를 눌러 주세요.' +
          (lastErr && lastErr.name === 'QuotaExceededError' ? ' (저장 공간 부족)' : ''), {
          duration: 30000,
          action: { label: '다시 시도', fn: function () { addPhotos(prop, target, storeFailed); } }
        });
      } else if (decodeFail) {
        toast((ok ? '사진 ' + ok + '장 저장. ' : '') + decodeFail + '장은 사진 형식을 읽지 못했어요. 파일 앱 대신 사진 앱(앨범)에서 골라 주세요.', { duration: 6000 });
      } else {
        toast(ok > 1 ? '사진 ' + ok + '장을 저장했어요' : '사진을 저장했어요');
      }
    });
  }

  function photoStrip(key, caption) {
    var el = h('div', { class: 'thumbs', hidden: true });
    view.refs.strips[key] = { el: el, caption: caption };
    renderStrip(key);
    return el;
  }

  function renderStrip(key) {
    var ref = view.refs.strips[key];
    if (!ref) return;
    var v = view;
    var list = (v.photos && v.photos[key]) || [];
    ref.el.textContent = '';
    ref.el.hidden = !list.length;
    list.forEach(function (rec, i) {
      var btn = h('button', { type: 'button', class: 'thumb', 'aria-label': (ref.caption ? ref.caption + ' — ' : '') + '사진 ' + (i + 1) + ' 크게 보기' },
        h('img', { src: photoUrl(rec), alt: '', loading: 'lazy', decoding: 'async' }));
      btn.addEventListener('click', function () {
        openLightbox(rec, ref.caption, function (deleted) {
          if (view !== v || !v.photos) return;
          v.photos[key] = (v.photos[key] || []).filter(function (r) { return r.id !== deleted.id; });
          renderStrip(key);
        });
      });
      ref.el.append(btn);
    });
  }

  /** 매물의 사진을 모두 읽어 { 'i:항목id' | 's:섹션id': [레코드] } 로 묶는다 */
  function loadPhotosInto(v, propertyId) {
    v.photosReady = Photos.byProperty(propertyId).then(function (list) {
      var map = {};
      list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (rec) {
        if (!rec.blob) return;
        var k = photoKey(rec);
        if (!map[k]) map[k] = [];
        map[k].push(rec);
      });
      v.photos = map;
      if (view === v) Object.keys(v.refs.strips).forEach(renderStrip);
    }).catch(function (err) {
      console.warn('사진 불러오기 실패', err);
      v.photos = {};
    });
    return v.photosReady;
  }

  // ---------------- 요약 ----------------
  function collectSummary(prop) {
    var S = {
      stops: [], cautionFlags: [], rateCautions: [], contractCautions: [], refCautions: [],
      answered: [], unanswered: [], visits: [], memos: [], sectionMemos: []
    };
    CL.sections.forEach(function (sec) {
      sec.items.forEach(function (it) {
        var st = getItemState(prop, it.id);
        var row = { it: it, st: st, sec: sec };
        if (it.type === 'flag' && st.status === 'yes') (it.severity === 'stop' ? S.stops : S.cautionFlags).push(row);
        else if (it.type === 'rate' && st.status === 'caution') {
          S.rateCautions.push(row);
          // 집 안처럼 고칠 수 있는 것은 협상·특약 후보, 동네·단지는 가격 판단 참고(특약으로 바꿀 수 없음)
          (sec.cautionUse === 'reference' ? S.refCautions : S.contractCautions).push(row);
        }
        else if (it.type === 'ask') (st.answer && st.answer.trim() ? S.answered : S.unanswered).push(row);
        else if (it.type === 'visit') { if (st.done || st.date || st.memo) S.visits.push(row); }
        else if (st.memo && st.memo.trim()) S.memos.push(row); // 그 밖에 메모를 남긴 항목
      });
      var m = Object.prototype.hasOwnProperty.call(prop.sectionMemos, sec.id) ? prop.sectionMemos[sec.id] : '';
      if (m && m.trim()) S.sectionMemos.push({ sec: sec, memo: m });
    });
    return S;
  }

  function sumCard(title, count, children, emptyText) {
    var has = Array.isArray(children) ? children.length > 0 : !!children;
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, title, count !== null && count !== undefined ? h('span', { class: 'count', text: count + '개' }) : null),
      has ? children : h('p', { class: 'sum-empty', text: emptyText })
    );
  }

  function renderSummary(id) {
    var prop = findProp(id);
    if (!prop) return renderNotFound();
    var v = newView('summary', prop);
    setTopbar({
      title: '요약',
      back: '/p/' + id,
      actions: [h('button', { type: 'button', class: 'tb-btn', 'aria-label': '요약을 텍스트로 공유', onclick: function () { shareSummary(prop); } }, icon('share'))]
    });
    updateTabbar('home');
    var main = resetMain();
    var S = collectSummary(prop);
    var o = overallProgress(prop);
    var line = propLine(prop);
    var diff = diffPercent(prop.askPrice, prop.realPrice);

    main.append(h('section', { class: 'card' },
      h('div', { class: 'dh-top' },
        h('div', {},
          h('h2', { class: 'dh-name', text: prop.name }),
          line ? h('p', { class: 'dh-unit', text: line }) : null
        ),
        statusChip(prop.status)
      ),
      h('p', {}, '호가 ', h('strong', { text: prop.askPrice ? formatManwon(prop.askPrice) : '입력 안 함' }),
        prop.realPrice ? ' · 최근 실거래 ' + formatManwon(prop.realPrice) : '',
        diff !== null ? ' (' + pctText(diff) + ')' : ''),
      sourceLink(prop),
      makeBar(o.pct, o.pct + '% (' + o.done + '/' + o.total + ')', { ariaLabel: '전체 진행률' }).el
    ));

    if (prop.status === 'dropped') {
      main.append(h('section', { class: 'card sum-drop' },
        h('h2', { class: 'card-title', text: '탈락 사유' }),
        h('p', { text: prop.dropReason || '사유를 적지 않았어요.' })
      ));
    }

    // 위험 신호
    var reg = registryResult(prop);
    var riskRows = S.stops.map(function (r) { return sumRow(r, 'is-stop', '멈춤 신호'); })
      .concat(S.cautionFlags.map(function (r) { return sumRow(r, 'is-caution', '주의 신호'); }));
    main.append(sumCard('위험 신호', riskRows.length,
      riskRows.length ? h('ul', { class: 'sum-list' }, riskRows) : null,
      '"있음"으로 표시한 위험 신호가 없어요. (등기부: ' + reg.label + ')'));

    // 협상·특약 후보 = 등기부 주의 신호(근저당 말소·전세권 정리 등) + 집 안 "주의" 항목 + 메모 + 사진
    var cand = S.cautionFlags.map(function (r) { return sumRow(r, 'is-caution', '주의 신호', true); })
      .concat(S.contractCautions.map(function (r) { return sumRow(r, 'is-caution', null, true); }));
    main.append(sumCard('협상·특약 후보', cand.length,
      cand.length ? [
        h('p', { class: 'muted small', text: '등기부 주의 신호는 해결 방법(예: 잔금일에 갚고 말소)을 특약에 적고, 집 안 "주의" 항목은 수리 특약이나 가격 협상 근거로 써요.' }),
        h('ul', { class: 'sum-list' }, cand)
      ] : null,
      '등기부 주의 신호나 집 안에서 "주의"로 표시한 항목이 없어요.'));

    // 가격 판단 참고 = 동네·단지 "주의" (특약으로 고칠 수 없는 것)
    if (S.refCautions.length) {
      main.append(sumCard('가격 판단 참고 (특약 대상 아님)', S.refCautions.length, [
        h('p', { class: 'muted small', text: '동네·단지에서 "주의"로 표시한 항목이에요. 계약서로 고칠 수 없으니 이 집을 고를지, 가격이 맞는지 판단할 때 참고하세요.' }),
        h('ul', { class: 'sum-list' }, S.refCautions.map(function (r) { return sumRow(r, '', null, true); }))
      ], ''));
    }

    // 질문과 답변
    var qa = S.answered.map(function (r) {
      return h('li', { class: 'sum-item' },
        h('p', { class: 'sum-item-sec', text: r.sec.title }),
        h('p', { class: 'q', text: 'Q. ' + r.it.text }),
        h('p', { class: 'a', text: 'A. ' + r.st.answer }));
    });
    var qaChildren = [];
    if (qa.length) qaChildren.push(h('ul', { class: 'sum-list' }, qa));
    if (S.unanswered.length) {
      qaChildren.push(h('details', {},
        h('summary', { class: 'small muted', style: 'min-height:44px;display:flex;align-items:center;font-weight:700', text: '아직 답을 못 받은 질문 ' + S.unanswered.length + '개' }),
        h('ul', { class: 'alert-list muted' }, S.unanswered.map(function (r) { return h('li', { text: r.it.text }); }))
      ));
    }
    main.append(sumCard('질문과 답변', qa.length, qaChildren, '아직 답변을 적은 질문이 없어요.'));

    // 재방문 기록
    var visits = S.visits.map(function (r) {
      return h('li', { class: 'sum-item' },
        h('p', { class: 'sum-item-title', text: '[' + visitLabel(r.st) + '] ' + r.it.text }),
        r.st.date ? h('p', { class: 'small muted', text: '날짜: ' + formatISODate(r.st.date) }) : null,
        r.st.memo ? h('p', { class: 'sum-item-memo', text: r.st.memo }) : null);
    });
    main.append(sumCard('재방문 기록', visits.length, visits.length ? h('ul', { class: 'sum-list' }, visits) : null, '시간대를 바꿔 다시 간 기록이 없어요.'));

    // 메모
    var memoRows = S.sectionMemos.map(function (m) {
      return h('li', { class: 'sum-item' }, h('p', { class: 'sum-item-sec', text: m.sec.title }), h('p', { class: 'sum-item-memo', text: m.memo }));
    }).concat(S.memos.map(function (r) { return sumRow(r, '', null, true); }));
    if (prop.memo) memoRows.unshift(h('li', { class: 'sum-item' }, h('p', { class: 'sum-item-sec', text: '매물 메모' }), h('p', { class: 'sum-item-memo', text: prop.memo })));
    main.append(sumCard('메모', memoRows.length, memoRows.length ? h('ul', { class: 'sum-list' }, memoRows) : null, '남긴 메모가 없어요.'));

    main.append(h('div', { class: 'detail-foot' },
      h('button', { type: 'button', class: 'btn btn-block', onclick: function () { shareSummary(prop); } }, icon('share', 'ic-sm'), '텍스트로 공유'),
      h('p', { class: 'disclaimer', text: DISCLAIMER })
    ));

    loadPhotosInto(v, prop.id);
  }

  /** 요약 목록의 한 줄: 섹션 이름, 항목, 메모, (사진) */
  function sumRow(r, cls, tag, withPhotos) {
    return h('li', { class: 'sum-item ' + (cls || '') },
      h('p', { class: 'sum-item-sec', text: r.sec.title + (r.it.group ? ' · ' + r.it.group : '') }),
      h('p', { class: 'sum-item-title' }, tag ? h('span', { class: 'sev ' + (cls === 'is-stop' ? 'sev-stop' : 'sev-caution'), style: 'margin-right:6px', text: tag }) : null, r.it.text),
      r.st.memo ? h('p', { class: 'sum-item-memo', text: '메모: ' + r.st.memo }) : null,
      withPhotos ? photoStrip('i:' + r.it.id, r.it.text) : null
    );
  }

  function buildShareText(prop) {
    var S = collectSummary(prop);
    var o = overallProgress(prop);
    var unit = unitText(prop);
    // 요약 화면에서 이미 읽어 둔 사진이 있으면 장수를 함께 적는다(공유는 클릭 안에서 바로 해야 해서 새로 읽지 않음)
    var photos = view.prop === prop && view.photos ? view.photos : null;
    function photoNote(r) {
      var n = photos && photos['i:' + r.it.id] ? photos['i:' + r.it.id].length : 0;
      return n ? ' (사진 ' + n + '장, 앱에 있음)' : '';
    }
    function memoText(m) { return str(m).trim().replace(/\r?\n/g, '\n    '); } // 여러 줄 메모는 들여쓰기
    function withMemo(r) { return r.st.memo && r.st.memo.trim() ? ' — ' + memoText(r.st.memo) : ''; }

    var lines = [];
    lines.push('[임장 요약] ' + prop.name + (unit ? ' ' + unit : ''));
    lines.push('작성: ' + formatDateTime(Date.now()));
    var price = [];
    if (prop.askPrice) price.push('호가 ' + formatManwon(prop.askPrice));
    if (prop.realPrice) price.push('최근 실거래 ' + formatManwon(prop.realPrice));
    var diff = diffPercent(prop.askPrice, prop.realPrice);
    if (price.length) lines.push(price.join(' / ') + (diff !== null ? ' (실거래 대비 ' + pctText(diff) + ')' : ''));
    var spec = [prop.area ? '전용 ' + prop.area + '㎡' : '', floorText(prop.floor), str(prop.direction).trim()].filter(Boolean);
    if (spec.length) lines.push(spec.join(' · '));
    lines.push('상태: ' + STATUS_LABEL[prop.status] + ' · 체크 진행 ' + o.pct + '% · 등기부: ' + registryResult(prop).label);
    if (prop.agentName || prop.agentPhone) lines.push('중개사: ' + [prop.agentName, prop.agentPhone].filter(Boolean).join(' '));
    if (prop.sourceUrl) lines.push('매물 링크: ' + prop.sourceUrl);

    function block(title, rows) {
      if (!rows.length) return;
      lines.push('');
      lines.push('■ ' + title);
      rows.forEach(function (r) { lines.push(r); });
    }
    if (prop.status === 'dropped') block('탈락 사유', [prop.dropReason || '(사유 없음)']);
    block('위험 신호', S.stops.map(function (r) { return '- [멈춤 신호] ' + r.it.text + withMemo(r); })
      .concat(S.cautionFlags.map(function (r) { return '- [주의 신호] ' + r.it.text + withMemo(r); })));
    block('협상·특약 후보', S.cautionFlags.map(function (r) { return '- [등기부] ' + r.it.text + withMemo(r) + photoNote(r); })
      .concat(S.contractCautions.map(function (r) { return '- ' + r.it.text + withMemo(r) + photoNote(r); })));
    block('가격 판단 참고 (동네·단지 "주의", 특약 대상 아님)', S.refCautions.map(function (r) { return '- ' + r.it.text + withMemo(r) + photoNote(r); }));
    block('질문과 답변', S.answered.map(function (r) { return '- Q. ' + r.it.text + '\n  A. ' + r.st.answer.trim().replace(/\r?\n/g, '\n     '); }));
    block('아직 답을 못 받은 질문', S.unanswered.map(function (r) { return '- ' + r.it.text; }));
    block('재방문 기록', S.visits.map(function (r) {
      return '- [' + visitLabel(r.st) + '] ' + r.it.text + (r.st.date ? ' (' + formatISODate(r.st.date) + ')' : '') + withMemo(r);
    }));
    var memoLines = [];
    if (prop.memo && prop.memo.trim()) memoLines.push('- 매물 메모: ' + memoText(prop.memo));
    S.sectionMemos.forEach(function (m) { memoLines.push('- ' + m.sec.title + ': ' + memoText(m.memo)); });
    S.memos.forEach(function (r) { memoLines.push('- ' + r.it.text + ': ' + memoText(r.st.memo)); });
    block('메모', memoLines);
    lines.push('');
    lines.push('※ 교육·참고용 체크리스트 기록이에요. 계약 전 전문가 확인 필요.');
    return lines.join('\n');
  }

  function shareSummary(prop) {
    var text = buildShareText(prop);
    var title = '임장 요약 - ' + prop.name;
    if (navigator.share) {
      // 사용자 동작(클릭) 안에서 바로 호출해야 iOS 에서 공유 시트가 뜬다
      navigator.share({ title: title, text: text }).catch(function (err) {
        if (!err || err.name !== 'AbortError') copyText(text);
      });
      return;
    }
    copyText(text);
  }

  /**
   * 글 복사. 클립보드가 안 되면(http 주소 등) 글상자 대화상자로 대신한다.
   * labels: { ok: 성공 토스트, title: 대화상자 제목 } (기본값은 요약 공유용)
   */
  function copyText(text, labels) {
    labels = labels || {};
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        toast(labels.ok || '요약을 복사했어요. 메신저나 메모에 붙여 넣으세요.');
      }, function () { showTextDialog(text, labels); });
    } else {
      showTextDialog(text, labels);
    }
  }

  function showTextDialog(text, labels) {
    labels = labels || {};
    var ta = h('textarea', { class: 'input', rows: 10, readonly: true, value: text, 'aria-label': labels.title || '요약 텍스트' });
    openDialog({
      title: labels.title || '요약 텍스트',
      message: '아래 글을 길게 눌러 전체 선택한 뒤 복사하세요.',
      content: ta,
      buttons: [
        {
          label: '복사하기', value: 'copy', keepOpen: true,
          action: function () {
            // iOS Safari 는 readonly 칸의 글자를 코드로 선택하지 못한다 → 복사하는 동안만 잠금을 푼다
            var ok = false;
            ta.readOnly = false;
            try {
              ta.focus({ preventScroll: true });
              ta.select();
              ta.setSelectionRange(0, ta.value.length);
              ok = document.execCommand('copy') && ta.selectionEnd - ta.selectionStart > 0;
            } catch (e) { ok = false; }
            ta.readOnly = true;
            try { ta.blur(); } catch (e) { /* 무시 */ }
            toast(ok ? '복사했어요' : '복사하지 못했어요. 글을 길게 눌러 "전체 선택" → "복사"를 눌러 주세요.', { duration: ok ? 2800 : 6000 });
          }
        },
        { label: '닫기', value: null, kind: 'secondary' }
      ]
    });
  }

  // ---------------- 비교 ----------------
  var SORTS = [
    { id: 'updated', label: '최근에 고친 순' },
    { id: 'ask', label: '호가 낮은 순' },
    { id: 'diff', label: '실거래 대비 낮은 순' },
    { id: 'progress', label: '진행률 높은 순' },
    { id: 'caution', label: '주의 적은 순' }
  ];

  function renderCompare() {
    newView('compare');
    setTopbar({ title: '매물 비교' });
    updateTabbar('compare');
    var main = resetMain();

    if (!state.properties.length) {
      main.append(h('div', { class: 'card' },
        h('p', { text: '비교할 매물이 아직 없어요. 매물을 두 개 이상 추가하면 호가·진행률·주의 개수를 한눈에 비교할 수 있어요.' }),
        h('a', { class: 'btn btn-accent btn-block', href: '#/new' }, icon('plus'), '매물 추가')));
      return;
    }

    // 탈락 매물은 기본으로 숨긴다(멈춤 신호로 뺀 집이 비교에 섞이지 않게)
    var includeDropped = sessionGet('imjang.cmp.dropped') === '1';
    var sortKey = sessionGet('imjang.cmp.sort') || 'updated';

    var sortSel = h('select', { class: 'select', 'aria-label': '정렬 기준' }, SORTS.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    sortSel.value = SORTS.some(function (s) { return s.id === sortKey; }) ? sortKey : 'updated';
    var dropToggle = h('input', { type: 'checkbox', checked: includeDropped });
    var droppedCount = state.properties.filter(function (p) { return p.status === 'dropped'; }).length;
    var hiddenNote = h('p', { class: 'small muted', 'aria-live': 'polite', style: 'margin:-4px 2px 10px' });
    var tableWrap = h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '매물 비교 표 (옆으로 밀어서 보기)' });

    main.append(
      h('p', { class: 'page-sub', text: '표를 옆으로 밀면 더 볼 수 있어요. 매물 이름을 누르면 상세 화면으로 가요.' }),
      h('div', { class: 'compare-tools' }, sortSel, h('label', { class: 'toggle' }, dropToggle, '탈락 매물도 보기')),
      hiddenNote,
      tableWrap,
      h('div', { class: 'card', style: 'margin-top:14px' },
        h('p', { class: 'small muted', text: '실거래 대비: 호가가 최근 실거래가보다 몇 % 높은지(+) 낮은지(−). 실거래가는 한 건의 거래라 층·향·수리 상태에 따라 차이가 날 수 있어요.' }),
        h('p', { class: 'small muted', text: '주의: 현장 평가에서 "주의"로 표시한 항목 + 등기부에서 "주의" 신호가 있다고 표시한 항목 수.' })
      )
    );

    function nullsLast(a, b, f, dir) {
      var x = f(a), y = f(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return dir * (x - y);
    }

    function draw() {
      var list = state.properties.filter(function (p) { return includeDropped || p.status !== 'dropped'; });
      var k = sortSel.value;
      list.sort(function (a, b) {
        if (k === 'ask') return nullsLast(a, b, function (p) { return p.askPrice || null; }, 1);
        if (k === 'diff') return nullsLast(a, b, function (p) { return diffPercent(p.askPrice, p.realPrice); }, 1);
        if (k === 'progress') return overallProgress(b).pct - overallProgress(a).pct;
        if (k === 'caution') return cautionCount(a) - cautionCount(b);
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      tableWrap.textContent = '';
      hiddenNote.textContent = !includeDropped && droppedCount ? '탈락 ' + droppedCount + '개 숨김' : '';
      hiddenNote.hidden = !hiddenNote.textContent;
      if (!list.length) {
        tableWrap.append(h('p', { class: 'muted', style: 'padding:16px', text: '보여 줄 매물이 없어요.' }));
        return;
      }
      // 핵심 판단 기준(등기부 결과)을 매물 이름 바로 옆에 둔다
      var thead = h('thead', {}, h('tr', {},
        h('th', { class: 'sticky-col', scope: 'col', text: '매물' }),
        h('th', { scope: 'col', text: '등기부 결과' }),
        h('th', { scope: 'col', text: '상태' }),
        h('th', { class: 'num', scope: 'col', text: '호가' }),
        h('th', { class: 'num', scope: 'col', text: '실거래 대비' }),
        h('th', { class: 'num', scope: 'col', text: '주의' }),
        h('th', { scope: 'col', text: '진행률' }),
        h('th', { class: 'num', scope: 'col', text: '최근 실거래가' }),
        h('th', { class: 'num', scope: 'col', text: '전용면적' }),
        h('th', { scope: 'col', text: '층·방향' })
      ));
      var tbody = h('tbody', {}, list.map(function (p) {
        var prog = overallProgress(p);
        var reg = registryResult(p);
        var diff = diffPercent(p.askPrice, p.realPrice);
        var unit = unitText(p);
        return h('tr', { class: p.status === 'dropped' ? 'is-dropped' : null },
          h('th', { class: 'sticky-col', scope: 'row' },
            h('a', { href: '#/p/' + encodeURIComponent(p.id) }, p.name, unit ? h('span', { class: 'unit-sub', text: unit }) : null)),
          h('td', {}, h('span', { class: 'meta-chip reg-' + reg.code, text: reg.label })),
          h('td', {}, statusChip(p.status)),
          h('td', { class: 'num', text: p.askPrice ? formatManwon(p.askPrice) : '-' }),
          h('td', { class: 'num' + (diff !== null ? (diff > 0 ? ' diff-up' : ' diff-down') : ''), text: pctText(diff) }),
          h('td', { class: 'num', text: String(cautionCount(p)) }),
          h('td', {}, h('span', { class: 'mini-bar' }, makeBar(prog.pct, null, { thin: true, ariaLabel: p.name + ' 진행률' }).el), prog.pct + '%'),
          h('td', { class: 'num', text: p.realPrice ? formatManwon(p.realPrice) : '-' }),
          h('td', { class: 'num', text: p.area ? p.area + '㎡' : '-' }),
          h('td', { text: [floorText(p.floor), str(p.direction).trim()].filter(Boolean).join(' · ') || '-' })
        );
      }));
      tableWrap.append(h('table', { class: 'ctable' }, h('caption', { class: 'sr-only', text: '매물 비교' }), thead, tbody));
    }

    sortSel.addEventListener('change', function () { sessionSet('imjang.cmp.sort', sortSel.value); draw(); });
    dropToggle.addEventListener('change', function () {
      includeDropped = dropToggle.checked;
      sessionSet('imjang.cmp.dropped', includeDropped ? '1' : '0');
      draw();
    });
    draw();
  }

  // ---------------- 용어 ----------------
  function highlight(text, q) {
    if (!q) return [text];
    var out = [];
    var lower = text.toLowerCase();
    var ql = q.toLowerCase();
    var i = 0;
    for (;;) {
      var j = lower.indexOf(ql, i);
      if (j < 0) break;
      if (j > i) out.push(text.slice(i, j));
      out.push(h('mark', { text: text.slice(j, j + q.length) }));
      i = j + q.length;
    }
    if (i < text.length) out.push(text.slice(i));
    return out;
  }

  function renderGlossary() {
    newView('glossary');
    setTopbar({ title: '용어와 바로가기' });
    updateTabbar('glossary');
    var main = resetMain();
    appendKid(main, dataWarning());

    var q = sessionGet('imjang.gloss.q') || '';
    var search = h('input', { class: 'input', type: 'search', placeholder: '용어 찾기 (예: 신탁, 근저당)', 'aria-label': '용어 검색', value: q, autocomplete: 'off', enterkeyhint: 'search' });
    var countEl = h('p', { class: 'small muted', 'aria-live': 'polite', style: 'margin:0 2px 8px' });
    var list = h('ul', { class: 'gloss', role: 'list' });

    function draw() {
      var term = search.value.trim();
      sessionSet('imjang.gloss.q', term);
      list.textContent = '';
      var tl = term.toLowerCase();
      var rows = CL.glossary.filter(function (g) {
        return !tl || g.term.toLowerCase().indexOf(tl) >= 0 || g.desc.toLowerCase().indexOf(tl) >= 0;
      });
      countEl.textContent = term ? '"' + term + '" 검색 결과 ' + rows.length + '개' : '용어 ' + rows.length + '개';
      if (!rows.length) {
        list.append(h('li', { class: 'muted', text: term ? '찾는 용어가 없어요. 다른 낱말로 찾아보세요.' : '등록된 용어가 없어요.' }));
        return;
      }
      rows.forEach(function (g) {
        list.append(h('li', {},
          h('p', { class: 'term' }, highlight(g.term, term)),
          g.desc ? h('p', { class: 'desc' }, highlight(g.desc, term)) : null));
      });
    }
    search.addEventListener('input', draw);

    main.append(
      h('div', { class: 'search-wrap' }, icon('search'), search),
      countEl,
      list
    );
    draw();

    if (CL.links.length) {
      main.append(h('h2', { class: 'h2' }, '바로가기', h('span', { class: 'count', text: '새 창으로 열려요' })));
      main.append(h('ul', { class: 'links', role: 'list' }, CL.links.map(function (l) {
        var host = '';
        try { host = new URL(l.url).host; } catch (e) { host = l.url; }
        return h('li', {},
          h('a', { class: 'link-card', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
            h('span', { class: 'lc-main' },
              h('span', { class: 'lc-label', text: l.label }),
              l.desc ? h('span', { class: 'lc-desc', style: 'display:block', text: l.desc }) : null,
              h('span', { class: 'lc-host', style: 'display:block', text: host })),
            icon('external'),
            h('span', { class: 'sr-only', text: '(새 창)' })
          ));
      })));
    }
    if (CL.version) main.append(h('p', { class: 'about', text: '체크리스트 기준: ' + CL.version }));
  }

  // ---------------- 설정 ----------------
  function renderSettings() {
    newView('settings');
    setTopbar({ title: '설정' });
    updateTabbar('settings');
    var main = resetMain();

    // 0) 코드로 매물 추가(Claude 가져오기 코드)
    main.append(h('a', { class: 'link-card set-link', href: '#/import' },
      h('span', { class: 'lc-main' },
        h('span', { class: 'lc-label', text: '코드로 매물 추가' }),
        h('span', { class: 'lc-desc', style: 'display:block', text: '네이버 부동산 매물 화면을 Claude에게 보내고, 받은 코드를 붙여 넣어요.' })),
      icon('paste')));

    // 1) 백업 내보내기
    var withPhotos = h('input', { type: 'checkbox', id: 'bk-photos' });
    // 기기 이름: 백업 파일 이름과 불러오기 확인 창("iPad에서 만든 백업")에 쓴다. 비우면 자동(iPad / iPhone / Mac / 기타)
    var nameInput = h('input', {
      class: 'input', id: 'set-device', type: 'text', value: state.ui.deviceName || '', placeholder: defaultDeviceName(),
      maxlength: DEVICE_NAME_MAX, autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': 'set-device-hint'
    });
    nameInput.addEventListener('input', function () {
      state.ui.deviceName = cleanDeviceName(nameInput.value);
      state.ui.deviceNameAt = Date.now();
      scheduleSave();
    });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); nameInput.blur(); }
    });
    main.append(h('section', { class: 'card', 'aria-labelledby': 'set-backup' },
      h('h2', { class: 'card-title', id: 'set-backup', text: '백업 내보내기' }),
      h('p', { class: 'small muted', text: '매물과 체크 기록을 JSON 파일 하나로 저장해요. iPhone 을 바꾸거나 Safari 데이터가 지워졌을 때 이 파일로 되살릴 수 있어요.' }),
      h('div', { class: 'field set-device' },
        h('label', { for: 'set-device', text: '이 기기 이름' }),
        nameInput,
        h('p', { class: 'field-hint', id: 'set-device-hint', text: '백업 파일 이름과, 다른 기기에서 불러올 때 보여요. 비워 두면 "' + defaultDeviceName() + '"' })),
      h('label', { class: 'toggle' }, withPhotos, '사진도 함께 넣기 (파일이 커져요)'),
      h('button', { type: 'button', class: 'btn btn-block', onclick: function () { createBackup(withPhotos.checked); } }, '백업 파일 만들기'),
      h('p', { class: 'small muted', text: state.ui.lastBackupAt ? '마지막 백업: ' + formatDateTime(state.ui.lastBackupAt) : '아직 백업한 적이 없어요.' })
    ));

    // 2) 불러오기
    var fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'file-input', 'aria-label': '백업 파일 고르기' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) importBackup(file);
    });
    // merge.js 를 못 불러왔으면(배포에 빠졌거나 캐시가 엇갈림) 합치기를 쓸 수 없다고 알린다
    var mergeMissing = !MG ? h('div', { class: 'notice notice-stop', role: 'alert' },
      h('strong', { text: '합치기 기능 파일을 못 불러왔어요' }),
      h('p', { text: '지금은 [합치기]를 쓸 수 없어요. 인터넷에 연결한 뒤 새로고침해 주세요.' }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () { location.reload(); } }, '새로고침')) : null;
    main.append(h('section', { class: 'card', 'aria-labelledby': 'set-import' },
      h('h2', { class: 'card-title', id: 'set-import', text: '백업 불러오기' }),
      mergeMissing,
      h('p', { class: 'small muted', text: '이 앱에서 만든 백업 파일(.json)을 고르면, 지금 기록과 합칠지 덮어쓸지 물어봐요.' }),
      h('label', { class: 'btn btn-ghost btn-block', style: 'position:relative' }, '백업 파일 고르기', fileInput),
      // 두 기기(예: iPad·Mac)를 백업 파일로 가끔 맞추는 순서
      h('div', { class: 'sync-guide', role: 'note', 'aria-labelledby': 'set-sync' },
        h('h3', { class: 'sync-title', id: 'set-sync', text: '두 기기 맞추는 순서' }),
        h('p', { class: 'small', text: '먼저 두 기기의 앱 버전(아래 "알아 두세요")이 같은지 보세요. 다르면 인터넷에 연결해 앱을 열고 새로고침해 최신으로 맞춰요. 지금 버전: ' + APP_VERSION }),
        h('ol', { class: 'sync-steps' },
          h('li', { text: 'A(예: iPad)에서 백업 파일 만들기 → B(예: Mac)에서 불러오기 → [합치기]' }),
          h('li', { text: 'B에서 백업 파일 만들기 → A에서 불러오기 → [합치기]' })),
        h('p', { class: 'small muted', text: '사진도 옮기려면 백업할 때 "사진도 함께 넣기"를 켜세요(이미 있는 사진은 다시 넣지 않아요).' }),
        h('p', { class: 'small muted', text: '같은 매물을 양쪽에서 고쳐도 항목마다 더 최근에 고친 쪽이 남아요. 한쪽에서 지운 매물은 다른 쪽에서도 지워져요(지워지기 전에 이름을 보여 주고 물어봐요).' }))
    ));

    // 3) 저장 공간
    var persistEl = h('span', { class: 'set-value', text: '확인 중…' });
    var usageEl = h('span', { class: 'set-value', text: '확인 중…' });
    var countEl = h('span', { class: 'set-value', text: '매물 ' + state.properties.length + '개' });
    var persistMsg = h('p', { class: 'small muted', 'aria-live': 'polite' });
    var persistBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-block' }, '데이터 보호 요청하기');
    persistBtn.addEventListener('click', function () {
      if (!navigator.storage || !navigator.storage.persist) {
        persistMsg.textContent = '이 브라우저는 데이터 보호 요청을 지원하지 않아요. 백업을 자주 해 두세요.';
        return;
      }
      navigator.storage.persist().then(function (granted) {
        persistEl.textContent = granted ? '보호됨' : '보호 안 됨';
        persistMsg.textContent = granted
          ? '보호됨: 저장 공간이 부족해도 브라우저가 이 앱 데이터를 마음대로 지우지 않아요.'
          : '브라우저가 요청을 받아들이지 않았어요. 홈 화면에 추가해서 자주 쓰고, 백업을 해 두세요.';
      }, function () { persistMsg.textContent = '요청 중 문제가 생겼어요.'; });
    });
    main.append(h('section', { class: 'card', 'aria-labelledby': 'set-storage' },
      h('h2', { class: 'card-title', id: 'set-storage', text: '저장 공간' }),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '데이터 보호' }), persistEl),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '사용 중인 용량' }), usageEl),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '저장된 기록' }), countEl),
      persistBtn,
      persistMsg,
      h('p', { class: 'small muted', text: '기록은 이 기기의 Safari 안에만 저장돼요(서버로 보내지 않아요). 다른 기기와 자동으로 맞춰지지 않으니 백업 파일로 옮기세요.' })
    ));
    fillStorageInfo(persistEl, usageEl, countEl);

    // 4) 홈 화면 앱
    var homeCard = h('section', { class: 'card', 'aria-labelledby': 'set-home' },
      h('h2', { class: 'card-title', id: 'set-home', text: '홈 화면에 추가' }),
      inAppWarning(),
      h('p', { class: 'small', text: isStandalone()
        ? '지금 홈 화면 앱으로 쓰고 있어요.'
        : 'Safari의 공유 버튼(또는 주소창 옆 ⋯ → 공유) → "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있어요.' }),
      h('p', { class: 'small muted', text: 'Safari 는 오래 쓰지 않은 사이트의 데이터를 지울 수 있어요. 홈 화면에 추가하고, 백업도 해 두세요.' }),
      h('p', { class: 'small', text: '홈 화면 앱과 Safari 탭은 저장 공간이 따로예요. 한쪽에서 입력한 기록은 다른 쪽에 보이지 않아요. 옮기려면 쓰던 쪽에서 "백업 파일 만들기" → 새 쪽에서 "백업 불러오기"를 하세요.' })
    );
    if (state.ui.dismissedInstallTip && !isStandalone()) {
      homeCard.append(h('button', {
        type: 'button', class: 'btn btn-ghost btn-block',
        onclick: function (e) {
          state.ui.dismissedInstallTip = false;
          saveNow();
          e.currentTarget.remove();
          toast('매물 화면에 안내를 다시 보여 드려요');
        }
      }, '안내 다시 보기'));
    }
    main.append(homeCard);

    // 5) 전체 삭제
    main.append(h('section', { class: 'card', 'aria-labelledby': 'set-wipe' },
      h('h2', { class: 'card-title', id: 'set-wipe', text: '전체 삭제' }),
      h('p', { class: 'small muted', text: '이 기기에 저장된 매물·체크 기록·사진을 모두 지워요. 다른 기기의 기록은 그대로예요. 되돌릴 수 없으니 먼저 백업하세요.' }),
      h('button', { type: 'button', class: 'btn btn-danger-ghost btn-block', onclick: wipeAll }, icon('trash', 'ic-sm'), '모든 기록 지우기')
    ));

    // 6) 정보
    var offline = ('serviceWorker' in navigator) && navigator.serviceWorker.controller ? '준비됨'
      : (location.protocol === 'file:' || !window.isSecureContext ? '지원 안 됨 (HTTPS 필요)' : '다음에 열 때 준비');
    main.append(h('section', { class: 'card', 'aria-labelledby': 'set-about' },
      h('h2', { class: 'card-title', id: 'set-about', text: '알아 두세요' }),
      h('p', { class: 'disclaimer', text: DISCLAIMER }),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '앱 버전' }), h('span', { class: 'set-value', text: APP_VERSION })),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '체크리스트 기준' }), h('span', { class: 'set-value', text: CL.version || '-' })),
      h('div', { class: 'set-row' }, h('span', { class: 'label', text: '오프라인 사용' }), h('span', { class: 'set-value', text: offline })),
      // 새 버전 안내 토스트를 놓쳐도 여기서 새로고침할 수 있게
      SW.updateReady ? h('div', { class: 'set-row' },
        h('span', { class: 'label', text: '새 버전이 준비됐어요' }),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: reloadForUpdate }, '새로고침')) : null
    ));
  }

  function fillStorageInfo(persistEl, usageEl, countEl) {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) { persistEl.textContent = p ? '보호됨' : '보호 안 됨'; }, function () { persistEl.textContent = '알 수 없음'; });
    } else {
      persistEl.textContent = '지원 안 됨';
    }
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        usageEl.textContent = bytesText(e.usage || 0) + (e.quota ? ' / 약 ' + bytesText(e.quota) : '');
      }, function () { usageEl.textContent = '알 수 없음'; });
    } else {
      var size = 0;
      try { size = (localStorage.getItem(STORAGE_KEY) || '').length * 2; } catch (e) { size = 0; }
      usageEl.textContent = '기록 약 ' + bytesText(size) + ' (사진 제외)';
    }
    Photos.count().then(function (n) {
      countEl.textContent = '매물 ' + state.properties.length + '개 · 사진 ' + n + '장';
    }, function () { /* 사진 저장소 없음 */ });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.append(a);
    a.click();
    // iOS 는 내려받기 확인 창을 띄우므로, 그동안 주소가 살아 있도록 넉넉히 기다렸다가 해제한다
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 120000);
  }

  function markBackup() {
    state.ui.lastBackupAt = Date.now();
    saveNow();
    if (view.name === 'settings') renderSettings();
  }

  var BIG_BACKUP_BYTES = 80 * 1024 * 1024;

  /**
   * 백업 파일에 넣을 기록: state 그대로이되 localDeleted(전체 삭제·덮어쓰기로 지운 "이 기기 초기화" 표시)는 뺀다(1.3.1).
   * 이것이 다른 기기로 가면 그 기기 [합치기]에서 그 기기 매물과 사진이 지워지기 때문
   */
  function backupData() {
    var d = {};
    Object.keys(state).forEach(function (k) { if (k !== 'localDeleted') d[k] = state[k]; });
    return d;
  }

  /**
   * 백업 파일 만들기.
   * 사진을 넣을 때 전체를 문자열 하나(JSON.stringify)로 만들면 iPhone 에서 메모리가 모자라 페이지가 다시 열릴 수 있다.
   * 그래서 사진마다 조각으로 Blob 에 이어 붙이고, 사진 문자열은 바로 놓아 준다.
   */
  function createBackup(includePhotos) {
    saveNow();
    var made = Date.now();
    var dev = deviceName();
    var header = {
      app: BACKUP_APP_ID,
      schema: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      checklistVersion: CL.version,
      exportedAt: new Date(made).toISOString(),
      // 1.3.0: 어느 기기에서 언제 만든 백업인지(불러올 때 "iPad에서 10월 9일 21:10에 만든 백업"으로 보여 줌)
      meta: { deviceName: dev, createdAt: made, appVersion: APP_VERSION },
      data: backupData() // 삭제 표시(deleted)·지운 매물 열쇠(goneKeys)도 들어 있어 [합치기]가 다른 기기에 전한다
    };
    var headJson = JSON.stringify(header); // 사진이 없는 부분이라 작다
    var TYPE = { type: 'application/json' };
    var photoCount = 0;

    function buildWithPhotos(records) {
      var acc = new Blob([headJson.slice(0, -1), ',"photos":['], TYPE);
      var chain = Promise.resolve();
      records.forEach(function (rec) {
        if (!rec.blob) return;
        chain = chain.then(function () {
          return blobToDataURL(rec.blob).then(function (dataUrl) {
            var meta = JSON.stringify({ id: rec.id, propertyId: rec.propertyId, itemId: rec.itemId || null, sectionId: rec.sectionId || null, createdAt: rec.createdAt });
            // dataUrl 은 base64 글자뿐이라 JSON 이스케이프가 필요 없다
            acc = new Blob([acc, photoCount ? ',' : '', meta.slice(0, -1), ',"dataUrl":"', dataUrl, '"}'], TYPE);
            photoCount++;
            if (photoCount % 5 === 0) toast('백업 만드는 중… 사진 ' + photoCount + '/' + records.length + '장', { duration: 0 });
          });
        });
      });
      return chain.then(function () { return new Blob([acc, ']}'], TYPE); });
    }

    var step;
    if (includePhotos) {
      toast('사진을 넣어 백업 파일을 만드는 중…', { duration: 0 });
      step = Photos.all().then(function (all) {
        var estimate = all.reduce(function (sum, r) { return sum + (r.blob ? r.blob.size : 0); }, 0) * 1.37;
        if (estimate < BIG_BACKUP_BYTES) return buildWithPhotos(all);
        hideToast();
        return confirmDialog({
          title: '백업 파일이 아주 커요',
          message: '사진 ' + all.length + '장, 예상 크기 약 ' + bytesText(estimate) + '예요. 사진이 많으면 iPhone 에서 만들다가 실패하거나 앱이 다시 열릴 수 있어요.\n\n사진 없이 먼저 백업해 두고, 사진 백업은 나중에 와이파이·충전 중에 다시 해 보세요.',
          confirmText: '그래도 사진 넣어 만들기',
          cancelText: '사진 없이 만들기'
        }).then(function (ok) {
          if (!ok) return null;
          toast('사진을 넣어 백업 파일을 만드는 중…', { duration: 0 });
          return buildWithPhotos(all);
        });
      }).catch(function (err) {
        console.warn('사진 읽기 실패', err);
        toast('사진을 읽지 못해 사진 없이 백업해요', { duration: 4000 });
        photoCount = 0;
        return null;
      });
    } else {
      step = Promise.resolve(null);
    }

    step.then(function (photoBlob) {
      var blob = photoBlob || new Blob([headJson.slice(0, -1), ',"photos":[]}'], TYPE);
      // 파일 이름: imjang-backup-<기기 이름>-YYYY-MM-DD(-photos).json. 실제로 넣은 사진이 있을 때만 -photos
      var safeDev = fileSafeName(dev);
      var fname = 'imjang-backup-' + (safeDev ? safeDev + '-' : '') + todayISO() + (photoBlob && photoCount ? '-photos' : '') + '.json';
      var shareFile = null;
      try {
        var f = new File([blob], fname, TYPE);
        if (navigator.canShare && navigator.canShare({ files: [f] })) shareFile = f;
      } catch (e) { shareFile = null; }
      var buttons = [];
      if (shareFile) {
        buttons.push({
          label: '공유하기 (파일에 저장·에어드롭·메일)', value: 'share', kind: 'accent',
          action: function () {
            navigator.share({ files: [shareFile], title: '임장 체크리스트 백업' })
              .then(markBackup)
              .catch(function (err) { if (!err || err.name !== 'AbortError') toast('공유하지 못했어요. 내려받기를 써 보세요.'); });
          }
        });
      }
      buttons.push({
        label: '파일로 내려받기', value: 'download', kind: shareFile ? 'secondary' : 'primary',
        action: function () {
          downloadBlob(blob, fname);
          // 취소했거나 홈 화면 앱에서 내려받기가 안 됐을 수 있으니, 저장을 확인한 뒤에만 '마지막 백업'을 남긴다
          toast('파일 앱의 "다운로드" 폴더에 저장됐는지 확인해 주세요.', {
            duration: 20000,
            action: { label: '저장 확인함', fn: markBackup }
          });
        }
      });
      buttons.push({ label: '닫기', value: null, kind: 'secondary' });
      hideToast();
      openDialog({
        title: '백업 파일이 준비됐어요',
        message: fname + '\n크기: ' + bytesText(blob.size) +
          (photoBlob ? ' · 사진 ' + photoCount + '장 포함' : (includePhotos ? ' · 사진 없이 만들었어요' : '')) +
          '\n\niPhone 에서는 "공유하기 → 파일에 저장"이 가장 확실해요.' +
          (isStandalone() && !shareFile ? '\n홈 화면 앱에서는 내려받기가 안 될 수 있어요. 안 되면 iOS 를 최신으로 업데이트해 주세요.' : ''),
        buttons: buttons
      });
    });
  }

  function validPhotoEntry(p) {
    return p && typeof p === 'object' && typeof p.id === 'string' && typeof p.propertyId === 'string' &&
      typeof p.dataUrl === 'string' && p.dataUrl.indexOf('data:image/') === 0;
  }

  function importPhotos(entries, skipExisting) {
    var known = {};
    state.properties.forEach(function (p) { known[p.id] = true; });
    var added = 0;
    var chain = Promise.resolve();
    entries.forEach(function (p) {
      if (!known[p.propertyId]) return;
      chain = chain.then(function () {
        return (skipExisting ? Photos.get(p.id) : Promise.resolve(null)).then(function (exists) {
          if (exists) return;
          var blob = dataURLToBlob(p.dataUrl);
          return Photos.put({
            id: p.id, propertyId: p.propertyId,
            itemId: typeof p.itemId === 'string' ? p.itemId : null,
            sectionId: typeof p.sectionId === 'string' ? p.sectionId : null,
            blob: blob, createdAt: numOrNull(p.createdAt) || Date.now()
          }).then(function () { added++; });
        }).catch(function (err) { console.warn('사진 불러오기 실패', err); });
      });
    });
    return chain.then(function () { return added; });
  }

  var BIG_IMPORT_BYTES = 150 * 1024 * 1024;

  /** 백업 data 에서 예전 버전(1.2.x 이하) 앱이 쓴 매물 수: 1.3.0 변경 시각(fieldsAt)이 아예 없는 매물 */
  function legacyCount(data) {
    return (Array.isArray(data.properties) ? data.properties : []).filter(function (p) {
      return p && typeof p === 'object' && (!p.fieldsAt || typeof p.fieldsAt !== 'object');
    }).length;
  }

  /**
   * 지금 기록(다른 탭이 방금 쓴 것까지)에 백업을 합친 결과를 계산만 한다(저장하지 않음). 확인 창과 doImport 가 같이 쓴다.
   * allowDelete: merge.js mergeStates 의 같은 이름 옵션({ id: true } 만 지움, 없으면 모두)
   * 결과: { state, report, before(합치기 전 이 기기 매물 id → true) }
   */
  function computeMerge(incoming, allowDelete) {
    pullFromStorage();
    var candidate = normalizeState(JSON.parse(JSON.stringify(state)));
    candidate.ui = Object.assign({}, state.ui); // 이 기기 설정(기기 이름 등)은 그대로
    var before = {};
    candidate.properties.forEach(function (p) { before[p.id] = true; });
    var r = MG.mergeStates(candidate, incoming, { now: Date.now(), keepMs: TOMBSTONE_KEEP_MS, goneMax: GONE_KEYS_MAX, allowDelete: allowDelete });
    r.before = before;
    return r;
  }

  /** 대화상자에 넣을 매물 이름 목록(10개까지 + "외 N개") */
  function nameList(list) {
    var NAMES_MAX = 10;
    var names = list.slice(0, NAMES_MAX).map(function (p) { return h('li', { text: p.name || '이름 없는 매물' }); });
    if (list.length > NAMES_MAX) names.push(h('li', { class: 'muted', text: '외 ' + (list.length - NAMES_MAX) + '개' }));
    return h('ul', { class: 'merge-names' }, names);
  }

  function importBackup(file) {
    var ask = file.size > BIG_IMPORT_BYTES
      ? confirmDialog({
        title: '아주 큰 백업 파일이에요',
        message: '파일 크기가 ' + bytesText(file.size) + '예요. iPhone 에서 불러오다가 앱이 다시 열릴 수 있어요. 다른 앱을 닫고 충전 중에 해 보세요.',
        confirmText: '불러오기'
      })
      : Promise.resolve(true);
    ask.then(function (go) {
      if (!go) return;
      toast('백업 파일을 읽는 중…', { duration: 0 });
      return readFileText(file).then(function (text) {
        hideToast();
        var obj = parseStored(text);
        text = null;
        if (!obj) {
          alertDialog('백업 파일을 읽지 못했어요', 'JSON 형식이 아니에요. 이 앱에서 만든 백업 파일인지 확인해 주세요.');
          return;
        }
        var data = obj.data && Array.isArray(obj.data.properties) ? obj.data
          : (Array.isArray(obj.properties) ? obj : null);
        if (!data) {
          alertDialog('백업 파일이 아니에요', '이 파일에서 매물 기록을 찾지 못했어요.');
          return;
        }
        // 1.3.0: 백업 속 삭제 표시(deleted)·지운 매물 열쇠(goneKeys)도 읽는다. [합치기]가 백업을 만든 기기에서 지운 매물을 맞춘다
        // ([덮어쓰기]는 예전처럼 이 기기의 삭제 표시만 쓴다). 백업의 ui(기기 이름 등)·localDeleted 는 쓰지 않는다
        var oldN = legacyCount(data); // 1.3.1: 예전 버전 앱이 쓴 매물(항목별 시각 없음)
        var incoming = normalizeState(data);
        var photos = Array.isArray(obj.photos) ? obj.photos.filter(validPhotoEntry) : [];
        var origin = backupOrigin(obj);
        obj = null;
        data = null;
        // 1.3.1: 합치면 이 기기에서 지워질 매물 수를 미리 계산해 보여 준다(저장하지 않음)
        var willDelete = MG ? computeMerge(incoming).report.removed.length : 0;
        var info = { legacy: oldN, photoCount: photos.length };
        return openDialog({
          title: '백업 불러오기',
          message: origin + ' · 매물 ' + incoming.properties.length + '개' + (photos.length ? ' · 사진 ' + photos.length + '장' : ' · 사진 없음') + '\n\n' +
            '· 합치기(권장): 두 기록을 항목마다 합쳐요. 같은 항목은 더 최근에 고친 쪽을 남기고, 백업을 만든 기기에서 지운 매물은 여기서도 지워요.' +
            (willDelete ? ' 지금 합치면 이 기기에서 매물 ' + willDelete + '개가 지워져요(다음 화면에서 확인).' : '') + '\n' +
            '· 덮어쓰기: 이 기기의 지금 기록을 모두 지우고 백업 내용으로 바꿔요.',
          content: oldN ? h('div', { class: 'dlg-warn' },
            h('strong', { text: '예전 버전 앱에서 만든 백업이에요' + (oldN < incoming.properties.length ? ' (매물 ' + oldN + '개)' : '') }),
            h('p', { text: '항목별로 정확히 합치지 못해, 이 기기에서 고친 내용이 그 기기의 예전 값으로 덮일 수 있어요. 그 기기를 인터넷에 연결해 앱을 새로고침(업데이트)한 뒤 새로 백업해 오세요.' })) : null,
          buttons: [
            { label: '합치기', value: 'merge' },
            { label: '덮어쓰기', value: 'replace', kind: 'danger-ghost' }, // 위험하지만 주 버튼은 아님(합치기가 기본)
            { label: '취소', value: null, kind: 'secondary' }
          ]
        }).then(function (r) {
          if (r.value === 'merge') {
            if (!MG) return doImport('merge', incoming, photos, info); // "합치지 못했어요" 안내
            return confirmMergeDeletes(incoming).then(function (allow) {
              if (!allow) return;
              info.allowDelete = allow;
              return doImport('merge', incoming, photos, info);
            });
          }
          if (r.value === 'replace') {
            return confirmDialog({
              title: '정말 덮어쓸까요?',
              message: '지금 이 기기에 있는 매물 ' + state.properties.length + '개와 사진이 모두 지워지고 백업 내용으로 바뀌어요. 다른 기기의 기록은 그대로예요.',
              confirmText: '덮어쓰기', danger: true
            }).then(function (ok) { if (ok) return doImport('replace', incoming, photos, info); });
          }
        });
      });
    }).catch(function (err) {
      console.warn('백업 불러오기 실패', err);
      hideToast();
      toast('파일을 열지 못했어요');
    });
  }

  /**
   * [합치기] 직전(1.3.1): 백업을 만든 기기에서 지운 매물이라 이 기기에서도 지워질 것이 있으면, 이름을 보여 주고 고르게 한다.
   * 사진까지 지워지고 되돌릴 수 없어서, 모르는 사이 한꺼번에 지워지지 않게 한다.
   * 결과 Promise: 지워도 되는 매물 { id: true }(지울 것이 없거나 [지우지 않고 합치기]면 {}), [취소]면 null
   */
  function confirmMergeDeletes(incoming) {
    var list = computeMerge(incoming).report.removed;
    if (!list.length) return Promise.resolve({});
    var all = list.length >= state.properties.length;
    return openDialog({
      title: all ? '이 기기의 매물이 모두 지워져요' : '매물 ' + list.length + '개가 지워져요',
      message: '백업을 만든 기기에서 지운 매물이라, 합치면 이 기기에서도 지워져요. 사진도 함께 지워지고 되돌릴 수 없어요.' +
        (all ? '\n맞는 백업 파일인지, 그 기기에서 정말 모두 지웠는지 확인하세요.' : ''),
      content: nameList(list),
      buttons: [
        { label: '지우고 합치기', value: 'delete', kind: 'danger' },
        { label: '지우지 않고 합치기', value: 'keep', kind: 'secondary' }, // 위험 대화상자라 첫 초점이 여기로 간다
        { label: '취소', value: null, kind: 'secondary' }
      ]
    }).then(function (r) {
      if (r.value === 'delete') {
        var ok = {};
        list.forEach(function (p) { ok[p.id] = true; }); // 보여 준 매물만 지운다(그사이 늘어난 것은 남김)
        return ok;
      }
      return r.value === 'keep' ? {} : null;
    });
  }

  /** 백업 파일이 어디서 언제 만들어졌는지: "iPad에서 10월 9일 21:10에 만든 백업" (1.2.x 백업은 기기 이름이 없음) */
  function backupOrigin(obj) {
    var meta = obj && obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
    var dev = cleanDeviceName(meta.deviceName);
    var at = numOrNull(meta.createdAt) || Date.parse(str(obj && obj.exportedAt)) || null;
    var when = at ? shortDateTime(at) + '에 ' : '';
    if (dev) return dev + '에서 ' + when + '만든 백업';
    return when ? when + '만든 백업' : '만든 때를 알 수 없는 백업';
  }

  /**
   * 합친 뒤 같은 매물로 보이는 쌍(1.3.1): 이 기기에 있던 매물과 백업에서 새로 들어온 매물의 매물번호나 링크가 같으면.
   * 두 기기에서 같은 매물을 따로 "코드로 매물 추가"하면 id 가 달라 둘 다 남는다. 결과 창에서 알려 준다
   */
  function crossDuplicates(before, props) {
    if (!IMP) return [];
    var olds = [];
    var news = [];
    props.forEach(function (p) { (hasOwn(before, p.id) ? olds : news).push({ p: p, info: IMP.dupInfo(p) }); });
    var out = [];
    news.forEach(function (n) {
      for (var i = 0; i < olds.length; i++) {
        var by = IMP.sameListing(n.info, olds[i].info);
        if (by === 'a' || by === 'u') {
          var a = olds[i].p.name || '이름 없는 매물';
          var b = n.p.name || '이름 없는 매물';
          out.push({ id: n.p.id, name: a === b ? a + ' (2개)' : a + ' · ' + b });
          return;
        }
      }
    });
    return out;
  }

  /**
   * 불러오기. 새 기록을 먼저 저장소에 써 보고, 성공했을 때만 메모리의 state 를 바꾸고 사진을 정리한다.
   * (저장이 실패했는데 사진부터 지우는 일이 없도록)
   * - 합치기(1.3.0): merge.js mergeStates. 항목 단위로 합치고, 양쪽 삭제 표시를 지운 시각과 비교해 반영한다.
   *   info.allowDelete(1.3.1): 확인 창에서 지워도 된다고 한 매물만 지운다.
   * - 덮어쓰기: 매물 목록을 백업으로 바꾼다. 1.3.1: 지금 매물은 localDeleted(이 기기 초기화)로 표시해 이 기기의 다른 탭만
   *   맞추고, 백업에 실어 다른 기기로 보내지 않는다(deleted 에 넣으면 다른 기기 [합치기]에서 그 기기 매물까지 지워짐).
   * info: { legacy(예전 버전 매물 수), photoCount(백업 속 사진 수), allowDelete }
   */
  function doImport(mode, incoming, photos, info) {
    info = info || {};
    if (mode === 'merge' && !MG) {
      alertDialog('합치지 못했어요', '합치기에 필요한 앱 파일(merge.js)을 불러오지 못했어요. 인터넷에 연결한 뒤 새로고침하고 다시 해 주세요. 지금 기록은 그대로 두었어요.');
      return Promise.resolve();
    }
    var candidate;
    var report = null;
    var dups = [];

    if (mode === 'replace') {
      pullFromStorage(); // 다른 탭이 방금 쓴 내용까지 포함해서 계산
      var now = Date.now();
      candidate = normalizeState(JSON.parse(JSON.stringify(state)));
      candidate.ui = Object.assign({}, state.ui); // 이 기기 설정(기기 이름 등)은 그대로
      // 지금 매물은 모두 "이 기기 초기화"로 표시: 다른 탭의 예전 사본을 버리게(그 시각은 매물의 마지막 변경보다 나중)
      var stamp = now;
      candidate.properties.forEach(function (p) { stamp = stampAfter(stamp, p.updatedAt); });
      candidate.properties.forEach(function (p) { candidate.localDeleted[p.id] = stamp; });
      candidate.properties = incoming.properties;
      // 예전에 지운 매물을 백업으로 되살리는 경우: '지움' 표시를 없애고 지금 고친 것으로 본다(지운 시각보다 늘 나중)
      candidate.properties.forEach(function (p) {
        if (candidate.deleted[p.id]) {
          p.updatedAt = stampAfter(now, p.updatedAt, candidate.deleted[p.id]);
          delete candidate.deleted[p.id];
        }
      });
    } else {
      var merged = computeMerge(incoming, info.allowDelete);
      candidate = merged.state;
      report = merged.report;
      dups = crossDuplicates(merged.before, candidate.properties);
    }

    if (!tryWriteState(candidate)) {
      alertDialog('불러오지 못했어요', '저장 공간이 부족하거나 저장이 막혀 있어요. 지금 기록과 사진은 그대로 두었어요. 사진 없이 만든 백업 파일로 다시 해 보세요.');
      return Promise.resolve();
    }
    state = candidate;
    dirty = false;
    lastSavedAt = Date.now();
    if (saveFailed) { saveFailed = false; showSaveError(null); }

    var photoStep = mode === 'replace'
      ? Photos.clear().catch(function (err) { console.warn('사진 비우기 실패', err); }).then(function () { return importPhotos(photos, false); })
      : importPhotos(photos, true);
    toast('사진을 넣는 중…', { duration: 0 });
    return photoStep.then(function (added) {
      if (view.name === 'settings') renderSettings();
      if (mode === 'replace') {
        toast('백업으로 바꿨어요: 매물 ' + state.properties.length + '개' + (added ? ', 사진 ' + added + '장' : ''), { duration: 4000 });
        focusImportCard();
        return;
      }
      hideToast();
      if (report.deleted) cleanDeletedPhotos(); // 백업을 만든 기기에서 지운 매물의 사진도 이 기기에서 정리
      // 다시 그린 설정 화면 위에 결과를 띄우고, 닫으면 "백업 불러오기" 제목으로 초점을 옮긴다(예전 버튼은 사라졌으므로)
      return showMergeResult(report, added, { dups: dups, legacy: info.legacy, photoCount: info.photoCount }).then(focusImportCard);
    });
  }

  /** 불러오기를 마친 뒤 설정 화면의 "백업 불러오기" 제목에 초점(VoiceOver 가 제자리에서 이어 읽게) */
  function focusImportCard() {
    if (view.name !== 'settings') return;
    var t = document.getElementById('set-import');
    if (!t) return;
    t.setAttribute('tabindex', '-1');
    try { t.focus(); } catch (e) { /* 무시 */ }
  }

  /**
   * [합치기] 결과 대화상자: 추가·합침·삭제·사진 수와, 지운 뒤 고친 매물·되살린 매물 등의 이름 목록.
   * extra: { dups(같은 매물로 보이는 쌍), legacy(예전 버전 앱이 쓴 매물 수), photoCount(백업 속 사진 수) }
   */
  function showMergeResult(rep, photosAdded, extra) {
    extra = extra || {};
    var dups = extra.dups || [];
    var added = rep.added + rep.revived.length;
    var mergedN = rep.merged + rep.updated;
    var sameHere = !added && !mergedN && !rep.deleted && !photosAdded; // 이 기기 기록은 그대로
    var notes = rep.keptAfterDelete.length + rep.keptLocal.length + rep.revived.length + rep.skipped.length + dups.length; // 따로 알려 줄 매물
    function group(cls, title, desc, list) {
      if (!list.length) return null;
      return h('div', { class: 'merge-group ' + cls },
        h('h3', { class: 'merge-group-title', text: title + ' ' + list.length + '개' }),
        h('p', { class: 'small', text: desc }),
        nameList(list));
    }
    var content = h('div', { class: 'merge-result' },
      h('p', { class: 'merge-sum' },
        h('span', { text: '추가 ' + added }), ' · ',
        h('span', { text: '합침 ' + mergedN + (mergedN && rep.items ? '(항목 ' + rep.items + '개)' : '') }), ' · ',
        h('span', { text: '삭제 ' + rep.deleted }), ' · ',
        h('span', { text: '사진 ' + (photosAdded || 0) + '장' })),
      // 이 기기는 그대로지만 이 기기에만 있는 내용이 있으면 "백업과 같았다"고 하지 않는다
      sameHere ? h('p', { class: 'small muted', text: notes || rep.incomingBehind ? '이 기기 기록은 그대로예요.' : '바뀐 것이 없어요. 이미 백업과 같은 기록이었어요.' }) : null,
      extra.legacy ? h('div', { class: 'dlg-warn' },
        h('strong', { text: '예전 버전 앱에서 만든 백업이었어요' }),
        h('p', { text: '항목별로 정확히 합치지 못했을 수 있어요. 그 기기를 업데이트한 뒤 새로 백업해 다시 맞춰 주세요.' })) : null,
      group('is-kept', '지운 뒤 고친 매물', '백업을 만든 기기에서는 지웠지만, 이 기기에서 그 뒤에 고쳐서 남겨 뒀어요. 필요 없으면 직접 지워 주세요.', rep.keptAfterDelete),
      group('is-kept', '지우지 않고 남긴 매물', '백업을 만든 기기에서는 지운 매물이에요. 그 기기에도 다시 넣으려면 여기서 백업 파일을 만들어 그 기기에서 [합치기] 하세요. 필요 없으면 직접 지워 주세요.', rep.keptLocal),
      group('is-revived', '되살린 매물', '이 기기에서 지웠지만, 백업을 만든 기기에서 그 뒤에 고쳐서 다시 넣었어요.', rep.revived),
      group('', '지운 매물', '백업을 만든 기기에서 지운 매물이라 여기서도 지웠어요.', rep.removed),
      group('', '넣지 않은 매물', '이 기기에서 지운 매물이라 넣지 않았어요. 그 기기에서도 지우려면 여기서 백업 파일을 만들어 그 기기에서 [합치기] 하세요.', rep.skipped),
      group('is-kept', '같은 매물로 보이는 것', '두 기기에서 따로 추가한 같은 매물로 보여요(매물번호나 링크가 같음). 하나를 지우기 전에 양쪽의 체크 기록과 사진을 확인하세요. 지운 쪽의 기록과 사진은 함께 사라져요.', dups),
      extra.photoCount === 0 ? h('p', { class: 'small muted', text: '이 백업에는 사진이 없어요. 사진도 옮기려면 그 기기에서 "사진도 함께 넣기"를 켜고 백업하세요.' }) : null,
      rep.incomingBehind
        ? h('p', { class: 'small muted', text: '이 기기에만 있던 내용도 있어요. 백업을 만든 기기도 맞추려면 여기서 백업 파일을 만들어 그 기기에서 [합치기] 하세요.' })
        : (sameHere ? null : h('p', { class: 'small muted', text: '이제 이 기기 기록이 백업과 같아요.' }))
    );
    return openDialog({ title: sameHere && !notes ? '합쳤어요 · 바뀐 것 없음' : '합쳤어요', content: content, buttons: [{ label: '확인', value: true }] });
  }

  function wipeAll() {
    confirmDialog({
      title: '모든 기록을 지울까요?',
      message: '매물 ' + state.properties.length + '개와 체크 기록, 사진이 이 기기에서 모두 지워져요. 다른 기기의 기록은 그대로예요(그 기기 백업을 [합치기] 하면 그 기록이 다시 들어와요). 지우기 전에 백업을 권해요.',
      confirmText: '다음', danger: true
    }).then(function (ok) {
      if (!ok) return;
      return confirmDialog({
        title: '정말 지울까요? (2단계 확인)',
        message: '되돌릴 수 없어요. 아래 칸에 "삭제"라고 입력하면 지울 수 있어요.',
        match: '삭제',
        confirmText: '모두 지우기', danger: true
      }).then(function (ok2) {
        if (!ok2) return;
        pullFromStorage(); // 다른 탭에서 방금 추가한 매물까지 지운 것으로 표시
        var ui = state.ui;
        var del = Object.assign({}, state.deleted); // 그 전에 하나씩 지운 매물의 표시는 그대로(다른 기기에도 전함)
        var ld = Object.assign({}, state.localDeleted);
        // 1.3.1: 전체 삭제는 "이 기기 초기화"라 localDeleted 에만 남긴다. 이 기기의 다른 탭이 예전 기록을 다시 써 넣지 않게
        // 하되, 백업에는 넣지 않아 다른 기기 [합치기]에서 그 기기 매물이 지워지지 않는다(시각은 매물의 마지막 변경보다 나중)
        var stamp = Date.now();
        state.properties.forEach(function (p) { stamp = stampAfter(stamp, p.updatedAt); });
        state.properties.forEach(function (p) { ld[p.id] = stamp; });
        state = emptyState(); // goneKeys(지운 매물 열쇠)도 비운다: 처음부터 새로 시작
        state.deleted = del;
        state.localDeleted = ld;
        state.ui.dismissedInstallTip = ui.dismissedInstallTip;
        state.ui.deviceName = ui.deviceName; // 기기 이름은 이 기기 설정이라 남긴다
        state.ui.deviceNameAt = ui.deviceNameAt;
        dirty = true;
        saveNow();
        localRemove(DRAFT_KEY);
        try {
          Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('imjang.') === 0) sessionStorage.removeItem(k); });
        } catch (e) { /* 무시 */ }
        return Photos.clear().catch(function (err) {
          console.warn('사진 비우기 실패(다음에 다시 시도)', err);
        }).then(function () {
          revokeAllPhotoUrls();
          toast('모든 기록을 지웠어요');
          navigate('/', true);
        });
      });
    });
  }

  /** 지운 매물의 사진이 남아 있으면(지울 때 저장소 연결이 끊겼던 경우) 조용히 정리한다. 전체 삭제·덮어쓰기로 지운 매물 포함 */
  function cleanDeletedPhotos() {
    if (loadProblem) return; // 기록을 제대로 못 읽었으면 아무것도 지우지 않는다
    var alive = {};
    state.properties.forEach(function (p) { alive[p.id] = true; });
    var gone = Object.assign({}, state.localDeleted, state.deleted);
    var ids = Object.keys(gone).filter(function (id) { return !alive[id]; });
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () { return Photos.removeByProperty(id); });
    });
    chain.catch(function (err) { console.warn('지운 매물 사진 정리 실패', err); });
  }

  // ---------------- 코드로 매물 추가 (Claude 가져오기 코드) ----------------
  // 네이버 부동산은 공식 API 가 없고 브라우저 CORS 때문에 앱이 직접 읽을 수 없다.
  // 그래서 사용자가 매물 화면(스크린샷·글·링크)을 Claude 채팅에 보내고, Claude 가 답한 "가져오기 코드"(JSON)를 여기에 붙여 넣는다.
  // 해석 규칙(코드 찾기·값 검사·중복 판단)은 import-parser.js 에 있다. tools/make-import-code.js 도 같은 파일을 쓴다.
  // 붙여 넣은 내용은 믿지 않는다: 값은 모두 textContent 로만 보여 주고, [N개 담기]를 눌러야 저장한다.

  /** "c=abc&x=1" 에서 값 하나 */
  function queryParam(query, name) {
    var parts = String(query || '').split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if ((eq < 0 ? parts[i] : parts[i].slice(0, eq)) === name) return eq < 0 ? '' : parts[i].slice(eq + 1);
    }
    return null;
  }

  function prettyJson(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  function importStep(n, title, desc) {
    return h('li', {},
      h('span', { class: 'isteps-num', 'aria-hidden': 'true', text: String(n) }),
      h('p', { class: 'isteps-title' }, h('span', { class: 'sr-only', text: n + '단계, ' }), title),
      h('p', { class: 'isteps-desc', text: desc }));
  }

  function renderImport(query) {
    var v = newView('import');
    setTopbar({ title: '코드로 매물 추가', back: '/' });
    updateTabbar('home');
    var main = resetMain();
    appendKid(main, inAppWarning()); // 카카오톡 등 앱 안 브라우저: 기록이 쉽게 지워진다
    if (!IMP) {
      main.append(h('div', { class: 'notice', role: 'alert' },
        h('strong', { text: '가져오기 기능을 불러오지 못했어요.' }),
        h('p', { text: 'import-parser.js 파일이 index.html 과 같은 폴더에 있는지 확인하고 새로고침해 주세요. 매물은 [매물 추가]로 직접 입력할 수 있어요.' }),
        h('a', { class: 'btn btn-small btn-secondary', href: '#/new' }, '매물 추가')));
      return;
    }

    // 딥링크 #/import?c=<base64url>: 같은 내용을 입력 칸에 채워 둔다(저장은 사용자가 [담기]를 눌러야).
    // 풀 수 없거나(잘린 링크 등) 풀어도 코드로 읽을 수 없으면 입력 칸을 비워 둔다.
    // 이때 지난번 글로 대신 채우지 않는다(링크와 상관없는 예전 매물이 미리보기에 나오지 않게)
    var code = queryParam(query, 'c');
    var linkText = null;
    var linkBad = false;
    if (code !== null) {
      var decoded = IMP.decodeLink(code);
      if (decoded !== null && IMP.parse(decoded).ok) linkText = prettyJson(decoded);
      else linkBad = true;
    }
    var linkMode = linkText !== null;
    var saved = code === null ? (sessionGet(IMPORT_TEXT_KEY) || '') : '';
    var initial = linkMode ? linkText : saved;
    // 링크나 지난번 글로 채운 뒤 아직 손대지 않았으면 true. 이때 새로 붙여 넣으면 뒤에 덧붙이지 않고 통째로 바꾼다
    var restored = !!initial;

    // 1) 방법 안내 + 요청문 (딥링크로 열면 접어 두고 미리보기를 먼저 보여 준다)
    var howBody = [
      h('ol', { class: 'isteps', role: 'list' },
        importStep(1, '네이버 부동산 매물 화면을 캡처해요', '글을 복사하거나 매물 링크를 보내도 돼요.'),
        importStep(2, 'Claude 앱 채팅에 요청문과 함께 보내요', '[요청문 복사]를 누른 뒤 채팅창에 붙여 넣고, 캡처한 화면을 첨부해요.'),
        importStep(3, 'Claude가 준 코드를 아래에 붙여 넣어요', '답변 전체를 복사해도 돼요. 코드만 찾아 읽어요. 코드가 여러 개면 모두 읽어요.')),
      h('button', {
        type: 'button', class: 'btn btn-secondary btn-block',
        onclick: function () { copyText(IMP.PROMPT, { ok: '요청문을 복사했어요. Claude 채팅에 붙여 넣으세요.', title: '요청문' }); }
      }, icon('copy', 'ic-sm'), '요청문 복사'),
      h('details', { class: 'prompt-box' },
        h('summary', {}, '요청문 펼쳐 보기'),
        h('pre', { class: 'prompt-text', text: IMP.PROMPT })),
      h('p', { class: 'small muted', text: '호수는 네이버 부동산에 없어서 담은 뒤 직접 입력해요. Claude가 화면의 숫자를 잘못 읽을 수 있으니 미리보기에서 꼭 확인하세요.' })
    ];
    var howEl = linkMode
      ? h('details', { class: 'card flow-details imp-how-more' }, h('summary', {}, 'Claude로 매물 정보 가져오는 방법'), howBody)
      : h('section', { class: 'card', 'aria-labelledby': 'imp-how' },
        h('h2', { class: 'card-title', id: 'imp-how', text: 'Claude로 매물 정보 가져오기' }), howBody);

    // 2) 붙여넣기
    var ta = h('textarea', {
      class: 'input imp-text', id: 'imp-text', rows: 7, value: initial,
      placeholder: '여기를 길게 눌러 [붙여넣기]', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      'aria-describedby': 'imp-text-hint'
    });
    // 클립보드 읽기는 지원할 때만(HTTPS·localhost). iPhone 은 누르면 [붙여넣기] 말풍선이 한 번 더 뜬다.
    // 딥링크로 열었으면 링크 내용을 덮어쓰지 않게 눈에 덜 띄는 보조 버튼으로
    var canRead = !!(navigator.clipboard && navigator.clipboard.readText && window.isSecureContext);
    var pasteBtn = canRead ? h('button', { type: 'button', class: 'btn btn-block ' + (linkMode ? 'btn-secondary' : 'btn-accent') }, icon('paste', 'ic-sm'), '클립보드에서 붙여넣기') : null;
    var clearBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', hidden: !initial }, '지우기');
    // 지난번에 붙여 넣은 글을 되살렸을 때(Claude 앱에 다녀오는 사이 페이지가 다시 열려도 남게 보관함): 조용히 채우지 않고 알린다
    var restoredNote = saved ? h('div', { class: 'notice notice-info', role: 'note' },
      h('strong', { text: '지난번에 붙여 넣은 코드예요' }),
      h('p', { text: '새 코드를 붙여 넣으면 이 글을 바꿔요. 필요 없으면 [지우기]를 누르세요.' })) : null;
    var pasteCard = h('section', { class: 'card', 'aria-labelledby': 'imp-paste' },
      h('h2', { class: 'card-title', id: 'imp-paste' }, h('label', { for: 'imp-text', text: 'Claude가 준 코드' })),
      linkBad ? h('p', { class: 'notice', role: 'alert', text: '링크 속 코드를 읽지 못했어요. 링크가 잘렸을 수 있어요. Claude 답변의 코드를 복사해 붙여 주세요.' }) : null,
      restoredNote,
      pasteBtn,
      ta,
      h('div', { class: 'imp-text-foot' },
        h('p', { class: 'field-hint', id: 'imp-text-hint', text: '붙여 넣으면 미리보기가 나와요. 아직 저장되지 않아요.' }),
        clearBtn)
    );

    // 딥링크 안내. iPhone 에서 링크는 늘 Safari 탭(또는 앱 안 브라우저)으로 열리고, 홈 화면 앱과 저장 공간이 따로다.
    // 홈 화면 앱을 쓰는 사람이 여기서 담으면 매물이 홈 화면 앱에 보이지 않으므로 [코드 복사]로 옮기게 한다
    var installed = isStandalone() || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var linkCard = linkMode ? h('section', { class: 'card imp-link', 'aria-labelledby': 'imp-link-title' },
      h('h2', { class: 'card-title', id: 'imp-link-title', text: '링크로 받은 코드를 채워 두었어요' }),
      h('p', { class: 'small muted', text: '아래 미리보기를 네이버 화면과 비교하고 [담기]를 눌러야 저장돼요. 호수는 담은 뒤 직접 입력해요.' }),
      installed ? null : h('div', { class: 'notice notice-ho', role: 'note' },
        h('strong', { text: isIOS() ? '홈 화면 앱을 쓰고 있다면 여기서 담지 마세요' : '평소 다른 기기나 앱에서 쓴다면 여기서 담지 마세요' }),
        h('p', {
          text: isIOS()
            ? '링크는 Safari(또는 앱 안 브라우저)로 열려요. 홈 화면 앱과는 저장 공간이 따로라서, 여기서 담은 매물은 홈 화면 앱에 보이지 않아요.'
            : '여기서 담은 매물은 링크를 연 이 브라우저에만 저장돼요. 다른 기기나 홈 화면 앱에는 보이지 않아요.'
        }),
        h('p', { text: '[코드 복사]를 누른 뒤, 평소 쓰는 앱의 [코드로 추가]에 붙여 넣으세요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-secondary',
          onclick: function () { copyText(ta.value || linkText, { ok: '코드를 복사했어요. 평소 쓰는 앱의 [코드로 추가]에 붙여 넣으세요.', title: '가져오기 코드' }); }
        }, icon('copy', 'ic-sm'), '코드 복사'))
    ) : null;

    // 3) 미리보기와 [N개 담기]
    // 상태 줄은 처음부터 화면에 둔 빈 알림 영역(나중에 붙이면 VoiceOver 가 읽지 않을 수 있음). 오류는 따로 role=alert 영역에
    var status = h('div', { class: 'imp-status', role: 'status', 'aria-live': 'polite' });
    var errBox = h('div', { class: 'imp-error', role: 'alert' });
    var hint = h('p', { class: 'small muted imp-hint', hidden: true, text: '담은 뒤 호수를 입력하면 등기부를 열람할 수 있어요.' });
    var list = h('div', { class: 'imp-list' });
    var submitBtn = h('button', { type: 'button', class: 'btn btn-block', disabled: true }, '담기');
    var actions = h('div', { class: 'imp-actions', hidden: true }, submitBtn);
    var resultEl = h('section', { class: 'imp-result', 'aria-label': '미리보기' }, errBox, status, hint, list, actions);

    // 딥링크: 안내 → 미리보기 → 입력 칸 → (접힌) 방법 안내. 보통: 방법 안내 → 입력 칸 → 미리보기
    if (linkMode) main.append(linkCard, resultEl, pasteCard, howEl);
    else main.append(howEl, pasteCard, resultEl);

    var current = null; // 마지막 해석 결과
    var picks = {};     // 사용자가 바꾼 담기 선택 (코드를 조금 고쳐도 유지)
    var timer = null;
    var done = false;   // [담기]를 이미 눌렀음: 빠르게 두 번 눌러 같은 매물이 두 벌 저장되지 않게
    var lastStatus = null;
    var lastError = null;

    function entryKey(e) { return e.index + '|' + e.prop.name; }
    function isOn(e) {
      var k = entryKey(e);
      return e.canImport && (hasOwn(picks, k) ? picks[k] : e.checked);
    }
    function chosen() { return current && current.ok ? current.entries.filter(isOn) : []; }

    function refreshCount() {
      if (done) return; // 담는 중: 다시 살리지 않는다
      var n = chosen().length;
      submitBtn.disabled = !n;
      submitBtn.textContent = n ? n + '개 담기' : '담을 매물을 골라 주세요';
    }

    function previewCard(e) {
      var p = e.prop;
      var k = entryKey(e);
      var on = isOn(e);
      var base = 'imp-' + e.index;
      var size = [p.dong ? p.dong + '동' : '', p.area ? '전용 ' + p.area + '㎡' : '', p.supplyArea ? '공급 ' + p.supplyArea + '㎡' : ''].filter(Boolean).join(' · ');
      var price = [p.askPrice ? '호가 ' + formatManwon(p.askPrice) : '호가 없음', p.tradeType].filter(Boolean).join(' · ');
      var spec = [floorText(p.floor), p.direction].filter(Boolean).join(' · ');
      var agent = [p.agentName, p.agentPhone].filter(Boolean).join(' ');
      var warnEl = e.warnings.length ? h('span', { class: 'imp-warns', id: base + '-warn' }, e.warnings.map(function (w) {
        return h('span', { class: 'imp-warn w-' + w.code, text: w.text });
      })) : null;
      var notesEl = e.notes.length ? h('span', { class: 'imp-notes', id: base + '-notes', text: e.notes.join(' · ') }) : null;
      // 같은 단지 매물이 여러 개여도 구분되게 이름 + 동·면적 + 가격 + 층·방향을 읽고, 경고·참고 문구를 설명으로 붙인다
      var cb = h('input', {
        type: 'checkbox', class: 'imp-check', id: base + '-cb', checked: on, disabled: !e.canImport,
        'aria-labelledby': [base + '-name', size ? base + '-size' : '', base + '-price', spec ? base + '-spec' : ''].filter(Boolean).join(' '),
        'aria-describedby': [warnEl ? base + '-warn' : '', notesEl ? base + '-notes' : ''].filter(Boolean).join(' ') || null
      });
      var card = h('label', { class: 'imp-card' + (on ? '' : ' is-off') + (e.canImport ? '' : ' is-bad'), for: base + '-cb' },
        cb,
        h('span', { class: 'imp-main' },
          h('strong', { class: 'imp-name', id: base + '-name', text: p.name || '단지명 없음' }),
          size ? h('span', { class: 'imp-line', id: base + '-size', text: size }) : null,
          h('span', { class: 'imp-price', id: base + '-price', text: price }),
          p.realPrice ? h('span', { class: 'imp-line', text: '최근 실거래 ' + formatManwon(p.realPrice) }) : null,
          spec ? h('span', { class: 'imp-line', id: base + '-spec', text: spec }) : null,
          agent ? h('span', { class: 'imp-line', text: '중개사 ' + agent }) : null,
          p.sourceUrl ? h('span', { class: 'imp-line', text: '링크 ' + hostOf(p.sourceUrl) }) : null,
          warnEl,
          notesEl
        ));
      cb.addEventListener('change', function () {
        picks[k] = cb.checked;
        card.classList.toggle('is-off', !cb.checked);
        refreshCount();
      });
      return card;
    }

    /** 상태 줄: 내용이 같으면 다시 쓰지 않는다(입력할 때마다 VoiceOver 가 되풀이해 읽지 않게) */
    function setStatus(lines) {
      var sig = lines.join('\n');
      if (sig === lastStatus) return;
      lastStatus = sig;
      status.textContent = '';
      lines.forEach(function (t, i) { status.append(i ? h('span', { class: 'imp-status-sub', text: t }) : h('strong', { text: t })); });
    }
    function setError(msg) {
      if (msg === lastError) return;
      lastError = msg;
      errBox.textContent = '';
      if (msg) errBox.append(h('strong', { text: msg }));
    }

    function draw() {
      var r = current;
      list.textContent = '';
      if (!r || r.error === 'empty' || !r.ok) {
        setStatus([]);
        setError(r && !r.ok ? r.message : '');
        hint.hidden = true;
        actions.hidden = true;
        return;
      }
      setError('');
      var offN = r.entries.filter(function (e) { return e.canImport && !e.checked; }).length;
      var dupN = r.entries.filter(function (e) { return e.warnings.some(function (w) { return w.code === 'exists' || w.code === 'gone' || w.code === 'repeat'; }); }).length;
      var lines = [
        (r.blocks > 1 ? '코드 ' + r.blocks + '개에서 ' : '') + '매물 ' + r.entries.length + '개를 찾았어요',
        !offN ? '숫자가 화면과 맞는지 확인하고 담으세요.'
          : dupN === offN ? '이미 있는 매물 ' + dupN + '개는 빼 두었어요. 담을 매물만 체크하세요.'
            : '확인이 필요한 매물 ' + offN + '개는 체크를 빼 두었어요. 경고를 읽고 담을 매물만 체크하세요.'
      ];
      if (r.truncated) lines.push('한 번에 ' + IMP.LIMITS.properties + '개까지 담을 수 있어요. 앞의 ' + IMP.LIMITS.properties + '개만 보여 줘요.');
      if (r.skipped) lines.push('읽을 수 없는 항목 ' + r.skipped + '개는 뺐어요.');
      if (r.incomplete) lines.push('글이 길어 뒷부분은 읽지 못했어요. 코드 부분만 붙여 넣어 주세요.');
      setStatus(lines);
      r.entries.forEach(function (e) { list.append(previewCard(e)); });
      hint.hidden = false;
      actions.hidden = false;
      refreshCount();
    }

    function parseNow() {
      clearTimeout(timer);
      timer = null;
      current = IMP.parse(ta.value, { existing: state.properties, goneKeys: state.goneKeys });
      draw();
    }

    function onTextChange() {
      var text = ta.value;
      clearBtn.hidden = !text;
      if (text && text.length <= IMP.LIMITS.inputChars) sessionSet(IMPORT_TEXT_KEY, text);
      else sessionRemove(IMPORT_TEXT_KEY);
      clearTimeout(timer);
      timer = setTimeout(parseNow, 250);
    }

    /** 사용자가 글을 바꿨다: 되살린 글 안내를 닫는다 */
    function markEdited() {
      restored = false;
      if (restoredNote) restoredNote.hidden = true;
    }

    function scrollToEl(el) {
      try { el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } catch (e) { /* 무시 */ }
    }
    /**
     * 붙여 넣은 직후. 미리보기와 [담기]가 입력 칸 아래에 있어 키보드에 가려지므로,
     * 읽혔으면 키보드를 내리고 미리보기로 옮긴다. 못 읽었으면 키보드는 두고 오류 안내로 옮긴다
     */
    function afterPaste() {
      if (!current || current.error === 'empty') return;
      if (current.ok) {
        if (document.activeElement === ta) { try { ta.blur(); } catch (e) { /* 무시 */ } }
        scrollToEl(status);
      } else {
        scrollToEl(errBox);
      }
    }

    ta.addEventListener('input', function () { markEdited(); onTextChange(); });
    // 길게 눌러 [붙여넣기]: 되살린 글이 있으면 그 뒤(또는 커서 자리)에 덧붙지 않게 통째로 바꾼다
    ta.addEventListener('paste', function (e) {
      var t = '';
      try { t = e.clipboardData ? (e.clipboardData.getData('text/plain') || e.clipboardData.getData('text')) : ''; } catch (err) { t = ''; }
      if (restored && ta.value && t && t.trim()) {
        e.preventDefault();
        ta.value = t;
        picks = {};
        onTextChange();
      }
      markEdited();
      // 붙여넣기가 입력 칸에 들어간 뒤(input 이벤트 다음)에 바로 해석한다
      setTimeout(function () {
        if (view !== v) return;
        parseNow();
        afterPaste();
      }, 0);
    });
    clearBtn.addEventListener('click', function () {
      ta.value = '';
      picks = {};
      markEdited();
      onTextChange();
      parseNow();
      try { ta.focus(); } catch (e) { /* 무시 */ }
    });
    if (pasteBtn) {
      pasteBtn.addEventListener('click', function () {
        // 사용자 동작(클릭) 안에서 바로 불러야 iOS 가 허락한다
        navigator.clipboard.readText().then(function (t) {
          if (!t || !t.trim()) { toast('클립보드가 비어 있어요. Claude 답변을 먼저 복사해 주세요.', { duration: 5000 }); return; }
          ta.value = t;
          picks = {};
          markEdited();
          onTextChange();
          parseNow();
          afterPaste(); // 미리보기가 화면 아래에 있으니 그쪽으로 옮겨 확인하게 한다
        }, function () {
          toast('붙여넣기를 하지 못했어요. 입력 칸을 길게 눌러 [붙여넣기]를 눌러 주세요.', { duration: 6000 });
        });
      });
    }

    submitBtn.addEventListener('click', function () {
      if (done) return;
      var picked = chosen();
      if (!picked.length) return;
      done = true; // 같은 틱에 두 번 눌려도 한 번만 담는다
      submitBtn.disabled = true;
      var now = Date.now();
      var made = picked.map(function (e, i) {
        var p = e.prop;
        var memo = p.memo;
        if (p.tradeType && p.tradeType !== '매매') memo = '거래 종류: ' + p.tradeType + (memo ? '\n' + memo : '');
        return normalizeProperty({
          id: uid(), name: p.name, dong: p.dong, ho: '', // 호수는 늘 사용자가 직접
          area: p.area, supplyArea: p.supplyArea, floor: p.floor, direction: p.direction,
          askPrice: p.askPrice, realPrice: p.realPrice, agentName: p.agentName, agentPhone: p.agentPhone,
          memo: memo, sourceUrl: p.sourceUrl, articleNo: p.articleNo, confirmedAt: p.confirmedAt,
          status: 'review', createdAt: now, updatedAt: now - i, // 코드 순서대로 목록 맨 위에
          importedAt: now, source: IMP.SOURCE_ID,
          fieldsAt: {} // 새 매물(예전 기록이 아님)
        });
      });
      Array.prototype.unshift.apply(state.properties, made);
      dirty = true;
      saveNow();
      sessionRemove(IMPORT_TEXT_KEY);
      // hashchange 를 기다리지 않고 이 클릭 안에서 다음 화면을 그린다(1개면 호수 칸에 바로 키보드가 뜨게)
      if (made.length === 1) {
        pendingFocus = 'ho';
        toast('매물을 담았어요. 호수만 입력하면 돼요.');
        navigateNow('/p/' + made[0].id + '/edit', true);
      } else {
        toast(made.length + '개 담았어요. 호수를 입력해 주세요', { duration: 4000 });
        navigateNow('/', true);
      }
    });

    // 다른 탭에서 매물이 바뀌면 화면을 다시 그리지 않고 중복 표시만 다시 계산한다(입력 칸 유지)
    v.refs.refresh = function () { if (ta.value && !done) parseNow(); };
    if (linkMode) sessionSet(IMPORT_TEXT_KEY, linkText);
    if (initial) parseNow();
  }

  function renderNotFound() {
    newView('notfound');
    setTopbar({ title: '찾을 수 없음', back: '/' });
    updateTabbar('home');
    var main = resetMain();
    main.append(h('div', { class: 'card' },
      h('p', { text: '이 매물을 찾을 수 없어요. 지워졌거나 다른 기기에서 만든 기록일 수 있어요.' }),
      h('a', { class: 'btn btn-block', href: '#/' }, '매물 목록으로')));
  }

  // =====================================================
  // 9. 라우터·시작
  // =====================================================
  var TABS = [
    { id: 'home', href: '#/', label: '매물', icon: 'home' },
    { id: 'compare', href: '#/compare', label: '비교', icon: 'compare' },
    { id: 'glossary', href: '#/glossary', label: '용어', icon: 'book' },
    { id: 'settings', href: '#/settings', label: '설정', icon: 'gear' }
  ];

  function renderTabbar() {
    var nav = $('#tabbar');
    nav.textContent = '';
    TABS.forEach(function (t) {
      var a = h('a', { class: 'tab', href: t.href, 'data-tab': t.id }, icon(t.icon), h('span', { text: t.label }));
      a.addEventListener('click', function (e) {
        // 같은 탭을 다시 누르면 맨 위로
        if (location.hash === t.href || (t.id === 'home' && (location.hash === '' || location.hash === '#'))) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        }
      });
      nav.append(a);
    });
  }

  function updateTabbar(tabId) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (a) {
      if (a.getAttribute('data-tab') === tabId) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  var ROUTES = [
    [/^\/?$/, function () { renderHome(); }],
    [/^\/new$/, function () { return renderForm(null); }],
    [/^\/p\/([^/]+)$/, function (m) { renderDetail(m[1]); }],
    [/^\/p\/([^/]+)\/summary$/, function (m) { renderSummary(m[1]); }],
    [/^\/p\/([^/]+)\/edit$/, function (m) { return renderForm(m[1]); }],
    [/^\/compare$/, function () { renderCompare(); }],
    [/^\/glossary$/, function () { renderGlossary(); }],
    [/^\/settings$/, function () { renderSettings(); }],
    [/^\/import(?:\?(.*))?$/, function (m) { renderImport(m[1] || ''); }]
  ];

  // 앱 안에서 다닌 경로(뒤로 가기 판단용)와 화면별 스크롤 위치
  var navStack = [];
  var scrollMemory = {};
  var lastPath = null;
  var replacing = false;

  function currentPath() {
    var raw = (location.hash || '#/').slice(1) || '/';
    try { raw = decodeURIComponent(raw); } catch (e) { /* 그대로 */ }
    return raw.charAt(0) === '/' ? raw : '/' + raw;
  }

  function hashFor(path) {
    return '#' + path.split('/').map(function (seg, i) { return i === 0 ? seg : encodeURIComponent(seg); }).join('/');
  }

  /** 다른 화면으로 이동. replace=true 면 지금 화면을 기록에서 바꿔치기(뒤로 가기에 안 남음) */
  function navigate(path, replace) {
    var target = hashFor(path);
    if (target === location.hash) { onRoute(); return; } // 같은 주소면 다시 그리기만
    if (replace) {
      replacing = true;
      location.replace(target);
    } else {
      location.hash = target;
    }
  }

  /**
   * 지금 바로(같은 클릭 처리 안에서) 화면을 바꾼다. hashchange 는 비동기라 그 뒤에 주는 초점으로는
   * iOS 가 키보드를 띄우지 않는다. 그래서 주소만 바꾸고(pushState/replaceState 는 hashchange 를 부르지 않음) 바로 그린다.
   */
  function navigateNow(path, replace) {
    var target = hashFor(path);
    if (target !== location.hash) {
      try {
        if (replace) history.replaceState(null, '', target);
        else history.pushState(null, '', target);
      } catch (e) { navigate(path, replace); return; }
      if (replace) replacing = true;
    }
    onRoute();
  }

  /** 뒤로 가기. strict=true 면 바로 앞 화면이 fallback 일 때만 history.back(), 아니면 fallback 으로 이동 */
  function goBack(fallback, strict) {
    var prev = navStack.length >= 2 ? navStack[navStack.length - 2] : null;
    if (prev !== null && (!strict || prev === fallback)) history.back();
    else navigate(fallback, true);
  }

  /** 경로에 맞는 화면을 그린다. 화면 함수가 'focused' 를 돌려주면 초점을 스스로 정한 것 */
  function renderPath(path) {
    for (var i = 0; i < ROUTES.length; i++) {
      var m = ROUTES[i][0].exec(path);
      if (m) {
        try { return ROUTES[i][1](m); } catch (err) { renderError(err); return null; }
      }
    }
    renderHome();
    return null;
  }

  /** 화면이 바뀌면 새 화면 제목으로 초점을 옮긴다(VoiceOver 가 화면 이름을 읽고, 읽기 위치를 잃지 않게) */
  function focusTitle() {
    if (openDialogs.length || closeLightbox) return;
    var t = document.getElementById('tb-title');
    if (t) { try { t.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }
  }

  function onRoute() {
    var path = currentPath();
    if (lastPath !== null) scrollMemory[lastPath] = window.scrollY;
    var isBack = false;
    if (replacing) {
      navStack.pop();
      navStack.push(path);
      replacing = false;
    } else if (navStack.length >= 2 && navStack[navStack.length - 2] === path) {
      navStack.pop();
      isBack = true;
    } else if (navStack[navStack.length - 1] !== path) {
      navStack.push(path);
    }
    if (navStack.length > 50) navStack = navStack.slice(-50);
    lastPath = path;

    // 이전 화면 정리
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (closeLightbox) closeLightbox();
    closeAllDialogs();
    revokeAllPhotoUrls();

    var result = renderPath(path);
    window.scrollTo(0, isBack && scrollMemory[path] ? scrollMemory[path] : 0);
    if (result !== 'focused') focusTitle();
  }

  // ---- 다른 탭(창)과 맞추기 ----
  var refreshTimer = null;

  /** 입력 중이거나 대화상자·사진 보기가 열려 있으면 화면을 다시 그리지 않는다 */
  function busyEditing() {
    if (openDialogs.length || closeLightbox) return true;
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('#main').contains(a));
  }

  /** 다른 탭의 변경을 합친 뒤 지금 화면을 다시 그린다(스크롤 위치 유지, 초점은 옮기지 않음) */
  function refreshViewSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(tryRefreshView, 60);
  }
  function tryRefreshView() {
    refreshTimer = null;
    if (view.name === 'form') return; // 폼은 입력 중일 수 있어 다시 그리지 않는다
    if (view.name === 'import') { if (view.refs.refresh) view.refs.refresh(); return; } // 붙여 넣은 글은 그대로, 중복 표시만 다시
    if (busyEditing()) { refreshTimer = setTimeout(tryRefreshView, 1500); return; }
    var y = window.scrollY;
    revokeAllPhotoUrls();
    renderPath(currentPath());
    window.scrollTo(0, y);
  }

  function syncFromOtherTabs() {
    if (pullFromStorage()) refreshViewSoon();
    if (needResave) { needResave = false; scheduleSave(); } // 예전 버전 탭이 지운 1.2.0 필드를 저장본에도 되돌린다
  }

  function renderError(err) {
    console.error(err);
    var main = resetMain();
    main.append(h('div', { class: 'notice', role: 'alert' },
      h('strong', { text: '화면을 그리다 문제가 생겼어요.' }),
      h('p', { text: '새로고침해 보세요. 계속되면 설정에서 백업을 먼저 해 두세요. (' + (err && err.message ? err.message : err) + ')' })));
  }

  // ---- 서비스 워커(오프라인 캐시·새 버전) ----
  var SW = { reg: null, lastCheck: 0, updateReady: false, reloading: false };

  function reloadForUpdate() {
    SW.reloading = true;
    flushIfDirty();
    location.reload();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // 파일(file://)로 열었거나 HTTPS 가 아니면(같은 Wi-Fi 의 http 주소 등) 건너뛴다
    if (!window.isSecureContext || !/^https?:$/.test(location.protocol)) return;
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; } // 처음 설치: 알릴 필요 없음
      if (SW.reloading) return;
      SW.updateReady = true;
      refreshVersionBadge(); // 헤더 버전 표시를 [업데이트]로
      // 예전 버전으로 열어 둔 다른 탭이 저장하면 새 필드가 빠질 수 있어(합칠 때 지키지만) 다른 탭도 새로고침하게 알린다
      toast('새 버전이 준비됐어요. 열어 둔 다른 탭도 새로고침해 주세요.', { duration: 15000, action: { label: '새로고침', fn: reloadForUpdate } });
      if (view.name === 'settings' && !busyEditing()) renderSettings(); // 설정 화면에도 [새로고침] 표시
    });
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      SW.reg = reg;
      SW.lastCheck = Date.now();
    }).catch(function (err) { console.warn('서비스 워커 등록 실패', err); });
  }

  /** 홈 화면 앱은 앱 전환기에 오래 남아 있다가 다시 열리므로, 다시 보일 때 새 버전을 확인한다(1시간에 한 번) */
  function checkForUpdate() {
    if (!SW.reg || Date.now() - SW.lastCheck < SW_CHECK_INTERVAL_MS) return;
    SW.lastCheck = Date.now();
    SW.reg.update().catch(function () { /* 오프라인 등: 무시 */ });
  }

  function requestPersistQuietly() {
    // 홈 화면 앱으로 쓸 때는 조용히 데이터 보호를 요청해 둔다(결과는 설정 화면에서 확인)
    if (!isStandalone() || !navigator.storage || !navigator.storage.persisted || !navigator.storage.persist) return;
    navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); }).catch(function () { /* 무시 */ });
  }

  function init() {
    renderTabbar();
    window.addEventListener('hashchange', onRoute);
    // 화면을 떠나거나 앱을 내릴 때: 바뀐 것이 있을 때만 저장(아무것도 안 고친 탭이 예전 내용으로 덮어쓰지 않게)
    window.addEventListener('pagehide', flushIfDirty);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { flushIfDirty(); return; }
      syncFromOtherTabs(); // 다른 탭에서 바뀐 내용 가져오기
      checkForUpdate();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) syncFromOtherTabs(); });
    // 다른 탭(창)이 저장하면 바로 합쳐서 다시 그린다
    window.addEventListener('storage', function (e) {
      if (e.key === null || e.key === STORAGE_KEY) syncFromOtherTabs();
    });
    // iOS Safari 는 touchstart 리스너가 있어야 버튼을 누를 때 :active 모양을 보여 준다
    document.addEventListener('touchstart', function () { /* :active 표시용 */ }, { passive: true });

    if (!location.hash || location.hash === '#') {
      try { history.replaceState(null, '', '#/'); } catch (e) { /* 무시 */ }
    }
    onRoute();

    if (loadProblem === 'blocked') showSaveError(new Error('blocked'));
    if (loadProblem === 'broken') {
      alertDialog('저장된 기록을 읽지 못했어요', '기록이 손상돼 새로 시작해요. 손상된 원본은 지우지 않고 따로 보관했어요. 백업 파일이 있다면 설정 → 백업 불러오기로 되살릴 수 있어요.');
    }
    // 사진 저장소를 쓸 수 없으면(파일로 열기 등) 사진 버튼을 숨기고 안내를 보여 준다
    Photos.probe().then(function (ok) {
      document.documentElement.classList.toggle('no-photos', !ok);
      if (ok) setTimeout(cleanDeletedPhotos, 2500);
    });
    registerServiceWorker();
    requestPersistQuietly();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
