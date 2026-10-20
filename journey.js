/*
 * 임장 체크리스트 — journey.js (1.11.0)
 * 매물 진행 지도: 아파트 매수 7단계(서류 거르기 → 가기 전 준비 → 집 보기 → 다시 가 보기 → 가격·대출 → 계약 → 잔금·입주)의
 * 상태를 계산한다. 순수 함수만 두고(DOM·저장소·시계 없음) app.js 가 부른다. 단계는 저장하지 않고 열 때마다 계산한다
 * (새 저장 필드는 property.journey 의 체크뿐 — 그건 app.js 가 관리).
 * 브라우저에서는 window.ImjangJourney, Node 에서는 require('./journey.js') 로 쓴다(UMD, ES5).
 *
 * 들어오는 것(app.js journeyInput 이 기존 계산 함수들로 만든 값. 모든 진행은 { done, total }):
 *   {
 *     status: 'review'|'planned'|'visited'|'contract'|'dropped',
 *     dropReason: string, today: 'YYYY-MM-DD',
 *     registry: { prog, label(registryResult 의 라벨), hasRecord(등기부 해석 기록 있음),
 *                 stopYes(멈춤 신호 "있음" 수, 전체), stopUnanswered(등기부 멈춤 신호 미확인 수), late(stopIsLate) },
 *     prep: prog,
 *     visit: prog(동네+단지+집 안+묻기 합산),
 *     revisit: { prog, plannedAt('YYYY-MM-DD'|'' — 재방문 visit 항목의 가장 가까운 미래 날짜) },
 *     money: { bankChecked, dealEntered, kbText, dealText, cashText(이미 포맷한 글. 없으면 '') },
 *     contract: { prog("가계약금 보내기 전"+"계약서 쓰는 날"), at(dates.contractAt) },
 *     balance: { prog("잔금일"+"잔금 뒤"), at(dates.balanceAt), moveInAt(dates.moveInAt) }
 *   }
 * 나가는 것: buildJourney → {
 *   stages: [7개 { n, id, title, state('done'|'active'|'todo'|'stopped'|'blocked'), progress({done,total}|null),
 *                  summary(한 줄), why(왜 이 순서인지 한 줄), link('section:<섹션id>'|'fin'), date({ label, iso, text }|null) }],
 *   current(지금 단계 번호. 모두 끝났으면 null. 멈춤이면 1), stopped, dropped, allDone,
 *   next(다음 할 일 한 줄 = active 단계 요약 + 그 단계 날짜(있으면). 멈춤이면 1단계 요약 — 멈춤 요약은 stopYes 수로만 말하고
 *        label 은 쓰지 않는다: label 은 게이트(등기부)만 보므로 계약 단계 멈춤과 모순될 수 있음) }
 *
 * 문구 원칙: 쉬운 해요체. "이 집을 사세요/사지 마세요" 같은 판정·추천 없음(멈춤 신호 문구는 data.js 의 기존 표현을 따름).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangJourney = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VISITED = { visited: 1, contract: 1 }; // '임장 완료' 이상(STATUSES 순서)

  // 단계 정의. why 는 "왜 이 순서인지" 한 줄(판정 아님)
  var STAGES = [
    { n: 1, id: 'papers', title: '서류 거르기', link: 'section:registry',
      why: '신탁·가압류 같은 문제가 있으면 보러 갈 필요가 없어서, 서류를 먼저 봐요.' },
    { n: 2, id: 'prep', title: '가기 전 준비', link: 'section:prep',
      why: '예산·규제와 동선을 알고 가야 현장에서 볼 것이 보여요.' },
    { n: 3, id: 'visit', title: '집 보기', link: 'section:area',
      why: '동네 → 단지 → 집 안 → 중개사에게 묻기 순서로 직접 확인해요.' },
    { n: 4, id: 'revisit', title: '다시 가 보기', link: 'section:revisit',
      why: '시간대·날씨를 바꿔 가 봐야 소음·주차·물 문제가 보여요.' },
    { n: 5, id: 'money', title: '가격·대출', link: 'fin',
      why: '가계약금을 보내기 전에 돈 계획이 서 있어야 해요.' },
    { n: 6, id: 'contract', title: '계약', link: 'section:final',
      why: '가계약금·계약금은 보내면 돌려받기 어려워요. 보내기 전에 서류를 다시 봐요.' },
    { n: 7, id: 'balance', title: '잔금·입주', link: 'section:final',
      why: '잔금일 아침 등기부 확인부터 잔금 뒤 신고까지 끝나야 마무리예요.' }
  ];

  // ---------------- 작은 도구 ----------------
  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  function isoDateOr(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v).trim());
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : '';
  }
  /** b - a 날수. 날짜가 아니면 null */
  function diffDays(a, b) {
    a = isoDateOr(a); b = isoDateOr(b);
    if (!a || !b) return null;
    var ms = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    return Math.round(ms / 86400000);
  }
  /** 'D-3'·'D-Day'·'D+2'. 날짜가 아니면 '' */
  function dLabel(iso, today) {
    var d = diffDays(today, iso);
    if (d === null) return '';
    return d === 0 ? 'D-Day' : d > 0 ? 'D-' + d : 'D+' + (-d);
  }
  /** '10.30'(올해가 아니면 '2027.1.5') */
  function shortMD(iso, today) {
    iso = isoDateOr(iso);
    if (!iso) return '';
    var y = +iso.slice(0, 4);
    var ty = isoDateOr(today) ? +today.slice(0, 4) : y;
    return (y !== ty ? y + '.' : '') + (+iso.slice(5, 7)) + '.' + (+iso.slice(8, 10));
  }
  function progOf(v) {
    var d = v && typeof v === 'object' ? v.done : null;
    var t = v && typeof v === 'object' ? v.total : null;
    d = typeof d === 'number' && isFinite(d) && d >= 0 ? Math.floor(d) : 0;
    t = typeof t === 'number' && isFinite(t) && t >= 0 ? Math.floor(t) : 0;
    return { done: Math.min(d, t || d), total: t };
  }
  /** 다 끝났는지(항목이 하나라도 있어야) */
  function complete(p) { return p.total > 0 && p.done >= p.total; }

  // ---------------- 입력 정리 ----------------
  function normalizeInput(input) {
    var o = input && typeof input === 'object' ? input : {};
    var reg = o.registry && typeof o.registry === 'object' ? o.registry : {};
    var rv = o.revisit && typeof o.revisit === 'object' ? o.revisit : {};
    var mo = o.money && typeof o.money === 'object' ? o.money : {};
    var ct = o.contract && typeof o.contract === 'object' ? o.contract : {};
    var bl = o.balance && typeof o.balance === 'object' ? o.balance : {};
    return {
      status: str(o.status) || 'review',
      dropReason: str(o.dropReason),
      today: isoDateOr(o.today),
      registry: {
        prog: progOf(reg.prog), label: str(reg.label), hasRecord: !!reg.hasRecord,
        stopYes: typeof reg.stopYes === 'number' && reg.stopYes > 0 ? Math.floor(reg.stopYes) : 0,
        stopUnanswered: typeof reg.stopUnanswered === 'number' && reg.stopUnanswered > 0 ? Math.floor(reg.stopUnanswered) : 0,
        late: !!reg.late
      },
      prep: progOf(o.prep),
      visit: progOf(o.visit),
      revisit: { prog: progOf(rv.prog), plannedAt: isoDateOr(rv.plannedAt) },
      money: { bankChecked: !!mo.bankChecked, dealEntered: !!mo.dealEntered, kbText: str(mo.kbText), dealText: str(mo.dealText), cashText: str(mo.cashText) },
      contract: { prog: progOf(ct.prog), at: isoDateOr(ct.at) },
      balance: { prog: progOf(bl.prog), at: isoDateOr(bl.at), moveInAt: isoDateOr(bl.moveInAt) }
    };
  }

  // ---------------- 단계 판정 ----------------
  /**
   * 각 단계의 done(끝났는지)만 계산한다. 멈춤·dropped 와 무관한 사실.
   *  1 서류 거르기: 등기부 섹션 100% 또는 (등기부 멈춤 신호를 모두 "없음"으로 답했고 + 등기부 해석 기록 있음). 멈춤 "있음"이면 끝난 게 아니다
   *  2 가기 전 준비: 준비 섹션 100%
   *  3 집 보기: 진행 상태가 '임장 완료' 이상(현장 체크 수는 참고로만 보여 줌 — 안 본 항목이 있어도 다녀왔으면 다음 단계로)
   *  4 다시 가 보기: 재방문 체크 1개 이상(비 오는 날까지 6개를 다 채우기 전에도 가계약 단계로 갈 수 있어서)
   *  5 가격·대출: 은행 확인 체크 + 협상가 입력
   *  6 계약: final "가계약금 보내기 전"+"계약서 쓰는 날" 100%
   *  7 잔금·입주: final "잔금일"+"잔금 뒤" 100%
   */
  function doneOf(i) {
    var r = i.registry;
    return [
      r.stopYes === 0 && (complete(r.prog) || (r.stopUnanswered === 0 && r.hasRecord && r.prog.total > 0)),
      complete(i.prep),
      !!VISITED[i.status],
      i.revisit.prog.total > 0 && i.revisit.prog.done >= 1,
      i.money.bankChecked && i.money.dealEntered,
      complete(i.contract.prog),
      complete(i.balance.prog)
    ];
  }

  function summaries(i, done) {
    var out = [];
    var r = i.registry;
    var lbl, tail;
    // 1 서류 거르기. 멈춤이면 label 을 쓰지 않는다(1.11.0 검토): label 은 등기부(게이트)만 보고 stopYes 는
    // 전 섹션(final 포함)을 세므로, 계약 단계에서만 멈춤이면 label 이 '체크 항목 이상 없음'이라 모순이 된다
    if (r.stopYes > 0) {
      out.push('멈춤 신호 ' + r.stopYes + '건 — ' + (r.late ? '돈을 보내지 말고 멈추세요' : '이 집은 임장할 필요가 없어요'));
    } else if (done[0]) {
      // done 인데 라벨 꼬리가 '확인 중 n/m'이면(기록+멈춤 없음 경로) '완료' 칩과 모순돼 보여 완료형으로 바꾼다(1.11.0 검토)
      lbl = r.label && r.label !== '-' ? r.label : '등기부 확인을 마쳤어요';
      tail = /^(.*) · 확인 중 (\d+)\/(\d+)$/.exec(lbl);
      if (tail) lbl = tail[1] + ' — 남은 체크 ' + Math.max(0, +tail[3] - +tail[2]) + '개는 참고예요';
      out.push(lbl);
    } else {
      out.push((r.label && r.label !== '-' ? r.label + ' · ' : '') + '등기부 체크 ' + r.prog.done + '/' + r.prog.total);
    }
    // 2 준비
    out.push(done[1] ? '준비를 마쳤어요 (' + i.prep.done + '/' + i.prep.total + ')' : '준비 체크 ' + i.prep.done + '/' + i.prep.total);
    // 3 집 보기
    out.push(done[2] ? '다녀왔어요 · 현장 체크 ' + i.visit.done + '/' + i.visit.total
      : '현장 체크 ' + i.visit.done + '/' + i.visit.total + ' · 다녀온 뒤 진행 상태를 "임장 완료"로 바꿔요');
    // 4 다시 가 보기 — 예정일은 카드의 날짜 줄(dateOf)과 진행 띠 next 가 보여 주므로 요약에 되풀이하지 않는다(1.11.0 검토)
    out.push(done[3] ? '다시 가 봤어요 (' + i.revisit.prog.done + '/' + i.revisit.prog.total + ')'
      : '다시 가 보기 ' + i.revisit.prog.done + '/' + i.revisit.prog.total);
    // 5 가격·대출: KB시세·협상가·필요 현금(있는 것만) + 남은 체크
    var m = i.money;
    var bits = [];
    if (m.kbText) bits.push('KB시세 ' + m.kbText);
    bits.push(m.dealEntered ? (m.dealText ? '협상가 ' + m.dealText : '협상가 입력함') : '협상가 입력 안 함');
    if (m.cashText) bits.push('필요 현금 약 ' + m.cashText);
    if (!done[4]) bits.push(!m.bankChecked && !m.dealEntered ? '은행 확인·협상가 입력이 남았어요' : !m.bankChecked ? '은행 확인이 남았어요' : '협상가를 적으면 끝나요');
    out.push(bits.join(' · '));
    // 6 계약 · 7 잔금·입주 — 날짜(계약일·잔금일·이사일)는 카드의 날짜 줄(dateOf)과 진행 띠 next 가 보여 주므로
    // 요약에 되풀이하지 않는다(1.11.0 검토: 같은 카드 안에 같은 날짜가 두 번 나와 좁은 화면에서 줄만 늘었음)
    out.push(done[5] ? '계약 확인을 마쳤어요 (' + i.contract.prog.done + '/' + i.contract.prog.total + ')'
      : '계약 전 확인 ' + i.contract.prog.done + '/' + i.contract.prog.total);
    out.push(done[6] ? '잔금·입주 확인을 마쳤어요 (' + i.balance.prog.done + '/' + i.balance.prog.total + ')'
      : '잔금·입주 확인 ' + i.balance.prog.done + '/' + i.balance.prog.total);
    return out;
  }

  /** 단계의 date(있으면). 4 재방문 예정 / 6 계약일 / 7 잔금일(지났고 이사일이 있으면 이사일) */
  function dateOf(stage, i) {
    var iso = '';
    var label = '';
    if (stage.id === 'revisit' && i.revisit.plannedAt && i.today && i.revisit.plannedAt > i.today) { iso = i.revisit.plannedAt; label = '예정'; }
    else if (stage.id === 'contract' && i.contract.at) { iso = i.contract.at; label = '계약일'; }
    else if (stage.id === 'balance' && i.balance.at) {
      iso = i.balance.at; label = '잔금일';
      if (i.today && i.balance.at < i.today && i.balance.moveInAt && i.balance.moveInAt >= i.today) { iso = i.balance.moveInAt; label = '이사·입주일'; }
    }
    if (!iso) return null;
    var d = dLabel(iso, i.today);
    return { label: label, iso: iso, text: label + ' ' + shortMD(iso, i.today) + (label === '예정' || !d ? '' : ' (' + d + ')') };
  }

  function buildJourney(input) {
    var i = normalizeInput(input);
    var dropped = i.status === 'dropped';
    var stopped = i.registry.stopYes > 0;
    var done = doneOf(i);
    var sums = summaries(i, done);
    var progs = [i.registry.prog, i.prep, i.visit, i.revisit.prog,
      { done: (i.money.bankChecked ? 1 : 0) + (i.money.dealEntered ? 1 : 0), total: 2 },
      i.contract.prog, i.balance.prog];
    var allDone = !stopped && done.every(function (d) { return d; });
    // active = 앞이 모두 done 인 첫 미완(순서대로 보면 "첫 미완"과 같다). 멈춤이면 1에서 고정
    var active = 0;
    while (active < 7 && done[active]) active++;
    var current = stopped ? 1 : allDone ? null : active + 1;
    var stages = STAGES.map(function (def, k) {
      var state;
      if (stopped) state = k === 0 ? 'stopped' : 'blocked';
      else if (done[k]) state = 'done';
      else if (current === k + 1) state = 'active';
      else state = 'todo';
      return {
        n: def.n, id: def.id, title: def.title, state: state,
        progress: progs[k],
        // blocked 요약은 칩 문구('멈춤 해결 후')와 다른 한 줄로(1.11.0 검토: 한 카드에 같은 글이 두 번 × 6장이었음)
        summary: state === 'blocked' ? '1단계 멈춤 신호를 해결하면 열려요' : sums[k],
        why: def.why,
        link: def.link,
        date: dateOf(def, i)
      };
    });
    var next = stopped ? sums[0] : allDone ? '' : sums[active];
    // 진행 띠의 next 한 줄에는 날짜가 유용해서 여기에만 붙인다(지도 카드에서는 .jny-date 줄이 따로 보여 줌 — 1.11.0 검토)
    if (!stopped && !allDone) {
      var nd = dateOf(STAGES[active], i);
      if (nd) next += ' · ' + nd.text;
    }
    return { stages: stages, current: current, stopped: stopped, dropped: dropped, allDone: allDone, next: next };
  }

  return {
    buildJourney: buildJourney,
    STAGES: STAGES,
    // 시험·재사용용 작은 도구
    diffDays: diffDays,
    dLabel: dLabel,
    shortMD: shortMD,
    isoDateOr: isoDateOr
  };
});
