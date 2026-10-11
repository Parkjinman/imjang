/*
 * 임장 체크리스트 — finance.js (1.7.0)
 * 집을 살 때 드는 돈(대출 한도·월 상환·취득세·중개보수·인지세·채권·필요 현금)과 재산세를 '추정'한다.
 *
 * - 브라우저: index.html 에서 app.js 전에 일반 스크립트로 불러온다 → window.ImjangFinance
 * - Node: 시험에서 require 한다 → module.exports
 * - DOM·저장소를 쓰지 않는다. 받은 객체는 고치지 않고 새 객체를 돌려준다.
 * - 어떤 입력에도 예외를 던지지 않는다. 못 읽은 값은 빈 값(null)으로 보고 notes 에 쉬운 말로 적는다.
 * - 모든 수치는 추정이다. 규칙은 RULES 한 곳에 모으고 근거(조문·시행일)를 적었다. RULES.asOf 는 확인한 날.
 *   어느 집을 사라·사지 말라는 판정은 하지 않는다(사실과 숫자만).
 *
 * 단위와 반올림
 *   - 입력 금액은 만원(숫자 또는 '1억 2,775만' 같은 글). 관리비 월평균(feeAvg)만 원(import-parser.js 의 feeAvg 와 같다).
 *   - 계산은 안에서 원(정수)으로 한다.
 *       취득세·지방교육세·농어촌특별세·재산세·도시지역분: 세목마다 10원 미만 버림(지방회계법 제55조)
 *       중개보수: 원 미만 버림(상한이므로), 부가세·인지세 몫·채권 비용: 원 단위 반올림
 *       국민주택채권 매입액: 1만원 미만 단수가 5천원 이상이면 1만원, 미만이면 버림(최저 1만원)
 *       대출 한도: 만원 아래 버림(한도를 넘지 않게)
 *       월 상환·이자: 원 단위 반올림
 *   - 결과 금액(만원) = 원 값을 1,000원 자리에서 반올림한 소수 첫째 자리 수(0.5 는 올림). 예: 647,290원 → 64.7
 *     합계는 원 단위로 먼저 더한 뒤 한 번만 바꾼다(그래서 항목 표시값을 더하면 0.1~0.2 차이가 날 수 있다).
 *     결과마다 won 객체에 원 단위 정수 값을 함께 준다. 정수 만원으로 보이려면 formatMan(값)(반올림).
 *
 * 공개 함수(모두 객체 하나를 받는다. 금액은 만원)
 *   defaultSettings()                                  기본 설정 사본
 *   normalizeSettings(settings)                        설정 검사(못 읽은 값은 기본값)
 *   suggestLtv(settings)                               지역·생애최초에 따른 규칙상 최대 LTV(%)
 *   loanLimit({ price, kb, settings, seniorLiens?, tenantDeposits? })
 *   payment({ principal, ratePct?, years?, method?, settings? })
 *   acquisitionCosts({ price, areaM2, firstHome?, kb?, publicPrice?, loan?, feeAvg?, settings })
 *   cashNeeded({ price, kb, areaM2, remodel, feeAvg, settings, firstHome?, publicPrice?, loan? })
 *   propertyTax({ publicPrice?, kb?, price?, year?, oneHouse?, prevPublicPrice? })
 *   holdingCost({ price, kb, publicPrice?, feeAvg, loan?, settings, year? })   year: 재산세를 계산할 해(없으면 2026)
 *   formatMan(만원, 소수자리?) → '1억 2,775만'      parseMan('1억 2,775만') → 12775
 *   BANG_GONGJE: 방공제 단계 목록(화면 고르기용)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangFinance = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = '1.7.0';
  var MAN = 10000;            // 1만원 = 10,000원
  var MAX_MAN = 10000000;     // 입력 금액 상한(1천억원). 넘으면 못 읽은 값으로 본다
  var INF = Infinity;

  // ───────────────────────── 규칙(이것만 고치면 된다) ─────────────────────────
  // 금액 키 이름이 Won 으로 끝나면 원, Pct 는 %, 나머지 비율은 소수(0.01 = 1%).
  var RULES = {
    asOf: '2026-10-11', // 아래 규칙을 이 날짜 현행으로 확인했다

    // ── 대출(주택구입목적 주담대) ──
    // 금융위 6·27 대책(2025-06-28 시행): 수도권·규제지역 생애최초 80→70%, 지방(규제지역 밖) 생애최초 80% 유지
    // 10·15 대책 FAQ 2-1(2025-10-16): 규제지역 무주택(처분조건부 1주택 포함) 70→40%. 2026-04-01·08-13 대책에서 유지
    ltvPct: {
      capital: 70,        // 수도권 비규제 무주택
      capitalFirst: 70,   // 수도권 비규제 생애최초
      regulated: 40,      // 규제지역 무주택
      regulatedFirst: 70, // 규제지역 생애최초(보도 2025-11-28 확인)
      local: 70,          // 지방 비규제 무주택
      localFirst: 80      // 지방 비규제 생애최초
    },
    // 10·15 FAQ(2025-10-16, 2026-08-13 유지): 수도권·규제지역 주택구입목적 주담대 최대 한도. 시가(KB 일반평균가 등) 기준, 이하/초과
    priceCapWon: [
      { upTo: 1500000000, cap: 600000000 }, // 15억 이하 → 6억
      { upTo: 2500000000, cap: 400000000 }, // 25억 이하 → 4억
      { upTo: INF, cap: 200000000 }         // 25억 초과 → 2억
    ],
    capitalMaxYears: 30,          // 6·27(2025-06-28): 수도권·규제지역 주담대 만기 30년 이내
    moveInMonths: 6,              // 6·27(2025-06-28): 수도권·규제지역 주택구입 주담대 6개월 안 전입(생애최초 디딤돌은 1개월)
    bankCapExampleWon: 300000000, // 은행 자율 한도 예(한 시중은행 2026-07-10~, 유지 여부 미확인) → 안내 문구에만 씀
    dsrBankPct: 40,               // 10·15 FAQ, 2026-08-13 대책 유지: 은행권 DSR 40%(앱은 소득을 받지 않아 안내에만 씀)

    // ── 방공제(최우선변제 소액보증금) ──
    // 주택임대차보호법 시행령 제10조①(개정 2023-02-21, 현행 2026-07-01 시행본), ② 주택가액의 1/2 한도. 아파트는 1개분(은행 실무)
    bangGongjeWon: {
      none: 0,                 // 빼지 않음(MCI·MCG 보험 가입 가정)
      seoul: 55000000,         // 1호 서울특별시
      'metro-dense': 48000000, // 2호 과밀억제권역(서울 제외)·세종·용인·화성·김포. 인천 계양·부평·미추홀 등(수도권정비계획법 시행령 별표1)
      'metro-city': 28000000,  // 3호 광역시(과밀억제권역·군 제외)·안산·광주·파주·이천·평택. 인천경제자유구역(송도·청라·영종 등)
      other: 25000000          // 4호 그 밖의 지역(인천 강화·옹진 포함)
    },
    bangGongjeHalf: 0.5,       // 같은 시행령 제10조②: 주택가액의 1/2 까지만

    // ── 취득세(무주택자가 주택 1채를 유상 취득) ──
    // 지방세법 제11조①8호(현행 2026-07-01 시행본): 6억 이하 1%, 6억 초과 9억 이하 (가액×2/3억−3)×1/100
    // (소수점 다섯째 자리 반올림, 넷째 자리까지), 9억 초과 3%
    acq: { lowUpToWon: 600000000, highOverWon: 900000000, lowRate: 0.01, highRate: 0.03 },
    eduOfAcq: 0.1,       // 지방세법 제151조①1호: 세율×50%로 산출한 금액의 20% = 취득세의 10%
    ruralRate: 0.002,    // 농어촌특별세법 제5조 표 6호(현행 2026-05-12): 표준세율 2%로 산출한 취득세의 10% = 가액의 0.2%
    ruralFreeAreaM2: 85, // 농특세법 제4조 11호·시행령 제4조⑤: 국민주택규모(전용 85㎡) 이하 비과세
    ruralOfRelief: 0.2,  // 농특세법 제5조 표 1호: 취득세 감면세액의 20%(85㎡ 이하는 제4조 9호로 비과세)

    // ── 생애최초 주택 취득세 감면 ── 지방세특례제한법 제36조의3①(개정 2025-12-31, 2026-01-01 시행, 2028-12-31 취득분까지)
    // 산출세액이 한도 이하면 면제, 넘으면 한도만큼 공제. 최소납부세제(제177조의2①) 적용 안 됨. 3년 안 매각·증여·임대 시 추징(④)
    firstHome: {
      maxPriceWon: 1200000000, // 취득당시가액 12억 이하
      limitWon: 2000000,       // 2호: 그 밖의 주택(아파트) 200만원
      limitSpecialWon: 3000000,// 1호: 소형 비아파트·인구감소지역 주택 300만원
      until: '2028-12-31',
      clawbackYears: 3
    },
    // 지특법 제36조의5(개정 2025-12-31, 2028-12-31 출산분까지): 출산·양육 주택 500만원 한도. 생애최초와 겹치면 큰 쪽 하나
    birth: { maxPriceWon: 1200000000, limitWon: 5000000 },

    // ── 중개보수(매매·교환, 한쪽이 내는 상한, 부가세 별도) ──
    // 공인중개사법 시행규칙 별표1(신설 2021-10-19, 현행 2026-08-28 시행본). 인천 조례 제2조①도 이 표를 따른다(2024-11-11)
    brokerTable: [
      { under: 50000000, rate: 0.006, capWon: 250000 }, // 5천만 미만 0.6%, 한도 25만
      { under: 200000000, rate: 0.005, capWon: 800000 },// 2억 미만 0.5%, 한도 80만
      { under: 900000000, rate: 0.004, capWon: null },  // 9억 미만 0.4%
      { under: 1200000000, rate: 0.005, capWon: null }, // 12억 미만 0.5%
      { under: 1500000000, rate: 0.006, capWon: null }, // 15억 미만 0.6%
      { under: INF, rate: 0.007, capWon: null }         // 15억 이상 0.7%
    ],
    brokerVat: 0.10,       // 일반과세자 부가세 10%(상한에 부가세가 들어 있지 않음)
    brokerVatSimple: 0.04, // 간이과세자: 부가세법 시행령 제111조② 부동산 관련 서비스업 부가가치율 40% × 10%

    // ── 인지세 ── 인지세법 제3조① 표 1·2호(현행 2026-01-02 시행본). 이하 기준
    stampTable: [
      { upTo: 10000000, won: 0 },
      { upTo: 30000000, won: 20000 },
      { upTo: 50000000, won: 40000 },
      { upTo: 100000000, won: 70000 },
      { upTo: 1000000000, won: 150000 },
      { upTo: INF, won: 350000 }
    ],
    stampSaleFreeUpToWon: 100000000, // 제6조 5호: 주택 소유권 이전 증서 1억 이하 비과세
    stampLoanFreeUpToWon: 50000000,  // 제6조 8호: 금전소비대차 증서 5천만 이하 비과세
    stampLoanShare: 0.5,             // 대출약정서는 은행과 반씩(여신거래 표준약관 관행)
    stampSaleShare: 1,               // 매매계약서는 매수인 보관(등기용)본 전액 기준. 매도인과 나누는 것은 협의(제1조② 연대 납세)

    // ── 법무사 비용(소유권이전등기) ── 규칙 legal_fee.estimate: 보수 50만 원(부가세 별도) + 등기 신청 수수료 1.5만 원.
    // 보수는 견적마다 다름(보통 30~70만 원). 1.7.0 검토 반영: 기본값을 범위 상단(70)에서 규칙 기본(51.5 = 50 + 1.5)으로
    legalFeeWon: 500000,
    registryFeeWon: 15000,

    // ── 국민주택채권(소유권이전등기 때 매입) ──
    // 주택도시기금법 시행령 별표(현행 2026-09-15 시행본) 15호 가목1) 주택. 시가표준액(공동주택가격) 미만 기준. metro = 특별시·광역시
    bondTable: [
      { under: 20000000, metro: 0, other: 0 },
      { under: 50000000, metro: 0.013, other: 0.013 },
      { under: 100000000, metro: 0.019, other: 0.014 },
      { under: 160000000, metro: 0.021, other: 0.016 },
      { under: 260000000, metro: 0.023, other: 0.018 },
      { under: 600000000, metro: 0.026, other: 0.021 },
      { under: INF, metro: 0.031, other: 0.026 }
    ],
    bondMinWon: 10000,     // 같은 별표 4호: 최저 1만원. 1만원 미만 단수는 5천원 이상 올림, 미만 버림
    bondUnitWon: 10000,
    bondHalfWon: 5000,
    bondDiscountPct: 16,   // 즉시 매도 할인율 기본값. 2026-10-09~12 약 15.99%(매 영업일 바뀜, 2026년 범위 약 13~17%)

    // ── 공시가격 추정 ── 2026년 공동주택 현실화율 69%(4년째 동결). 부동산원 시세 기준 전국 평균이라 근사치
    publicRatio: 0.69,

    // ── 재산세(주택) ──
    // 지방세법 시행령 제109조①2호(개정 2026-05-29, 시행 2026-10-01): 공정시장가액비율 60%.
    // 단, 2026년도 1세대1주택은 3억 이하 43%, 6억 이하 44%, 6억 초과 45%(2027년분은 다시 개정하지 않으면 60%)
    fmrBase: 0.60,
    fmrOneHouseYear: 2026,
    fmrOneHouse: [
      { upTo: 300000000, r: 0.43 },
      { upTo: 600000000, r: 0.44 },
      { upTo: INF, r: 0.45 }
    ],
    // 지방세법 제111조①3호 나목: 주택 표준세율(과세표준 이하 구간 → 고정액 + 넘는 부분 × 세율)
    propStd: [
      { upTo: 60000000, from: 0, fixed: 0, rate: 0.001 },
      { upTo: 150000000, from: 60000000, fixed: 60000, rate: 0.0015 },
      { upTo: 300000000, from: 150000000, fixed: 195000, rate: 0.0025 },
      { upTo: INF, from: 300000000, fixed: 570000, rate: 0.004 }
    ],
    // 지방세법 제111조의2①: 1세대1주택(시가표준액 9억 이하) 특례세율.
    // 법률 제17769호 부칙 제2조(개정 2023-12-29): 2026-12-28까지 성립한 납세의무만(2026년분까지). 2027년분은 연장 입법 필요
    propSpecial: [
      { upTo: 60000000, from: 0, fixed: 0, rate: 0.0005 },
      { upTo: 150000000, from: 60000000, fixed: 30000, rate: 0.001 },
      { upTo: 300000000, from: 150000000, fixed: 120000, rate: 0.002 },
      { upTo: INF, from: 300000000, fixed: 420000, rate: 0.0035 }
    ],
    specialMaxPubWon: 900000000,
    specialLastYear: 2026,
    cityRate: 0.0014,        // 지방세법 제112조①2호: 도시지역분 과세표준의 1천분의 1.4(조례로 2.3까지 다르게 정할 수 있음)
    propEduOfTax: 0.2,       // 지방세법 제151조①6호: 재산세(도시지역분 제외)의 20%
    baseCapRate: 0.05,       // 지방세법 제110조③·시행령 제109조의2: 과세표준상한율 5%
    oneShotMaxWon: 200000,   // 지방세법 제115조①3호: 재산세(도시지역분 포함) 20만원 이하면 조례로 7월에 한 번에
    taxBaseDate: '06-01',    // 과세기준일 6월 1일(그날 가진 사람이 그해 재산세를 낸다)
    jongbuOneHouseWon: 1200000000, // 종합부동산세법 제8조①1호(현행 2026-01-01): 1세대1주택 12억 공제

    // ── 기한·신고 ──
    reportDays: 30,               // 부동산 거래신고법 제3조①: 계약일부터 30일(중개 거래면 중개사가 신고)
    acqTaxDays: 60,               // 지방세법 제20조①: 취득일(잔금일 등)부터 60일(그 전에 등기하면 등기 접수일까지)
    registerDays: 60,             // 부동산등기 특별조치법 제2조①1호: 잔금일부터 60일
    fundingPlanWon: 600000000     // 거래신고법 시행령 별표1 3호(2026-10-01본): 6억 이상 또는 투기과열·조정대상지역이면 자금조달계획서
  };

  // 화면 고르기용 방공제 단계. 금액(man, 만원)과 이름 속 금액은 RULES.bangGongjeWon 에서 만든다
  var BANG_GONGJE = (function () {
    var list = [
      { key: 'none', name: '빼지 않음', hint: 'MCI·MCG 보험에 가입하면 빼지 않아요. 받아 주는 은행이 적어요.' },
      { key: 'seoul', name: '서울', hint: '서울특별시' },
      { key: 'metro-dense', name: '과밀억제권역',
        hint: '서울 밖 수도권 과밀억제권역(인천 계양·부평·미추홀 등)과 세종·용인·화성·김포' },
      { key: 'metro-city', name: '광역시',
        hint: '광역시(과밀억제권역·군 제외, 인천 송도·청라·영종 등)와 안산·광주·파주·이천·평택' },
      { key: 'other', name: '그 밖의 지역', hint: '위에 없는 지역(인천 강화·옹진 포함)' }
    ];
    for (var i = 0; i < list.length; i++) {
      list[i].man = RULES.bangGongjeWon[list[i].key] / MAN;
      list[i].label = list[i].man ? list[i].name + ' ' + formatMan(list[i].man) : list[i].name;
    }
    return list;
  })();

  var METHODS = { 'equal-payment': 1, 'equal-principal': 1 };
  var METHOD_ALIAS = { annuity: 'equal-payment', 'equal-principal-interest': 'equal-payment', principal: 'equal-principal' };
  var METHOD_LABEL = { 'equal-payment': '원리금균등', 'equal-principal': '원금균등' };

  var NOTE_ESTIMATE = '모두 추정이에요. 세금은 위택스·구청, 대출은 은행에서 꼭 확인하세요.';

  // ───────────────────────── 작은 도구 ─────────────────────────
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function has(o, k) { return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function get(o, k) { return has(o, k) ? o[k] : undefined; }
  function addNote(list, text) { if (list && text && list.indexOf(text) < 0) list.push(text); }
  function positive(n) { return isNum(n) && n > 0 ? n : null; }
  function roundHalfUp(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }
  // 계산값의 부동소수 오차(…999.9999)를 덮는 여유. 실제 금액의 소수 부분은 이보다 훨씬 굵다
  var EPS = 1e-6;
  function floorWon(x) { return Math.floor(x + EPS); }
  function floor10(x) { return Math.floor(x / 10 + EPS) * 10; } // 지방회계법 제55조: 10원 미만 버림
  function floorMan(won) { return Math.floor(won / MAN + EPS) * MAN; }
  /** 원 → 만원(소수 첫째 자리. 1,000원 자리에서 반올림) */
  function man1(won) {
    if (!isNum(won)) return null;
    var v = roundHalfUp(won / 1000) / 10;
    return v === 0 ? 0 : v; // -0 없애기
  }
  function comma(n) {
    var s = String(n), parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  /** 안내 문구용: 만원 → '4,800만 원'·'1억 원'·'7,500원' */
  function wonText(man, decimals) {
    var t = formatMan(man, decimals);
    return t && !/원$/.test(t) ? t + ' 원' : t;
  }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (var k in o) if (has(o, k)) deepFreeze(o[k]);
    }
    return o;
  }

  /** 숫자 또는 숫자 글('70', '4.5%', '1,500') → min~max 안의 수, 아니면 null */
  function numIn(v, min, max) {
    var n = v;
    if (typeof v === 'string') {
      var t = v.replace(/[\s,%]/g, '');
      n = /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
    }
    return (isNum(n) && n >= min && n <= max) ? n : null;
  }
  function boolIn(v) {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    return null;
  }
  function blank(v) { return v === undefined || v === null || (typeof v === 'string' && v.replace(/\s/g, '') === ''); }

  /** 만원 금액 입력 읽기. 비면 null. 못 읽거나 음수면 null + 메모 */
  function readMan(v, label, notes) {
    if (blank(v)) return null;
    var n = typeof v === 'number' ? v : (typeof v === 'string' ? parseMan(v) : NaN);
    if (!isNum(n) || n < 0 || n > MAX_MAN) {
      addNote(notes, label + ' 값을 읽지 못해 빼고 계산했어요.');
      return null;
    }
    return n;
  }
  /** 원 금액 입력 읽기(관리비). 글에 '만'·'억'이 있으면 parseMan 으로 */
  function readWon(v, label, notes, max) {
    if (blank(v)) return null;
    var n = NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string') {
      if (/[억만]/.test(v)) { var m = parseMan(v); n = m === null ? NaN : m * MAN; }
      else { var t = v.replace(/[\s,]/g, '').replace(/원$/, ''); n = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN; }
    }
    if (!isNum(n) || n < 0 || n > max) { addNote(notes, label + ' 값을 읽지 못해 빼고 계산했어요.'); return null; }
    return Math.round(n);
  }
  function readArea(v, notes) {
    if (blank(v)) return null;
    var n = typeof v === 'number' ? v : NaN;
    if (typeof v === 'string') {
      var t = v.replace(/[\s,]/g, '').replace(/(㎡|m²|m2|제곱미터)$/, '');
      n = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
    }
    if (!isNum(n) || n <= 0 || n > 1000) { addNote(notes, '전용면적 값을 읽지 못해 빼고 계산했어요.'); return null; }
    return n;
  }

  // ───────────────────────── 설정 ─────────────────────────
  /**
   * 기본 설정(사본). 금액은 만원.
   * 지역 기본값(capitalArea·regulated·metroCity·bangGongje)은 RULES 를 확인한 인천 계양구(수도권·비규제·광역시·과밀억제권역) 기준.
   * bangGongje 기본값은 '빼기'(metro-dense): 2026-10 현재 MCI·MCG 를 받아 주는 시중은행이 거의 없어서(규칙 bang_gongje.mci_mcg).
   */
  function defaultSettings() {
    return {
      ltv: RULES.ltvPct.capital, // % (수도권 비규제 70)
      ratePct: 4.5,            // 연 %
      years: 30,
      method: 'equal-payment', // 'equal-payment'(원리금균등) | 'equal-principal'(원금균등)
      firstHome: true,         // 생애최초(본인·배우자 모두 집을 가진 적 없음)
      bangGongje: 'metro-dense', // 'none' | 'seoul' | 'metro-dense' | 'metro-city' | 'other'
      vatOnBroker: true,       // true(일반과세 10%) | 'simple'(간이과세 약 4%) | false(없음)
      legalFee: (RULES.legalFeeWon + RULES.registryFeeWon) / MAN, // 법무사 비용(만원): 보수 50 + 등기 신청 수수료 1.5 = 51.5(부가세 별도)
      moving: 130,             // 이사비(만원)
      prepaidFeeMonths: 2,     // 선수관리비(관리비 예치금) 개월 수
      capitalArea: true,       // 수도권
      regulated: false,        // 규제지역(투기과열·조정대상)
      metroCity: true,         // 특별시·광역시(국민주택채권 요율)
      saleStampShare: 1,       // 매매계약서 인지세 중 내 몫(1 = 전액, 0.5 = 반)
      bondDiscountPct: RULES.bondDiscountPct, // 국민주택채권 즉시 매도 할인율(%). 0 이면 채권 비용을 빼고 계산
      depositPct: 10,          // 계약금 비율(%). 매도인과 정한다
      bankCap: null,           // 은행 자체 한도(만원). 없으면 null
      reliefSpecial: false,    // 생애최초 300만원 한도 주택(소형 비아파트·인구감소지역)
      birthRelief: false,      // 출산·양육 주택 감면(500만원 한도) 대상
      oneHouse: true           // 재산세 1세대1주택
    };
  }

  var SETTING_NUM = {
    ltv: [0, 100], ratePct: [0, 30], years: [1, 50], legalFee: [0, 1000], moving: [0, 10000],
    prepaidFeeMonths: [0, 12], saleStampShare: [0, 1], bondDiscountPct: [0, 100], depositPct: [0, 100]
  };
  var SETTING_BOOL = ['firstHome', 'capitalArea', 'regulated', 'metroCity', 'reliefSpecial', 'birthRelief', 'oneHouse'];
  var SETTING_LABEL = {
    ltv: 'LTV', ratePct: '금리', years: '대출 기간', legalFee: '법무사 비용', moving: '이사비',
    prepaidFeeMonths: '선수관리비 개월', saleStampShare: '인지세 몫', bondDiscountPct: '채권 할인율', depositPct: '계약금 비율',
    method: '상환 방식', bangGongje: '방공제', vatOnBroker: '중개 부가세', bankCap: '은행 한도',
    firstHome: '생애최초', capitalArea: '수도권', regulated: '규제지역', metroCity: '광역시', reliefSpecial: '감면 한도',
    birthRelief: '출산 감면', oneHouse: '1세대1주택'
  };

  /** 설정 검사. 없는 키는 기본값, 못 읽은 키는 기본값 + 메모(notes 를 주면) */
  function normalizeSettings(raw, notes) {
    var s = defaultSettings(), bad = [], k, i, v;
    if (raw === null || typeof raw !== 'object') return s;
    for (k in SETTING_NUM) {
      if (!has(SETTING_NUM, k) || !has(raw, k) || blank(raw[k])) continue;
      v = numIn(raw[k], SETTING_NUM[k][0], SETTING_NUM[k][1]);
      if (v === null) bad.push(k); else s[k] = v;
    }
    for (i = 0; i < SETTING_BOOL.length; i++) {
      k = SETTING_BOOL[i];
      if (!has(raw, k) || blank(raw[k])) continue;
      v = boolIn(raw[k]);
      if (v === null) bad.push(k); else s[k] = v;
    }
    if (has(raw, 'method') && !blank(raw.method)) {
      v = typeof raw.method === 'string' ? (METHOD_ALIAS[raw.method] || raw.method) : null;
      if (v && has(METHODS, v)) s.method = v; else bad.push('method');
    }
    if (has(raw, 'bangGongje') && !blank(raw.bangGongje)) {
      v = raw.bangGongje;
      if (typeof v === 'string' && has(RULES.bangGongjeWon, v)) s.bangGongje = v; else bad.push('bangGongje');
    }
    if (has(raw, 'vatOnBroker') && !blank(raw.vatOnBroker)) {
      v = raw.vatOnBroker === 'simple' ? 'simple' : boolIn(raw.vatOnBroker);
      if (v === null) bad.push('vatOnBroker'); else s.vatOnBroker = v;
    }
    if (has(raw, 'bankCap') && !blank(raw.bankCap)) {
      v = numIn(raw.bankCap, 0, MAX_MAN);
      if (v === null) bad.push('bankCap'); else s.bankCap = v;
    }
    if (bad.length && notes) {
      var names = [];
      for (i = 0; i < bad.length; i++) names.push(SETTING_LABEL[bad[i]] || bad[i]);
      addNote(notes, '설정(' + names.join(', ') + ')을 읽지 못해 기본값으로 계산했어요.');
    }
    return s;
  }

  /** 규칙상 최대 LTV(%) — 지역(수도권·규제지역)과 생애최초에 따라 */
  function ltvRule(s) {
    var L = RULES.ltvPct;
    if (s.regulated) return s.firstHome ? L.regulatedFirst : L.regulated;
    if (s.capitalArea) return s.firstHome ? L.capitalFirst : L.capital;
    return s.firstHome ? L.localFirst : L.local;
  }
  function capitalOrRegulated(s) { return !!(s.capitalArea || s.regulated); }

  // ───────────────────────── 규칙 계산(원) ─────────────────────────
  /** 취득세율(1/10000 단위 정수). 6~9억은 소수점 다섯째 자리 반올림 → 넷째 자리 */
  function acqRateBp(priceWon) {
    var A = RULES.acq;
    if (priceWon <= A.lowUpToWon) return Math.round(A.lowRate * 10000);
    if (priceWon > A.highOverWon) return Math.round(A.highRate * 10000);
    // (V × 2/3억 − 3) × 1/100 을 1/10000 단위로: (2V/3억 − 3) × 100 = (2V − 9억) / 300만. 0.5 는 올림(반올림)
    return Math.round((2 * priceWon - 900000000) / 3000000);
  }
  function brokerFeeWon(priceWon) {
    var T = RULES.brokerTable;
    for (var i = 0; i < T.length; i++) {
      if (priceWon < T[i].under) {
        var fee = floorWon(priceWon * T[i].rate);
        return T[i].capWon !== null && fee > T[i].capWon ? T[i].capWon : fee;
      }
    }
    return 0;
  }
  function stampWon(amountWon) {
    var T = RULES.stampTable;
    for (var i = 0; i < T.length; i++) if (amountWon <= T[i].upTo) return T[i].won;
    return 0;
  }
  function bondRate(pubWon, metro) {
    var T = RULES.bondTable;
    for (var i = 0; i < T.length; i++) if (pubWon < T[i].under) return metro ? T[i].metro : T[i].other;
    return 0;
  }
  /** 채권 매입액 단수 처리: 1만원 미만이 5천원 이상이면 1만원으로, 미만이면 버림. 최저 1만원 */
  function roundBond(x) {
    var unit = RULES.bondUnitWon, k = Math.floor(x / unit + EPS), rem = x - k * unit;
    var v = rem + EPS >= RULES.bondHalfWon ? (k + 1) * unit : k * unit;
    return v < RULES.bondMinWon ? RULES.bondMinWon : v;
  }
  function progressive(table, base) {
    for (var i = 0; i < table.length; i++) {
      if (base <= table[i].upTo) return table[i].fixed + (base - table[i].from) * table[i].rate;
    }
    return 0;
  }
  function priceCapWon(marketWon) {
    var T = RULES.priceCapWon;
    for (var i = 0; i < T.length; i++) if (marketWon <= T[i].upTo) return T[i].cap;
    return T[T.length - 1].cap;
  }

  // ───────────────────────── 대출 한도 ─────────────────────────
  function loanEmpty(notes) {
    return { ok: false, base: null, ltvAmount: null, deduction: null, limit: null, ltv: null, suggestedLtv: null,
      cap: null, basis: 'none', won: {}, notes: notes };
  }
  /**
   * 담보가치 = min(KB시세, 매매가). 한도 = 담보가치 × LTV − 방공제 − 선순위·임차보증금,
   * 수도권·규제지역이면 시가별 최대 한도(6억/4억/2억), 은행 자체 한도(settings.bankCap) 중 작은 값. 만원 아래 버림.
   */
  function loanLimitCore(o) {
    var notes = [];
    var s = normalizeSettings(get(o, 'settings'), notes);
    var price = positive(readMan(get(o, 'price'), '매매가', notes));
    var kb = positive(readMan(get(o, 'kb'), 'KB시세', notes));
    var senior = readMan(get(o, 'seniorLiens'), '선순위 채권', notes) || 0;
    var tenant = readMan(get(o, 'tenantDeposits'), '임차보증금', notes) || 0;
    if (price === null && kb === null) {
      addNote(notes, '매매가나 KB시세를 넣으면 대출 한도를 계산해요.');
      return loanEmpty(notes);
    }
    var priceW = price === null ? null : Math.round(price * MAN);
    var kbW = kb === null ? null : Math.round(kb * MAN);
    var baseW, basis;
    if (kbW === null) {
      baseW = priceW; basis = 'price';
      addNote(notes, 'KB시세 없음: 매매가로 계산했어요. 은행은 KB시세나 감정가로 봐요.');
    } else if (priceW === null) {
      baseW = kbW; basis = 'kb';
      addNote(notes, '매매가가 없어 KB시세로 계산했어요.');
    } else if (priceW < kbW) {
      baseW = priceW; basis = 'price';
      addNote(notes, '매매가가 KB시세보다 낮아 매매가로 계산했어요(둘 중 낮은 값).');
    } else {
      baseW = kbW; basis = 'kb';
    }

    var rule = ltvRule(s), ltv = s.ltv;
    if (ltv > rule) {
      addNote(notes, '규칙상 LTV는 최대 ' + rule + '%라서 ' + rule + '%로 계산했어요.');
      ltv = rule;
    }
    var ltvW = floorWon(baseW * ltv / 100);
    var bgFull = RULES.bangGongjeWon[s.bangGongje] || 0;
    var dedW = Math.min(bgFull, floorWon(baseW * RULES.bangGongjeHalf));
    var otherW = Math.round(senior * MAN) + Math.round(tenant * MAN);
    var rawW = ltvW - dedW - otherW;
    var limitW = rawW, capW = null, capBy = null;
    if (capitalOrRegulated(s)) {
      // 시가: KB시세(없으면 매매가)
      capW = priceCapWon(kbW !== null ? kbW : priceW);
      if (capW < limitW) { limitW = capW; capBy = 'law'; }
    }
    if (s.bankCap !== null) {
      var bankW = Math.round(s.bankCap * MAN);
      if (bankW < limitW) { limitW = bankW; capBy = 'bank'; }
      if (capW === null || bankW < capW) capW = bankW;
    }
    limitW = Math.max(0, floorMan(limitW));

    if (dedW > 0) {
      addNote(notes, '방공제 ' + wonText(dedW / MAN) + '을 뺐어요(소액 임차인 몫). MCI·MCG 보험에 가입하면 빼지 않아요.');
    } else if (s.bangGongje === 'none') {
      addNote(notes, '방공제를 빼지 않았어요(MCI·MCG 가입 가정). 받아 주는 은행이 적어요. 안 되면 한도가 줄어요.');
    }
    if (otherW > 0) addNote(notes, '선순위 채권·임차보증금 ' + wonText(otherW / MAN) + '을 뺐어요.');
    if (capBy === 'law') addNote(notes, '수도권·규제지역은 집값에 따라 대출이 최대 ' + wonText(capW / MAN) + '까지예요.');
    if (capBy === 'bank') addNote(notes, '은행 자체 한도 ' + wonText(s.bankCap) + '으로 줄였어요.');
    if (limitW > RULES.bankCapExampleWon && s.bankCap === null) {
      addNote(notes, '은행마다 자체 한도가 더 낮을 수 있어요(예: 최대 ' + wonText(RULES.bankCapExampleWon / MAN) + ').');
    }
    if (capitalOrRegulated(s)) {
      addNote(notes, '수도권·규제지역은 대출받고 ' + RULES.moveInMonths + '개월 안에 전입해야 해요.');
      if (s.years > RULES.capitalMaxYears) addNote(notes, '수도권·규제지역 주담대 만기는 ' + RULES.capitalMaxYears + '년까지예요.');
    }
    addNote(notes, '이 계산은 LTV(집값 대비 대출 비율) 기준이에요. 실제 한도는 소득(DSR)에 따라 더 줄 수 있어요.');
    addNote(notes, '디딤돌·보금자리론 같은 정책대출은 한도·금리가 따로예요(이 계산에 없음).');
    addNote(notes, NOTE_ESTIMATE);

    return {
      ok: true,
      base: man1(baseW), ltvAmount: man1(ltvW), deduction: man1(dedW), limit: man1(limitW),
      ltv: ltv, suggestedLtv: rule, cap: capW === null ? null : man1(capW), basis: basis,
      won: { base: baseW, ltvAmount: ltvW, deduction: dedW, other: otherW, limit: limitW, cap: capW },
      notes: notes
    };
  }

  // ───────────────────────── 월 상환 ─────────────────────────
  function paymentEmpty(notes) {
    return { ok: false, firstMonth: null, avgMonth: null, lastMonth: null, firstYearInterest: null, totalInterest: null,
      months: null, method: null, ratePct: null, years: null, won: {}, notes: notes };
  }
  /**
   * 원리금균등: M = P·r·(1+r)^n / ((1+r)^n − 1) (r = 0 이면 P/n)
   * 원금균등: 매달 원금 P/n + 남은 원금 × r
   * 첫해 이자 = 첫 12개월(기간이 더 짧으면 그 기간) 이자 합
   */
  function paymentCore(o) {
    var notes = [];
    var s = normalizeSettings(get(o, 'settings'), notes);
    var P = readMan(get(o, 'principal'), '대출 원금', notes);
    var rate = blank(get(o, 'ratePct')) ? s.ratePct : numIn(get(o, 'ratePct'), 0, 30);
    var years = blank(get(o, 'years')) ? s.years : numIn(get(o, 'years'), 1 / 12, 50);
    var method = s.method;
    if (!blank(get(o, 'method'))) {
      var mm = typeof o.method === 'string' ? (METHOD_ALIAS[o.method] || o.method) : null;
      if (mm && has(METHODS, mm)) method = mm; else addNote(notes, '상환 방식을 몰라 ' + METHOD_LABEL[method] + '으로 계산했어요.');
    }
    if (rate === null) { rate = s.ratePct; addNote(notes, '금리를 읽지 못해 ' + rate + '%로 계산했어요.'); }
    if (years === null) { years = s.years; addNote(notes, '기간을 읽지 못해 ' + years + '년으로 계산했어요.'); }
    if (P === null) { addNote(notes, '대출 원금을 넣으면 월 상환액을 계산해요.'); return paymentEmpty(notes); }

    var PW = Math.round(P * MAN);
    var n = Math.max(1, Math.round(years * 12));
    var r = rate / 100 / 12;
    var m = Math.min(12, n);
    var first, avg, last, year1, total;
    if (method === 'equal-principal') {
      var p = PW / n;
      first = p + PW * r;
      last = p + p * r;
      total = r * PW * (n + 1) / 2;
      year1 = r * (m * PW - p * m * (m - 1) / 2);
      avg = (PW + total) / n;
      addNote(notes, '원금균등: 처음에 가장 많이 내고 매달 조금씩 줄어요.');
    } else {
      var M;
      if (r === 0) {
        M = PW / n; year1 = 0;
      } else {
        var g = Math.pow(1 + r, n);
        M = PW * r * g / (g - 1);
        var gm = Math.pow(1 + r, m);
        var balM = PW * gm - M * (gm - 1) / r; // m 개월 뒤 남은 원금
        year1 = m * M - (PW - balM);
      }
      first = M; last = M; avg = M;
      total = M * n - PW;
      addNote(notes, '원리금균등: 매달 같은 금액을 내요.');
    }
    if (PW === 0) { first = 0; last = 0; avg = 0; year1 = 0; total = 0; }
    var won = {
      principal: PW, firstMonth: Math.round(first), avgMonth: Math.round(avg), lastMonth: Math.round(last),
      firstYearInterest: Math.round(year1), totalInterest: Math.round(total)
    };
    if (rate === 0) addNote(notes, '금리 0%로 계산했어요(이자 없음).');
    addNote(notes, '금리가 바뀌면(변동·혼합 금리) 월 상환액도 달라져요. 은행 상환표로 확인하세요.');
    return {
      ok: true,
      firstMonth: man1(won.firstMonth), avgMonth: man1(won.avgMonth), lastMonth: man1(won.lastMonth),
      firstYearInterest: man1(won.firstYearInterest), totalInterest: man1(won.totalInterest),
      months: n, method: method, ratePct: rate, years: n / 12, won: won, notes: notes
    };
  }

  // ───────────────────────── 매수 부대비용 ─────────────────────────
  var COST_KEYS = ['acqTax', 'firstHomeRelief', 'acqTaxDue', 'eduTax', 'eduTaxBefore', 'ruralTax', 'broker', 'brokerVat',
    'stamp', 'stampSale', 'stampLoan', 'legalFee', 'bond', 'bondCost', 'moving', 'prepaidFee', 'taxTotal', 'total'];
  function costEmpty(notes) {
    var r = { ok: false, won: {}, itemNotes: {}, notes: notes, publicPrice: null, publicBasis: 'none', acqRatePct: null, reliefKind: null };
    for (var i = 0; i < COST_KEYS.length; i++) r[COST_KEYS[i]] = null;
    return r;
  }

  /** 추정 공시가격(원): 공시가격 > KB시세 × 69% > 매매가 × 69% */
  function publicPriceWon(pub, kb, price) {
    if (pub !== null) return { won: Math.round(pub * MAN), basis: 'public' };
    var src = kb !== null ? kb : price;
    if (src === null) return { won: null, basis: 'none' };
    return { won: Math.round(src * MAN * RULES.publicRatio), basis: 'estimate' };
  }

  function acquisitionCore(o) {
    var notes = [], IN = {};
    var s = normalizeSettings(get(o, 'settings'), notes);
    var price = positive(readMan(get(o, 'price'), '매매가', notes));
    if (price === null) { addNote(notes, '매매가를 넣으면 세금·수수료를 계산해요.'); return costEmpty(notes); }
    var kb = positive(readMan(get(o, 'kb'), 'KB시세', notes));
    var pub = positive(readMan(get(o, 'publicPrice'), '공시가격', notes));
    var area = readArea(get(o, 'areaM2'), notes);
    var feeAvg = readWon(get(o, 'feeAvg'), '관리비', notes, 10000000);
    var fh = boolIn(get(o, 'firstHome'));
    if (fh !== null) s.firstHome = fh;
    var loanIn = get(o, 'loan');
    var loan = readMan(loanIn, '대출', notes);
    if (loan === null) loan = loanLimitCore({ price: price, kb: kb, settings: s }).limit || 0;

    var V = Math.round(price * MAN), W = {};
    function note(key, text) { if (!IN[key]) IN[key] = []; addNote(IN[key], text); }

    // 취득세·지방교육세
    var bp = acqRateBp(V);
    W.acqTax = floor10(V * bp / 10000);
    W.eduTaxBefore = floor10(V * bp / 10000 * RULES.eduOfAcq);
    var lowT = wonText(RULES.acq.lowUpToWon / MAN), highT = wonText(RULES.acq.highOverWon / MAN);
    if (V <= RULES.acq.lowUpToWon) note('acqTax', '무주택자가 집 한 채를 살 때 ' + lowT + ' 이하는 ' + (bp / 100) + '%예요.');
    else if (V <= RULES.acq.highOverWon) note('acqTax', lowT + '~' + highT + '은 가격에 따라 1~3%예요(이 집 ' + (bp / 100) + '%).');
    else note('acqTax', highT + ' 넘으면 ' + (bp / 100) + '%예요.');
    note('acqTax', '집이 이미 있으면 세율이 달라요(이 계산에 없음).');
    note('acqTax', '잔금일부터 ' + RULES.acqTaxDays + '일 안에 내요(그 전에 등기하면 등기 때까지).');
    note('eduTax', '지방교육세는 취득세의 10%예요.');

    // 감면(생애최초·출산 중 큰 쪽 하나)
    W.firstHomeRelief = 0;
    var reliefKind = null, limit = 0;
    if (s.firstHome || s.birthRelief) {
      if (V > RULES.firstHome.maxPriceWon) {
        note('firstHomeRelief', wonText(RULES.firstHome.maxPriceWon / MAN) + '이 넘으면 감면을 받을 수 없어요.');
      } else {
        var lf = s.firstHome ? (s.reliefSpecial ? RULES.firstHome.limitSpecialWon : RULES.firstHome.limitWon) : 0;
        var lb = s.birthRelief ? RULES.birth.limitWon : 0;
        limit = Math.max(lf, lb);
        reliefKind = lb > lf ? 'birth' : 'firstHome';
        W.firstHomeRelief = Math.min(W.acqTax, limit);
        var lname = reliefKind === 'birth' ? '출산·양육 감면' : '생애최초 감면';
        note('firstHomeRelief', lname + ': 취득세가 ' + wonText(limit / MAN) + ' 이하면 전부 면제, 넘으면 ' +
          wonText(limit / MAN) + '을 빼 줘요.');
        note('firstHomeRelief', '3년 안에 팔거나 증여·임대하면 감면받은 세금을 이자와 함께 다시 내요.');
        if (reliefKind === 'firstHome') note('firstHomeRelief', '본인·배우자 모두 집을 가진 적이 없어야 해요. 위택스·구청에서 확인하세요.');
      }
    }
    // 1.7.0 검토 반영: 출산·양육 감면(지특법 제36조의5)을 켜지 않았으면 빠져 있다고 알린다(대상이면 세금이 크게 줄 수 있음)
    if (!s.birthRelief && V <= RULES.birth.maxPriceWon) {
      note('firstHomeRelief', '출산·양육 주택 감면(' + wonText(RULES.birth.limitWon / MAN) + ' 한도)은 넣지 않았어요. 대상이면 계산 조건에서 켜 주세요' +
        '(생애최초 감면과 겹치면 큰 쪽 하나만 받아요).');
    }
    W.acqTaxDue = W.acqTax - W.firstHomeRelief;
    if (W.firstHomeRelief > 0 && W.acqTax <= limit) {
      W.eduTax = 0;
      note('eduTax', '취득세가 면제되면 지방교육세도 0원이에요.');
    } else if (W.firstHomeRelief > 0) {
      W.eduTax = floor10(W.eduTaxBefore * (1 - limit / W.acqTax));
      note('eduTax', '감면 비율만큼 줄여 계산했어요(실무 방식).');
    } else {
      W.eduTax = W.eduTaxBefore;
    }

    // 농어촌특별세
    W.ruralTax = 0;
    if (area === null) {
      note('ruralTax', '전용면적을 넣으면 농어촌특별세(' + RULES.ruralFreeAreaM2 + '㎡ 넘을 때)를 계산해요.');
    } else if (area <= RULES.ruralFreeAreaM2) {
      note('ruralTax', '전용 ' + RULES.ruralFreeAreaM2 + '㎡ 이하라 농어촌특별세가 없어요.');
    } else {
      W.ruralTax = floor10(V * RULES.ruralRate) + (W.firstHomeRelief > 0 ? floor10(W.firstHomeRelief * RULES.ruralOfRelief) : 0);
      note('ruralTax', '전용 ' + RULES.ruralFreeAreaM2 + '㎡ 초과라 매매가의 ' + (RULES.ruralRate * 100) + '%예요' +
        (W.firstHomeRelief > 0 ? '(감면받은 세금의 ' + (RULES.ruralOfRelief * 100) + '%도 더해요).' : '.'));
    }

    // 중개보수
    W.broker = brokerFeeWon(V);
    var vr = s.vatOnBroker === 'simple' ? RULES.brokerVatSimple : (s.vatOnBroker ? RULES.brokerVat : 0);
    W.brokerVat = Math.round(W.broker * vr);
    note('broker', '법정 상한이에요. 협의로 더 낮을 수 있어요.');
    if (s.vatOnBroker === 'simple') note('brokerVat', '간이과세자 중개사라 약 4%로 잡았어요.');
    else if (s.vatOnBroker) note('brokerVat', '일반과세자 중개사는 부가세 10%를 따로 받아요(간이과세자면 약 4%).');
    else note('brokerVat', '부가세를 빼고 계산했어요.');

    // 인지세(내 몫)
    var saleFull = V <= RULES.stampSaleFreeUpToWon ? 0 : stampWon(V);
    var loanW = Math.round(loan * MAN);
    var loanFull = loanW <= RULES.stampLoanFreeUpToWon ? 0 : stampWon(loanW);
    W.stampSale = Math.round(saleFull * s.saleStampShare);
    W.stampLoan = Math.round(loanFull * RULES.stampLoanShare);
    W.stamp = W.stampSale + W.stampLoan;
    // 1.7.0 검토 반영: 0원이면 나누는 방식이 아니라 비과세라는 이유를 적는다(제6조 5호·8호)
    var saleT = saleFull === 0 ? '0원(' + wonText(RULES.stampSaleFreeUpToWon / MAN) + ' 이하 비과세)'
      : wonText(W.stampSale / MAN, 1) + (s.saleStampShare === 1 ? '(등기용 계약서 전액. 매도인과 나누기도 해요)' : '(내 몫)');
    var loanT = loanFull === 0 ? '0원(' + (loanW > 0 ? wonText(RULES.stampLoanFreeUpToWon / MAN) + ' 이하 비과세' : '대출 없음') + ')'
      : wonText(W.stampLoan / MAN, 1) + '(은행과 반씩)';
    note('stamp', '매매계약서 ' + saleT + ' + 대출약정서 ' + loanT + '.');

    // 국민주택채권 즉시 매도 비용
    var pp = publicPriceWon(pub, kb, price);
    var br = pp.won === null ? 0 : bondRate(pp.won, s.metroCity);
    W.bond = br > 0 ? roundBond(pp.won * br) : 0;
    W.bondCost = Math.round(W.bond * s.bondDiscountPct / 100);
    if (W.bond > 0) {
      note('bondCost', '등기 때 사는 국민주택채권(' + wonText(W.bond / MAN, 1) + ')을 바로 팔 때 드는 비용이에요(할인율 ' +
        s.bondDiscountPct + '%, 매일 바뀌어요).');
      if (pp.basis === 'estimate') note('bondCost', '공시가격을 몰라 ' + (kb !== null ? 'KB시세' : '매매가') + '×69%로 추정했어요.');
      // 1.7.0 검토 반영: 요율이 지역(특별시·광역시 여부)에 따라 다르다는 가정을 적는다
      note('bondCost', s.metroCity ? '특별시·광역시 요율로 계산했어요(그 밖의 시·군은 요율이 더 낮을 수 있어요).'
        : '특별시·광역시가 아닌 지역 요율로 계산했어요.');
    } else {
      note('bondCost', pp.won === null ? '공시가격을 몰라 채권 비용을 빼고 계산했어요.'
        : '공시가격 ' + wonText(RULES.bondTable[0].under / MAN) + ' 미만이라 채권을 사지 않아요.');
    }

    // 법무사·이사·선수관리비(직접 정한 값)
    W.legalFee = Math.round(s.legalFee * MAN);
    // 1.7.0 검토 반영: 기본값은 규칙의 법무사 보수 50만 원 + 등기 신청 수수료 1.5만 원(부가세 별도)
    if (s.legalFee === defaultSettings().legalFee) {
      note('legalFee', '법무사 보수 약 ' + wonText(RULES.legalFeeWon / MAN) + '과 등기 신청 수수료 ' + wonText(RULES.registryFeeWon / MAN, 1) +
        '으로 잡았어요(부가세 별도). 견적마다 달라요(보수는 보통 30~70만 원). 직접 등기하면 줄어요.');
    } else {
      note('legalFee', '직접 넣은 값이에요. 법무사 보수는 견적마다 달라요(보통 30~70만 원, 부가세 별도). 직접 등기하면 줄어요.');
    }
    W.moving = Math.round(s.moving * MAN);
    note('moving', '직접 넣은 예상값이에요.');
    if (feeAvg === null) {
      W.prepaidFee = 0;
      note('prepaidFee', '관리비 월평균을 넣으면 선수관리비를 계산해요.');
    } else {
      W.prepaidFee = Math.round(feeAvg * s.prepaidFeeMonths);
      note('prepaidFee', '관리비 월평균 × ' + s.prepaidFeeMonths + '개월로 잡았어요. 단지마다 달라요. 관리사무소에 확인하세요.');
    }

    W.taxTotal = W.acqTaxDue + W.eduTax + W.ruralTax;
    W.total = W.taxTotal + W.broker + W.brokerVat + W.stamp + W.legalFee + W.bondCost + W.moving + W.prepaidFee;
    addNote(notes, NOTE_ESTIMATE);

    var r = { ok: true, won: W, itemNotes: IN, notes: notes, acqRatePct: bp / 100, reliefKind: reliefKind,
      publicPrice: pp.won === null ? null : man1(pp.won), publicBasis: pp.basis, loanUsed: man1(loanW) };
    for (var i = 0; i < COST_KEYS.length; i++) r[COST_KEYS[i]] = man1(W[COST_KEYS[i]]);
    return r;
  }

  // ───────────────────────── 필요 현금 ─────────────────────────
  function cashEmpty(notes) {
    return { ok: false, totalCost: null, loan: null, cash: null, timeline: { contract: null, balanceDay: null, after: null },
      items: [], won: {}, loanInfo: null, costs: null, payment: null, notes: notes };
  }
  /**
   * 총비용 = 매매가 + 수리비 + 부대비용(acquisitionCosts.total). 필요 현금 = 총비용 − 대출.
   * 때(timeline): contract(계약금) · balanceDay(잔금일: 잔금 중 대출 밖 몫 + 세금·수수료·채권·선수관리비) · after(이사·수리)
   */
  function cashCore(o) {
    var notes = [];
    var s = normalizeSettings(get(o, 'settings'), notes);
    var fh = boolIn(get(o, 'firstHome'));
    if (fh !== null) s.firstHome = fh;
    var price = positive(readMan(get(o, 'price'), '매매가', notes));
    if (price === null) { addNote(notes, '매매가를 넣으면 필요한 현금을 계산해요.'); return cashEmpty(notes); }
    var kb = positive(readMan(get(o, 'kb'), 'KB시세', notes));
    var remodel = readMan(get(o, 'remodel'), '수리비', notes) || 0;

    var loanInfo = loanLimitCore({ price: price, kb: kb, settings: s, seniorLiens: get(o, 'seniorLiens'),
      tenantDeposits: get(o, 'tenantDeposits') });
    var loan = loanInfo.limit || 0;
    var loanGiven = readMan(get(o, 'loan'), '대출', notes);
    if (loanGiven !== null) {
      if (loanGiven > loan) addNote(notes, '넣은 대출(' + wonText(loanGiven) + ')이 계산한 한도(' + wonText(loan) + ')보다 커요.');
      loan = loanGiven;
    }
    var costs = acquisitionCore({ price: price, kb: kb, publicPrice: get(o, 'publicPrice'), areaM2: get(o, 'areaM2'),
      feeAvg: get(o, 'feeAvg'), loan: loan, settings: s });
    var years = s.years;
    if (capitalOrRegulated(s) && years > RULES.capitalMaxYears) years = RULES.capitalMaxYears;
    var pay = paymentCore({ principal: loan, ratePct: s.ratePct, years: years, method: s.method });

    var V = Math.round(price * MAN), loanW = Math.round(loan * MAN), remodelW = Math.round(remodel * MAN), CW = costs.won;
    var depositW = Math.round(V * s.depositPct / 100);
    if (V - depositW < loanW) {
      depositW = Math.max(0, V - loanW);
      addNote(notes, '대출이 커서 계약금을 ' + wonText(man1(depositW)) + '으로 줄여 나눴어요.');
    }
    var balanceW = V - depositW - loanW; // 잔금 중 내 돈으로 낼 몫(음수면 대출이 매매가보다 큼)
    var items = [];
    function item(key, label, won, when, extra) {
      items.push({ key: key, label: label, amount: man1(won), when: when, notes: (extra || []).slice() });
    }
    item('deposit', '계약금(' + s.depositPct + '%)', depositW, 'contract', ['비율은 매도인과 정해요.']);
    item('balance', '잔금(대출 뺀 몫)', balanceW, 'balanceDay', []);
    item('acqTax', CW.firstHomeRelief > 0 ? '취득세(감면 반영)' : '취득세', CW.acqTaxDue, 'balanceDay',
      (costs.itemNotes.acqTax || []).concat(costs.itemNotes.firstHomeRelief || []));
    item('eduTax', '지방교육세', CW.eduTax, 'balanceDay', costs.itemNotes.eduTax);
    item('ruralTax', '농어촌특별세', CW.ruralTax, 'balanceDay', costs.itemNotes.ruralTax);
    item('broker', '중개보수', CW.broker, 'balanceDay', costs.itemNotes.broker);
    item('brokerVat', '중개보수 부가세', CW.brokerVat, 'balanceDay', costs.itemNotes.brokerVat);
    item('stamp', '인지세(내 몫)', CW.stamp, 'balanceDay', costs.itemNotes.stamp);
    item('legalFee', '법무사 비용', CW.legalFee, 'balanceDay', costs.itemNotes.legalFee);
    item('bondCost', '국민주택채권 비용', CW.bondCost, 'balanceDay', costs.itemNotes.bondCost);
    item('prepaidFee', '선수관리비', CW.prepaidFee, 'balanceDay', costs.itemNotes.prepaidFee);
    item('moving', '이사비', CW.moving, 'after', costs.itemNotes.moving);
    item('remodel', '수리비', remodelW, 'after', []);

    var totalCostW = V + remodelW + CW.total;
    var cashW = totalCostW - loanW;
    var afterW = CW.moving + remodelW;
    var balanceDayW = cashW - depositW - afterW;

    var i;
    for (i = 0; i < loanInfo.notes.length; i++) if (loanInfo.notes[i] !== NOTE_ESTIMATE) addNote(notes, loanInfo.notes[i]);
    for (i = 0; i < costs.notes.length; i++) if (costs.notes[i] !== NOTE_ESTIMATE) addNote(notes, costs.notes[i]);
    if (years !== s.years) addNote(notes, '월 상환은 ' + years + '년으로 계산했어요.');
    if (V >= RULES.fundingPlanWon || s.regulated) {
      addNote(notes, '자금조달계획서를 내야 해요(' + wonText(RULES.fundingPlanWon / MAN) + ' 이상이거나 규제지역).');
    }
    addNote(notes, '계약하고 ' + RULES.reportDays + '일 안에 거래 신고를 해요(중개 거래면 중개사가 해요).');
    addNote(notes, '등기는 잔금일부터 ' + RULES.registerDays + '일 안에 해요.');
    addNote(notes, NOTE_ESTIMATE);

    return {
      ok: true,
      totalCost: man1(totalCostW), loan: man1(loanW), cash: man1(cashW),
      timeline: { contract: man1(depositW), balanceDay: man1(balanceDayW), after: man1(afterW) },
      items: items,
      won: { price: V, remodel: remodelW, costs: CW.total, totalCost: totalCostW, loan: loanW, cash: cashW,
        contract: depositW, balanceDay: balanceDayW, after: afterW },
      loanInfo: loanInfo, costs: costs, payment: pay, notes: notes
    };
  }

  // ───────────────────────── 재산세 ─────────────────────────
  function propEmpty(notes) {
    return { ok: false, tax: null, eduTax: null, cityTax: null, total: null, base: null, fmrPct: null, special: false,
      year: null, publicPrice: null, estimatedPublicPrice: null, basis: 'none', schedule: [], scenarios: [], max: null, min: null,
      won: {}, notes: notes };
  }
  /** pubW 원, year, oneHouse, prevW(직전 연도 공시가격 원 | null), opts {fmr: 강제 비율, special: 강제 특례} */
  function propCalc(pubW, year, oneHouse, prevW, force) {
    var fmr, i;
    if (force && isNum(force.fmr)) fmr = force.fmr;
    else if (oneHouse && year === RULES.fmrOneHouseYear) {
      for (i = 0; i < RULES.fmrOneHouse.length; i++) if (pubW <= RULES.fmrOneHouse[i].upTo) { fmr = RULES.fmrOneHouse[i].r; break; }
    } else fmr = RULES.fmrBase;
    var special = force && typeof force.special === 'boolean' ? force.special
      : (oneHouse && year <= RULES.specialLastYear);
    special = special && oneHouse && pubW <= RULES.specialMaxPubWon;
    var base = pubW * fmr;
    if (prevW !== null) base = Math.min(base, prevW * fmr + pubW * fmr * RULES.baseCapRate);
    var tax = floor10(progressive(special ? RULES.propSpecial : RULES.propStd, base));
    var city = floor10(base * RULES.cityRate);
    var edu = floor10(tax * RULES.propEduOfTax);
    return { fmr: fmr, special: special, base: Math.round(base), tax: tax, city: city, edu: edu, total: tax + city + edu };
  }

  function propertyTaxCore(o) {
    var notes = [];
    var pub = positive(readMan(get(o, 'publicPrice'), '공시가격', notes));
    var kb = positive(readMan(get(o, 'kb'), 'KB시세', notes));
    var price = positive(readMan(get(o, 'price'), '매매가', notes));
    var prev = positive(readMan(get(o, 'prevPublicPrice'), '작년 공시가격', notes));
    var oneHouse = boolIn(get(o, 'oneHouse'));
    if (oneHouse === null) oneHouse = true;
    var year = numIn(get(o, 'year'), 2000, 2100);
    year = year === null ? RULES.fmrOneHouseYear : Math.floor(year);
    if (year < RULES.fmrOneHouseYear) { addNote(notes, RULES.fmrOneHouseYear + '년 규칙으로 계산했어요.'); year = RULES.fmrOneHouseYear; }

    var pp = publicPriceWon(pub, kb, price);
    if (pp.won === null) { addNote(notes, '공시가격이나 시세를 넣으면 재산세를 계산해요.'); return propEmpty(notes); }
    if (pp.basis === 'estimate') {
      addNote(notes, '추정 공시가격(' + (kb !== null ? 'KB시세' : '매매가') + '×69%)으로 계산했어요. 실제 공동주택가격은 부동산공시가격알리미에서 확인하세요.');
    }
    var prevW = prev === null ? null : Math.round(prev * MAN);
    var c = propCalc(pp.won, year, oneHouse, prevW, null);

    // 내년(2027년분) 규칙이 아직 안 정해져 네 경우를 함께 보여 준다(규칙 property_tax.*)
    var sc = [];
    if (oneHouse) {
      var f2026 = propCalc(pp.won, RULES.fmrOneHouseYear, true, prevW, null).fmr;
      var defs = [
        { key: 'keep', label: '지금 규칙이 이어지면', fmr: f2026, special: true },
        { key: 'noSpecial', label: '특례세율만 끝나면', fmr: f2026, special: false },
        { key: 'fmr60', label: '비율만 60%로 돌아가면', fmr: RULES.fmrBase, special: true },
        { key: 'worst', label: '비율 60%·특례 끝(지금 법 그대로)', fmr: RULES.fmrBase, special: false }
      ];
      for (var i = 0; i < defs.length; i++) {
        var x = propCalc(pp.won, year, true, prevW, { fmr: defs[i].fmr, special: defs[i].special });
        sc.push({ key: defs[i].key, label: defs[i].label, fmrPct: Math.round(x.fmr * 100), special: x.special,
          total: man1(x.total), won: x.total });
      }
    }
    // 1.7.0 검토 반영: 가장 큰 값(max)과 가장 작은 값(min). keep = 2026년 규칙이 이어질 때, worst = 지금 법 그대로(비율 60%·특례 끝)
    var maxW = c.total, minW = c.total, keepW = null, worstW = null, keepPct = null;
    for (var j = 0; j < sc.length; j++) {
      if (sc[j].won > maxW) maxW = sc[j].won;
      if (sc[j].won < minW) minW = sc[j].won;
      if (sc[j].key === 'keep') { keepW = sc[j].won; keepPct = sc[j].fmrPct; }
      if (sc[j].key === 'worst') worstW = sc[j].won;
    }

    var schedule;
    if (c.tax + c.city <= RULES.oneShotMaxWon) {
      schedule = [{ month: 7, amount: man1(c.total) }];
      addNote(notes, wonText(RULES.oneShotMaxWon / MAN) + ' 이하라 7월에 한 번에 낼 수 있어요(지자체 조례).');
    } else {
      var half = Math.round(c.total / 2);
      schedule = [{ month: 7, amount: man1(half) }, { month: 9, amount: man1(c.total - half) }];
      addNote(notes, '7월과 9월에 반씩 내요.');
    }
    addNote(notes, '재산세는 6월 1일에 집을 가진 사람이 그해 몫을 내요.');
    // 1.7.0 검토 반영: 지금 법(현행 조문) 그대로면 2027년분부터 비율 60%·표준세율이다(특례세율은 2026년분까지).
    // 2026년 규칙(43~45%·특례세율)은 '연장되면'의 경우라서, 늘어나는 쪽이 아니라 줄어드는 쪽으로 안내한다
    var fmrT = Math.round(c.fmr * 100);
    if (c.special) addNote(notes, year + '년 1세대 1주택 규칙(공정시장가액비율 ' + fmrT + '%, 특례세율)으로 계산했어요.');
    else if (oneHouse && year > RULES.specialLastYear) {
      addNote(notes, year + '년분을 지금 법 그대로(공정시장가액비율 ' + fmrT + '%, 표준세율) 계산했어요. 1세대 1주택 특례세율은 ' +
        RULES.specialLastYear + '년분까지예요.');
    } else addNote(notes, '공정시장가액비율 ' + fmrT + '%, 표준세율로 계산했어요.');
    if (oneHouse && year <= RULES.specialLastYear && worstW !== null && worstW > c.total) {
      addNote(notes, (year + 1) + '년분은 아직 안 정해졌어요. 지금 법 그대로면(비율 60%·특례세율 끝) 약 ' + wonText(man1(worstW), 1) +
        ', ' + RULES.fmrOneHouseYear + '년 규칙이 연장되면 약 ' + wonText(man1(keepW !== null ? keepW : c.total), 1) + '이에요.');
    } else if (oneHouse && year > RULES.specialLastYear && keepW !== null && keepW < c.total) {
      addNote(notes, RULES.fmrOneHouseYear + '년 규칙(비율 ' + keepPct + '%·특례세율)이 연장되면 약 ' + wonText(man1(keepW), 1) +
        '으로 줄어요. 아직 정해지지 않았어요.');
    }
    if (!oneHouse || pp.won > RULES.jongbuOneHouseWon) addNote(notes, '종합부동산세가 따로 나올 수 있어요(이 계산에 없음).');
    addNote(notes, '지역자원시설세(소방분)는 빠져 있어요.');
    addNote(notes, NOTE_ESTIMATE);

    return {
      ok: true,
      tax: man1(c.tax), eduTax: man1(c.edu), cityTax: man1(c.city), total: man1(c.total),
      base: man1(c.base), fmrPct: Math.round(c.fmr * 100), special: c.special, year: year,
      publicPrice: man1(pp.won), estimatedPublicPrice: pp.basis === 'estimate' ? man1(pp.won) : null, basis: pp.basis,
      schedule: schedule, scenarios: sc, max: man1(maxW), min: man1(minW),
      won: { publicPrice: pp.won, base: c.base, tax: c.tax, eduTax: c.edu, cityTax: c.city, total: c.total, max: maxW, min: minW },
      notes: notes
    };
  }

  // ───────────────────────── 보유 비용 ─────────────────────────
  function holdEmpty(notes) {
    return { ok: false, propertyTax: null, propertyTaxMax: null, propertyTaxMin: null, mgmtFee: null, interestYear1: null,
      total: null, totalMax: null, totalMin: null, taxYear: null,
      monthly: { payment: null, mgmtFee: null, total: null }, won: {}, loan: null, notes: notes };
  }
  /**
   * 1년 보유 비용 = 재산세 + 관리비(월평균×12) + 첫해 대출 이자. 월 주거비 = 첫 달 상환액 + 관리비 월평균.
   * year(선택): 재산세를 계산할 해(propertyTax 와 같음, 없으면 2026). 1.7.0 검토 반영: 화면은 '산 사람이 처음 내는 해'를 넘긴다
   * (6월 1일 소유자가 그해 몫을 내므로 6월 이후에 사면 다음 해분부터)
   */
  function holdingCore(o) {
    var notes = [];
    var s = normalizeSettings(get(o, 'settings'), notes);
    var price = positive(readMan(get(o, 'price'), '매매가', notes));
    var kb = positive(readMan(get(o, 'kb'), 'KB시세', notes));
    var feeAvg = readWon(get(o, 'feeAvg'), '관리비', notes, 10000000);
    var loan = readMan(get(o, 'loan'), '대출', notes);
    if (loan === null && (price !== null || kb !== null)) loan = loanLimitCore({ price: price, kb: kb, settings: s }).limit;
    var pt = propertyTaxCore({ publicPrice: get(o, 'publicPrice'), kb: kb, price: price, oneHouse: s.oneHouse, year: get(o, 'year') });
    if (loan === null && !pt.ok && feeAvg === null) {
      addNote(notes, '매매가·시세나 관리비를 넣으면 보유 비용을 계산해요.');
      return holdEmpty(notes);
    }
    var years = s.years;
    if (capitalOrRegulated(s) && years > RULES.capitalMaxYears) years = RULES.capitalMaxYears;
    var pay = loan === null ? null : paymentCore({ principal: loan, ratePct: s.ratePct, years: years, method: s.method });

    var W = {
      propertyTax: pt.ok ? pt.won.total : null,
      propertyTaxMax: pt.ok ? pt.won.max : null,
      propertyTaxMin: pt.ok ? pt.won.min : null,
      mgmtFee: feeAvg === null ? null : feeAvg * 12,
      interestYear1: pay && pay.ok ? pay.won.firstYearInterest : null,
      monthPayment: pay && pay.ok ? pay.won.firstMonth : null,
      monthMgmt: feeAvg
    };
    W.total = (W.propertyTax || 0) + (W.mgmtFee || 0) + (W.interestYear1 || 0);
    W.totalMax = (W.propertyTaxMax || 0) + (W.mgmtFee || 0) + (W.interestYear1 || 0);
    W.totalMin = (W.propertyTaxMin || 0) + (W.mgmtFee || 0) + (W.interestYear1 || 0);
    W.monthTotal = (W.monthPayment || 0) + (W.monthMgmt || 0);

    if (feeAvg === null) addNote(notes, '관리비 월평균이 없어 관리비는 빼고 더했어요.');
    if (!pt.ok) addNote(notes, '재산세는 빼고 더했어요.');
    addNote(notes, '1년 합계에는 대출 이자만 넣었어요(원금 상환은 빠져 있어요).');
    addNote(notes, '월 주거비는 첫 달 상환액(원금+이자)과 관리비 월평균을 더한 값이에요.');
    // 1.7.0 검토 반영: 방향을 바로잡음. 2026년 규칙으로 계산했으면 다음 해분(지금 법 그대로)이 더 크고, 2027년분 이후를
    // 지금 법 그대로 계산했으면 특례가 연장될 때 더 작다
    if (pt.ok && pt.won.max > pt.won.total) {
      addNote(notes, (pt.year + 1) + '년분 재산세가 지금 법 그대로 나오면 1년 합계는 약 ' + wonText(man1(W.totalMax), 1) + '이에요.');
    }
    if (pt.ok && pt.won.min < pt.won.total) {
      addNote(notes, '재산세 특례가 연장되면 1년 합계는 약 ' + wonText(man1(W.totalMin), 1) + '으로 줄어요.');
    }
    addNote(notes, NOTE_ESTIMATE);

    return {
      ok: true,
      propertyTax: man1(W.propertyTax), propertyTaxMax: man1(W.propertyTaxMax), propertyTaxMin: man1(W.propertyTaxMin),
      mgmtFee: man1(W.mgmtFee), taxYear: pt.ok ? pt.year : null,
      interestYear1: man1(W.interestYear1), total: man1(W.total), totalMax: man1(W.totalMax), totalMin: man1(W.totalMin),
      monthly: { payment: man1(W.monthPayment), mgmtFee: man1(W.monthMgmt), total: man1(W.monthTotal) },
      loan: loan === null ? null : loan, won: W, propertyTaxInfo: pt, payment: pay, notes: notes
    };
  }

  // ───────────────────────── 표시·읽기 ─────────────────────────
  /**
   * 만원 → '1억 2,775만'. decimals(0~2, 기본 0)만큼 만원 아래 소수를 보인다('64.7만').
   * 1만원 미만(0 제외)은 원으로('7,500원'). 0 은 '0원'. 숫자가 아니면 ''.
   */
  function formatMan(v, decimals) {
    try {
      var n = typeof v === 'string' ? parseMan(v) : v;
      if (!isNum(n)) return '';
      var d = decimals === 1 || decimals === 2 ? decimals : 0;
      var neg = n < 0, a = Math.abs(n);
      if (a === 0) return '0원';
      if (a < 1) {
        var w = Math.round(a * MAN);
        return w === 0 ? '0원' : (neg ? '-' : '') + comma(w) + '원';
      }
      var f = Math.pow(10, d);
      a = Math.round(a * f) / f;
      var eok = Math.floor(a / MAN + 1e-9);
      var rest = Math.round((a - eok * MAN) * f) / f;
      if (rest >= MAN) { eok += 1; rest = 0; }
      var restStr = rest === 0 ? '' : comma(d ? String(rest) : String(Math.round(rest))) + '만';
      var out = eok > 0 ? comma(eok) + '억' + (restStr ? ' ' + restStr : '') : (restStr || '0원');
      return (neg ? '-' : '') + out;
    } catch (e) { return ''; }
  }

  var UNIT_MAN = { '억': 10000, '천만': 1000, '백만': 100, '천': 1000, '백': 100, '만': 1 };
  /**
   * 글 → 만원. '1억 2,775만'·'1억2775'·'12,775'·'1.2775억'·'3억 5천'·'15만원'·'138,552원'(→13.8552)·'약 64.7만'.
   * 숫자는 그대로(유한한 0 이상). 못 읽거나 음수면 null.
   * 단위 없는 숫자: 앞에 '만'이 있었으면 원('13만 8,552원'), 아니면 만원.
   */
  function parseMan(s) {
    try {
      if (typeof s === 'number') return isNum(s) && s >= 0 ? s : null;
      if (typeof s !== 'string') return null;
      var t = s.replace(/[\s,]/g, '').replace(/^약/, '').replace(/(쯤|정도|가량)$/, '');
      if (!t || t.length > 40) return null;
      var wonEnd = /원$/.test(t);
      t = t.replace(/원$/, '');
      if (!t) return null;
      if (wonEnd && !/[억만]/.test(t)) { // '138552원'·'5천원'
        var wm = /^(\d+(?:\.\d+)?)(천|백)?$/.exec(t);
        return wm ? Math.round(parseFloat(wm[1]) * (wm[2] === '천' ? 1000 : wm[2] === '백' ? 100 : 1)) / MAN : null;
      }
      var re = /^(\d+(?:\.\d+)?)(억|천만|백만|천|백|만)?/, total = 0, prevUnit = null, m, rest = t, guard = 0;
      while (rest.length && guard++ < 10) {
        m = re.exec(rest);
        if (!m) return null;
        var num = parseFloat(m[1]), unit = m[2] || null;
        if (unit) total += num * UNIT_MAN[unit];
        else total += prevUnit === '만' ? num / MAN : num; // '13만8552' → 8552원
        prevUnit = unit;
        rest = rest.slice(m[0].length);
        if (!unit && rest.length) return null; // 단위 없는 수는 끝에만
      }
      if (rest.length || !isNum(total)) return null;
      return Math.round(total * MAN) / MAN; // 원 단위까지(1.2775억 → 12775)
    } catch (e) { return null; }
  }

  // ───────────────────────── 예외 막기 ─────────────────────────
  function safe(core, empty) {
    return function (o) {
      try { return core(o !== null && typeof o === 'object' ? o : {}); }
      catch (e) { return empty(['계산하지 못했어요. 넣은 값을 확인해 주세요.']); }
    };
  }

  deepFreeze(RULES);
  deepFreeze(BANG_GONGJE);

  return {
    VERSION: VERSION,
    RULES: RULES,
    BANG_GONGJE: BANG_GONGJE,
    METHOD_LABEL: METHOD_LABEL,
    defaultSettings: defaultSettings,
    normalizeSettings: function (s) { try { return normalizeSettings(s); } catch (e) { return defaultSettings(); } },
    suggestLtv: function (s) { try { return ltvRule(normalizeSettings(s)); } catch (e) { return RULES.ltvPct.capital; } },
    loanLimit: safe(loanLimitCore, loanEmpty),
    payment: safe(paymentCore, paymentEmpty),
    acquisitionCosts: safe(acquisitionCore, costEmpty),
    cashNeeded: safe(cashCore, cashEmpty),
    propertyTax: safe(propertyTaxCore, propEmpty),
    holdingCost: safe(holdingCore, holdEmpty),
    formatMan: formatMan,
    parseMan: parseMan,
    // 시험용(화면에서는 쓰지 않는다)
    _internal: { acqRateBp: acqRateBp, brokerFeeWon: brokerFeeWon, stampWon: stampWon, bondRate: bondRate,
      roundBond: roundBond, floor10: floor10, man1: man1, priceCapWon: priceCapWon, propCalc: propCalc }
  };
});
