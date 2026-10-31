/*
 * 임장 체크리스트 — loanpath.js (1.14.0)
 * "대출 길잡이": 몇 가지 질문으로 디딤돌대출이 되는지, 안 되면 다음 플랜(신생아 특례 → 디딤돌 → 보금자리론 → 은행
 * 주택담보대출)이 무엇인지 경우의 수를 따져 준다. 순수 함수만 두고(DOM·저장소 없음) app.js 가 부른다.
 * 브라우저에서는 window.ImjangLoanPath, Node 에서는 require('./loanpath.js') 로 쓴다(UMD, ES5).
 *
 * 기준 출처(확인 시점 BASIS, 숫자는 자주 바뀌므로 화면에는 "바뀔 수 있음" 단서를 함께 둔다)
 *   - 내집마련디딤돌대출: 주택도시기금 기금포털 nhuf.molit.go.kr (FP05030101)
 *   - 신생아 특례 디딤돌대출: 기금포털 (FP05030801)
 *   - 보금자리론: 한국주택금융공사 hf.go.kr
 *   한도는 2025-06-28 이후 계약 기준(그 전 계약은 더 큼). 순자산 기준은 2026년도 5.11억 원.
 *
 * 들어오는 것: answers { home, baby, family[], income, asset, price, size } (QUESTIONS 의 option id)
 * 나가는 것: evaluate(answers) →
 *   { products: [{ id, name, verdict('ok'|'maybe'|'no'), reasons[], notes[], specs[{label,value}] }], pickId, maybeIds[] }
 *   순서는 보통 유리한 차례(신생아 특례 → 디딤돌 → 보금자리론 → 은행). pickId 는 첫 'ok'.
 * 문구 원칙: 쉬운 해요체, 판정은 "이 기준으로는" 톤. 최종 판단은 은행·기금e든든에 넘긴다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangLoanPath = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var BASIS = '2026-11'; // 기준을 확인한 시점(기금포털·주택금융공사 게시 기준)

  // 소득·집값 구간: rank 가 작을수록 낮다. 상한 비교는 구간의 위쪽 끝으로 본다(구간이 걸치면 아래 설명에 단서)
  var INCOME = [
    { id: 'i60', label: '6천만 원 이하', rank: 1 },
    { id: 'i70', label: '6천만 ~ 7천만 원', rank: 2 },
    { id: 'i85', label: '7천만 ~ 8천5백만 원', rank: 3 },
    { id: 'i100', label: '8천5백만 ~ 1억 원', rank: 4 },
    { id: 'i130', label: '1억 ~ 1억3천만 원', rank: 5 },
    { id: 'i200', label: '1억3천만 ~ 2억 원', rank: 6 },
    { id: 'iover', label: '2억 원 초과', rank: 7 }
  ];
  var PRICE = [
    { id: 'p30', label: '3억 원 이하', rank: 1 },
    { id: 'p50', label: '3억 ~ 5억 원', rank: 2 },
    { id: 'p60', label: '5억 ~ 6억 원', rank: 3 },
    { id: 'p90', label: '6억 ~ 9억 원', rank: 4 },
    { id: 'pover', label: '9억 원 초과', rank: 5 }
  ];

  var QUESTIONS = [
    {
      id: 'home', type: 'single',
      text: '지금 세대에 집이 있나요?',
      hint: '주민등록등본에 같이 있는 가족 모두 기준이에요. 분양권·조합원 입주권도 집으로 봐요.',
      options: [
        { id: 'none', label: '전원 무주택이에요' },
        { id: 'one', label: '1채 있어요 (팔고 갈아탈 생각)' },
        { id: 'more', label: '2채 이상 있어요' }
      ]
    },
    {
      id: 'baby', type: 'single',
      text: '최근 2년 안에 출산(입양)한 자녀가 있나요?',
      hint: '2023년 1월 1일 이후 출생아부터예요. 혼인신고를 안 했어도 돼요(임신 중은 아직 아니에요).',
      options: [
        { id: 'yes', label: '네, 있어요' },
        { id: 'no', label: '아니요' }
      ]
    },
    {
      id: 'family', type: 'multi',
      text: '해당하는 것을 모두 골라 주세요',
      hint: '없으면 바로 [다음]을 누르면 돼요.',
      options: [
        { id: 'newly', label: '신혼이에요', hint: '혼인신고 7년 이내거나 결혼 예정' },
        { id: 'kids2', label: '자녀가 2명 이상이에요' },
        { id: 'first', label: '생애최초예요', hint: '본인·배우자 모두 집을 가진 적 없음' },
        { id: 'single30', label: '만 30세 이상 미혼 1인 세대주예요' },
        { id: 'under30', label: '만 30세 미만 1인 세대주예요' }
      ]
    },
    {
      id: 'income', type: 'single',
      text: '부부합산 연소득은 얼마쯤인가요?',
      hint: '1인 가구는 본인 소득, 세전 기준이에요.',
      options: INCOME.map(function (o) { return { id: o.id, label: o.label }; })
    },
    {
      id: 'asset', type: 'single',
      text: '부부합산 순자산이 약 5억 원 이하인가요?',
      hint: '가진 재산(예금·전세보증금·차 등)에서 빚을 뺀 금액이에요. 기금 대출의 자산 기준(2026년 5.11억 원, 해마다 바뀜)이에요.',
      options: [
        { id: 'yes', label: '네, 이하예요' },
        { id: 'no', label: '아니요, 넘어요' },
        { id: 'unsure', label: '잘 모르겠어요' }
      ]
    },
    {
      id: 'price', type: 'single',
      text: '사려는 집 가격은 얼마쯤인가요?',
      hint: '아직 못 정했으면 생각하는 예산으로 골라요.',
      options: PRICE.map(function (o) { return { id: o.id, label: o.label }; })
    },
    {
      id: 'size', type: 'single',
      text: '전용면적이 85㎡ 이하인가요?',
      hint: '보통 "34평형"(전용 84㎡)까지예요. 읍·면 지역은 100㎡까지 돼요.',
      options: [
        { id: 'yes', label: '네 (85㎡ 이하)' },
        { id: 'no', label: '아니요 (85㎡ 초과)' },
        { id: 'unsure', label: '잘 모르겠어요' }
      ]
    }
  ];

  function rankOf(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].rank;
    return null;
  }
  function has(arr, v) { return Array.isArray(arr) && arr.indexOf(v) >= 0; }

  /** 판정 하나. no() 가 한 번이라도 불리면 'no', 아니면 maybe() 가 불렸으면 'maybe', 아니면 'ok' */
  function makeVerdict() {
    var v = { verdict: 'ok', reasons: [], notes: [] };
    return {
      v: v,
      no: function (why) { v.verdict = 'no'; v.reasons.push(why); },
      maybe: function (why) { if (v.verdict !== 'no') v.verdict = 'maybe'; v.reasons.push(why); },
      note: function (t) { v.notes.push(t); }
    };
  }

  /** answers 의 모자란 값은 가장 보수적으로 두지 않고 '모름'으로 본다(질문을 건너뛰면 maybe 로) */
  function evaluate(answers) {
    var a = answers && typeof answers === 'object' ? answers : {};
    var fam = Array.isArray(a.family) ? a.family : [];
    var inc = rankOf(INCOME, a.income);
    var pr = rankOf(PRICE, a.price);
    var newly = has(fam, 'newly'), kids2 = has(fam, 'kids2'), first = has(fam, 'first');
    var single30 = has(fam, 'single30'), under30 = has(fam, 'under30');
    var noHome = a.home === 'none', oneHome = a.home === 'one', moreHome = a.home === 'more';
    var baby = a.baby === 'yes';

    function assetCheck(k) {
      if (a.asset === 'no') k.no('부부합산 순자산이 기준(2026년 5.11억 원)을 넘어요');
      else if (a.asset !== 'yes') k.maybe('순자산이 기준(5.11억 원) 이하인지 확인이 필요해요. 자산은 기금e든든 자산심사에서 따져요');
    }
    function sizeCheck(k) {
      if (a.size === 'no') k.no('전용면적 85㎡ 이하(읍·면 지역 100㎡)만 돼요');
      else if (a.size !== 'yes') k.maybe('전용면적이 85㎡ 이하인지 확인이 필요해요');
    }
    function homeCheckFund(k) {
      if (moreHome) k.no('세대 전원이 무주택이어야 해요');
      else if (oneHome) k.no('세대 전원이 무주택이어야 해요(1주택 갈아타기는 아래 보금자리론·은행 대출을 봐요)');
      else if (!noHome) k.maybe('세대 전원 무주택인지 확인이 필요해요');
    }

    // ── 1) 신생아 특례 디딤돌 ──
    var nb = makeVerdict();
    if (!baby) nb.no('대출접수일 기준 2년 안에 출산(입양)한 가구만 돼요(2023-01-01 이후 출생아부터)');
    else {
      homeCheckFund(nb);
      if (oneHome) nb.note('1주택자는 새 구입은 안 되지만, 지금 집의 비싼 주택담보대출을 이 상품으로 갈아타는 것(대환)은 돼요');
      if (inc === null) nb.maybe('소득 구간을 알아야 해요');
      else if (inc >= 7) nb.no('부부합산 연소득 1.3억 원(맞벌이 2억 원) 이하만 돼요');
      else if (inc === 6) nb.maybe('1.3억~2억 원 구간은 맞벌이면서 각자 소득이 1.3억 원 이하일 때만 돼요');
      assetCheck(nb);
      if (pr === null) nb.maybe('집값 구간을 알아야 해요');
      else if (pr >= 5) nb.no('집값(담보주택 평가액) 9억 원 이하만 돼요');
      sizeCheck(nb);
    }
    nb.note('실행일부터 1개월 안 전입하고 2년 이상 실거주해야 해요(사유서로 연장 가능)');
    var newborn = {
      id: 'newborn', name: '신생아 특례 디딤돌대출', verdict: nb.v.verdict, reasons: nb.v.reasons, notes: nb.v.notes,
      specs: [
        { label: '한도', value: '최대 4억 원 (집값의 70%, 생애최초 80%·수도권은 70%)' },
        { label: '금리', value: '연 1.8~4.5% — 특례금리 5년, 추가 출산마다 5년 연장' },
        { label: '요건 요약', value: '2년 내 출산·입양 · 무주택 · 소득 1.3억(맞벌이 2억) · 집값 9억 · 전용 85㎡' }
      ]
    };

    // ── 2) 내집마련 디딤돌 ──
    var dd = makeVerdict();
    homeCheckFund(dd);
    if (under30 && !baby) dd.no('만 30세 미만 1인 세대주는 안 돼요(미성년 형제·자매를 6개월 이상 부양하면 예외)');
    var incCap = newly ? 3 : (first || kids2) ? 2 : 1;
    var incCapLabel = newly ? '신혼 8.5천만 원' : (first || kids2) ? '생애최초·2자녀 7천만 원' : '일반 6천만 원';
    if (inc === null) dd.maybe('소득 구간을 알아야 해요');
    else if (inc > incCap) {
      if (newly && inc <= 5) dd.maybe('부부합산으로는 기준(8.5천만 원)을 넘지만, 신혼은 신청인 1인 소득이 6천만 원 이하면 그 소득만으로 신청할 수 있어요');
      else dd.no('부부합산 연소득 기준(' + incCapLabel + ')을 넘어요');
    }
    assetCheck(dd);
    var prCap = single30 ? 1 : (newly || kids2) ? 3 : 2;
    if (pr === null) dd.maybe('집값 구간을 알아야 해요');
    else if (pr > prCap) {
      dd.no(single30 ? '만 30세 이상 미혼 1인 세대주는 집값 3억 원 이하만 돼요'
        : '집값(담보주택 평가액) ' + ((newly || kids2) ? '6억 원(신혼·2자녀)' : '5억 원') + ' 이하만 돼요');
    }
    if (single30) dd.note('만 30세 이상 미혼 1인 세대주는 전용 60㎡ 이하·한도 1.5억 원(생애최초 2억 원)으로 줄어요');
    sizeCheck(dd);
    var ddLimit = single30 ? '1.5억 원(생애최초 2억 원)' : (newly || kids2) ? '3.2억 원(신혼·2자녀)' : first ? '2.4억 원(생애최초)' : '2억 원';
    dd.note('실행일부터 1개월 안 전입 의무가 있어요(일정 탭이 기한을 계산해 줘요)');
    var didim = {
      id: 'didimdol', name: '내집마련 디딤돌대출', verdict: dd.v.verdict, reasons: dd.v.reasons, notes: dd.v.notes,
      specs: [
        { label: '한도', value: '최대 ' + ddLimit + ' (집값의 70%, 생애최초 80%·수도권은 70%)' },
        { label: '금리', value: '연 2.85~4.15% (소득·기간별, 우대 별도)' },
        { label: '요건 요약', value: '무주택 · 소득 6천(생초·2자녀 7천, 신혼 8.5천) · 집값 5억(신혼·2자녀 6억) · 전용 85㎡' }
      ]
    };

    // ── 3) 보금자리론 ──
    var bg = makeVerdict();
    if (moreHome) bg.no('무주택이거나, 기존 집을 3년 안에 파는 조건의 1주택(일시적 2주택)까지만 돼요');
    if (oneHome) bg.note('1주택 갈아타기는 기존 집을 대출 실행일부터 3년 안에 파는 조건으로 돼요');
    var bgCap = kids2 ? 4 : newly ? 3 : 2; // 기본 7천, 신혼 8.5천, 다자녀 1억 (미성년 1자녀 9천은 질문에 없어 note 로)
    if (inc === null) bg.maybe('소득 구간을 알아야 해요');
    else if (inc > bgCap) {
      if (newly && inc <= 5) bg.maybe('부부합산으로는 넘지만, 신혼은 신청인 1인 소득이 7천만 원 이하면 신청할 수 있어요');
      else if (inc <= 4) bg.maybe('기본 기준(7천만 원)은 넘지만, 미성년 자녀가 1명이면 9천만 원까지 돼요 — 정확한 소득으로 확인해요');
      else bg.no('부부합산 연소득 기준(기본 7천만 원, 신혼 8.5천만 원, 미성년 1자녀 9천만 원, 다자녀 1억 원)을 넘어요');
    }
    if (pr === null) bg.maybe('집값 구간을 알아야 해요');
    else if (pr >= 4) bg.no('집값 6억 원 이하만 돼요');
    bg.note('순자산·면적 기준은 없어요. 수도권·규제지역은 실행일부터 6개월 안 전입 의무가 있어요');
    var bogeum = {
      id: 'bogeumjari', name: '보금자리론', verdict: bg.v.verdict, reasons: bg.v.reasons, notes: bg.v.notes,
      specs: [
        { label: '한도', value: '최대 3.6억 원 (생애최초 4.2억, 다자녀 4억 · 아파트는 집값의 70%)' },
        { label: '금리', value: '고정금리 (시기별로 공시 — 주택금융공사에서 확인)' },
        { label: '요건 요약', value: '무주택·1주택(처분 조건) · 소득 7천(신혼 8.5천, 다자녀 1억) · 집값 6억' }
      ]
    };

    // ── 4) 은행 주택담보대출 ──
    var bk = makeVerdict();
    bk.note('소득·집값·무주택 요건이 없는 대신 금리가 보통 가장 높아요. 여러 은행의 금리와 한도를 비교해요');
    bk.note('수도권·규제지역은 집값 대비 한도(LTV)가 낮고, 스트레스 DSR 로 소득 대비 한도가 줄어요. 실행일부터 6개월 안 전입 의무도 있어요');
    bk.note('가계약금을 보내기 전에 이 집 기준 대출 가능 금액을 꼭 은행에 확인해요(체크리스트 "은행 상담" 항목)');
    var bank = {
      id: 'bank', name: '은행 주택담보대출', verdict: 'ok', reasons: [], notes: bk.v.notes,
      specs: [
        { label: '한도', value: '지역·규제에 따라 집값의 40~70% 안팎 + DSR 한도' },
        { label: '금리', value: '은행·시기별 (정책대출보다 높은 편)' },
        { label: '요건 요약', value: '제한 없음 (신용·소득 심사만)' }
      ]
    };

    var products = [newborn, didim, bogeum, bank];
    var pickId = null, maybeIds = [];
    products.forEach(function (p) {
      if (!pickId && p.verdict === 'ok') pickId = p.id;
      if (p.verdict === 'maybe') maybeIds.push(p.id);
    });
    return { products: products, pickId: pickId, maybeIds: maybeIds, basis: BASIS };
  }

  return {
    BASIS: BASIS,
    QUESTIONS: QUESTIONS,
    evaluate: evaluate
  };
});
