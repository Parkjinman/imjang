/*
 * 임장 체크리스트 — app.js
 * 순수 자바스크립트(빌드·프레임워크·외부 라이브러리 없음). data.js 다음에 로드된다.
 *
 * 구성
 *   1. 상수
 *   2. 작은 도구(숫자·날짜·환경)
 *   3. 체크리스트 데이터 정리 (data.js 의 window.CHECKLIST)
 *   4. 저장소: 매물·체크 상태 (localStorage 'imjang.v1')
 *   5. 사진·서류 저장소 (IndexedDB 'imjang-photos'. 1.6.0: DB 버전 2 에 서류함 'docs')
 *   6. 계산: 진행률·위험 신호·요약
 *   7. 공통 UI: DOM 헬퍼, 아이콘, 진행 막대, 토스트, 대화상자, 사진 크게 보기
 *   8. 화면: 홈 / 매물 폼 / 상세 / 요약 / 비교 / 용어 / 설정 / 코드·글로 매물 추가(Claude 가져오기 코드, 네이버 매물 화면 글)
 *   9. 라우터·시작
 *
 * 보안: 사용자 입력은 항상 textContent(또는 value)로만 화면에 넣는다. innerHTML 은 고정 아이콘 SVG 에만 쓴다.
 * 가져오기 코드·네이버 매물 글 해석은 import-parser.js(window.ImjangImport)가 맡는다. data.js 다음, 이 파일 전에 로드된다.
 * 두 기록 합치기(백업 [합치기]·여러 탭)는 merge.js(window.ImjangMerge)가 맡는다. import-parser.js 다음, 이 파일 전에 로드된다.
 * 1.6.0: 등기부 PDF 해석은 registry-parser.js(window.ImjangRegistry)가 맡는다(import-parser.js 다음, merge.js 전에 로드).
 *   PDF 글자를 꺼내는 pdf.js(vendor/pdfjs)는 처음 PDF 를 올릴 때만 불러온다(loadPdfjs). 서류·해석 결과는 이 기기 밖으로 보내지 않는다.
 * 1.7.0: 대출 한도·월 상환·매수 부대비용·필요 현금·보유비용 추정은 finance.js(window.ImjangFinance)가 맡는다(merge.js 다음, 이 파일 전에 로드).
 *   매물의 KB시세·관리비 등 네이버 참고값은 import-parser.js 가 읽고, 상세 화면 '대출·비용' 카드(finCard)가 보여 준다. 모든 수치는 추정이다.
 */
(function () {
  'use strict';

  // =====================================================
  // 1. 상수
  // =====================================================
  var APP_VERSION = '1.7.0';
  var STORAGE_KEY = 'imjang.v1';
  var DRAFT_KEY = 'imjang.v1.draft'; // 새 매물 폼 임시 저장(앱이 내려가도 남도록 localStorage)
  // 1.6.0 검토 반영: 매물의 1.6.0 필드(등기부 기록·지운 기록 표시·매도인 이름) 사본. 예전(1.5.x) 탭이 이 필드를 빼고 저장해도 되살린다
  var REG_SIDE_KEY = 'imjang.v1.reg';
  // 1.7.0: 매물의 1.7.0 필드(KB시세·관리비·리모델링비 등)와 전역 대출 조건(settings)의 사본. 예전(1.6.0 이하) 탭이 이것을 빼고 저장해도
  // 되살린다. 1.6.0 은 REG_SIDE_KEY 를 통째로 다시 쓰므로 키를 따로 둔다(그 키에 넣으면 1.6.0 탭이 지움)
  var FIN_SIDE_KEY = 'imjang.v1.fin';
  var SCHEMA_VERSION = 1;
  var PHOTO_DB_NAME = 'imjang-photos';
  var PHOTO_STORE = 'photos';
  // 1.6.0: 사진 DB 버전 2 — 서류함(매물별 첨부 서류) object store 'docs' 를 더한다(사진 'photos' 는 그대로).
  // 예전 버전 탭이 v1 로 열어 둔 채 응답하지 않으면 업그레이드가 막힌다(onblocked → 안내 띠, IDB 묶음)
  var PHOTO_DB_VERSION = 2;
  var DOC_STORE = 'docs';
  var DOC_KINDS = [
    { id: 'registry', label: '등기부' },
    { id: 'building', label: '건축물대장' },
    { id: 'contract', label: '계약서' },
    { id: 'other', label: '기타' }
  ];
  var DOC_KIND_LABEL = {};
  DOC_KINDS.forEach(function (k) { DOC_KIND_LABEL[k.id] = k.label; });
  var DOC_MAX_BYTES = 30 * 1024 * 1024; // 서류 하나의 최대 크기(등기부 PDF 는 보통 1MB 안팎)
  var DOC_NAME_MAX = 120;               // 서류 이름 글자 수
  var SELLER_NAME_MAX = 40;             // 1.6.0: 매도인 이름 글자 수
  var SNAPSHOTS_MAX = 12;               // 1.6.0: 매물 하나의 등기부 해석 기록 최대 개수(넘치면 오래된 것부터 버림)
  var PHOTO_MAX_EDGE = 1600;
  var PHOTO_QUALITY = 0.8;
  var SAVE_DELAY_MS = 400;
  var TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60 * 1000; // 지운 매물 표시(다른 탭과 맞추기용) 보관 기간
  var SW_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  var BACKUP_APP_ID = 'imjang-checklist';
  // 가져오기 코드·네이버 매물 글 해석기(import-parser.js). 파일이 없으면 null 이고, 그때는 '코드·글로 매물 추가' 화면만 안내로 바뀐다
  var IMP = window.ImjangImport || null;
  var IMPORT_TEXT_KEY = 'imjang.import.text'; // 붙여 넣은 글(sessionStorage). Claude 앱·네이버에 다녀와도 남게
  // 1.4.0: 가져오기 화면 제목(Claude 코드나 네이버 매물 화면 글을 붙여 넣음). 1.5.0 검토 반영: 홈 버튼 이름과 같은 어근("네이버 글")으로
  var IMPORT_TITLE = '네이버 글·코드로 추가';
  // 1.4.1: 홈 [코드·글로 추가] 버튼의 보충 설명(VoiceOver 이름·마우스 풍선). 보이는 글은 320px 한 줄에 맞게 짧게 둔다
  var IMPORT_HINT = '네이버 매물 화면 글이나 Claude 코드를 붙여 넣어 매물 추가';
  var GONE_KEYS_MAX = 600; // 지운 매물 열쇠(goneKeys) 최대 개수
  // 두 기록 합치기(merge.js). 파일이 없으면 null 이고, 그때는 탭끼리 매물 단위로 합치고(1.2.x 방식) 백업 [합치기]만 막는다
  var MG = window.ImjangMerge || null;
  // 1.6.0: 등기부 PDF 해석기(registry-parser.js). 파일이 없으면 null 이고, 그때는 PDF 를 서류로만 저장한다(해석 안내만 바뀜)
  var REG = window.ImjangRegistry || null;
  // 1.7.0: 대출·비용 추정(finance.js). 파일이 없으면 null 이고, 그때는 '대출·비용' 카드가 안내로 바뀐다(값 입력·저장은 그대로)
  var FIN = window.ImjangFinance || null;
  // 1.6.0: PDF 읽기 도구(pdf.js 3.11, Apache-2.0). 처음 PDF 를 올릴 때 스크립트 태그로 불러온다(loadPdfjs).
  // 일꾼(worker) 주소는 상대 경로(배포 위치가 바뀌어도 되게). 서비스 워커가 둘 다 미리 저장해 오프라인에서도 읽는다.
  // 한글 cMap 은 넣지 않았다: 인터넷등기소 PDF 는 글꼴을 품고 글자 대응표(ToUnicode)가 있어 cMap 없이 같은 글자가 나옴(1.6.0 확인)
  var PDFJS_SRC = 'vendor/pdfjs/pdf.min.js';
  var PDFJS_WORKER_SRC = 'vendor/pdfjs/pdf.worker.min.js';
  var DEVICE_NAME_MAX = 20; // 기기 이름 최대 글자 수
  var UNDO_MS = 10000;      // 매물을 지운 뒤 [되돌리기]를 누를 수 있는 시간. 사진은 이 시간이 지난 뒤에 지운다
  // 1.4.1: [되돌리기] 토스트나 홈의 되돌리기 줄에 초점·손가락이 있으면 기다린다(VoiceOver·키보드로 닿을 시간). 최대 이만큼
  var UNDO_HOLD_MAX_MS = 45000;
  // 지운 지 이만큼 안 된 매물의 사진은 남은 사진 정리(cleanDeletedPhotos, 다른 탭 포함)도 건너뛴다. 되돌리기도 이 안에서만
  // (1.4.0 은 15초. 1.4.1 에서 기다리는 시간이 늘어 1분)
  var UNDO_KEEP_MS = 60000;
  var DIALOG_GUARD_MS = 400; // 1.4.1: 대화상자를 연 직후 이 시간 동안은 버튼·바탕 누름을 무시한다(두 번 눌러 확인 없이 지워지지 않게)
  var TOAST_RESUME_MS = 4000; // 1.4.1: 멈춰 둔 토스트에서 초점·손가락이 떠나면 적어도 이만큼 더 보여 준다

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
    // 1.5.0(C6): 규제지역·허가구역·대출 한도는 단지 단계에서 정해지므로 여기서 함께 보게 한다
    { title: '단지 고르기', desc: '실거래가(실제로 거래된 가격)를 보고 예산에 맞는 단지를 고릅니다. 규제지역·토지거래허가구역인지, 대출 한도 안에 드는지도 이때 봅니다(토지이음·은행). 아직 집을 보러 가지 않아요.' },
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
    forward: '<path d="M9 6l6 6-6 6"/>',
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
  /** 1.6.0 검토 반영: 낱말 + 조사. 마지막 글자에 받침이 있으면 withB, 없으면(한글이 아니어도) noB. josa('동', '이', '가') → '동이' */
  function josa(word, withB, noB) {
    var s = str(word);
    var c = s.charCodeAt(s.length - 1);
    return s + (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 ? withB : noB);
  }
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
  /**
   * 1.7.0 검토 반영: 대출·비용 만원 칸(KB시세·협상가·리모델링비·공시가격) 읽기. 전에는 숫자가 아닌 글자를 모두 지워서
   * '1.9억'이 19(만원), '2천'이 2(만원)로 조용히 저장됐다.
   *   숫자·쉼표·공백만 → 그 수. '억·천·만·원'이 든 글('1.9억', '2억 4천', '1천5백만', '15000000원') → finance.js parseMan.
   *   결과 { value: 만원 정수 | null(빈 칸), bad: '' | 'unread'(못 읽음) | 'fraction'(만원 아래 소수) }
   */
  function readManInput(text) {
    var t = String(text === null || text === undefined ? '' : text)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/，/g, ',').trim();
    if (!t) return { value: null, bad: '' };
    if (/^[\d,\s]+$/.test(t)) {
      var d = t.replace(/[,\s]/g, '');
      return d ? { value: parseInt(d, 10), bad: '' } : { value: null, bad: 'unread' };
    }
    var n = FIN && FIN.parseMan ? FIN.parseMan(t) : null;
    if (n === null || !isFinite(n)) return { value: null, bad: 'unread' };
    if (Math.abs(n - Math.round(n)) > 1e-9) return { value: null, bad: 'fraction' };
    return { value: Math.round(n), bad: '' };
  }
  /** readManInput 이 못 읽었을 때 칸 아래에 보일 말 */
  function manInputError(bad) {
    return bad === 'fraction' ? '만원 단위로 소수점 없이 적어 주세요. (2억 3,450 → 23450)'
      : '읽지 못해 저장하지 않았어요. 만원 단위 숫자로 적어 주세요. (2억 3,450 → 23450)';
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
        shortTitle: str(s.shortTitle), // 1.5.0: 좁은 화면 섹션 칩용 2~3자 제목(없으면 title)
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
          memoHint: str(it.memoHint), // 1.4.5: 메모 칸 자리표시 문구(없으면 앱 기본 문구)
          // 1.5.0: 항목 하나만 섹션과 다르게 모을 때('contract' | 'reference', 없으면 '' = 섹션 값을 따름)
          cautionUse: it.cautionUse === 'reference' || it.cautionUse === 'contract' ? it.cautionUse : '',
          linkTo: str(it.linkTo), // 1.5.0: flag "있음"일 때 그 자리에 열어 줄 섹션 id(예: 'registry')
          shortTitle: str(it.shortTitle), // 1.5.0 검토 반영: 답한 항목의 접힌 한 줄에 문장 대신 보여 줄 짧은 이름(없으면 문장)
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

  /** 1.4.5: data.js 바로가기(links) 중 이름(label)에 word 가 들어 있는 첫 것. 없으면 null */
  function linkByLabel(word) {
    for (var i = 0; i < CL.links.length; i++) {
      if (CL.links[i].label.indexOf(word) >= 0) return CL.links[i];
    }
    return null;
  }

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
    return { version: SCHEMA_VERSION, rev: '', dataVersion: '', properties: [], deleted: {}, localDeleted: {}, goneKeys: {}, ui: { dismissedInstallTip: false, lastBackupAt: null, deviceName: '', deviceNameAt: null, backupWithPhotos: null, dataNotice: null },
      // 1.7.0: 전역 대출 조건(finance.js defaultSettings 모양, 안 바꿨으면 null = 기본값)과 바꾼 시각. 기록의 일부라 백업·[합치기]에 함께 간다
      settings: { finance: null, financeAt: 0 } };
  }

  var ITEM_VALUE_KEYS = ['status', 'memo', 'answer', 'date', 'done']; // 항목 상태의 값 이름(merge.js ITEM_FIELDS 와 같음)

  // 1.5.0 검토 반영: 저장본에 적는 데이터(data.js) 버전. 이보다 오래된 저장본(1.4.x 이하는 dataVersion 이 없음)을 읽을 때
  // 2026-10c 에서 바뀐 항목(가처분 분리, rate → check)을 한 번 옮긴다. normalizeState 가 migrationStats 에 옮긴 수를 센다
  var DATA_MIGRATION_VERSION = '2026-10c';
  var migrationStats = null; // { legacy, inj, unitMoved, unitLost } — normalizeState 마다 새로 만듦
  var migratedOnLoad = false; // loadState 가 옛 저장본을 읽었으면 true → init 이 한 번 다시 저장(dataVersion 을 적어 다음부터 안 옮김)

  /**
   * 항목 상태 정리. legacy(1.5.0 검토 반영): 데이터 2026-10c 보다 오래된 저장본이면 type 이 rate → check 로 바뀐 항목
   * (unit-measure·unit-balcony)의 "양호"를 체크(done)로 옮긴다("주의"는 메모만 남음).
   * 저장본이 어느 버전이든 항목 type 에 맞지 않는 status(rate 가 아닌 항목의 good/caution, flag 가 아닌 항목의 yes/no)는 버린다
   * — 앱은 어차피 type 에 맞는 값만 읽지만(isItemDone), 버리지 않으면 저장본·백업·합치기에 영원히 남아 나중에 type 을 되돌리면
   * 옛 답이 말없이 되살아난다. 읽을 때 모든 기기가 같은 규칙으로 버리므로 합치기에 안전하다(ft 시각은 남겨 "지운 값"으로 합쳐짐)
   */
  function normalizeItems(items, legacy) {
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
      var def = CL.itemById[k];
      if (def && def.type !== 'rate' && (o.status === 'good' || o.status === 'caution')) {
        if (legacy && def.type === 'check' && o.status === 'good') {
          if (!o.done) { o.done = true; if (o.ft && o.ft.status && !o.ft.done) o.ft.done = o.ft.status; }
          if (migrationStats) migrationStats.unitMoved++;
        } else if (legacy && migrationStats && o.status === 'caution') migrationStats.unitLost++;
        delete o.status;
      }
      if (def && def.type !== 'flag' && (o.status === 'yes' || o.status === 'no')) delete o.status;
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

  // 1.5.0: 가져오기 참고(importNotes). 가져오기가 메모에 넣던 앱 안내 문장(면적 환산 안내 등)을 메모와 따로 둔다
  var IMPORT_NOTES_MAX = 10;   // 문장 수
  var IMPORT_NOTE_LEN = 300;   // 문장 길이
  // 1.4.x 가 메모 본문에 넣던 안내 문장의 머리말. 1.5.0 부터는 importNotes 로 옮긴다("다른 연락처: …"는 정보라 메모에 남김)
  var IMPORT_NOTE_LINE_RE = /^(면적: 화면의 평 표기|면적: 목록 표기|네이버 목록에서 읽었어요)/;
  // 1.5.0 검토 반영: 담는 순간에만 뜻이 있는 안내(호수는 담은 뒤 직접 적으므로)는 가져오기 참고에 남기지 않는다
  var IMPORT_NOTE_ONCE_RE = /^호수는 직접 입력/;

  /** 가져오기 참고 목록 정리: 문자열 배열, 빈 것·중복 제외, 개수·길이 제한 */
  function noteList(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (n) {
      n = str(n).trim().slice(0, IMPORT_NOTE_LEN);
      if (n && out.indexOf(n) < 0 && out.length < IMPORT_NOTES_MAX) out.push(n);
    });
    return out;
  }

  /**
   * 메모에 섞인 앱 안내 문장을 떼어 가져오기 참고로 옮긴다 → { memo, notes }.
   * notes(가져오기 결과의 참고 문구)는 뒤에 붙이되, 같은 머리말("면적:")의 더 자세한 문장이 메모에서 왔으면 겹치니 뺀다.
   * 안내 문장이 없으면 메모는 그대로(사용자가 쓴 줄바꿈을 건드리지 않음)
   */
  function splitImportMemo(memo, notes) {
    var keep = [];
    var moved = [];
    str(memo).split(/\r?\n/).forEach(function (line) {
      if (IMPORT_NOTE_LINE_RE.test(line.trim())) moved.push(line.trim()); else keep.push(line);
    });
    var out = moved.slice();
    (Array.isArray(notes) ? notes : []).forEach(function (n) {
      n = str(n).trim();
      if (IMPORT_NOTE_ONCE_RE.test(n)) return; // 1.5.0 검토 반영: "호수는 직접 입력해요"는 호수를 적고 나면 틀린 안내가 됨
      var at = n.indexOf(':');
      var label = at > 0 ? n.slice(0, at + 1) : '';
      if (label && moved.some(function (m) { return m.indexOf(label) === 0; })) return;
      out.push(n);
    });
    return { memo: moved.length ? keep.join('\n').replace(/\n{3,}/g, '\n\n').trim() : str(memo), notes: noteList(out) };
  }

  // ---- 1.6.0: 등기부 해석 기록(property.registrySnapshots) ----
  // 등기부 PDF 해석(registry-parser.js)·가져오기 코드의 registry 블록(import-parser.js)·직접 입력이 모두 같은 모양으로 남긴다.
  // 매물 JSON 에 들어가므로 작게: 글자 수·줄 수를 자르고, 매물 하나에 SNAPSHOTS_MAX 개까지(오래된 것부터 버림).
  //   { id, docId|null(서류함 레코드 id), source: 'pdf'|'code'|'manual', viewedAt(열람 일시 ms|null),
  //     docType(문서 구분 글자, 예: '열람용'·'제출용' 또는 문서 제목), includesCancelled(말소사항 포함 true, 현재 유효사항만 false, 모름 null),
  //     uniqueNo(고유번호 글자), area(표제부 전용면적 ㎡|null),
  //     owners: [{ name, share(지분 글자), since(취득 접수일 글자) }],
  //     live: [{ kind(종류: trust·seizure·injunction·auction·provisional·lease·mortgage·jeonse·ownership·other|''),
  //              part: 'title'|'gap'|'eul'|'', rank(순위번호), purpose(등기목적), date(접수일 글자), text(요약) }]  지금 살아 있는 기록
  //     history: [ 같은 모양 ]  말소된(빨간 줄) 지난 기록
  //       (live·history 는 registry-parser 모양 { 종류: [{ section, rank, purpose, receiptDate, maxAmount, holder… }] } 도 받아 위 모양으로 바꾼다)
  //     mortgages: [{ rank, maxAmount(채권최고액, 원), holder(근저당권자), debtor(채무자) }]  말소되지 않은 근저당(없으면 live.mortgage 에서 만듦)
  //     answers: { 항목id: 'yes'|'no'|'done' }  flag 는 yes/no, check 는 done(applyRegistrySnapshot 이 항목 답으로 반영)
  //     addedAt(ms), t(이 기록을 마지막으로 바꾼 시각 — 합치기에서 같은 id 는 t 가 큰 쪽),
  //     appliedAt(ms, 반영한 적 있을 때), applied: { 항목id: { v, t } }(반영해 바꾼 답과 그 값 시각 — 다음 반영 때 "앱이 넣은 답"인지 가림) }
  // 지운 기록은 property.registrySnapshotsRemoved { 기록id: 지운 시각 } 으로 남겨 다른 탭·기기와 합칠 때 되살아나지 않게 한다(180일)
  var SNAP_SOURCES = { pdf: 1, code: 1, manual: 1 };
  var SNAP_PARTS = { title: 1, gap: 1, eul: 1 };
  var SNAP_ANSWERS = { yes: 1, no: 1, done: 1 };
  var SNAP_ENTRY_MAX = 30;
  var SNAP_OWNER_MAX = 20;
  var SNAP_MORTGAGE_MAX = 20;
  var SNAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/;

  function snapText(v, max) { return str(v).replace(/\s+/g, ' ').trim().slice(0, max); }
  /**
   * 시각 값 → ms(못 읽으면 null). 숫자(ms), 'YYYY-MM-DD HH:MM(:SS)', 'YYYY.MM.DD HH:MM', '2026년 10월 10일 15시 30분',
   * 시간대가 붙은 ISO 글자(그대로 Date.parse). 시간대 없는 글자는 이 기기 시각으로 본다
   */
  function snapTime(v) {
    if (typeof v === 'number') return isFinite(v) && v > 0 ? Math.round(v) : null;
    var s = str(v).trim();
    if (!s) return null;
    if (/T\d{1,2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      var p = Date.parse(s);
      return isFinite(p) && p > 0 ? p : null;
    }
    var m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\.?(?:\s*T?\s*(\d{1,2})\s*[:시]\s*(\d{1,2})\s*분?(?:\s*:?\s*(\d{1,2})\s*초?)?)?/.exec(s);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var t = d.getTime();
    return isFinite(t) && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? t : null;
  }
  /** 금액(원) → 정수. 숫자, 또는 '금240,000,000원' 같은 글자(숫자만 모음). 없으면 null */
  function snapAmount(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? Math.round(v) : null;
    var d = str(v).replace(/[^\d]/g, '');
    if (!d || d.length > 15) return null;
    return parseInt(d, 10);
  }
  function snapOwners(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (o) {
      var obj = o && typeof o === 'object';
      var name = snapText(obj ? o.name : o, 40);
      if (name && out.length < SNAP_OWNER_MAX) out.push({ name: name, share: snapText(obj ? o.share : '', 40), since: snapText(obj ? o.since : '', 20) });
    });
    return out;
  }
  // 기록 줄의 종류(registry-parser.js 의 분류와 같은 열쇠)
  var SNAP_KINDS = { ownership: 1, trust: 1, seizure: 1, injunction: 1, auction: 1, provisional: 1, lease: 1, mortgage: 1, jeonse: 1, other: 1 };
  function snapEntry(e, kind) {
    if (!e || typeof e !== 'object') return { kind: SNAP_KINDS[kind] ? kind : '', part: '', rank: '', purpose: '', date: '', text: snapText(e, 160) };
    var k = SNAP_KINDS[e.kind] ? e.kind : (SNAP_KINDS[kind] ? kind : '');
    var part = e.part || e.section; // registry-parser 는 section('gap'|'eul')
    var text = e.text;
    if (!text) { // registry-parser 요약 줄(brief)에는 text 가 없다: 권리자·금액으로 짧게
      var amt = snapAmount(e.maxAmount || e.deposit || e.amount);
      text = [str(e.holder), amt ? (e.maxAmount ? '채권최고액 ' : e.deposit ? '보증금 ' : '금액 ') + formatManwon(amt / 10000) : ''].filter(Boolean).join(' · ');
    }
    return { kind: k, part: SNAP_PARTS[part] ? part : '', rank: snapText(e.rank, 12), purpose: snapText(e.purpose, 40), date: snapText(e.date || e.receiptDate, 20), text: snapText(text, 160) };
  }
  /** 기록 줄 목록. 배열, 또는 registry-parser 모양 { 종류: [줄…] } 도 받는다 */
  function snapEntries(v) {
    var src = [];
    if (Array.isArray(v)) v.forEach(function (e) { src.push([e, '']); });
    else if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) { if (!BAD_KEYS[k] && Array.isArray(v[k])) v[k].forEach(function (e) { src.push([e, k]); }); });
    }
    var out = [];
    src.forEach(function (x) {
      if (out.length >= SNAP_ENTRY_MAX) return;
      var o = snapEntry(x[0], x[1]);
      if (o.purpose || o.text) out.push(o);
    });
    return out;
  }
  function snapMortgages(v, live) {
    var out = [];
    // 따로 주지 않았으면 registry-parser 모양의 살아 있는 근저당 줄(live.mortgage)에서 만든다
    if (!Array.isArray(v) && live && typeof live === 'object' && !Array.isArray(live) && Array.isArray(live.mortgage)) v = live.mortgage;
    (Array.isArray(v) ? v : []).forEach(function (m) {
      if (!m || typeof m !== 'object' || out.length >= SNAP_MORTGAGE_MAX) return;
      var o = { rank: snapText(m.rank, 12), maxAmount: snapAmount(m.maxAmount), holder: snapText(m.holder, 60), debtor: snapText(m.debtor, 40) };
      if (o.rank || o.maxAmount !== null || o.holder) out.push(o);
    });
    return out;
  }
  /** 답 정리: { 항목id: 'yes'|'no'|'done' }. true → 'done', { value } 모양도 받음. 모르는 값은 버림 */
  function snapAnswers(v) {
    var out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach(function (k) {
      if (BAD_KEYS[k] || !SNAP_ID_RE.test(k)) return;
      var a = v[k];
      if (a && typeof a === 'object') a = a.value;
      if (a === true) a = 'done';
      a = str(a).trim().toLowerCase();
      if (SNAP_ANSWERS[a]) out[k] = a;
    });
    return out;
  }
  function snapApplied(v) {
    var out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach(function (k) {
      var a = v[k];
      if (BAD_KEYS[k] || !SNAP_ID_RE.test(k) || !a || typeof a !== 'object' || !SNAP_ANSWERS[a.v]) return;
      out[k] = { v: a.v, t: numOrNull(a.t) > 0 ? numOrNull(a.t) : 0 };
    });
    return out;
  }
  /** 등기부 해석 기록 하나 정리(위 모양으로). 객체가 아니면 null. id 가 없거나 이상하면 새로 만든다 */
  function normalizeSnapshot(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    var id = str(s.id).trim();
    if (!SNAP_ID_RE.test(id) || BAD_KEYS[id]) id = uid();
    var addedAt = snapTime(s.addedAt) || Date.now();
    var area = numOrNull(s.area);
    var o = {
      id: id,
      docId: SNAP_ID_RE.test(str(s.docId).trim()) ? str(s.docId).trim() : null,
      source: SNAP_SOURCES[s.source] ? s.source : 'manual',
      viewedAt: snapTime(s.viewedAt),
      docType: snapText(s.docType, 80),
      includesCancelled: typeof s.includesCancelled === 'boolean' ? s.includesCancelled : null,
      uniqueNo: snapText(s.uniqueNo, 40),
      area: area > 0 && area < 100000 ? Math.round(area * 10000) / 10000 : null,
      owners: snapOwners(s.owners),
      live: snapEntries(s.live),
      history: snapEntries(s.history),
      mortgages: snapMortgages(s.mortgages, s.live),
      answers: snapAnswers(s.answers),
      addedAt: addedAt,
      t: Math.max(snapTime(s.t) || 0, addedAt)
    };
    // 1.6.0 검토 반영: 소유자 계산이 불확실(registry-parser ownersUncertain) — 매도인 비교로 "없음"을 넣지 않는다. 참일 때만 둔다
    if (s.ownersUncertain === true) o.ownersUncertain = true;
    var at = snapTime(s.appliedAt);
    if (at) { o.appliedAt = at; o.applied = snapApplied(s.applied); }
    return o;
  }
  /**
   * 매물의 기록 목록 정리: 같은 id 는 t 가 큰 것 하나, 지운 기록(removed)은 빼고, 만든 순서로 최근 SNAPSHOTS_MAX 개.
   * 1.6.0 검토 반영: 열람 일시·고유번호·서류 종류가 같은 겹친 기록(두 기기에서 같은 PDF)은 하나로(merge.js dedupeSnapshots)
   */
  function normalizeSnapshots(list, removed) {
    var byId = {};
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var s = normalizeSnapshot(raw);
      if (!s) return;
      if (removed && removed[s.id] && removed[s.id] >= s.t) return;
      if (!hasOwn(byId, s.id) || s.t > byId[s.id].t) byId[s.id] = s;
    });
    var out = Object.keys(byId).map(function (k) { return byId[k]; });
    if (MG && MG.dedupeSnapshots) out = MG.dedupeSnapshots(out);
    out.sort(function (a, b) { return (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return out.length > SNAPSHOTS_MAX ? out.slice(out.length - SNAPSHOTS_MAX) : out;
  }

  // ---- 1.7.0: 대출·비용 값(매물 필드) ----
  // 매물마다 늘 같은 키를 둔다(값이 없으면 null·''·[]). 키가 아예 없는 저장본 매물 = 예전(1.6.0 이하) 탭이 쓴 것(restoreFinFromSide 가 판단)
  //   kbPrice(만원)·kbAt('YYYY-MM-DD', KB시세를 가져온 날 = 기준일)·kbSource('naver'|'code'|'manual')·kbHistory·askHistory([{ value, at, source, t }])
  //   dealPrice(협상가, 만원)·remodelCost(리모델링비, 만원)·publicPrice(공시가격, 만원) — 사용자가 '대출·비용' 카드에서 넣는 값
  //   naverLoanLimit(만원)·naverRate({ min, max, bank })·feeMonthly·feeAvg·feeSummer·feeWinter(원)·feeRecent({ month, amount 원 })·
  //   acqTaxNaver·propertyTaxNaver(원) — 네이버 화면의 참고값(import-parser.js W1 과 같은 범위 검사)
  //   syncAt({ 칸: ms }): 가져오기·다시 붙여넣기가 그 칸에 값을 마지막으로 넣은 시각. 그 뒤에 fieldsAt 이 올라간 칸 = 손으로 고친 값
  // 1.7.0 검토 반영: 협상가 하한을 KB시세처럼 1,000만원, 공시가격 하한을 100만원으로(전에는 1만원이라 '1.9억'을 19로 읽은 값도 받았음)
  var FIN_NUM_RANGE = {
    kbPrice: [1000, 10000000], dealPrice: [1000, 10000000], remodelCost: [0, 1000000], publicPrice: [100, 10000000],
    naverLoanLimit: [100, 10000000], feeMonthly: [1000, 5000000], feeAvg: [1000, 5000000], feeSummer: [1000, 5000000],
    feeWinter: [1000, 5000000], acqTaxNaver: [10000, 10000000000], propertyTaxNaver: [1000, 1000000000]
  };
  var FIN_PROP_NUMS = Object.keys(FIN_NUM_RANGE);
  // 1.7.0 에서 늘어난 매물 필드(대출·비용). 1.7.0 은 늘 이 키를 적는다(값이 없으면 null·''·[]·{}). kbHistory 가 없으면 예전 탭이 쓴 매물.
  // 저장본을 처음 읽을 때(loadState → restoreFinFromSide)도 쓰므로 그보다 앞에 선언한다
  var FIELDS_170 = ['kbPrice', 'kbAt', 'kbSource', 'kbHistory', 'askHistory', 'dealPrice', 'remodelCost', 'publicPrice',
    'naverLoanLimit', 'naverRate', 'feeMonthly', 'feeAvg', 'feeSummer', 'feeWinter', 'feeRecent', 'acqTaxNaver', 'propertyTaxNaver', 'syncAt'];
  // 그중 fieldsAt 으로 시각을 남기는 칸(merge.js FIN_FIELDS 와 같음). 사본에 시각도 함께 둔다
  var FIN_TIMED = ['kbPrice', 'dealPrice', 'remodelCost', 'publicPrice', 'naverLoanLimit', 'naverRate',
    'feeMonthly', 'feeAvg', 'feeSummer', 'feeWinter', 'feeRecent', 'acqTaxNaver', 'propertyTaxNaver'];
  var HIST_SOURCES = { naver: 1, code: 1, manual: 1 };
  var HISTORY_MAX = 20; // merge.js HISTORY_MAX 와 같음
  var ASK_RANGE = [1, 10000000];
  /** 범위 안의 수(정수로 반올림)면 그 수, 아니면 null */
  function finNum(v, key) {
    var n = numOrNull(v);
    var r = FIN_NUM_RANGE[key] || ASK_RANGE;
    if (n === null) return null;
    n = Math.round(n);
    return n >= r[0] && n <= r[1] ? n : null;
  }
  /** 'YYYY-MM-DD'(있는 날짜)면 그대로, 아니면 '' */
  function isoDateOr(v) {
    var s = str(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? s : '';
  }
  function finRate(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var min = numOrNull(v.min);
    if (min === null || min < 0.1 || min > 30) return null;
    var max = numOrNull(v.max);
    if (max === null || max < min || max > 30) max = null;
    return { min: min, max: max, bank: str(v.bank).replace(/\s+/g, ' ').trim().slice(0, 30) };
  }
  function finFeeRecent(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var month = /^\d{4}-(0[1-9]|1[0-2])$/.test(str(v.month)) ? str(v.month) : '';
    var amount = finNum(v.amount, 'feeAvg');
    return month && amount !== null ? { month: month, amount: amount } : null;
  }
  /** 값 이력 정리: { value(범위 안), at('YYYY-MM-DD'|''), source, t(ms, 있으면) } 만, 최근 HISTORY_MAX 개 */
  function finHistory(v, range) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var n = numOrNull(e.value);
      if (n === null) return;
      n = Math.round(n);
      if (n < range[0] || n > range[1]) return;
      var o = { value: n, at: isoDateOr(e.at), source: HIST_SOURCES[e.source] ? e.source : '' };
      var t = numOrNull(e.t);
      if (t > 0) o.t = t;
      out.push(o);
    });
    return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
  }
  /** 매물 원본(p)의 1.7.0 값을 정리해 np 에 넣는다(normalizeProperty·restoreFinFromSide 가 같이 씀) */
  function finFieldsInto(np, p) {
    FIN_PROP_NUMS.forEach(function (k) { np[k] = finNum(p[k], k); });
    np.naverRate = finRate(p.naverRate);
    np.feeRecent = finFeeRecent(p.feeRecent);
    np.kbAt = np.kbPrice !== null ? isoDateOr(p.kbAt) : '';
    np.kbSource = np.kbPrice !== null && HIST_SOURCES[p.kbSource] ? p.kbSource : '';
    np.kbHistory = finHistory(p.kbHistory, FIN_NUM_RANGE.kbPrice);
    np.askHistory = finHistory(p.askHistory, ASK_RANGE);
    np.syncAt = timeMapOf(p.syncAt); // { 칸: 가져오기로 넣은 시각 }
    return np;
  }
  /** 1.7.0 전역 대출 조건 정리: { finance: 숫자·글·참거짓만 담은 객체 | null, financeAt: ms }. 값 검사는 finance.js normalizeSettings 가 계산 때 한다 */
  function normalizeSettingsState(v) {
    var out = { finance: null, financeAt: 0 };
    if (!v || typeof v !== 'object') return out;
    var f = v.finance;
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      var o = {};
      Object.keys(f).slice(0, 60).forEach(function (k) {
        var x = f[k];
        if (BAD_KEYS[k]) return;
        if (x === null || typeof x === 'boolean' || (typeof x === 'number' && isFinite(x)) || (typeof x === 'string' && x.length <= 40)) o[k] = x;
      });
      out.finance = Object.keys(o).length ? o : null;
    }
    var t = numOrNull(v.financeAt);
    out.financeAt = t > 0 ? t : 0;
    return out;
  }

  /** legacy(1.5.0 검토 반영): 데이터 2026-10c 보다 오래된 저장본에서 온 매물이면 바뀐 항목을 한 번 옮긴다(normalizeItems·migrateInjunction) */
  function normalizeProperty(p, legacy) {
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
      importNotes: noteList(p.importNotes), // 1.5.0: 가져오기 참고(앱 안내 문장). 상세에서 접힌 목록, 공유 글에는 안 넣음
      // 1.6.0: 매도인(파는 사람) 이름. 등기부 소유자와 비교(applyRegistrySnapshot → reg-owner-diff). 합치기는 fieldsAt 대상
      sellerName: str(p.sellerName).replace(/\s+/g, ' ').trim().slice(0, SELLER_NAME_MAX),
      // 1.6.0: 등기부 해석 기록(작은 JSON). 서류 파일(Blob)은 매물에 넣지 않고 IndexedDB 서류함(Docs)에 둔다
      registrySnapshots: [],
      items: normalizeItems(p.items, legacy),
      sectionMemos: normalizeMemos(p.sectionMemos),
      // 1.3.0 변경 시각(두 기기 합치기용). 검사와 빈 곳 채우기(예전 기록은 legacyAt)는 merge.js fillTimes
      fieldsAt: p.fieldsAt,          // { 필드: ms } 기본 정보가 바뀐 시각
      statusAt: p.statusAt,          // ms 진행 상태·탈락 사유가 바뀐 시각
      sectionMemoAt: p.sectionMemoAt, // { 섹션id: ms } 섹션 메모가 바뀐 시각(지워도 남김)
      legacyAt: p.legacyAt           // 1.3.1. ms 시각 없는 예전 기록(1.2.x)을 처음 읽은 때. 그때의 값은 모두 알고 있었다는 뜻
    };
    // 1.5.0: 1.4.x 가져오기가 메모 본문에 넣은 안내 문장은 가져오기 참고로 옮긴다(가져온 매물만. 한 번 옮기면 다음부터는 그대로)
    if (np.importedAt) {
      var sp = splitImportMemo(np.memo, np.importNotes);
      np.memo = sp.memo;
      np.importNotes = sp.notes;
    }
    if (!np.importNotes.length) delete np.importNotes; // 비면 키를 두지 않는다(합치기에서 "다른 정보"로 세지 않게)
    // 1.6.0: 지운 등기부 해석 기록 표시(180일)와 기록 목록. 표시가 비면 키를 두지 않는다
    var snapGone = normalizeDeleted(p.registrySnapshotsRemoved);
    np.registrySnapshots = normalizeSnapshots(p.registrySnapshots, snapGone);
    if (Object.keys(snapGone).length) np.registrySnapshotsRemoved = snapGone;
    finFieldsInto(np, p); // 1.7.0: 대출·비용 값(늘 같은 키)
    if (legacy && migrateInjunction(np.items) && migrationStats) migrationStats.inj++; // 1.5.0 검토 반영
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

  /**
   * 1.5.0 검토 반영: 1.4.x 저장본의 reg-seizure 문장은 "압류·가압류·가처분"이었으므로 그 "없음"은 가처분까지 부정한 답이다.
   * reg-injunction(2026-10c 에서 분리)이 아예 없으면 { status: 'no', t, ft } 로 복사한다("있음"은 셋 중 무엇인지 몰라 미확인으로 둔다).
   * 같은 입력에서 같은 결과(멱등)라 다른 기기와 합쳐도 되살아남 문제가 없다. 데이터 2026-10c 로 저장한 기록(dataVersion 있음)에는
   * 하지 않는다 — 1.5.0 에서 압류·가압류만 답하고 가처분은 아직 안 답한 매물이 다시 열 때 저절로 "없음"이 되면 안 되므로
   */
  function migrateInjunction(items) {
    var sz = items['reg-seizure'];
    if (items['reg-injunction'] || !sz || sz.status !== 'no' || !CL.itemById['reg-injunction']) return false;
    var o = { status: 'no' };
    if (sz.t) o.t = sz.t;
    if (sz.ft && sz.ft.status) o.ft = { status: sz.ft.status };
    items['reg-injunction'] = o;
    return true;
  }

  /** 홈의 "체크리스트가 바뀌었어요" 안내에 쓸 수 { inj, unitMoved, unitLost }. 모두 0 이면 null */
  function noticeStats(v) {
    if (!v || typeof v !== 'object') return null;
    var o = { inj: numOrNull(v.inj) || 0, unitMoved: numOrNull(v.unitMoved) || 0, unitLost: numOrNull(v.unitLost) || 0 };
    return o.inj || o.unitMoved || o.unitLost ? o : null;
  }

  /** 저장된 데이터를 현재 스키마로 맞춘다. (나중에 version 이 바뀌면 여기서 변환) */
  function normalizeState(data) {
    var s = emptyState();
    migrationStats = { legacy: false, inj: 0, unitMoved: 0, unitLost: 0 };
    if (!data || typeof data !== 'object') return s;
    s.rev = str(data.rev);
    // 1.5.0 검토 반영: 저장본을 쓴 데이터 버전. 없거나(1.4.x 이하) 2026-10c 보다 오래되면 바뀐 항목을 한 번 옮긴다
    s.dataVersion = str(data.dataVersion);
    var legacy = !s.dataVersion || s.dataVersion < DATA_MIGRATION_VERSION;
    migrationStats.legacy = legacy;
    s.deleted = normalizeDeleted(data.deleted);
    s.localDeleted = normalizeDeleted(data.localDeleted); // 1.3.1: 이 기기 초기화(전체 삭제·덮어쓰기)로 지운 매물
    s.goneKeys = normalizeDeleted(data.goneKeys); // 모양이 같다({ 열쇠: 시각 }, 180일 보관)
    var list = Array.isArray(data.properties) ? data.properties : [];
    var seen = {};
    list.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var np = normalizeProperty(p, legacy);
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
      // 1.4.5: 백업 "사진도 함께 넣기"의 마지막 선택. 고른 적이 없으면 null(사진 수·크기로 기본값을 정함)
      s.ui.backupWithPhotos = typeof data.ui.backupWithPhotos === 'boolean' ? data.ui.backupWithPhotos : null;
      s.ui.dataNotice = noticeStats(data.ui.dataNotice); // 1.5.0 검토 반영: 홈의 "체크리스트가 바뀌었어요" 안내(✕ 로 닫으면 null)
    }
    s.settings = normalizeSettingsState(data.settings); // 1.7.0: 전역 대출 조건
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
    // 1.6.0 검토 반영: 예전(1.5.x) 탭이 1.6.0 필드를 빼고 저장해 두었으면 따로 둔 키에서 되살리고 다시 저장한다
    if (restoreFromSide(s, obj)) migratedOnLoad = true;
    if (restoreFinFromSide(s, obj)) migratedOnLoad = true; // 1.7.0: 예전(1.6.0 이하) 탭이 지운 대출·비용 값·대출 조건
    // 1.5.0 검토 반영: 옛 저장본(1.4.x)을 처음 읽었으면 옮긴 수를 홈 안내(ui.dataNotice)에 남기고, init 이 dataVersion 을 적어 다시 저장한다
    var m = migrationStats;
    if (m && m.legacy) {
      if (m.inj || m.unitMoved || m.unitLost) s.ui.dataNotice = { inj: m.inj, unitMoved: m.unitMoved, unitLost: m.unitLost };
      migratedOnLoad = true;
    }
    if (CL.version) s.dataVersion = CL.version; // 메모리의 state 는 지금 데이터 기준(사본을 다시 정리해도(computeMerge) 또 옮기지 않게)
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
  // 1.6.0 에서 늘어난 매물 필드(매도인 이름, 등기부 해석 기록). 1.6.0 은 늘 이 키를 적으므로, 키가 없으면 예전(1.5.x) 탭이 쓴 매물이다.
  // 합칠 때는 내 값이 이기지만(merge.js LATE_FIELDS·기록 합집합) 저장본에서는 빠진 채라, 다시 저장해 되돌린다(needResave)
  var FIELDS_160 = ['sellerName', 'registrySnapshots'];
  // 1.7.0 에서 늘어난 매물 필드는 FIELDS_170·FIN_TIMED(위 '대출·비용 값' 묶음. loadState 가 쓰므로 그 앞에 둔다)
  var needResave = false; // 합치면서 예전 탭이 지운 필드를 되살렸으면 다시 저장해 저장본에도 되돌려 놓는다
  /** 빈 값('' null undefined, 빈 배열) */
  function blankVal(v) { return v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length); }

  /**
   * 1.6.0 검토 반영: 1.6.0 필드 사본(REG_SIDE_KEY)을 쓴다 — { v: 1, props: { 매물id: { sellerName, sellerNameAt, registrySnapshots, registrySnapshotsRemoved } } }.
   * 1.6.0 탭을 닫은 뒤 아직 새로고침하지 않은 1.5.x 탭이 저장하면 이 필드가 키째 빠지고, 합칠 1.6.0 탭이 없어 영구히 사라졌다.
   * 1.5.x 는 이 키를 모르므로 남아 있다가 다음 1.6.0 시작(loadState → restoreFromSide) 때 되살린다. 본 저장이 된 뒤에만 부르고, 실패해도 조용히 넘어간다
   */
  function writeSide(s) {
    try {
      var props = {};
      (s.properties || []).forEach(function (p) {
        var o = {};
        if (p.sellerName) {
          o.sellerName = p.sellerName;
          if (p.fieldsAt && numOrNull(p.fieldsAt.sellerName) > 0) o.sellerNameAt = p.fieldsAt.sellerName;
        }
        if (p.registrySnapshots && p.registrySnapshots.length) o.registrySnapshots = p.registrySnapshots;
        if (p.registrySnapshotsRemoved && Object.keys(p.registrySnapshotsRemoved).length) o.registrySnapshotsRemoved = p.registrySnapshotsRemoved;
        if (Object.keys(o).length) props[p.id] = o;
      });
      if (Object.keys(props).length) localStorage.setItem(REG_SIDE_KEY, JSON.stringify({ v: 1, props: props }));
      else localStorage.removeItem(REG_SIDE_KEY);
    } catch (e) { /* 저장 공간 부족 등: 본 저장은 됐다. 다음 저장 때 다시 */ }
  }
  /**
   * 저장본 원문(raw)에서 1.6.0 필드 키가 아예 없는 매물(예전 탭이 씀)에 사본의 값을 되살린다. 되살렸으면 true(→ 다시 저장).
   * 키가 있으면(1.6.0 이 쓴 저장본) 빈 값이어도 그대로 둔다(사용자가 지운 것)
   */
  function restoreFromSide(s, raw) {
    var side = null;
    try { side = parseStored(localStorage.getItem(REG_SIDE_KEY)); } catch (e) { return false; }
    side = side && side.props && typeof side.props === 'object' && !Array.isArray(side.props) ? side.props : null;
    if (!side) return false;
    var rawById = {};
    (raw && Array.isArray(raw.properties) ? raw.properties : []).forEach(function (p) {
      if (p && typeof p === 'object' && p.id && !BAD_KEYS[p.id]) rawById[str(p.id)] = p;
    });
    var changed = false;
    s.properties.forEach(function (p) {
      var r = hasOwn(rawById, p.id) ? rawById[p.id] : null;
      var d = hasOwn(side, p.id) && !BAD_KEYS[p.id] ? side[p.id] : null;
      if (!r || !d || typeof d !== 'object') return;
      if (!hasOwn(r, 'sellerName') && !p.sellerName && d.sellerName) {
        p.sellerName = str(d.sellerName).replace(/\s+/g, ' ').trim().slice(0, SELLER_NAME_MAX);
        if (!p.fieldsAt || typeof p.fieldsAt !== 'object') p.fieldsAt = {};
        if (numOrNull(d.sellerNameAt) > 0 && !(numOrNull(p.fieldsAt.sellerName) > 0)) p.fieldsAt.sellerName = numOrNull(d.sellerNameAt);
        changed = true;
      }
      if (!hasOwn(r, 'registrySnapshots') && !(p.registrySnapshots || []).length && Array.isArray(d.registrySnapshots) && d.registrySnapshots.length) {
        var gone = normalizeDeleted(d.registrySnapshotsRemoved);
        p.registrySnapshots = normalizeSnapshots(d.registrySnapshots, gone);
        if (Object.keys(gone).length) p.registrySnapshotsRemoved = gone;
        changed = true;
      }
    });
    return changed;
  }

  /**
   * 1.7.0: 1.7.0 필드 사본(FIN_SIDE_KEY)을 쓴다 — { v: 1, props: { 매물id: { 값…, fa: { 칸: 시각 } } }, settings: { finance, financeAt } }.
   * 1.6.0 이하 탭은 이 키를 몰라 남아 있다가, 그 탭이 대출·비용 값을 빼고 저장한 뒤 1.7.0 이 시작할 때(restoreFinFromSide) 되살린다.
   * 본 저장이 된 뒤에만 부르고, 실패해도 조용히 넘어간다
   */
  function writeFinSide(s) {
    try {
      var props = {};
      (s.properties || []).forEach(function (p) {
        var o = {};
        var fa = {};
        FIELDS_170.forEach(function (k) {
          var x = p[k];
          if (!blankVal(x) && !(x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length)) o[k] = x;
        });
        FIN_TIMED.forEach(function (k) {
          if (p.fieldsAt && numOrNull(p.fieldsAt[k]) > 0) fa[k] = p.fieldsAt[k];
        });
        if (!Object.keys(o).length && !Object.keys(fa).length) return;
        if (Object.keys(fa).length) o.fa = fa;
        props[p.id] = o;
      });
      var st = s.settings && s.settings.finance ? { finance: s.settings.finance, financeAt: s.settings.financeAt || 0 } : null;
      if (Object.keys(props).length || st) {
        var side = { v: 1, props: props };
        if (st) side.settings = st;
        localStorage.setItem(FIN_SIDE_KEY, JSON.stringify(side));
      } else localStorage.removeItem(FIN_SIDE_KEY);
    } catch (e) { /* 저장 공간 부족 등: 본 저장은 됐다. 다음 저장 때 다시 */ }
  }
  /**
   * 1.7.0: 저장본 원문(raw)에서 1.7.0 키(kbHistory)가 아예 없는 매물(예전 탭이 씀)에 사본의 값을 되살린다. 지금 비어 있는 칸만 채우고,
   * 그 칸의 시각(fa)도 되돌린다. 저장본에 settings 키가 없으면(예전 탭이 씀) 대출 조건도 되살린다. 되살렸으면 true(→ 다시 저장)
   */
  function restoreFinFromSide(s, raw) {
    var side = null;
    try { side = parseStored(localStorage.getItem(FIN_SIDE_KEY)); } catch (e) { return false; }
    if (!side || typeof side !== 'object') return false;
    var changed = false;
    var sp = side.props && typeof side.props === 'object' && !Array.isArray(side.props) ? side.props : {};
    var rawById = {};
    (raw && Array.isArray(raw.properties) ? raw.properties : []).forEach(function (p) {
      if (p && typeof p === 'object' && p.id && !BAD_KEYS[p.id]) rawById[str(p.id)] = p;
    });
    s.properties.forEach(function (p) {
      var r = hasOwn(rawById, p.id) ? rawById[p.id] : null;
      var d = hasOwn(sp, p.id) && !BAD_KEYS[p.id] ? sp[p.id] : null;
      if (!r || !d || typeof d !== 'object' || hasOwn(r, 'kbHistory')) return;
      var back = finFieldsInto({}, d);
      var fa = d.fa && typeof d.fa === 'object' ? d.fa : {};
      if (!p.fieldsAt || typeof p.fieldsAt !== 'object') p.fieldsAt = {};
      FIN_TIMED.forEach(function (k) {
        if (!blankVal(p[k]) || blankVal(back[k])) return;
        p[k] = back[k];
        if (k === 'kbPrice') { p.kbAt = back.kbAt; p.kbSource = back.kbSource; }
        if (numOrNull(fa[k]) > 0 && !(numOrNull(p.fieldsAt[k]) > 0)) p.fieldsAt[k] = numOrNull(fa[k]);
        changed = true;
      });
      ['kbHistory', 'askHistory'].forEach(function (k) {
        if ((p[k] || []).length || !back[k].length) return;
        p[k] = back[k];
        changed = true;
      });
      if (!p.syncAt || typeof p.syncAt !== 'object') p.syncAt = {};
      Object.keys(back.syncAt).forEach(function (k) {
        if (!(p.syncAt[k] >= back.syncAt[k])) { p.syncAt[k] = back.syncAt[k]; changed = true; }
      });
    });
    var ss = side.settings ? normalizeSettingsState(side.settings) : null;
    if (ss && ss.finance && raw && !hasOwn(raw, 'settings') && !(s.settings && s.settings.finance)) {
      s.settings = ss;
      changed = true;
    }
    return changed;
  }

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

  /** 저장본 원문에서 매물별로 아예 없는 1.2.0·1.6.0 필드 키 { id: [키…] } (빈 값과 구분: 키가 없을 때만) */
  function missingNewFields(raw) {
    var out = {};
    (raw && Array.isArray(raw.properties) ? raw.properties : []).forEach(function (p) {
      if (!p || typeof p !== 'object' || !p.id || BAD_KEYS[p.id]) return;
      var miss = FIELDS_120.concat(FIELDS_160, FIELDS_170).filter(function (k) { return !hasOwn(p, k); });
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
        // 1.6.0: 예전(1.5.x) 탭이 새 필드를 모른 채 저장했으면 합친 결과(내 값)를 저장본에도 되돌린다
        var miss = missing && hasOwn(missing, p.id) ? missing[p.id] : [];
        // 1.7.0: 대출·비용 필드도 같은 방식(나중에 늘어난 칸이라 합치면 내 값이 이기고, 저장본에는 다시 써서 되돌린다)
        if (FIELDS_160.concat(FIELDS_170).some(function (k) { return miss.indexOf(k) >= 0 && !blankVal(mine[k]); })) needResave = true;
        return;
      }
      // 예전 버전 탭이 쓴 매물(또는 merge.js 를 못 불러옴): 매물 단위로 더 나중 것
      if ((p.updatedAt || 0) > (mine.updatedAt || 0)) {
        var keep = {};
        (missing && hasOwn(missing, p.id) ? missing[p.id] : []).forEach(function (k) {
          if (!blankVal(mine[k])) keep[k] = mine[k];
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
    // 1.7.0: 전역 대출 조건은 더 나중에 바꾼 쪽
    var ta = target.settings ? numOrNull(target.settings.financeAt) || 0 : 0;
    var tb = incoming.settings ? numOrNull(incoming.settings.financeAt) || 0 : 0;
    if (tb > ta) { target.settings = normalizeSettingsState(incoming.settings); changed = true; }
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
    // 1.7.0: 예전 탭이 settings 키 없이 썼는데 내게 대출 조건이 있으면 저장본에도 되돌린다
    if (!hasOwn(obj, 'settings') && state.settings && state.settings.finance) needResave = true;
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
      if (CL.version) state.dataVersion = CL.version; // 1.5.0 검토 반영: 어느 데이터 기준으로 쓴 저장본인지(읽을 때 옛 항목 옮기기 판단)
      state.rev = uid();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      knownRev = state.rev;
      writeSide(state); // 1.6.0 검토 반영: 1.6.0 필드 사본(예전 탭이 지워도 되살리게)
      writeFinSide(state); // 1.7.0: 대출·비용 값·대출 조건 사본
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
      if (CL.version) candidate.dataVersion = CL.version;
      candidate.rev = uid();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      knownRev = candidate.rev;
      writeSide(candidate);
      writeFinSide(candidate); // 1.7.0
      return true;
    } catch (e) {
      // 1.4.5: 실패 표시를 남겨야 다음 성공 저장(saveNow)이 빨간 띠를 지운다(전에는 새로고침할 때까지 남았음)
      saveFailed = true;
      showSaveError(e);
      updateSaveState();
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
      ? '저장 공간이 부족해 기록을 저장하지 못했어요. 설정에서 백업한 뒤 필요 없는 매물이나 사진을 지워 주세요.'
      : blocked
        ? '이 기기에서 기록을 저장할 수 없어요. iPhone 설정 → Safari → "모든 쿠키 차단"이 켜져 있으면 꺼 주세요. 지금 입력한 내용은 이 화면을 닫으면 사라져요.'
        : '기록을 저장하지 못했어요. 다음 입력 때 다시 저장해 볼게요. 계속 이 안내가 보이면 설정에서 백업해 두세요. 이 화면을 닫으면 저장하지 못한 기록이 사라질 수 있어요.';
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
    // 1.5.1 검토 반영: 이 탭에서 고친 매물은 돌아간 홈에서 필터 조건 밖이어도 한 번 보인다(renderHome → applyHomeFilter 의 revealed)
    if (homeReveal && view.name !== 'home') homeReveal[prop.id] = true;
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

  // ---- 1.6.0: 등기부 해석 기록 다루기(통합 단계의 해석 화면·가져오기가 쓴다) ----
  /** 매물의 등기부 해석 기록(사본 아님), 최근 열람(없으면 만든 때) 순 */
  function registrySnapshotsOf(prop) {
    return (prop.registrySnapshots || []).slice().sort(function (a, b) {
      return ((b.viewedAt || b.addedAt) - (a.viewedAt || a.addedAt)) || (b.addedAt - a.addedAt);
    });
  }
  function findSnapshot(prop, id) {
    var list = prop.registrySnapshots || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** 서류함 레코드(docId)를 해석한 가장 최근 기록. 없으면 null */
  function snapshotForDoc(prop, docId) {
    var hit = null;
    (prop.registrySnapshots || []).forEach(function (s) { if (s.docId === docId && (!hit || s.addedAt > hit.addedAt)) hit = s; });
    return hit;
  }
  /**
   * 기록을 매물에 넣는다(정리해서). 같은 id 가 있으면 바꾼다(t 를 올림). 지운 기록 표시가 있던 id 면 표시를 지운다.
   * 결과: 넣은 기록(매물 안의 객체). 정리할 수 없는 값이면 null
   */
  function addRegistrySnapshot(prop, raw) {
    var s = normalizeSnapshot(raw);
    if (!s) return null;
    var now = Date.now();
    var old = findSnapshot(prop, s.id);
    var gone = prop.registrySnapshotsRemoved && prop.registrySnapshotsRemoved[s.id];
    s.t = stampAfter(Math.max(now, s.t), old && old.t, gone, prop.legacyAt);
    if (!Array.isArray(prop.registrySnapshots)) prop.registrySnapshots = [];
    if (old) prop.registrySnapshots.splice(prop.registrySnapshots.indexOf(old), 1, s);
    else prop.registrySnapshots.push(s);
    if (gone) {
      delete prop.registrySnapshotsRemoved[s.id];
      if (!Object.keys(prop.registrySnapshotsRemoved).length) delete prop.registrySnapshotsRemoved;
    }
    prop.registrySnapshots = normalizeSnapshots(prop.registrySnapshots);
    touch(prop, s.t);
    return findSnapshot(prop, s.id); // 넘쳐서 버려졌으면 null(가장 오래된 것이 아닌 한 남음)
  }
  /** 기록을 지운다. 다른 탭·기기와 합칠 때 되살아나지 않게 지운 시각을 남긴다(registrySnapshotsRemoved). 지웠으면 true */
  function removeRegistrySnapshot(prop, id) {
    var s = findSnapshot(prop, id);
    if (!s || BAD_KEYS[id]) return false;
    var t = stampAfter(Date.now(), s.t);
    prop.registrySnapshots = prop.registrySnapshots.filter(function (x) { return x !== s; });
    if (!prop.registrySnapshotsRemoved) prop.registrySnapshotsRemoved = {};
    prop.registrySnapshotsRemoved[id] = t;
    touch(prop, t);
    return true;
  }

  /** 이름 비교용 열쇠: NFC, 소문자, 공백 제거. dropInner 면 괄호 안 글자까지 뺌("홍길동(洪吉童)" → "홍길동") */
  function personKey(s, dropInner) {
    s = str(s);
    if (s.normalize) s = s.normalize('NFC');
    if (dropInner) s = s.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, '');
    return s.replace(/[\s()（）[\]]/g, '').toLowerCase();
  }
  /** 두 이름이 같은 사람인지(공백·괄호 무시. 괄호 안을 빼고 같거나, 괄호 기호만 빼고 같으면) */
  function samePerson(a, b) {
    var a1 = personKey(a, true);
    var a2 = personKey(a, false);
    return !!((a1 && a1 === personKey(b, true)) || (a2 && a2 === personKey(b, false)));
  }
  /** 매도인 이름 칸을 사람별로 나눈다(공동명의라 "홍길동, 김철수"처럼 여러 명을 적었을 때) */
  function sellerNames(v) {
    return str(v).split(/[,，、·\/&＆+＋]|\s및\s/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // 근저당권자가 금융회사·법인인지(메모에 이름을 적어도 되는지). 아니면 "개인 근저당권자"로만 적는다
  var LENDER_RE = /은행|금고|조합|캐피탈|보험|카드|저축|신협|농협|수협|새마을|공사|공단|기금|증권|투자|대부|금융|신탁|주식회사|유한회사|\(주\)|㈜/;
  // 항목 메모 안의 "앱이 적은 묶음"(등기부 해석 요약). 이 머리말 줄부터 "· "로 시작하는 줄까지를 통째로 바꾼다(사용자가 쓴 글은 그대로)
  var SNAP_MEMO_HEAD = '[등기부 해석';
  function snapMemoBlock(memo, lines) {
    var src = str(memo).split('\n');
    var at = -1;
    for (var i = 0; i < src.length; i++) if (src[i].indexOf(SNAP_MEMO_HEAD) === 0) { at = i; break; }
    if (at >= 0) {
      var end = at + 1;
      while (end < src.length && src[end].indexOf('· ') === 0) end++;
      src.splice.apply(src, [at, end - at].concat(lines));
    } else if (lines.length) {
      while (src.length && !src[src.length - 1].trim()) src.pop();
      src = src.concat(src.length ? [''] : [], lines);
    }
    return src.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  /** 항목 값의 시각(앱이 넣은 답인지 가릴 때): ft[값] → t */
  function itemValueTime(st, field) { return (st.ft && st.ft[field]) || st.t || 0; }

  /**
   * 1.6.0: 등기부 해석 기록(snapshot)을 등기부 항목 답으로 반영한다(setItemState 경유 → 시각·합치기 규칙 그대로).
   * snapshot: 위 모양(registry-parser 결과·가져오기 코드 registry 블록을 같은 모양으로 넘김). 매물에 없는 기록이면 넣는다(dryRun 이 아니면).
   * opts: { overwrite: true | { 항목id: true }(사용자가 이미 다르게 답한 항목도 바꿈), dryRun(바꾸지 않고 결과만), noRefresh(화면 다시 그리지 않음),
   *         titleMismatch(1.6.0 통합: '동·호' 같은 글. 등기부의 동·호가 매물과 다르면 reg-title 을 답하지 않고 메모로 알림) }
   * 규칙:
   *  - snapshot.answers 의 flag(yes/no)·check(done) 답. 사용자가 이미 다르게 답한 flag 는 overwrite 가 아니면 건너뛰고 skipped 로 돌려준다.
   *    앞서 이 함수가 넣은 답이고 그 뒤 손대지 않았으면(기록의 applied 와 값·시각이 같음) 사용자 답으로 치지 않고 새 기록으로 바꾼다.
   *    1.6.0 검토 반영: 단 그 답을 넣은 기록이 이 기록보다 열람 일시가 나중이면(더 새 등기부) 사용자 답처럼 skipped 로 돌려 묻는다
   *  - reg-view·reg-date 는 done(열람했고 서류를 남김). reg-date 메모에 열람 일시
   *  - reg-title: 표제부 전용면적이 매물 전용면적과 0.05㎡ 안이면 done. 다르거나 비교할 수 없으면 답하지 않고 메모·결과로 알림
   *  - 매도인 이름(sellerName)이 있고 소유자를 읽었으면 reg-owner-diff 답(공백·괄호 무시 비교. 여러 명을 적었으면 모두 소유자여야 "없음").
   *    1.6.0 검토 반영: 기록의 ownersUncertain(소유자 계산 불확실)이면 "없음"은 넣지 않고(메모로 알림) reg-joint done 도 넣지 않는다
   *  - 소유자를 읽었으면 reg-joint done + 메모에 소유자 수(공동명의 안내). 이름은 메모에 적지 않는다(공유 글에 실리므로)
   *  - 근저당이 있으면 reg-mortgage 메모에 근저당 요약(답이 없으면 "있음")
   *  - 메모는 사용자가 쓴 글을 지우지 않고 "[등기부 해석 …]" 묶음만 넣거나 바꾼다
   * 결과: { ok, snapshotId, dryRun, applied:[{ id, value, prev }], skipped:[{ id, value, current }], same:[id], ignored:[id],
   *         memos:[id], title: { match: true|false|null, snapArea, propArea, diff }, owner: { match: true|false|null, owners, sellers }, notes:[문장] }
   */
  function applyRegistrySnapshot(prop, snapshot, opts) {
    opts = opts || {};
    var dry = !!opts.dryRun;
    var res = {
      ok: false, snapshotId: null, dryRun: dry, applied: [], skipped: [], same: [], ignored: [], memos: [],
      title: { match: null, snapArea: null, propArea: null, diff: null }, owner: { match: null, owners: 0, sellers: 0 }, notes: []
    };
    if (!prop || !snapshot) return res;
    var snap = normalizeSnapshot(snapshot);
    if (!snap) return res;
    var stored = findSnapshot(prop, snap.id);
    if (!dry && !stored) stored = addRegistrySnapshot(prop, snap);
    var src = stored || snap;
    res.ok = true;
    res.snapshotId = src.id;
    var now = Date.now();
    var viewed = regViewedText(src.viewedAt, src.docType); // 1.6.0 통합: 제출용은 발행일만 있어 "2026.10.10 발행"
    var head = SNAP_MEMO_HEAD + ' · ' + viewed + ']';

    // 1) 넣을 답: 기록의 answers + 앱이 셈한 것
    var want = {};
    Object.keys(src.answers).forEach(function (k) { want[k] = src.answers[k]; });
    var memoOf = {}; // 항목id → 메모 묶음 줄(머리말 포함). 빈 배열이면 예전 묶음을 지움
    want['reg-view'] = 'done';
    want['reg-date'] = 'done';
    var kindLine = [src.docType, src.includesCancelled === true && src.docType.indexOf('말소') < 0 ? '말소사항 포함'
      : src.includesCancelled === false ? '현재 유효사항만(지난 기록은 안 보임)' : ''].filter(Boolean).join(' · ');
    memoOf['reg-date'] = [head].concat(kindLine ? ['· ' + kindLine] : []);
    // 표제부 전용면적 ↔ 매물 전용면적
    var pa = numOrNull(prop.area);
    res.title.snapArea = src.area;
    res.title.propArea = pa;
    delete want['reg-title']; // 면적으로만 정한다
    if (src.area && pa) {
      var diff = Math.round(Math.abs(src.area - pa) * 10000) / 10000;
      res.title.diff = diff;
      res.title.match = diff <= 0.05;
      if (res.title.match) {
        want['reg-title'] = 'done';
        memoOf['reg-title'] = [head, '· 표제부 전용면적 ' + src.area + '㎡ = 매물 정보와 같아요'];
      } else {
        memoOf['reg-title'] = [head, '· 표제부 전용면적 ' + src.area + '㎡ ≠ 매물 정보 ' + pa + '㎡ — 다른 호수의 서류인지 확인하세요'];
        res.notes.push('표제부 전용면적(' + src.area + '㎡)이 매물 정보(' + pa + '㎡)와 달라요. 다른 호수의 등기부인지 확인하세요.');
      }
    } else if (src.area) {
      memoOf['reg-title'] = [head, '· 표제부 전용면적 ' + src.area + '㎡ (매물 정보에 전용면적이 없어 비교하지 못했어요)'];
      res.notes.push('매물 정보에 전용면적이 없어 표제부와 비교하지 못했어요.');
    }
    // 1.6.0 통합: 등기부의 동·호가 매물과 다르면(registryUnitCheck) 면적이 같아도 표제부 일치로 답하지 않는다
    if (opts.titleMismatch) {
      delete want['reg-title'];
      res.title.match = false;
      memoOf['reg-title'] = [head, '· 등기부의 ' + josa(opts.titleMismatch, '이', '가') + ' 매물 정보와 달라요 — 다른 집 서류인지 확인하세요'];
      res.notes.push('등기부의 ' + josa(opts.titleMismatch, '이', '가') + ' 매물 정보와 달라요.');
    }
    // 소유자 ↔ 매도인 이름
    var owners = src.owners;
    var sellers = sellerNames(prop.sellerName);
    // 1.6.0 검토 반영: 소유자 계산이 불확실하면(지분 계산·이름을 못 읽음·모르는 소유권 말소) 공동명의 확인 체크와 매도인 비교 "없음"을 넣지 않는다
    var ownersUnsure = !!src.ownersUncertain;
    res.owner.owners = owners.length;
    res.owner.sellers = sellers.length;
    if (owners.length && !ownersUnsure) {
      if (!want['reg-joint']) want['reg-joint'] = 'done';
      memoOf['reg-joint'] = [head, owners.length > 1
        ? '· 소유자 ' + owners.length + '명(공동명의) — 팔려면 소유자 모두가 동의해야 해요'
        : '· 소유자 1명'];
    } else if (owners.length) {
      delete want['reg-joint'];
      delete want['reg-period'];
      memoOf['reg-joint'] = [head, '· 소유자 ' + owners.length + '명으로 읽었지만 소유자 계산이 확실하지 않아요 — 원본 갑구를 직접 보세요'];
    }
    if (owners.length && sellers.length) {
      var allIn = sellers.every(function (n) { return owners.some(function (o) { return samePerson(o.name, n); }); });
      if (allIn && ownersUnsure) {
        delete want['reg-owner-diff'];
        memoOf['reg-owner-diff'] = [head, '· 매도인 이름이 등기부 소유자와 같아 보이지만 소유자 계산이 확실하지 않아 답하지 않았어요 — 원본 갑구를 직접 보세요'];
        res.notes.push('소유자 계산이 확실하지 않아 "소유자 ≠ 매도인"은 답하지 않았어요.');
      } else {
        res.owner.match = allIn;
        want['reg-owner-diff'] = allIn ? 'no' : 'yes';
        memoOf['reg-owner-diff'] = [head, allIn
          ? '· 매도인 이름이 등기부 소유자와 같아요(앱이 비교, 공백·괄호 무시)'
          : '· 매도인 이름과 같은 소유자가 등기부에 없어요(앱이 비교, 공백·괄호 무시) — 이유가 풀리기 전에는 진행하지 마세요'];
        if (!allIn) res.notes.push('매도인 이름이 등기부 소유자와 달라요.');
      }
    } else if (owners.length) {
      res.notes.push('매물 정보에 매도인 이름을 적으면 등기부 소유자와 비교해 드려요.');
    }
    // 근저당 요약
    var mg = src.mortgages;
    if (mg.length) {
      if (!want['reg-mortgage']) want['reg-mortgage'] = 'yes';
      var sum = 0;
      var known = 0;
      mg.forEach(function (m) { if (m.maxAmount !== null) { sum += m.maxAmount; known++; } });
      var lines = [head, '· 말소되지 않은 근저당 ' + mg.length + '건' + (known ? ' · 채권최고액 합계 ' + formatManwon(sum / 10000) + (known < mg.length ? '(금액을 읽은 ' + known + '건)' : '') : '')];
      // 메모는 공유 글에 실리므로 사람 이름은 적지 않는다: 근저당권자는 금융회사 이름만(사람이면 "개인"),
      // 채무자는 소유자와 같은지만(소유자가 아닌 사람의 빚이면 따로 알림)
      mg.forEach(function (m) {
        var debtor = !m.debtor ? '' : owners.some(function (o) { return samePerson(o.name, m.debtor); }) ? '채무자 = 소유자' : '채무자는 소유자가 아님';
        lines.push('· ' + [m.rank ? '을구 ' + m.rank + '번' : '', m.maxAmount !== null ? '채권최고액 ' + formatManwon(m.maxAmount / 10000) : '',
          m.holder ? (LENDER_RE.test(m.holder) ? m.holder : '개인 근저당권자') : '', debtor].filter(Boolean).join(' · '));
      });
      memoOf['reg-mortgage'] = lines;
    } else if (want['reg-mortgage'] === 'no') {
      memoOf['reg-mortgage'] = []; // 예전 기록이 남긴 근저당 요약을 지운다
    }

    // 2) 항목 답 반영
    var applied = {};
    Object.keys(want).forEach(function (id) {
      var it = CL.itemById[id];
      var v = want[id];
      if (!it || !((it.type === 'flag' && (v === 'yes' || v === 'no')) || (it.type === 'check' && v === 'done'))) { res.ignored.push(id); return; }
      var field = it.type === 'flag' ? 'status' : 'done';
      var cur = getItemState(prop, id);
      var curV = it.type === 'flag' ? (cur.status === 'yes' || cur.status === 'no' ? cur.status : '') : (cur.done ? 'done' : '');
      if (curV === v) { res.same.push(id); return; }
      if (curV) {
        // 앞서 이 함수가 넣고 그 뒤 손대지 않은 답이면 사용자 답이 아니다.
        // 1.6.0 검토 반영: 단, 이 기록보다 열람 일시가 나중인(더 새) 등기부가 넣은 답은 사용자 답처럼 묻는다
        // (옛 서류를 다시 읽거나 나중에 올려 새 등기부의 "있음"이 말없이 "없음"으로 돌아가지 않게)
        var inV = src.viewedAt || 0;
        var mine = (prop.registrySnapshots || []).some(function (s) {
          var a = s.applied && s.applied[id];
          if (!a || a.v !== curV || a.t !== itemValueTime(cur, field)) return false;
          return s.id === src.id || !inV || !s.viewedAt || s.viewedAt <= inV;
        });
        var force = opts.overwrite === true || (opts.overwrite && typeof opts.overwrite === 'object' && opts.overwrite[id] === true);
        if (!mine && !force) { res.skipped.push({ id: id, value: v, current: curV }); return; }
      }
      res.applied.push({ id: id, value: v, prev: curV || null });
      if (dry) return;
      setItemState(prop, id, it.type === 'flag' ? { status: v } : { done: true });
      applied[id] = { v: v, t: itemValueTime(getItemState(prop, id), field) };
    });

    // 3) 메모 묶음(사용자 글은 그대로)
    Object.keys(memoOf).forEach(function (id) {
      var it = CL.itemById[id];
      if (!it || it.type === 'ask') return;
      var cur = getItemState(prop, id);
      var next = snapMemoBlock(cur.memo, memoOf[id]);
      if (next === str(cur.memo).trim() || (!next && !cur.memo)) return;
      res.memos.push(id);
      if (!dry) setItemState(prop, id, { memo: next });
    });
    // 메모를 고치면 항목 시각이 바뀌지만 값 시각(ft.status·ft.done)은 그대로라 "앱이 넣은 답" 판단은 유지된다

    if (res.skipped.length) res.notes.push('이미 다르게 답한 항목 ' + res.skipped.length + '개는 그대로 두었어요.');
    if (!dry && stored) {
      // 반영한 기록: 이번에 바꾼 답과 그 시각을 남긴다(다음 기록을 반영할 때 "앱이 넣은 답"인지 가림)
      stored.applied = Object.assign({}, stored.applied || {}, applied);
      stored.appliedAt = stampAfter(now, stored.appliedAt);
      stored.t = stampAfter(now, stored.t);
      touch(prop, stored.t);
    }
    // 상세 화면을 보고 있으면 다시 그린다(입력 중·대화상자가 열려 있으면 refreshViewSoon 이 기다렸다 그림)
    if (!dry && !opts.noRefresh && (res.applied.length || res.memos.length) && view.prop === prop && view.name === 'detail') refreshViewSoon();
    return res;
  }

  // =====================================================
  // 5. 사진·서류 저장소 (IndexedDB 'imjang-photos')
  //    사진 레코드(object store 'photos'): { id, propertyId, itemId|null, sectionId|null, blob, createdAt }
  //    1.6.0 서류 레코드(object store 'docs'): { id, propertyId, kind: 'registry'|'building'|'contract'|'other', name, mime, size, addedAt, blob }
  //    DB 버전 2(1.6.0)에서 'docs' 를 더했다. 업그레이드는 없는 저장소만 만들고 사진은 건드리지 않는다
  // =====================================================

  /** 1.6.0: 사진·서류가 함께 쓰는 DB 연결(업그레이드·막힘·연결 끊김 처리) */
  var IDB = (function () {
    var dbPromise = null;
    var currentDb = null;
    var waitingReq = null; // 다른 탭이 예전 버전으로 열어 두어 업그레이드를 기다리는 요청(onblocked 뒤 success 를 기다림)
    var blocked = false;
    var listeners = [];

    function forget() {
      // iOS 에서 앱을 오래 내려 두면 IndexedDB 연결이 끊길 수 있다 → 다음 요청 때 새로 연다.
      // 다른 탭이 더 새 버전으로 열려고 할 때(versionchange)도 닫아 그 탭의 업그레이드를 막지 않는다
      if (currentDb) { try { currentDb.close(); } catch (e) { /* 무시 */ } }
      currentDb = null;
      dbPromise = null;
    }

    function isConnectionError(err) {
      if (!err) return false;
      return err.name === 'InvalidStateError' || err.name === 'UnknownError' ||
        /connection|closing|closed/i.test(String(err.message || ''));
    }

    function setBlocked(on) {
      if (blocked === on) return;
      blocked = on;
      listeners.forEach(function (fn) { try { fn(on); } catch (e) { console.error(e); } });
    }
    function blockedError() {
      var e = new Error('다른 탭(창)에 예전 버전 앱이 열려 있어 사진·서류 저장소를 새로 맞추지 못하고 있어요');
      e.name = 'BlockedError';
      return e;
    }

    /** 없는 저장소만 만든다(있는 것·사진 레코드는 그대로) */
    function upgrade(db) {
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' }).createIndex('propertyId', 'propertyId', { unique: false });
      }
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: 'id' }).createIndex('propertyId', 'propertyId', { unique: false });
      }
    }

    function watch(db) {
      currentDb = db;
      db.onversionchange = function () { forget(); };
      db.onclose = function () { if (currentDb === db) { currentDb = null; dbPromise = null; } };
    }

    /**
     * 버전 없이 지금 있는 그대로 연다(업그레이드가 실패했거나, 더 새 앱이 버전을 올려 둔 경우).
     * 사진은 그대로 쓰고, 서류 저장소가 없으면 서류함만 못 쓴다(Docs 가 NotFoundError 로 알림)
     */
    function openAsIs() {
      return new Promise(function (resolve, reject) {
        var req;
        try { req = indexedDB.open(PHOTO_DB_NAME); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function () { upgrade(req.result); }; // DB 가 아예 없을 때만(버전 1 로 새로 만듦)
        req.onsuccess = function () { watch(req.result); resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }

    function open() {
      if (dbPromise) return dbPromise;
      if (waitingReq) return Promise.reject(blockedError()); // 아직 다른 탭을 기다리는 중
      var p = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('이 브라우저는 IndexedDB 를 지원하지 않아요')); return; }
        var req;
        try { req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION); } catch (e) { reject(e); return; }
        var settled = false;
        req.onupgradeneeded = function () { upgrade(req.result); };
        req.onsuccess = function () {
          var db = req.result;
          waitingReq = null;
          watch(db);
          if (!settled) { settled = true; resolve(db); }
          else dbPromise = Promise.resolve(db); // 막혔다가 풀림: 다음 요청부터 이 연결을 쓴다
          setBlocked(false);
        };
        req.onerror = function (ev) {
          var err = req.error;
          if (ev && ev.preventDefault) ev.preventDefault();
          waitingReq = null;
          setBlocked(false);
          if (settled) return;
          settled = true;
          // 업그레이드 실패(AbortError 등)나 더 새 버전(VersionError: 더 새 앱 탭이 올려 둠)이면 지금 있는 그대로 연다(사진을 잃지 않게)
          console.warn('사진·서류 저장소 업그레이드 실패, 지금 있는 그대로 열어요', err);
          openAsIs().then(resolve, function () { reject(err); });
        };
        req.onblocked = function () {
          // 예전 버전 탭이 v1 연결을 닫지 않고 있다. 요청은 살려 두고(그 탭이 닫히면 success), 지금 기다리는 쪽에는 바로 알린다
          if (settled) return;
          settled = true;
          waitingReq = req;
          setBlocked(true);
          reject(blockedError());
        };
      });
      dbPromise = p;
      p.catch(function () { if (dbPromise === p) dbPromise = null; });
      return p;
    }

    /** 트랜잭션 하나를 열어 fn(store, setResult) 을 실행하고, 완료되면 결과를 돌려준다. 저장소가 없으면 NotFoundError */
    function runOnce(storeName, mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx;
          var store;
          try {
            if (!db.objectStoreNames.contains(storeName)) {
              var nf = new Error('저장소가 없어요: ' + storeName);
              nf.name = 'NotFoundError';
              throw nf;
            }
            tx = db.transaction(storeName, mode);
            store = tx.objectStore(storeName);
          } catch (e) { reject(e); return; }
          var result;
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error('저장이 취소됐어요')); };
          try { fn(store, function (v) { result = v; }); } catch (e) { try { tx.abort(); } catch (_) { /* 무시 */ } reject(e); }
        });
      });
    }

    /** 연결이 끊겨 실패하면 연결을 새로 열어 한 번 더 시도한다 */
    function run(storeName, mode, fn) {
      return runOnce(storeName, mode, fn).catch(function (err) {
        if (!isConnectionError(err)) throw err;
        forget();
        return runOnce(storeName, mode, fn);
      });
    }

    return {
      open: open,
      run: run,
      /** 저장소를 쓸 수 있는지. 다른 탭 때문에 업그레이드를 기다리는 중이면 true(곧 풀림, 안내 띠가 알림) */
      probe: function () {
        return open().then(function () { return true; }, function (err) { return !!err && err.name === 'BlockedError'; });
      },
      /** 서류 저장소('docs')가 있는지(업그레이드 실패면 false). 열지 못하면(막힘 등) 그 오류로 거절 */
      hasDocs: function () {
        return open().then(function (db) { return db.objectStoreNames.contains(DOC_STORE); });
      },
      isBlocked: function () { return blocked; },
      /** 막힘 상태가 바뀔 때 fn(true|false) */
      onBlockedChange: function (fn) { listeners.push(fn); }
    };
  })();

  /** 1.6.0: 다른 탭 때문에 저장소를 기다리는 중인 오류(조용히 넘기고 안내 띠로만 알림) */
  function dbBlockedErr(err) { return !!err && err.name === 'BlockedError'; }

  var Photos = (function () {
    function run(mode, fn) { return IDB.run(PHOTO_STORE, mode, fn); }

    function onResult(req, set) { req.onsuccess = function () { set(req.result); }; }

    // 오래된 Safari 처럼 Blob 저장이 안 되면 ArrayBuffer 로 저장한 레코드를 다시 Blob 으로
    function fromStored(rec) {
      if (rec && !rec.blob && rec.data) rec.blob = new Blob([rec.data], { type: rec.type || 'image/jpeg' });
      return rec;
    }

    return {
      /** 사진 저장소를 쓸 수 있는지 (파일로 열었거나 IndexedDB 가 막혀 있으면 false. 1.6.0: 다른 탭을 기다리는 중이면 true) */
      probe: function () { return IDB.probe(); },
      put: function (rec) {
        return run('readwrite', function (st) { st.put(rec); }).catch(function (err) {
          if (!rec.blob || dbBlockedErr(err)) throw err;
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
      /**
       * 1.5.1: 매물별 사진 수 { 매물id: n }. 홈 목록 필터 "사진 있음" 칩용.
       * propertyId 색인의 키 커서만 돌려 Blob 은 읽지 않는다(Photos.all 은 사진이 많으면 느림, 16.1 #57)
       */
      countByProperty: function () {
        return run('readonly', function (st, set) {
          var out = {};
          var req = st.index('propertyId').openKeyCursor();
          req.onsuccess = function () {
            var c = req.result;
            if (c) { out[c.key] = (out[c.key] || 0) + 1; c.continue(); }
          };
          set(out); // 트랜잭션이 끝난 뒤 돌려주므로 그때는 다 세어져 있다
        });
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

  /**
   * 1.6.0: 서류함(매물별 첨부 서류: 등기부 PDF, 건축물대장·계약서 사진 등). object store 'docs'.
   * 레코드 { id, propertyId, kind, name, mime, size, addedAt, blob }. 서류 목록은 매물 JSON 이 아니라 여기서 읽는다.
   * 저장소가 없으면(업그레이드 실패) 읽기(list·all·count)는 빈 값, 쓰기(put)는 NotFoundError
   */
  var Docs = (function () {
    function run(mode, fn) { return IDB.run(DOC_STORE, mode, fn); }
    function onResult(req, set) { req.onsuccess = function () { set(req.result); }; }
    function missing(err) { return !!err && err.name === 'NotFoundError'; }
    /** 서류 저장소가 없을 때(업그레이드 실패) 읽기는 빈 값으로 */
    function soft(p, empty) { return p.catch(function (err) { if (missing(err)) return empty; throw err; }); }
    // Blob 저장이 안 되는 Safari 에서는 ArrayBuffer 로 저장한 레코드를 다시 Blob 으로
    function fromStored(rec) {
      if (rec && !rec.blob && rec.data) rec.blob = new Blob([rec.data], { type: rec.mime || 'application/octet-stream' });
      return rec;
    }
    function byAdded(list) {
      return (list || []).map(fromStored).sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
    }
    return {
      put: function (rec) {
        return run('readwrite', function (st) { st.put(rec); }).catch(function (err) {
          if (!rec.blob || dbBlockedErr(err) || missing(err)) throw err;
          console.warn('서류 Blob 저장 실패, 다른 방식으로 다시 시도', err);
          return blobToArrayBuffer(rec.blob).then(function (buf) {
            var alt = Object.assign({}, rec, { blob: null, data: buf });
            return run('readwrite', function (st) { st.put(alt); });
          });
        });
      },
      get: function (id) {
        return soft(run('readonly', function (st, set) { onResult(st.get(id), set); }), null).then(function (r) { return r ? fromStored(r) : null; });
      },
      /** 매물의 서류(올린 순서) */
      list: function (pid) {
        return soft(run('readonly', function (st, set) { onResult(st.index('propertyId').getAll(pid), set); }), []).then(byAdded);
      },
      all: function () {
        return soft(run('readonly', function (st, set) { onResult(st.getAll(), set); }), []).then(byAdded);
      },
      count: function () {
        return soft(run('readonly', function (st, set) { onResult(st.count(), set); }), 0);
      },
      remove: function (id) {
        return run('readwrite', function (st) { st.delete(id); });
      },
      removeByProperty: function (pid) {
        return soft(run('readwrite', function (st) {
          var req = st.index('propertyId').openCursor(pid);
          req.onsuccess = function () {
            var c = req.result;
            if (c) { c.delete(); c.continue(); }
          };
        }), undefined);
      },
      clear: function () {
        return soft(run('readwrite', function (st) { st.clear(); }), undefined);
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

  // 라벨 6개("멈춤 신호 n건" / "아직 안 봄" / "멈춤 신호 n개 미확인" / "주의 n건 · 멈춤 신호 없음" / "멈춤 신호 없음 · 확인 중 n/m" /
  // "체크 항목 이상 없음")를 바꾸면 data.js 용어 "등기부 결과" 설명도 같이 고친다(사용자가 홈 카드의 라벨로 용어를 검색함)
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
    // 1.4.5: 핵심 과업(등기부 멈춤 신호에 모두 답하기)의 결과를 보여 준다. 전에는 모두 "없음"이어도 "확인 중 7/17"로만 보였음(1.5.0 데이터는 8/18)
    var gate = gateStopState(prop);
    if (gate.unanswered > 0) return { code: 'unanswered', label: '멈춤 신호 ' + gate.unanswered + '개 미확인' };
    // 여기부터는 멈춤 신호를 모두 "없음"으로 답한 상태
    if (cautions) return { code: 'caution', label: '주의 ' + cautions + '건 · 멈춤 신호 없음' };
    if (prog.done < prog.total) return { code: 'clear', label: '멈춤 신호 없음 · 확인 중 ' + prog.done + '/' + prog.total };
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
  /** 지금 이 매물의 멈춤 안내가 늦은 단계 문구인지. 상단 경고(renderAlerts)·홈 카드 칩과 같은 기준 */
  function lateNow(prop) { return stopIsLate(prop, flagsYes(prop, 'stop')); }

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

  /**
   * 1.4.5: data.js 바로가기를 새 창으로 여는 작은 링크. word 가 이름에 든 바로가기가 없으면 null(버튼 자체를 숨김).
   * cls 를 주면 그 클래스(예: 버튼 모양)로, 없으면 .ext-link
   */
  function extLink(word, text, cls) {
    var l = linkByLabel(word);
    if (!l) return null;
    return h('a', { class: cls || 'ext-link', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
      text, icon('external', 'ic-sm'), h('span', { class: 'sr-only', text: '(새 창)' }));
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
  var toastSeq = 0; // 토스트를 띄울 때마다 늘어나는 번호. 내가 띄운 토스트(되돌리기 등)가 아직 떠 있는지 알 때 쓴다
  var toastEnd = 0;     // 1.4.1: 지금 토스트가 저절로 사라질 시각(0: 직접 닫을 때까지)
  var toastHeldLeft = -1; // 1.4.1: 멈춰 둔 토스트의 남은 시간(ms). -1 이면 멈추지 않음
  /** opts: { action: { label, fn }, duration(ms, 0 이면 직접 닫을 때까지) }. 결과: 이 토스트의 번호(toastSeq) */
  function toast(msg, opts) {
    opts = opts || {};
    var el = $('#toast');
    if (!el) return 0;
    toastSeq++;
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
    toastHeldLeft = -1;
    toastEnd = 0;
    if (opts.duration !== 0) startToastTimer(opts.duration || 2800);
    return toastSeq;
  }
  function startToastTimer(ms) {
    clearTimeout(toastTimer);
    toastEnd = Date.now() + ms;
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    toastHeldLeft = -1;
    toastEnd = 0;
    var el = $('#toast');
    if (el) el.classList.remove('show', 'has-action');
  }
  /** 지금 떠 있는 토스트의 번호(없으면 0) */
  function shownToast() {
    var el = $('#toast');
    return el && el.classList.contains('show') ? toastSeq : 0;
  }
  /**
   * 1.4.1: 버튼이 있는 토스트([되돌리기] 등)에 초점이나 손가락(포인터)이 있으면 저절로 사라지지 않게 멈추고,
   * 떠나면 남은 시간(적어도 TOAST_RESUME_MS)만큼 더 보여 준다. VoiceOver·키보드로 버튼까지 가는 사이에 사라지지 않게
   */
  function holdToast(on) {
    var el = $('#toast');
    if (!el || !el.classList.contains('show') || !el.classList.contains('has-action')) return;
    if (on) {
      if (toastHeldLeft >= 0 || !toastEnd) return; // 이미 멈춤, 또는 직접 닫는 토스트
      toastHeldLeft = Math.max(0, toastEnd - Date.now());
      clearTimeout(toastTimer);
      toastTimer = null;
    } else if (toastHeldLeft >= 0) {
      var left = toastHeldLeft;
      toastHeldLeft = -1;
      startToastTimer(Math.max(left, TOAST_RESUME_MS));
    }
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
   * opts: { title, message, content(Node), className(1.6.0 검토 반영: .modal 에 더할 클래스), input: { placeholder, value, label, match, multiline },
   *         initialFocus(1.7.0: 처음 초점을 줄 요소, content 안),
   *         buttons: [{ label, value, kind: 'primary'|'danger'|'danger-ghost'|'secondary'|'accent', needsMatch, action, keepOpen,
   *                     validate(1.7.0: 누를 때 false 를 돌려주면 닫지 않음) }] }
   *   'danger-ghost' 은 위험하지만 주 버튼이 아닌 동작(테두리만 빨강). 첫 초점은 'danger' 일 때만 취소로 간다
   * 1.4.1: 연 뒤 DIALOG_GUARD_MS(0.4초) 동안은 버튼·바탕 누름을 무시한다. 폭이 좁으면 하단 시트의 [지우기]가 방금 누른
   *   [N개 삭제]와 같은 자리에 떠서, 두 번 빠르게 누르면 이름 목록을 보기도 전에 지워졌다
   */
  function openDialog(opts) {
    return new Promise(function (resolve) {
      var root = $('#overlay-root');
      var prevFocus = document.activeElement;
      var openedAt = Date.now();
      function tooSoon() { return Date.now() - openedAt < DIALOG_GUARD_MS; }
      var titleId = 'dlg-' + uid();
      var msgId = titleId + '-msg';
      var inputEl = null;
      var actions = h('div', { class: 'modal-actions' });
      // 설명: 메시지와 내용(content) 모두. 내용만 있는 대화상자(합치기 결과 등)도 VoiceOver 가 열 때 읽게
      if (opts.content && !opts.content.id) opts.content.id = titleId + '-body';
      var describedBy = [opts.message ? msgId : '', opts.content ? opts.content.id : ''].filter(Boolean).join(' ');
      var card = h('div', { class: 'modal' + (opts.className ? ' ' + opts.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': describedBy || null },
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
          if (tooSoon()) return; // 대화상자를 연 누름이 한 번 더 들어온 것
          if (b.validate && !b.validate()) return; // 1.7.0 검토 반영: 칸 검사가 틀리면 닫지 않는다(오류는 validate 가 칸 아래에 보임)
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
      overlay.addEventListener('click', function (e) { if (e.target === overlay && !tooSoon()) cancel(); });
      document.addEventListener('keydown', onKey, true);
      openDialogs.push(cancel);
      root.append(overlay);
      // 지우기 같은 위험한 대화상자는 실수로 Enter 를 눌러도 안전하도록 '취소'에 먼저 초점
      var hasDanger = (opts.buttons || []).some(function (b) { return b.kind === 'danger'; });
      setTimeout(function () {
        var target = (opts.initialFocus && document.contains(opts.initialFocus) ? opts.initialFocus : null) || inputEl ||
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
            notePhotoChange(rec.propertyId, -1);
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
    if (homeSearchFlush) { var flush = homeSearchFlush; homeSearchFlush = null; flush(); } // 1.5.1 검토 반영: 홈 검색 디바운스 중이면 친 검색어부터 기억
    view = { name: name, prop: prop || null, refs: { secs: {}, chips: {}, hints: [], stopWords: [], strips: {} }, photos: null, photosReady: null };
    return view;
  }

  function resetMain() {
    var m = $('#main');
    m.textContent = '';
    return m;
  }

  /**
   * 상단 바 제목 아래 앱 버전(1.3.2). 새 버전을 받아 두었으면 누르면 바로 적용되는 [업데이트] 버튼으로 바뀐다.
   * 1.3.2는 배포 폴더에서 먼저 나갔고, 1.4.0에서 이 폴더로 옮겼다
   */
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
    appendKid(left, o.left); // 뒤로 가기 대신 둘 버튼(홈 선택 모드의 [전체 선택])
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
        h('p', { class: 'flow-step-desc', text: s.desc }),
        // 1.5.0(L1): 등기부 단계에 인터넷등기소 바로가기(data.js links 에 없으면 생략)
        s.key ? extLink('등기소', '인터넷등기소 열기', 'ext-link flow-link') : null
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

  /**
   * 홈 화면 추가 안내. 1.5.0(L6): 한 줄 배너("홈 화면에 추가하면 더 안전해요 [방법] ✕")로 줄였다(1.4.x 까지는 3단계 카드가
   * 첫 화면의 1/3을 차지해 매물 목록을 밀었음). 자세한 글(기록이 있으면 "먼저 백업" 안내 포함)은 [방법] 대화상자(showInstallHow).
   * ✕ 로 닫으면 ui.dismissedInstallTip 에 기억하고 설정의 [안내 다시 보기]로 되돌린다
   */
  function installTip() {
    if (!isIOS() || isStandalone() || inAppBrowser() || state.ui.dismissedInstallTip) return null;
    var bar = h('div', { class: 'install-bar', role: 'note' },
      h('p', { class: 'install-bar-text', text: '홈 화면에 추가하면 더 안전해요' }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary install-bar-how', 'aria-label': '방법: 홈 화면에 추가하는 법 보기', onclick: showInstallHow }, '방법'),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': '홈 화면 추가 안내 닫기',
        onclick: function () {
          state.ui.dismissedInstallTip = true;
          saveNow();
          bar.remove();
        }
      }, icon('close'))
    );
    return bar;
  }

  /**
   * 1.5.0 검토 반영: 데이터 2026-10c 로 옮긴 내용을 홈 맨 위에서 한 번 알린다(loadState 가 옛 저장본을 읽으며 ui.dataNotice 에 남김).
   * 1.4.x 매물의 "압류·가압류·가처분 없음"을 가처분 "없음"으로, 집 안 두 항목의 "양호"를 체크로 옮겼고 "주의"는 메모만 남는다는 것.
   * [확인]으로 닫으면 ui.dataNotice 를 지우고 저장한다(전에는 README 에만 적혀 있어 앱 안에서는 "멈춤 신호 1개 미확인"으로 되돌아간 듯 보였음)
   */
  function dataNoticeBar() {
    var n = state.ui.dataNotice;
    if (!n) return null;
    var lines = [];
    if (n.inj) lines.push('등기부에 "가처분" 항목이 새로 생겼어요. 전에 "압류·가압류·가처분"을 "없음"으로 답한 매물 ' + n.inj + '개는 가처분도 "없음"으로 옮겨 두었어요.');
    if (n.unitMoved || n.unitLost) {
      lines.push('집 안의 "가구 자리 줄자 측정"·"베란다 확장"은 양호/주의에서 체크로 바뀌었어요.' +
        (n.unitMoved ? ' "양호" ' + n.unitMoved + '개는 체크해 두었어요.' : '') +
        (n.unitLost ? ' "주의" ' + n.unitLost + '개는 메모만 남았으니 다시 봐 주세요.' : ''));
    }
    var bar = h('div', { class: 'notice notice-info data-notice', role: 'note' },
      h('strong', { text: '체크리스트가 바뀌었어요 (1.5.0)' }),
      lines.map(function (t) { return h('p', { text: t }); }),
      h('button', {
        type: 'button', class: 'btn btn-small btn-secondary',
        onclick: function () { state.ui.dataNotice = null; saveNow(); bar.remove(); }
      }, '확인'));
    return bar;
  }

  /** [방법] 대화상자: 홈 화면에 추가하는 법 + 기록이 있을 때 "추가하기 전에 먼저 백업"(저장 공간이 따로라서) + [지금 백업하기] */
  function showInstallHow() {
    var hasData = state.properties.length > 0;
    var buttons = [];
    if (hasData) buttons.push({ label: '지금 백업하기', value: 'backup', kind: 'accent' });
    buttons.push({ label: '닫기', value: null, kind: hasData ? 'secondary' : undefined });
    openDialog({
      title: '홈 화면에 추가해서 쓰세요',
      content: h('div', { class: 'install-how' },
        h('p', { text: INSTALL_TIP }),
        hasData ? h('p', { class: 'tip-move', text: INSTALL_TIP_MOVE }) : null),
      buttons: buttons
    }).then(function (r) { if (r.value === 'backup') navigate('/settings'); });
  }

  // ---------------- 홈: 매물 목록 ----------------
  function propertyCardClass(p) {
    var dropped = p.status === 'dropped';
    return 'pcard' + (dropped ? ' is-dropped' : '') + (!dropped && flagsYes(p, 'stop').length ? ' has-stop' : '');
  }

  /**
   * 1.5.0: 홈 카드의 "호수 입력 필요" 칩. 누르면 수정 폼의 호수(동이 비었으면 동) 칸으로 바로 간다(M8).
   * 카드 전체가 링크라 칩은 그 안의 작은 링크(클릭은 카드로 번지지 않게). 선택 모드(plain)에서는 글자만
   */
  function needHoChip(p, plain) {
    var label = p.dong ? '호수 입력 필요' : '동·호수 입력 필요';
    if (plain) return h('span', { class: 'meta-chip need-ho', text: label });
    return h('a', {
      class: 'meta-chip need-ho need-ho-link', href: '#/p/' + encodeURIComponent(p.id) + '/edit',
      'aria-label': label + ' · 입력하러 가기',
      onclick: function (e) {
        e.preventDefault();
        e.stopPropagation();
        pendingFocus = p.dong ? 'ho' : 'dong';
        navigateNow('/p/' + p.id + '/edit'); // 클릭 안에서 그려야 iOS 가 키보드를 띄움
      }
    }, label, h('span', { class: 'need-ho-arrow', 'aria-hidden': 'true', text: '›' }));
  }

  /** 매물 카드 내용(이름·상태·가격·진행·칩). idBase 가 있으면 이름·단위·상태에 id 를 붙인다(선택 모드 체크박스의 이름) */
  function propertyCardParts(p, idBase) {
    var prog = overallProgress(p);
    var cautions = cautionCount(p);
    var reg = registryResult(p);
    var dropped = p.status === 'dropped';
    var stopList = flagsYes(p, 'stop');
    var stops = stopList.length;
    var diff = diffPercent(p.askPrice, p.realPrice);
    var unit = unitText(p);
    var chip = statusChip(p.status);
    if (idBase) chip.id = idBase + '-st';
    return [
      h('div', { class: 'pcard-top' },
        h('div', {},
          h('strong', { class: 'pcard-name', id: idBase ? idBase + '-name' : null, text: p.name }),
          (unit || p.area) ? h('span', { class: 'pcard-unit', id: idBase ? idBase + '-unit' : null, text: [unit, p.area ? '전용 ' + p.area + '㎡' : ''].filter(Boolean).join(' · ') }) : null
        ),
        chip
      ),
      h('p', { class: 'pcard-price', id: idBase ? idBase + '-price' : null },
        p.askPrice ? '호가 ' + formatManwon(p.askPrice) : '호가 입력 안 함',
        diff !== null ? h('span', { class: 'pcard-diff', text: ' · 실거래 대비 ' + pctText(diff) }) : null,
        // 1.7.0: KB시세 작은 칩(없으면 생략). 칩 앞의 공백은 화면 읽기에서 숫자가 붙어 읽히지 않게
        p.kbPrice ? ' ' : null,
        p.kbPrice ? h('span', { class: 'kb-chip', title: 'KB시세' + (p.kbAt ? ' (' + formatISODate(p.kbAt) + ')' : ''), text: 'KB ' + kbShort(p.kbPrice) }) : null
      ),
      makeBar(prog.pct, '진행 ' + prog.pct + '%', { ariaLabel: '체크리스트 진행률' }).el,
      h('div', { class: 'pcard-meta' },
        // 동·호수가 없으면 등기부를 열람할 수 없다(가져온 매물은 동만 있고 호수가 비어 있음 → "호수 입력 필요")
        (!p.dong || !p.ho) && !dropped ? needHoChip(p, !!idBase) : null,
        h('span', { class: 'meta-chip reg-' + reg.code, text: '등기부: ' + reg.label }),
        // 1.4.5: 아무것도 안 본 매물에는 "주의 0개"를 붙이지 않는다("문제 없음"처럼 읽히지 않게)
        cautions ? h('span', { class: 'meta-chip warn', text: '주의 ' + cautions + '개' }) : (prog.done ? h('span', { class: 'meta-chip', text: '주의 0개' }) : null),
        stops && !dropped ? h('span', { class: 'meta-chip reg-stop', text: stopIsLate(p, stopList) ? '진행 멈춤' : '임장 불필요' }) : null
      ),
      dropped ? h('p', { class: 'pcard-drop', text: '탈락' + (p.dropReason ? ' · ' + p.dropReason : '') }) : null
    ];
  }

  function propertyCard(p) {
    return h('a', { class: propertyCardClass(p), href: '#/p/' + encodeURIComponent(p.id) }, propertyCardParts(p));
  }

  // 홈 선택 모드(여러 매물 지우기): { on, ids: { 매물id: true } }.
  // 다른 탭 동기화로 다시 그려도(tryRefreshView) 유지하고, 다른 화면으로 가거나 지운 뒤에는(onRoute) 끈다
  var homeSel = { on: false, ids: {} };

  /** 선택 모드를 켜거나([선택]) 끄고([취소]) 홈을 다시 그린다. 켜면 제목("매물 선택")으로, 끄면 [선택] 버튼으로 초점 */
  function setHomeSelect(on) {
    homeSel = { on: !!on, ids: {} };
    var y = window.scrollY;
    renderHome();
    window.scrollTo(0, y);
    var target = on ? document.getElementById('tb-title') : document.querySelector('[data-focus-key="sel-start"]');
    if (target) { try { target.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }
  }

  /**
   * 선택 모드의 매물 카드: 실제 체크박스 + 카드 내용. 카드 아무 곳을 눌러도 체크가 바뀐다(상세로 가지 않음).
   * 결과: { el, set(on) }. onPick: 사용자가 체크를 바꿨을 때
   */
  function selectCard(p, onPick) {
    var base = 'sel-' + domId(p.id);
    var cb = h('input', {
      type: 'checkbox', class: 'sel-check', id: base, checked: !!homeSel.ids[p.id], 'data-focus-key': 'sel:' + p.id,
      // 단지명 + 동·호·면적 + 가격 + 상태로 읽는다(같은 단지 매물이 여러 개여도 구분되게. 1.4.1 가격 줄 추가)
      'aria-labelledby': [base + '-name', (unitText(p) || p.area) ? base + '-unit' : '', base + '-price', base + '-st'].filter(Boolean).join(' ')
    });
    var card = h('div', { class: propertyCardClass(p) + ' pcard-sel' + (cb.checked ? ' is-picked' : '') },
      cb, h('div', { class: 'pcard-body' }, propertyCardParts(p, base)));
    function set(on) {
      cb.checked = on;
      if (on) homeSel.ids[p.id] = true; else delete homeSel.ids[p.id];
      card.classList.toggle('is-picked', on);
    }
    cb.addEventListener('change', function () { set(cb.checked); onPick(); });
    card.addEventListener('click', function (e) {
      if (e.target === cb) return; // 체크박스를 직접 누르면 change 가 처리한다
      set(!cb.checked);
      onPick();
    });
    return { el: card, set: set };
  }

  // ---------------- 홈: 목록 필터·검색·정렬 (1.5.1, 보고서 L14) ----------------
  // 상태는 sessionStorage 에 둔다(상세에 다녀와도 유지, 탭을 닫으면 초기화. 백업·합치기에 섞이지 않게 localStorage 는 쓰지 않음)
  var HOME_FILTER_KEY = 'imjang.home.filter';
  var HOME_SEARCH_DEBOUNCE_MS = 150;
  var homePhotoCounts = null; // 매물별 사진 수(Photos.countByProperty). 홈을 그릴 때마다 다시 읽고, 읽기 전에는 null. 이 탭에서 사진을 넣고 지우면 notePhotoChange 가 맞춘다
  // 1.5.1 검토 반영: 이 탭에서 방금 추가·가져오기·고친 매물 id(touch·새 매물 저장·가져오기가 적음). 다음 홈 그리기가 가져가서,
  // 필터 조건 밖이어도 그 홈 화면에서 한 번 따로 보인다("방금 추가·고친 매물"). 필터를 바꾸거나 다른 화면에 다녀오면 숨는다
  var homeReveal = {};
  var homeSearchFlush = null; // 검색 디바운스가 남아 있으면 그 검색어를 바로 기억하는 함수(newView 가 부름: 화면이 바뀌어도 친 검색어가 어긋나지 않게)
  // 1.5.1 검토 반영: 사진은 저장본(imjang.v1)에 없어서 다른 탭이 사진을 넣고 지운 것을 몰랐다 → 이 작은 키를 바꿔 storage 이벤트로 알린다
  var PHOTO_REV_KEY = 'imjang.photos.rev';
  /**
   * 이 탭에서 사진을 넣거나(+1) 지웠을 때(-1): 홈의 사진 수 기억(homePhotoCounts)도 맞추고(홈 첫 그리기가 지난 수로 그려졌다
   * 바뀌며 지운 매물이 잠깐 보이던 것) 다른 탭에 알린다
   */
  function notePhotoChange(pid, delta) {
    if (homePhotoCounts && pid) {
      var n = (homePhotoCounts[pid] || 0) + delta;
      if (n > 0) homePhotoCounts[pid] = n; else delete homePhotoCounts[pid];
    }
    localSet(PHOTO_REV_KEY, Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  }
  // 칩 묶음. 상태·등기부는 값이 하나뿐인 결과라 묶음 안 OR, "더 좁히기"(all: true)는 서로 다른 조건이라 묶음 안도 AND(켤수록 좁아짐). 묶음끼리는 AND.
  // test(f) 의 f 는 homeFacts(매물) — 매물마다 한 번만 계산해 개수 세기와 거르기에 같이 쓴다
  var HOME_CHIP_GROUPS = [
    { id: 'status', label: '상태', chips: STATUSES.map(function (s) {
      return { id: s.id, label: s.label, test: function (f) { return f.status === s.id; } };
    }) },
    { id: 'reg', label: '등기부', chips: [ // registryResult 의 code 를 다시 쓴다(6.1). 매물마다 셋 중 정확히 하나(none 제외)
      { id: 'reg-stop', label: '멈춤 신호 있음', test: function (f) { return f.reg === 'stop'; } },
      // 1.5.1 검토 반영: 멈춤 신호를 모두 "없음"으로 답한 상태 전부(카드 "주의 1건 · 멈춤 신호 없음"도 여기에 듦)
      { id: 'reg-clear', label: '멈춤 신호 없음', test: function (f) { return f.reg === 'clear' || f.reg === 'ok' || f.reg === 'caution'; } },
      { id: 'reg-todo', label: '아직 안 봄·미확인', test: function (f) { return f.reg === 'todo' || f.reg === 'unanswered'; } }
    ] },
    { id: 'more', label: '더 좁히기', all: true, chips: [
      // 1.5.1 검토 반영: 등기부 주의 신호를 "있음"으로 답한 매물(멈춤 신호·미답과 관계없이). 전에는 registryResult code 'caution' 만
      { id: 'reg-caution', label: '등기부 주의 있음', test: function (f) { return f.regCautions > 0; } },
      { id: 'has-caution', label: '주의 1개 이상', test: function (f) { return f.cautions > 0; } }, // 카드 "주의 N개"와 같은 셈(cautionCount)
      { id: 'need-ho', label: '호수 입력 필요', test: function (f) { return f.needHo; } },
      { id: 'has-photo', label: '사진 있음', test: function (f) { return f.photos > 0; } }
    ] }
  ];
  var HOME_CHIP_KNOWN = {};
  HOME_CHIP_GROUPS.forEach(function (g) { g.chips.forEach(function (c) { HOME_CHIP_KNOWN[c.id] = true; }); });

  /** 검색 비교용 글자: 소문자 + 공백 제거(대소문자·공백 무시 부분 일치) */
  function searchKey(s) { return str(s).toLowerCase().replace(/\s+/g, ''); }
  /** 검색 대상: 단지명·동·호(unitText 모양 "204동 1604호" 포함)·중개사 이름·메모. 가져오기 참고(importNotes)는 뺀다 */
  function homeSearchText(p) { return searchKey([p.name, unitText(p), p.dong, p.ho, p.agentName, p.memo].join(' ')); }
  /** 등기부(게이트) 섹션의 주의 신호(멈춤이 아닌 flag)를 "있음"으로 답한 수. registryResult 와 같은 셈이지만 멈춤 신호·미답과 관계없이 센다 */
  function regCautionCount(p) {
    var n = 0;
    gateSections().forEach(function (s) {
      s.items.forEach(function (it) { if (it.type === 'flag' && it.severity !== 'stop' && getItemState(p, it.id).status === 'yes') n++; });
    });
    return n;
  }
  /** 칩 판정·검색에 쓰는 매물 요약. photos 는 { 매물id: 사진 수 } 또는 null(아직 못 읽음) */
  function homeFacts(p, photos) {
    return {
      status: p.status,
      reg: registryResult(p).code,
      regCautions: regCautionCount(p),
      cautions: cautionCount(p),
      needHo: !p.dong || !p.ho,
      photos: photos ? (photos[p.id] || 0) : 0,
      text: homeSearchText(p)
    };
  }

  // 1.5.1 검토 반영: 한글을 치는 중간(자음만 "ㄹ", 다음 글자의 첫소리가 받침으로 붙은 "램", 받침 전 "래미아")에는 정확히 맞는 매물이 없어
  // 칠 때마다 빈 상태가 깜빡였다. 정확히 맞는 매물이 하나도 없을 때만 마지막 글자를 "치는 중"으로 보고 넓게 맞춘다(homeQueryMatcher)
  var HANGUL_CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'; // 첫소리 19개(유니코드 음절 순서). 자음 낱자 → 첫소리 번호
  // 받침 번호(1~27) → [남는 받침 번호, 다음 글자 첫소리 번호]. "램"(ㅁ) → "래" + ㅁ…, "닭"(ㄺ) → "달" + ㄱ…
  var HANGUL_JONG_SPLIT = [null, [0, 0], [0, 1], [1, 9], [0, 2], [4, 12], [4, 18], [0, 3], [0, 5], [8, 0], [8, 6], [8, 7], [8, 9], [8, 16], [8, 17], [8, 18],
    [0, 6], [0, 7], [17, 9], [0, 9], [0, 10], [0, 11], [0, 12], [0, 14], [0, 15], [0, 16], [0, 17], [0, 18]];
  /** 한글 음절이면 { cho, base(받침 뺀 음절), jong } (아니면 null) */
  function hangulParts(ch) {
    var c = ch.charCodeAt(0) - 0xAC00;
    if (c < 0 || c > 11171) return null;
    var jong = c % 28;
    return { cho: Math.floor(c / 588), base: c - jong, jong: jong };
  }
  /** 마지막 글자를 치는 중으로 볼 때, text 의 j 번째 글자부터가 그 글자로 이어질 수 있는지 판단하는 함수(넓게 맞출 수 없는 글자면 null) */
  function hangulTailTest(last) {
    var cho = HANGUL_CHO.indexOf(last);
    if (cho >= 0) { // 자음 낱자: 그 첫소리로 시작하는 음절
      return function (text, j) { var x = j < text.length ? hangulParts(text.charAt(j)) : null; return !!x && x.cho === cho; };
    }
    var l = hangulParts(last);
    if (!l) return null;
    if (!l.jong) { // 받침 전("아"): 같은 첫소리·가운뎃소리에 받침이 붙은 음절("안")까지
      return function (text, j) { var x = j < text.length ? hangulParts(text.charAt(j)) : null; return !!x && x.base === l.base; };
    }
    var sp = HANGUL_JONG_SPLIT[l.jong]; // 받침이 다음 글자의 첫소리일 수 있음("램" → "래미")
    return function (text, j) {
      if (j + 1 >= text.length || text.charCodeAt(j) - 0xAC00 !== l.base + sp[0]) return false;
      var y = hangulParts(text.charAt(j + 1));
      return !!y && y.cho === sp[1];
    };
  }
  /**
   * 검색어 q(searchKey 한 값) → 맞는지 보는 함수 text → bool (q 가 비면 null). 매물 하나라도 q 를 그대로 품으면 그대로 부분 일치,
   * 아무것도 없으면 마지막 글자만 치는 중으로 보고 넓게(hangulTailTest). 넓게 봐도 없으면 0개(빈 상태)
   */
  function homeQueryMatcher(q, texts) {
    if (!q) return null;
    function exact(t) { return t.indexOf(q) >= 0; }
    if (texts.some(exact)) return exact;
    var tail = hangulTailTest(q.charAt(q.length - 1));
    if (!tail) return exact;
    var head = q.slice(0, -1);
    return function (t) {
      for (var i = t.indexOf(head); i >= 0 && i + head.length < t.length; i = t.indexOf(head, i + 1)) { // 뒤에 한 글자 이상 남아야 함(head 가 '' 여도 끝남)
        if (tail(t, i + head.length)) return true;
      }
      return false;
    };
  }

  /** sessionStorage 의 필터 상태 → { q, chips: { 칩id: true }, sort }. 모르는 칩·정렬 id 는 버린다 */
  function readHomeFilter() {
    var out = { q: '', chips: {}, sort: 'updated' };
    var o = null;
    try { o = JSON.parse(sessionGet(HOME_FILTER_KEY) || 'null'); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return out;
    out.q = str(o.q).trim().slice(0, 100);
    if (Array.isArray(o.chips)) o.chips.forEach(function (id) { if (HOME_CHIP_KNOWN[id]) out.chips[id] = true; });
    if (HOME_SORTS.some(function (s) { return s.id === o.sort; })) out.sort = o.sort;
    return out;
  }
  function writeHomeFilter(f) {
    var on = Object.keys(f.chips);
    if (!f.q && !on.length && f.sort === 'updated') { sessionRemove(HOME_FILTER_KEY); return; } // 기본값이면 키를 두지 않는다
    sessionSet(HOME_FILTER_KEY, JSON.stringify({ q: f.q, chips: on, sort: f.sort }));
  }
  /** 검색어나 켜진 칩이 하나라도 있는지(정렬은 매물을 숨기지 않으므로 세지 않음) */
  function homeFilterActive(f) { return !!(f.q || Object.keys(f.chips).length); }
  /** 켜진 칩 이름(묶음·칩 순서) */
  function homeChipNames(f) {
    var names = [];
    HOME_CHIP_GROUPS.forEach(function (g) { g.chips.forEach(function (c) { if (f.chips[c.id]) names.push(c.label); }); });
    return names;
  }
  /** 켜진 조건 한 줄: 검색 “래미안” · 임장 예정, 멈춤 신호 있음 (아무것도 없으면 '') */
  function homeFilterSummary(f) {
    var parts = [];
    if (f.q) parts.push('검색 “' + f.q + '”');
    var names = homeChipNames(f);
    if (names.length) parts.push(names.join(', '));
    return parts.join(' · ');
  }

  /**
   * 필터·검색·정렬을 적용한 목록. props 는 '최근에 고친 순'으로 정렬돼 있어야 한다(같은 값끼리는 그 순서가 남음).
   * 결과 { list, dropped, revealed }:
   *  - list: 위 "내 매물" 목록. 상태 칩이 켜져 있으면 그중 하나인 매물, 없으면 탈락 제외(검색어가 있으면 탈락도 포함).
   *    상태·등기부 묶음은 켜진 칩 중 하나라도(OR), "더 좁히기"는 켜진 칩 모두(AND), 묶음끼리는 모두(AND) 맞아야 한다
   *  - dropped: 아래 "탈락한 매물" 묶음. 검색어도 상태 칩도 없을 때만. 1.5.1 검토 반영: 등기부·더 좁히기 칩이 켜져 있으면 같은 조건에 맞는
   *    탈락 매물만(전에는 필터와 관계없이 모두 보여 결과 줄·칩 개수·[전체 선택]과 어긋났음), 정렬도 위 목록과 같게
   *  - revealed: 필터가 켜져 있을 때 reveal(방금 추가·고친 매물)인데 위 둘에 안 든 매물 — 이번 홈에서만 따로 보인다
   */
  function applyHomeFilter(props, f, facts, reveal) {
    var on = f.chips;
    var match = homeQueryMatcher(searchKey(f.q), props.map(function (p) { return facts[p.id].text; }));
    var statusOn = STATUSES.filter(function (s) { return on[s.id]; }).map(function (s) { return s.id; });
    var groups = HOME_CHIP_GROUPS.filter(function (g) { return g.id !== 'status'; }).map(function (g) {
      return { all: !!g.all, chips: g.chips.filter(function (c) { return on[c.id]; }) };
    }).filter(function (g) { return g.chips.length; });
    function fits(fc) {
      return groups.every(function (g) {
        function ok(c) { return c.test(fc); }
        return g.all ? g.chips.every(ok) : g.chips.some(ok);
      });
    }
    var cmp = sortCompare(f.sort);
    var list = props.filter(function (p) {
      var fc = facts[p.id];
      if (match && !match(fc.text)) return false;
      if (statusOn.length) { if (statusOn.indexOf(p.status) < 0) return false; }
      else if (p.status === 'dropped' && !match) return false;
      return fits(fc);
    });
    list.sort(cmp);
    var dropped = !match && !statusOn.length ? props.filter(function (p) { return p.status === 'dropped' && fits(facts[p.id]); }).sort(cmp) : [];
    var revealed = [];
    if (reveal && homeFilterActive(f)) {
      var seen = {};
      list.concat(dropped).forEach(function (p) { seen[p.id] = true; });
      revealed = props.filter(function (p) { return reveal[p.id] && !seen[p.id]; }).sort(cmp);
    }
    return { list: list, dropped: dropped, revealed: revealed };
  }

  /**
   * 홈 목록 도구: 검색 칸(디바운스 150ms, [지우기]) + 필터 칩 묶음 3개(가로 스크롤 한 줄, button + aria-pressed, 숨은 쪽 끝 흐림) + 정렬 select +
   * [모두 해제] + 결과 줄(role=status, 켜진 칩 이름까지). hf(readHomeFilter 결과)를 제자리에서 고쳐 sessionStorage 에 적고 opts.onChange(kind) 를
   * 부른다(kind 'filter' = 검색·칩, 'sort' = 정렬. 목록만 다시 그리고 도구는 그대로라 검색 칸·칩의 초점이 남는다).
   * 결과 { el, update(facts, shown, total, revealed), reset(), clearSearch(), placeChips(left), showChip(el) }
   */
  function homeFilterBar(hf, opts) {
    var timer = null;
    var chipEls = {};
    var countEls = {};
    function changed(kind) { writeHomeFilter(hf); syncTools(); opts.onChange(kind || 'filter'); }

    var input = h('input', {
      class: 'input hf-q', id: 'hf-q', type: 'search', placeholder: '단지명·동·호·메모 검색', enterkeyhint: 'search',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 100, value: hf.q, 'data-focus-key': 'hf-q'
    });
    var clearBtn = h('button', {
      type: 'button', class: 'icon-btn hf-clear', 'aria-label': '검색어 지우기', hidden: !hf.q, 'data-focus-key': 'hf-clear',
      onclick: function () { input.value = ''; applySearch(); input.focus(); }
    }, icon('close'));
    function applySearch() {
      clearTimeout(timer);
      timer = null;
      if (homeSearchFlush === flushSearch) homeSearchFlush = null;
      var q = input.value.trim();
      clearBtn.hidden = !q;
      if (q === hf.q) return;
      hf.q = q;
      changed();
    }
    /**
     * 1.5.1 검토 반영: 디바운스 중에 화면이 바뀌면(newView 가 부름) 친 검색어를 그리지 않고 기억만 한다. 전에는 남은 타이머가 지난 홈을
     * 다시 그리며 지금 화면 제목을 "매물 선택"으로 덮거나, 새로 그린 검색 칸(빈 값)과 기억한 검색어가 어긋났음
     */
    function flushSearch() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      var q = input.value.trim();
      if (q !== hf.q) { hf.q = q; writeHomeFilter(hf); }
    }
    input.addEventListener('input', function () {
      clearBtn.hidden = !input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(applySearch, HOME_SEARCH_DEBOUNCE_MS); // 입력 즉시(디바운스) 적용
      homeSearchFlush = flushSearch;
    });
    input.addEventListener('keydown', function (e) { // 자판의 [검색](enterkeyhint): 바로 적용하고 키보드를 내린다
      if (e.key === 'Enter') { e.preventDefault(); applySearch(); input.blur(); }
    });
    input.addEventListener('search', applySearch); // type=search 의 지우기·검색 이벤트(브라우저가 보내면)
    // 1.5.1 검토 반영: 검색 칸을 누르면 상단 바 바로 아래로 올린다(자판이 올라오면 375·320 에서 결과 카드가 거의 보이지 않았음)
    input.addEventListener('focus', function () {
      var tb = document.getElementById('topbar');
      var dy = searchBox.getBoundingClientRect().top - (tb ? tb.getBoundingClientRect().bottom : 0) - 8;
      if (dy > 4) window.scrollBy(0, dy);
    });

    var groups = HOME_CHIP_GROUPS.map(function (g) {
      return h('div', { class: 'hf-group', role: 'group', 'aria-label': g.label },
        h('span', { class: 'hf-gl', 'aria-hidden': 'true', text: g.label }),
        g.chips.map(function (c) {
          var n = h('span', { class: 'hf-n' });
          countEls[c.id] = n;
          // 버튼 자체가 44px(누르는 영역), 보이는 알약(.hf-pill)은 36px
          var b = h('button', {
            type: 'button', class: 'hf-chip', 'aria-pressed': hf.chips[c.id] ? 'true' : 'false', 'data-focus-key': 'hf:' + c.id,
            onclick: function () {
              if (hf.chips[c.id]) delete hf.chips[c.id]; else hf.chips[c.id] = true;
              b.setAttribute('aria-pressed', hf.chips[c.id] ? 'true' : 'false');
              changed();
            }
          }, h('span', { class: 'hf-pill' }, c.label, ' ', n));
          chipEls[c.id] = b;
          return b;
        }));
    });

    // 1.5.1 검토 반영: 칩 줄이 넘치면 숨은 쪽 끝을 흐리게(.has-prev / .has-next → CSS mask). 전에는 "등기부"·"더 좁히기" 묶음이 있다는 표시가 없었음
    var chipRow = h('div', { class: 'hf-chips' }, groups);
    function syncFade() {
      var max = chipRow.scrollWidth - chipRow.clientWidth;
      chipRow.classList.toggle('has-prev', chipRow.scrollLeft > 2);
      chipRow.classList.toggle('has-next', max > 2 && chipRow.scrollLeft < max - 2);
    }
    chipRow.addEventListener('scroll', syncFade, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(syncFade).observe(chipRow);
    /** 칩 하나가 칩 줄 안(흐린 끝 밖)에 보이게 가로로만 옮긴다 */
    function showChip(b) {
      var r = b.getBoundingClientRect();
      var cr = chipRow.getBoundingClientRect();
      if (r.left < cr.left + 16) chipRow.scrollLeft += r.left - cr.left - 16;
      else if (r.right > cr.right - 32) chipRow.scrollLeft += r.right - cr.right + 32;
      syncFade();
    }
    /**
     * 칩 줄 가로 위치. left 가 숫자면 그대로(같은 홈을 다시 그릴 때 이어 가기), 아니면 켜진 첫 칩의 묶음이 줄 앞에 오게
     * (상세에 다녀오면 0 으로 돌아가 켜진 칩이 화면 밖이던 것). 켜진 칩이 없으면 맨 앞
     */
    function placeChips(left) {
      if (typeof left === 'number') chipRow.scrollLeft = left;
      else {
        var first = null;
        HOME_CHIP_GROUPS.some(function (g) {
          return g.chips.some(function (c) { if (hf.chips[c.id]) first = chipEls[c.id]; return !!first; });
        });
        chipRow.scrollLeft = 0;
        if (first) {
          chipRow.scrollLeft = first.parentNode.getBoundingClientRect().left - chipRow.getBoundingClientRect().left - 12;
          showChip(first);
        }
      }
      syncFade();
    }

    var sortSel = h('select', { class: 'select hf-sort', id: 'hf-sort', 'data-focus-key': 'hf-sort' },
      HOME_SORTS.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    sortSel.value = hf.sort;
    sortSel.addEventListener('change', function () { hf.sort = sortSel.value; changed('sort'); });
    // 1.5.1 검토 반영: "필터 N" 배지는 뺐다(켜진 칩 이름은 결과 줄에). [모두 해제]만 정렬 옆에 두어 320px 에서도 한 줄
    var resetBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost hf-reset', 'data-focus-key': 'hf-reset', onclick: function () { reset(); } }, '모두 해제');
    var result = h('p', { class: 'hf-result', role: 'status', 'aria-live': 'polite' });

    /** 검색어와 칩을 모두 끈다(정렬은 그대로). 누른 버튼이 사라지면(빈 상태 카드·[모두 해제]) 첫 칩으로 초점 */
    function reset() {
      clearTimeout(timer);
      timer = null;
      hf.q = '';
      hf.chips = {};
      input.value = '';
      clearBtn.hidden = true;
      Object.keys(chipEls).forEach(function (id) { chipEls[id].setAttribute('aria-pressed', 'false'); });
      changed();
      var a = document.activeElement;
      if (!a || a === document.body || !a.isConnected || a.hidden) {
        var first = chipEls[HOME_CHIP_GROUPS[0].chips[0].id];
        try { first.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
      }
    }
    /** 검색어만 지운다(검색어만 있을 때 빈 상태 카드의 [검색어 지우기]). 초점은 검색 칸으로 */
    function clearSearch() {
      input.value = '';
      applySearch();
      try { input.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }
    function syncTools() {
      resetBtn.hidden = !homeFilterActive(hf);
    }
    syncTools();

    var searchBox = h('div', { class: 'hf-search' }, h('label', { class: 'sr-only', for: 'hf-q', text: '매물 검색' }), input, clearBtn);
    var el = h('div', { class: 'home-filter' },
      searchBox,
      chipRow,
      h('div', { class: 'hf-tools' },
        h('label', { class: 'sr-only', for: 'hf-sort', text: '정렬' }), sortSel, resetBtn),
      result);
    return {
      el: el,
      reset: reset,
      clearSearch: clearSearch,
      placeChips: placeChips,
      showChip: showChip,
      /**
       * 칩마다 개수(모든 매물 기준 — 그 칩 하나만 켰을 때 보일 수와 같음)와 결과 줄(필터·검색이 걸려 있을 때만):
       * "N개 중 M개 보임"(N = 모든 매물, M = 지금 보이는 카드 전부) + "(방금 추가·고친 k개 포함)" + " · 켜진 칩 이름". 사진 수를 아직 못 읽었으면 그 칩은 개수 없이
       */
      update: function (facts, shown, total, revealed) {
        var ids = Object.keys(facts);
        HOME_CHIP_GROUPS.forEach(function (g) {
          g.chips.forEach(function (c) {
            if (c.id === 'has-photo' && !homePhotoCounts) { countEls[c.id].textContent = ''; return; }
            var k = 0;
            ids.forEach(function (id) { if (c.test(facts[id])) k++; });
            countEls[c.id].textContent = '(' + k + ')';
          });
        });
        var text = '';
        if (homeFilterActive(hf)) {
          var names = homeChipNames(hf);
          text = total + '개 중 ' + shown + '개 보임' + (revealed ? '(방금 추가·고친 ' + revealed + '개 포함)' : '') + (names.length ? ' · ' + names.join(', ') : '');
        }
        if (result.textContent !== text) result.textContent = text; // 같은 글이면 다시 읽히지 않게 그대로 둔다
      }
    };
  }

  function renderHome() {
    // 다른 탭 동기화로 다시 그릴 때 초점을 같은 자리(체크박스·선택 버튼·검색 칸·필터 칩)로 되돌리려고 기억해 둔다
    var ae = document.activeElement;
    var keepFocus = ae && ae.getAttribute ? ae.getAttribute('data-focus-key') : null;
    // 1.5.1 검토 반영: 같은 홈을 다시 그릴 때(다른 탭 동기화·선택 모드 켜고 끄기)는 칩 줄 가로 위치와 "방금 추가·고친 매물"을 이어 간다.
    // 다른 화면에서 왔으면 그사이 이 탭에서 추가·고친 매물(homeReveal)만
    var sameHome = view.name === 'home';
    var oldChips = sameHome ? document.querySelector('#main .hf-chips') : null;
    var chipLeft = oldChips ? oldChips.scrollLeft : null;
    var reveal = Object.assign({}, sameHome && view.refs.reveal || {}, homeReveal);
    homeReveal = {};
    var v = newView('home');
    v.refs.reveal = reveal;
    var props = state.properties.slice().sort(sortCompare('updated')); // 바탕 순서: 최근에 고친 순(필터 정렬의 같은 값끼리도 이 순서)
    if (!props.length) homeSel.on = false;
    var sel = homeSel.on;
    if (sel) { // 그사이(다른 탭에서) 지워진 매물은 선택에서 뺀다
      var alive = {};
      props.forEach(function (p) { alive[p.id] = true; });
      Object.keys(homeSel.ids).forEach(function (id) { if (!alive[id]) delete homeSel.ids[id]; });
    }
    var allBtn = sel ? h('button', { type: 'button', class: 'tb-btn tb-text', 'data-focus-key': 'sel-all' }) : null;
    setTopbar(sel ? {
      title: '매물 선택',
      left: allBtn,
      actions: [h('button', { type: 'button', class: 'tb-btn tb-text', 'data-focus-key': 'sel-cancel', onclick: function () { setHomeSelect(false); } }, '취소')]
    } : {
      title: '임장 체크리스트',
      actions: [h('a', { class: 'tb-btn', href: '#/new', 'aria-label': '매물 추가' }, icon('plus'))]
    });
    updateTabbar('home');
    var main = resetMain();
    appendKid(main, dataWarning());
    appendKid(main, inAppWarning());
    if (!sel) {
      appendKid(main, undoBar()); // 1.4.1: 방금 지운 매물 되돌리기(토스트보다 찾기 쉬운 자리. VoiceOver 는 제목 다음)
      appendKid(main, installTip());
      appendKid(main, dataNoticeBar()); // 1.5.0 검토 반영: 데이터 2026-10c 로 옮긴 내용 한 번 안내
      appendKid(main, draftCard());
    }

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
      // 1.5.0(L1·L11): [첫 매물 추가하기]·[네이버 매물 글 붙여넣기]를 제목 바로 아래로(iPhone 390 에서는 5단계 목록 때문에 첫 화면 밖이었음),
      // 5단계 목록은 접힌 <details> "순서 자세히 보기". 빈 상태는 세로 여유가 있어 가져오기 버튼 이름을 풀어 쓴다(목록 상태는 "글·코드로 추가". 검토 반영: 화면 제목 "네이버 글·코드로 추가"와 같은 어근)
      main.append(h('section', { class: 'card flow-card', 'aria-labelledby': 'flow-title' },
        h('h2', { class: 'flow-title', id: 'flow-title', text: '처음이라면 이 순서대로' }),
        h('p', { class: 'flow-sub', text: '집을 보러 가기 전에 등기부등본부터 봐요. 문제가 있는 집은 보러 갈 필요가 없어요.' }),
        h('a', { class: 'btn btn-accent btn-block flow-cta', href: '#/new' }, icon('plus'), '첫 매물 추가하기'),
        h('a', { class: 'btn btn-secondary btn-block', href: '#/import', title: IMPORT_HINT, 'aria-label': '네이버 매물 글 붙여넣기: ' + IMPORT_HINT }, icon('paste'), '네이버 매물 글 붙여넣기'),
        h('p', { class: 'muted small flow-intro-hint', text: '중개사에게 동·호수를 받았다면 매물을 추가하고 등기부 체크부터 시작하세요. 네이버 매물 글이나 Claude가 준 코드를 붙여 넣어도 돼요.' }),
        h('details', { class: 'flow-details flow-details-first' },
          h('summary', {}, '순서 자세히 보기'),
          flowList())
      ));
      return;
    }

    var active = props.filter(function (p) { return p.status !== 'dropped'; });
    // 1.5.1(L14): 매물이 2개 이상이면 "내 매물" 아래에 검색·필터 칩·정렬 도구(homeFilterBar). 0~1개면 도구도, 기억해 둔 필터도 쓰지 않는다
    var hf = props.length >= 2 ? readHomeFilter() : null;

    // 선택 모드: 고른 수는 상단 제목과 화면 읽기용 알림 영역(처음부터 둔 빈 영역)에, [N개 삭제]는 화면 아래 고정 바에.
    // cards = 지금 보이는 카드(필터 결과). [전체 선택]·"선택 해제" 판단은 이 수로(선택 대상 = 보이는 매물)
    var cards = [];
    var live = sel ? h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }) : null;
    var delBtn = null;
    function refreshSel(announce) {
      if (view !== v) return; // 1.5.1 검토 반영: 지난 홈의 늦은 호출이 지금 화면 제목을 "매물 선택"으로 덮지 않게
      var n = Object.keys(homeSel.ids).length;
      var title = document.getElementById('tb-title');
      if (title) title.textContent = n ? n + '개 선택됨' : '매물 선택';
      allBtn.textContent = n && n === cards.length ? '선택 해제' : '전체 선택';
      delBtn.disabled = !n;
      delBtn.textContent = '';
      appendKid(delBtn, n ? [icon('trash', 'ic-sm'), n + '개 삭제'] : '지울 매물을 골라 주세요');
      if (announce) live.textContent = n ? n + '개 선택됨' : '선택한 매물이 없어요';
    }
    function cardFor(p) {
      if (!sel) return propertyCard(p);
      var c = selectCard(p, function () { refreshSel(true); });
      cards.push(c);
      return c.el;
    }

    appendKid(main, live);
    // 1.5.1 검토 반영: 필터가 켜져 있으면 머리 줄 수도 결과 줄과 같은 기준("12개 중 4개" = 모든 매물 중 보이는 카드). 꺼져 있으면 1.5.0 처럼 탈락 뺀 수
    var headCount = h('span', { class: 'count', text: active.length + '개' });
    main.append(h('div', { class: 'list-head' },
      h('h2', { class: 'h2' }, '내 매물', headCount),
      // 여러 매물을 골라 한 번에 지우기(탈락한 매물 포함)
      sel ? null : h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'data-focus-key': 'sel-start', onclick: function () { setHomeSelect(true); } }, '선택')
    ));
    var bar = hf ? homeFilterBar(hf, {
      onChange: function (kind) {
        if (kind !== 'sort') { reveal = {}; v.refs.reveal = reveal; } // 검색·칩을 바꾸면 "방금 추가·고친 매물"도 조건대로
        drawList();
      }
    }) : null;
    appendKid(main, bar ? bar.el : null);
    // 목록(위 "내 매물")과 "탈락한 매물" 묶음은 필터가 바뀔 때마다 이 자리들만 다시 그린다(도구·버튼은 그대로)
    var listWrap = h('div', { class: 'home-list' });
    main.append(listWrap);
    // 1.5.1 검토 반영: 목록 맨 아래(매물 추가 위)에도 "필터 켜짐 · 조건 [모두 해제]" — 상세에서 돌아와 스크롤이 복원되면 위 도구가 화면 밖이라
    var foot = hf ? h('div', { class: 'hf-foot', hidden: true }) : null;
    appendKid(main, foot);
    if (!sel) {
      main.append(h('div', { class: 'btn-row add-row' },
        h('a', { class: 'btn btn-accent', href: '#/new' }, icon('plus'), '매물 추가'),
        // 1.5.0 검토 반영: 화면 제목(IMPORT_TITLE "네이버 글·코드로 추가")의 끝과 같은 이름. 앞에 "네이버"까지 붙이면 375·390px 에서 두 줄
        h('a', { class: 'btn btn-secondary', href: '#/import', title: IMPORT_HINT, 'aria-label': '글·코드로 추가: ' + IMPORT_HINT }, icon('paste'), '글·코드로 추가')
      ));
    }
    var droppedWrap = h('div', { class: 'home-dropped' });
    main.append(droppedWrap);

    /**
     * 1.5.1 검토 반영: 결과 0개 빈 상태 카드는 무엇 때문인지에 맞게 — 검색어만: "검색어 “…”에 맞는 매물이 없어요 [검색어 지우기]",
     * 칩만: "조건에 맞는 매물이 없어요" + 켜진 칩 이름 [필터 모두 해제], 둘 다: [검색·필터 모두 해제]
     */
    function emptyCard() {
      var names = homeChipNames(hf);
      var msg = !names.length ? h('p', { text: '검색어 “' + hf.q + '”에 맞는 매물이 없어요' })
        : h('p', {}, '조건에 맞는 매물이 없어요',
          h('span', { class: 'hf-empty-sub', text: (hf.q ? '검색어 “' + hf.q + '” · ' : '') + '켜진 필터: ' + names.join(', ') }));
      var label = !names.length ? '검색어 지우기' : hf.q ? '검색·필터 모두 해제' : '필터 모두 해제';
      return h('div', { class: 'card hf-empty', role: 'note' }, msg,
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () { if (names.length) bar.reset(); else bar.clearSearch(); } }, label));
    }

    function drawList() {
      if (view !== v) return; // 1.5.1 검토 반영: 지난 홈 화면의 늦은 호출(사진 수 등)이 지금 화면을 건드리지 않게
      // 목록 안(선택 모드 체크박스)에 초점이 있으면 다시 그린 뒤 같은 카드로 되돌린다(사진 수가 늦게 와서 다시 그릴 때)
      var fa = document.activeElement;
      var fk = fa && (listWrap.contains(fa) || droppedWrap.contains(fa) || (foot && foot.contains(fa))) && fa.getAttribute ? fa.getAttribute('data-focus-key') : null;
      cards.length = 0;
      var facts = null;
      var shown;
      var filtering = !!hf && homeFilterActive(hf);
      if (hf) {
        facts = {};
        props.forEach(function (p) { facts[p.id] = homeFacts(p, homePhotoCounts); });
        shown = applyHomeFilter(props, hf, facts, reveal);
      } else {
        shown = { list: active, dropped: props.filter(function (p) { return p.status === 'dropped'; }), revealed: [] };
      }
      var nShown = shown.revealed.length + shown.list.length + shown.dropped.length; // 지금 보이는 카드 전부(결과 줄·머리 줄·[전체 선택]이 같은 수)
      if (sel) { // 선택 대상은 보이는 매물뿐: 필터로 숨은 매물은 선택에서 뺀다
        var vis = {};
        shown.revealed.concat(shown.list, shown.dropped).forEach(function (p) { vis[p.id] = true; });
        Object.keys(homeSel.ids).forEach(function (id) { if (!vis[id]) delete homeSel.ids[id]; });
      }
      listWrap.textContent = '';
      droppedWrap.textContent = '';
      if (shown.revealed.length) { // 방금 추가·고친 매물(조건 밖): 목록 위에 따로, 이번 홈에서만
        listWrap.append(h('section', { class: 'hf-reveal', 'aria-labelledby': 'hf-reveal-t' },
          h('h3', { class: 'hf-reveal-t', id: 'hf-reveal-t', text: '방금 추가·고친 매물 ' + shown.revealed.length + '개' }),
          h('p', { class: 'hf-reveal-sub', text: '지금 필터 조건에는 맞지 않아요. 필터를 바꾸거나 다른 화면에 다녀오면 숨겨져요.' }),
          h('div', { class: 'plist' }, shown.revealed.map(cardFor))));
      }
      if (shown.list.length) {
        listWrap.append(h('div', { class: 'plist' }, shown.list.map(cardFor)));
      } else if (filtering && shown.dropped.length) {
        listWrap.append(h('p', { class: 'muted hf-none', text: '조건에 맞는 매물은 아래 탈락한 매물에만 있어요.' }));
      } else if (filtering) {
        listWrap.append(emptyCard());
      } else {
        listWrap.append(h('p', { class: 'muted', text: '검토 중인 매물이 없어요.' }));
      }
      if (shown.dropped.length) {
        droppedWrap.append(
          h('h2', { class: 'h2' }, '탈락한 매물', h('span', { class: 'count', text: shown.dropped.length + '개' })),
          h('div', { class: 'plist' }, shown.dropped.map(cardFor)));
      }
      headCount.textContent = filtering ? props.length + '개 중 ' + nShown + '개' : active.length + '개';
      if (foot) {
        foot.textContent = '';
        foot.hidden = !filtering;
        if (filtering) {
          foot.append(h('p', { class: 'hf-foot-text', text: '필터 켜짐 · ' + homeFilterSummary(hf) }),
            h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'data-focus-key': 'hf-foot-reset', onclick: function () { bar.reset(); } }, '모두 해제'));
        }
      }
      if (bar) bar.update(facts, nShown, props.length, shown.revealed.length);
      if (sel) refreshSel(false);
      if (fk) {
        var back = main.querySelector('[data-focus-key="' + fk.replace(/["\\]/g, '\\$&') + '"]');
        if (back) { try { back.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }
      }
    }

    if (sel) {
      delBtn = h('button', {
        type: 'button', class: 'btn btn-danger btn-block', 'data-focus-key': 'sel-del',
        onclick: function () {
          var list = props.filter(function (p) { return homeSel.ids[p.id]; }); // 화면 순서대로
          if (!list.length) return;
          confirmDeleteProps(list).then(function (ok) {
            if (!ok) return;
            deleteProperties(list);
            navigate('/', true); // 같은 주소라 다시 그리기만 한다: 선택 모드를 끄고(onRoute) 남은 목록을 그림
          });
        }
      });
      main.append(h('div', { class: 'sel-bar' }, delBtn));
      allBtn.addEventListener('click', function () {
        var all = cards.length > 0 && Object.keys(homeSel.ids).length === cards.length; // 보이는 것을 모두 골랐으면 [선택 해제], 아니면 [전체 선택]
        cards.forEach(function (c) { c.set(!all); });
        refreshSel(true);
      });
    } else {
      main.append(h('details', { class: 'flow-details card' },
        h('summary', {}, '올바른 순서 다시 보기'),
        flowList()
      ));
    }
    drawList();
    if (bar) bar.placeChips(chipLeft);
    if (hf) { // 사진 수는 비동기(IndexedDB): 받으면 "사진 있음" 칩 개수를 채우고, 바뀐 것이 있으면 목록을 다시 거른다
      Photos.countByProperty().then(function (m) {
        if (view !== v) return;
        var next = m || {};
        var same = homePhotoCounts && JSON.stringify(next) === JSON.stringify(homePhotoCounts);
        homePhotoCounts = next;
        if (!same) drawList();
      }, function (err) {
        if (!dbBlockedErr(err)) console.warn('사진 수 읽기 실패(사진 있음 칩은 0으로)', err);
        if (view === v && !homePhotoCounts) { homePhotoCounts = {}; drawList(); }
      });
    }

    if (keepFocus) {
      var again = document.querySelector('[data-focus-key="' + keepFocus.replace(/["\\]/g, '\\$&') + '"]');
      if (again) { try { again.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }
      if (again && bar && again.classList.contains('hf-chip')) bar.showChip(again); // 1.5.1 검토 반영: 초점 칩이 칩 줄 밖에 남지 않게
    }
  }
  // ---------------- 매물 추가·수정 폼 ----------------
  // 새 매물 폼은 제출 전까지 매물이 없으므로, 입력을 임시 저장(DRAFT_KEY)해 둔다.
  // 전화 걸기·실거래가 찾기로 다른 앱에 다녀오는 사이 iOS 가 앱을 내려도 입력이 남는다.
  var DRAFT_FIELDS = ['name', 'dong', 'ho', 'area', 'floor', 'direction', 'ask', 'real', 'agentName', 'agentPhone', 'sellerName', 'sourceUrl', 'memo', 'dropReason'];
  var pendingFocus = null; // 다음에 그릴 수정 폼에서 초점을 줄 칸('ho'). 가져오기 직후·상세의 [입력하기]
  // 1.5.0: 다음에 그릴 상세 화면에서 열고 스크롤할 섹션 id. 수정 폼의 [저장하고 등기부 보기], 요약의 [등기부 보기]
  var pendingSection = null;

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
    setTopbar({
      title: editing ? '매물 정보 수정' : '매물 추가', back: editing ? '/p/' + id : '/',
      // 1.5.0(M8): 수정 폼은 상단 바 오른쪽에도 [완료](맨 아래 버튼까지 안 내려가도 됨). submitDone 은 아래 function 선언(끌어올려짐)
      actions: editing ? [h('button', { type: 'button', class: 'tb-btn tb-text', onclick: function () { submitDone(); } }, '완료')] : null
    });
    updateTabbar('home');
    var main = resetMain();
    var draft = editing ? null : readDraft();
    var restored = !editing && draftHasContent(draft);
    var src = editing || (restored ? {
      name: draft.name, dong: draft.dong, ho: draft.ho, area: draft.area, floor: draft.floor, direction: draft.direction,
      askPrice: draft.ask, realPrice: draft.real, agentName: draft.agentName, agentPhone: draft.agentPhone, sellerName: draft.sellerName,
      sourceUrl: draft.sourceUrl, memo: draft.memo, status: draft.status, dropReason: draft.dropReason
    } : { status: 'review' });
    // 호수 칸 강조: 가져오기 코드로 만든 매물(호수가 늘 비어 있음)이거나 [입력하기]로 들어왔을 때
    var focusHo = !!editing && pendingFocus === 'ho';
    var focusDong = !!editing && pendingFocus === 'dong'; // 1.4.5: 동도 비어 있으면 동 칸부터
    pendingFocus = null;
    // 1.5.0 통합: 홈의 "동·호수 입력 필요" 칩·상세의 [입력하기]로 동 칸부터 채우러 온 폼(focusDong)에도 같은 안내와 [저장하고 등기부 보기]
    var needHo = !!editing && !editing.ho && (!!editing.importedAt || focusHo || focusDong);
    // 1.5.0(M8): 호수(동·호수)만 채우러 온 폼에서는 호 칸의 Return 이 "완료"(저장하고 상세로)
    var hoDone = needHo || focusDong;
    // 1.6.0 통합: 폼을 열 때의 매도인 이름. [완료] 때 바뀌었으면 최근 등기부 기록의 소유자와 비교한다(ownerDiffAfterSellerEdit)
    var sellerAtOpen = editing ? str(editing.sellerName) : '';

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
    f.ho = h('input', { class: 'input', id: 'f-ho', type: 'text', value: val(src.ho), placeholder: '예: 1203', autocomplete: 'off', enterkeyhint: hoDone ? 'done' : 'next', maxlength: 20, 'aria-describedby': needHo ? 'f-ho-need' : null });
    f.area = h('input', { class: 'input', id: 'f-area', type: 'text', inputmode: 'decimal', enterkeyhint: 'next', value: val(src.area), placeholder: '예: 84.97', autocomplete: 'off', 'aria-describedby': 'f-area-hint' });
    f.floor = h('input', { class: 'input', id: 'f-floor', type: 'text', value: val(src.floor), placeholder: '예: 12/25', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20, 'aria-describedby': 'f-floor-hint' });
    f.direction = h('input', { class: 'input', id: 'f-dir', type: 'text', value: val(src.direction), placeholder: '예: 남향', autocomplete: 'off', enterkeyhint: 'next', maxlength: 20 });
    f.ask = h('input', { class: 'input', id: 'f-ask', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'next', value: val(src.askPrice), placeholder: '예: 85000', autocomplete: 'off', 'aria-describedby': 'f-ask-live f-ask-hint' });
    f.real = h('input', { class: 'input', id: 'f-real', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'next', value: val(src.realPrice), placeholder: '예: 82000', autocomplete: 'off', 'aria-describedby': 'f-real-live f-real-hint' });
    f.agentName = h('input', { class: 'input', id: 'f-agent', type: 'text', value: val(src.agentName), placeholder: '예: 행복공인중개사 김OO', autocomplete: 'off', enterkeyhint: 'next', maxlength: 60 });
    f.agentPhone = h('input', { class: 'input', id: 'f-phone', type: 'tel', inputmode: 'tel', enterkeyhint: 'next', value: val(src.agentPhone), placeholder: '예: 010-1234-5678', autocomplete: 'off', maxlength: 30 });
    // 1.6.0: 매도인 이름(선택). 등기부 소유자와 같은지 비교하는 데 쓴다(applyRegistrySnapshot)
    f.sellerName = h('input', { class: 'input', id: 'f-seller', type: 'text', value: val(src.sellerName), placeholder: '예: 홍길동', autocomplete: 'off', enterkeyhint: 'next', maxlength: SELLER_NAME_MAX, 'aria-describedby': 'f-seller-hint' });
    f.sourceUrl = h('input', { class: 'input', id: 'f-url', type: 'url', inputmode: 'url', enterkeyhint: 'next', value: val(src.sourceUrl), placeholder: '예: https://new.land.naver.com/…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 2000, 'aria-describedby': 'f-url-err f-url-hint' });
    f.memo = h('textarea', { class: 'input', id: 'f-memo', rows: 3, value: val(src.memo), placeholder: '예: 남향, 2026년 12월 입주 가능하다고 함' });
    f.dropReason = h('textarea', { class: 'input', id: 'f-drop', rows: 2, value: val(src.dropReason), placeholder: '예: 등기부에 신탁 기록' });
    // Return(다음) 키를 눌렀을 때 옮겨 갈 순서
    var order = [f.name, f.dong, f.ho, f.area, f.floor, f.direction, f.ask, f.real, f.agentName, f.agentPhone, f.sellerName, f.sourceUrl, f.memo];

    var nameErr = h('p', { class: 'field-error', id: 'f-name-err', hidden: true, text: '단지명을 입력해 주세요.' });
    var urlErr = h('p', { class: 'field-error', id: 'f-url-err', hidden: true, text: 'http:// 또는 https:// 로 시작하는 주소만 저장돼요.' });
    var hoTitleText = editing && !editing.dong ? '동·호수만 입력하면 돼요' : '호수만 입력하면 돼요'; // 1.4.5(L4): 동도 비었으면
    var hoTitle = h('strong', { text: hoTitleText });
    var hoDesc = h('p', { id: 'f-ho-need', text: editing && editing.importedAt
      ? '등기부 열람에 꼭 필요해요. 네이버 부동산에는 호수가 없으니 중개사에게 받아 적어 주세요.'
      : '등기부 열람에 꼭 필요해요. 중개사에게 받아 적어 주세요.' });
    var hoBanner = needHo ? h('div', { class: 'notice notice-ho', role: 'note' },
      hoTitle,
      hoDesc,
      // 1.5.0(M8): 호수를 적고 바로 등기부로(저장 → 상세 → 등기부 섹션 열고 스크롤). 등기부 섹션이 없는 데이터면 생략.
      // 통합: 호수를 적어도 배너를 닫지 않는다(1.4.x 는 닫았음 — 그러면 이 버튼도 사라져 못 누름). 대신 제목을 바꾸고 설명 줄만 숨긴다(refreshLive)
      gateSections().length ? h('button', {
        type: 'button', class: 'btn btn-small btn-accent',
        onclick: function () { submitTo(gateSections()[0].id); }
      }, '저장하고 등기부 보기') : null) : null;
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
      if (hoBanner) { // 1.5.0: 호수를 입력하면 안내를 닫는 대신(닫으면 [저장하고 등기부 보기]도 사라짐) 제목을 바꾸고 설명 줄만 숨긴다
        var hasHo = !!f.ho.value.trim();
        hoBanner.classList.toggle('is-filled', hasHo);
        hoTitle.textContent = hasHo ? '호수를 적었어요. 이제 등기부를 볼 수 있어요' : hoTitleText;
        hoDesc.hidden = hasHo;
      }
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
        sellerName: f.sellerName.value.replace(/\s+/g, ' ').trim().slice(0, SELLER_NAME_MAX), // 1.6.0
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
          ask: f.ask.value, real: f.real.value, agentName: f.agentName.value, agentPhone: f.agentPhone.value, sellerName: f.sellerName.value,
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
        // 1.6.0 통합: 매도인 이름을 고쳤으면 최근 등기부 기록의 소유자와 비교해 "소유자 ≠ 매도인"을 채우거나(비어 있을 때) 바꿀지 묻는다(토스트)
        if (str(editing.sellerName) !== sellerAtOpen) ownerDiffAfterSellerEdit(editing);
        saveNow();
        goBack('/p/' + editing.id, true);
        return;
      }
      // fieldsAt: {} → 새 매물(예전 기록이 아님). 칸 시각은 만든 시각으로 채워진다
      var p = normalizeProperty(Object.assign({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), fieldsAt: {} }, readForm()));
      state.properties.unshift(p);
      homeReveal[p.id] = true; // 1.5.1 검토 반영: 홈 필터가 켜져 있어도 돌아간 홈에서 한 번 보이게
      dirty = true;
      saveNow();
      localRemove(DRAFT_KEY);
      toast('매물을 추가했어요. 등기부부터 확인하세요.');
      navigate('/p/' + p.id, true);
    }
    /** 1.5.0(M8): 저장(완료)한 뒤 상세에서 secId 섹션을 열고 그리로 스크롤. 단지명이 비어 저장이 안 되면 섹션도 열지 않는다 */
    function submitTo(secId) {
      if (!validateName(true)) { f.name.focus(); return; } // 폼에 그대로 남는다(submit 과 같은 검사)
      pendingSection = secId;
      submit();
    }
    /**
     * 1.5.0 검토 반영: 호수만 채우러 온 폼(hoDone)에서는 호 칸의 Return·상단 [완료]·아래 [완료]도 호수를 적었으면
     * [저장하고 등기부 보기]와 같은 곳(상세의 등기부 섹션을 열고 스크롤)에 닿는다. 전에는 저장만 하고 상세 맨 위로 가서
     * 배너("이제 등기부를 볼 수 있어요")의 작은 버튼만이 등기부로 가는 길이었음. 호수가 비어 있으면 예전처럼 저장만
     */
    function submitDone() {
      var g = gateSections()[0];
      if (hoDone && g && f.ho.value.trim()) submitTo(g.id); else submit();
    }

    // 폼 안에 submit 버튼을 두지 않는다(type=button). 그래서 iPhone 키보드의 Return(다음) 키로
    // 폼이 제출되지 않고, 아래 keydown 처리로 다음 칸으로 넘어간다.
    var submitBtn = h('button', { type: 'button', class: 'btn btn-block', onclick: submitDone }, editing ? '완료' : '저장하고 체크 시작');
    var form = h('form', { class: 'form', novalidate: true, autocomplete: 'off' },
      restored ? h('div', { class: 'notice notice-info', role: 'status' },
        h('strong', { text: '작성 중이던 내용을 불러왔어요' }),
        h('p', { text: '입력은 저장 버튼을 누르기 전에도 이 기기에 임시로 보관돼요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-ghost', style: 'margin-top:8px',
          onclick: function () { localRemove(DRAFT_KEY); renderForm(null); }
        }, '비우고 새로 쓰기')) : null,
      // 1.5.0(L5): 다 채워야 저장되는 줄 알고 멈추지 않게(호가·실거래가·중개사는 첫날엔 모르는 값)
      editing ? null : h('p', { class: 'form-intro', text: '단지명만 넣고 저장해도 돼요. 동·호수는 중개사에게 받으면, 가격은 나중에 채워도 돼요.' }),
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
      field('매도인 이름 (선택)', f.sellerName, { hint: '집을 파는 사람(지금 집주인) 이름이에요. 등기부를 해석할 때 등기부의 소유자와 같은 사람인지 비교하는 데 써요. 공동명의면 쉼표로 함께 적어요. (예: 홍길동, 김철수)' }),
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
      if (t === f.ho && hoDone) { submitDone(); return; } // 1.5.0(M8): 호수만 채우러 온 폼은 Return = 완료(검토 반영: 등기부 섹션까지)
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
    else if (focusDong) { try { f.dong.focus(); } catch (e) { /* 무시 */ } }
    return editing && !focusHo && !focusDong ? null : 'focused'; // 새 매물은 단지명, 호수 입력은 호수(동) 칸에 초점을 주므로 제목으로 옮기지 않는다
  }

  // ---------------- 매물 지우기와 되돌리기 ----------------
  // 수정 화면의 [이 매물 삭제]와 홈 선택 모드의 [N개 삭제]가 같이 쓴다.
  // 기록은 바로 지우고 한 번 저장한다(삭제 표시 deleted 로 다른 탭·다른 기기 [합치기]에도 전함).
  // 사진은 [되돌리기]를 누를 수 있는 동안(UNDO_MS) 남겨 두었다가 지운다. 그 전에 앱이 닫히면 다음에 열 때
  // 남은 사진 정리(cleanDeletedPhotos)가 지운다.
  // 1.4.1: [되돌리기] 토스트나 홈의 되돌리기 줄(undoBar)에 초점·손가락이 있으면 UNDO_HOLD_MAX_MS 까지 기다린다(pendingTick).
  // { at, entries: [{ prop, index(목록 위치), deletedAt }], gone: { 열쇠: 지우기 전 시각 | null }, goneNow, timer, toast }
  var pendingDelete = null;

  /** 되돌리기를 기다리는 중에 사용자가 그 자리를 쓰고 있는지: 그 토스트가 떠 있음(멈춤 포함), 또는 홈 되돌리기 줄에 초점 */
  function undoInUse(pd, focusOnly) {
    var a = document.activeElement;
    var t = $('#toast');
    var focused = !!(a && ((t && t.contains(a) && pd.toast === shownToast()) || (a.closest && a.closest('.undo-bar'))));
    if (focusOnly) return focused;
    return focused || (pd.toast !== 0 && pd.toast === shownToast());
  }

  /** 되돌리기 시간이 지났는지 본다. 그 자리를 쓰고 있으면(UNDO_HOLD_MAX_MS 까지) 1초 뒤 다시 본다 */
  function pendingTick(pd) {
    if (pendingDelete !== pd) return;
    clearTimeout(pd.timer);
    if (Date.now() - pd.at < UNDO_HOLD_MAX_MS && undoInUse(pd)) {
      pd.timer = setTimeout(function () { pendingTick(pd); }, 1000);
      return;
    }
    settlePendingDelete();
  }

  /** 홈 맨 위의 "방금 매물 N개를 지웠어요 [되돌리기]" 줄(1.4.1). 토스트를 놓쳐도(다른 알림이 덮음, VoiceOver) 되돌릴 수 있게 */
  function undoBar() {
    var pd = pendingDelete;
    if (!pd) return null;
    var n = pd.entries.filter(function (e) { return !findProp(e.prop.id); }).length;
    if (!n) return null;
    return h('div', { class: 'undo-bar', role: 'group', 'aria-label': '방금 지운 매물' },
      h('p', { text: n > 1 ? '방금 매물 ' + n + '개를 지웠어요' : '방금 매물을 지웠어요' }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () { restoreDeleted(pd); } }, '되돌리기'));
  }

  /** 지우기 확인: 이름 목록(5개까지 + "외 N개")과 함께 지워지는 것을 알린다. 위험 대화상자라 첫 초점은 [취소] */
  function confirmDeleteProps(list, title) {
    return openDialog({
      title: title || '매물 ' + list.length + '개를 지울까요?',
      content: h('div', { class: 'del-confirm' },
        nameList(list, 5, true),
        h('p', { text: '체크 기록, 메모, 사진·서류도 함께 지워져요.' })),
      buttons: [
        { label: '지우기', value: 'delete', kind: 'danger' },
        { label: '취소', value: null, kind: 'secondary' }
      ]
    }).then(function (r) { return r.value === 'delete'; });
  }

  /** 수정 화면의 [이 매물 삭제] */
  function deleteProperty(prop) {
    confirmDeleteProps([prop], '이 매물을 지울까요?').then(function (ok) {
      if (!ok) return;
      deleteProperties([prop]);
      navigate('/', true);
    });
  }

  /**
   * 매물 여러 개를 한 번에 지운다. 저장은 한 번. 토스트 "N개 지웠어요 [되돌리기]"(UNDO_MS).
   * 매물마다 삭제 표시(그 매물의 마지막 변경보다 늘 나중 시각, stampAfter)와 지운 매물 열쇠(goneKeys)를 남긴다.
   * 결과: 지운 수
   */
  function deleteProperties(list) {
    settlePendingDelete(); // 앞서 지운 매물은 되돌리기를 끝내고 사진을 지운다(토스트는 하나뿐이라)
    var want = {};
    list.forEach(function (p) { want[p.id] = true; });
    var entries = [];
    state.properties.forEach(function (p, i) { if (hasOwn(want, p.id)) entries.push({ prop: p, index: i, deletedAt: 0 }); });
    if (!entries.length) return 0; // 그사이 다른 탭에서 지워짐
    var goneBefore = Object.assign({}, state.goneKeys);
    var now = Date.now();
    state.properties = state.properties.filter(function (p) { return !hasOwn(want, p.id); });
    entries.forEach(function (e) {
      // 다른 탭·다른 기기에도 지운 것을 알린다. 이 매물의 마지막 변경(다른 기기에서 받은 것 포함)보다 늘 나중 시각
      e.deletedAt = state.deleted[e.prop.id] = stampAfter(now, e.prop.updatedAt);
      rememberGone(e.prop, e.deletedAt); // 같은 매물을 코드로 다시 가져오면 알려 주려고
    });
    // 되돌릴 때 지운 매물 열쇠도 되돌리려고, 이번에 바뀐 열쇠의 앞뒤 값을 남긴다
    var gone = {};
    var goneNow = {};
    Object.keys(state.goneKeys).forEach(function (k) {
      if (state.goneKeys[k] === goneBefore[k]) return;
      gone[k] = hasOwn(goneBefore, k) ? goneBefore[k] : null;
      goneNow[k] = state.goneKeys[k];
    });
    dirty = true;
    saveNow();
    var pd = { at: Date.now(), entries: entries, gone: gone, goneNow: goneNow, timer: null, toast: 0 };
    pendingDelete = pd;
    // 토스트가 사라진 뒤에 사진을 지운다(사라지기 직전에 누른 [되돌리기]와 겹치지 않게 조금 늦게).
    // 1.4.1: 그때 토스트가 멈춰 있거나 되돌리기 줄에 초점이 있으면 더 기다린다(pendingTick)
    pd.timer = setTimeout(function () { pendingTick(pd); }, UNDO_MS + 500);
    var n = entries.length;
    pd.toast = toast(n > 1 ? n + '개 지웠어요' : '매물을 지웠어요', {
      duration: UNDO_MS,
      action: { label: '되돌리기', fn: function () { restoreDeleted(pd); } }
    });
    return n;
  }

  /** 되돌리기를 끝낸다: 아직 지워진 채인 매물의 사진을 지우고, 떠 있는 [되돌리기] 토스트와 홈의 되돌리기 줄을 닫는다 */
  function settlePendingDelete() {
    var pd = pendingDelete;
    if (!pd) return;
    pendingDelete = null;
    clearTimeout(pd.timer);
    // 초점이 사라지는 버튼(토스트·되돌리기 줄)에 있었으면 화면 제목으로 옮긴다
    var lostFocus = undoInUse(pd, true);
    if (pd.toast && pd.toast === toastSeq) hideToast();
    var bar = document.querySelector('.undo-bar');
    if (bar) bar.remove();
    if (lostFocus) focusTitle();
    pd.entries.forEach(function (e) {
      var id = e.prop.id;
      if (findProp(id)) return; // 그사이 되살아났다(다른 탭에서 고침 등): 사진을 남긴다
      sessionRemove('imjang.open.' + id);
      // 실패해도(연결 끊김 등) 다음에 앱을 열 때 남은 사진 정리(cleanDeletedPhotos)가 다시 지운다. 1.6.0: 서류도 같이
      Photos.removeByProperty(id).catch(function (err) { if (!dbBlockedErr(err)) console.warn('사진 정리 실패(다음에 다시 시도)', err); });
      Docs.removeByProperty(id).catch(function (err) { if (!dbBlockedErr(err)) console.warn('서류 정리 실패(다음에 다시 시도)', err); });
    });
  }

  /**
   * 앱을 내렸다가 다시 보일 때: 되돌리기 시간이 이미 지났으면 끝낸다(앱이 내려가 있는 동안 타이머가 멈출 수 있음).
   * 1.4.1: 그 버튼에 초점이 있으면 기다리는 시간(UNDO_HOLD_MAX_MS) 안에서는 남긴다
   */
  function expirePendingDelete() {
    var pd = pendingDelete;
    if (!pd) return;
    var age = Date.now() - pd.at;
    if (age > UNDO_HOLD_MAX_MS || (age > UNDO_MS && !undoInUse(pd, true))) settlePendingDelete();
  }

  /**
   * 1.4.1: 방금(UNDO_KEEP_MS 안) 지워 다른 탭에서 [되돌리기]를 기다리고 있을 수 있는 매물 id.
   * 전체 삭제·[덮어쓰기]가 이 매물도 "이 기기 초기화"(localDeleted)로 표시해, 그 탭이 빈 기록 위에 되살리지 않게 한다(restoreDeleted)
   */
  function recentlyDeleted(s) {
    var now = Date.now();
    var alive = {};
    s.properties.forEach(function (p) { alive[p.id] = true; });
    return Object.keys(s.deleted).filter(function (id) { return !alive[id] && Math.abs(now - s.deleted[id]) < UNDO_KEEP_MS; });
  }

  /**
   * [되돌리기]: 지운 매물을 원래 자리에 되살리고 삭제 표시를 지운다. updatedAt 은 지금(삭제 표시보다 늘 나중)으로 올려
   * "지운 뒤에 고친 매물"로 남게 한다. 그래서 다른 탭이 예전 삭제 표시를 다시 합치거나, 지우기가 실린 백업을 다른 기기에서
   * [합치기] 해도 다시 지워지지 않는다(deleted[id] 보다 updatedAt 이 나중이면 남김: mergeInto, merge.js mergeStates)
   */
  function restoreDeleted(pd) {
    if (pendingDelete !== pd) return; // 이미 끝났다(사진까지 지움)
    if (Date.now() - pd.at > UNDO_KEEP_MS) { // 앱을 내렸다가 오래 뒤에 누름: 다른 탭이 사진을 정리했을 수 있다
      settlePendingDelete();
      toast('되돌릴 수 있는 시간이 지났어요');
      return;
    }
    pullFromStorage(); // 그사이 다른 탭이 쓴 내용부터 합친다(이미 돌아온 매물을 두 번 넣지 않게)
    // 1.4.1: 그사이 다른 탭에서 전체 삭제·[덮어쓰기]를 했으면(이 매물도 localDeleted 로 표시됨, 사진 저장소도 비워짐) 되살리지 않는다
    if (pd.entries.some(function (e) { return (state.localDeleted[e.prop.id] || 0) > e.deletedAt; })) {
      settlePendingDelete();
      clearTimeout(refreshTimer);
      tryRefreshView();
      var fa = document.activeElement;
      if (!fa || fa === document.body) focusTitle();
      toast('다른 창에서 기록을 지우거나 바꿔서 되돌리지 못했어요', { duration: 5000 });
      return;
    }
    pendingDelete = null;
    clearTimeout(pd.timer);
    var now = Date.now();
    var n = 0;
    pd.entries.slice().sort(function (a, b) { return a.index - b.index; }).forEach(function (e) {
      var p = findProp(e.prop.id);
      if (!p) {
        p = e.prop;
        state.properties.splice(Math.min(e.index, state.properties.length), 0, p);
      }
      p.updatedAt = stampAfter(now, p.updatedAt, e.deletedAt, state.deleted[p.id]);
      delete state.deleted[p.id];
      n++;
    });
    // 지울 때 남긴 지운 매물 열쇠를 되돌린다. 그사이 바뀐 열쇠(다른 매물을 지움 등)는 그대로 둔다
    Object.keys(pd.gone).forEach(function (k) {
      if (state.goneKeys[k] !== pd.goneNow[k]) return;
      if (pd.gone[k] === null) delete state.goneKeys[k];
      else state.goneKeys[k] = pd.gone[k];
    });
    dirty = true;
    saveNow();
    // 지금 화면을 다시 그린다(홈이면 되살린 매물이 다시 보임). 토스트 버튼에 있던 초점은 화면 제목으로
    clearTimeout(refreshTimer);
    tryRefreshView();
    var a = document.activeElement;
    if (!a || a === document.body || $('#toast').contains(a)) focusTitle();
    toast(n > 1 ? n + '개를 되돌렸어요' : '매물을 되돌렸어요');
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
    // 동·호수가 없으면 등기부를 열람할 수 없다(가져온 매물은 동만 있고 호수가 비어 있음 → "호수를"). 1.4.5: 동도 본다
    if ((!prop.dong || !prop.ho) && prop.status !== 'dropped') {
      main.append(h('div', { class: 'notice notice-ho', role: 'note' },
        h('strong', { text: (prop.dong ? '호수를' : '동·호수를') + ' 입력해야 등기부를 볼 수 있어요' }),
        h('p', { text: '등기부등본은 동·호수까지 알아야 열람할 수 있어요. 중개사에게 받아 적어 주세요.' }),
        h('div', { class: 'btn-row' },
          h('button', {
            type: 'button', class: 'btn btn-small btn-accent',
            onclick: function () { pendingFocus = prop.dong ? 'ho' : 'dong'; navigateNow('/p/' + prop.id + '/edit'); } // 클릭 안에서 그려야 iOS 가 키보드를 띄움
          }, '입력하기'),
          extLink('인터넷등기소', '인터넷등기소 열기', 'btn btn-small btn-ghost')) // 1.4.5
      ));
    }
    // 1.5.0(L2): 등기부 멈춤 신호(2026-10c 데이터는 8개)가 모두 "없음"이면 "멈춤 신호 없음 — [임장 예정으로 바꾸기]" 제안 줄(경고 상자와 따로. refreshFlowHint).
    // 검토 반영: 헤더 카드 위(상단 바 바로 아래)에 둔다 — 카드 아래에 두면 메모·중개사·가져오기 참고가 있는 매물에서 첫 화면 밖이고 버튼이 탭바 뒤였음
    v.refs.flowHint = h('div', { class: 'flow-hint-wrap', id: 'd-flow', role: 'status' });
    main.append(v.refs.flowHint);

    main.append(detailHeader(prop));

    v.refs.alerts = h('div', { class: 'alerts', id: 'd-alerts' });
    // 화면을 처음 그릴 때는 경고를 다시 읽어 주지 않는다(새로 '있음'을 누를 때만 role=alert)
    v.refs.prevStopCount = prop.status === 'dropped' ? 0 : flagsYes(prop, 'stop').length;
    main.append(v.refs.alerts);
    renderAlerts(prop); // 제안 줄(refreshFlowHint)도 이 안에서 같이 그린다
    // 1.7.0: 대출·비용(추정) 카드. 접힌 머리 줄에 필요 현금·대출 한도 요약(펼친 상태는 이 탭에서 기억)
    main.append(finCard(prop));

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

    // 1.5.0(M8): [저장하고 등기부 보기]·요약의 [등기부 보기]로 왔으면 그 섹션을 열고 스크롤.
    // onRoute 가 그린 직후 맨 위로 스크롤하므로 그 뒤(setTimeout)에 옮긴다
    if (pendingSection) {
      var ps = pendingSection;
      pendingSection = null;
      if (v.refs.secs[ps]) setTimeout(function () { if (view === v) jumpToSection(ps); }, 0);
    }

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

    // 1.5.0(L2): 상태 select 를 이름 줄 옆으로 올리고(메모 아래까지 안 내려가도 됨), 아래 한 줄로 상태의 뜻을 적는다
    var sel = h('select', { class: 'select', id: 'd-status', 'aria-describedby': 'd-status-help' }, STATUSES.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    sel.value = prop.status;
    sel.addEventListener('change', function () { changeStatus(prop, sel.value); });
    v.refs.statusSelect = sel;
    var statusBox = h('div', { class: 'dh-status' }, h('label', { for: 'd-status', text: '진행 상태' }), sel);
    var statusHelp = h('p', { class: 'status-help', id: 'd-status-help', text: STATUS_HELP });

    var o = overallProgress(prop);
    v.refs.overallBar = makeBar(o.pct, o.pct + '% (' + o.done + '/' + o.total + ')', { ariaLabel: '전체 진행률' });

    var saveState = h('p', { class: 'save-state', id: 'save-state' });
    var memoWrap = memoBlock(prop.memo);
    var card = h('section', { class: 'card dh', 'aria-label': '매물 요약' },
      h('div', { class: 'dh-top' },
        h('div', { class: 'dh-head' },
          h('h2', { class: 'dh-name', text: prop.name }),
          line ? h('p', { class: 'dh-unit', text: line }) : null,
          extra ? h('p', { class: 'dh-extra', text: extra }) : null
        ),
        statusBox
      ),
      statusHelp,
      dl,
      sourceLink(prop),
      agent,
      memoWrap ? memoWrap.el : null,
      importNotesBlock(prop),
      h('div', {},
        h('div', { class: 'dh-progress-head' }, h('p', { class: 'small muted', style: 'font-weight:700', text: '전체 진행' }), saveState),
        v.refs.overallBar.el)
    );
    setTimeout(function () {
      updateSaveState(); // 화면에 붙은 뒤 '자동 저장됨' 표시 채우기
      if (memoWrap) memoWrap.measure(); // 메모가 3줄을 넘을 때만 [더 보기]
    }, 0);
    return card;
  }

  // 1.5.0(L2): 진행 상태 5개의 뜻(상태 select 아래 한 줄). 상태 이름을 바꾸면 data.js 용어도 같이
  var STATUS_HELP = '검토 중 = 등기부 확인 단계 · 임장 예정 = 등기부 통과, 방문 전 · 임장 완료 = 다녀옴 · 계약 검토 = 가계약 전 재확인';
  var MEMO_CLAMP_LINES = 3; // 헤더 카드 메모를 접었을 때 보이는 줄 수(CSS -webkit-line-clamp 와 같음)

  /**
   * 1.5.0(M7): 헤더 카드 메모. 3줄로 접고 넘치면 [더 보기]/[접기]. 결과 { el, measure } (measure 는 화면에 붙인 뒤).
   * 줄 수를 세어 두고(긴 메모는 바로 버튼), 붙인 뒤 실제 높이로 한 번 더 본다(짧은 줄이 여러 번 꺾일 때)
   */
  function memoBlock(memo) {
    memo = str(memo);
    if (!memo.trim()) return null;
    var p = h('p', { class: 'dh-memo is-clamped', id: 'd-memo', text: memo });
    var btn = h('button', { type: 'button', class: 'dh-memo-more', 'aria-expanded': 'false', 'aria-controls': 'd-memo', hidden: true }, '더 보기');
    var el = h('div', { class: 'dh-memo-wrap' }, p, btn);
    var open = false;
    btn.addEventListener('click', function () {
      open = !open;
      p.classList.toggle('is-clamped', !open);
      btn.textContent = open ? '접기' : '더 보기';
      btn.setAttribute('aria-expanded', String(open));
      if (!open) { try { btn.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 무시 */ } }
    });
    function measure() {
      if (open) return;
      var lines = (memo.match(/\n/g) || []).length + 1;
      btn.hidden = !(lines > MEMO_CLAMP_LINES || p.scrollHeight > p.clientHeight + 2);
    }
    return { el: el, measure: measure };
  }

  /** 1.5.0(M7): 가져오기 참고(importNotes) — 접힌 목록. 없으면 null. 공유 글(buildShareText)에는 넣지 않는다 */
  function importNotesBlock(prop) {
    var notes = Array.isArray(prop.importNotes) ? prop.importNotes : [];
    if (!notes.length) return null;
    return h('details', { class: 'dh-import-notes' },
      h('summary', {}, '가져오기 참고 ' + notes.length + '개', h('span', { class: 'sr-only', text: ' (앱이 가져오면서 알려 주는 말)' })),
      h('ul', { class: 'dh-import-list' }, notes.map(function (n) { return h('li', { text: n }); }))
    );
  }

  /**
   * 1.5.0(L2 + M3 후속): 등기부 멈춤 신호를 모두 "없음"으로 답했고 아직 "검토 중"이면
   * "멈춤 신호 없음 — [임장 예정으로 바꾸기]" 한 줄을 헤더 카드 아래에 보여 준다. renderAlerts(항목·상태가 바뀔 때마다 불림)가 부른다
   */
  function refreshFlowHint(prop) {
    var box = view.refs.flowHint;
    if (!box || view.prop !== prop) return;
    var gs = gateStopState(prop);
    var show = prop.status === 'review' && gs.total > 0 && gs.yes === 0 && gs.unanswered === 0;
    if (!show) { box.textContent = ''; return; }
    if (box.firstChild) return; // 이미 보여 주고 있음(다시 그리면 VoiceOver 가 또 읽음)
    box.append(h('div', { class: 'flow-hint' },
      h('p', {}, h('strong', { text: '멈춤 신호 없음' }), ' — 등기부 멈춤 신호 ' + gs.total + '개를 모두 "없음"으로 답했어요. 이제 보러 가도 돼요.'),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () { applyStatus(prop, 'planned'); } }, '임장 예정으로 바꾸기')
    ));
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
    toast('상태: ' + STATUS_LABEL[next], { duration: 1500 }); // 1.5.0 검토 반영: 짧게(집 안 항목의 [양호] 위에 겹치는 시간을 줄임)
  }

  function afterStatusChange(prop) {
    if (view.prop !== prop) return;
    if (view.refs.statusSelect) view.refs.statusSelect.value = prop.status;
    if (view.refs.sectionsWrap) view.refs.sectionsWrap.classList.toggle('prop-dropped', prop.status === 'dropped');
    renderAlerts(prop);
    refreshStopWords(prop); // 1.4.5: 임장 완료·계약 검토로 바뀌면 항목 안 멈춤 문구도 "돈을 보내지 말고"로
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
    refreshFlowHint(prop); // 1.5.0(L2): 멈춤 신호가 모두 "없음"이면 헤더 아래 "[임장 예정으로 바꾸기]" 제안 줄(경고 상자와 따로)
  }

  function sectionChips(prop) {
    var nav = h('nav', { class: 'sec-chips', 'aria-label': '섹션 바로가기' });
    CL.sections.forEach(function (sec) {
      var p = sectionProgress(prop, sec);
      var n = h('span', { class: 'n', text: p.done + '/' + p.total });
      // 1.5.0: 칩 글자는 짧은 제목(data.js shortTitle, 없으면 title). 긴 제목은 title 속성으로
      var chip = h('button', {
        type: 'button',
        class: 'sec-chip' + (sec.gate ? ' is-gate' : '') + (p.total && p.done === p.total ? ' is-complete' : ''),
        title: sec.shortTitle && sec.shortTitle !== sec.title ? sec.title : null,
        onclick: function () { jumpToSection(sec.id); }
      }, sec.shortTitle || sec.title, n);
      view.refs.chips[sec.id] = { el: chip, n: n };
      nav.append(chip);
    });
    return chipScroller(nav);
  }

  /**
   * 1.5.0: 지금 보고 있는 섹션의 칩에 aria-current="true"(죽어 있던 CSS 살리기).
   * 열린 섹션 가운데 칩 줄 아래로 아직 끝나지 않은 첫 섹션 = 화면에서 가장 위에 보이는 열린 섹션.
   * 열린 섹션이 모두 위로 지나갔으면 마지막 열린 섹션. 바뀔 때만 그 칩이 보이도록 줄을 옮긴다(세로 스크롤은 건드리지 않음)
   */
  function syncCurrentChip() {
    if (view.name !== 'detail' || !view.refs.chips || !view.refs.secs) return;
    var wrap = view.refs.chipsWrap;
    var line = wrap ? wrap.getBoundingClientRect().bottom : 0;
    var opens = CL.sections.filter(function (sec) { var r = view.refs.secs[sec.id]; return r && !r.body.hidden; });
    var cur = null;
    opens.forEach(function (sec) {
      if (!cur && view.refs.secs[sec.id].wrap.getBoundingClientRect().bottom > line + 1) cur = sec.id;
    });
    if (!cur && opens.length) cur = opens[opens.length - 1].id;
    var changed = false;
    CL.sections.forEach(function (sec) {
      var c = view.refs.chips[sec.id];
      if (!c) return;
      var on = sec.id === cur;
      if (on === (c.el.getAttribute('aria-current') === 'true')) return;
      changed = true;
      if (on) c.el.setAttribute('aria-current', 'true'); else c.el.removeAttribute('aria-current');
    });
    if (changed && cur) revealChip(view.refs.chips[cur].el);
  }
  var chipSyncRaf = 0;
  function scheduleChipSync() {
    if (chipSyncRaf || view.name !== 'detail') return;
    chipSyncRaf = requestAnimationFrame(function () { chipSyncRaf = 0; syncCurrentChip(); });
  }
  window.addEventListener('scroll', scheduleChipSync, { passive: true });
  window.addEventListener('resize', scheduleChipSync);

  /** 칩이 줄 밖에 있으면 가로로만 옮겨 보이게 한다(scrollIntoView 는 세로 스크롤까지 움직일 수 있어 쓰지 않음) */
  function revealChip(chip) {
    var nav = chip.parentNode;
    if (!nav) return;
    var cr = chip.getBoundingClientRect();
    var nr = nav.getBoundingClientRect();
    var pad = 12;
    var left = nav.scrollLeft;
    if (cr.left < nr.left + pad) left += cr.left - nr.left - pad;
    else if (cr.right > nr.right - pad) left += cr.right - nr.right + pad;
    else return;
    if (nav.scrollTo) nav.scrollTo({ left: left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    else nav.scrollLeft = left;
  }

  /**
   * 1.4.4: 가로로 넘치는 칩 줄을 옮기는 도우미.
   * - 양 끝 ◀ ▶ 버튼: 숨은 칩이 있는 쪽에만 보이고, 누르면 줄 폭의 70% 만큼 옮긴다.
   * - 마우스로 끌기: 6px 넘게 끌면 줄이 따라오고, 끈 뒤의 클릭(칩 이동)은 무시한다. 터치는 원래대로 손가락으로 민다.
   * 키보드는 칩에 초점을 옮기면 브라우저가 알아서 보이게 하므로 ◀ ▶ 버튼은 탭 순서에서 뺀다.
   */
  function chipScroller(nav) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function step(dir) {
      var by = dir * Math.max(120, Math.round(nav.clientWidth * 0.7));
      if (nav.scrollBy) nav.scrollBy({ left: by, behavior: reduce ? 'auto' : 'smooth' });
      else nav.scrollLeft += by;
    }
    var prev = h('button', { type: 'button', class: 'chip-arrow chip-arrow-prev', tabindex: '-1', 'aria-label': '앞쪽 섹션 보기', hidden: true, onclick: function () { step(-1); } }, icon('back'));
    var next = h('button', { type: 'button', class: 'chip-arrow chip-arrow-next', tabindex: '-1', 'aria-label': '뒤쪽 섹션 보기', hidden: true, onclick: function () { step(1); } }, icon('forward'));
    var wrap = h('div', { class: 'sec-chips-wrap' }, nav, prev, next);
    view.refs.chipsWrap = wrap; // 1.5.0: syncCurrentChip 이 "칩 줄 아래" 기준선으로 씀
    function update() {
      var max = nav.scrollWidth - nav.clientWidth;
      prev.hidden = !(nav.scrollLeft > 2);
      next.hidden = !(max > 2 && nav.scrollLeft < max - 2);
      // 1.5.0: ◀ ▶ 는 마우스 환경(hover+fine pointer)에서만 보이고(CSS), 터치에서는 양 끝 그라데이션으로 "더 있음"을 알린다
      wrap.classList.toggle('has-prev', !prev.hidden);
      wrap.classList.toggle('has-next', !next.hidden);
    }
    nav.addEventListener('scroll', update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(nav);
    else window.addEventListener('resize', update);
    requestAnimationFrame(update);

    // 마우스 끌기
    var drag = null;
    var suppressClick = false;
    nav.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, left: nav.scrollLeft, moved: false };
    });
    nav.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 6) return;
        drag.moved = true;
        nav.classList.add('is-dragging');
        try { nav.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      }
      nav.scrollLeft = drag.left - dx;
      e.preventDefault();
    });
    function endDrag() {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0); // 끈 직후의 클릭 한 번만 무시
      }
      nav.classList.remove('is-dragging');
      drag = null;
    }
    nav.addEventListener('pointerup', endDrag);
    nav.addEventListener('pointercancel', endDrag);
    nav.addEventListener('click', function (e) {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    nav.addEventListener('dragstart', function (e) { e.preventDefault(); }); // 버튼 글자를 끌어 놓기로 잡지 않게

    return wrap;
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
    // 1.4.5: 머리 아래 작은 바로가기(새 창). 등기부 → 인터넷등기소, 가기 전 준비 → 실거래가·건축물대장. data.js 에 없으면 생략
    var links = sec.gate ? [extLink('인터넷등기소', '인터넷등기소 열기')]
      : sec.id === 'prep' ? [extLink('실거래가', '실거래가 조회'), extLink('건축물대장', '건축물대장')] : [];
    links = links.filter(Boolean);
    var wrap = h('section', { class: 'sec' + (sec.gate ? ' sec-gate' : ''), id: 'sec-' + domId(sec.id) },
      head, links.length ? h('div', { class: 'sec-links' }, links) : null,
      sec.gate ? registrySnapLine(prop) : null, // 1.6.0 통합: "등기부 기록 N개 · 마지막 열람 …" + [기록 보기](접혀 있어도 보임)
      body);
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
    syncCurrentChip(); // 1.5.0
  }

  function jumpToSection(secId) {
    toggleSection(secId, true);
    var r = view.refs.secs[secId];
    if (!r) return;
    r.wrap.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setTimeout(function () { try { r.head.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }, 350);
  }

  /** 1.5.0: 항목으로 이동. 섹션을 열고, 접힌 항목이면 펼친 뒤 칩 줄 아래에 오도록 스크롤하고 항목에 초점(tabindex=-1) */
  function jumpToItem(itemId) {
    var it = CL.itemById[itemId];
    if (!it) return;
    toggleSection(it.sectionId, true);
    var ref = view.refs.items && view.refs.items[itemId];
    if (!ref) return;
    ref.fold(false);
    ref.el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setTimeout(function () { try { ref.el.focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }, 350);
    // 1.5.0 검토 반영: 터치 뒤의 프로그램 초점은 :focus-visible 테두리가 안 그려지므로 1.5초 동안 배경을 밝혀 어디로 왔는지 보여 준다(CSS .is-target)
    ref.el.classList.remove('is-target');
    void ref.el.offsetWidth; // 같은 항목으로 다시 오면 애니메이션을 처음부터
    ref.el.classList.add('is-target');
    clearTimeout(ref.targetTimer);
    ref.targetTimer = setTimeout(function () { ref.el.classList.remove('is-target'); }, 1600);
  }

  /**
   * 1.5.0 검토 반영: 등기부 멈춤 신호에 답한 그 자리(접힌 줄 바로 아래)에 "멈춤 신호 N개 남음 · [다음 멈춤 신호로]" 한 줄.
   * 미니 진행 줄의 버튼은 섹션 맨 위라 둘째 멈춤 신호부터는 500~1,000px 위에 있었음. 한 줄은 늘 하나뿐(마지막에 답한 항목 아래),
   * 멈춤 신호를 모두 답했거나 답을 지웠으면 없앤다. 누르면 줄을 없애고 다음 미답 멈춤 신호로(jumpToItem)
   */
  function updateNextStopRow(prop, it, el) {
    var r = view.refs;
    if (r.nextRow) { r.nextRow.remove(); r.nextRow = null; }
    var st = getItemState(prop, it.id).status;
    if (st !== 'yes' && st !== 'no') return;
    var gs = gateStopState(prop);
    var next = gs.unanswered ? nextStopItem(prop) : null;
    if (!next) return;
    var row = h('div', { class: 'next-stop-row' },
      h('span', { class: 'next-stop-text', text: '멈춤 신호 ' + gs.unanswered + '개 남음' }),
      h('button', {
        type: 'button', class: 'btn btn-small btn-accent',
        onclick: function () { row.remove(); if (r.nextRow === row) r.nextRow = null; jumpToItem(next.id); }
      }, '다음 멈춤 신호로'));
    el.after(row);
    r.nextRow = row;
  }

  /** 1.5.0: 등기부 멈춤 신호 가운데 아직 답하지 않은 첫 항목. 없으면 null */
  function nextStopItem(prop) {
    var found = null;
    gateSections().forEach(function (s) {
      s.items.forEach(function (it) {
        if (found || it.type !== 'flag' || it.severity !== 'stop') return;
        var st = getItemState(prop, it.id).status;
        if (st !== 'yes' && st !== 'no') found = it;
      });
    });
    return found;
  }

  /**
   * 1.5.0: 섹션 본문 맨 위의 미니 진행 줄. 등기부(gate)는 "멈춤 신호 N개 중 M개 답함"(N = gateStopState total, 2026-10c 데이터는 8) + [다음 멈춤 신호로],
   * 다른 섹션은 "N/M 답함". 답이 바뀌면 refreshMini 가 다시 쓴다(전에는 등기부 섹션 안에 진행 표시가 없었음)
   */
  function miniProgress(prop, sec) {
    var text = h('span', { class: 'mini-prog-text' });
    var btn = sec.gate ? h('button', {
      type: 'button', class: 'btn btn-small btn-accent',
      onclick: function () { var it = nextStopItem(prop); if (it) jumpToItem(it.id); }
    }, '다음 멈춤 신호로') : null;
    var el = h('div', { class: 'mini-prog' + (sec.gate ? ' mini-prog-gate' : '') }, text, btn);
    if (!view.refs.minis) view.refs.minis = {};
    view.refs.minis[sec.id] = { el: el, text: text, btn: btn, sec: sec };
    refreshMini(prop);
    return el;
  }
  function refreshMini(prop) {
    if (view.prop !== prop || !view.refs.minis) return;
    var gs = null;
    Object.keys(view.refs.minis).forEach(function (sid) {
      var m = view.refs.minis[sid];
      if (m.sec.gate && gateStopState(prop).total) {
        gs = gs || gateStopState(prop);
        var answered = gs.total - gs.unanswered;
        m.text.textContent = gs.unanswered
          ? '멈춤 신호 ' + gs.total + '개 중 ' + answered + '개 답함'
          : '멈춤 신호 ' + gs.total + '개 모두 답함' + (gs.yes ? ' · 있음 ' + gs.yes + '개' : '');
        m.el.classList.toggle('is-complete', gs.unanswered === 0);
        if (m.btn) m.btn.hidden = gs.unanswered === 0;
      } else {
        var p = sectionProgress(prop, m.sec);
        m.text.textContent = p.done + '/' + p.total + ' 답함';
        m.el.classList.toggle('is-complete', p.total > 0 && p.done === p.total);
        if (m.btn) m.btn.hidden = true;
      }
    });
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
        h('strong', {}, icon('alert', 'ic-sm'), stopWordEl(prop, 'span', null, 'line', true)),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-small btn-danger drop-btn', onclick: function () { dropProperty(prop); } }, '탈락 처리'),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { jumpToSection(gates[0].id); } }, '등기부 다시 보기'))
      );
      view.refs.hints.push({ hint: hint, text: hintText, stop: stopLine });
      body.append(stopLine, hint);
      refreshHints(prop);
    }
    if (sec.gate) body.append(docsCard(prop)); // 1.6.0: 등기부 섹션 맨 위 서류함(등기부 PDF·건축물대장·계약서)
    body.append(miniProgress(prop, sec)); // 1.5.0: 미니 진행(등기부는 멈춤 신호 기준 + [다음 멈춤 신호로])
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

  /**
   * 1.4.5: 멈춤 신호 문구 묶음 [등기부 단계, 늦은 단계]. 항목 태그·"있음" 바로 아래 안내·다른 섹션 맨 위 줄이
   * 상단 경고와 같은 기준(lateNow)으로 고른다. 전에는 "임장 완료"인 매물에서도 "임장할 필요가 없어요"가 보였음
   */
  var STOP_WORDS = {
    tag: ['멈춤 신호 · 있으면 임장 불필요', '멈춤 신호 · 있으면 돈 보내지 않기'],
    inline: ['멈춤 신호예요. 이 집은 임장할 필요가 없어요.', '멈춤 신호예요. 가계약금·잔금을 보내지 말고 멈추세요.'],
    line: ['멈춤 신호가 있어 이 집은 임장할 필요가 없어요', '멈춤 신호가 있어요. 가계약금·잔금을 보내지 말고 멈추세요']
  };
  /** 멈춤 신호 문구 요소. gate: 등기부 섹션 것인지(계약 단계 항목은 늘 늦은 단계 문구). 상태·답이 바뀌면 refreshStopWords 가 다시 쓴다 */
  function stopWordEl(prop, tag, cls, kind, gate) {
    var el = h(tag, { class: cls, text: STOP_WORDS[kind][lateNow(prop) || !gate ? 1 : 0] });
    view.refs.stopWords.push({ el: el, kind: kind, gate: gate });
    return el;
  }
  function refreshStopWords(prop) {
    if (view.prop !== prop) return;
    var late = lateNow(prop);
    view.refs.stopWords.forEach(function (r) { r.el.textContent = STOP_WORDS[r.kind][late || !r.gate ? 1 : 0]; });
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
    var ref = view.refs.items && view.refs.items[it.id];
    if (ref) ref.sync(); // 1.5.0: applyItemClasses 가 className 을 통째로 다시 쓰므로 접힘·도구 줄 클래스를 다시 붙인다
    refreshProgress(prop);
    refreshMini(prop); // 1.5.0
    // 1.5.0(L2): 마지막 멈춤 신호를 "없음"으로 답한 그 순간에만 토스트([임장 예정으로]). 제안 줄(refreshFlowHint)은 화면 위라 답한 자리에서 안 보임.
    // 상태를 되돌려 제안 줄이 다시 생길 때는 토스트하지 않는다(afterStatusChange 가 "상태: …" 토스트를 띄움)
    var hintWas = !!(view.refs.flowHint && view.refs.flowHint.firstChild);
    if (it.type === 'flag') { renderAlerts(prop); refreshStopWords(prop); }
    if (sec.gate && it.type === 'flag' && !hintWas && view.refs.flowHint && view.refs.flowHint.firstChild) {
      toast('멈춤 신호 없음 · 이제 보러 가도 돼요', { duration: 5000, action: { label: '임장 예정으로', fn: function () { applyStatus(prop, 'planned'); } } });
    }
    if (sec.gate) refreshHints(prop);
    if (sec.gate && it.type === 'flag' && it.severity === 'stop') updateNextStopRow(prop, it, el); // 1.5.0 검토 반영: 답한 자리 아래 [다음 멈춤 신호로]
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

  /** 항목 메모 칸. onInput(선택, 1.5.0): 메모가 바뀔 때마다 부르는 콜백(항목 요약 줄의 "메모 있음" 표시용) */
  function memoField(prop, it, placeholder, onInput) {
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
      if (onInput) onInput();
    });
    return { btn: btn, wrap: wrap, open: function () { setOpen(true, false); } };
  }

  /** 재방문 기록 표시: 다녀옴 / 예정 / 체크 안 함 */
  function visitLabel(st) {
    if (st.done) return '다녀옴';
    if (st.date && st.date > todayISO()) return '예정';
    return st.date ? '날짜만 적음(체크 안 함)' : '메모만 있음';
  }

  /** 1.5.0: 접힌 항목 요약 줄의 답 표시 [글자, 종류]. 답하지 않았으면 null */
  function answerLabel(it, st) {
    if (it.type === 'rate') return st.status === 'good' ? ['양호', 'good'] : st.status === 'caution' ? ['주의', 'caution'] : null;
    if (it.type === 'flag') return st.status === 'yes' ? ['있음', it.severity === 'stop' ? 'stop' : 'yes'] : st.status === 'no' ? ['없음', 'no'] : null;
    if (it.type === 'ask') return (st.answer && st.answer.trim()) || st.done ? ['답변 있음', 'ask'] : null;
    if (it.type === 'visit') return st.done ? ['다녀옴', 'done'] : null;
    return st.done ? ['완료', 'done'] : null;
  }

  /** 1.5.0: 길게 누르기(550ms, 8px 안 움직임). 버튼·입력 칸 위에서 시작한 누름은 무시 */
  function onLongPress(el, fn) {
    var timer = 0;
    var sx = 0;
    var sy = 0;
    function clear() { if (timer) { clearTimeout(timer); timer = 0; } }
    el.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button, a, input, textarea, select, label')) return;
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(function () { timer = 0; fn(); }, 550);
    });
    el.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) clear();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { el.addEventListener(t, clear); });
  }

  /**
   * 항목 하나. 1.5.0(M6)에서 바뀐 것:
   * - 메모·사진 도구 줄은 답한 뒤(또는 메모·사진이 이미 있을 때, 머리 줄의 [메모·사진] 버튼, 항목 길게 누르기)에만 보인다(.tools-off)
   * - 팁은 (?) 쉬운 설명 안에 들어간다(help 가 없고 tip 만 있어도 (?) 가 생김)
   * - 답한 항목은 한 줄 요약(문장 + 답 + 메모·사진 표시)으로 접고 누르면 펼친다(.is-folded). 멈춤 신호 "있음"은 접지 않는다
   *   답하는 순간 접는 것은 깔끔한 답(없음·양호·check 완료)뿐이고, 주의·있음·답변·재방문은 메모를 이어 쓰도록 펼쳐 둔다
   * 상태 클래스는 applyItemClasses 가 className 을 통째로 다시 쓰므로, 접힘·도구 줄 클래스는 sync() 가 늘 다시 붙인다(afterItemChange 가 부름)
   */
  function itemEl(prop, sec, it) {
    var st = getItemState(prop, it.id);
    var el = h('div', { id: 'item-' + domId(it.id), tabindex: '-1' });
    var helpId = 'help-' + domId(it.id);
    var textId = 'itxt-' + domId(it.id);
    var bodyId = 'item-body-' + domId(it.id);
    var dateInput = null;
    var cb = null;
    var folded = false;   // 한 줄 요약으로 접힘
    var revealed = false; // 답하기 전에 [메모·사진]을 눌러 도구 줄을 연 상태

    // (?) 쉬운 설명 — 1.5.0: 팁도 이 안에(전에는 항상 펼쳐져 있었음)
    var helpPanel = (it.help || it.tip) ? h('div', { class: 'item-help', id: helpId, hidden: true },
      it.help ? h('span', { text: it.help }) : null,
      it.tip ? h('span', { class: 'tip' }, h('b', { text: '팁 ' }), it.tip) : null) : null;
    var helpBtn = helpPanel ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': '쉬운 설명: ' + it.text, 'aria-expanded': 'false', 'aria-controls': helpId }, icon('help')) : null;
    if (helpBtn) {
      helpBtn.addEventListener('click', function () {
        var open = helpPanel.hidden;
        helpPanel.hidden = !open;
        helpBtn.setAttribute('aria-expanded', String(open));
      });
    }
    // 1.5.0: 답하기 전에 메모·사진을 남기고 싶을 때(머리 줄 작은 버튼). 도구 줄이 숨어 있을 때만 보임(CSS .tools-off)
    var moreBtn = h('button', { type: 'button', class: 'icon-btn item-more', 'aria-label': '메모·사진 열기: ' + it.text }, icon('note'));
    // 1.5.0: 펼친 답한 항목을 다시 접는 버튼. 답했고 접히지 않았을 때만 보임(CSS)
    var collapseBtn = h('button', { type: 'button', class: 'icon-btn item-collapse', 'aria-label': '접기: ' + it.text }, icon('chevron'));

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
        if (done && it.type === 'check') setFold(true, true); // 재방문은 메모를 이어 쓰도록 펼쳐 둔다
      });
      head = h('div', { class: 'item-head' }, cb, helpBtn, moreBtn, collapseBtn);
    } else {
      // flag·rate 의 [메모·사진 열기]는 머리 줄이 아니라 [있음][없음] 줄 끝에 둔다(머리 줄에 버튼이 둘이면 문장이 더 많이 줄바꿈돼 오히려 길어짐)
      head = h('div', { class: 'item-head' }, h('p', { class: 'item-text', id: textId, text: it.text }), helpBtn,
        it.type === 'flag' || it.type === 'rate' ? null : moreBtn, collapseBtn);
    }

    var tags = it.type === 'flag'
      ? h('div', { class: 'item-tags' }, it.severity === 'stop'
        ? stopWordEl(prop, 'span', 'sev sev-stop', 'tag', sec.gate)
        : h('span', { class: 'sev sev-caution', text: '주의 신호 · 있으면 조심해서 진행' }))
      : null;

    var controls = null;
    var extra = null;
    var memo = null;
    var stopInline = null;
    var linkEl = null; // 1.5.0(C11): flag "있음"일 때 보이는 [등기부 섹션 열기](data.js linkTo)

    // 1.4.5: data.js 항목에 memoHint 가 있으면 메모 칸 자리표시로 쓴다(없으면 종류별 기본 문구)
    var hint = it.memoHint;
    if (it.type === 'rate') {
      memo = memoField(prop, it, hint || (sec.cautionUse === 'reference' ? '어떤 점이 아쉬운지 적어 두면 가격을 판단할 때 써요' : '어떤 점이 아쉬운지 적어 두면 협상·특약 때 써요'), sync);
      controls = segment([{ v: 'good', label: '양호' }, { v: 'caution', label: '주의' }], st.status, function (val) {
        setItemState(prop, it.id, { status: val });
        if (val === 'caution') memo.open();
        afterItemChange(prop, sec, it, el);
        if (val === 'good') setFold(true, true);
      }, textId);
    } else if (it.type === 'flag') {
      memo = memoField(prop, it, hint || '예: 채권최고액, 접수 날짜, 권리자', sync);
      controls = segment([{ v: 'yes', label: '있음' }, { v: 'no', label: '없음' }], st.status, function (val) {
        setItemState(prop, it.id, { status: val });
        afterItemChange(prop, sec, it, el);
        if (val === 'no') setFold(true, true);
      }, textId);
      if (it.severity === 'stop') {
        // '있음'을 누른 바로 그 자리에서 결과와 [탈락 처리]를 보여 준다(위쪽 배너는 화면 밖일 수 있음). 문구는 상단 경고와 같은 기준
        stopInline = h('div', { class: 'stop-inline', role: 'note' },
          stopWordEl(prop, 'p', null, 'inline', sec.gate),
          h('button', { type: 'button', class: 'btn btn-small btn-danger drop-btn', onclick: function () { dropProperty(prop); } }, '탈락 처리'));
      }
      // 1.5.0(C11): data.js linkTo 가 있는 flag(계약 단계의 "다시 뗀 등기부에 달라진 기록이 있다" 셋)를 "있음"으로 표시하면
      // 그 자리에 [등기부 섹션 열기] — 달라진 등기부 항목도 "있음"으로 바꾸러 가게(전에는 help 글로만 "맨 위 섹션도 고치세요"). sync 가 보이고 숨김
      if (it.linkTo && CL.sectionById[it.linkTo]) {
        var linkSec = CL.sectionById[it.linkTo];
        linkEl = h('div', { class: 'item-link', hidden: true },
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { jumpToSection(it.linkTo); } },
            (linkSec.gate ? '등기부' : linkSec.title) + ' 섹션 열기'));
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
      var vmemo = h('textarea', { class: 'input', id: vmId, rows: rowsFor(st.memo), placeholder: hint || '예: 밤 10시, 위층 발소리 거의 없음', value: st.memo || '', 'aria-describedby': textId });
      vmemo.addEventListener('input', function () { setItemState(prop, it.id, { memo: vmemo.value }); sync(); });
      extra = h('div', { class: 'visit-fields' },
        h('div', {}, h('label', { class: 'inline-label', for: dId, text: '다녀온 날짜 (갈 날을 미리 적어도 돼요)' }), dateInput),
        h('div', {}, h('label', { class: 'inline-label', for: vmId, text: '메모' }), vmemo)
      );
    } else {
      memo = memoField(prop, it, hint || '메모', sync);
    }

    var tools = h('div', { class: 'item-tools' }, memo ? memo.btn : null, photoAddButton(prop, { itemId: it.id }, it.text));
    if (it.type === 'flag' || it.type === 'rate') controls = h('div', { class: 'item-ctl' }, controls, moreBtn);
    // 1.5.0: 본문을 한 상자에 담아 접힘(.is-folded)과 요약 줄의 aria-controls 대상으로 쓴다
    var body = h('div', { class: 'item-body', id: bodyId },
      head, tags, helpPanel, controls, stopInline, linkEl, extra, memo ? memo.wrap : null, tools, photoStrip('i:' + it.id, it.text));

    // 1.5.0: 접힌 항목의 한 줄 요약(누르면 펼침). 사진 표시는 사진 줄이 보일 때 CSS(:has)가 켠다
    var foldAns = h('span', { class: 'fold-ans' });
    // 검토 반영: data.js 에 shortTitle 이 있으면(등기부 flag 13개) 접힌 줄에는 그 짧은 이름 — 같은 머리말("갑구에 말소되지 않은…")의
    // 멈춤 신호 5개가 한 줄로 접히면 글자가 똑같아 구별되지 않았음(390px 에서 "갑구에 말소되지 않은(빨간 줄이 없…")
    var foldBtn = h('button', { type: 'button', class: 'item-fold', 'aria-expanded': 'false', 'aria-controls': bodyId },
      h('span', { class: 'fold-text', text: it.shortTitle || it.text }),
      foldAns,
      h('span', { class: 'fold-memo' }, icon('note', 'ic-sm'), h('span', { class: 'sr-only', text: '메모 있음' })),
      h('span', { class: 'fold-photo' }, icon('camera', 'ic-sm'), h('span', { class: 'sr-only', text: '사진 있음' })),
      icon('chevron', 'ic-sm ic-chev'));
    foldBtn.addEventListener('click', function () { setFold(false, true); });
    collapseBtn.addEventListener('click', function () { setFold(true, true); });

    function reveal() {
      if (revealed) return;
      revealed = true;
      sync();
      if (memo) memo.open();
    }
    moreBtn.addEventListener('click', reveal);
    onLongPress(el, reveal);

    /** 접힘·도구 줄·메모 표시 클래스를 지금 상태에 맞춘다. 답을 지웠거나 멈춤 신호 "있음"이면 접지 않는다 */
    function sync() {
      var cur = getItemState(prop, it.id);
      var done = isItemDone(it, cur);
      var stopYes = it.type === 'flag' && it.severity === 'stop' && cur.status === 'yes';
      var hasMemo = !!(cur.memo && cur.memo.trim());
      if (!done || stopYes) folded = false;
      el.classList.toggle('is-folded', folded);
      el.classList.toggle('has-memo', hasMemo);
      el.classList.toggle('tools-off', !(done || hasMemo || revealed));
      if (linkEl) linkEl.hidden = cur.status !== 'yes'; // 1.5.0(C11)
      foldBtn.setAttribute('aria-expanded', String(!folded));
      var a = answerLabel(it, cur);
      foldAns.textContent = a ? a[0] : '';
      foldAns.className = 'fold-ans' + (a ? ' fold-ans-' + a[1] : '');
    }
    /** 접거나 펼친다. focus: 접으면 요약 줄, 펼치면 [접기] 버튼으로 초점을 옮긴다(키보드·VoiceOver 가 자리를 잃지 않게) */
    function setFold(on, focus) {
      var wasInside = el.contains(document.activeElement);
      folded = !!on;
      sync();
      if (!focus || !wasInside) return;
      try { (folded ? foldBtn : collapseBtn).focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }

    el.append(foldBtn, body);
    applyItemClasses(el, it, st);
    folded = isItemDone(it, st); // 처음 그릴 때 이미 답한 항목은 접어서 보여 준다(멈춤 "있음"은 sync 가 펼침)
    sync();
    if (!view.refs.items) view.refs.items = {};
    view.refs.items[it.id] = { el: el, sync: sync, fold: function (on) { setFold(on, false); } };
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
            notePhotoChange(prop.id, 1);
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
      if (!dbBlockedErr(err)) console.warn('사진 불러오기 실패', err); // 다른 탭을 기다리는 중이면 안내 띠가 알린다
      v.photos = {};
    });
    return v.photosReady;
  }

  // ---- 1.6.0 서류함 UI (매물 상세 · 등기부 섹션 맨 위 "서류" 카드) ----
  // 올리기(PDF·사진 여러 개) → 목록(종류 칩·이름·크기·올린 날, 등기부는 열람 일시) → 보기(새 창) · 종류 바꾸기 · 지우기.
  // 해석 화면(등기부 PDF 읽기)은 통합 단계에서 이 카드에 붙인다
  var docUrls = {}; // 서류 보기 임시 주소(object URL). 화면을 옮기면 해제
  function docUrl(rec) {
    if (!docUrls[rec.id]) docUrls[rec.id] = URL.createObjectURL(rec.blob);
    return docUrls[rec.id];
  }
  function revokeDocUrl(id) {
    if (docUrls[id]) { URL.revokeObjectURL(docUrls[id]); delete docUrls[id]; }
  }
  function revokeAllDocUrls() { Object.keys(docUrls).forEach(revokeDocUrl); }

  /** 올린 파일의 형식: PDF 나 사진만(파일 앱에서 고르면 type 이 비어 있을 수 있어 확장자도 본다). 아니면 '' */
  var DOC_EXT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif' };
  function docMime(file) {
    var t = str(file.type).toLowerCase();
    if (DOC_MIME_RE.test(t)) return t;
    var m = /\.([a-z0-9]+)$/i.exec(str(file.name));
    return m && DOC_EXT_MIME[m[1].toLowerCase()] ? DOC_EXT_MIME[m[1].toLowerCase()] : '';
  }
  /** 서류 이름: 제어 문자 빼고 앞뒤 공백 정리, DOC_NAME_MAX 글자. 비면 형식에 맞는 기본 이름 */
  function cleanDocName(name, mime) {
    var s = str(name).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.normalize) s = s.normalize('NFC'); // macOS·iOS 파일 이름은 한글이 풀려(NFD) 올 수 있다
    return s.slice(0, DOC_NAME_MAX) || (mime === 'application/pdf' ? '서류.pdf' : '사진');
  }
  /** 파일 이름으로 종류 짐작(등기부 섹션에서 올리므로 PDF 는 기본 등기부). 목록에서 바꿀 수 있다 */
  function guessDocKind(name, mime) {
    var s = str(name);
    if (s.normalize) s = s.normalize('NFC'); // "건축물대장"이 풀린 글자(NFD)로 오면 맞지 않으므로
    if (/건축물|대장/.test(s)) return 'building';
    if (/계약/.test(s)) return 'contract';
    if (/등기/.test(s) || mime === 'application/pdf') return 'registry';
    return 'other';
  }
  function shortDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
  }
  /** 서류 저장소 오류를 사람 말로 */
  function docErrText(err) {
    if (dbBlockedErr(err)) return '다른 탭(창)에 예전 버전 앱이 열려 있어 서류를 쓸 수 없어요. 그 탭을 닫거나 새로고침해 주세요.';
    if (err && err.name === 'NotFoundError') return '서류함을 준비하지 못했어요. 이 앱의 탭(창)을 모두 닫았다가 다시 열어 주세요.';
    if (err && err.name === 'QuotaExceededError') return '저장 공간이 부족해 서류를 저장하지 못했어요. 필요 없는 사진·서류를 지워 주세요.';
    if (document.documentElement.classList.contains('no-photos')) return '이 환경에서는 서류를 저장할 수 없어요. HTTPS 주소(또는 홈 화면 앱)로 열면 서류를 올릴 수 있어요.';
    return '서류를 저장하거나 읽지 못했어요. 다시 해 보세요.';
  }

  /** 등기부 섹션 맨 위 "서류" 카드 */
  function docsCard(prop) {
    var v = view;
    var countEl = h('span', { class: 'count' });
    var list = h('ul', { class: 'doc-list', 'aria-label': '이 매물의 서류' });
    var empty = h('p', { class: 'small muted doc-empty', text: '서류를 불러오는 중…' });
    var off = h('p', { class: 'notice doc-off', role: 'note', hidden: true });
    var input = h('input', { type: 'file', accept: 'application/pdf,image/*', multiple: true, class: 'file-input', 'aria-label': '서류 올리기 (PDF·사진, 여러 개)' });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (files.length) uploadDocs(prop, files); // 1.6.0 통합: 등기부 PDF 는 읽어서 미리보기, 그 밖은 서류로만(addDocs)
    });
    // 1.6.0 통합: 사진 서류가 있으면 "사진은 앱이 읽지 못해요 — Claude 로 등기부 코드" 안내(renderDocList 가 보이고 숨김)
    var photoTip = registryPhotoTip(false);
    photoTip.hidden = true;
    var card = h('section', { class: 'doc-card', 'aria-labelledby': 'docs-title' },
      h('div', { class: 'doc-head' },
        h('h3', { class: 'doc-title', id: 'docs-title' }, '서류', countEl),
        h('label', { class: 'btn btn-small btn-secondary doc-add' }, icon('plus', 'ic-sm'), h('span', { text: '서류 올리기' }), input)),
      h('p', { class: 'small muted doc-desc', text: '인터넷등기소에서 "말소사항 포함"으로 열람한 등기부 PDF를 올리면 앱이 읽어 아래 항목의 답을 채워 줘요(답하기 전에 미리보기로 확인). 건축물대장·계약서 사진도 여기에 모아 둬요. 서류는 이 기기에만 저장돼요(다른 기기로는 백업할 때 "사진·서류도 함께 넣기").' }),
      off, photoTip, list, empty);
    v.refs.docs = { prop: prop, card: card, list: list, empty: empty, off: off, countEl: countEl, recs: [], photoTip: photoTip };
    loadDocs(v);
    return card;
  }

  /** 서류 목록을 다시 읽어 그린다 */
  function loadDocs(v) {
    var r = v.refs.docs;
    if (!r) return Promise.resolve();
    return IDB.hasDocs().then(function (has) {
      if (!has) { // 업그레이드가 안 된 DB(더 새 앱이 버전을 올렸거나 업그레이드 실패): 읽기는 빈 값이라 따로 알린다
        var nf = new Error('서류 저장소 없음');
        nf.name = 'NotFoundError';
        throw nf;
      }
      return Docs.list(r.prop.id);
    }).then(function (recs) {
      if (view !== v) return;
      r.off.hidden = true;
      r.card.classList.remove('is-off');
      renderDocList(v, recs);
    }, function (err) {
      if (view !== v) return;
      if (!dbBlockedErr(err) && err.name !== 'NotFoundError') console.warn('서류 불러오기 실패', err);
      r.empty.hidden = true;
      r.off.hidden = false;
      r.off.textContent = docErrText(err);
      r.card.classList.add('is-off'); // [서류 올리기] 숨김(풀리면 화면을 다시 그림)
    });
  }

  function renderDocList(v, recs) {
    var r = v.refs.docs;
    // 목록에서 빠진 서류의 임시 주소는 해제
    var keep = {};
    recs.forEach(function (rec) { keep[rec.id] = true; });
    r.recs.forEach(function (old) { if (!keep[old.id]) revokeDocUrl(old.id); });
    r.recs = recs;
    r.list.textContent = '';
    r.countEl.textContent = recs.length ? ' ' + recs.length + '개' : '';
    r.empty.hidden = !!recs.length;
    r.empty.textContent = '아직 올린 서류가 없어요. 인터넷등기소에서 열람한 등기부를 PDF로 저장해 올려 두세요.';
    // 1.6.0 통합: 등기부(또는 기타)로 올린 사진이 있으면 Claude 로 읽는 길을 알려 준다(앱은 사진 글자를 읽지 못함)
    if (r.photoTip) {
      r.photoTip.hidden = !recs.some(function (rec) {
        return /^image\//.test(str(rec.mime)) && (rec.kind === 'registry' || rec.kind === 'other');
      });
    }
    // 최근에 올린 것부터
    recs.slice().reverse().forEach(function (rec) { r.list.append(docRow(v, rec)); });
  }

  function docRow(v, rec) {
    var prop = v.refs.docs.prop;
    var kind = DOC_KIND_LABEL[rec.kind] ? rec.kind : 'other';
    var nameId = 'doc-n-' + domId(rec.id);
    var meta = [];
    if (kind === 'registry') {
      var snap = snapshotForDoc(prop, rec.id);
      // 1.6.0 통합: 열람용 "열람 2026.01.02 09:00", 제출용 "2026.01.02 발행"(발행일만 적혀 있음)
      meta.push(snap && snap.viewedAt ? (snap.docType === '제출용' ? regViewedText(snap.viewedAt, snap.docType) : '열람 ' + regWhen(snap.viewedAt)) : '열람 일시 미확인');
    }
    meta.push(bytesText(rec.size || (rec.blob ? rec.blob.size : 0)), '올린 날 ' + shortDate(rec.addedAt));
    // 보기: 새 창(탭)에서 연다. iOS Safari 는 PDF 를 미리보기로 보여 준다. 홈 화면 앱(standalone)은 새 창이 Blob 주소를 못 열어 앱 안에서 보여 준다
    var viewBtn = rec.blob
      ? h('a', { class: 'btn btn-small btn-secondary doc-view', href: docUrl(rec), target: '_blank', rel: 'noopener', 'aria-describedby': nameId },
        '보기', h('span', { class: 'sr-only', text: '(새 창)' }))
      : h('span', { class: 'small muted', text: '파일을 읽지 못했어요' });
    if (rec.blob && isStandalone()) {
      viewBtn.addEventListener('click', function (e) { e.preventDefault(); openDocViewer(rec); });
    }
    var sel = h('select', { class: 'select doc-kind', 'aria-label': '종류 바꾸기: ' + rec.name },
      DOC_KINDS.map(function (k) { return h('option', { value: k.id, text: k.label }); }));
    sel.value = kind;
    sel.addEventListener('change', function () { changeDocKind(v, rec, sel); });
    var del = h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost doc-del', 'aria-describedby': nameId }, icon('trash', 'ic-sm'), '지우기');
    del.addEventListener('click', function () { removeDoc(v, rec); });
    // 1.6.0 통합: 등기부 PDF 는 [읽기]로 다시 해석할 수 있다([서류만 저장]으로 올렸거나, 해석 기록을 지웠을 때)
    var readBtn = kind === 'registry' && rec.blob && rec.mime === 'application/pdf'
      ? h('button', { type: 'button', class: 'btn btn-small btn-accent doc-read', 'aria-describedby': nameId, onclick: function () { readSavedRegistryDoc(prop, rec); } }, '읽기')
      : null;
    return h('li', { class: 'doc-row' },
      h('div', { class: 'doc-main' },
        h('span', { class: 'doc-chip doc-chip-' + kind, text: DOC_KIND_LABEL[kind] }),
        h('span', { class: 'doc-name', id: nameId, text: rec.name })),
      h('p', { class: 'doc-meta', text: meta.join(' · ') }),
      h('div', { class: 'doc-actions' }, viewBtn, readBtn, sel, del));
  }

  /** 서류 올리기: 하나씩 차례로 저장(메모리에 한꺼번에 올리지 않음). PDF·사진만, 하나에 DOC_MAX_BYTES 까지 */
  function addDocs(prop, files) {
    var v = view;
    var total = files.length;
    var ok = 0;
    var bad = 0;   // 형식이 아님
    var big = 0;   // 너무 큼
    var failed = []; // 저장 실패(다시 시도용 원본)
    var lastErr = null;
    function progress(i) { toast(total > 1 ? '서류 저장 중 ' + i + '/' + total + '…' : '서류 저장 중…', { duration: 0 }); }
    var chain = Promise.resolve();
    files.forEach(function (file, i) {
      chain = chain.then(function () {
        progress(i + 1);
        var mime = docMime(file);
        if (!mime) { bad++; return; }
        if (file.size > DOC_MAX_BYTES) { big++; return; }
        // 파일 앱에서 고른 File 을 그대로 넣지 않고 내용을 읽어 새 Blob 으로 저장한다(원본 파일 참조가 나중에 끊기지 않게)
        return blobToArrayBuffer(file).then(function (buf) {
          var rec = {
            id: uid(), propertyId: prop.id, kind: guessDocKind(file.name, mime), name: cleanDocName(file.name, mime),
            mime: mime, size: buf.byteLength, addedAt: Date.now(), blob: new Blob([buf], { type: mime })
          };
          return Docs.put(rec).then(function () { ok++; });
        }).catch(function (err) {
          lastErr = err;
          if (!dbBlockedErr(err)) console.warn('서류 저장 실패', err);
          failed.push(file);
        });
      });
    });
    return chain.then(function () {
      if (ok) touch(prop); // 사진처럼 매물을 고친 것으로(최근에 고친 순)
      if (view === v) loadDocs(v);
      var parts = [];
      if (ok) parts.push('서류 ' + ok + '개를 올렸어요.');
      if (bad) parts.push(bad + '개는 PDF·사진이 아니라 넣지 않았어요.');
      if (big) parts.push(big + '개는 ' + bytesText(DOC_MAX_BYTES) + '보다 커서 넣지 않았어요.');
      if (failed.length) {
        parts.push(failed.length + '개를 저장하지 못했어요. ' + docErrText(lastErr));
        toast(parts.join(' '), { duration: 30000, action: { label: '다시 시도', fn: function () { addDocs(prop, failed); } } });
      } else {
        toast(parts.join(' ') || '올린 서류가 없어요', { duration: bad || big ? 6000 : 2800 });
      }
    });
  }

  function changeDocKind(v, rec, sel) {
    var next = sel.value;
    var prev = rec.kind;
    if (next === prev || !DOC_KIND_LABEL[next]) return;
    var upd = Object.assign({}, rec, { kind: next });
    Docs.put(upd).then(function () {
      rec.kind = next;
      if (view === v) loadDocs(v);
      toast('종류를 바꿨어요: ' + DOC_KIND_LABEL[next]);
    }, function (err) {
      if (!dbBlockedErr(err)) console.warn('서류 종류 바꾸기 실패', err);
      sel.value = DOC_KIND_LABEL[prev] ? prev : 'other';
      toast(docErrText(err), { duration: 5000 });
    });
  }

  function removeDoc(v, rec) {
    var prop = v.refs.docs.prop;
    var snap = snapshotForDoc(prop, rec.id);
    confirmDialog({
      title: '이 서류를 지울까요?',
      message: rec.name + '\n\n지운 서류는 되돌릴 수 없어요.' + (snap ? ' 이 서류로 남긴 등기부 해석 기록은 그대로 남아요.' : ''),
      confirmText: '지우기', danger: true
    }).then(function (ok) {
      if (!ok) return;
      return Docs.remove(rec.id).then(function () {
        revokeDocUrl(rec.id);
        if (view === v) loadDocs(v);
        toast('서류를 지웠어요');
      });
    }).catch(function (err) {
      if (!dbBlockedErr(err)) console.warn('서류 지우기 실패', err);
      toast(docErrText(err), { duration: 5000 });
    });
  }

  /**
   * 홈 화면 앱(standalone)에서 서류 보기: 새 창은 Safari 로 열려 앱의 Blob 주소를 읽지 못하므로 앱 안에서 보여 준다.
   * PDF 는 iframe(iOS 가 그려 줌), 사진은 img. [다른 앱으로 보내기]는 공유 시트(파일에 저장·다른 앱에서 열기)
   */
  function openDocViewer(rec) {
    if (closeLightbox) closeLightbox();
    var prevFocus = document.activeElement;
    var url = docUrl(rec);
    var closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '서류 닫기' }, icon('close'));
    var isPdf = rec.mime === 'application/pdf';
    var body = isPdf
      ? h('iframe', { class: 'docv-frame', src: url, title: rec.name })
      : h('img', { src: url, alt: rec.name });
    var shareBtn = null;
    try {
      var f = new File([rec.blob], rec.name, { type: rec.mime });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        shareBtn = h('button', { type: 'button', class: 'btn btn-small btn-on-dark' }, icon('share', 'ic-sm'), '다른 앱으로 보내기');
        shareBtn.addEventListener('click', function () {
          navigator.share({ files: [f], title: rec.name }).catch(function (err) { if (!err || err.name !== 'AbortError') toast('보내지 못했어요'); });
        });
      }
    } catch (e) { shareBtn = null; }
    var lb = h('div', { class: 'lightbox docv', role: 'dialog', 'aria-modal': 'true', 'aria-label': '서류 보기: ' + rec.name },
      h('div', { class: 'lb-bar' }, closeBtn, h('p', { class: 'lb-caption', text: rec.name }), h('span', { style: 'width:44px;flex:none', 'aria-hidden': 'true' })),
      h('div', { class: 'lb-img docv-body' }, body),
      shareBtn ? h('div', { class: 'lb-foot' }, shareBtn) : null);
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
    document.addEventListener('keydown', onKey, true);
    $('#overlay-root').append(lb);
    closeLightbox = close; // 사진 크게 보기와 같은 자리(화면을 옮기면 닫힘, 다른 탭 동기화가 기다림)
    setTimeout(function () { closeBtn.focus(); }, 30);
  }

  // =====================================================
  // 1.6.0 통합: 등기부 PDF 읽기 → 미리보기 → 답하기, 재열람 비교, 등기부 기록 보기
  //   [서류 올리기]에서 PDF 를 고르면 pdf.js 로 쪽별 글자를 꺼내 ImjangRegistry.parsePdf(extractRows → parseRegistry)로 읽고,
  //   미리보기(registryPreview)에서 [이대로 답하기] → 서류 저장(kind 'registry') + 해석 기록(snapshot) + 항목 답(applyRegistrySnapshot).
  //   가져오기 화면의 등기부 코드(Claude 가 등기부 사진을 읽은 것, source 'code')도 같은 미리보기·답하기를 쓴다.
  //   해석 결과(소유자 이름 등)는 이 기기 안에서만 쓰고, 항목 메모에는 사람 이름을 적지 않는다(공유 글에 실리므로)
  // =====================================================

  var REG_KIND_LABEL = {
    trust: '신탁', seizure: '압류·가압류', injunction: '가처분', auction: '경매개시결정', provisional: '가등기',
    lease: '임차권등기', mortgage: '근저당', jeonse: '전세권', other: '그 밖의 기록'
  };
  var REG_STOP_KINDS = ['trust', 'seizure', 'injunction', 'auction', 'provisional', 'lease'];
  var REG_HISTORY_KINDS = ['seizure', 'injunction', 'auction', 'lease', 'provisional']; // reg-history 로 세는 지난 기록(registry-parser 와 같음)
  // 재열람 단계: 다시 뗀 등기부를 앞 기록과 비교한 결과를 넣을 최종 확인 섹션 항목(data.js)
  var RECHECK_STAGES = [
    { id: 'now', label: '가계약금 보내기 전', check: 'fin-reg-now', flag: 'fin-reg-now-changed' },
    { id: 'contract', label: '계약서 쓰는 날', check: 'fin-reg-contract', flag: 'fin-reg-contract-changed' },
    { id: 'balance', label: '잔금일', check: 'fin-reg-balance', flag: 'fin-reg-balance-changed' }
  ];

  var pdfjsLoading = null;
  /** pdf.js 를 처음 쓸 때 한 번만 스크립트 태그로 불러온다. 결과: Promise<pdfjsLib>(실패하면 reject, 다음에 다시 시도) */
  function loadPdfjs() {
    var lib = window.pdfjsLib;
    if (lib && typeof lib.getDocument === 'function') return Promise.resolve(lib);
    if (pdfjsLoading) return pdfjsLoading;
    pdfjsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS_SRC;
      s.async = true;
      s.onload = function () {
        var l = window.pdfjsLib;
        if (l && typeof l.getDocument === 'function') {
          // 일꾼 주소는 상대 경로(배포 위치와 관계없이). 서비스 워커 캐시에서도 같은 주소로 찾는다
          if (l.GlobalWorkerOptions && !l.GlobalWorkerOptions.workerSrc) l.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
          resolve(l);
        } else {
          pdfjsLoading = null;
          reject(new Error('pdfjsLib 없음'));
        }
      };
      s.onerror = function () {
        pdfjsLoading = null;
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('pdf.js 를 불러오지 못함'));
      };
      document.head.appendChild(s);
    });
    return pdfjsLoading;
  }

  /** PDF 바이트 → registry-parser 결과. 실패도 { ok:false, error, message } 로 돌려준다(Promise 는 늘 resolve) */
  function parseRegistryPdf(buf) {
    if (!REG) return Promise.resolve({ ok: false, error: 'no-parser', message: '등기부 읽기 기능(registry-parser.js)을 불러오지 못했어요. 새로고침해 보세요.' });
    return loadPdfjs().then(function (lib) {
      // registry-parser 가 늘 isEvalSupported:false 로 연다(PDF 안 글꼴로 코드를 만들지 않게)
      return REG.parsePdf(lib, buf, { workerSrc: PDFJS_WORKER_SRC, today: todayISO() });
    }, function () {
      return { ok: false, error: 'no-pdfjs', message: REG.MESSAGES['no-pdfjs'] };
    }).then(null, function (err) {
      console.warn('등기부 PDF 해석 실패', err);
      return { ok: false, error: 'internal', message: REG.MESSAGES.internal };
    });
  }

  function regAnsText(v) { return v === 'yes' ? '있음' : v === 'no' ? '없음' : v === 'done' ? '체크' : '답 없음'; }
  /** 열람 일시 글. 시각이 00:00 이면(제출용은 발행일만 적혀 있음) 날짜만 */
  function regWhen(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.getHours() || d.getMinutes() ? formatDateTime(ms) : d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
  }
  function regViewedText(ms, docType) { return ms ? regWhen(ms) + (docType === '제출용' ? ' 발행' : ' 열람') : '열람 일시 모름'; }
  /** 이 기기 시각의 'YYYY-MM-DDTHH:MM'(registry-parser 의 비교 함수가 글자로 견줌) */
  function isoLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /** 동·호 비교용 열쇠: 공백·앞의 "제"·끝의 "동/호"를 빼고 대문자 */
  function unitKey(v) { return str(v).replace(/\s+/g, '').replace(/^제/, '').replace(/(동|호)$/, '').toUpperCase(); }
  /** 단지명 비교용 열쇠: NFC, 공백·끝의 "아파트" 빼고 소문자 */
  function nameKey(v) {
    var s = str(v);
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(/\s+/g, '').replace(/아파트$/, '').toLowerCase();
  }
  function kindCount(lists, k) { return lists && !Array.isArray(lists) && Array.isArray(lists[k]) ? lists[k].length : 0; }
  /**
   * 기록 한 줄 이름(등기목적 그대로): "갑구 13번 가압류(2026-10-20 접수)". 등기목적에 사람 이름이 들어갈 수 있어
   * ("2번홍길동지분가압류") 이 기기 화면(미리보기)에서만 쓴다. 메모·공유 글·[기록 보기]는 regEntrySafeLabel
   */
  function regEntryLabel(b) {
    var part = b.part || b.section;
    return (part === 'gap' ? '갑구 ' : part === 'eul' ? '을구 ' : '') + (b.rank ? b.rank + '번 ' : '') + (b.purpose || '(부기)') +
      ((b.receiptDate || b.date) ? '(' + (b.receiptDate || b.date) + ' 접수)' : '');
  }
  /** 1.6.0 검토 반영: 메모·[기록 보기]용 이름 — 종류 이름과 순위번호만(사람 이름 없이): "갑구 3번 압류·가압류(지분)(2026-10-22 접수)" */
  function regEntrySafeLabel(b) {
    var part = b.part || b.section;
    return (part === 'gap' ? '갑구 ' : part === 'eul' ? '을구 ' : '') + (b.rank ? b.rank + '번 ' : '') + (REG_KIND_LABEL[b.kind] || '기록') +
      (/지분/.test(str(b.purpose)) ? '(지분)' : '') + ((b.receiptDate || b.date) ? '(' + (b.receiptDate || b.date) + ' 접수)' : '');
  }
  // 재열람 비교에서 "없음"을 말하려면 새 등기부로 답하는 멈춤 신호가 모두 확실해야 한다(registry-parser STOP_IDS 와 같음)
  var REG_STOP_IDS = ['reg-trust', 'reg-seizure', 'reg-injunction', 'reg-auction', 'reg-provisional', 'reg-lease'];
  /** 1.6.0 검토 반영: 새 등기부가 비교에 쓰기에 불확실한지(PDF 를 끝까지 읽지 못함·멈춤 신호 중 확신 낮음·빈칸) */
  function registryUnsure(model) {
    if (model.source === 'pdf' && model.complete !== true) return true;
    var a = (model.snap && model.snap.answers) || {};
    return REG_STOP_IDS.some(function (id) { return a[id] !== 'yes' && a[id] !== 'no'; });
  }
  /** 같은 날(이 기기 날짜)인지 */
  function sameLocalDay(a, b) {
    var x = new Date(a);
    var y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  /**
   * 등기부의 동·호 ↔ 매물 동·호. 결과: { state: 'match'|'mismatch'|'unknown', diffs: ['동(매물 101 / 등기부 102)'], label: '동·호' }
   * 양쪽에 다 있는 것만 견준다(가져온 매물은 호수가 비어 있을 수 있음)
   */
  function registryUnitCheck(prop, dong, ho) {
    var diffs = [];
    var parts = [];
    var known = 0;
    [['동', prop.dong, dong], ['호', prop.ho, ho]].forEach(function (x) {
      if (!str(x[1]).trim() || !str(x[2]).trim()) return;
      known++;
      if (unitKey(x[1]) !== unitKey(x[2])) {
        diffs.push(x[0] + '(매물 ' + x[1] + ' / 등기부 ' + x[2] + ')');
        parts.push(x[0]);
      }
    });
    return { state: diffs.length ? 'mismatch' : known ? 'match' : 'unknown', diffs: diffs, label: parts.join('·') };
  }

  // 미리보기·답하기가 함께 쓰는 모양(model):
  //   { source: 'pdf'|'code', snap(기록 원본 — normalizeSnapshot 이 받는 모양), parsed(registry-parser 결과|null),
  //     address, dong, ho, area, uniqueNo, viewedAt(ms|null), docType, includesCancelled, complete(true|false|null),
  //     owners: [{ name, share, since }], low: { 항목id: 값 }(확신이 낮아 답하지 않음), mortgages, live, history(종류별 목록),
  //     warnings: [글], notes: [글], match(코드의 건물 정보|null), dupOf(같은 열람 일시의 기록|null), diff({ prev, res }|null) }
  /** registry-parser 결과 → model. 확신이 낮은(confidence 'low') 답은 넣지 않고 "확인 필요"로만 보여 준다 */
  function registryModelFromPdf(R) {
    var answers = {};
    var low = {};
    Object.keys(R.answers || {}).forEach(function (k) {
      var v = R.answers[k] === true ? 'done' : R.answers[k];
      if (R.confidence && R.confidence[k] === 'low') low[k] = v;
      else answers[k] = v;
    });
    // 근저당 요약은 을구 기록에서(부기로 바뀐 채권최고액·채무자가 반영된 값). 말소된 것과 부기 행은 뺀다
    var mortgages = (R.eul || []).filter(function (e) { return e.kind === 'mortgage' && !e.cancelled && !e.parent; })
      .map(function (e) { return { rank: e.rank, maxAmount: e.maxAmount || null, holder: e.holder || '', debtor: e.debtor || '' }; });
    var owners = (R.owners || []).map(function (o) { return { name: o.name, share: o.share, since: o.since }; });
    var snap = {
      id: uid(), docId: null, source: 'pdf', viewedAt: R.viewedAt, docType: R.docType || '', includesCancelled: R.includesCancelled,
      uniqueNo: R.uniqueNo || '', area: R.area, owners: owners, live: R.live, history: R.history, mortgages: mortgages, answers: answers,
      ownersUncertain: !!R.ownersUncertain, // 1.6.0 검토 반영: 소유자 계산이 불확실하면 매도인 비교로 "없음"을 넣지 않음
      addedAt: Date.now()
    };
    return {
      source: 'pdf', snap: snap, parsed: R, address: R.address || '', dong: R.dong || '', ho: R.ho || '', area: R.area,
      uniqueNo: R.uniqueNo || '', viewedAt: snapTime(R.viewedAt), docType: R.docType || '', includesCancelled: R.includesCancelled,
      complete: !!R.complete, owners: owners, low: low, mortgages: mortgages, live: R.live || {}, history: R.history || {},
      warnings: (R.warnings || []).slice(), notes: [], match: null, dupOf: null, diff: null
    };
  }
  /** 가져오기 코드의 등기부 기록(import-parser parseRegistryBlock 의 snapshot) → model */
  function registryModelFromCode(s, notes, warnings) {
    var m = s.match || {};
    return {
      source: 'code', snap: Object.assign({}, s, { addedAt: Date.now() }), parsed: null, address: '', dong: m.dong || '', ho: m.ho || '',
      area: s.area, uniqueNo: s.uniqueNo || '', viewedAt: snapTime(s.viewedAt), docType: s.docType || '', includesCancelled: s.includesCancelled,
      complete: null, owners: s.owners || [], low: {}, mortgages: s.mortgages || [], live: s.live || {}, history: s.history || {},
      warnings: (warnings || []).map(function (w) { return str(w && w.text ? w.text : w); }),
      notes: (notes || []).concat(s.notes || []).map(str), match: m, dupOf: null, diff: null
    };
  }

  /**
   * 기록(정리된 snapshot) → registry-parser diffRegistry 가 받는 모양(갑구·을구 기록을 순위번호로).
   * 1.6.0 검토 반영: 순위번호·구가 없는 기록도 버리지 않는다(구는 종류로 짐작. 비교는 종류·접수일·목적으로). unsure: 새 등기부가 불확실
   */
  function diffInputOf(s, unsure) {
    var o = {
      ok: true, uniqueNo: s.uniqueNo || '', viewedAt: s.viewedAt ? isoLocal(s.viewedAt) : null,
      includesCancelled: s.includesCancelled, owners: s.owners || [], gap: [], eul: [], unsure: !!unsure
    };
    [[s.live, false], [s.history, true]].forEach(function (x) {
      (x[0] || []).forEach(function (e) {
        var part = e.part === 'gap' || e.part === 'eul' ? e.part : /^(mortgage|jeonse|lease)$/.test(e.kind) ? 'eul' : 'gap';
        o[part].push({ rank: e.rank || '', purpose: e.purpose, kind: e.kind, receiptDate: e.date, receiptNo: '', cancelled: x[1], text: e.text });
      });
    });
    return o;
  }
  /** 고유번호가 맞는지(한쪽이 없으면 맞는 것으로) */
  function snapSameHouse(s, uniqueNo) { return !s.uniqueNo || !uniqueNo || s.uniqueNo === uniqueNo; }
  /** 두 비교 결과(처음 기록과, 바로 앞 기록과)를 합친다: 새 기록·그 사이 말소는 합집합, 소유자 변경·불확실은 하나라도 */
  function combineDiff(a, b) {
    if (!b || !a || !a.ok || !b.ok) return a;
    function uniq(list) {
      var seen = {};
      return list.filter(function (e) {
        var k = e.section + ':' + (e.rank || '') + ':' + (e.receiptDate || '') + ':' + (e.purpose || '');
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
    }
    var newRisks = uniq(a.newRisks.concat(b.newRisks));
    var ownerChanged = a.ownerChanged || b.ownerChanged;
    var changed = newRisks.length > 0 || ownerChanged;
    var unsure = !!(a.unsure || b.unsure);
    return Object.assign({}, a, {
      newEntries: uniq(a.newEntries.concat(b.newEntries)), newRisks: newRisks, cancelledSince: uniq(a.cancelledSince.concat(b.cancelledSince)),
      ownerChanged: ownerChanged, changed: changed, unsure: unsure, answer: changed ? 'yes' : unsure ? null : 'no',
      warnings: a.warnings.concat(b.warnings.filter(function (w) { return a.warnings.indexOf(w) < 0; }))
    });
  }

  /**
   * 미리보기 전에: 같은 열람 일시의 기록(dupOf, 같은 서류를 다시 올림)과, 다시 뗀 등기부면 이전 기록과의 비교(diff)를 찾는다.
   * 1.6.0 검토 반영: 비교 기준은 새 서류보다 열람 일시가 앞선(같은 열람 일시는 빼고) 같은 집 기록 가운데 **처음 기록**(base)과
   * **바로 앞 기록**(prev) 둘 다 — "처음과 달라진 기록"을 놓치지 않게(처음 → 새 가압류 → 같은 내용 다시 열람이 "없음"이 되지 않게).
   * 새 서류보다 열람 일시가 나중인 기록이 있으면 newer(미리보기 경고, 기본은 기록만 남김). 고유번호가 다른 기록만 있으면 'different'
   */
  function prepareRegistryModel(prop, model) {
    var list = registrySnapshotsOf(prop); // 최근 열람 순
    var vt = model.viewedAt;
    model.dupOf = null;
    model.diff = null;
    model.newer = null;
    if (vt) {
      list.forEach(function (s) {
        if (!model.dupOf && s.viewedAt === vt && snapSameHouse(s, model.uniqueNo)) model.dupOf = s;
        if (!model.newer && s.viewedAt && s.viewedAt > vt && snapSameHouse(s, model.uniqueNo)) model.newer = s;
      });
    }
    var limit = vt || Date.now();
    var older = list.filter(function (s) {
      return s !== model.dupOf && !(vt && s.viewedAt === vt) && (s.viewedAt || s.addedAt) <= limit;
    });
    if (!older.length || !REG) return model;
    var next = diffInputOf(normalizeSnapshot(model.snap), registryUnsure(model));
    var same = older.filter(function (s) { return snapSameHouse(s, model.uniqueNo); });
    if (!same.length) { // 고유번호가 다른 기록만 있음 → 'different'(미리보기 경고)
      model.diff = { prev: older[0], base: older[0], res: REG.diffRegistry(diffInputOf(older[0]), next) };
      return model;
    }
    var prev = same[0];
    var base = same[same.length - 1];
    var res = REG.diffRegistry(diffInputOf(base), next);
    if (prev !== base) res = combineDiff(res, REG.diffRegistry(diffInputOf(prev), next));
    model.diff = { prev: prev, base: base, res: res };
    return model;
  }

  function rpSection(title, kids, cls) {
    return h('section', { class: 'rp-sec' + (cls ? ' ' + cls : '') }, h('h3', { class: 'rp-h', text: title }), kids);
  }
  function rpLine(text, state) { return text ? h('p', { class: 'rp-line' + (state ? ' is-' + state : ''), text: text }) : null; }
  function rpWarn(title, text) { return h('div', { class: 'dlg-warn rp-warn', role: 'note' }, h('strong', { text: title }), text ? h('p', { text: text }) : null); }
  /** 근저당 한 줄 + 원금 짐작(채권최고액 ÷ 110·120·130%) */
  function mortgageLine(m) {
    var t = [m.rank ? '을구 ' + m.rank + '번' : '근저당', m.maxAmount ? '채권최고액 ' + formatManwon(m.maxAmount / 10000) : '채권최고액 못 읽음', m.holder]
      .filter(Boolean).join(' · ');
    var est = m.maxAmount && REG ? REG.estimatePrincipal(m.maxAmount) : null;
    if (est && est.ok) {
      if (est.likely) t += ' — ' + est.likely.percent + '%로 보면 원금 약 ' + formatManwon(est.likely.principal / 10000);
      else t += ' — 원금 짐작 ' + est.rates.map(function (r) { return r.percent + '% 약 ' + formatManwon(Math.round(r.principal / 10000)); }).join(', ');
    }
    return t;
  }

  /**
   * 등기부 미리보기 대화상자: 매물과 같은 집인지(주소·동·호), 열람 일시·종류, 소유자(매도인 비교), 멈춤 신호·주의 신호 각각,
   * 근저당 목록과 원금 짐작, 지난 기록, 전유면적 ↔ 매물 면적, 직접 답할 항목(위반건축물·매도인 미입력·확인 필요), 해석 경고,
   * (앞 기록이 있으면) 재열람 비교 + 재열람 항목에 넣을 단계 고르기.
   * opts.withDoc: [서류만 저장] 버튼(PDF 를 새로 올렸을 때). 결과: Promise<{ action: 'apply'|'doc'|null, stage: 재열람 단계 id|null }>
   */
  function registryPreview(prop, model, opts) {
    opts = opts || {};
    var unit = registryUnitCheck(prop, model.dong, model.ho);
    var answers = model.snap.answers || {};
    var sellers = sellerNames(prop.sellerName);
    var ownerMatch = model.owners.length && sellers.length
      ? sellers.every(function (n) { return model.owners.some(function (o) { return samePerson(o.name, n); }); }) : null;
    // 1.6.0 검토 반영: 소유자 계산이 불확실하면 매도인 이름이 같아 보여도 "없음"으로 답하지 않는다(확인 필요)
    var ownerUnsure = !!model.snap.ownersUncertain;
    var different = !!(model.diff && model.diff.res && !model.diff.res.ok && model.diff.res.error === 'different');
    // 다른 집 등기부일 수 있음(동·호가 다르거나 앞 기록과 고유번호가 다름): 주 버튼은 답하기가 아니다
    var suspect = unit.state === 'mismatch' || different;
    var kids = [];

    // 0) 이 서류보다 최근 등기부가 이미 있음(옛 서류를 다시 읽거나 나중에 올림): 기본은 기록만 남김
    if (model.newer) {
      kids.push(rpWarn('이 서류보다 최근 등기부(' + regViewedText(model.newer.viewedAt, model.newer.docType) + ')가 있어요',
        '답은 최근 기록 기준으로 두는 것이 안전해요. [기록만 남기기]는 답을 바꾸지 않고 이 서류의 기록만 남겨요.'));
    }
    // 1) 다른 집일 수 있음
    if (unit.state === 'mismatch') {
      kids.push(rpWarn('이 매물과 ' + josa(unit.label, '이', '가') + ' 달라요', unit.diffs.join(', ') + '. 다른 집 등기부일 수 있어요. 답하면 이 매물의 멈춤 신호가 이 서류 값으로 바뀌어요("표제부 일치"는 체크하지 않아요).'));
    }
    if (different) {
      kids.push(rpWarn('전에 넣은 등기부와 고유번호가 달라요', '다른 집의 등기부일 수 있어요. 매물을 잘못 고르지 않았는지 보세요.'));
    }
    var sumAt = kids.length; // 한 줄 결론은 경고 바로 아래에(멈춤 신호를 센 뒤 넣음)

    // 2) 서류
    var place = model.address || (model.match ? [model.match.name, model.match.dong ? model.match.dong + '동' : '', model.match.ho ? model.match.ho + '호' : ''].filter(Boolean).join(' ') : '');
    var mine = [prop.dong ? prop.dong + '동' : '', prop.ho ? prop.ho + '호' : ''].filter(Boolean).join(' ');
    kids.push(rpSection('서류', [
      rpLine([regViewedText(model.viewedAt, model.docType), model.docType,
        model.includesCancelled === true ? '말소사항 포함' : model.includesCancelled === false ? '현재 유효사항만' : ''].filter(Boolean).join(' · ')),
      model.source === 'code' ? rpLine('Claude가 등기부를 읽고 만든 코드예요. 숫자·이름이 원본과 같은지 보세요.', 'muted') : null,
      place ? rpLine((model.address ? '주소 ' : '건물 ') + place) : null,
      rpLine('이 매물 ' + (mine || '(동·호수 없음)') + ' — ' + (unit.state === 'match' ? '등기부와 같아요' : unit.state === 'mismatch' ? '등기부와 달라요' : '비교하지 못했어요'),
        unit.state === 'match' ? 'ok' : unit.state === 'mismatch' ? 'bad' : ''),
      model.uniqueNo ? rpLine('고유번호 ' + model.uniqueNo, 'muted') : null,
      model.dupOf ? rpLine('같은 열람 일시의 기록이 이미 있어요. 답하면 그 기록을 이번에 읽은 것으로 바꿔요.', 'muted') : null
    ]));

    // 3) 소유자
    var ownerKids = model.owners.length
      ? model.owners.map(function (o) { return rpLine(o.name + (o.share ? ' · 지분 ' + o.share : '') + (o.since ? ' · ' + o.since + ' 접수' : '')); })
      : [rpLine('소유자를 읽지 못했어요. 원본 갑구의 마지막 소유권 기록을 직접 보세요.', 'warn')];
    if (model.owners.length > 1) ownerKids.push(rpLine('공동명의 ' + model.owners.length + '명 — 팔려면 소유자 모두가 동의해야 해요.', 'warn'));
    if (model.owners.length && ownerUnsure) ownerKids.push(rpLine('소유자 계산이 확실하지 않아요(지분·이름을 다 읽지 못했거나 무엇을 지웠는지 모르는 말소가 있음). 원본 갑구를 직접 보세요.', 'warn'));
    if (ownerMatch === true && ownerUnsure) ownerKids.push(rpLine('매도인 이름(매물 정보)과 같아 보여요 — 소유자 계산이 확실하지 않아 "없음"으로 답하지 않아요', 'warn'));
    else if (ownerMatch === true) ownerKids.push(rpLine('매도인 이름(매물 정보)과 같아요', 'ok'));
    else if (ownerMatch === false) ownerKids.push(rpLine('매도인 이름(매물 정보)과 달라요 — "소유자 ≠ 매도인"을 "있음"으로 답해요', 'bad'));
    kids.push(rpSection('소유자', ownerKids));

    // 4) 멈춤 신호·주의 신호(등기부 섹션의 flag 항목 순서 그대로)
    var gate = gateSections()[0];
    var flags = gate ? gate.items.filter(function (it) { return it.type === 'flag'; }) : [];
    var stopYes = 0;
    var stopUnknown = 0;
    var stopUnread = 0; // 1.6.0 검토 반영: 위반건축물(늘 답 못 함)·매도인 이름 미입력 말고 앱이 확실히 읽지 못한 멈춤 신호
    function flagState(it) {
      if (it.id === 'reg-building') return { v: 'skip', note: '건축물대장에서 확인', expected: true };
      if (it.id === 'reg-owner-diff') {
        if (ownerMatch === null) return { v: 'skip', note: sellers.length ? '소유자를 못 읽어 비교 못 함' : '매도인 이름 미입력', expected: !sellers.length };
        if (ownerMatch && ownerUnsure) return { v: 'low', note: '매도인 이름과 같아 보이지만 소유자 계산이 확실하지 않아요' };
        return { v: ownerMatch ? 'no' : 'yes', note: '매도인 이름과 비교' };
      }
      var a = answers[it.id];
      if (it.id === 'reg-mortgage' && !a && (model.mortgages || []).length) a = 'yes';
      if (a === 'yes' || a === 'no') return { v: a };
      if (hasOwn(model.low, it.id)) return { v: 'low', note: '"' + regAnsText(model.low[it.id]) + '"으로 읽었지만 확실하지 않아요' };
      return { v: 'skip', note: '읽지 못함 — 직접 확인' };
    }
    function flagRow(it) {
      var s = flagState(it);
      var stop = it.severity === 'stop';
      if (stop && s.v === 'yes') stopYes++;
      if (stop && s.v !== 'yes' && s.v !== 'no') stopUnknown++;
      if (stop && s.v !== 'yes' && s.v !== 'no' && !s.expected) stopUnread++;
      return h('li', { class: 'rp-row' },
        h('span', { class: 'rp-name', text: it.shortTitle || it.text }),
        h('span', { class: 'rp-ans rp-' + s.v + (stop ? ' is-stop' : ''), text: { yes: '있음', no: '없음', low: '확인 필요', skip: '답 못 함' }[s.v] }),
        s.note ? h('span', { class: 'rp-note', text: s.note }) : null);
    }
    var stopRows = flags.filter(function (it) { return it.severity === 'stop'; }).map(flagRow);
    var cautionRows = flags.filter(function (it) { return it.severity !== 'stop'; }).map(flagRow);
    // 1.6.0 검토 반영: 확실히 읽지 못한 멈춤 신호가 있으면 초록 "모두 없어요"가 아니라 주황으로 먼저 알린다
    var stopHead = stopYes ? '멈춤 신호 ' + stopYes + '개가 있어요. 이 집은 진행하지 않는 것이 안전해요.'
      : stopUnread ? '멈춤 신호 ' + stopUnread + '개는 앱이 확실히 읽지 못했어요 — 원본에서 직접 확인하세요.'
        : '읽은 멈춤 신호는 모두 없어요' + (stopUnknown ? '(직접 답할 항목 ' + stopUnknown + '개)' : '');
    var stopTone = stopYes ? 'bad' : stopUnread ? 'warn' : 'ok';
    kids.push(rpSection('멈춤 신호', [rpLine(stopHead, stopTone), h('ul', { class: 'rp-list' }, stopRows)], stopYes ? 'is-stop' : ''));
    kids.push(rpSection('주의 신호', [h('ul', { class: 'rp-list' }, cautionRows)]));
    // 한 줄 결론(맨 위): 같은 집인지 · 멈춤 신호 · 확인 필요. 대화상자가 길어도 첫 화면에서 보이게
    var sumParts = [unit.state === 'match' ? '같은 집(동·호)' : unit.state === 'mismatch' ? '다른 집일 수 있음' : '동·호 비교 못 함',
      stopYes ? '멈춤 신호 있음 ' + stopYes + '개' : stopUnread ? '멈춤 신호 확인 필요 ' + stopUnread + '개' : '읽은 멈춤 신호 없음'];
    if (model.newer) sumParts.push('더 최근 등기부가 있음');
    kids.splice(sumAt, 0, h('p', { class: 'rp-sum is-' + (suspect || stopYes ? 'bad' : stopUnread || model.newer ? 'warn' : 'ok'), text: sumParts.join(' · ') }));

    // 5) 근저당
    var mg = model.mortgages || [];
    if (mg.length) {
      kids.push(rpSection('근저당 ' + mg.length + '건', mg.map(function (m) { return rpLine(mortgageLine(m)); }).concat([
        rpLine('채권최고액은 보통 빌린 돈의 110~130%로 적혀요. 실제 남은 빚은 매도인의 대출 잔액 증명서로 확인하세요.', 'muted')])));
    }

    // 6) 지난 기록
    var hist = REG_HISTORY_KINDS.filter(function (k) { return kindCount(model.history, k); })
      .map(function (k) { return REG_KIND_LABEL[k] + ' ' + kindCount(model.history, k) + '건'; });
    var common = kindCount(model.history, 'mortgage') + kindCount(model.history, 'trust') + kindCount(model.history, 'jeonse');
    kids.push(rpSection('지난 기록(말소됨)', [
      model.includesCancelled === false
        ? rpLine('현재 유효사항으로 열람해 지워진 지난 기록이 보이지 않아요. "말소사항 포함"으로 열람하면 볼 수 있어요.', 'warn')
        : rpLine(hist.length ? hist.join(', ') + ' — 지금은 풀렸지만 언제 왜 생겼는지 물어보세요.' : '압류·가압류·가처분·경매·가등기·임차권 지난 기록 없음', hist.length ? 'warn' : ''),
      common ? rpLine('말소된 근저당·신탁·전세권 ' + common + '건은 흔한 기록이라 "지난 기록"으로 세지 않아요.', 'muted') : null
    ]));

    // 7) 전유면적 ↔ 매물 면적
    var pa = numOrNull(prop.area);
    var ra = numOrNull(model.area);
    var areaSame = ra && pa ? Math.abs(ra - pa) <= 0.05 : null;
    kids.push(rpSection('전유면적', [
      rpLine(ra ? '등기부 ' + ra + '㎡ · 매물 ' + (pa ? pa + '㎡' : '없음') + (areaSame === true ? ' — 같아요' : areaSame === false ? ' — 달라요' : '')
        : '등기부에서 전유면적을 읽지 못했어요', areaSame === true ? 'ok' : areaSame === false ? 'bad' : ''),
      ra && pa !== ra && unit.state !== 'mismatch' ? rpLine('답한 뒤 매물 면적을 등기부 값으로 ' + (pa ? '바꿀지' : '채울지') + ' 물어볼게요.', 'muted') : null
    ]));

    // 8) 직접 답할 항목
    var cant = ['위반건축물 — 등기부에 나오지 않아요. 건축물대장(정부24·세움터)에서 보고 직접 답하세요.'];
    if (ownerMatch === null) {
      cant.push('소유자 ≠ 매도인 — ' + (sellers.length ? '소유자를 읽지 못해 비교하지 못했어요.' : '매물 정보에 매도인 이름이 없어요. [매물 정보 수정]에서 적으면 비교해 답해요.'));
    } else if (ownerMatch && ownerUnsure) {
      cant.push('소유자 ≠ 매도인 — 소유자 계산이 확실하지 않아 답하지 않았어요. 원본 갑구의 마지막 소유자와 매도인 이름을 직접 비교하세요.');
    }
    Object.keys(model.low).forEach(function (id) {
      var it = CL.itemById[id];
      if (it) cant.push((it.shortTitle || it.text) + ' — 앱이 확실히 읽지 못했어요. 원본을 직접 보고 답하세요.');
    });
    kids.push(rpSection('직접 답할 항목', cant.map(function (t) { return rpLine(t); })));

    // 9) 해석하며 알게 된 것(경고·참고)
    var warns = model.warnings.concat(model.notes).filter(Boolean);
    if (warns.length) kids.push(rpSection('확인할 점', warns.slice(0, 12).map(function (w) { return rpLine(w, 'warn'); })));

    // 10) 재열람 비교(이전 기록이 있을 때). 1.6.0 검토 반영:
    //  - 처음 기록·바로 앞 기록과 함께 비교(prepareRegistryModel). 새 등기부가 불확실하면 "없음"을 제안하지 않음
    //  - 재열람 체크("오늘 날짜로 다시 열람했다")는 오늘 열람한 서류일 때만, 기본 켬은 계약 검토 상태일 때만
    //  - "달라진 기록" 있음 제안은 기본 켬(안전한 쪽), 없음은 계약 검토 + 오늘 서류일 때만 기본 켬,
    //    지금 "있음"인 것을 "없음"으로 바꾸는 것은 늘 기본 끔(글로 따로 알림)
    var stagePick = null;
    var d = model.diff && model.diff.res;
    if (d && d.ok) {
      var baseS = model.diff.base || model.diff.prev;
      var prevS = model.diff.prev;
      var two = prevS && prevS !== baseS;
      var dl = [rpLine('처음 기록: ' + regViewedText(baseS.viewedAt, baseS.docType) + ' (' + snapSourceLabel(baseS) + ')', 'muted')];
      if (two) dl.push(rpLine('바로 앞 기록: ' + regViewedText(prevS.viewedAt, prevS.docType) + ' (' + snapSourceLabel(prevS) + ')', 'muted'));
      var cmpName = two ? '처음·앞 기록과' : '처음 기록과';
      dl.push(rpLine(d.changed ? cmpName + ' 달라진 기록이 있어요'
        : d.unsure ? '비교가 확실하지 않아요 — 새 등기부를 다 읽지 못했어요(빠진 쪽·확인 필요 항목). 전체 PDF로 다시 열람해 비교하세요.'
          : cmpName + ' 달라진 기록이 없어요', d.changed ? 'bad' : d.unsure ? 'warn' : 'ok'));
      d.newRisks.forEach(function (b) { dl.push(rpLine('새 기록: ' + regEntryLabel(b), 'bad')); });
      if (d.ownerChanged) dl.push(rpLine('소유자가 바뀌었어요', 'bad'));
      d.cancelledSince.forEach(function (b) { dl.push(rpLine('그 사이 말소: ' + regEntryLabel(b), 'muted')); });
      (d.warnings || []).forEach(function (w) { dl.push(rpLine(w, 'warn')); });
      var stages = recheckStages();
      var propose = d.changed ? 'yes' : d.unsure ? '' : 'no';
      var fresh = !!(model.viewedAt && sameLocalDay(model.viewedAt, Date.now()));
      if (stages.length && (propose || fresh)) {
        var contract = prop.status === 'contract';
        var sel = h('select', { class: 'select rp-stage-sel', 'aria-label': '재열람 단계' },
          stages.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
        sel.value = defaultRecheckStage(prop);
        var checkCb = fresh ? h('input', { type: 'checkbox', id: 'rp-stage-c-' + uid() }) : null;
        var flagCb = propose ? h('input', { type: 'checkbox', id: 'rp-stage-f-' + uid() }) : null;
        var flagText = h('span');
        var pick = { sel: sel, checkCb: checkCb, flagCb: flagCb, lower: false };
        var syncStage = function (first) {
          var st = RECHECK_STAGES.filter(function (s) { return s.id === sel.value; })[0] || stages[0];
          var cur = getItemState(prop, st.flag).status;
          pick.lower = propose === 'no' && cur === 'yes';
          flagText.textContent = propose === 'yes' ? '"달라진 기록"을 "있음"으로 표시'
            : pick.lower ? '"달라진 기록"을 지금 "있음" → "없음"으로 바꾸기' : '"달라진 기록"을 "없음"으로 표시';
          if (flagCb && pick.lower) flagCb.checked = false;
          else if (flagCb && first) flagCb.checked = propose === 'yes' || (contract && fresh);
          if (checkCb && first) checkCb.checked = contract;
        };
        sel.addEventListener('change', function () { syncStage(false); });
        syncStage(true);
        dl.push(h('div', { class: 'rp-stage' },
          checkCb ? h('label', { class: 'rp-check', for: checkCb.id }, checkCb, h('span', { text: '이 단계의 재열람 항목("등기부를 다시 열람했다")을 체크' })) : null,
          flagCb ? h('label', { class: 'rp-check', for: flagCb.id }, flagCb, flagText) : null,
          fresh ? null : rpLine('오늘 열람한 서류가 아니라 재열람 항목은 체크하지 않아요.', 'muted'),
          h('div', { class: 'rp-stage-row' }, h('span', { class: 'small', text: '단계(최종 확인 섹션)' }), sel)));
        stagePick = pick;
      }
      kids.push(rpSection('다시 뗀 등기부 비교', dl, d.changed ? 'is-stop' : ''));
    }

    // 버튼: 더 최근 등기부가 있으면 [기록만 남기기], 다른 집일 수 있으면 [서류만 저장]·[취소]가 먼저. [그래도 답하기]는 한 번 더 묻는다
    var buttons;
    var message = '원본과 같은지 보고 [이대로 답하기]를 누르세요. 이미 답한 항목을 바꿀 때는 한 번 더 물어요.';
    if (model.newer) {
      buttons = [{ label: '기록만 남기기', value: 'record' }, { label: '그래도 답하기', value: 'force', kind: 'secondary' }];
      message = '이 서류보다 최근 등기부가 있어요. 답은 그대로 두고 기록만 남기는 것을 권해요.';
    } else if (suspect) {
      buttons = opts.withDoc ? [{ label: '서류만 저장', value: 'doc' }] : [];
      message = '다른 집 등기부일 수 있어요. 매물과 서류를 확인한 뒤에만 답하세요.';
    } else {
      buttons = [{ label: '이대로 답하기', value: 'apply' }];
      if (opts.withDoc) buttons.push({ label: '서류만 저장', value: 'doc', kind: 'secondary' });
    }
    if (suspect && !model.newer) {
      if (!opts.withDoc) buttons.push({ label: '취소', value: null, kind: 'secondary' });
      buttons.push({ label: '그래도 답하기', value: 'force', kind: 'danger-ghost' });
      if (opts.withDoc) buttons.push({ label: '취소', value: null, kind: 'secondary' });
    } else buttons.push({ label: '취소', value: null, kind: 'secondary' });
    return openDialog({
      title: model.source === 'pdf' ? '등기부를 읽었어요' : '등기부 코드를 읽었어요',
      message: message,
      content: h('div', { class: 'rp' }, kids),
      className: 'rp-dialog', // 1.6.0 검토 반영: 긴 미리보기에서도 버튼이 화면 아래에 붙어 보이게(styles.css)
      buttons: buttons
    }).then(function (r) {
      var out = {
        action: r.value === 'apply' || r.value === 'doc' || r.value === 'record' ? r.value : null,
        stage: null, setCheck: false, setFlag: false, lowerOk: false
      };
      if (stagePick) {
        out.setCheck = !!(stagePick.checkCb && stagePick.checkCb.checked);
        out.setFlag = !!(stagePick.flagCb && stagePick.flagCb.checked);
        out.lowerOk = out.setFlag && stagePick.lower;
        if (out.setCheck || out.setFlag) out.stage = stagePick.sel.value;
      }
      if (r.value !== 'force') return out;
      return confirmDialog({
        title: '그래도 이 서류로 답할까요?',
        message: [suspect ? '다른 집 등기부일 수 있어요. 답하면 이 매물의 멈춤 신호·주의 신호가 이 서류 값으로 바뀌어요.' : '',
          model.newer ? '더 최근 등기부가 넣은 답은 바꾸기 전에 항목마다 한 번 더 물어요.' : ''].filter(Boolean).join('\n'),
        confirmText: '그래도 답하기', danger: suspect
      }).then(function (ok) {
        out.action = ok ? 'apply' : null;
        return out;
      });
    });
  }

  function recheckStages() { return RECHECK_STAGES.filter(function (s) { return CL.itemById[s.check] || CL.itemById[s.flag]; }); }
  /** 재열람 단계 기본값: 계약 검토 중이면 "계약서 쓰는 날", 그 밖(검토 중·임장 예정·임장 완료)은 "가계약금 보내기 전" */
  function defaultRecheckStage(prop) { return prop.status === 'contract' ? 'contract' : 'now'; }
  function snapSourceLabel(s) { return s.source === 'pdf' ? 'PDF' : s.source === 'code' ? '등기부 코드' : '직접 입력'; }

  /** 이미 답한 항목을 등기부 값으로 덮어쓸지 목록으로 묻는다. 결과: Promise<{ 항목id: true }>(고른 것만) */
  function confirmOverwrite(skipped) {
    var boxes = [];
    var list = h('ul', { class: 'rp-over' }, skipped.map(function (s) {
      var it = CL.itemById[s.id];
      var cbId = 'rp-over-' + domId(s.id);
      // 지금 "있음"인 것을 "없음"으로 바꾸는 것은 기본으로 고르지 않는다(사용자가 아는 사정이 있을 수 있음)
      var cb = h('input', { type: 'checkbox', id: cbId, checked: !(s.current === 'yes' && s.value === 'no') });
      boxes.push({ id: s.id, cb: cb });
      return h('li', {}, h('label', { class: 'rp-check', for: cbId }, cb,
        h('span', { text: (it ? it.shortTitle || it.text : s.id) + ': 지금 "' + regAnsText(s.current) + '" → 등기부 "' + regAnsText(s.value) + '"' })));
    }));
    return openDialog({
      title: '이미 답한 항목이 있어요. 덮어쓸까요?',
      content: h('div', { class: 'rp-over-box' },
        h('p', { class: 'small muted', text: '고른 항목만 등기부 값으로 바꿔요. 다른 항목은 그대로 답해요.' }), list),
      buttons: [
        { label: '고른 항목 덮어쓰기', value: 'go' },
        { label: '모두 그대로 두기', value: 'keep', kind: 'secondary' }
      ]
    }).then(function (r) {
      var over = {};
      if (r.value === 'go') boxes.forEach(function (b) { if (b.cb.checked) over[b.id] = true; });
      return over;
    });
  }

  /**
   * 등기부 전유면적이 매물 면적과 다르거나 매물에 면적이 없으면 바꿀지(채울지) 묻는다.
   * 결과: Promise<{ changed, near(반올림 차이 0.05㎡ 안 또는 비어 있던 칸을 채움), from(바꾸기 전 매물 면적) }>
   * 1.6.0 검토 반영: 차이가 크면(다른 호수일 수 있음) 주 버튼은 [그대로 두기]. [바꾸기]를 눌러도 "표제부 일치"는 체크하지 않는다(부른 쪽)
   */
  function askAreaChange(prop, model, unit) {
    var ra = numOrNull(model.area);
    var pa = numOrNull(prop.area);
    var none = { changed: false, near: false, from: pa };
    if (!ra || unit.state === 'mismatch' || (pa !== null && Math.abs(ra - pa) < 0.0005)) return Promise.resolve(none);
    var near = pa === null || Math.abs(ra - pa) <= 0.05;
    var go = { label: pa !== null ? '바꾸기' : '채우기', value: true };
    var keep = { label: '그대로 두기', value: false, kind: 'secondary' };
    return openDialog({
      title: pa !== null ? '매물 면적을 등기부 값으로 바꿀까요?' : '매물 면적을 등기부 값으로 채울까요?',
      message: pa !== null
        ? '매물 정보 전용 ' + pa + '㎡ → 등기부 전유부분 ' + ra + '㎡\n' + (near ? '반올림 차이예요. 등기부 값이 정확해요.'
          : '차이가 커요. 다른 호수의 등기부가 아닌지 먼저 확인하세요. 바꿔도 "표제부 일치"는 체크하지 않아요.')
        : '매물 정보에 전용면적이 비어 있어요. 등기부 전유부분 ' + ra + '㎡로 채우면 "표제부 일치"도 체크해요.',
      buttons: near ? [go, keep] : [{ label: '그대로 두기', value: false }, { label: go.label, value: true, kind: 'secondary' }]
    }).then(function (r) {
      if (r.value !== true) return none;
      if (!prop.fieldsAt || typeof prop.fieldsAt !== 'object') prop.fieldsAt = {};
      prop.area = ra;
      var t = prop.fieldsAt.area = stampAfter(Date.now(), prop.fieldsAt.area, prop.legacyAt);
      touch(prop, t);
      return { changed: true, near: near, from: pa };
    });
  }

  /**
   * 재열람 비교 결과를 최종 확인 섹션에 넣는다: (pick.setCheck) 재열람 체크(fin-reg-…) 완료 + 메모(열람 일시),
   * (pick.setFlag) "달라진 기록"(…-changed) 있음/없음 + 메모(사람 이름 없이: 종류 이름과 순위번호만).
   * model: 미리보기 model(diff = { base: 처음 기록, prev: 바로 앞 기록, res: 비교 결과 }).
   * 1.6.0 검토 반영: 비교가 불확실(res.unsure)하고 바뀐 것이 없으면 "없음"을 넣지 않는다. 지금 "있음"을 "없음"으로는
   *   pick.lowerOk(미리보기에서 따로 고름)일 때만 바꾼다.
   * 결과: { stage, changed, flag: 'yes'|'no'|null(넣지 않음), kept(있음을 그대로 둠), checked, items:[바꾼 항목 id] } | null
   */
  function applyRecheck(prop, stageId, model, pick) {
    pick = pick || {};
    var st = RECHECK_STAGES.filter(function (s) { return s.id === stageId; })[0];
    var d = model.diff && model.diff.res;
    var base = model.diff && (model.diff.base || model.diff.prev);
    var prev = model.diff && model.diff.prev;
    if (!st || !d || !d.ok) return null;
    var out = [];
    var head = SNAP_MEMO_HEAD + ' · ' + regViewedText(model.viewedAt, model.docType) + ']';
    var res = { stage: st, changed: d.changed, flag: null, kept: false, checked: false, items: out };
    if (pick.setCheck && CL.itemById[st.check]) {
      if (!getItemState(prop, st.check).done) {
        setItemState(prop, st.check, { done: true });
        out.push(st.check);
      }
      res.checked = true;
      var cmemo = snapMemoBlock(getItemState(prop, st.check).memo, [head, '· 이 등기부로 앱이 재열람을 체크했어요']);
      if (cmemo !== str(getItemState(prop, st.check).memo).trim()) setItemState(prop, st.check, { memo: cmemo });
    }
    if (pick.setFlag && CL.itemById[st.flag]) {
      var v = d.changed ? 'yes' : d.unsure ? null : 'no';
      var cur = getItemState(prop, st.flag).status;
      if (v === 'no' && cur === 'yes' && !pick.lowerOk) { v = null; res.kept = true; }
      if (v) {
        res.flag = v;
        if (cur !== v) {
          setItemState(prop, st.flag, { status: v });
          out.push(st.flag);
        }
        var since = '처음 기록(' + regViewedText(base && base.viewedAt, base && base.docType) + ')' +
          (prev && prev !== base ? '·앞 기록(' + regViewedText(prev.viewedAt, prev.docType) + ')' : '');
        var lines = [head, '· ' + since + '과 ' + (d.changed ? '달라진 기록이 있어요' : '달라진 기록 없음')];
        // 메모는 공유 글에 실린다: 등기목적("2번홍길동지분가압류") 대신 종류 이름과 순위번호만
        d.newRisks.forEach(function (b) { lines.push('· 새 기록: ' + regEntrySafeLabel(b)); });
        if (d.ownerChanged) lines.push('· 소유자가 바뀌었어요');
        if (d.cancelledSince.length) lines.push('· 그 사이 말소 ' + d.cancelledSince.length + '건');
        var memo = snapMemoBlock(getItemState(prop, st.flag).memo, lines);
        if (memo !== str(getItemState(prop, st.flag).memo).trim()) setItemState(prop, st.flag, { memo: memo });
      }
    }
    return res;
  }

  /** 등기부 PDF 를 서류함에 넣는다(kind 'registry'). 결과: Promise<서류 id | null(저장 실패 — 이유는 pdf.docFailed, 알림은 부른 쪽이)> */
  function saveRegistryDoc(prop, pdf) {
    var rec = {
      id: uid(), propertyId: prop.id, kind: 'registry', name: cleanDocName(pdf.name, 'application/pdf'),
      mime: 'application/pdf', size: pdf.buf.byteLength, addedAt: Date.now(), blob: new Blob([pdf.buf], { type: 'application/pdf' })
    };
    return Docs.put(rec).then(function () {
      pdf.docId = rec.id;
      pdf.docFailed = '';
      touch(prop); // 사진처럼 매물을 고친 것으로(최근에 고친 순)
      if (view.prop === prop && view.refs.docs) loadDocs(view);
      return rec.id;
    }, function (err) {
      if (!dbBlockedErr(err)) console.warn('서류 저장 실패', err);
      pdf.docFailed = docErrText(err);
      return null;
    });
  }
  /** [서류만 저장]. 실패하면 [다시 시도] 토스트(addDocs 와 같은 모양). model 이 있으면 같은 서류가 이미 있을 때 다시 저장하지 않음 */
  function saveRegistryDocOnly(prop, pdf, model) {
    return (model ? registryDocStep(prop, model, pdf) : saveRegistryDoc(prop, pdf)).then(function (id) {
      if (!id) {
        toast('서류를 저장하지 못했어요. ' + pdf.docFailed, { duration: 30000, action: { label: '다시 시도', fn: function () { saveRegistryDocOnly(prop, pdf); } } });
        return;
      }
      toast(pdf.reused ? '같은 서류가 이미 서류함에 있어요.' : '서류만 저장했어요. 나중에 서류 목록의 [읽기]로 답할 수 있어요.', { duration: 4500 });
    });
  }
  /** 답은 넣었는데 서류 저장만 실패했을 때 [서류 다시 저장]: 저장되면 그 해석 기록에 서류를 잇는다 */
  function retryRegistryDoc(prop, pdf, snapId) {
    saveRegistryDoc(prop, pdf).then(function (id) {
      if (!id) {
        toast('서류를 저장하지 못했어요. ' + pdf.docFailed, { duration: 30000, action: { label: '다시 시도', fn: function () { retryRegistryDoc(prop, pdf, snapId); } } });
        return;
      }
      var s = findSnapshot(prop, snapId);
      if (s && !s.docId) {
        s.docId = id;
        s.t = stampAfter(Date.now(), s.t);
        touch(prop, s.t);
        dirty = true;
        saveNow();
      }
      toast('서류를 저장했어요');
      if (view.name === 'detail' && view.prop === prop) refreshViewSoon();
    });
  }

  /**
   * [이대로 답하기]: (새 PDF 면) 서류 저장 → 기록 넣기 → 이미 답한 항목 덮어쓰기 확인 → 항목 답(applyRegistrySnapshot)
   * → 전유면적 바꾸기 제안 → (골랐으면) 재열람 항목 → 저장·다시 그리기·토스트.
   * pdf: { buf, name, docId(이미 저장된 서류면) } 또는 null(등기부 코드). 결과: Promise<applyRegistrySnapshot 결과>
   */
  /**
   * 1.6.0 검토 반영: 새 PDF 를 서류함에 넣는다. 같은 열람 일시의 기록(dupOf)이 이미 서류를 갖고 있고 그 서류가 남아 있으면
   * 새로 저장하지 않고 그 서류를 쓴다(같은 PDF 를 두 번 올려 서류가 겹치지 않게). 결과: Promise<서류 id | null>
   */
  function registryDocStep(prop, model, pdf) {
    if (!pdf) return Promise.resolve(null);
    if (pdf.docId) return Promise.resolve(pdf.docId);
    var old = model.dupOf && model.dupOf.docId;
    var reuse = old ? Docs.get(old).then(function (rec) { return rec && rec.propertyId === prop.id ? rec.id : null; }, function () { return null; }) : Promise.resolve(null);
    return reuse.then(function (id) {
      if (!id) return saveRegistryDoc(prop, pdf);
      pdf.docId = id;
      pdf.reused = true;
      return id;
    });
  }

  function answerFromRegistry(prop, model, choice, pdf) {
    var unit = registryUnitCheck(prop, model.dong, model.ho);
    var o = { noRefresh: true, titleMismatch: unit.state === 'mismatch' ? unit.label : '' };
    var res = null;
    var area = null;
    var step = registryDocStep(prop, model, pdf);
    return step.then(function (docId) {
      model.snap.docId = docId || (model.dupOf && model.dupOf.docId) || null;
      if (model.dupOf) {
        // 같은 서류를 다시 읽음: 그 기록을 이번에 읽은 것으로 바꿔 넣는다(앞서 넣은 답 표시는 이어받음)
        model.snap.id = model.dupOf.id;
        if (model.dupOf.appliedAt) { model.snap.appliedAt = model.dupOf.appliedAt; model.snap.applied = model.dupOf.applied; }
      }
      if (choice && choice.action === 'record') return null;
      var dry = applyRegistrySnapshot(prop, model.snap, Object.assign({ dryRun: true }, o));
      return dry.skipped.length ? confirmOverwrite(dry.skipped) : {};
    }).then(function (over) {
      // 대화상자를 보는 사이 다른 탭에서 이 매물을 지웠으면 답하지 않는다(탭 병합은 같은 객체를 고치므로 그 밖에는 그대로)
      if (!findProp(prop.id)) throw new Error('매물 없음');
      if (choice && choice.action === 'record') {
        // 1.6.0 검토 반영: 더 최근 등기부가 있을 때 기본 — 답은 그대로 두고 이 서류의 기록만 남긴다
        addRegistrySnapshot(prop, model.snap);
        dirty = true;
        saveNow();
        toast('이 서류의 기록만 남겼어요. 항목 답은 그대로예요.' + (pdf && pdf.docFailed ? ' 서류는 저장하지 못했어요. ' + pdf.docFailed : ''), { duration: 5000 });
        if (view.name === 'detail' && view.prop === prop) refreshViewSoon();
        return 'record';
      }
      if (model.dupOf) addRegistrySnapshot(prop, model.snap);
      res = applyRegistrySnapshot(prop, model.snap, Object.assign({ overwrite: over }, o));
      dirty = true;
      saveNow();
      return askAreaChange(prop, model, unit);
    }).then(function (ac) {
      if (ac === 'record') return { ok: true, recordOnly: true, applied: [], skipped: [] };
      area = ac;
      if (ac.changed && ac.near) { // 반올림 차이로 면적을 맞췄으니 "표제부 일치"를 다시 본다(이미 넣은 답은 같으면 그대로)
        var res2 = applyRegistrySnapshot(prop, findSnapshot(prop, res.snapshotId) || model.snap, o);
        res2.applied.forEach(function (a) { res.applied.push(a); });
      } else if (ac.changed && CL.itemById['reg-title']) {
        // 1.6.0 검토 반영: 차이가 큰데 바꿈 — "표제부 일치"는 체크하지 않고, 바꾼 사실(원래 면적)을 메모에 남긴다
        var snapNow = findSnapshot(prop, res.snapshotId) || normalizeSnapshot(model.snap);
        var tmemo = snapMemoBlock(getItemState(prop, 'reg-title').memo, [SNAP_MEMO_HEAD + ' · ' + regViewedText(snapNow.viewedAt, snapNow.docType) + ']',
          '· 매물 정보 ' + ac.from + '㎡를 등기부 ' + numOrNull(model.area) + '㎡로 바꿈(차이 큼) — 다른 호수의 서류가 아닌지 확인한 뒤 직접 체크하세요']);
        if (tmemo !== str(getItemState(prop, 'reg-title').memo).trim()) setItemState(prop, 'reg-title', { memo: tmemo });
      }
      var re = choice && choice.stage && model.diff && model.diff.res && model.diff.res.ok
        ? applyRecheck(prop, choice.stage, model, choice) : null;
      dirty = true;
      saveNow();
      var msg = [res.applied.length ? '등기부로 항목 ' + res.applied.length + '개에 답했어요.' : '새로 답한 항목은 없어요(이미 같은 답).'];
      if (res.skipped.length) msg.push('이미 다르게 답한 ' + res.skipped.length + '개는 그대로 뒀어요.');
      if (area.changed) msg.push('매물 면적을 등기부 값으로 바꿨어요' + (area.near ? '.' : '("표제부 일치"는 직접 확인).'));
      if (re) {
        var rp = [];
        if (re.checked) rp.push('재열람 항목을 체크했어요');
        if (re.flag === 'yes') rp.push('"달라진 기록 있음"으로 표시했어요');
        else if (re.flag === 'no') rp.push('달라진 기록 없음');
        else if (re.kept) rp.push('"달라진 기록"은 지금 답(있음)을 그대로 뒀어요');
        if (rp.length) msg.push(re.stage.label + ' 재열람: ' + rp.join(', ') + '.');
      }
      if (pdf && pdf.docFailed) {
        msg.push('서류는 저장하지 못했어요. ' + pdf.docFailed);
        toast(msg.join(' '), { duration: 30000, action: { label: '서류 다시 저장', fn: function () { retryRegistryDoc(prop, pdf, res.snapshotId); } } });
      } else toast(msg.join(' '), { duration: 6000 });
      if (view.name === 'detail' && view.prop === prop) refreshViewSoon();
      return res;
    }).catch(function (err) {
      if (err && err.message === '매물 없음') toast('그사이 이 매물이 지워져서 등기부로 답하지 못했어요.', { duration: 5000 });
      else { console.warn('등기부 답하기 실패', err); toast('등기부로 답하다 문제가 생겼어요. 다시 해 보세요.', { duration: 5000 }); }
      return null;
    });
  }

  /** 등기부 해석 결과(R) → (실패면 서류만 저장할지 묻고) 미리보기 → 답하기/서류만 저장. pdf: { buf, name, docId|null } */
  function handleRegistryParse(prop, R, pdf) {
    var saved = !!pdf.docId;
    if (!R || !R.ok) {
      var photoLike = !!R && (R.error === 'no-text' || R.error === 'not-registry');
      var buttons = saved ? [] : [{ label: '서류만 저장', value: 'doc' }];
      if (photoLike && IMP && IMP.REGISTRY_PROMPT) buttons.push({ label: '등기부 요청문 복사', value: null, kind: 'secondary', keepOpen: true, action: copyRegistryPrompt });
      buttons.push({ label: saved ? '닫기' : '취소', value: null, kind: 'secondary' });
      return openDialog({
        title: '등기부로 읽지 못했어요',
        message: ((R && R.message) || '읽다가 문제가 생겼어요.') +
          (photoLike ? '\n\n등기부를 사진으로 찍었거나 스캔했다면 [등기부 요청문 복사] → Claude 채팅에 함께 보내고, 받은 등기부 코드를 [글·코드로 추가]에 붙여 넣으세요.' : ''),
        buttons: buttons
      }).then(function (r) { if (r.value === 'doc') return saveRegistryDocOnly(prop, pdf); });
    }
    var model = prepareRegistryModel(prop, registryModelFromPdf(R));
    return registryPreview(prop, model, { withDoc: !saved }).then(function (choice) {
      if (choice.action === 'apply' || choice.action === 'record') return answerFromRegistry(prop, model, choice, pdf);
      if (choice.action === 'doc') return saveRegistryDocOnly(prop, pdf, model);
    });
  }

  /** 올린 PDF 한 개를 읽어 미리보기까지(읽는 동안 토스트) */
  function readRegistryUpload(prop, file) {
    var seq = toast('등기부 PDF를 읽는 중…', { duration: 0 });
    function done() { if (shownToast() === seq) hideToast(); }
    return blobToArrayBuffer(file).then(function (buf) {
      return parseRegistryPdf(buf).then(function (R) {
        done();
        return handleRegistryParse(prop, R, { buf: buf, name: file.name, docId: null });
      });
    }, function (err) {
      done();
      console.warn('파일 읽기 실패', err);
      toast('파일을 읽지 못했어요. 다시 골라 주세요.', { duration: 5000 });
    });
  }
  /** 서류 목록의 [읽기]: 이미 저장한 등기부 PDF 를 다시 읽는다(서류는 그대로) */
  function readSavedRegistryDoc(prop, rec) {
    if (!rec.blob) return;
    var seq = toast('등기부 PDF를 읽는 중…', { duration: 0 });
    blobToArrayBuffer(rec.blob).then(function (buf) {
      return parseRegistryPdf(buf).then(function (R) {
        if (shownToast() === seq) hideToast();
        return handleRegistryParse(prop, R, { buf: buf, name: rec.name, docId: rec.id });
      });
    }).catch(function (err) {
      if (shownToast() === seq) hideToast();
      console.warn('서류 읽기 실패', err);
      toast('서류를 읽지 못했어요. 다시 해 보세요.', { duration: 5000 });
    });
  }

  /**
   * [서류 올리기]: 등기부 PDF(파일 이름이 건축물대장·계약서가 아닌 PDF)는 하나씩 읽어 미리보기, 그 밖(사진 등)은 서류로만 저장(addDocs).
   * 사진은 앱이 읽지 못한다 → 서류 카드에 "Claude 로 등기부 코드" 안내가 보인다(renderDocList)
   */
  function uploadDocs(prop, files) {
    var pdfs = [];
    var rest = [];
    files.forEach(function (f) {
      var mime = docMime(f);
      if (mime === 'application/pdf' && guessDocKind(f.name, mime) === 'registry' && f.size <= DOC_MAX_BYTES) pdfs.push(f);
      else rest.push(f);
    });
    var chain = Promise.resolve();
    pdfs.forEach(function (f) { chain = chain.then(function () { return readRegistryUpload(prop, f); }); });
    if (rest.length) chain = chain.then(function () { return addDocs(prop, rest); });
    return chain.catch(function (err) { console.warn('서류 올리기 실패', err); });
  }

  function copyRegistryPrompt() {
    if (!IMP || !IMP.REGISTRY_PROMPT) return;
    copyText(IMP.REGISTRY_PROMPT, { ok: '등기부 요청문을 복사했어요. Claude 채팅에 붙여 넣고 등기부 사진을 함께 보내세요.', title: '등기부 요청문' });
  }
  /** "사진은 앱이 읽지 못해요" 안내(서류 카드). Claude 로 등기부 코드를 받아 [글·코드로 추가]에 붙여 넣는 길 */
  function registryPhotoTip() {
    return h('div', { class: 'notice notice-info doc-photo-tip', role: 'note' },
      h('strong', { text: '사진은 앱이 읽지 못해요' }),
      h('p', { text: '등기부 사진이면 [등기부 요청문 복사]를 눌러 Claude 채팅에 사진과 함께 보내고, Claude가 준 등기부 코드를 [글·코드로 추가]에 붙여 넣으세요. 인터넷등기소 PDF를 올리면 앱이 바로 읽어요.' }),
      h('div', { class: 'btn-row' },
        IMP && IMP.REGISTRY_PROMPT ? h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: copyRegistryPrompt }, icon('copy', 'ic-sm'), '등기부 요청문 복사') : null,
        h('a', { class: 'btn btn-small btn-ghost', href: '#/import' }, '글·코드로 추가')));
  }

  /**
   * 매물 정보 [완료] 때 매도인 이름이 바뀌었으면: 가장 최근 등기부 기록의 소유자와 비교해
   * "소유자 ≠ 매도인"이 비어 있으면 답하고(메모에 앱이 비교했다고 남김, 이름은 적지 않음), 이미 다른 답이면 바꿀지 토스트로 묻는다.
   * 1.6.0 검토 반영: 가장 최근 기록 하나만 본다(그 기록에서 소유자를 못 읽었다고 예전 기록의 옛 소유자와 비교하지 않음).
   * 그 기록의 소유자가 비었거나 계산이 불확실(ownersUncertain)하면 "없음"은 답하지 않고 알린다
   */
  function ownerDiffAfterSellerEdit(prop) {
    var it = CL.itemById['reg-owner-diff'];
    var sellers = sellerNames(prop.sellerName);
    if (!it || !sellers.length) return;
    var snap = registrySnapshotsOf(prop)[0];
    if (!snap) return;
    var owners = snap.owners || [];
    var match = owners.length > 0 && sellers.every(function (n) { return owners.some(function (o) { return samePerson(o.name, n); }); });
    if (!owners.length || (match && snap.ownersUncertain)) {
      toast('최근 등기부(' + regViewedText(snap.viewedAt, snap.docType) + ')에서 소유자를 확실히 읽지 못해 매도인 이름과 비교하지 않았어요. 원본 갑구를 직접 보세요.', { duration: 6000 });
      return;
    }
    var v = match ? 'no' : 'yes';
    var cur = getItemState(prop, it.id).status;
    if (cur === v) return;
    var name = '"' + (it.shortTitle || it.text) + '"';
    function put() {
      setItemState(prop, it.id, { status: v });
      var lines = [SNAP_MEMO_HEAD + ' · ' + regViewedText(snap.viewedAt, snap.docType) + ']', match
        ? '· 매도인 이름이 등기부 소유자와 같아요(앱이 비교, 공백·괄호 무시)'
        : '· 매도인 이름과 같은 소유자가 등기부에 없어요(앱이 비교, 공백·괄호 무시) — 이유가 풀리기 전에는 진행하지 마세요'];
      var memo = snapMemoBlock(getItemState(prop, it.id).memo, lines);
      if (memo !== str(getItemState(prop, it.id).memo).trim()) setItemState(prop, it.id, { memo: memo });
      dirty = true;
      saveNow();
    }
    var head = match ? '매도인 이름이 등기부 소유자와 같아요. ' : '매도인 이름이 등기부 소유자와 달라요. ';
    if (cur !== 'yes' && cur !== 'no') {
      put();
      toast(head + name + '을 "' + regAnsText(v) + '"으로 답했어요.', { duration: 5000 });
      return;
    }
    toast(head + name + ' 답을 "' + regAnsText(v) + '"으로 바꿀까요?', {
      duration: 10000,
      action: { label: '바꾸기', fn: function () {
        put();
        toast(name + '을 "' + regAnsText(v) + '"으로 바꿨어요.');
        if (view.name === 'detail' && view.prop === prop) refreshViewSoon();
      } }
    });
  }

  /** 상세 등기부 섹션 머리 아래 "등기부 기록 N개 · 마지막 열람 …" + [기록 보기]. 기록이 없으면 null */
  function registrySnapLine(prop) {
    var list = registrySnapshotsOf(prop);
    if (!list.length) return null;
    var last = list[0];
    return h('div', { class: 'reg-snaps' },
      h('span', { class: 'reg-snaps-text', text: '등기부 기록 ' + list.length + '개 · 마지막 ' + (last.viewedAt ? regViewedText(last.viewedAt, last.docType) : '기록 ' + formatDateTime(last.addedAt)) }),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost reg-snaps-btn', onclick: function () { showRegistryHistory(prop); } }, '기록 보기'));
  }
  /** 기록 한 개의 요약(사람 이름 없이): 살아 있는 멈춤 기록·근저당·전세권·소유자 수 */
  function snapRiskSummary(s) {
    var count = {};
    (s.live || []).forEach(function (e) { if (e.kind) count[e.kind] = (count[e.kind] || 0) + 1; });
    var stops = REG_STOP_KINDS.filter(function (k) { return count[k]; }).map(function (k) { return REG_KIND_LABEL[k] + ' ' + count[k] + '건'; });
    var parts = [stops.length ? '살아 있는 멈춤 기록: ' + stops.join(', ') : '살아 있는 멈춤 기록 없음'];
    if (count.mortgage) parts.push('근저당 ' + count.mortgage + '건');
    if (count.jeonse) parts.push('전세권 ' + count.jeonse + '건');
    if (s.owners && s.owners.length) parts.push('소유자 ' + s.owners.length + '명');
    return parts.join(' · ');
  }
  /** [기록 보기]: 해석 기록 목록(최근 열람 순)과 앞 기록과의 차이, 기록 지우기 */
  function showRegistryHistory(prop) {
    var list = registrySnapshotsOf(prop);
    if (!list.length) return;
    var toDelete = null;
    var items = list.map(function (s, i) {
      var older = list[i + 1] || null;
      var d = older && REG ? REG.diffRegistry(diffInputOf(older), diffInputOf(s)) : null;
      var dText = !older ? '처음 기록'
        : !d ? ''
          : !d.ok ? (d.error === 'different' ? '앞 기록과 고유번호가 달라요(다른 집 등기부일 수 있어요)' : '앞 기록과 비교하지 못했어요')
            // 1.6.0 검토 반영: 기록 이름은 종류와 순위번호만(등기목적의 사람 이름을 보이지 않게)
            : d.changed ? '앞 기록과 달라요 — ' + [d.newRisks.length ? '새 기록 ' + d.newRisks.map(regEntrySafeLabel).join(', ') : '', d.ownerChanged ? '소유자가 바뀜' : ''].filter(Boolean).join(' · ')
              : '앞 기록과 달라진 기록 없음' + (d.cancelledSince.length ? '(그 사이 말소 ' + d.cancelledSince.length + '건)' : '');
      return h('li', { class: 'rh-item' },
        h('p', { class: 'rh-when' },
          h('strong', { text: regViewedText(s.viewedAt, s.docType) }),
          h('span', { class: 'rh-src', text: ' · ' + [snapSourceLabel(s), s.docType, s.includesCancelled === true ? '말소사항 포함' : s.includesCancelled === false ? '현재 유효사항' : ''].filter(Boolean).join(' · ') })),
        h('p', { class: 'rh-sum', text: snapRiskSummary(s) }),
        dText ? h('p', { class: 'rh-diff' + (d && d.ok && d.changed ? ' is-changed' : ''), text: dText }) : null,
        h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', onclick: function () { toDelete = s; closeAllDialogs(); } },
          icon('trash', 'ic-sm'), '이 기록 지우기'));
    });
    openDialog({
      title: '등기부 기록 ' + list.length + '개',
      content: h('div', { class: 'rh' },
        h('p', { class: 'small muted', text: '최근 열람 순이에요. 앞 기록과 순위번호로 비교해요. 기록을 지워도 항목 답·메모와 서류는 그대로예요.' }),
        h('ol', { class: 'rh-list' }, items)),
      buttons: [{ label: '닫기', value: null, kind: 'secondary' }]
    }).then(function () {
      if (!toDelete) return null;
      var s = toDelete;
      return confirmDialog({
        title: '이 등기부 기록을 지울까요?',
        message: regViewedText(s.viewedAt, s.docType) + ' · ' + snapSourceLabel(s) + '\n\n항목 답·메모와 서류는 그대로 남아요.',
        confirmText: '지우기', danger: true
      }).then(function (ok) {
        if (!ok || !removeRegistrySnapshot(prop, s.id)) return;
        dirty = true;
        saveNow();
        toast('등기부 기록을 지웠어요');
        if (view.name === 'detail' && view.prop === prop) refreshViewSoon();
      });
    });
  }

  /**
   * 등기부 코드(가져오기)를 넣을 매물 고르기: 고유번호(그 매물의 지난 기록) > 동·호 > 단지명.
   * 동이나 호가 양쪽에 있는데 다르면 후보에서 뺀다. 가장 잘 맞는 매물이 하나뿐일 때만 { prop, why }, 아무것도 맞지 않으면 null.
   * 1.6.0 검토 반영: 가장 잘 맞는 매물이 여럿이면(동점) { prop: null, tie: [매물…], why } — "맞는 매물이 여러 개예요"로 알린다
   */
  function matchRegistryTarget(s, props) {
    var m = s.match || {};
    var nk = nameKey(m.name);
    var best = null;
    var tied = [];
    props.forEach(function (p) {
      var score = 0;
      var why = '';
      var dKnown = !!(m.dong && p.dong);
      var hKnown = !!(m.ho && p.ho);
      var dOk = dKnown && unitKey(m.dong) === unitKey(p.dong);
      var hOk = hKnown && unitKey(m.ho) === unitKey(p.ho);
      var pk = nameKey(p.name);
      var nOk = !!(nk && pk && (pk.indexOf(nk) >= 0 || nk.indexOf(pk) >= 0));
      if (s.uniqueNo && registrySnapshotsOf(p).some(function (x) { return x.uniqueNo === s.uniqueNo; })) { score = 100; why = '고유번호가 같은 등기부 기록이 있어요'; }
      else if ((dKnown && !dOk) || (hKnown && !hOk)) score = 0;
      else if (dOk && hOk) { score = 50 + (nOk ? 5 : 0); why = '동·호가 같아요'; }
      else if (nOk) { score = 10 + (dOk ? 5 : 0); why = '단지명이 같아요' + (dOk ? '(동도 같음)' : ''); }
      if (!score) return;
      if (!best || score > best.score) { best = { prop: p, why: why, score: score }; tied = [p]; }
      else if (score === best.score) tied.push(p);
    });
    if (!best) return null;
    return tied.length > 1 ? { prop: null, tie: tied, why: best.why, score: best.score } : best;
  }

  /**
   * 1.6.0: 다른 탭이 예전 버전 앱으로 사진 DB 를 열어 두어 업그레이드(서류함 추가)가 막혔을 때의 안내 띠.
   * 그 탭이 닫히면 저절로 풀리고(IDB onsuccess) 지금 화면을 다시 그려 사진·서류를 불러온다
   */
  function showDbBlocked(on) {
    var el = document.getElementById('db-blocked');
    if (on) {
      if (el) return;
      el = h('div', { class: 'db-blocked', id: 'db-blocked', role: 'alert' },
        h('strong', { text: '다른 탭(창)에 예전 버전 앱이 열려 있어요' }),
        h('span', { text: ' 사진·서류 저장소를 새 버전으로 바꾸려면 그 탭을 닫거나 새로고침해 주세요. 그동안 사진·서류는 보거나 저장할 수 없어요(체크 기록은 그대로 저장돼요).' }));
      var se = $('#save-error');
      if (se && se.parentNode) se.parentNode.insertBefore(el, se.nextSibling);
      else document.body.insertBefore(el, document.body.firstChild);
      return;
    }
    if (!el) return;
    el.remove();
    document.documentElement.classList.remove('no-photos');
    toast('사진·서류 저장소를 새 버전으로 맞췄어요');
    refreshViewSoon(); // 막혀 있는 동안 못 읽은 사진·서류를 다시 읽는다
    setTimeout(cleanDeletedPhotos, 2500); // 막혀 있는 동안 못 한 남은 사진·서류 정리
  }

  // ---------------- 요약 ----------------
  function collectSummary(prop) {
    var S = {
      stops: [], cautionFlags: [], contractFlags: [], refFlags: [], rateCautions: [], contractCautions: [], refCautions: [],
      answered: [], unanswered: [], visits: [], memos: [], sectionMemos: []
    };
    CL.sections.forEach(function (sec) {
      sec.items.forEach(function (it) {
        var st = getItemState(prop, it.id);
        var row = { it: it, st: st, sec: sec };
        // 1.5.0: 항목 cautionUse 가 섹션 값보다 우선('reference' = 가격 판단 참고, 특약 대상 아님)
        var useRef = (it.cautionUse || sec.cautionUse) === 'reference';
        if (it.type === 'flag' && st.status === 'yes') {
          (it.severity === 'stop' ? S.stops : S.cautionFlags).push(row);
          // 주의 신호를 특약으로 풀 수 있는 것(contractFlags)과 참고용(refFlags)으로 나눠 둔다(cautionFlags 는 둘 다)
          if (it.severity !== 'stop') (useRef ? S.refFlags : S.contractFlags).push(row);
        }
        else if (it.type === 'rate' && st.status === 'caution') {
          S.rateCautions.push(row);
          // 집 안처럼 고칠 수 있는 것은 협상·특약 후보, 동네·단지는 가격 판단 참고(특약으로 바꿀 수 없음)
          (useRef ? S.refCautions : S.contractCautions).push(row);
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
    // 1.5.0(L8): 비어 있는 카드는 한 줄(제목 · 0개 · 설명)로 줄인다(첫날 요약이 0개 카드 5개로 길지 않게)
    return h('section', { class: 'card' + (has ? '' : ' sum-card-empty') },
      h('h2', { class: 'card-title' }, title, count !== null && count !== undefined ? h('span', { class: 'count', text: count + '개' }) : null),
      has ? children : h('p', { class: 'sum-empty', text: emptyText })
    );
  }

  /**
   * 1.5.0(L8): 요약 맨 위 한 줄 — 아직 체크한 것이 거의 없을 때(아무것도 안 봤거나, 등기부 멈춤 신호가 남았고 진행 15% 미만).
   * [등기부 보기]는 상세로 돌아가 등기부 섹션을 열고 스크롤(pendingSection). 탈락 매물·등기부 섹션 없는 데이터면 null
   */
  function summaryIntro(prop, o) {
    if (prop.status === 'dropped') return null;
    var gates = gateSections();
    if (!gates.length) return null;
    var gs = gateStopState(prop);
    var low = o.done === 0 || (gs.unanswered > 0 && o.pct < 15);
    if (!low) return null;
    return h('div', { class: 'sum-intro', role: 'note' },
      h('p', { text: '등기부 확인부터 하면 여기에 위험 신호·특약 후보가 정리돼요.' }),
      h('button', {
        type: 'button', class: 'btn btn-small btn-secondary',
        onclick: function () { pendingSection = gates[0].id; goBack('/p/' + prop.id, true); }
      }, '등기부 보기'));
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

    appendKid(main, summaryIntro(prop, o)); // 1.5.0(L8): 진행이 거의 없을 때 맨 위 한 줄
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

    // 협상·특약 후보 = 등기부 주의 신호 가운데 특약으로 풀 수 있는 것(근저당 말소·전세권 정리 등) + 집 안 "주의" 항목 + 메모 + 사진.
    // 1.5.0(L37): 특약으로 풀 수 없는 주의 신호(data.js cautionUse 'reference': 잦은 소유자 변경, 지난 기록)는 아래 "가격 판단 참고"로(S.refFlags)
    var cand = S.contractFlags.map(function (r) { return sumRow(r, 'is-caution', '주의 신호', true); })
      .concat(S.contractCautions.map(function (r) { return sumRow(r, 'is-caution', null, true); }));
    main.append(sumCard('협상·특약 후보', cand.length,
      cand.length ? [
        h('p', { class: 'muted small', text: '등기부 주의 신호는 해결 방법(예: 잔금일에 갚고 말소)을 특약에 적고, 집 안 "주의" 항목은 수리 특약이나 가격 협상 근거로 써요.' }),
        h('ul', { class: 'sum-list' }, cand)
      ] : null,
      '등기부 주의 신호나 집 안에서 "주의"로 표시한 항목이 없어요.'));

    // 가격 판단 참고 = 특약으로 풀 수 없는 등기부 주의 신호(1.5.0 L37, S.refFlags) + 동네·단지 "주의" (특약으로 고칠 수 없는 것)
    var refRows = S.refFlags.map(function (r) { return sumRow(r, 'is-caution', '주의 신호', true); })
      .concat(S.refCautions.map(function (r) { return sumRow(r, '', null, true); }));
    if (refRows.length) {
      main.append(sumCard('가격 판단 참고 (특약 대상 아님)', refRows.length, [
        h('p', { class: 'muted small', text: '동네·단지에서 "주의"로 표시한 항목과, 특약으로 풀 수 없는 등기부 주의 신호(잦은 소유자 변경·지난 기록)예요. 계약서로 고칠 수 없으니 이 집을 고를지, 가격이 맞는지 판단할 때 참고하세요.' }),
        h('ul', { class: 'sum-list' }, refRows)
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
    // 1.5.0(L37): 협상·특약 후보에는 특약으로 풀 수 있는 주의 신호만(contractFlags). 참고용 주의 신호(refFlags)는 가격 판단 참고로
    block('협상·특약 후보', S.contractFlags.map(function (r) { return '- [등기부] ' + r.it.text + withMemo(r) + photoNote(r); })
      .concat(S.contractCautions.map(function (r) { return '- ' + r.it.text + withMemo(r) + photoNote(r); })));
    block('가격 판단 참고 (특약 대상 아님)', S.refFlags.map(function (r) { return '- [등기부] ' + r.it.text + withMemo(r) + photoNote(r); })
      .concat(S.refCautions.map(function (r) { return '- ' + r.it.text + withMemo(r) + photoNote(r); })));
    block('질문과 답변', S.answered.map(function (r) { return '- Q. ' + r.it.text + '\n  A. ' + r.st.answer.trim().replace(/\r?\n/g, '\n     '); }));
    // 1.5.0(L33): 미답 질문은 16줄 대신 한 줄(가족에게 보내는 글에 질문 목록은 필요 없음. 앱의 요약 화면에 접힌 목록이 있음)
    if (S.unanswered.length) { lines.push(''); lines.push('■ 아직 답 못 받은 질문 ' + S.unanswered.length + '개(앱에서 보기)'); }
    block('재방문 기록', S.visits.map(function (r) {
      return '- [' + visitLabel(r.st) + '] ' + r.it.text + (r.st.date ? ' (' + formatISODate(r.st.date) + ')' : '') + withMemo(r);
    }));
    // 1.7.0: 돈 계산(추정). 숫자만 넣고(판정 없음), 사람 이름은 넣지 않는다
    block('돈 계산 (추정)', finShareLines(prop));
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

  // ---------------- 1.7.0 대출·비용 (finance.js) ----------------
  // 상세 '대출·비용' 카드(finCard), 홈 카드 KB 칩, 비교 열, 공유 글, 다시 붙여넣기 갱신(refresh*)이 같이 쓴다.
  // 모든 수치는 추정이다. 어느 집을 사라·사지 말라는 판정은 하지 않는다(사실과 숫자만, 가장 낮은 값 강조도 하지 않음).
  // 매물 값(KB시세·협상가·리모델링비·공시가격)은 fieldsAt 시각을 남기고(합치기), 대출 조건은 state.settings(financeAt)에 둔다.
  var finCache = {}; // 매물id → { key(입력 서명), val(finCalc 결과) }
  var FIN_OPEN_KEY = 'imjang.fin.open'; // 상세 '대출·비용' 카드를 펼쳐 두었는지(sessionStorage)
  var HIST_SOURCE_LABEL = { naver: '네이버 글', code: 'Claude 코드', manual: '직접 입력' };

  /** 이력의 출처: 네이버 글(또는 네이버 글로 만든 코드)이면 'naver', Claude 코드면 'code' */
  function finSourceOf(res) { return res && res.source === 'naver' ? 'naver' : 'code'; }
  /** ms → 이 기기 날짜 'YYYY-MM-DD' (없으면 '') */
  function isoDateOf(ms) {
    if (!(ms > 0)) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * 가져오기 결과 매물(p, import-parser 가 정리한 값)의 1.7.0 값을 새 매물 원본(raw)에 넣는다.
   * KB시세 기준일이 없으면 가져온 날(today). 첫 이력(KB시세·호가)과 가져오기 시각(syncAt)도 남긴다. t: 그 매물의 시각
   */
  function importFinInto(raw, p, hsrc, today, t) {
    var sync = {};
    FIN_TIMED.forEach(function (k) {
      if (k === 'dealPrice' || k === 'remodelCost' || k === 'publicPrice') return; // 사용자가 넣는 칸
      if (p[k] === null || p[k] === undefined || p[k] === '') return;
      raw[k] = p[k];
      sync[k] = t;
    });
    if (raw.kbPrice) {
      raw.kbAt = isoDateOr(p.kbAt) || today;
      raw.kbSource = hsrc;
      raw.kbHistory = [{ value: raw.kbPrice, at: raw.kbAt, source: hsrc, t: t }];
    }
    if (p.askPrice) { raw.askHistory = [{ value: p.askPrice, at: today, source: hsrc, t: t }]; sync.askPrice = t; }
    if (p.realPrice) sync.realPrice = t;
    raw.syncAt = sync;
  }

  /**
   * 1.7.0 검토 반영: 재산세를 계산할 해 = 지금 사는 사람이 처음 내는 해. 재산세는 6월 1일에 가진 사람이 그해 몫을 내므로
   * 6월 이후(오늘이 6~12월)면 다음 해분, 1~5월이면 그해분. 2026-10 이면 2027년분(지금 법 그대로: 비율 60%·표준세율)
   */
  function finTaxYear() {
    var d = new Date();
    return d.getMonth() >= 5 ? d.getFullYear() + 1 : d.getFullYear();
  }
  /** 지금 대출 조건(finance.js 기본값 + 사용자가 바꾼 값) */
  function finSettings() { return FIN ? FIN.normalizeSettings(state.settings && state.settings.finance) : null; }
  /** 계산에 쓰는 매매가: 협상가가 있으면 협상가, 없으면 호가(만원) */
  function finPrice(p) { return p.dealPrice || p.askPrice || null; }
  /** 관리비 월평균(원): 관리비 묶음의 월 평균, 없으면 기본 정보의 관리비 */
  function finFeeWon(p) { return p.feeAvg || p.feeMonthly || null; }

  /**
   * 매물 하나의 추정치 → { settings, price, priceKind('deal'|'ask'|''), cash(cashNeeded|null), limit(loanLimit|null),
   *   pay(payment|null), hold(holdingCost|null) } | null(finance.js 없음). 입력이 같으면 다시 계산하지 않는다(홈 정렬·비교에서 여러 번 부름)
   */
  function finCalc(p) {
    if (!FIN) return null;
    var taxYear = finTaxYear();
    var key = [JSON.stringify(state.settings && state.settings.finance || null), p.askPrice, p.dealPrice, p.kbPrice, p.area,
      p.remodelCost, p.publicPrice, p.feeAvg, p.feeMonthly, taxYear].join('|');
    var c = hasOwn(finCache, p.id) ? finCache[p.id] : null;
    if (c && c.key === key) return c.val;
    var s = finSettings();
    var price = finPrice(p);
    var fee = finFeeWon(p);
    var cash = price ? FIN.cashNeeded({ price: price, kb: p.kbPrice, areaM2: p.area, remodel: p.remodelCost || 0, feeAvg: fee,
      publicPrice: p.publicPrice, settings: s }) : null;
    if (cash && !cash.ok) cash = null;
    var limit = cash ? cash.loanInfo : FIN.loanLimit({ price: price, kb: p.kbPrice, settings: s });
    if (limit && !limit.ok) limit = null;
    var hold = FIN.holdingCost({ price: price, kb: p.kbPrice, publicPrice: p.publicPrice, feeAvg: fee,
      loan: cash ? cash.loan : (limit ? limit.limit : null), settings: s, year: taxYear });
    if (!hold.ok) hold = null;
    var pay = cash ? cash.payment : (hold && hold.payment ? hold.payment : null);
    if (pay && !pay.ok) pay = null;
    var val = { settings: s, price: price, priceKind: p.dealPrice ? 'deal' : p.askPrice ? 'ask' : '', cash: cash, limit: limit, pay: pay, hold: hold };
    finCache[p.id] = { key: key, val: val };
    return val;
  }
  function finCashOf(p) { var c = finCalc(p); return c && c.cash ? c.cash.cash : null; }
  /** 호가가 KB시세보다 몇 % 높은지(둘 다 있어야). 정렬용 숫자일 뿐 판정이 아니다 */
  function kbGapOf(p) { return p.askPrice && p.kbPrice ? (p.askPrice - p.kbPrice) / p.kbPrice * 100 : null; }

  /** 만원 → '1억 2,775만원'·'64.7만원'(소수가 있으면 한 자리)·'7,500원'. 숫자가 아니면 '-' */
  function manText(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    var t = FIN ? FIN.formatMan(v, Math.round(Math.abs(v) * 10) % 10 ? 1 : 0) : formatManwon(v);
    return /[억만]$/.test(t) ? t + '원' : t;
  }
  /** 원 → '13만 8,552원' · '15만원' */
  function wonText(won) {
    if (typeof won !== 'number' || !isFinite(won) || won <= 0) return '-';
    var man = Math.floor(won / 10000);
    var rest = won % 10000;
    return (man ? formatNumber(man) + '만' + (rest ? ' ' : '') : '') + (rest ? formatNumber(rest) : '') + '원';
  }
  /** 홈 카드 칩용 짧은 KB시세: '2억 3,450' (1억 미만은 '9,500만') */
  function kbShort(v) {
    var t = FIN ? FIN.formatMan(v) : formatManwon(v).replace(/원$/, '');
    return /억/.test(t) ? t.replace(/만$/, '') : t;
  }
  function rateText(r) {
    if (!r) return '';
    return r.min + '%' + (r.max !== null && r.max !== undefined && r.max !== r.min ? '~' + r.max + '%' : '') + (r.bank ? ' · ' + r.bank : '');
  }
  /** 'YYYY-MM' → '2026년 7월' */
  function monthText(m) { var x = /^(\d{4})-(\d{2})$/.exec(str(m)); return x ? x[1] + '년 ' + parseInt(x[2], 10) + '월' : str(m); }
  /** 기간 표시: 30 → '30년', 30.5 → '30.5년' (전에는 Math.round 로 '31년') */
  function yearsText(y) { return (Math.round(y * 10) / 10) + '년'; }
  /** 계산에 실제로 쓰는 LTV·기간(규칙상 최대를 넘으면 finance.js 가 낮춘 값). c: finCalc 결과(없어도 됨) */
  function finUsed(s, c) {
    var ltv = c && c.limit ? c.limit.ltv : Math.min(s.ltv, FIN.suggestLtv(s));
    var maxY = FIN.RULES.capitalMaxYears;
    var years = c && c.pay ? c.pay.years : ((s.capitalArea || s.regulated) && s.years > maxY ? maxY : s.years);
    return { ltv: ltv, years: years };
  }
  /**
   * 대출 조건 한 줄: 'LTV 70% · 연 4.5% · 30년 · 원리금균등 · 생애최초 · 방공제 과밀억제권역 4,800만 · 수도권 · 특별·광역시'.
   * 1.7.0 검토 반영: 넣은 값이 아니라 실제 계산에 쓴 LTV·기간을 적고, 다르면 넣은 값을 함께 적는다(카드·공유 글이 같은 문구)
   *   예 'LTV 40%(규칙상 최대. 넣은 값 70%) · … · 30년(수도권·규제지역 최대. 넣은 값 40년)'
   */
  function finCondText(s, c) {
    if (!s || !FIN) return '';
    var bg = null;
    FIN.BANG_GONGJE.forEach(function (b) { if (b.key === s.bangGongje) bg = b; });
    var u = finUsed(s, c);
    return ['LTV ' + u.ltv + '%' + (u.ltv !== s.ltv ? '(규칙상 최대. 넣은 값 ' + s.ltv + '%)' : ''),
      '연 ' + s.ratePct + '%',
      yearsText(u.years) + (u.years !== s.years ? '(수도권·규제지역 최대. 넣은 값 ' + yearsText(s.years) + ')' : ''),
      FIN.METHOD_LABEL[s.method] || '',
      s.firstHome ? '생애최초' : '생애최초 아님', s.birthRelief ? '출산·양육 감면' : '',
      bg ? (bg.key === 'none' ? '방공제 빼지 않음' : '방공제 ' + bg.label) : '',
      s.regulated ? '규제지역' : s.capitalArea ? '수도권' : '지방', s.metroCity ? '특별·광역시' : ''].filter(Boolean).join(' · ');
  }

  /** 값 이력에 한 줄 더한다(합치기와 같은 규칙: 날짜·값·출처·시각이 같으면 하나, 최근 HISTORY_MAX 개) */
  function pushHistory(list, e) {
    if (MG && MG.mergeHistory) return MG.mergeHistory(list, [e]);
    var out = (Array.isArray(list) ? list : []).concat([e]);
    return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
  }
  /** 이력의 마지막 값이 지금 값과 다르면(직접 고쳤거나 예전 버전이 넣은 값) 지금 값을 먼저 남긴다 */
  function keepCurrentInHistory(prop, histKey, cur, at, source, t) {
    var list = Array.isArray(prop[histKey]) ? prop[histKey] : [];
    var last = list.length ? list[list.length - 1] : null;
    if (cur === null || cur === undefined || (last && last.value === cur)) return;
    var e = { value: cur, at: at || '', source: source };
    if (t > 0) e.t = t;
    prop[histKey] = pushHistory(list, e);
  }

  /** 대출·비용 칸 하나를 바꾸고 시각을 남긴다(합치기: 칸마다 더 나중에 고친 쪽) */
  function setFinField(prop, key, value) {
    if (sameValue(prop[key], value)) return;
    var t = prop.fieldsAt[key] = stampAfter(Date.now(), prop.fieldsAt[key], prop.legacyAt);
    prop[key] = value;
    touch(prop, t);
  }
  /**
   * KB시세를 직접 넣거나(값) 지운다(null). 직접 넣은 값은 출처 'manual', 기준일은 오늘. 바꿨으면 true.
   * 1.7.0 검토 반영: 지금 값과 같으면 아무것도 바꾸지 않는다(전에는 값 그대로 [저장]만 눌러도 출처가 '직접 입력'이 되고
   * 이력이 한 줄씩 늘어, 다시 붙여넣기에서 '직접 고친 값'으로 나오고 처음 가져온 이력이 밀려났음)
   */
  function setKbManual(prop, value) {
    if (sameValue(prop.kbPrice, value)) return false;
    var now = Date.now();
    var prevT = numOrNull(prop.fieldsAt.kbPrice) || 0;
    var t = prop.fieldsAt.kbPrice = stampAfter(now, prop.fieldsAt.kbPrice, prop.legacyAt);
    if (prop.kbPrice !== null) keepCurrentInHistory(prop, 'kbHistory', prop.kbPrice, prop.kbAt, prop.kbSource || 'manual', prevT);
    prop.kbPrice = value;
    prop.kbAt = value === null ? '' : todayISO();
    prop.kbSource = value === null ? '' : 'manual';
    if (value !== null) prop.kbHistory = pushHistory(prop.kbHistory, { value: value, at: prop.kbAt, source: 'manual', t: t });
    touch(prop, t);
    return true;
  }

  // ---- 다시 붙여넣기 갱신(가져오기 화면의 "이미 담은 매물이에요") ----
  // 바뀔 수 있는 값. hand: 사용자가 손으로 고칠 수 있는 칸(고쳤으면 덮어쓰기 전에 묻는다). 호수·메모·체크 기록 등은 넣지 않는다(절대 덮어쓰지 않음)
  var REFRESH_FIELDS = [
    { k: 'kbPrice', label: 'KB시세', kind: 'man', hand: true },
    { k: 'kbAt', label: 'KB시세 기준일', kind: 'date' },
    { k: 'askPrice', label: '호가', kind: 'man', hand: true },
    { k: 'realPrice', label: '최근 실거래가', kind: 'man', hand: true },
    { k: 'naverLoanLimit', label: '대출 한도(네이버 계산)', kind: 'man' },
    { k: 'naverRate', label: '최저 금리(네이버)', kind: 'rate' },
    { k: 'feeMonthly', label: '관리비(기본 정보)', kind: 'won' },
    { k: 'feeAvg', label: '관리비 월 평균', kind: 'won' },
    { k: 'feeSummer', label: '관리비 여름 평균', kind: 'won' },
    { k: 'feeWinter', label: '관리비 겨울 평균', kind: 'won' },
    { k: 'feeRecent', label: '최근 관리비', kind: 'recent' },
    { k: 'acqTaxNaver', label: '취득세 합계(네이버)', kind: 'won' },
    { k: 'propertyTaxNaver', label: '재산세 합계(네이버)', kind: 'won' },
    { k: 'confirmedAt', label: '확인매물 날짜', kind: 'text' }
  ];
  /** 가져오기 결과 매물 → 앱 범위로 정리한 새 값들 */
  function refreshValues(np) {
    var o = finFieldsInto({}, np);
    o.askPrice = finNum(np.askPrice, 'askPrice');
    o.realPrice = finNum(np.realPrice, 'realPrice');
    o.confirmedAt = str(np.confirmedAt).trim();
    return o;
  }
  function finValText(kind, v) {
    if (v === null || v === undefined || v === '') return '없음';
    if (kind === 'man') return manText(v);
    if (kind === 'won') return wonText(v);
    if (kind === 'rate') return rateText(v);
    if (kind === 'recent') return monthText(v.month) + ' ' + wonText(v.amount);
    if (kind === 'date') return formatISODate(v);
    return str(v);
  }
  function sameFinVal(a, b) {
    if (sameValue(a, b)) return true;
    return !!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
  }
  /**
   * 손으로 고친 값인지: KB시세는 직접 넣은 것(manual), 나머지는 가져오기가 넣은 뒤(syncAt, 없으면 가져온 시각) 고친 칸.
   * 1.7.0 검토 반영: 예전(1.2.x 이하) 기록은 fillTimes 가 모든 칸 시각을 legacyAt(= 처음 읽은 때의 updatedAt)으로 채운다.
   * 그 시각은 "그때 값을 알고 있었다"는 뜻일 뿐 고친 시각이 아니므로, 기준을 legacyAt 까지 올린다(전에는 체크 항목 하나만 고친
   * 예전 매물의 호가·실거래가가 '직접 고친 값'으로 나왔음)
   */
  function handEdited(prop, k) {
    if (prop[k] === null || prop[k] === undefined || prop[k] === '') return false;
    if (k === 'kbPrice') return prop.kbSource === 'manual';
    var t = numOrNull(prop.fieldsAt && prop.fieldsAt[k]) || 0;
    var s = numOrNull(prop.syncAt && prop.syncAt[k]) || numOrNull(prop.importedAt) || 0;
    var legacy = numOrNull(prop.legacyAt) || 0;
    if (s && legacy > s) s = legacy;
    return !s || t > s;
  }
  /** 저장된 매물(prop)과 새로 읽은 값(np)의 차이 [{ k, label, from, to, hand }]. 새 글에 없는 값은 바꾸지 않는다(그대로 둠) */
  function refreshChanges(prop, np) {
    var vals = refreshValues(np);
    var out = [];
    REFRESH_FIELDS.forEach(function (f) {
      var nv = vals[f.k];
      if (nv === null || nv === undefined || nv === '') return;
      if (f.k === 'kbAt') { // KB시세가 그대로이고 새 기준일이 더 나중일 때만(값이 바뀌면 KB시세 줄이 함께 바꿈)
        if (prop.kbPrice === null || vals.kbPrice !== prop.kbPrice || !(nv > str(prop.kbAt))) return;
      } else if (sameFinVal(prop[f.k], nv)) return;
      out.push({ k: f.k, label: f.label, from: finValText(f.kind, prop[f.k]), to: finValText(f.kind, nv), hand: !!f.hand && handEdited(prop, f.k) });
    });
    return out;
  }
  /**
   * 고른 값(keys)만 새 값으로 바꾼다. KB시세·호가는 바꾸기 전 값을 이력에 남기고 새 값도 이력에 더한다.
   * 칸마다 fieldsAt·syncAt 을 같은 시각으로 찍어(다음에 "손으로 고친 값"을 가릴 수 있게) touch 한다. 호수 등 다른 칸은 건드리지 않는다
   */
  function applyRefresh(prop, np, keys, hsrc) {
    var vals = refreshValues(np);
    var now = Date.now();
    var today = todayISO();
    var last = 0;
    if (!prop.syncAt || typeof prop.syncAt !== 'object') prop.syncAt = {};
    var oldSrc = prop.source === 'naver-text' ? 'naver' : prop.importedAt ? 'code' : 'manual';
    // 시각을 찍기 전에: 지금 호가가 손으로 고친 값인지, 언제 들어온 값인지(이력에 남길 때 씀)
    var askHand = handEdited(prop, 'askPrice');
    var askT = numOrNull(prop.fieldsAt.askPrice) || 0;
    var askAt = isoDateOf(askT || prop.importedAt || prop.createdAt);
    var kbT = numOrNull(prop.fieldsAt.kbPrice) || 0;
    keys.forEach(function (k) {
      if (k === 'confirmedAt') { prop.confirmedAt = vals.confirmedAt; return; } // 가져오기 값(시각 없이 합침)
      var fk = k === 'kbAt' ? 'kbPrice' : k;
      var t = prop.fieldsAt[fk] = stampAfter(now, prop.fieldsAt[fk], prop.legacyAt);
      prop.syncAt[fk] = t;
      if (t > last) last = t;
      if (fk === 'kbPrice') {
        var kb = k === 'kbAt' ? prop.kbPrice : vals.kbPrice;
        keepCurrentInHistory(prop, 'kbHistory', prop.kbPrice, prop.kbAt, prop.kbSource || oldSrc, kbT);
        prop.kbPrice = kb;
        prop.kbAt = vals.kbAt || today;
        prop.kbSource = hsrc;
        // 1.7.0 검토 반영: 이력에는 값이 바뀐 것만 남긴다. 값은 그대로이고 기준일만 새로우면(네이버 글은 늘 '오늘') 줄을 더하지 않는다.
        // 전에는 다른 날 다시 붙여 넣을 때마다 같은 값이 한 줄씩 쌓여 20줄 안에서 실제로 바뀐 기록이 밀려났음
        var kh = Array.isArray(prop.kbHistory) ? prop.kbHistory : [];
        if (!kh.length || kh[kh.length - 1].value !== kb) prop.kbHistory = pushHistory(kh, { value: kb, at: prop.kbAt, source: hsrc, t: t });
        return;
      }
      if (fk === 'askPrice') {
        keepCurrentInHistory(prop, 'askHistory', prop.askPrice, askAt, askHand ? 'manual' : oldSrc, askT);
        prop.askHistory = pushHistory(prop.askHistory, { value: vals.askPrice, at: today, source: hsrc, t: t });
      }
      prop[fk] = vals[fk];
    });
    touch(prop, last || now);
  }
  /** 층 글 → 해당층 숫자: '12/25' → 12, '3층' → 3, '중/25'·'' → null */
  function floorNum(f) {
    var m = /^\s*(\d{1,3})(?:\s*층)?(?:\s*\/|\s*$)/.exec(str(f));
    return m ? parseInt(m[1], 10) : null;
  }
  /** 호수 → 층: '1203' → 12, '302호' → 3. 세 자리·네 자리 숫자일 때만(그 밖은 null) */
  function floorOfHo(ho) {
    var m = /^\s*(\d{3,4})\s*호?\s*$/.exec(str(ho));
    return m ? Math.floor(parseInt(m[1], 10) / 100) : null;
  }
  /**
   * 다시 붙여넣기: 같은 매물(매물번호 → 링크 → 단지명·동·면적·호가, 1.4.1 느슨한 판정)으로 이미 담은 매물. 없으면 null.
   * 1.7.0 검토 반영: 판정의 확실한 정도도 → { prop, by('a'|'u'|'n'|'loose'), sure, warn: [쉬운 말], floorConflict }.
   * 매물번호·링크로 같다고 본 것은 확실(sure). 단지명 조합(n)·느슨한 판정은 ① 매물번호(링크)가 한쪽에만 있거나 ② 층이 한쪽에만
   * 있거나 ③ 담은 매물의 호수에서 나온 층과 새 글의 층이 다르거나(floorConflict) ④ 매물번호도 층도 양쪽에 없거나 ⑤ 느슨한 판정이면
   * 다른 집일 수 있다고 알린다(warn, sure false).
   * 전에는 층 없이 담은 1203호 매물에 같은 단지·동·면적·호가인 3층 매물 글을 붙여 넣으면 [바꾸기]로 다른 집의 값이 들어갔음
   */
  function existingMatch(np, idx) {
    if (!IMP) return null;
    var hit = IMP.findDuplicate(np, idx, null);
    var prop = null, by = '';
    if (hit && hit.kind === 'exists' && hit.prop) { prop = hit.prop; by = hit.by || 'n'; }
    else {
      var nm = searchKey(np.name);
      var dong = IMP.dongOf(np.dong);
      if (!nm || !np.askPrice) return null;
      var c = state.properties.filter(function (p) { return searchKey(p.name) === nm && IMP.dongOf(p.dong) === dong && p.askPrice === np.askPrice; });
      if (c.length !== 1) return null;
      prop = c[0];
      by = 'loose';
    }
    var warn = [];
    var conflict = false;
    if (by === 'n' || by === 'loose') {
      if (by === 'loose') warn.push('단지·동·호가만 같아요(면적·매물번호로 확인하지 못했어요)');
      // 매물번호(없으면 링크): 양쪽에 있었다면 앞 단계(a·u)가 정했으므로 여기서는 많아야 한쪽에만 있다
      var na = str(np.articleNo).trim() || str(np.sourceUrl).trim(), pa = str(prop.articleNo).trim() || str(prop.sourceUrl).trim();
      if (!!na !== !!pa) warn.push(na ? '담아 둔 매물에는 매물번호가 없어요' : '새 글에는 매물번호가 없어요');
      var nf = str(np.floor).trim(), pf = str(prop.floor).trim();
      var hoF = floorOfHo(prop.ho), newF = floorNum(nf);
      if (!pf && nf && hoF !== null && newF !== null && hoF !== newF) {
        conflict = true;
        warn.push('담아 둔 매물은 ' + str(prop.ho).trim() + '호(' + hoF + '층)인데 새 글은 ' + newF + '층이에요');
      } else if (!!nf !== !!pf) {
        warn.push(nf ? '담아 둔 매물에는 층 정보가 없어요(새 글 ' + floorText(nf) + ')' : '새 글에는 층 정보가 없어요');
      }
      if (by === 'n' && !na && !pa && !nf && !pf) warn.push('매물번호와 층이 없어 단지·동·면적·호가로만 같다고 봤어요');
    }
    return { prop: prop, by: by, sure: !warn.length, warn: warn, floorConflict: conflict };
  }
  /** 손으로 고친 값을 덮어쓸지 고르게 한다(기본은 그대로 둠). others: 함께 바뀌는 다른 값 이름. 결과 Promise: { 칸: true }(고른 것), [취소]면 null */
  function confirmHandOverwrite(list, others) {
    var boxes = [];
    var ul = h('ul', { class: 'rp-over' }, list.map(function (c) {
      var id = 'imp-hand-' + domId(c.k);
      var cb = h('input', { type: 'checkbox', id: id, checked: false });
      boxes.push({ k: c.k, cb: cb });
      return h('li', {}, h('label', { class: 'rp-check', for: id }, cb,
        h('span', { text: c.label + ': 지금 ' + c.from + '(직접 고친 값) → 새 ' + c.to })));
    }));
    // 1.7.0 검토 반영: '그대로'를 두 뜻으로 쓰지 않는다. 체크한 값만 바꾸고, 함께 바뀌는 다른 값은 이름을 적는다
    var rest = (others || []).length ? '나머지 바뀐 값(' + others.join(', ') + ')은 새 값으로 바꿔요.' : '';
    return openDialog({
      title: '직접 고친 값이 있어요. 바꿀까요?',
      content: h('div', { class: 'rp-over-box' },
        h('p', { class: 'small muted', text: '체크한 값만 새 값으로 바꿔요. 체크하지 않은 값은 지금 값을 그대로 둬요. ' + rest }), ul),
      buttons: [
        { label: '바꾸기', value: 'go' },
        { label: '취소', value: null, kind: 'secondary' }
      ]
    }).then(function (r) {
      if (r.value !== 'go') return null;
      var over = {};
      boxes.forEach(function (b) { if (b.cb.checked) over[b.k] = true; });
      return over;
    });
  }

  // ---- 상세 '대출·비용' 카드 ----
  var FIN_INPUT_LABEL = { kbPrice: 'KB시세', dealPrice: '협상가', remodelCost: '리모델링비', publicPrice: '공시가격' };
  /** 1.7.0 검토 반영: 범위 밖 값의 안내(칸 이름과 고치는 법). 너무 크면 원 단위로 적었을 수 있다 */
  function finRangeError(key, n) {
    var r = FIN_NUM_RANGE[key], name = FIN_INPUT_LABEL[key] || '이 값';
    return (n > r[1] ? josa(name, '이', '가') + ' 너무 커요. ' : josa(name, '은', '는') + ' ' + manText(r[0]) + ' 이상으로 적어 주세요. ') +
      '만원 단위 숫자예요. (2억 3,450만원 → 23450) 이 값은 저장하지 않았어요.';
  }
  /**
   * 만원 입력 칸(협상가·리모델링비·공시가격). 입력을 멈추면(0.35초) 저장하고 아래 계산만 다시 그린다.
   * 1.7.0 검토 반영: readManInput 으로 읽는다('1.9억'·'1억 9천' → 19000). 못 읽거나 범위 밖이면 저장하지 않고 칸 아래에 알린다
   */
  function finInputField(prop, key, id, label, hint, placeholder) {
    var inp = h('input', {
      class: 'input', id: id, type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'done', autocomplete: 'off',
      value: prop[key] !== null && prop[key] !== undefined ? String(prop[key]) : '', placeholder: placeholder || '',
      'aria-describedby': id + '-live ' + id + '-err ' + id + '-hint'
    });
    var live = h('p', { class: 'field-live', id: id + '-live', 'aria-live': 'polite' });
    var err = h('p', { class: 'field-error', id: id + '-err', role: 'alert', hidden: true });
    var timer = null;
    function show() {
      var r = readManInput(inp.value);
      live.textContent = !r.bad && r.value !== null ? '= ' + manText(r.value) : '';
    }
    function fail(text) {
      err.textContent = text;
      err.hidden = false;
      inp.setAttribute('aria-invalid', 'true');
    }
    function commit() {
      clearTimeout(timer);
      timer = null;
      if (!findProp(prop.id)) return;
      var r = readManInput(inp.value);
      if (r.bad) { fail(manInputError(r.bad)); return; }
      var n = r.value;
      if (n !== null && finNum(n, key) === null) { fail(finRangeError(key, n)); return; }
      err.hidden = true;
      inp.removeAttribute('aria-invalid');
      if (sameValue(prop[key], n)) return;
      setFinField(prop, key, n);
      drawFinResults(prop);
    }
    inp.addEventListener('input', function () { show(); clearTimeout(timer); timer = setTimeout(commit, 350); });
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(); inp.blur(); }
    });
    show();
    return h('div', { class: 'field fin-field' },
      h('label', { for: id, text: label }),
      h('div', { class: 'input-unit' }, inp, h('span', { class: 'unit', 'aria-hidden': 'true', text: '만원' })),
      live, err,
      h('p', { class: 'field-hint', id: id + '-hint', text: hint }));
  }

  /** KB시세 직접 입력 칸 + [저장]. editing: 이미 KB시세가 있어 고치는 중([취소]·[지우기] 보임) */
  function kbEditor(prop, editing) {
    var inp = h('input', {
      class: 'input', id: 'fin-kb-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'done', autocomplete: 'off',
      value: editing && prop.kbPrice !== null ? String(prop.kbPrice) : '', placeholder: '예: 23450', 'aria-describedby': 'fin-kb-live fin-kb-err fin-kb-hint'
    });
    var live = h('p', { class: 'field-live', id: 'fin-kb-live', 'aria-live': 'polite' });
    var err = h('p', { class: 'field-error', id: 'fin-kb-err', role: 'alert', hidden: true });
    function show() { var r = readManInput(inp.value); live.textContent = !r.bad && r.value !== null ? '= ' + manText(r.value) : ''; }
    function save() {
      var r = readManInput(inp.value);
      var n = r.value;
      // 1.7.0 검토 반영: '2.3억'을 23(만원)으로 읽지 않는다. 값이 지금과 같으면 아무것도 바꾸지 않고 칸만 닫는다(setKbManual)
      if (r.bad) { err.textContent = manInputError(r.bad); err.hidden = false; return; }
      if (n === null) {
        if (!editing) { err.textContent = 'KB시세를 만원 단위 숫자로 적어 주세요. (2억 3,450 → 23450)'; err.hidden = false; return; }
        if (setKbManual(prop, null)) toast('KB시세를 지웠어요');
      } else if (finNum(n, 'kbPrice') === null) {
        err.textContent = finRangeError('kbPrice', n);
        err.hidden = false;
        return;
      } else {
        toast(setKbManual(prop, n) ? 'KB시세를 저장했어요' : '지금 KB시세와 같아서 그대로 두었어요');
      }
      saveNow();
      drawFinBody(prop, 'fin-kb');
    }
    inp.addEventListener('input', function () { show(); err.hidden = true; });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); }
    });
    show();
    return h('div', { class: 'field fin-kb-edit' },
      h('label', { for: 'fin-kb-input', text: editing ? 'KB시세 고치기' : 'KB시세 직접 입력' }),
      h('div', { class: 'input-unit' }, inp, h('span', { class: 'unit', 'aria-hidden': 'true', text: '만원' })),
      live, err,
      h('p', { class: 'field-hint', id: 'fin-kb-hint', text: 'KB부동산 앱이나 은행에서 본 일반평균가를 만원 단위로 적어요. (2억 3,450 → 23450)' + (editing ? ' 비우고 저장하면 지워요.' : '') }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-small', id: 'fin-kb-save', onclick: save }, 'KB시세 저장'),
        editing ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { drawFinBody(prop, 'fin-kb'); } }, '취소') : null));
  }

  /** 가격 이력(KB시세·호가) 대화상자 */
  function showPriceHistory(prop) {
    function rows(list, cur) {
      var items = (list || []).slice().reverse();
      if (!items.length) return h('p', { class: 'small muted', text: '기록이 없어요.' });
      return h('ul', { class: 'fin-hist' }, items.map(function (e, i) {
        return h('li', {},
          h('span', { class: 'fin-hist-v', text: manText(e.value) }),
          h('span', { class: 'fin-hist-sub', text: [e.at ? formatISODate(e.at) : '날짜 모름', HIST_SOURCE_LABEL[e.source] || '', i === 0 && e.value === cur ? '지금 값' : ''].filter(Boolean).join(' · ') }));
      }));
    }
    return openDialog({
      title: '가격 이력',
      content: h('div', { class: 'fin-hist-box' },
        h('h3', { class: 'fin-h', text: 'KB시세' }), rows(prop.kbHistory, prop.kbPrice),
        h('h3', { class: 'fin-h', text: '호가' }), rows(prop.askHistory, prop.askPrice),
        h('p', { class: 'small muted', text: '네이버 매물 글을 다시 붙여 넣고 [바꾸기]를 누르거나 KB시세를 직접 고치면 여기에 남아요. 네이버 화면의 KB시세에는 날짜가 없어서, 날짜는 가져온 날이에요.' })),
      buttons: [{ label: '닫기', value: null }]
    });
  }

  /**
   * 대출 조건 바꾸기 대화상자(모든 매물에 같이 적용). 저장하면 true. prop: 이 창을 연 매물(저장 알림에 바뀐 결과를 적음. 없어도 됨)
   * 1.7.0 검토 반영:
   *  - 지역·생애최초를 맨 위로(LTV 규칙상 최대가 이것으로 정해짐). 넣은 LTV 가 규칙상 최대보다 크면 LTV 칸 바로 아래에 알린다
   *  - 특별시·광역시(국민주택채권 요율)·출산·양육 감면 칸을 더함(전에는 화면에서 바꿀 수 없었음)
   *  - 칸 안내를 aria-describedby 로 잇고, 첫 초점은 첫 칸(전에는 맨 아래 [저장])
   *  - 못 읽은 숫자가 있으면 저장하지 않고 그 칸 아래에 칸 이름과 함께 알린다(창은 열린 채)
   *  - [기본값으로 채우기]는 칸만 기본값으로 채운다(저장은 [저장]으로). 전에는 묻지 않고 바로 저장했음
   *  - 저장 알림에 이 매물의 필요 현금·대출 한도가 어떻게 바뀌었는지 적는다(같으면 '그대로예요')
   */
  function editFinSettings(prop) {
    if (!FIN) return Promise.resolve(false);
    var s = finSettings();
    var D = FIN.defaultSettings();
    // 숫자 칸(화면 순서). 범위는 finance.js SETTING_NUM 과 같다
    var NUMS = [
      { key: 'ltv', id: 'fs-ltv', label: 'LTV', unit: '%', mode: 'decimal', min: 0, max: 100, eg: '70' },
      { key: 'ratePct', id: 'fs-rate', label: '금리', unit: '%', mode: 'decimal', min: 0, max: 30, eg: '4.5' },
      { key: 'years', id: 'fs-years', label: '대출 기간', unit: '년', mode: 'numeric', min: 1, max: 50, eg: '30' },
      { key: 'legalFee', id: 'fs-legal', label: '법무사 비용', unit: '만원', mode: 'numeric', min: 0, max: 1000, eg: String(D.legalFee),
        hint: '기본 ' + manText(D.legalFee) + ': 법무사 보수 50만원 + 등기 신청 수수료 1.5만원(부가세 별도). 견적을 받으면 바꿔요.' },
      { key: 'moving', id: 'fs-moving', label: '이사비', unit: '만원', mode: 'numeric', min: 0, max: 10000, eg: '130' },
      { key: 'depositPct', id: 'fs-deposit', label: '계약금 비율', unit: '%', mode: 'decimal', min: 0, max: 100, eg: '10',
        hint: '보통 매매가의 10%예요. 매도인과 정해요.' }
    ];
    var f = {}, errs = {};
    /** 숫자 칸 하나(이름·입력·단위·안내·오류). extra: 더 이을 안내 id */
    function numField(d, extra) {
      var hintId = d.hint ? d.id + '-hint' : '';
      var inp = h('input', { class: 'input', id: d.id, type: 'text', inputmode: d.mode, autocomplete: 'off', value: String(s[d.key]),
        placeholder: d.eg, 'aria-describedby': [hintId, extra || '', d.id + '-err'].filter(Boolean).join(' ') });
      f[d.key] = inp;
      errs[d.key] = h('p', { class: 'field-error', id: d.id + '-err', role: 'alert', hidden: true });
      return h('div', { class: 'field' },
        h('label', { for: d.id, text: d.label + (d.key === 'ratePct' ? ' (연)' : '') }),
        h('div', { class: 'input-unit' }, inp, h('span', { class: 'unit', 'aria-hidden': 'true', text: d.unit })),
        errs[d.key],
        d.hint ? h('p', { class: 'field-hint', id: hintId, text: d.hint }) : null);
    }
    function toggle(id, checked, label, hintId) {
      var cb = h('input', { type: 'checkbox', id: id, checked: !!checked, 'aria-describedby': hintId || null });
      return { cb: cb, el: h('label', { class: 'toggle', for: id }, cb, h('span', { text: label })) };
    }
    var tCapital = toggle('fs-capital', s.capitalArea, '수도권 (서울·경기·인천)');
    var tReg = toggle('fs-reg', s.regulated, '규제지역 (투기과열지구·조정대상지역)');
    var tMetro = toggle('fs-metro', s.metroCity, '특별시·광역시 (서울·인천·부산 등)', 'fs-metro-hint');
    var tFirst = toggle('fs-first', s.firstHome, '생애최초 (본인·배우자 모두 집을 가진 적이 없어요)');
    var tBirth = toggle('fs-birth', s.birthRelief, '출산·양육 주택 감면 대상', 'fs-birth-hint');
    var method = h('select', { class: 'select', id: 'fs-method', 'aria-describedby': 'fs-method-hint' },
      h('option', { value: 'equal-payment', text: '원리금균등' }),
      h('option', { value: 'equal-principal', text: '원금균등' }));
    var bang = h('select', { class: 'select', id: 'fs-bang', 'aria-describedby': 'fs-bang-hint' }, FIN.BANG_GONGJE.map(function (b) { return h('option', { value: b.key, text: b.label }); }));
    method.value = s.method;
    bang.value = s.bangGongje;
    var fields = {};
    NUMS.forEach(function (d) { fields[d.key] = numField(d, d.key === 'ltv' ? 'fs-ltv-hint fs-ltv-warn' : ''); });
    var bangHint = h('p', { class: 'field-hint', id: 'fs-bang-hint' });
    // LTV 칸 바로 아래: 뜻과 이 조건의 규칙상 최대(지역·생애최초 칸을 바꾸면 바뀜), 넣은 값이 더 크면 경고
    var ltvHint = h('p', { class: 'field-hint', id: 'fs-ltv-hint', 'aria-live': 'polite' });
    var ltvWarn = h('p', { class: 'field-warn fin-ltv-warn', id: 'fs-ltv-warn', hidden: true });
    fields.ltv.insertBefore(ltvHint, errs.ltv.nextSibling);
    fields.ltv.append(ltvWarn);
    var resetNote = h('p', { class: 'field-live fin-reset-note', 'aria-live': 'polite' });
    function sync() {
      var b = null;
      FIN.BANG_GONGJE.forEach(function (x) { if (x.key === bang.value) b = x; });
      bangHint.textContent = (b ? b.hint + ' ' : '') + '방공제: 은행이 소액 세입자 몫을 빼고 빌려주는 돈이에요.';
      var cond = { firstHome: tFirst.cb.checked, capitalArea: tCapital.cb.checked, regulated: tReg.cb.checked };
      var rule = FIN.suggestLtv(cond);
      ltvHint.textContent = 'LTV: 집값 대비 빌릴 수 있는 비율이에요. 이 지역·조건의 규칙상 최대는 ' + rule + '%예요.';
      var t = str(f.ltv.value).replace(/[,\s%]/g, '');
      var n = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
      var maxY = FIN.RULES.capitalMaxYears;
      var ty = str(f.years.value).replace(/[,\s]/g, '');
      var y = /^\d+(\.\d+)?$/.test(ty) ? parseFloat(ty) : null;
      var warns = [];
      if (n !== null && n > rule) warns.push('넣은 ' + n + '%는 규칙상 최대보다 커서 ' + rule + '%로 계산해요.');
      if (y !== null && y > maxY && (cond.capitalArea || cond.regulated)) warns.push('수도권·규제지역 대출 기간은 ' + maxY + '년까지라 ' + maxY + '년으로 계산해요.');
      ltvWarn.textContent = warns.join(' ');
      ltvWarn.hidden = !warns.length;
    }
    [bang, tFirst.cb, tCapital.cb, tReg.cb].forEach(function (el) { el.addEventListener('change', sync); });
    [f.ltv, f.years].forEach(function (el) { el.addEventListener('input', sync); });
    NUMS.forEach(function (d) { f[d.key].addEventListener('input', function () { errs[d.key].hidden = true; f[d.key].removeAttribute('aria-invalid'); }); });
    sync();
    var content = h('div', { class: 'fin-set' },
      h('p', { class: 'small muted', text: '모든 매물에 같이 적용돼요. 은행·상품마다 다르니 상담받은 조건으로 바꿔 보세요.' }),
      h('fieldset', { class: 'fin-region' },
        h('legend', { text: '지역' }),
        tCapital.el, tReg.el, tMetro.el,
        h('p', { class: 'field-hint', id: 'fs-metro-hint', text: '특별시·광역시는 국민주택채권 요율이 달라요(그 밖의 시·군은 더 낮아요).' }),
        h('p', { class: 'field-hint', text: '기본값은 인천 계양구(수도권·규제지역 아님·광역시) 기준이에요. 매물 지역이 다르면 바꿔 주세요.' })),
      tFirst.el,
      tBirth.el,
      h('p', { class: 'field-hint', id: 'fs-birth-hint', text: '아이를 낳은 가구가 집을 살 때 받는 취득세 감면이에요(500만원 한도). 생애최초 감면과 겹치면 큰 쪽 하나만 받아요. 자격은 위택스·구청에서 확인하세요.' }),
      h('div', { class: 'field-row' }, fields.ltv, fields.ratePct),
      h('div', { class: 'field-row' }, fields.years, h('div', { class: 'field' }, h('label', { for: 'fs-method', text: '상환 방식' }), method)),
      h('p', { class: 'field-hint', id: 'fs-method-hint', text: '원리금균등: 매달 같은 금액을 내요. 원금균등: 처음에 많이 내고 점점 줄어요.' }),
      h('div', { class: 'field' }, h('label', { for: 'fs-bang', text: '방공제 단계' }), bang, bangHint),
      h('div', { class: 'field-row' }, fields.legalFee, fields.moving),
      fields.depositPct,
      resetNote);
    /** [저장] 전에 숫자 칸 검사: 못 읽거나 범위 밖이면 그 칸 아래에 알리고 첫 칸으로 초점. 다 맞으면 true (비운 칸은 지금 값 그대로) */
    function validate() {
      var first = null;
      NUMS.forEach(function (d) {
        var t = str(f[d.key].value).replace(/[,\s%]/g, '');
        var n = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
        var ok = !t || (isFinite(n) && n >= d.min && n <= d.max);
        errs[d.key].hidden = ok;
        if (ok) { f[d.key].removeAttribute('aria-invalid'); return; }
        errs[d.key].textContent = josa(d.label, '은', '는') + ' ' + d.min + '~' + formatNumber(d.max) + ' 사이 숫자로 적어 주세요. (예: ' + d.eg + ')';
        f[d.key].setAttribute('aria-invalid', 'true');
        if (!first) first = f[d.key];
      });
      if (first) { try { first.focus(); } catch (e) { /* 무시 */ } }
      return !first;
    }
    /** [기본값으로 채우기]: 칸만 기본값으로(저장은 사용자가 [저장]으로) */
    function fillDefaults() {
      NUMS.forEach(function (d) { f[d.key].value = String(D[d.key]); errs[d.key].hidden = true; f[d.key].removeAttribute('aria-invalid'); });
      tCapital.cb.checked = !!D.capitalArea;
      tReg.cb.checked = !!D.regulated;
      tMetro.cb.checked = !!D.metroCity;
      tFirst.cb.checked = !!D.firstHome;
      tBirth.cb.checked = !!D.birthRelief;
      method.value = D.method;
      bang.value = D.bangGongje;
      sync();
      resetNote.textContent = '';
      resetNote.textContent = '기본값을 채웠어요. [저장]을 눌러야 바뀌어요.';
    }
    var before = prop ? finCalc(prop) : null;
    return openDialog({
      title: '대출 조건 바꾸기',
      content: content,
      className: 'fin-set-modal',
      initialFocus: tCapital.cb,
      buttons: [
        { label: '저장', value: 'save', validate: validate },
        { label: '취소', value: null, kind: 'secondary' },
        { label: '기본값으로 채우기', value: 'fill', kind: 'secondary', keepOpen: true, action: fillDefaults }
      ]
    }).then(function (r) {
      if (r.value !== 'save') return false;
      var next = Object.assign({}, s);
      NUMS.forEach(function (d) {
        var t = str(f[d.key].value).replace(/[,\s%]/g, '');
        if (t && /^\d+(\.\d+)?$/.test(t)) next[d.key] = parseFloat(t); // validate 를 지난 값. 비운 칸은 지금 값 그대로
      });
      next.method = method.value;
      next.bangGongje = bang.value;
      next.firstHome = tFirst.cb.checked;
      next.birthRelief = tBirth.cb.checked;
      next.capitalArea = tCapital.cb.checked;
      next.regulated = tReg.cb.checked;
      next.metroCity = tMetro.cb.checked;
      next = FIN.normalizeSettings(next);
      var prev = state.settings || { finance: null, financeAt: 0 };
      state.settings = { finance: next, financeAt: stampAfter(Date.now(), prev.financeAt) };
      finCache = {};
      saveNow();
      toast(finSettingsChangeText(before, prop && findProp(prop.id) ? finCalc(prop) : null), { duration: 6000 });
      return true;
    });
  }
  /** 조건 저장 알림: 이 매물의 필요 현금·대출 한도 전 → 뒤(1.7.0 검토 반영). 매물이 없으면 짧게 */
  function finSettingsChangeText(b, a) {
    if (!b || !a) return '대출 조건을 바꿨어요';
    var parts = [];
    function cmp(label, x, y) {
      if (typeof x !== 'number' && typeof y !== 'number') return;
      if (x !== y) parts.push(label + ' ' + manText(x) + ' → ' + manText(y));
    }
    cmp('필요 현금', b.cash ? b.cash.cash : null, a.cash ? a.cash.cash : null);
    cmp('대출 한도', b.limit ? b.limit.limit : null, a.limit ? a.limit.limit : null);
    return parts.length ? '대출 조건을 바꿨어요. 이 매물: ' + parts.join(' · ')
      : '대출 조건을 바꿨어요. 이 매물의 필요 현금·대출 한도는 그대로예요.';
  }

  /** 상세 '대출·비용' 카드(접히는 카드). 머리 줄에 필요 현금·대출 한도 요약 */
  function finCard(prop) {
    var v = view;
    var sumLine = h('span', { class: 'fin-sum-line', id: 'fin-sum-line' });
    var body = h('div', { class: 'fin-body' });
    var card = h('details', { class: 'card fin-card', id: 'fin-card', open: sessionGet(FIN_OPEN_KEY) === '1' },
      h('summary', { class: 'fin-summary' },
        h('span', { class: 'fin-title' }, '대출·비용', h('span', { class: 'fin-est', text: ' (추정)' })),
        sumLine,
        icon('chevron', 'fin-chev')),
      body);
    card.addEventListener('toggle', function () { sessionSet(FIN_OPEN_KEY, card.open ? '1' : '0'); });
    v.refs.fin = { body: body, sumLine: sumLine, results: null, prop: prop };
    drawFinBody(prop);
    return card;
  }

  /**
   * 카드 안 전체(핵심 숫자·조건·KB시세·입력 칸·계산 내역·참고값·안내)를 다시 그린다. focusId: 다 그린 뒤 초점을 줄 요소 id.
   * 1.7.0 검토 반영: 핵심 숫자(필요한 현금·대출 한도·첫 달 상환)와 계산 조건·[조건 바꾸기]를 맨 위로(전에는 KB시세·입력 칸 아래라
   * 큰 숫자까지 1,000px 넘게, 생애최초 같은 전제는 카드 맨 아래에 있었음). 네이버의 단순 계산(대출 한도·금리)은 '네이버 참고값' 안으로
   */
  function drawFinBody(prop, focusId) {
    var r = view.refs.fin;
    if (!r || view.prop !== prop) return;
    var body = r.body;
    body.textContent = '';
    // 0) 핵심 숫자(입력할 때마다 이 자리도 다시 그림)와 계산 조건
    r.top = h('div', { class: 'fin-sec fin-top', id: 'fin-top' });
    body.append(r.top);
    var cond = h('p', { class: 'fin-cond-line', id: 'fin-cond-line' });
    body.append(h('div', { class: 'fin-sec fin-cond' },
      h('h3', { class: 'fin-h', text: '계산 조건' }),
      cond,
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', id: 'fin-cond-btn', onclick: function () {
        editFinSettings(prop).then(function (changed) { if (changed && view.prop === prop) drawFinBody(prop, 'fin-cond-btn'); });
      } }, '조건 바꾸기')));
    r.cond = cond;
    // 1) KB시세
    var kbBox = h('div', { class: 'fin-sec fin-kb', id: 'fin-kb', tabindex: '-1' });
    if (prop.kbPrice !== null) {
      var hist = (prop.kbHistory || []).length + (prop.askHistory || []).length;
      kbBox.append(
        h('dl', { class: 'kv fin-kv' },
          h('dt', { text: 'KB시세' }),
          h('dd', {},
            h('span', { class: 'fin-num', id: 'fin-kb-value', 'data-man': String(prop.kbPrice), text: manText(prop.kbPrice) }),
            h('span', { class: 'sub', text: [prop.kbAt ? formatISODate(prop.kbAt) + (prop.kbSource === 'manual' ? ' 입력' : ' 가져옴') : '', HIST_SOURCE_LABEL[prop.kbSource] || ''].filter(Boolean).join(' · ') }))),
        h('div', { class: 'btn-row fin-kb-btns' },
          hist ? h('button', { type: 'button', class: 'btn btn-small btn-secondary', id: 'fin-hist-btn', onclick: function () { showPriceHistory(prop); } }, '이력 보기') : null,
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', id: 'fin-kb-edit-btn', onclick: function () {
            var box = $('#fin-kb');
            if (!box) return;
            box.textContent = '';
            box.append(kbEditor(prop, true));
            try { $('#fin-kb-input').focus(); } catch (e) { /* 무시 */ }
          } }, '직접 고치기')));
    } else {
      kbBox.append(
        h('div', { class: 'notice notice-info fin-kb-none', role: 'note' },
          h('strong', { text: 'KB시세가 없어요' }),
          h('p', { text: '네이버 매물 글을 다시 붙여 넣으면 KB시세를 가져와요. 은행은 보통 KB시세로 대출 한도를 정해요. 지금은 매매가로 계산했어요.' }),
          h('a', { class: 'btn btn-small btn-secondary', href: '#/import' }, icon('paste', 'ic-sm'), '네이버 글 붙여넣기')),
        kbEditor(prop, false));
    }
    body.append(kbBox);
    // 2) 입력 칸. 1.7.0 검토 반영: 협상가 자리표시자에 '예:'(전에는 호가 숫자만 있어 이미 넣은 값처럼 보였음), 안내에 지금 호가
    body.append(h('div', { class: 'fin-sec fin-inputs' },
      finInputField(prop, 'dealPrice', 'fin-deal', '협상가 (선택)',
        '매도인과 맞춘 가격이 있으면 적어요. 비우면 ' + (prop.askPrice ? '호가 ' + manText(prop.askPrice) + '으로' : '호가로') + ' 계산해요.',
        '예: ' + (prop.askPrice ? String(prop.askPrice) : '24000')),
      finInputField(prop, 'remodelCost', 'fin-remodel', '리모델링비', '수리·인테리어에 쓸 돈이에요. 잔금 뒤에 나가는 돈으로 더해요.', '예: 1500'),
      finInputField(prop, 'publicPrice', 'fin-public', '공시가격 (선택)', '모르면 KB시세의 69%로 추정해요. 부동산공시가격알리미에서 볼 수 있어요.', '예: 16000')));
    // 3) 계산 내역(입력할 때마다 이 자리만 다시 그림)
    r.results = h('div', { class: 'fin-results', id: 'fin-results' });
    body.append(r.results);
    // 4) 네이버 참고값(네이버 화면의 단순 계산·참고값. 은행 한도·금리가 아님)
    var refs = [];
    function ref(label, text) { if (text && text !== '-') refs.push(h('dt', { text: label }), h('dd', { text: text })); }
    ref('대출 한도(네이버 계산)', prop.naverLoanLimit ? manText(prop.naverLoanLimit) : '');
    ref('최저 금리(네이버)', prop.naverRate ? rateText(prop.naverRate) : '');
    ref('관리비(기본 정보)', wonText(prop.feeMonthly));
    ref('관리비 월 평균', wonText(prop.feeAvg));
    ref('여름(6~8월) 평균', wonText(prop.feeSummer));
    ref('겨울(12~2월) 평균', wonText(prop.feeWinter));
    if (prop.feeRecent) ref('최근 관리비(' + monthText(prop.feeRecent.month) + ')', wonText(prop.feeRecent.amount));
    ref('취득세 합계', prop.acqTaxNaver ? '약 ' + wonText(prop.acqTaxNaver) : '');
    ref('재산세 합계', prop.propertyTaxNaver ? '약 ' + wonText(prop.propertyTaxNaver) : '');
    if (refs.length) {
      body.append(h('details', { class: 'fin-naver' },
        h('summary', {}, '네이버 참고값'),
        h('dl', { class: 'kv fin-kv' }, refs),
        h('p', { class: 'small muted', text: '네이버 화면에 나온 값이에요(관리비는 국토교통부 자료). 대출 한도·금리는 네이버의 단순 계산이라 은행 한도·금리가 아니에요. 관리비는 세대·계절마다 달라요. 관리사무소에서 확인하세요.' })));
    }
    // 5) 늘 보이는 안내
    body.append(h('p', { class: 'fin-foot', role: 'note', text: '모두 추정이에요. 실제 대출 한도는 소득(DSR)과 은행 심사로 정해져요. 세금은 위택스·구청에서 확인하세요.' }));
    drawFinResults(prop);
    if (focusId) {
      var el = document.getElementById(focusId);
      if (el) { try { el.focus({ preventScroll: false }); } catch (e) { /* 무시 */ } }
    }
  }

  /** 계산 결과 자리만 다시 그린다(입력 칸은 그대로라 입력 중 초점이 남는다) */
  function drawFinResults(prop) {
    var r = view.refs.fin;
    if (!r || view.prop !== prop || !r.results) return;
    var box = r.results;
    var top = r.top;
    box.textContent = '';
    if (top) top.textContent = '';
    if (!FIN) {
      r.sumLine.textContent = '';
      box.append(h('div', { class: 'notice', role: 'note' },
        h('strong', { text: '계산 파일을 불러오지 못했어요' }),
        h('p', { text: '인터넷에 연결한 뒤 새로고침해 주세요. 넣은 값은 그대로 저장돼요.' })));
      return;
    }
    var c = finCalc(prop);
    if (r.cond) r.cond.textContent = finCondText(c.settings, c);
    if (!c.price && prop.kbPrice === null) {
      r.sumLine.textContent = '호가나 KB시세를 넣으면 계산해요';
      box.append(h('p', { class: 'small muted', text: '호가(매물 정보 수정)나 협상가, KB시세를 넣으면 대출 한도와 필요한 현금을 계산해요.' }));
      return;
    }
    function row(dt, valueMan, key, sub) {
      return [h('dt', { text: dt }), h('dd', {},
        h('span', { class: 'fin-num', 'data-fin': key || null, 'data-man': typeof valueMan === 'number' ? String(valueMan) : null, text: typeof valueMan === 'number' ? manText(valueMan) : str(valueMan) }),
        sub ? h('span', { class: 'sub', text: sub }) : null)];
    }
    /** 맨 위 핵심 숫자 줄(data-top). 아래 내역(#fin-results, data-fin)과 같은 값 */
    function topRow(dt, valueMan, key, sub) {
      return [h('dt', { text: dt }), h('dd', {},
        h('span', { class: 'fin-num', 'data-top': key, 'data-man': String(valueMan), text: manText(valueMan) }),
        sub ? h('span', { class: 'sub', text: sub }) : null)];
    }
    var L = c.limit;
    var P = c.pay;
    var C = c.cash;
    var H = c.hold;
    var S = c.settings;
    // 넣은 LTV 가 규칙상 최대보다 커서 낮춰 계산했으면 대출 줄 바로 아래에 보인다(전에는 접힌 '계산 설명' 안에만 있었음)
    var ltvCut = L && L.ltv < S.ltv ? 'LTV ' + L.ltv + '%(규칙상 최대. 넣은 값 ' + S.ltv + '%)로 계산했어요' : '';
    var capped = L && L.limit < Math.max(0, L.ltvAmount - L.deduction) - 1;
    // 요약 줄
    r.sumLine.textContent = C ? '필요 현금 약 ' + manText(C.cash) + (L ? ' · 대출 ' + manText(L.limit) : '')
      : L ? '대출 한도 약 ' + manText(L.limit) : '';
    // 맨 위 핵심 숫자
    if (top) {
      if (C) {
        top.append(h('p', { class: 'fin-top-k', text: '필요한 현금' }),
          h('p', { class: 'fin-big' }, h('span', { class: 'fin-num', 'data-top': 'cash', 'data-man': String(C.cash), text: manText(C.cash) })));
      }
      var trows = [];
      if (L) trows.push(topRow('대출 한도', L.limit, 'loan', ltvCut || ('LTV ' + L.ltv + '% 기준' + (capped ? ' · 최대 한도 적용' : ''))));
      if (P) trows.push(topRow('첫 달 상환', P.firstMonth, 'month', '연 ' + P.ratePct + '% · ' + yearsText(P.years)));
      if (trows.length) top.append(h('dl', { class: 'kv fin-kv' }, trows));
    }
    // 가격 기준
    box.append(h('dl', { class: 'kv fin-kv' },
      row('계산에 쓴 매매가', c.price, 'price', c.priceKind === 'deal' ? '협상가' : c.priceKind === 'ask' ? '호가' : '호가가 없어 KB시세로만 계산했어요')));
    // 대출
    var loanRows = [];
    if (L) {
      var basis = (L.basis === 'kb' ? 'KB시세 ' : '매매가 ') + manText(L.base) + ' × LTV ' + L.ltv + '%' +
        (L.deduction ? ' − 방공제 ' + manText(L.deduction) : '') + (capped ? ' (최대 한도 적용)' : '') + (ltvCut ? '. ' + ltvCut : '');
      loanRows.push(row('대출 한도', L.limit, 'loan', basis));
    }
    if (P) {
      loanRows.push(row('월 상환(첫 달)', P.firstMonth, 'month', '연 ' + P.ratePct + '% · ' + yearsText(P.years) +
        (P.years !== S.years ? '(수도권·규제지역 최대. 넣은 값 ' + yearsText(S.years) + ')' : '') + ' · ' + (FIN.METHOD_LABEL[P.method] || '') +
        (P.method === 'equal-principal' ? ' · 마지막 달 ' + manText(P.lastMonth) : '')));
    }
    if (loanRows.length) box.append(h('div', { class: 'fin-sec' }, h('h3', { class: 'fin-h', text: '대출' }), h('dl', { class: 'kv fin-kv' }, loanRows)));
    // 필요 현금
    if (C) {
      var items = C.items.filter(function (it) { return it.amount !== 0 || it.key === 'acqTax'; });
      var notes = [];
      C.items.forEach(function (it) { if (it.notes && it.notes.length) notes.push(h('li', { text: it.label + ': ' + it.notes.join(' ') })); });
      var WHEN = { contract: '계약일', balanceDay: '잔금일', after: '잔금 후' };
      box.append(h('div', { class: 'fin-sec fin-cash' },
        h('h3', { class: 'fin-h', text: '필요한 현금 내역' }),
        h('p', { class: 'fin-cash-sum' }, '총비용 ' + manText(C.totalCost) + ' − 대출 ' + manText(C.loan) + ' = ',
          h('span', { class: 'fin-num', 'data-fin': 'cash', 'data-man': String(C.cash), text: manText(C.cash) })),
        h('ol', { class: 'fin-timeline', 'aria-label': '돈이 나가는 때' },
          ['contract', 'balanceDay', 'after'].map(function (w) {
            return h('li', {}, h('span', { class: 'fin-when', text: WHEN[w] + (w === 'after' ? '(이사·수리)' : '') }),
              h('span', { class: 'fin-num', 'data-fin': w, 'data-man': String(C.timeline[w]), text: manText(C.timeline[w]) }));
          })),
        h('ul', { class: 'fin-items', 'aria-label': '들어가는 돈' }, items.map(function (it) {
          return h('li', { 'data-k': it.key },
            h('span', { class: 'fin-item-l' }, it.key === 'remodel' ? '리모델링비' : it.label, h('span', { class: 'fin-item-w', text: ' · ' + WHEN[it.when] })),
            h('span', { class: 'fin-num', 'data-man': String(it.amount), text: manText(it.amount) }));
        })),
        notes.length ? h('details', { class: 'fin-notes' }, h('summary', {}, '항목 설명'), h('ul', {}, notes)) : null));
    }
    // 1년 보유비용
    if (H) {
      var ptx = H.propertyTaxInfo;
      var hrows = [];
      /** 표시값(소수 첫째 자리)끼리 더한 값. finance.js 는 원 단위로 더한 뒤 한 번만 반올림해 0.1만원 다를 수 있다 */
      var sum1 = function (list) { return Math.round(list.reduce(function (a, x) { return a + (typeof x === 'number' ? x : 0); }, 0) * 10) / 10; };
      var ROUND_NOTE = '항목을 원 단위로 더한 뒤 반올림해서 위 숫자의 합과 0.1만원 다를 수 있어요';
      if (H.propertyTax !== null) {
        // 1.7.0 검토 반영: 어느 해 몫인지와 다른 경우의 값. 산 사람이 처음 내는 해(finTaxYear)를 지금 법 그대로 계산한다
        var spLast = FIN.RULES.specialLastYear;
        var ptSub = [H.taxYear ? H.taxYear + '년분' : '',
          H.taxYear > spLast ? '지금 법 그대로' + (H.propertyTaxMin < H.propertyTax ? ' · 특례가 연장되면 ' + manText(H.propertyTaxMin) : '')
            : H.propertyTaxMax > H.propertyTax ? (H.taxYear + 1) + '년분은 지금 법 그대로면 ' + manText(H.propertyTaxMax) : '',
          ptx && ptx.basis === 'estimate' ? '공시가격을 몰라 시세의 69%로 추정' : ''];
        hrows.push(row('재산세', H.propertyTax, 'propertyTax', ptSub.filter(Boolean).join(' · ')));
      }
      hrows.push(row('관리비(1년)', H.mgmtFee !== null ? H.mgmtFee : '관리비 정보 없음', 'mgmt', H.mgmtFee !== null ? '월 ' + wonText(finFeeWon(prop)) + ' × 12' + (prop.feeAvg ? '' : ' (기본 정보 관리비)') : ''));
      if (H.interestYear1 !== null) hrows.push(row('첫해 대출 이자', H.interestYear1, 'interest', '원금 상환은 빠져 있어요'));
      hrows.push(row('합계', H.total, 'holdTotal', sum1([H.propertyTax, H.mgmtFee, H.interestYear1]) !== H.total ? ROUND_NOTE : ''));
      hrows.push(row('월 주거비', H.monthly.total, 'monthTotal', '첫 달 상환 ' + manText(H.monthly.payment || 0) + ' + 관리비 ' + manText(H.monthly.mgmtFee || 0) +
        (sum1([H.monthly.payment, H.monthly.mgmtFee]) !== H.monthly.total ? '. ' + ROUND_NOTE : '')));
      box.append(h('div', { class: 'fin-sec' }, h('h3', { class: 'fin-h', text: '1년 보유비용' }), h('dl', { class: 'kv fin-kv' }, hrows)));
    }
    // 계산 설명(finance.js 메모). 1.7.0 검토 반영: 재산세 메모(6월 1일 소유자·적용 연도·특례 연장)도 넣는다
    var all = [];
    [L && L.notes, C && C.notes, H && H.notes, H && H.propertyTaxInfo && H.propertyTaxInfo.notes].forEach(function (list) {
      (list || []).forEach(function (n) { if (all.indexOf(n) < 0 && !/^모두 추정이에요/.test(n)) all.push(n); });
    });
    if (all.length) box.append(h('details', { class: 'fin-notes' }, h('summary', {}, '계산 설명 ' + all.length + '개'), h('ul', {}, all.map(function (n) { return h('li', { text: n }); }))));
  }

  /** 공유 글의 '돈 계산 (추정)' 줄. 숫자만(판정·사람 이름 없음). 계산할 값이 없으면 [] */
  function finShareLines(prop) {
    var c = finCalc(prop);
    if (!c || (!c.price && prop.kbPrice === null)) return [];
    var out = [];
    if (prop.kbPrice !== null) out.push('- KB시세 ' + manText(prop.kbPrice) + (prop.kbAt ? ' (' + formatISODate(prop.kbAt) + ' 기준)' : ''));
    if (c.price) out.push('- 계산에 쓴 매매가 ' + manText(c.price) + (c.priceKind === 'deal' ? '(협상가)' : '(호가)'));
    // 1.7.0 검토 반영: 조건 괄호는 실제 계산에 쓴 LTV·기간(카드의 계산 조건 줄과 같은 문구)
    if (c.limit) out.push('- 대출 한도 약 ' + manText(c.limit.limit) + (c.pay ? ' · 첫 달 상환 약 ' + manText(c.pay.firstMonth) : '') + ' (' + finCondText(c.settings, c) + ')');
    if (c.cash) out.push('- 필요한 현금 약 ' + manText(c.cash.cash) + ' (계약일 ' + manText(c.cash.timeline.contract) + ' · 잔금일 ' + manText(c.cash.timeline.balanceDay) + ' · 잔금 후 ' + manText(c.cash.timeline.after) + ')');
    if (c.hold) out.push('- 1년 보유비용 약 ' + manText(c.hold.total) + ' · 월 주거비 약 ' + manText(c.hold.monthly.total) + (c.hold.taxYear ? ' (재산세 ' + c.hold.taxYear + '년분 기준)' : ''));
    out.push('- 추정이에요. 대출은 은행, 세금은 위택스·구청에서 확인하세요.');
    return out;
  }

  // ---------------- 정렬 규칙 (비교·홈 공용, 1.5.1) ----------------
  /** 값이 없는(null) 매물은 맨 뒤. dir 1 이면 오름차순, -1 이면 내림차순 */
  function nullsLast(a, b, f, dir) {
    var x = f(a), y = f(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir * (x - y);
  }
  function askOf(p) { return p.askPrice || null; }
  // 비교 화면(renderCompare)과 홈 목록 필터(renderHome)가 같은 비교 함수를 쓴다. 1.5.0 비교의 5가지는 규칙 그대로(순서가 같으면 원래 순서 유지)
  var SORT_CMP = {
    updated: function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); },
    created: function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); },
    name: function (a, b) { return str(a.name).localeCompare(str(b.name), 'ko'); },
    ask: function (a, b) { return nullsLast(a, b, askOf, 1); },
    askDesc: function (a, b) { return nullsLast(a, b, askOf, -1); },
    diff: function (a, b) { return nullsLast(a, b, function (p) { return diffPercent(p.askPrice, p.realPrice); }, 1); },
    progress: function (a, b) { return overallProgress(b).pct - overallProgress(a).pct; },
    // 1.5.1 검토 반영: 주의 표시 수가 같으면 멈춤 신호가 있는 매물을 뒤로, 그다음 아직 하나도 안 본 매물(진행 0)을 뒤로.
    // 전에는 멈춤 신호가 있거나 안 본 매물이 "주의 0"으로 맨 앞에 와 '안전한 순'처럼 읽혔음(비교 화면도 같은 규칙)
    caution: function (a, b) {
      return cautionCount(a) - cautionCount(b) ||
        (flagsYes(a, 'stop').length ? 1 : 0) - (flagsYes(b, 'stop').length ? 1 : 0) ||
        (overallProgress(a).done ? 0 : 1) - (overallProgress(b).done ? 0 : 1);
    },
    // 1.7.0: 숫자 순서일 뿐 판정이 아니다(값이 없는 매물은 맨 뒤). 필요 현금은 지금 대출 조건으로 계산한 추정
    kbGap: function (a, b) { return nullsLast(a, b, kbGapOf, 1); },
    cash: function (a, b) { return nullsLast(a, b, finCashOf, 1); }
  };
  /** 정렬 id → 비교 함수. 모르는 id 는 '최근에 고친 순' */
  function sortCompare(key) { return SORT_CMP[key] || SORT_CMP.updated; }
  /** 비교 화면의 정렬 select(1.5.0 과 같은 5가지, 같은 순서) */
  var SORTS = [
    { id: 'updated', label: '최근에 고친 순' },
    { id: 'ask', label: '호가 낮은 순' },
    { id: 'diff', label: '실거래 대비 낮은 순' },
    { id: 'progress', label: '진행률 높은 순' },
    { id: 'caution', label: '주의 표시 적은 순' }, // 1.5.1 검토 반영: "주의 적은 순"은 '안전한 순'으로 읽혀 이름을 바꿈(멈춤 신호는 주의 표시가 아님)
    { id: 'cash', label: '필요 현금 적은 순' } // 1.7.0: 비교 표의 필요 현금 열과 같은 추정
  ];
  /** 홈 목록의 정렬 select(1.5.1): 비교의 5가지 + 최근 추가한 순·단지명 가나다·호가 높은 순 */
  var HOME_SORTS = [
    { id: 'updated', label: '최근에 고친 순' },
    { id: 'created', label: '최근 추가한 순' }, // 1.5.1 검토 반영: createdAt 내림차순인데 "추가한 순"은 먼저 추가한 것부터로 읽혔음
    { id: 'name', label: '단지명 가나다' },
    { id: 'ask', label: '호가 낮은 순' },
    { id: 'askDesc', label: '호가 높은 순' },
    { id: 'diff', label: '실거래 대비 낮은 순' },
    { id: 'progress', label: '진행률 높은 순' },
    { id: 'caution', label: '주의 표시 적은 순' },
    // 1.7.0: 끝에 더한다(1.5.1 정렬의 순서·이름은 그대로). 기억해 둔 정렬 id 가 모르는 값이면 '최근에 고친 순'(readHomeFilter)
    { id: 'kbGap', label: 'KB시세 대비 호가 낮은 순' },
    { id: 'cash', label: '필요 현금 적은 순' }
  ];

  // ---------------- 비교 ----------------
  function renderCompare() {
    var v = newView('compare');
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
    var hiddenNote = h('p', { class: 'small muted', 'aria-live': 'polite', style: 'margin:-4px 2px 10px' });
    var tableWrap = h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '매물 비교 표 (옆으로 밀어서 보기)' });
    // 1.7.0 검토 반영: 대출·비용 열이 표 끝에 있어 바로 가는 단추
    var finJump = h('button', { type: 'button', class: 'btn btn-small btn-ghost cmp-fin-jump' }, '대출·비용 열 보기');

    // 1.4.5: 매물이 하나뿐이면 비교할 상대가 없다는 안내 + [매물 추가](0개일 때만 안내하던 것)
    var oneNote = state.properties.length === 1 ? h('div', { class: 'notice notice-info cmp-one', role: 'note' },
      h('p', { text: '매물을 하나 더 추가하면 호가·등기부 결과를 나란히 비교할 수 있어요.' }),
      h('a', { class: 'btn btn-small btn-accent', href: '#/new' }, icon('plus', 'ic-sm'), '매물 추가')) : null;
    main.append(
      // 1.5.0 검토 반영: 빠른 동작 열을 등기부 결과 바로 뒤(3번째 열)로 — 맨 끝(11번째)이면 390px 에서 약 900px 을 밀어야 보여 "바로"가 아니었음. 버튼 순서대로 적음
      h('p', { class: 'page-sub', text: '옆으로 밀어서 더 보세요. 이름을 누르면 상세로, 등기부 결과 옆 [임장 예정]·[탈락]으로 상태를 바로 바꿔요. 대출·비용(추정) 열은 표 오른쪽 끝에 있어요.' }),
      h('div', { class: 'compare-tools' }, sortSel, h('label', { class: 'toggle' }, dropToggle, '탈락 매물도 보기'), finJump),
      hiddenNote
    );
    appendKid(main, oneNote); // null 이면 넣지 않는다(main.append(null) 은 글자 "null"을 넣음)
    main.append(
      tableWrap,
      h('div', { class: 'card', style: 'margin-top:14px' },
        h('p', { class: 'small muted', text: '실거래 대비: 호가가 최근 실거래가보다 몇 % 높은지(+) 낮은지(−). 실거래가는 한 건의 거래라 층·향·수리 상태에 따라 차이가 날 수 있어요.' }),
        h('p', { class: 'small muted', text: '주의: 현장 평가에서 "주의"로 표시한 항목 + 등기부에서 "주의" 신호가 있다고 표시한 항목 수.' }),
        // 1.7.0
        h('p', { class: 'small muted', text: '대출 한도·월 상환(첫 달)·필요 현금·1년 보유비용: 매물 상세 "대출·비용" 카드의 조건으로 계산한 추정이에요. 계산 매매가는 협상가가 있으면 협상가, 없으면 호가예요. 실제 한도는 소득(DSR)·은행 심사로, 세금은 위택스·구청에서 확인하세요.' })
      )
    );
    /** 1.7.0: 대출·비용 칸 6개(KB시세·계산 매매가·대출 한도·월 상환·필요 현금·1년 보유비용). 없으면 '-' */
    function finCells(p) {
      var c = finCalc(p);
      function td(v, key) { return h('td', { class: 'num', 'data-fin': key, text: typeof v === 'number' ? manText(v) : '-' }); }
      return [
        td(p.kbPrice, 'kb'),
        td(c ? c.price : null, 'price'),
        td(c && c.limit ? c.limit.limit : null, 'loan'),
        td(c && c.pay ? c.pay.firstMonth : null, 'month'),
        td(c && c.cash ? c.cash.cash : null, 'cash'),
        td(c && c.hold ? c.hold.total : null, 'holdTotal')
      ];
    }

    /** 1.5.0(M5): 고정 열 부제 "204동 1604호 · 16/16층 동향" — 같은 단지·같은 동 매물을 층·방향으로 구분(전에는 동·호만) */
    function subText(p) {
      var fl = [floorText(p.floor), str(p.direction).trim()].filter(Boolean).join(' ');
      return [unitText(p), fl].filter(Boolean).join(' · ');
    }
    function fullName(p) { var s = subText(p); return p.name + (s ? ' ' + s : ''); }

    /**
     * 1.5.0(M5): 행 끝 빠른 동작. 상세 화면의 상태 바꾸기(changeStatus)와 같은 확인창을 띄우되, 비교 화면에는 상태 select 가
     * 없어 끝난 뒤 표를 다시 그린다(전에는 이름 → 상세 → 상태 select → [탈락 처리] → 뒤로 4~5탭). 문구를 바꾸면 changeStatus 도 같이
     */
    function quickDrop(p) {
      openDialog({
        title: '탈락 처리할까요?',
        message: fullName(p) + '\n탈락 사유를 남겨 두면 나중에 비교할 때 도움이 돼요. (비워 둬도 돼요)',
        input: { multiline: true, placeholder: '예: 등기부에 신탁 기록, 누수 흔적', value: p.dropReason || suggestedDropReason(p), label: '탈락 사유' },
        buttons: [{ label: '탈락 처리', value: 'ok', kind: 'danger' }, { label: '취소', value: null, kind: 'secondary' }]
      }).then(function (r) {
        if (r.value !== 'ok') return;
        var prev = p.status;
        setPropStatus(p, 'dropped', r.text.trim());
        saveNow();
        draw();
        // 1.5.0 검토 반영: 행이 바로 사라지므로("탈락 매물도 보기"가 꺼져 있으면) 토스트에 [되돌리기](전 상태로. 탈락 사유는 보관)
        toast('탈락 처리했어요', {
          duration: 6000,
          action: { label: '되돌리기', fn: function () {
            setPropStatus(p, prev);
            afterStatusChange(p); // 그 매물 상세를 열어 둔 상태면 select·경고 상자도 맞춘다(다른 화면이면 아무것도 안 함)
            saveNow();
            if (view === v) draw();
            toast('되돌렸어요 · ' + STATUS_LABEL[prev], { duration: 1500 });
          } }
        });
      });
    }
    /** 임장 예정으로. 등기부 멈춤 신호를 다 보기 전이면 한 번 더 묻고, [등기부 먼저 보기]는 그 매물 상세의 등기부 섹션을 연 채로 간다 */
    function quickPlan(p) {
      var gs = gateStopState(p);
      if (!(gs.unanswered > 0 || gs.yes > 0)) { applyStatus(p, 'planned'); saveNow(); draw(); return; }
      var hasStop = gs.yes > 0;
      openDialog({
        title: hasStop ? '멈춤 신호가 있는 매물이에요' : '등기부 멈춤 신호를 먼저 확인하세요',
        message: fullName(p) + '\n' + (hasStop
          ? '등기부에 멈춤 신호가 있다고 표시했어요. 이 집은 보러 갈 필요가 없어요. 그래도 상태를 "임장 예정"으로 바꿀까요?'
          : '아직 확인하지 않은 멈춤 신호가 ' + gs.unanswered + '개 있어요. 신탁·가압류 같은 문제가 있으면 보러 갈 필요가 없어요. 그래도 상태를 "임장 예정"으로 바꿀까요?'),
        buttons: [{ label: '그래도 바꾸기', value: 'ok' }, { label: '등기부 먼저 보기', value: 'reg', kind: 'secondary' }]
      }).then(function (r) {
        if (r.value === 'ok') { applyStatus(p, 'planned'); saveNow(); draw(); return; }
        if (r.value !== 'reg') return; // Esc·바탕 누름: 그대로
        var g = gateSections()[0];
        if (g) pendingSection = g.id; // 상세가 그 섹션을 열고 스크롤한다(renderDetail, 1.5.0 M8 과 같은 길)
        navigate('/p/' + p.id);
      });
    }
    function rowActions(p) {
      if (p.status === 'dropped') {
        return h('button', {
          type: 'button', class: 'btn btn-small btn-ghost', 'aria-label': '다시 검토하기: ' + fullName(p),
          onclick: function () { applyStatus(p, 'review'); saveNow(); draw(); }
        }, '다시 검토');
      }
      return h('div', { class: 'cmp-act-row' },
        p.status === 'review' ? h('button', {
          type: 'button', class: 'btn btn-small btn-secondary', 'aria-label': '임장 예정으로 바꾸기: ' + fullName(p),
          onclick: function () { quickPlan(p); }
        }, '임장 예정') : null,
        h('button', {
          type: 'button', class: 'btn btn-small btn-danger-ghost', 'aria-label': '탈락 처리: ' + fullName(p),
          onclick: function () { quickDrop(p); }
        }, '탈락'));
    }

    function draw() {
      var list = state.properties.filter(function (p) { return includeDropped || p.status !== 'dropped'; });
      var droppedCount = state.properties.filter(function (p) { return p.status === 'dropped'; }).length; // 빠른 동작으로 바뀌므로 그릴 때마다 센다
      list.sort(sortCompare(sortSel.value)); // 1.5.1: 홈 목록과 같은 비교 함수(SORT_CMP). 규칙은 1.5.0 그대로
      tableWrap.textContent = '';
      hiddenNote.textContent = !includeDropped && droppedCount ? '탈락 ' + droppedCount + '개 숨김' : '';
      hiddenNote.hidden = !hiddenNote.textContent;
      finJump.hidden = !list.length;
      if (!list.length) {
        tableWrap.append(h('p', { class: 'muted', style: 'padding:16px', text: '보여 줄 매물이 없어요.' }));
        return;
      }
      // 핵심 판단 기준(등기부 결과)을 매물 이름 바로 옆에, 그다음 빠른 동작(1.5.0 검토 반영: 맨 끝에서 3번째 열로. 등기부 결과를 보고
      // 바로 [임장 예정]·[탈락]), 1.5.0(M5): 같은 단지 매물을 구분할 층·방향, 거의 같은 값(최근 실거래가·전용면적)은 뒤로
      var thead = h('thead', {}, h('tr', {},
        h('th', { class: 'sticky-col', scope: 'col', text: '매물' }),
        h('th', { scope: 'col', text: '등기부 결과' }),
        h('th', { class: 'cmp-act', scope: 'col', text: '빠른 동작' }),
        h('th', { scope: 'col', text: '층·방향' }),
        h('th', { scope: 'col', text: '상태' }),
        h('th', { class: 'num', scope: 'col', text: '호가' }),
        h('th', { class: 'num', scope: 'col', text: '실거래 대비' }),
        h('th', { class: 'num', scope: 'col', text: '주의' }),
        h('th', { scope: 'col', text: '진행률' }),
        h('th', { class: 'num', scope: 'col', text: '최근 실거래가' }),
        h('th', { class: 'num', scope: 'col', text: '전용면적' }),
        // 1.7.0: 대출·비용(추정). 숫자만 나란히(가장 낮은 값 강조 같은 판정 표시는 하지 않음).
        // 1.7.0 검토 반영: 표 끝으로 옮김(전에는 '실거래 대비' 다음이라 위험 정보인 '주의'·'진행률' 열이 630px 오른쪽으로 밀렸음)
        h('th', { class: 'num', scope: 'col', id: 'cmp-fin-start', text: 'KB시세' }),
        h('th', { class: 'num', scope: 'col', text: '계산 매매가' }),
        h('th', { class: 'num', scope: 'col', text: '대출 한도' }),
        h('th', { class: 'num', scope: 'col', text: '월 상환' }),
        h('th', { class: 'num', scope: 'col', text: '필요 현금' }),
        h('th', { class: 'num', scope: 'col', text: '1년 보유비용' })
      ));
      var tbody = h('tbody', {}, list.map(function (p) {
        var prog = overallProgress(p);
        var reg = registryResult(p);
        var diff = diffPercent(p.askPrice, p.realPrice);
        var sub = subText(p);
        return h('tr', { class: p.status === 'dropped' ? 'is-dropped' : null },
          h('th', { class: 'sticky-col', scope: 'row' },
            h('a', { href: '#/p/' + encodeURIComponent(p.id) }, p.name, sub ? h('span', { class: 'unit-sub', text: sub }) : null)),
          h('td', {}, h('span', { class: 'meta-chip reg-' + reg.code, text: reg.label })),
          h('td', { class: 'cmp-act' }, rowActions(p)),
          h('td', { text: [floorText(p.floor), str(p.direction).trim()].filter(Boolean).join(' · ') || '-' }),
          h('td', {}, statusChip(p.status)),
          h('td', { class: 'num', text: p.askPrice ? formatManwon(p.askPrice) : '-' }),
          h('td', { class: 'num' + (diff !== null ? (diff > 0 ? ' diff-up' : ' diff-down') : ''), text: pctText(diff) }),
          h('td', { class: 'num', text: String(cautionCount(p)) }),
          h('td', {}, h('span', { class: 'mini-bar' }, makeBar(prog.pct, null, { thin: true, ariaLabel: p.name + ' 진행률' }).el), prog.pct + '%'),
          h('td', { class: 'num', text: p.realPrice ? formatManwon(p.realPrice) : '-' }),
          h('td', { class: 'num', text: p.area ? p.area + '㎡' : '-' }),
          finCells(p)
        );
      }));
      tableWrap.append(h('table', { class: 'ctable' }, h('caption', { class: 'sr-only', text: '매물 비교' }), thead, tbody));
      snapPad();
    }
    /**
     * 1.7.0 검토 반영: 옆으로 밀다 멈출 때 칸이 고정된 '매물' 열에 반쯤 가린 채 멈추지 않게(오른쪽 정렬 금액의 앞자리가 가려
     * '1억 1,401.5만원'이 '01.5만원'처럼 보였음). 표는 칸 시작에 맞춰 멈추고(styles.css scroll-snap), 맞출 자리는 고정 열 바로 오른쪽
     */
    function snapPad() {
      var st = tableWrap.querySelector('thead .sticky-col');
      if (st && st.offsetWidth) tableWrap.style.scrollPaddingLeft = st.offsetWidth + 'px';
    }
    /** [대출·비용 열 보기]: 표를 KB시세 열까지 민다 */
    function showFinCols() {
      var th = document.getElementById('cmp-fin-start');
      var st = tableWrap.querySelector('thead .sticky-col');
      if (!th) return;
      tableWrap.scrollLeft = Math.max(0, th.offsetLeft - (st ? st.offsetWidth : 0));
      try { tableWrap.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }
    finJump.addEventListener('click', showFinCols);
    var onResize = function () {
      if (!document.contains(tableWrap)) { window.removeEventListener('resize', onResize); return; }
      snapPad();
    };
    window.addEventListener('resize', onResize);

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
    setTopbar({ title: '용어·링크' }); // 1.4.5: 탭 이름과 같게(1.4.4까지 "용어와 바로가기")
    updateTabbar('glossary');
    var main = resetMain();
    appendKid(main, dataWarning());

    var q = sessionGet('imjang.gloss.q') || '';
    var search = h('input', { class: 'input', type: 'search', placeholder: '용어·바로가기 찾기 (예: 신탁, 등기소)', 'aria-label': '용어·바로가기 검색', value: q, autocomplete: 'off', enterkeyhint: 'search' });
    var countEl = h('p', { class: 'small muted', 'aria-live': 'polite', style: 'margin:0 2px 8px' });
    var list = h('ul', { class: 'gloss', role: 'list' });

    // 1.4.5: 바로가기 묶음을 검색창 바로 아래로(용어 51개 뒤에 있어 찾기 어려웠음). 검색어가 있으면 이름·설명·주소가 맞는 것만 보인다
    var linkRows = CL.links.map(function (l) {
      var host = '';
      try { host = new URL(l.url).host; } catch (e) { host = l.url; }
      var li = h('li', {},
        h('a', { class: 'link-card', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
          h('span', { class: 'lc-main' },
            h('span', { class: 'lc-label', text: l.label }),
            l.desc ? h('span', { class: 'lc-desc', style: 'display:block', text: l.desc }) : null,
            h('span', { class: 'lc-host', style: 'display:block', text: host })),
          icon('external'),
          h('span', { class: 'sr-only', text: '(새 창)' })
        ));
      return { el: li, key: (l.label + ' ' + l.desc + ' ' + host).toLowerCase() };
    });
    var linksBlock = linkRows.length ? h('section', { class: 'links-block', 'aria-labelledby': 'gloss-links' },
      h('h2', { class: 'h2', id: 'gloss-links' }, '바로가기', h('span', { class: 'count', text: '새 창으로 열려요' })),
      h('ul', { class: 'links', role: 'list' }, linkRows.map(function (r) { return r.el; }))) : null;

    function draw() {
      var term = search.value.trim();
      sessionSet('imjang.gloss.q', term);
      list.textContent = '';
      var tl = term.toLowerCase();
      if (linksBlock) {
        var shown = 0;
        linkRows.forEach(function (r) {
          var ok = !tl || r.key.indexOf(tl) >= 0;
          r.el.hidden = !ok;
          if (ok) shown++;
        });
        linksBlock.hidden = !shown;
      }
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
      linksBlock,
      h('h2', { class: 'h2', id: 'gloss-terms' }, '용어'),
      countEl,
      list
    );
    draw();
    if (CL.version) main.append(h('p', { class: 'about', text: '체크리스트 기준: ' + CL.version }));
  }

  // ---------------- 설정 ----------------
  var photoBytesCache = null; // 1.4.5: { count, docs(1.6.0 서류 수), bytes } 설정을 열 때 센 사진·서류 크기 합(이 세션 안에서만, 수가 같으면 다시 읽지 않음)
  function renderSettings() {
    newView('settings');
    setTopbar({ title: '설정' });
    updateTabbar('settings');
    var main = resetMain();

    // 0) 코드·글로 매물 추가(Claude 가져오기 코드, 네이버 매물 화면 글)
    main.append(h('a', { class: 'link-card set-link', href: '#/import' },
      h('span', { class: 'lc-main' },
        h('span', { class: 'lc-label', text: IMPORT_TITLE }),
        h('span', { class: 'lc-desc', style: 'display:block', text: '네이버 매물 화면 글이나 Claude가 준 코드를 붙여 넣어요.' })),
      icon('paste')));

    // 1) 백업 내보내기
    var withPhotos = h('input', { type: 'checkbox', id: 'bk-photos' });
    // 1.6.0: 서류함(매물별 첨부 서류)도 같은 선택으로 넣는다("사진도 함께 넣기" → "사진·서류도 함께 넣기")
    var withPhotosLabel = h('span', { text: '사진·서류도 함께 넣기 (파일이 커져요)' });
    // 1.4.5: 마지막 선택을 기억한다(전에는 매번 꺼져 시작해 iPad 사진이 Mac 으로 안 넘어갔음).
    // 아직 고른 적이 없으면 사진·서류가 1개 이상이고 예상 크기가 80MB(BIG_BACKUP_BYTES) 미만일 때 켜 둔다
    if (typeof state.ui.backupWithPhotos === 'boolean') withPhotos.checked = state.ui.backupWithPhotos;
    withPhotos.addEventListener('change', function () {
      state.ui.backupWithPhotos = withPhotos.checked;
      scheduleSave();
    });
    var baseLabel = withPhotosLabel.textContent;
    Promise.all([Photos.count(), Docs.count()]).then(function (c) {
      var n = c[0] || 0;
      var m = c[1] || 0;
      if (!n && !m) {
        // 사진·서류가 없으면 기억값이 켜짐이어도 꺼진 채 보인다(변경 이벤트는 내지 않아 기억값은 그대로). 전에는 켜진 채 "사진 0장 포함"으로 만들어졌음
        withPhotos.checked = false;
        return null;
      }
      baseLabel = filesCountText(n, m) + '도 함께 넣기 (파일이 커져요)';
      withPhotosLabel.textContent = baseLabel;
      if (typeof state.ui.backupWithPhotos === 'boolean') return null;
      function applyDefault(bytes) {
        if (typeof state.ui.backupWithPhotos !== 'boolean' && withPhotos.isConnected) withPhotos.checked = bytes * 1.37 < BIG_BACKUP_BYTES;
      }
      // 크기 합은 이 세션 안에서 사진·서류 수가 같으면 다시 읽지 않는다(사진이 많으면 Photos.all 이 느림, SPEC 16.1 #57)
      if (photoBytesCache && photoBytesCache.count === n && photoBytesCache.docs === m) { applyDefault(photoBytesCache.bytes); return null; }
      withPhotosLabel.textContent = filesCountText(n, m) + '도 함께 넣기 (크기 확인 중…)';
      return Promise.all([n ? Photos.all() : [], m ? Docs.all() : []]).then(function (r) {
        var bytes = r[0].concat(r[1]).reduce(function (sum, x) { return sum + (x.blob ? x.blob.size : 0); }, 0);
        photoBytesCache = { count: n, docs: m, bytes: bytes };
        withPhotosLabel.textContent = baseLabel;
        applyDefault(bytes);
      });
    }).catch(function () { withPhotosLabel.textContent = baseLabel; /* 사진 저장소를 못 쓰는 환경: 꺼진 채로 둔다 */ });
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
      h('label', { class: 'toggle' }, withPhotos, withPhotosLabel),
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
        h('p', { class: 'small muted', text: '사진·서류도 옮기려면 백업할 때 "사진·서류도 함께 넣기"를 켜세요(이미 있는 사진·서류는 다시 넣지 않아요).' }),
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
      h('p', { class: 'small muted', text: '이 기기에 저장된 매물·체크 기록·사진·서류를 모두 지워요. 다른 기기의 기록은 그대로예요. 되돌릴 수 없으니 먼저 백업하세요.' }),
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
    Promise.all([Photos.count(), Docs.count().catch(function () { return 0; })]).then(function (c) {
      countEl.textContent = '매물 ' + state.properties.length + '개 · 사진 ' + c[0] + '장' + (c[1] ? ' · 서류 ' + c[1] + '개' : '');
    }, function () { /* 사진 저장소 없음 */ });
  }

  /** 1.6.0: "사진 N장·서류 M개"(0 인 쪽은 뺌) */
  function filesCountText(n, m) {
    return [n ? '사진 ' + n + '장' : '', m ? '서류 ' + m + '개' : ''].filter(Boolean).join('·');
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
    var docCount = 0;    // 1.6.0: 넣은 서류 수
    var skipped = 0;     // 1.4.5: 사진을 넣지 않아 빠지는 사진 수(대화상자에서 알린다. 전에는 "크기 7KB"만 보였음)
    var skippedDocs = 0; // 1.6.0: 넣지 않아 빠지는 서류 수
    var photoReadFail = false;

    /** 사진·서류(1.6.0)를 하나씩 data URL 로 바꿔 Blob 에 이어 붙인다(큰 문자열 하나를 만들지 않음) */
    function buildWithFiles(records, docs) {
      var acc = new Blob([headJson.slice(0, -1), ',"photos":['], TYPE);
      var total = records.length + docs.length;
      function progress() {
        var n = photoCount + docCount;
        if (n % 5 === 0) toast('백업 만드는 중… ' + n + '/' + total, { duration: 0 });
      }
      var chain = Promise.resolve();
      records.forEach(function (rec) {
        if (!rec.blob) return;
        chain = chain.then(function () {
          return blobToDataURL(rec.blob).then(function (dataUrl) {
            var meta = JSON.stringify({ id: rec.id, propertyId: rec.propertyId, itemId: rec.itemId || null, sectionId: rec.sectionId || null, createdAt: rec.createdAt });
            // dataUrl 은 base64 글자뿐이라 JSON 이스케이프가 필요 없다
            acc = new Blob([acc, photoCount ? ',' : '', meta.slice(0, -1), ',"dataUrl":"', dataUrl, '"}'], TYPE);
            photoCount++;
            progress();
          });
        });
      });
      // 1.6.0: "docs": [{ id, propertyId, kind, name, mime, size, addedAt, dataUrl }]. 예전 앱은 이 키를 읽지 않는다
      chain = chain.then(function () { acc = new Blob([acc, '],"docs":['], TYPE); });
      docs.forEach(function (rec) {
        if (!rec.blob) return;
        chain = chain.then(function () {
          return blobToDataURL(rec.blob).then(function (dataUrl) {
            var meta = JSON.stringify({ id: rec.id, propertyId: rec.propertyId, kind: rec.kind, name: rec.name, mime: rec.mime, size: rec.size, addedAt: rec.addedAt });
            acc = new Blob([acc, docCount ? ',' : '', meta.slice(0, -1), ',"dataUrl":"', dataUrl, '"}'], TYPE);
            docCount++;
            progress();
          });
        });
      });
      return chain.then(function () { return new Blob([acc, ']}'], TYPE); });
    }

    var step;
    if (includePhotos) {
      toast('사진·서류를 넣어 백업 파일을 만드는 중…', { duration: 0 });
      step = Promise.all([
        Photos.all().catch(function (err) { console.warn('사진 읽기 실패', err); photoReadFail = true; return []; }),
        Docs.all().catch(function (err) { console.warn('서류 읽기 실패', err); photoReadFail = true; return []; })
      ]).then(function (r) {
        var all = r[0];
        var docs = r[1];
        if (!all.length && !docs.length) return null; // 1.4.5: 사진·서류가 없으면(기억값이 켜짐이어도) 없이 만든다 → 대화상자 "사진·서류 없이 만들었어요"
        var estimate = all.concat(docs).reduce(function (sum, x) { return sum + (x.blob ? x.blob.size : 0); }, 0) * 1.37;
        if (estimate < BIG_BACKUP_BYTES) return buildWithFiles(all, docs);
        hideToast();
        return confirmDialog({
          title: '백업 파일이 아주 커요',
          message: filesCountText(all.length, docs.length) + ', 예상 크기 약 ' + bytesText(estimate) + '예요. 사진이 많으면 iPhone 에서 만들다가 실패하거나 앱이 다시 열릴 수 있어요.\n\n사진·서류 없이 먼저 백업해 두고, 사진·서류 백업은 나중에 와이파이·충전 중에 다시 해 보세요.',
          confirmText: '그래도 사진·서류 넣어 만들기',
          cancelText: '사진·서류 없이 만들기'
        }).then(function (ok) {
          if (!ok) { skipped = all.length; skippedDocs = docs.length; return null; }
          toast('사진·서류를 넣어 백업 파일을 만드는 중…', { duration: 0 });
          return buildWithFiles(all, docs);
        });
      });
    } else {
      // 사진·서류를 안 넣을 때도 몇 개가 빠지는지 세어 알린다(저장소를 못 쓰면 0)
      step = Promise.all([Photos.count().catch(function () { return 0; }), Docs.count().catch(function () { return 0; })])
        .then(function (c) { skipped = c[0] || 0; skippedDocs = c[1] || 0; return null; });
    }

    step.then(function (photoBlob) {
      var blob = photoBlob || new Blob([headJson.slice(0, -1), ',"photos":[],"docs":[]}'], TYPE);
      // 파일 이름: imjang-backup-<기기 이름>-YYYY-MM-DD(-photos).json. 실제로 넣은 사진이 있을 때만 -photos(1.6.0: 서류만 넣었으면 -docs)
      var safeDev = fileSafeName(dev);
      var fname = 'imjang-backup-' + (safeDev ? safeDev + '-' : '') + todayISO() + (photoBlob && photoCount ? '-photos' : photoBlob && docCount ? '-docs' : '') + '.json';
      var included = filesCountText(photoCount, docCount);
      var left = filesCountText(skipped, skippedDocs);
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
        // 1.5.0(L34): 첫 줄에 두 기기 맞추기의 다음 단계(합치기 결과창의 [이 기기 백업 파일 만들기]로 왔을 때 특히)
        message: '다른 기기와 맞추려면: 그 기기에서 설정 → 백업 불러오기 → [합치기]\n\n' + fname + '\n크기: ' + bytesText(blob.size) +
          (photoBlob && included ? ' · ' + included + ' 포함' : (includePhotos ? ' · 사진·서류 없이 만들었어요' : '')) +
          (photoReadFail ? '\n사진·서류 저장소를 읽지 못해 일부가 빠졌을 수 있어요.' : '') +
          // "사진 3장은" / "사진 3장·서류 2개는": 마지막 낱말(장/개)에 맞춘 조사
          (!photoBlob && left ? '\n' + left + (skippedDocs ? '는' : '은') + ' 들어가지 않아요. 옮기려면 "사진·서류도 함께 넣기"를 켜고 다시 만드세요.' : '') +
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

  // 1.6.0: 백업 속 서류. PDF·사진만 받는다(mime 과 dataUrl 머리가 맞아야 함)
  var DOC_MIME_RE = /^(application\/pdf|image\/[a-z0-9.+-]+)$/i;
  function validDocEntry(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.propertyId !== 'string' || typeof p.dataUrl !== 'string') return false;
    if (!SNAP_ID_RE.test(p.id) || BAD_KEYS[p.id]) return false;
    var m = /^data:([^;,]+)/.exec(p.dataUrl);
    return !!m && DOC_MIME_RE.test(m[1]);
  }

  /** 1.6.0: 백업의 서류 넣기(합친 뒤 남은 매물 것만). skipExisting: 이미 있는 id 는 건너뜀(합치기). 결과: 넣은 수 */
  function importDocs(entries, skipExisting) {
    var known = {};
    state.properties.forEach(function (p) { known[p.id] = true; });
    var added = 0;
    var chain = Promise.resolve();
    entries.forEach(function (p) {
      if (!known[p.propertyId]) return;
      chain = chain.then(function () {
        return (skipExisting ? Docs.get(p.id) : Promise.resolve(null)).then(function (exists) {
          if (exists) return;
          var blob = dataURLToBlob(p.dataUrl);
          var mime = DOC_MIME_RE.test(str(p.mime)) ? str(p.mime).toLowerCase() : (blob.type || 'application/octet-stream');
          return Docs.put({
            id: p.id, propertyId: p.propertyId,
            kind: DOC_KIND_LABEL[p.kind] ? p.kind : 'other',
            name: cleanDocName(p.name, mime),
            mime: mime,
            size: blob.size,
            addedAt: numOrNull(p.addedAt) || Date.now(),
            blob: blob
          }).then(function () { added++; });
        }).catch(function (err) { console.warn('서류 불러오기 실패', err); });
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

  /**
   * 대화상자에 넣을 매물 이름 목록(max 개까지, 기본 10개 + "외 N개").
   * detail(1.4.1, 지우기 확인): 이름 아래에 동·호 · 전용 · 층 · 향 · 호가를 붙인다(같은 단지 매물이 여러 개여도 무엇을 지우는지 보이게)
   */
  function nameList(list, max, detail) {
    var NAMES_MAX = max || 10;
    var names = list.slice(0, NAMES_MAX).map(function (p) {
      var name = p.name || '이름 없는 매물';
      if (!detail) return h('li', { text: name });
      var sub = [propLine(p), p.askPrice ? '호가 ' + formatManwon(p.askPrice) : ''].filter(Boolean).join(' · ');
      return h('li', {}, h('span', { class: 'nl-name', text: name }), sub ? h('span', { class: 'nl-sub', text: ' · ' + sub }) : null);
    });
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
        var docs = Array.isArray(obj.docs) ? obj.docs.filter(validDocEntry) : []; // 1.6.0: 서류함
        var origin = backupOrigin(obj);
        // 1.5.0 검토 반영: 더 새로운 앱이 만든 백업이면 이 앱이 모르는 정보(예: 1.5.0 의 가져오기 참고)가 합치면서 빠질 수 있다고 알린다
        var backupVer = str(obj.appVersion) || str(obj.meta && obj.meta.appVersion);
        var newerVer = isNewerVersion(backupVer, APP_VERSION) ? backupVer : '';
        obj = null;
        data = null;
        // 1.3.1: 합치면 이 기기에서 지워질 매물 수를 미리 계산해 보여 준다(저장하지 않음)
        var willDelete = MG ? computeMerge(incoming).report.removed.length : 0;
        var info = { legacy: oldN, photoCount: photos.length, docs: docs, docCount: docs.length };
        return openDialog({
          title: '백업 불러오기',
          message: origin + ' · 매물 ' + incoming.properties.length + '개' +
            (photos.length || docs.length ? ' · ' + filesCountText(photos.length, docs.length).replace('·', ' · ') : ' · 사진 없음') + '\n\n' +
            '· 합치기(권장): 두 기록을 항목마다 합쳐요. 같은 항목은 더 최근에 고친 쪽을 남기고, 백업을 만든 기기에서 지운 매물은 여기서도 지워요.' +
            (willDelete ? ' 지금 합치면 이 기기에서 매물 ' + willDelete + '개가 지워져요(다음 화면에서 확인).' : '') + '\n' +
            '· 덮어쓰기: 이 기기의 지금 기록을 모두 지우고 백업 내용으로 바꿔요.',
          content: oldN || newerVer ? h('div', {},
            oldN ? h('div', { class: 'dlg-warn' },
              h('strong', { text: '예전 버전 앱에서 만든 백업이에요' + (oldN < incoming.properties.length ? ' (매물 ' + oldN + '개)' : '') }),
              h('p', { text: '항목별로 정확히 합치지 못해, 이 기기에서 고친 내용이 그 기기의 예전 값으로 덮일 수 있어요. 그 기기를 인터넷에 연결해 앱을 새로고침(업데이트)한 뒤 새로 백업해 오세요.' })) : null,
            newerVer ? h('div', { class: 'dlg-warn' },
              h('strong', { text: '더 새로운 앱(' + newerVer + ')에서 만든 백업이에요' }),
              h('p', { text: '이 앱(' + APP_VERSION + ')이 모르는 정보는 합치면서 빠질 수 있어요. 인터넷에 연결해 이 앱을 새로고침(업데이트)한 뒤 불러오면 그대로 들어와요.' })) : null) : null,
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
              message: '지금 이 기기에 있는 매물 ' + state.properties.length + '개와 사진·서류가 모두 지워지고 백업 내용으로 바뀌어요. 다른 기기의 기록은 그대로예요.',
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
   * 사진·서류까지 지워지고 되돌릴 수 없어서, 모르는 사이 한꺼번에 지워지지 않게 한다.
   * 결과 Promise: 지워도 되는 매물 { id: true }(지울 것이 없거나 [지우지 않고 합치기]면 {}), [취소]면 null
   */
  function confirmMergeDeletes(incoming) {
    var list = computeMerge(incoming).report.removed;
    if (!list.length) return Promise.resolve({});
    var all = list.length >= state.properties.length;
    return openDialog({
      title: all ? '이 기기의 매물이 모두 지워져요' : '매물 ' + list.length + '개가 지워져요',
      message: '백업을 만든 기기에서 지운 매물이라, 합치면 이 기기에서도 지워져요. 사진·서류도 함께 지워지고 되돌릴 수 없어요.' +
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
  /** 1.5.0 검토 반영: a 가 b 보다 새 버전이면 true(숫자 마디 비교: '1.10.0' > '1.9.0'). 둘 중 하나라도 '숫자.숫자…' 꼴이 아니면 false */
  function isNewerVersion(a, b) {
    a = str(a); b = str(b);
    if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return false;
    var x = a.split('.');
    var y = b.split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var p = parseInt(x[i] || '0', 10);
      var q = parseInt(y[i] || '0', 10);
      if (p !== q) return p > q;
    }
    return false;
  }

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
   * info: { legacy(예전 버전 매물 수), photoCount(백업 속 사진 수), allowDelete, docs(1.6.0: 백업 속 서류 항목), docCount }
   */
  function doImport(mode, incoming, photos, info) {
    info = info || {};
    if (mode === 'merge' && !MG) {
      alertDialog('합치지 못했어요', '합치기에 필요한 앱 파일(merge.js)을 불러오지 못했어요. 인터넷에 연결한 뒤 새로고침하고 다시 해 주세요. 지금 기록은 그대로 두었어요.');
      return Promise.resolve();
    }
    settlePendingDelete(); // 방금 지운 매물의 [되돌리기]는 끝낸다(불러온 기록 위에 예전 매물을 되살리지 않게)
    var candidate;
    var report = null;
    var dups = [];

    if (mode === 'replace') {
      pullFromStorage(); // 다른 탭이 방금 쓴 내용까지 포함해서 계산
      var now = Date.now();
      candidate = normalizeState(JSON.parse(JSON.stringify(state)));
      candidate.ui = Object.assign({}, state.ui); // 이 기기 설정(기기 이름 등)은 그대로
      // 지금 매물은 모두 "이 기기 초기화"로 표시: 다른 탭의 예전 사본을 버리게(그 시각은 매물의 마지막 변경보다 나중).
      // 1.4.1: 다른 탭에서 방금 지워 [되돌리기]를 기다리는 매물도(그 탭이 되살리지 않게, restoreDeleted)
      var stamp = now;
      var recent = recentlyDeleted(candidate);
      candidate.properties.forEach(function (p) { stamp = stampAfter(stamp, p.updatedAt); });
      recent.forEach(function (id) { stamp = stampAfter(stamp, candidate.deleted[id]); });
      candidate.properties.forEach(function (p) { candidate.localDeleted[p.id] = stamp; });
      recent.forEach(function (id) { candidate.localDeleted[id] = stamp; });
      candidate.properties = incoming.properties;
      // 1.7.0: 백업에 대출 조건이 있으면 그것으로(덮어쓰기 = 백업 내용으로 바꿈). 없으면(예전 백업·바꾼 적 없음) 이 기기 것을 둔다
      if (incoming.settings && incoming.settings.finance) candidate.settings = normalizeSettingsState(incoming.settings);
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

    var docs = info.docs || []; // 1.6.0: 서류함도 사진과 같은 규칙(덮어쓰기는 비우고 넣고, 합치기는 없는 id 만)
    var added = 0;
    var photoStep = mode === 'replace'
      ? Photos.clear().catch(function (err) { console.warn('사진 비우기 실패', err); }).then(function () { return importPhotos(photos, false); })
      : importPhotos(photos, true);
    var fileStep = photoStep.then(function (n) {
      added = n;
      return mode === 'replace'
        ? Docs.clear().catch(function (err) { console.warn('서류 비우기 실패', err); }).then(function () { return importDocs(docs, false); })
        : importDocs(docs, true);
    });
    toast(docs.length ? '사진·서류를 넣는 중…' : '사진을 넣는 중…', { duration: 0 });
    return fileStep.then(function (docsAdded) {
      if (view.name === 'settings') renderSettings();
      if (mode === 'replace') {
        toast('백업으로 바꿨어요: 매물 ' + state.properties.length + '개' + (added ? ', 사진 ' + added + '장' : '') + (docsAdded ? ', 서류 ' + docsAdded + '개' : ''), { duration: 4000 });
        focusImportCard();
        return;
      }
      hideToast();
      if (report.deleted) cleanDeletedPhotos(); // 백업을 만든 기기에서 지운 매물의 사진·서류도 이 기기에서 정리
      // 다시 그린 설정 화면 위에 결과를 띄우고, 닫으면 "백업 불러오기" 제목으로 초점을 옮긴다(예전 버튼은 사라졌으므로)
      return showMergeResult(report, added, { dups: dups, legacy: info.legacy, photoCount: info.photoCount, docsAdded: docsAdded, docCount: info.docCount || 0 }).then(focusImportCard);
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
    var docsAdded = extra.docsAdded || 0; // 1.6.0
    var sameHere = !added && !mergedN && !rep.deleted && !photosAdded && !docsAdded && !rep.settings; // 이 기기 기록은 그대로(1.7.0: 대출 조건 포함)
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
        h('span', { text: '사진 ' + (photosAdded || 0) + '장' }),
        extra.docCount || docsAdded ? ' · ' : null,
        extra.docCount || docsAdded ? h('span', { text: '서류 ' + docsAdded + '개' }) : null),
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
      group('is-kept', '같은 매물로 보이는 것', '두 기기에서 따로 추가한 같은 매물로 보여요(매물번호나 링크가 같음). 하나를 지우기 전에 양쪽의 체크 기록과 사진·서류를 확인하세요. 지운 쪽의 기록과 사진·서류는 함께 사라져요.', dups),
      extra.photoCount === 0 && !extra.docCount ? h('p', { class: 'small muted', text: '이 백업에는 사진·서류가 없어요. 사진·서류도 옮기려면 그 기기에서 "사진·서류도 함께 넣기"를 켜고 백업하세요.' }) : null,
      rep.settings ? h('p', { class: 'small muted', text: '대출 조건(대출·비용 카드의 [조건 바꾸기])은 백업 쪽이 더 나중에 바꾼 것이라 그것으로 맞췄어요.' }) : null, // 1.7.0
      rep.incomingBehind
        ? h('p', { class: 'small muted', text: '이 기기에만 있던 내용도 있어요. 백업을 만든 기기도 맞추려면 아래 [이 기기 백업 파일 만들기]로 만든 파일을 그 기기에서 [합치기] 하세요.' })
        : (sameHere ? null : h('p', { class: 'small muted', text: '이제 이 기기 기록이 백업과 같아요.' }))
    );
    // 1.5.0(L34): 이 기기에만 있던 내용이 있으면 다음 단계(백업 파일 만들기)를 바로 누르게(전에는 [확인]만 있어 설정에서 다시 찾아야 했음).
    // 사진 포함 여부는 설정의 "사진도 함께 넣기" 기억값(ui.backupWithPhotos)을 따른다(백업 대화상자가 빠진 사진 수를 알려 줌)
    var buttons = [];
    if (rep.incomingBehind) buttons.push({ label: '이 기기 백업 파일 만들기', value: 'backup', kind: 'accent' });
    buttons.push({ label: '확인', value: true });
    return openDialog({ title: sameHere && !notes ? '합쳤어요 · 바뀐 것 없음' : '합쳤어요', content: content, buttons: buttons })
      .then(function (r) {
        if (r.value === 'backup') createBackup(state.ui.backupWithPhotos === true);
        return r;
      });
  }

  function wipeAll() {
    confirmDialog({
      title: '모든 기록을 지울까요?',
      message: '매물 ' + state.properties.length + '개와 체크 기록, 사진·서류가 이 기기에서 모두 지워져요. 다른 기기의 기록은 그대로예요(그 기기 백업을 [합치기] 하면 그 기록이 다시 들어와요). 지우기 전에 백업을 권해요.',
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
        settlePendingDelete(); // 방금 지운 매물은 되돌리지 못하게 끝낸다(사진은 아래에서 모두 비움)
        pullFromStorage(); // 다른 탭에서 방금 추가한 매물까지 지운 것으로 표시
        var ui = state.ui;
        var del = Object.assign({}, state.deleted); // 그 전에 하나씩 지운 매물의 표시는 그대로(다른 기기에도 전함)
        var ld = Object.assign({}, state.localDeleted);
        // 1.3.1: 전체 삭제는 "이 기기 초기화"라 localDeleted 에만 남긴다. 이 기기의 다른 탭이 예전 기록을 다시 써 넣지 않게
        // 하되, 백업에는 넣지 않아 다른 기기 [합치기]에서 그 기기 매물이 지워지지 않는다(시각은 매물의 마지막 변경보다 나중)
        // 1.4.1: 다른 탭에서 방금 지워 [되돌리기]를 기다리는 매물도 표시한다(그 탭이 빈 기록 위에 되살리지 않게, restoreDeleted)
        var stamp = Date.now();
        var recent = recentlyDeleted(state);
        state.properties.forEach(function (p) { stamp = stampAfter(stamp, p.updatedAt); });
        recent.forEach(function (id) { stamp = stampAfter(stamp, state.deleted[id]); });
        state.properties.forEach(function (p) { ld[p.id] = stamp; });
        recent.forEach(function (id) { ld[id] = stamp; });
        state = emptyState(); // goneKeys(지운 매물 열쇠)도 비운다: 처음부터 새로 시작
        state.deleted = del;
        state.localDeleted = ld;
        state.ui.dismissedInstallTip = ui.dismissedInstallTip;
        state.ui.deviceName = ui.deviceName; // 기기 이름은 이 기기 설정이라 남긴다
        state.ui.deviceNameAt = ui.deviceNameAt;
        state.ui.backupWithPhotos = ui.backupWithPhotos; // 1.4.5: 백업 사진 포함 선택도 이 기기 설정
        dirty = true;
        saveNow();
        localRemove(DRAFT_KEY);
        try {
          Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('imjang.') === 0) sessionStorage.removeItem(k); });
        } catch (e) { /* 무시 */ }
        return Photos.clear().catch(function (err) {
          console.warn('사진 비우기 실패(다음에 다시 시도)', err);
        }).then(function () {
          // 1.6.0: 서류함도 비운다(실패하면 다음 실행의 남은 정리가 지운 매물(localDeleted) 서류를 지움)
          return Docs.clear().catch(function (err) { console.warn('서류 비우기 실패(다음에 다시 시도)', err); });
        }).then(function () {
          revokeAllPhotoUrls();
          revokeAllDocUrls();
          toast('모든 기록을 지웠어요');
          navigate('/', true);
        });
      });
    });
  }

  /** 지운 매물의 사진·서류(1.6.0)가 남아 있으면(지울 때 저장소 연결이 끊겼던 경우) 조용히 정리한다. 전체 삭제·덮어쓰기로 지운 매물 포함 */
  function cleanDeletedPhotos() {
    if (loadProblem) return; // 기록을 제대로 못 읽었으면 아무것도 지우지 않는다
    var alive = {};
    state.properties.forEach(function (p) { alive[p.id] = true; });
    var gone = Object.assign({}, state.localDeleted, state.deleted);
    var now = Date.now();
    var recent = false;
    var ids = Object.keys(gone).filter(function (id) {
      if (alive[id]) return false;
      // 방금 지운 매물(다른 탭에서 [되돌리기]를 기다리는 중일 수 있음)은 사진을 남겨 두고 조금 뒤에 다시 정리한다
      var t = state.deleted[id];
      if (t && Math.abs(now - t) < UNDO_KEEP_MS) { recent = true; return false; }
      return true;
    });
    if (recent) setTimeout(cleanDeletedPhotos, UNDO_KEEP_MS);
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      // 1.6.0: 서류도 같이(사진과 같은 규칙)
      chain = chain.then(function () { return Photos.removeByProperty(id); }).then(function () { return Docs.removeByProperty(id); });
    });
    chain.catch(function (err) { if (!dbBlockedErr(err)) console.warn('지운 매물 사진·서류 정리 실패', err); });
  }

  // ---------------- 코드·글로 매물 추가 (Claude 가져오기 코드, 네이버 매물 화면 글) ----------------
  // 네이버 부동산은 공식 API 가 없고 브라우저 CORS 때문에 앱이 네이버에 접속해 읽을 수 없다. 그래서 두 가지로 받는다.
  //  1) 사용자가 매물 화면(스크린샷·글·링크)을 Claude 채팅에 보내고, Claude 가 답한 "가져오기 코드"(JSON)를 붙여 넣는다.
  //  2) 1.4.0: 네이버 매물 상세 화면의 글을 전체 복사(또는 iPad 단축어로 복사)해 붙여 넣으면 앱이 직접 읽는다(Claude 없이).
  // 해석 규칙(코드 찾기·네이버 글 읽기·값 검사·중복 판단)은 import-parser.js 에 있다(IMP.parseText: 코드 먼저, 없으면 네이버 글).
  // tools/make-import-code.js 도 같은 파일을 쓴다.
  // 붙여 넣은 내용은 믿지 않는다: 값은 모두 textContent 로만 보여 주고, [N개 담기]를 눌러야 저장한다.

  // iPad 단축어 '웹 페이지에서 JavaScript 실행'에 넣을 코드: 맨 앞에 주소 한 줄, 그다음 페이지 글 전체
  var SHORTCUT_JS = "completion('URL: ' + location.href + '\\n' + document.body.innerText);";

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

  /**
   * 접히는 안내 "iPad 단축어로 한 번에 복사하기"(1.4.0). Safari 공유 시트에서 페이지 주소와 글 전체를 클립보드에 담는 단축어를
   * 한 번 만들어 두게 한다. 앱은 단축어를 만들거나 실행하지 않는다(사용자가 단축어 앱에서 직접 만듦)
   */
  function shortcutGuide() {
    function step(kids) { return h('li', {}, kids); }
    return h('details', { class: 'prompt-box imp-shortcut' },
      h('summary', {}, 'iPad 단축어로 한 번에 복사하기'),
      h('div', { class: 'imp-sc' },
        h('p', { class: 'small', text: '처음 한 번만 만들어 두면, Safari에서 매물 화면을 연 채로 공유 버튼만 눌러 글을 복사할 수 있어요.' }),
        h('ol', { class: 'imp-sc-steps' },
          step('단축어 앱을 열고 [+]로 새 단축어를 만들어요. 이름은 "임장체크에 담기".'),
          step('단축어 정보(ⓘ)에서 "공유 시트에 표시"를 켜고, 받는 입력을 "Safari 웹 페이지"로 해요.'),
          step([
            h('span', { text: '동작 "웹 페이지에서 JavaScript 실행"을 넣고, 안의 코드를 모두 지운 뒤 아래 코드를 넣어요.' }),
            h('pre', { class: 'prompt-text imp-sc-code', text: SHORTCUT_JS }),
            h('button', {
              type: 'button', class: 'btn btn-small btn-secondary',
              onclick: function () { copyText(SHORTCUT_JS, { ok: '단축어 코드를 복사했어요. 단축어 앱에 붙여 넣으세요.', title: '단축어 코드' }); }
            }, icon('copy', 'ic-sm'), '코드 복사')
          ]),
          step('동작 "클립보드에 복사"를 넣어요.'),
          step('동작 "알림 표시"를 넣고 글을 "복사했어요. 임장체크 앱에서 붙여넣으세요"로 해요.')),
        h('p', { class: 'imp-sc-title', text: '쓰는 법' }),
        h('p', { class: 'small', text: 'Safari에서 네이버 매물 상세 화면을 연 채로 공유 → "임장체크에 담기" → 홈 화면의 임장체크 앱 → [글·코드로 추가] → 붙여넣기.' }),
        h('p', { class: 'small muted', text: '"웹 페이지에서 JavaScript 실행"이 막히면 설정 → 단축어 → 고급 → "스크립트 실행 허용"을 켜요. iPadOS 버전에 따라 메뉴 이름이 조금 다를 수 있어요.' })));
  }

  function renderImport(query) {
    var v = newView('import');
    setTopbar({ title: IMPORT_TITLE, back: '/' });
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

    // 1) 방법 안내 + 요청문 + iPad 단축어. 1.5.0(L32): 방법 1 네이버 매물 글 붙여넣기(권장) → 방법 2 Claude 코드 순서로 바꾸고,
    //    처음 쓸 때도 접힌 <details>로 입력 칸 아래에 둔다(전에는 안내 카드 944px 뒤에 입력 칸이 있어 글을 들고 온 사람이 1.3화면을 내려야 했음)
    var howBody = [
      h('h3', { class: 'imp-way', text: '방법 1. 네이버 매물 글 붙여넣기 (권장)' }),
      h('ol', { class: 'isteps', role: 'list' },
        importStep(1, '네이버 부동산에서 매물 상세 화면을 열어요', 'Safari나 Mac 브라우저에서 매물을 눌러 상세 정보가 보이게 해요.'),
        importStep(2, '화면 글을 전체 복사해요', 'Mac은 빈 곳을 누르고 ⌘A → ⌘C. iPad는 아래 단축어를 쓰면 한 번에 돼요. 면적 단위를 ㎡로 바꾸고 복사하면 면적이 정확해요.'),
        importStep(3, '위 칸에 붙여 넣어요', 'Claude 없이 앱이 바로 읽어요. 옆의 관심·최근 목록이 섞여도 괜찮아요.')),
      shortcutGuide(),
      h('h3', { class: 'imp-way', text: '방법 2. Claude에게 코드 받기' }),
      h('ol', { class: 'isteps', role: 'list' },
        importStep(1, '네이버 부동산 매물 화면을 캡처해요', '화면 글을 복사해 보내도 돼요. 링크만 보내면 Claude가 읽지 못해요.'),
        importStep(2, 'Claude 앱 채팅에 요청문과 함께 보내요', '[요청문 복사]를 누른 뒤 채팅창에 붙여 넣고, 캡처한 화면을 첨부해요.'),
        importStep(3, 'Claude가 준 코드를 위 칸에 붙여 넣어요', '답변 전체를 복사해도 돼요. 코드만 찾아 읽어요. 코드가 여러 개면 모두 읽어요.')),
      h('button', {
        type: 'button', class: 'btn btn-secondary btn-block',
        onclick: function () { copyText(IMP.PROMPT, { ok: '요청문을 복사했어요. Claude 채팅에 붙여 넣으세요.', title: '요청문' }); }
      }, icon('copy', 'ic-sm'), '요청문 복사'),
      h('details', { class: 'prompt-box' },
        h('summary', {}, '요청문 펼쳐 보기'),
        h('pre', { class: 'prompt-text', text: IMP.PROMPT })),
      h('p', { class: 'small muted', text: '호수는 네이버 부동산에 없어서 담은 뒤 직접 입력해요. 숫자를 잘못 읽을 수 있으니 미리보기에서 꼭 확인하세요.' }),
      // 1.6.0 통합: 등기부 사진은 Claude 로(앱은 사진 글자를 읽지 못함). PDF 는 상세 화면 등기부 섹션의 [서류 올리기]가 바로 읽는다
      IMP.REGISTRY_PROMPT ? [
        h('h3', { class: 'imp-way', text: '등기부 사진은 Claude로 읽기' }),
        h('ol', { class: 'isteps', role: 'list' },
          importStep(1, '인터넷등기소 PDF가 있으면 그것을 올려요', '매물 상세 화면 등기부 섹션의 [서류 올리기]에 PDF를 올리면 앱이 바로 읽어요. "말소사항 포함"으로 열람한 PDF가 좋아요.'),
          importStep(2, '사진이면 [등기부 요청문 복사] → Claude 채팅', '요청문을 붙여 넣고 등기부 사진(모든 장)을 첨부해요.'),
          importStep(3, 'Claude가 준 등기부 코드를 위 칸에 붙여 넣어요', '어느 매물의 등기부인지 고르고 미리보기를 확인한 뒤 답해요.')),
        h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: copyRegistryPrompt }, icon('copy', 'ic-sm'), '등기부 요청문 복사'),
        h('details', { class: 'prompt-box' },
          h('summary', {}, '등기부 요청문 펼쳐 보기'),
          h('pre', { class: 'prompt-text', text: IMP.REGISTRY_PROMPT }))
      ] : null
    ];
    // 한 번이라도 코드·글로 담은 적이 있으면(가져온 매물이 있음) 입력 카드의 한 줄 안내를 생략한다
    var returning = !linkMode && state.properties.some(function (p) { return !!p.importedAt; });
    var howEl = h('details', { class: 'card flow-details imp-how-more' }, h('summary', {}, '매물 정보 가져오는 방법'), howBody);

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
      h('strong', { text: '지난번에 붙여 넣은 글이에요' }),
      h('p', { text: '새로 붙여 넣으면 이 글을 바꿔요. 필요 없으면 [지우기]를 누르세요.' })) : null;
    var pasteCard = h('section', { class: 'card', 'aria-labelledby': 'imp-paste' },
      h('h2', { class: 'card-title', id: 'imp-paste' }, h('label', { for: 'imp-text', text: '네이버 매물 글이나 Claude 코드' })),
      // 1.5.0(L32): 처음 쓰는 사람에게 한 줄만(자세한 방법은 아래 접힌 안내)
      !returning && !linkMode ? h('p', { class: 'small muted', text: '네이버 매물 상세 화면의 글을 전체 복사해 붙여 넣으면 앱이 바로 읽어요. 자세한 방법은 아래에 있어요.' }) : null,
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
        h('p', { text: '[코드 복사]를 누른 뒤, 평소 쓰는 앱의 [글·코드로 추가]에 붙여 넣으세요.' }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-secondary',
          onclick: function () { copyText(ta.value || linkText, { ok: '코드를 복사했어요. 평소 쓰는 앱의 [글·코드로 추가]에 붙여 넣으세요.', title: '가져오기 코드' }); }
        }, icon('copy', 'ic-sm'), '코드 복사'))
    ) : null;

    // 3) 미리보기와 [N개 담기]
    // 상태 줄은 처음부터 화면에 둔 빈 알림 영역(나중에 붙이면 VoiceOver 가 읽지 않을 수 있음). 오류는 따로 role=alert 영역에
    var status = h('div', { class: 'imp-status', role: 'status', 'aria-live': 'polite' });
    var errBox = h('div', { class: 'imp-error', role: 'alert' });
    // 1.4.0: 네이버 매물 화면 글에서 읽었을 때(앱이 직접 읽어 숫자가 틀릴 수 있음) 미리보기 위에 늘 보이는 주의
    var naverNote = h('div', { class: 'notice notice-ho imp-naver', hidden: true },
      h('strong', { text: '네이버 매물 화면 글에서 읽었어요 — 숫자를 꼭 확인하세요' }),
      h('p', { text: '가격·면적·층이 네이버 화면과 같은지 보고 담으세요. 목록에서 읽은 매물은 면적을 비워 둬요.' }));
    var hint = h('p', { class: 'small muted imp-hint', hidden: true, text: '담은 뒤 호수를 입력하면 등기부를 열람할 수 있어요.' });
    var list = h('div', { class: 'imp-list' });
    var submitBtn = h('button', { type: 'button', class: 'btn btn-block', disabled: true }, '담기');
    var actions = h('div', { class: 'imp-actions', hidden: true }, submitBtn);
    // 1.6.0 통합: 등기부 코드(registry 블록) 상자. 등기부만 있으면 넣을 매물을 고르고 [등기부 미리보기], 매물과 같이 오면 담는 매물에 함께
    var regBox = h('div', { class: 'imp-reg', hidden: true });
    var regTarget = null; // 사용자가 고른 매물 id(다시 그려도 유지)
    var resultEl = h('section', { class: 'imp-result', 'aria-label': '미리보기' }, errBox, naverNote, status, regBox, hint, list, actions);

    // 딥링크: 안내 → 미리보기 → 입력 칸 → (접힌) 방법 안내. 그 밖(1.5.0: 처음 쓸 때도 같음): 입력 칸 → 미리보기 → (접힌) 방법 안내
    if (linkMode) main.append(linkCard, resultEl, pasteCard, howEl);
    else main.append(pasteCard, resultEl, howEl);

    var current = null; // 마지막 해석 결과
    var picks = {};     // 사용자가 바꾼 담기 선택 (코드를 조금 고쳐도 유지)
    var timer = null;
    var done = false;   // [담기]를 이미 눌렀음: 빠르게 두 번 눌러 같은 매물이 두 벌 저장되지 않게
    var lastStatus = null;
    var lastError = null;
    // 1.7.0 다시 붙여넣기 갱신: 항목 열쇠 → { id(바꾼 매물), n(바꾼 값 수) } / true([취소]로 그대로 둠)
    var refreshed = {};
    var refreshOff = {};
    var sameOk = {}; // 1.7.0 검토 반영: 같은 집인지 확실하지 않은 상자에서 "같은 집이 맞아요"를 체크함(항목 열쇠 → true)

    function entryKey(e) { return e.index + '|' + e.prop.name; }

    /**
     * 1.7.0: 같은 매물(매물번호 → 링크 → 단지명·동·면적·호가)을 이미 담았으면 미리보기 카드 아래에 "이미 담은 매물이에요" 상자.
     * 바뀌는 값(KB시세·호가·관리비 등, 이전 → 새)을 보여 주고 [바꾸기](새 매물을 만들지 않고 값만, 이전 값은 이력에)·
     * [새 매물로 담기](체크해서 [담기]로)·[취소](그대로). 호수·메모·체크 기록 등 사용자 입력은 바꾸지 않는다.
     * 1.7.0 검토 반영:
     *  - 같은 집인지 확실하지 않으면(existingMatch: 매물번호·층이 한쪽에만 있음, 둘 다 없음, 느슨한 판정) 제목을 "이미 담은 매물일 수
     *    있어요"로 하고 까닭을 적은 뒤, "같은 집이 맞아요"를 체크해야 [바꾸기]가 켜진다. 담은 매물의 호수에서 나온 층과 새 글의 층이
     *    다르면 [바꾸기]를 두지 않는다(전에는 1203호 매물에 3층 매물의 KB·관리비·대출 한도가 들어갔음)
     *  - 바꾼 뒤 상자에 바꾼 값과 그대로 둔 값(직접 고친 값)을 나눠 적는다
     *  - [새 매물로 담기]를 고르거나 카드를 체크하면 상자를 '새 매물로 담도록 골랐어요 · [되돌리기]'로 줄인다
     */
    function updateBox(e, idx) {
      if (!e.canImport || !e.warnings.some(function (w) { return w.code === 'exists'; })) return null;
      var match = existingMatch(e.prop, idx);
      if (!match) return null;
      var target = match.prop;
      var k = entryKey(e);
      var base = 'imp-' + e.index + '-up';
      var unit = unitText(target);
      var who = target.name + (unit ? ' ' + unit : '') + (target.status === 'dropped' ? ' (탈락)' : '');
      if (hasOwn(refreshed, k)) {
        var rf = refreshed[k];
        return h('div', { class: 'imp-update is-done', id: base, role: 'group', 'aria-labelledby': base + '-t' },
          h('strong', { class: 'imp-up-title', id: base + '-t', tabindex: '-1', text: '값을 바꿨어요 · ' + who }),
          h('p', { class: 'small', text: '바꾼 값: ' + rf.changed.join(' · ') }),
          rf.kept.length ? h('p', { class: 'small', text: '그대로 둔 값: ' + rf.kept.join(' · ') }) : null,
          rf.hist ? h('p', { class: 'small muted', text: '바꾸기 전 KB시세·호가는 매물의 [이력 보기]에 남겼어요.' }) : null,
          h('a', { class: 'btn btn-small btn-secondary', href: '#/p/' + encodeURIComponent(rf.id) }, '매물 보기'));
      }
      if (isOn(e)) {
        return h('div', { class: 'imp-update is-off', id: base },
          h('p', { class: 'small', id: base + '-t', tabindex: '-1', text: '새 매물로 담도록 골랐어요. 아래 [담기]를 누르면 ' + josa(who, '과', '와') + ' 따로 담아요.' }),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { picks[k] = false; redrawFocus(base + '-t'); } }, '되돌리기'));
      }
      if (refreshOff[k]) {
        return h('div', { class: 'imp-update is-off', id: base },
          h('p', { class: 'small muted', id: base + '-t', tabindex: '-1', text: '이미 담은 매물이라 그대로 두었어요.' }),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () { delete refreshOff[k]; redrawFocus(base + '-t'); } }, '바꿀 값 다시 보기'));
      }
      var ch = refreshChanges(target, e.prop);
      var list = ch.length ? h('ul', { class: 'imp-up-list', id: base + '-list' }, ch.map(function (c) {
        return h('li', {},
          h('span', { class: 'imp-up-k', text: c.label }),
          h('span', { class: 'imp-up-v' }, h('span', { class: 'imp-up-from', text: c.from }), ' → ', h('strong', { text: c.to })),
          c.hand ? h('span', { class: 'imp-up-hand', text: '직접 고친 값' }) : null);
      })) : h('p', { class: 'small muted', id: base + '-list', text: '바뀐 값이 없어요. 담아 둔 값과 같아요.' });
      // 같은 집인지 확실하지 않은 까닭(매물번호·층). 층이 다르면(conflict) [바꾸기]를 두지 않는다
      var conflict = match.floorConflict;
      var why = match.warn;
      var unsure = !match.sure;
      var upBtn = conflict ? null : h('button', { type: 'button', class: 'btn btn-small', disabled: !ch.length || (unsure && !sameOk[k]), 'aria-describedby': base + '-list', onclick: doUpdate }, '바꾸기');
      var sameCb = unsure && !conflict && ch.length ? h('input', { type: 'checkbox', id: base + '-same', checked: !!sameOk[k] }) : null;
      if (sameCb) sameCb.addEventListener('change', function () { sameOk[k] = sameCb.checked; upBtn.disabled = !sameCb.checked; });
      function doUpdate() {
        var hands = ch.filter(function (c) { return c.hand; });
        var others = ch.filter(function (c) { return !c.hand; }).map(function (c) { return c.label; });
        (hands.length ? confirmHandOverwrite(hands, others) : Promise.resolve({})).then(function (over) {
          if (over === null || view !== v) return;
          var p = findProp(target.id);
          if (!p) { toast('그 매물을 찾지 못했어요. 다른 탭에서 지웠을 수 있어요.'); return; }
          var keys = ch.filter(function (c) { return !c.hand || over[c.k]; }).map(function (c) { return c.k; });
          if (!keys.length) { toast('바꾼 값이 없어요. 직접 고친 값은 그대로 두었어요.'); return; }
          applyRefresh(p, e.prop, keys, finSourceOf(current));
          saveNow();
          var hist = keys.indexOf('kbPrice') >= 0 || keys.indexOf('askPrice') >= 0;
          refreshed[k] = { id: p.id, n: keys.length, hist: hist,
            changed: ch.filter(function (c) { return keys.indexOf(c.k) >= 0; }).map(function (c) { return c.label + ' ' + c.from + ' → ' + c.to; }),
            kept: ch.filter(function (c) { return keys.indexOf(c.k) < 0; }).map(function (c) { return c.label + ' ' + c.from + '(직접 고친 값)'; }) };
          picks[k] = false;
          homeReveal[p.id] = true;
          redrawFocus(base + '-t');
          toast('값을 바꿨어요.' + (hist ? ' 이전 값은 이력에 남겼어요.' : ''), { duration: 6000, action: { label: '매물 보기', fn: function () { navigate('/p/' + p.id); } } });
        });
      }
      return h('div', { class: 'imp-update' + (unsure || conflict ? ' is-unsure' : ''), id: base, role: 'group', 'aria-labelledby': base + '-t', 'aria-describedby': base + '-d' + (why.length ? ' ' + base + '-why' : '') },
        h('strong', { class: 'imp-up-title', id: base + '-t', tabindex: '-1', text: conflict ? '다른 집일 수 있어요' : unsure ? '이미 담은 매물일 수 있어요' : '이미 담은 매물이에요' }),
        h('p', { class: 'small', id: base + '-d', text: who + ' — ' + (conflict
          ? '층이 달라 값을 바꾸지 않아요. 다른 집이면 [새 매물로 담기]로 따로 담으세요.'
          : '새 매물을 만들지 않고 값만 바꿀 수 있어요. 호수·메모·체크 기록은 그대로예요.') }),
        why.length ? h('p', { class: 'imp-up-why', id: base + '-why', text: (conflict ? '' : '같은 집인지 확인해 주세요. ') + why.join('. ') + '.' }) : null,
        ch.length && !conflict ? h('p', { class: 'imp-up-sub', text: '바뀌는 값 (이전 → 새)' }) : null,
        conflict ? null : list,
        sameCb ? h('label', { class: 'toggle imp-up-same', for: base + '-same' }, sameCb, h('span', { text: '같은 집이 맞아요 (확인하면 [바꾸기]가 켜져요)' })) : null,
        h('div', { class: 'btn-row imp-up-btns' },
          upBtn,
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () {
            picks[k] = true;
            redrawFocus(null);
            toast('새 매물로 담도록 체크했어요. 아래 [담기]를 누르세요.', { duration: 4000 });
            try { submitBtn.focus({ preventScroll: false }); } catch (err) { /* 무시 */ }
          } }, '새 매물로 담기'),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: function () {
            refreshOff[k] = true;
            picks[k] = false;
            redrawFocus(base + '-t');
          } }, '취소')));
    }
    /** 미리보기를 다시 그리고 id 요소로 초점(스크롤 위치는 그대로). 같은 상태 줄은 다시 읽히지 않는다(setStatus) */
    function redrawFocus(id) {
      var y = window.scrollY;
      draw();
      window.scrollTo(0, y);
      var el = id ? document.getElementById(id) : null;
      if (el) { try { el.focus({ preventScroll: true }); } catch (err) { /* 무시 */ } }
    }
    function isOn(e) {
      var k = entryKey(e);
      return e.canImport && (hasOwn(picks, k) ? picks[k] : e.checked);
    }
    function chosen() { return current && current.ok ? current.entries.filter(isOn) : []; }

    /** 1.7.0 검토 반영: [바꾸기]로 값만 바꾼 항목 수와, 그 밖에 아직 담을 수 있는 항목 수 */
    function refreshedCounts() {
      var es = current && current.ok ? current.entries : [];
      var rn = es.filter(function (e) { return hasOwn(refreshed, entryKey(e)); }).length;
      var left = es.filter(function (e) { return e.canImport && !hasOwn(refreshed, entryKey(e)); }).length;
      return { refreshed: rn, left: left };
    }
    function refreshCount() {
      if (done) return; // 담는 중: 다시 살리지 않는다
      var n = chosen().length;
      var rc = refreshedCounts();
      submitBtn.disabled = !n;
      submitBtn.textContent = n ? n + '개 담기' : rc.refreshed && !rc.left ? '새로 담을 매물이 없어요' : '담을 매물을 골라 주세요';
    }

    function previewCard(e) {
      var p = e.prop;
      var k = entryKey(e);
      var on = isOn(e);
      var base = 'imp-' + e.index;
      // 1.4.1: 평에서 바꾼 면적은 근삿값이라 "약"을 붙인다(e.approx)
      var ax = e.approx || {};
      var size = [p.dong ? p.dong + '동' : '', p.area ? '전용 ' + (ax.area ? '약 ' : '') + p.area + '㎡' : '',
        p.supplyArea ? '공급 ' + (ax.supplyArea ? '약 ' : '') + p.supplyArea + '㎡' : ''].filter(Boolean).join(' · ');
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
        // 1.7.0 검토 반영: 카드 아래 "이미 담은 매물" 상자가 있으면 고른 대로 다시 그린다(체크하면 '새 매물로 담도록 골랐어요')
        if (document.getElementById(base + '-up')) redrawFocus(base + '-cb');
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
      var naver = !!(r && r.ok && r.source === 'naver');
      naverNote.hidden = !naver;
      if (!r || r.error === 'empty' || !r.ok) {
        setStatus([]);
        setError(r && !r.ok ? r.message : '');
        hint.hidden = true;
        actions.hidden = true;
        drawRegistry(null);
        return;
      }
      setError('');
      // 1.6.0 통합: 등기부 코드만 있음(매물 없음) → 넣을 매물 고르기 + [등기부 미리보기]. [담기] 바는 숨김
      if (!r.entries.length && r.registry) {
        setStatus(['등기부 코드를 찾았어요', '어느 매물의 등기부인지 고르고 [등기부 미리보기]를 누르세요. 아직 저장되지 않아요.']);
        hint.hidden = true;
        actions.hidden = true;
        drawRegistry(r);
        return;
      }
      drawRegistry(r);
      var offN = r.entries.filter(function (e) { return e.canImport && !e.checked; }).length;
      var dupN = r.entries.filter(function (e) { return e.warnings.some(function (w) { return w.code === 'exists' || w.code === 'gone' || w.code === 'repeat'; }); }).length;
      // 네이버 상세+목록 글: 경고 없이 기본 해제한 목록 매물
      var listOffN = r.entries.filter(function (e) { return e.fromList && e.canImport && !e.checked && !e.warnings.length; }).length;
      var lines = [
        (naver ? (r.kind === 'code' ? '네이버 글로 만든 코드에서 ' : '네이버 매물 글에서 ') : (r.blocks > 1 ? '코드 ' + r.blocks + '개에서 ' : '')) +
          '매물 ' + r.entries.length + '개를 찾았어요',
        // 1.4.1: 상세 화면 글인데 상세 매물을 못 읽음(목록 매물만, 모두 기본 해제)
        r.detailFailed ? '상세 화면 매물은 읽지 못했어요. 목록에서 읽은 매물만 보여요. 담을 것만 체크하세요.'
          : !offN ? '숫자가 화면과 맞는지 확인하고 담으세요.'
          : listOffN === offN ? '상세 화면 매물만 체크해 두었어요. 목록 매물 ' + listOffN + '개는 담을 것만 체크하세요.'
            : dupN === offN ? '이미 있는 매물 ' + dupN + '개는 빼 두었어요. 담을 매물만 체크하세요.'
              : '확인이 필요한 매물 ' + offN + '개는 체크를 빼 두었어요. 경고를 읽고 담을 매물만 체크하세요.'
      ];
      // 1.7.0 검토 반영: [바꾸기]로 값을 바꾼 뒤에는 그에 맞게(전에는 바꾼 뒤에도 '담을 매물만 체크하세요'가 남았음)
      var rc = refreshedCounts();
      if (rc.refreshed) lines[1] = '이미 담은 매물 ' + rc.refreshed + '개는 값을 바꿨어요. ' + (rc.left ? '새로 담을 매물만 체크하세요.' : '새로 담을 매물은 없어요.');
      if (r.truncated) lines.push('한 번에 ' + IMP.LIMITS.properties + '개까지 담을 수 있어요. 앞의 ' + IMP.LIMITS.properties + '개만 보여 줘요.');
      if (r.skipped) lines.push('읽을 수 없는 항목 ' + r.skipped + '개는 뺐어요.');
      if (r.incomplete) lines.push('글이 길어 뒷부분은 읽지 못했어요. 코드 부분만 붙여 넣어 주세요.');
      setStatus(lines);
      var idx = IMP.indexProps ? IMP.indexProps(state.properties) : null; // 1.7.0: 이미 담은 매물 찾기용
      r.entries.forEach(function (e) {
        list.append(previewCard(e));
        appendKid(list, updateBox(e, idx)); // 1.7.0: "이미 담은 매물이에요" → [바꾸기]/[새 매물로 담기]/[취소]
      });
      hint.hidden = false;
      actions.hidden = false;
      refreshCount();
    }

    /**
     * 1.6.0 통합: 등기부 코드 상자. 요약(열람 일시·소유자 수·살아 있는 기록)·경고·참고 문구.
     * 매물과 함께 온 코드면 "담는 매물에 함께 넣어요", 등기부만 있으면 넣을 매물 고르기(registry match 로 자동 선택) + [등기부 미리보기]
     */
    function drawRegistry(r) {
      regBox.textContent = '';
      var s = r && r.ok ? r.registry : null;
      regBox.hidden = !s;
      if (!s) return;
      var model = registryModelFromCode(s, r.registryNotes, r.registryWarnings);
      var liveN = {};
      Object.keys(model.live).forEach(function (k) { if (Array.isArray(model.live[k]) && model.live[k].length) liveN[k] = model.live[k].length; });
      var risky = REG_STOP_KINDS.filter(function (k) { return liveN[k]; });
      var sum = [regViewedText(model.viewedAt, model.docType), model.owners.length ? '소유자 ' + model.owners.length + '명' : '',
        risky.length ? '살아 있는 멈춤 기록: ' + risky.map(function (k) { return REG_KIND_LABEL[k] + ' ' + liveN[k] + '건'; }).join(', ') : '살아 있는 멈춤 기록 없음',
        liveN.mortgage ? '근저당 ' + liveN.mortgage + '건' : ''].filter(Boolean).join(' · ');
      var m = model.match || {};
      var where = [m.name, m.dong ? m.dong + '동' : '', m.ho ? m.ho + '호' : ''].filter(Boolean).join(' ');
      appendKid(regBox, [ // append 는 null 을 "null" 글자로 넣으므로 appendKid(빈 값 건너뜀)
        h('h3', { class: 'imp-reg-title', text: '등기부 코드' + (where ? ' · ' + where : '') }),
        h('p', { class: 'imp-reg-sum', text: sum }),
        (r.registryWarnings || []).length ? h('p', { class: 'imp-warns' }, r.registryWarnings.map(function (w) { return h('span', { class: 'imp-warn w-' + str(w.code), text: str(w.text) }); })) : null,
        (r.registryNotes || []).length ? h('p', { class: 'imp-notes', text: r.registryNotes.join(' · ') }) : null]);
      if (r.entries.length) {
        regBox.append(h('p', { class: 'small', text: '[담기]를 누르면 새로 담는 매물 가운데 동·단지명이 맞는 매물에 이 등기부를 함께 넣어요. 맞는 매물이 없으면 넣지 않고, 알림의 [등기부 미리보기]로 확인한 뒤 넣을 수 있어요. 담은 뒤 상세 화면 등기부 섹션에서 답을 확인하세요.' }));
        return;
      }
      var props = state.properties.filter(function (p) { return p.status !== 'dropped'; })
        .concat(state.properties.filter(function (p) { return p.status === 'dropped'; }));
      if (!props.length) {
        regBox.append(h('div', { class: 'notice', role: 'note' },
          h('strong', { text: '등기부를 넣을 매물이 없어요' }),
          h('p', { text: '먼저 매물을 추가한 뒤 이 코드를 다시 붙여 넣으세요.' }),
          h('a', { class: 'btn btn-small btn-secondary', href: '#/new' }, '매물 추가')));
        return;
      }
      var hit = matchRegistryTarget(s, props);
      if (regTarget && !findProp(regTarget)) regTarget = null;
      var chosen = regTarget || (hit && hit.prop ? hit.prop.id : '');
      // 1.6.0 검토 반영: 맞는 매물이 여럿(동점)이면 그 후보를 목록 맨 위에 두고 "여러 개예요"로 알린다
      var tie = hit && hit.tie ? hit.tie : [];
      if (tie.length) props = tie.concat(props.filter(function (p) { return tie.indexOf(p) < 0; }));
      var selId = 'imp-reg-target';
      var sel = h('select', { class: 'select', id: selId, 'aria-describedby': 'imp-reg-why' },
        chosen ? null : h('option', { value: '', text: '매물을 골라 주세요' }),
        props.map(function (p) {
          var u = [p.dong ? p.dong + '동' : '', p.ho ? p.ho + '호' : ''].filter(Boolean).join(' ');
          return h('option', { value: p.id, text: (tie.indexOf(p) >= 0 ? '후보 · ' : '') + p.name + (u ? ' · ' + u : '') + (p.status === 'dropped' ? ' (탈락)' : '') });
        }));
      sel.value = chosen;
      var why = h('p', { class: 'small muted', id: 'imp-reg-why', text: regTarget ? '직접 고른 매물이에요.'
        : hit && hit.prop ? '자동으로 골랐어요: ' + hit.why + '. 다르면 바꾸세요.'
          : tie.length ? '맞는 매물이 여러 개예요(' + tie.map(function (p) { return p.name + (p.dong ? ' ' + p.dong + '동' : '') + (p.ho ? ' ' + p.ho + '호' : ''); }).join(', ') + '). 골라 주세요.'
            : '맞는 매물을 찾지 못했어요. 직접 골라 주세요.' });
      var go = h('button', { type: 'button', class: 'btn btn-block btn-accent', disabled: !chosen }, '등기부 미리보기');
      sel.addEventListener('change', function () {
        regTarget = sel.value || null;
        go.disabled = !sel.value;
        why.textContent = sel.value ? '직접 고른 매물이에요.' : '매물을 골라 주세요.';
      });
      go.addEventListener('click', function () {
        var p = findProp(sel.value);
        if (!p) return;
        var mdl = prepareRegistryModel(p, registryModelFromCode(s, r.registryNotes, r.registryWarnings));
        registryPreview(p, mdl, {}).then(function (choice) {
          if ((choice.action !== 'apply' && choice.action !== 'record') || view !== v) return null;
          return answerFromRegistry(p, mdl, choice, null).then(function (res) {
            if (!res) return; // 답하지 못함(토스트로 알림)
            sessionRemove(IMPORT_TEXT_KEY);
            var g = gateSections()[0];
            if (g) pendingSection = g.id; // 상세가 등기부 섹션을 열고 그리로 스크롤
            homeReveal[p.id] = true;
            navigate('/p/' + p.id, true);
          });
        });
      });
      regBox.append(
        h('div', { class: 'field imp-reg-pick' }, h('label', { for: selId, text: '어느 매물의 등기부인가요?' }), sel, why),
        go);
    }

    function parseNow() {
      clearTimeout(timer);
      timer = null;
      // 1.4.0: 가져오기 코드를 먼저 찾고, 없거나 못 읽으면 네이버 매물 화면 글로 읽는다
      // 1.7.0: today = KB시세 기준일이 글에 없을 때 쓸 날(네이버 화면의 KB시세에는 날짜가 없음 → 가져온 날)
      current = (IMP.parseText || IMP.parse)(ta.value, { existing: state.properties, goneKeys: state.goneKeys, today: todayISO() });
      draw();
    }

    function onTextChange() {
      var text = ta.value;
      clearBtn.hidden = !text;
      refreshed = {}; // 1.7.0: 글이 바뀌면 "바꿨어요·그대로 두었어요" 표시를 지우고 새로 비교한다
      refreshOff = {};
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
        scrollToEl(naverNote.hidden ? status : naverNote); // 네이버 글이면 "숫자를 꼭 확인하세요"부터 보이게
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
          if (!t || !t.trim()) { toast('클립보드가 비어 있어요. Claude 답변이나 네이버 매물 글을 먼저 복사해 주세요.', { duration: 5000 }); return; }
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
      var src = current && current.source === 'naver' ? (IMP.NAVER_SOURCE_ID || 'naver-text') : IMP.SOURCE_ID; // 어디서 읽은 매물인지
      var hsrc = finSourceOf(current); // 1.7.0: 이력의 출처('naver' | 'code')
      var today = todayISO();
      var made = picked.map(function (e, i) {
        var p = e.prop;
        // 1.5.0(M7): 앱 안내 문장(면적 환산 안내 등)과 가져오기 참고 문구(e.notes)는 메모가 아니라 importNotes 로.
        // "다른 연락처: …" 같은 정보는 메모에 남는다(splitImportMemo)
        var sp = splitImportMemo(p.memo, e.notes);
        var memo = sp.memo;
        if (p.tradeType && p.tradeType !== '매매') memo = '거래 종류: ' + p.tradeType + (memo ? '\n' + memo : '');
        var raw = {
          id: uid(), name: p.name, dong: p.dong, ho: '', // 호수는 늘 사용자가 직접
          area: p.area, supplyArea: p.supplyArea, floor: p.floor, direction: p.direction,
          askPrice: p.askPrice, realPrice: p.realPrice, agentName: p.agentName, agentPhone: p.agentPhone,
          memo: memo, sourceUrl: p.sourceUrl, articleNo: p.articleNo, confirmedAt: p.confirmedAt,
          importNotes: sp.notes,
          status: 'review', createdAt: now, updatedAt: now - i, // 코드 순서대로 목록 맨 위에
          importedAt: now, source: src,
          fieldsAt: {} // 새 매물(예전 기록이 아님)
        };
        importFinInto(raw, p, hsrc, today, now - i); // 1.7.0: KB시세·관리비 등 참고값과 첫 이력
        return normalizeProperty(raw);
      });
      Array.prototype.unshift.apply(state.properties, made);
      made.forEach(function (p) { homeReveal[p.id] = true; }); // 1.5.1 검토 반영: 홈 필터·검색이 남아 있어도 담은 매물이 홈에서 보이게
      // 1.6.0 통합: 같은 코드에 등기부(registry)도 있으면 새로 담은 매물 가운데 동·단지명이 맞는 매물에 함께 넣는다.
      // 새 매물이라 덮어쓸 답이 없으므로 미리보기 없이 넣고, 답은 상세 화면 등기부 섹션에서 확인한다.
      // 1.6.0 검토 반영: 맞는 매물이 없거나 여럿이면(동이 다름 등) 넣지 않는다 — 다른 집의 "없음" 답이 새 매물에 들어가지 않게.
      // 토스트의 [등기부 미리보기]로 고른 매물에 미리보기를 거쳐 넣을 수 있다
      var regMsg = '';
      var regLater = null;
      if (current && current.registry) {
        var regCode = current.registry;
        var regNotes = current.registryNotes;
        var regWarns = current.registryWarnings;
        var regHit = matchRegistryTarget(regCode, made);
        if (regHit && regHit.prop) {
          var regProp = regHit.prop;
          var rm = registryModelFromCode(regCode, regNotes, regWarns);
          var ru = registryUnitCheck(regProp, rm.dong, rm.ho);
          var rr = applyRegistrySnapshot(regProp, rm.snap, { noRefresh: true, titleMismatch: ru.state === 'mismatch' ? ru.label : '' });
          if (rr.ok) regMsg = made.length > 1 ? ' 등기부 코드는 "' + regProp.name + '"에 넣었어요.' : ' 등기부 코드도 함께 넣었어요.';
        } else {
          regMsg = ' 등기부의 동·호' + (regHit && regHit.tie ? '로 담은 매물 하나를 고르지 못해' : '가 담은 매물과 맞지 않아') + ' 등기부는 넣지 않았어요.';
          var target = regHit && regHit.tie ? regHit.tie[0] : made[0];
          regLater = function () {
            // 지금 화면(호수를 적는 수정 폼 등) 위에 미리보기를 띄운다. 폼은 손댄 칸만 저장하므로 답·면적과 겹치지 않는다
            if (!findProp(target.id)) return;
            var mdl = prepareRegistryModel(target, registryModelFromCode(regCode, regNotes, regWarns));
            registryPreview(target, mdl, {}).then(function (choice) {
              if (choice.action === 'apply' || choice.action === 'record') return answerFromRegistry(target, mdl, choice, null);
            });
          };
        }
      }
      dirty = true;
      saveNow();
      sessionRemove(IMPORT_TEXT_KEY);
      // hashchange 를 기다리지 않고 이 클릭 안에서 다음 화면을 그린다(1개면 호수 칸에 바로 키보드가 뜨게)
      // 1.6.0 검토 반영: 등기부를 넣지 못했으면 토스트에 [등기부 미리보기](그 매물 상세로 가서 미리보기 → 답하기)
      var regOpt = regLater ? { duration: 15000, action: { label: '등기부 미리보기', fn: regLater } } : regMsg ? { duration: 4000 } : null;
      if (made.length === 1) {
        pendingFocus = 'ho';
        // 1.5.0 검토 반영: "호수만 입력하면 돼요"는 수정 폼의 배너가 같은 자리에서 말하므로 토스트에서 뺌
        toast(regMsg ? '매물을 담았어요.' + regMsg : '매물을 담았어요', regOpt);
        navigateNow('/p/' + made[0].id + '/edit', true);
      } else {
        toast(made.length + '개 담았어요. 호수를 입력해 주세요' + (regMsg ? '.' + regMsg : ''), regOpt || { duration: 4000 });
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
    { id: 'glossary', href: '#/glossary', label: '용어·링크', icon: 'book' }, // 1.4.5: 바로가기가 있다는 것이 이름에 보이게
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
    homeSel = { on: false, ids: {} }; // 화면을 옮기면(같은 화면을 새로 그려도) 홈 선택 모드를 끈다
    if (closeLightbox) closeLightbox();
    closeAllDialogs();
    revokeAllPhotoUrls();
    revokeAllDocUrls(); // 1.6.0: 서류 보기 임시 주소(이미 연 새 창은 다 읽은 뒤라 괜찮음)

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
    // 홈 선택 모드의 체크박스는 입력 중이 아니다(다시 그리면서 고른 것과 초점을 그대로 되살림, renderHome)
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.classList.contains('sel-check') && $('#main').contains(a));
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
    revokeAllDocUrls();
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
      refreshVersionBadge(); // 헤더 버전 표시를 [업데이트]로(1.3.2)
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
      expirePendingDelete(); // 내려가 있는 사이 되돌리기 시간이 지났으면 끝낸다
      syncFromOtherTabs(); // 다른 탭에서 바뀐 내용 가져오기
      checkForUpdate();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) { expirePendingDelete(); syncFromOtherTabs(); } });
    // 다른 탭(창)이 저장하면 바로 합쳐서 다시 그린다
    window.addEventListener('storage', function (e) {
      if (e.key === null || e.key === STORAGE_KEY) syncFromOtherTabs();
      else if (e.key === PHOTO_REV_KEY && view.name === 'home') refreshViewSoon(); // 1.5.1 검토 반영: 다른 탭이 사진을 넣고 지움 → "사진 있음" 다시 셈
    });
    // iOS Safari 는 touchstart 리스너가 있어야 버튼을 누를 때 :active 모양을 보여 준다
    document.addEventListener('touchstart', function () { /* :active 표시용 */ }, { passive: true });
    // 1.4.1: 버튼이 있는 토스트([되돌리기] 등)는 초점·손가락이 있는 동안 저절로 사라지지 않는다(holdToast)
    var toastEl = $('#toast');
    if (toastEl) {
      toastEl.addEventListener('focusin', function () { holdToast(true); });
      toastEl.addEventListener('focusout', function (e) { if (!toastEl.contains(e.relatedTarget)) holdToast(false); });
      toastEl.addEventListener('pointerenter', function () { holdToast(true); });
      toastEl.addEventListener('pointerleave', function () { if (!toastEl.contains(document.activeElement)) holdToast(false); });
    }

    if (!location.hash || location.hash === '#') {
      try { history.replaceState(null, '', '#/'); } catch (e) { /* 무시 */ }
    }
    onRoute();
    if (migratedOnLoad) { migratedOnLoad = false; scheduleSave(); } // 1.5.0 검토 반영: 옮긴 항목과 dataVersion 을 저장본에도

    if (loadProblem === 'blocked') showSaveError(new Error('blocked'));
    if (loadProblem === 'broken') {
      alertDialog('저장된 기록을 읽지 못했어요', '기록이 손상돼 새로 시작해요. 손상된 원본은 지우지 않고 따로 보관했어요. 백업 파일이 있다면 설정 → 백업 불러오기로 되살릴 수 있어요.');
    }
    // 1.6.0: 다른 탭이 예전 버전으로 사진 DB 를 열어 두어 업그레이드(서류함 추가)가 막히면 안내 띠, 풀리면 다시 그림
    IDB.onBlockedChange(showDbBlocked);
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
