/*
 * 임장 체크리스트 — schedule.js (1.10.0)
 * 일정 탭의 날짜·기한 계산. 순수 함수만 두고(DOM·저장소·시계 없음) app.js 가 부른다.
 * 브라우저에서는 window.ImjangSchedule, Node 에서는 require('./schedule.js') 로 쓴다(UMD, ES5).
 *
 * 들어오는 것
 *   props[]   app.js 가 정리한 매물. 쓰는 칸: id, name, status, items { 항목id: { done, date } },
 *             dates { contractAt, balanceAt, vacateAt, leaseEndAt, moveInAt }('YYYY-MM-DD'|''),
 *             customEvents [{ id, at, title, memo }], scheduleDone { 항목 key: ms(>0 완료, <0 완료 취소) }
 *   settings  { firstHome: boolean(기본 true), loanType: 'bank'|'didimdol'|'bogeumjari'(기본 'bank') }
 *   today     'YYYY-MM-DD'
 *   opts      { visits: [{ id, text }] } 체크리스트의 임장(visit) 항목 정의(날짜가 미래면 '임장' 항목으로)
 *
 * 나가는 것: buildSchedule → 정렬된 항목 배열. 항목마다
 *   { key, propId, propName, dropped, date('YYYY-MM-DD'|''), undated, title, short, why, kind, severity, link, done, doneBy, itemId }
 *   kind     'deadline'(법정·계약상 기한) | 'todo'(그날 할 일) | 'visit'(임장 예정) | 'custom'(사용자 일정)
 *   severity 'stop' | 'caution' | 'info'
 *   link     'item:<항목id>' | 'section:<섹션id>' | 'dates' | 'custom:<일정id>'  (매물 상세에서 갈 곳)
 *   doneBy   'item'(체크리스트 항목의 done 을 그대로 씀) | 'sched'(property.scheduleDone[key])
 *
 * 문구 원칙: 쉬운 해요체, 판정·추천 없음. 법정 기한은 근거(법 이름·조문)를 why 에 적고 "확인하세요" 톤.
 * 공휴일은 모른다(토·일만 본다). 기한은 안내일 뿐 법적 효력이 없다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ImjangSchedule = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // app.js 의 DATE_KEYS·DATE_LABELS 와 같아야 한다(저장 모양은 app.js 가 정함)
  var DATE_KEYS = ['contractAt', 'balanceAt', 'vacateAt', 'leaseEndAt', 'moveInAt'];
  var DATE_LABELS = { contractAt: '계약일', balanceAt: '잔금일', vacateAt: '집 비워 주는 날', leaseEndAt: '세입자 임대차 만기', moveInAt: '이사·입주일' };
  var LOAN_TYPES = [
    { id: 'bank', label: '은행 주택담보대출' },
    { id: 'didimdol', label: '디딤돌대출' },
    { id: 'bogeumjari', label: '보금자리론' }
  ];
  var LOAN_LABEL = {};
  LOAN_TYPES.forEach(function (l) { LOAN_LABEL[l.id] = l.label; });
  // 근거(법 이름·조문). 화면에는 작은 글씨로
  var LAW = {
    report: '부동산 거래신고 등에 관한 법률 제3조①',
    jeonip: '주민등록법 제16조①',
    lease: '주택임대차보호법 제6조①',
    firstHome: '지방세특례제한법 제36조의3④'
  };
  var DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  var SEV_RANK = { stop: 0, caution: 1, info: 2 };
  var WEEK_DAYS = 7;
  // 검토 반영: "다음에 할 일"·홈 칩은 최근 이 날수 안에 지난 미완료 기한(deadline, info 아님)을 맨 앞에 두고,
  // 이보다 멀리(1년 넘게) 남은 항목은 "다음에 할 일"에서 뺀다(목록에는 그대로)
  var RECENT_PAST_DAYS = 14;
  var NEXT_HORIZON_DAYS = 365;
  var BAD_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };

  // ---------------- 날짜 도구 ----------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  /** 'YYYY-MM-DD'(있는 날짜)면 그대로, 아니면 '' */
  function isoDateOr(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v).trim());
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return '';
    return m[0];
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m: 1~12
  function parts(iso) { return [+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10)]; }
  function fromUTC(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function toUTC(iso) { var p = parts(iso); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  /** n 일 뒤(음수면 앞). 잘못된 날짜면 '' */
  function addDays(iso, n) {
    iso = isoDateOr(iso);
    if (!iso) return '';
    var d = toUTC(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return fromUTC(d);
  }
  /** n 개월 뒤(음수면 앞). 같은 날이 없는 달이면 그 달의 마지막 날(1월 31일 + 1개월 → 2월 28/29일) */
  function addMonths(iso, n) {
    iso = isoDateOr(iso);
    if (!iso) return '';
    var p = parts(iso);
    var total = p[0] * 12 + (p[1] - 1) + n;
    var y = Math.floor(total / 12);
    var m = total - y * 12 + 1;
    var d = Math.min(p[2], daysInMonth(y, m));
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function addYears(iso, n) { return addMonths(iso, n * 12); }
  /** a 에서 b 까지 며칠(b − a). 같은 날이면 0 */
  function diffDays(a, b) {
    a = isoDateOr(a); b = isoDateOr(b);
    if (!a || !b) return null;
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }
  /** 요일 0(일)~6(토) */
  function weekday(iso) { iso = isoDateOr(iso); return iso ? toUTC(iso).getUTCDay() : null; }
  function weekdayKo(iso) { var w = weekday(iso); return w === null ? '' : DAY_KO[w]; }
  function isWeekend(iso) { var w = weekday(iso); return w === 0 || w === 6; }
  /** 기기 시각 → 'YYYY-MM-DD'(app.js todayISO 와 같은 계산) */
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /** 'D-3' / 'D-Day' / 'D+2'. 날짜가 없으면 '' */
  function dLabel(date, today) {
    var n = diffDays(today, date);
    if (n === null) return '';
    if (n === 0) return 'D-Day';
    return n > 0 ? 'D-' + n : 'D+' + (-n);
  }
  /** 읽기 도구용 말: '오늘' / '3일 뒤' / '4일 지남'. 날짜가 없으면 '' */
  function dSpoken(date, today) {
    var n = diffDays(today, date);
    if (n === null) return '';
    if (n === 0) return '오늘';
    return n > 0 ? n + '일 뒤' : (-n) + '일 지남';
  }
  /** 짧은 날짜 '10.30 (금)'. 올해가 아니면 '2027.1.5 (화)' */
  function shortDate(iso, today) {
    iso = isoDateOr(iso);
    if (!iso) return '';
    var p = parts(iso);
    var y = today && isoDateOr(today) && parts(today)[0] === p[0] ? '' : p[0] + '.';
    return y + p[1] + '.' + p[2] + ' (' + weekdayKo(iso) + ')';
  }
  /** 긴 날짜 '2026년 10월 30일 (금)' */
  function longDate(iso) {
    iso = isoDateOr(iso);
    if (!iso) return '';
    var p = parts(iso);
    return p[0] + '년 ' + p[1] + '월 ' + p[2] + '일 (' + weekdayKo(iso) + ')';
  }

  // ---------------- 항목 만들기 ----------------
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function itemDone(p, id) { var st = p && p.items && hasOwn(p.items, id) ? p.items[id] : null; return !!(st && st.done); }
  function schedDone(p, key) {
    var d = p && p.scheduleDone;
    if (!d || typeof d !== 'object' || !hasOwn(d, key)) return false;
    return typeof d[key] === 'number' && d[key] > 0;
  }
  function dateOf(p, k) { return p && p.dates && typeof p.dates === 'object' ? isoDateOr(p.dates[k]) : ''; }
  function cleanSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    return {
      firstHome: hasOwn(s, 'firstHome') ? !!s.firstHome : true,
      loanType: LOAN_LABEL[s.loanType] ? s.loanType : 'bank'
    };
  }
  function cmpItems(a, b) {
    if (a.undated !== b.undated) return a.undated ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var sa = SEV_RANK[a.severity], sb = SEV_RANK[b.severity];
    if (sa !== sb) return sa - sb;
    if (a.propName !== b.propName) return a.propName < b.propName ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  /**
   * 매물 하나의 항목들. today 는 '지났어요' 같은 문구에만 쓴다(항목을 빼지는 않음 — 지난 것은 app.js 가 접어서 보여 준다)
   */
  function buildForProp(p, s, today, visits) {
    var out = [];
    if (!p || typeof p !== 'object') return out;
    var id = str(p.id);
    var name = str(p.name) || '이름 없는 매물';
    var dropped = p.status === 'dropped';
    function push(sub, o) {
      var it = {
        key: id + ':' + sub, propId: id, propName: name, dropped: dropped,
        date: o.date || '', undated: !o.date, title: o.title, short: o.short || o.title, why: o.why || '',
        kind: o.kind || 'todo', severity: o.severity || 'info', link: o.link || 'dates',
        doneBy: o.itemId ? 'item' : 'sched', itemId: o.itemId || ''
      };
      it.done = o.itemId ? itemDone(p, o.itemId) : schedDone(p, it.key);
      out.push(it);
      return it;
    }
    var contractAt = dateOf(p, 'contractAt');
    var balanceAt = dateOf(p, 'balanceAt');
    var vacateAt = dateOf(p, 'vacateAt');
    var leaseEndAt = dateOf(p, 'leaseEndAt');
    var moveInAt = dateOf(p, 'moveInAt');

    // 1) 등기부 재열람 — 가계약금 보내기 전(날짜 없음): 계약을 잡은 매물(계약일·잔금일이 있거나 상태가 계약 검토)에서,
    //    아직 계약 전일 때만(계약일이 지났으면, 계약일이 없고 잔금일이 지났으면 뺀다)
    var preContract = contractAt ? contractAt >= today : (balanceAt ? balanceAt >= today : true);
    if ((contractAt || balanceAt || p.status === 'contract') && preContract) {
      push('reg-now', {
        title: '등기부 다시 열람 — 가계약금 보내기 전', short: '등기부 재열람',
        why: '체크리스트 최종 확인 → 가계약금 보내기 전. 오늘 날짜로 다시 떼서 앞 기록과 비교하세요',
        kind: 'todo', severity: 'caution', link: 'item:fin-reg-now', itemId: 'fin-reg-now'
      });
    }
    // 2) 계약일: 아침에 등기부 재열람, 실거래 신고 기한(+30일)
    if (contractAt) {
      push('reg-contract', {
        date: contractAt, title: '계약일 — 아침에 등기부 다시 열람', short: '계약일 등기부',
        why: '체크리스트 최종 확인 → 계약서 쓰는 날. 계약서에 도장 찍기 전에 오늘 날짜 등기부를 보세요',
        kind: 'todo', severity: 'caution', link: 'item:fin-reg-contract', itemId: 'fin-reg-contract'
      });
      push('report', {
        date: addDays(contractAt, 30), title: '실거래 신고 기한 (계약일부터 30일)', short: '실거래 신고',
        why: LAW.report + ' · 보통 중개사가 신고해요. 신고가 됐는지만 확인하세요',
        kind: 'deadline', severity: 'info', link: 'dates'
      });
    }
    // 3) 잔금일
    if (balanceAt) {
      if (isWeekend(balanceAt)) {
        push('balance-weekend', {
          date: balanceAt, title: '잔금일이 ' + weekdayKo(balanceAt) + '요일이에요 — 은행 대출 실행·등기 접수가 안 돼요', short: '잔금 주말',
          why: '잔금일을 평일로 다시 잡는지 중개사·은행에 확인하세요. 공휴일은 앱이 모르니 직접 확인하세요',
          kind: 'deadline', severity: 'stop', link: 'dates'
        });
      }
      push('reg-balance', {
        date: balanceAt, title: '잔금일 — 아침에 등기부 다시 열람', short: '잔금 등기부',
        why: '체크리스트 최종 확인 → 잔금일. 잔금을 보내기 전에 오늘 날짜 등기부를 보세요',
        kind: 'todo', severity: 'caution', link: 'item:fin-reg-balance', itemId: 'fin-reg-balance'
      });
      push('balance-day', {
        date: balanceAt, title: '잔금일 할 일 — 전입세대확인서·관리비 정산·근저당 말소 확인·열쇠', short: '잔금',
        why: '체크리스트 최종 확인 → 잔금일 묶음에서 하나씩 확인하세요',
        kind: 'todo', severity: 'caution', link: 'item:fin-jeonip-balance'
      });
      if (s.loanType === 'didimdol') {
        push('loan-movein', {
          date: addMonths(balanceAt, 1), title: '대출 전입 의무 기한 (디딤돌: 잔금일부터 1개월)', short: '전입 의무',
          why: '디딤돌대출은 대출 실행일부터 1개월 안에 전입해요. 사유서를 내면 2개월 연장할 수 있어요 — 은행에 확인하세요',
          kind: 'deadline', severity: 'caution', link: 'dates'
        });
      } else {
        push('loan-movein', {
          date: addMonths(balanceAt, 6), title: '대출 전입 의무 기한 (' + (s.loanType === 'bogeumjari' ? '보금자리론' : '주택담보대출') + ': 잔금일부터 6개월)', short: '전입 의무',
          why: '수도권 주택담보대출·보금자리론은 대출 실행일부터 6개월 안에 전입해요(2025-06-27 대책). 내 대출의 조건은 은행에 확인하세요',
          kind: 'deadline', severity: 'caution', link: 'dates'
        });
      }
      // 생애최초 취득세 감면의 추징 요건(지방세특례제한법 제36조의3④, 2025-12-31 개정·2026-01-01 시행): 취득일부터 3년 안에 팔거나 증여하거나
      // 임대 등 다른 용도로 쓰면 추징. 종전의 "3개월 안 상시 거주 시작" 요건은 삭제됐다(세션 조사·검증 2026-10-11). 기산점은 취득일(잔금·등기일)
      if (s.firstHome) {
        push('first-home-hold', {
          date: addYears(balanceAt, 3), title: '생애최초 감면 유지 — 취득일부터 3년', short: '감면 유지',
          why: LAW.firstHome + ' · 취득일부터 3년 안에 팔거나 증여하거나 세를 주는 등 다른 용도로 쓰면 감면받은 취득세를 다시 내요(추징, 2026-01-01 시행 개정). 본인이 살 목적이어야 하니 수리가 끝나면 바로 전입하세요. 위택스·구청에 확인하세요',
          kind: 'deadline', severity: 'info', link: 'dates'
        });
      }
    }
    // 4) 이사·입주: 전입신고 +14일(입주일이 없으면 잔금일 기준)
    var moveBase = moveInAt || balanceAt;
    if (moveInAt) {
      push('move-in', {
        date: moveInAt, title: '이사·입주일', short: '입주',
        why: '이삿짐·관리사무소 입주 신고·전입신고 준비', kind: 'todo', severity: 'info', link: 'dates'
      });
    }
    if (moveBase) {
      push('jeonip', {
        date: addDays(moveBase, 14), title: '전입신고 기한 (이사한 날부터 14일)', short: '전입신고',
        why: LAW.jeonip + ' · 주민센터나 정부24에서 해요' + (moveInAt ? '' : ' · 지금은 잔금일 기준이에요. 입주일을 적으면 다시 계산해요'),
        kind: 'deadline', severity: 'caution', link: 'dates'
      });
    }
    // 5) 세입자: 만기, 갱신거절 통지 기한, 퇴거일이 만기보다 늦으면 주의
    //    통지 기한은 "만기 2개월 전까지"(주택임대차보호법 제6조①). 통지는 세입자가 받은 날 기준이고 기간 셈(민법 초일 불산입 역산)에 따라
    //    "2개월 전 되는 날" 당일은 늦다는 해석이 있어, 안내 날짜는 그 전날로 하루 앞당겨 둔다(안내일 뿐 법적 효력 없음)
    if (leaseEndAt) {
      var notice = addDays(addMonths(leaseEndAt, -2), -1);
      var passed = today && notice < today;
      var buyerLate = balanceAt && balanceAt > notice;
      push('lease-notice', {
        date: notice,
        title: '세입자 갱신거절 통지 기한 (만기 2개월 전 되는 날의 전날까지 도달)' + (passed ? ' — 지났어요. 통지 여부를 확인하세요' : ''), short: '갱신거절 통지',
        why: LAW.lease + ' · 임대인은 만기 6개월~2개월 전에 통지해야 갱신을 거절할 수 있어요(받은 날 기준, 기간 셈이 복잡해 하루 앞당겨 잡았어요). ' +
          '집을 산 사람이 "직접 살겠다"는 이유로 거절하려면 이 기간 안에 잔금·등기까지 마쳐야 해요(대법원 2022.12.1. 2021다266631)' +
          (buyerLate ? ' · 지금 적은 잔금일(' + balanceAt + ')은 이 기한보다 늦어요 — 중개사·법무사에게 확인하세요' : '') + '. 세입자의 갱신요구권도 함께 확인하세요',
        kind: 'deadline', severity: passed ? 'stop' : 'caution', link: 'item:fin-sp-tenant'
      });
      push('lease-end', {
        date: leaseEndAt, title: '세입자 임대차 만기', short: '임대차 만기',
        why: '보증금 반환·퇴거 조건이 계약서 특약과 맞는지 확인하세요', kind: 'todo', severity: 'info', link: 'dates'
      });
    }
    if (vacateAt) {
      push('vacate', {
        date: vacateAt, title: '집 비워 주는 날 (세입자 퇴거)', short: '퇴거',
        why: '비워진 상태를 직접 확인한 뒤 잔금을 치르는 조건인지 특약을 보세요', kind: 'todo', severity: 'info', link: 'dates'
      });
      if (leaseEndAt && vacateAt > leaseEndAt) {
        push('vacate-late', {
          date: vacateAt, title: '퇴거일이 임대차 만기보다 늦어요', short: '퇴거 늦음',
          why: '만기 뒤에도 세입자가 남는 조건이에요. 보증금 반환·퇴거 약속을 특약에 어떻게 적었는지 확인하세요',
          kind: 'deadline', severity: 'caution', link: 'item:fin-sp-tenant'
        });
      }
    }
    // 6) 임장 예정일: 체크리스트 visit 항목의 날짜가 오늘보다 뒤면
    (visits || []).forEach(function (v) {
      if (!v || !v.id) return;
      var st = p.items && hasOwn(p.items, v.id) ? p.items[v.id] : null;
      var at = st ? isoDateOr(st.date) : '';
      if (!at || !today || at <= today) return;
      push('visit:' + v.id, {
        date: at, title: '임장 — ' + str(v.text), short: '임장',
        why: '체크리스트 다시 가 보기 → 다녀온 날짜', kind: 'visit', severity: 'info', link: 'item:' + v.id, itemId: v.id
      });
    });
    // 7) 사용자 지정 일정
    (Array.isArray(p.customEvents) ? p.customEvents : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var at = isoDateOr(e.at);
      var eid = str(e.id);
      if (!at || !eid || BAD_KEYS[eid]) return;
      push('custom:' + eid, {
        date: at, title: str(e.title) || '일정', short: str(e.title).slice(0, 8) || '일정',
        why: str(e.memo), kind: 'custom', severity: 'info', link: 'custom:' + eid
      });
    });
    return out;
  }

  /** 모든 매물의 항목(정렬). 날짜가 있는 것만(가계약 전 재열람만 날짜 없이) */
  function buildSchedule(props, settings, today, opts) {
    var s = cleanSettings(settings);
    var visits = opts && Array.isArray(opts.visits) ? opts.visits : [];
    today = isoDateOr(today) || todayISO();
    var out = [];
    (Array.isArray(props) ? props : []).forEach(function (p) { out = out.concat(buildForProp(p, s, today, visits)); });
    out.sort(cmpItems);
    return out;
  }

  /** 지난 것 / 날짜 없음 / 오늘 / 이번 주(7일 안) / 이후 로 묶는다(순서 고정, 비어도 돌려줌) */
  function groupItems(items, today) {
    today = isoDateOr(today) || todayISO();
    var g = { past: [], undated: [], today: [], week: [], later: [] };
    (items || []).forEach(function (it) {
      if (it.undated) g.undated.push(it);
      else if (it.date < today) g.past.push(it);
      else if (it.date === today) g.today.push(it);
      else if (diffDays(today, it.date) <= WEEK_DAYS) g.week.push(it);
      else g.later.push(it);
    });
    return [
      { id: 'past', label: '지난 것', items: g.past },
      { id: 'undated', label: '날짜 없음 · 가계약금 보내기 전', items: g.undated },
      { id: 'today', label: '오늘', items: g.today },
      { id: 'week', label: '이번 주 (7일 안)', items: g.week },
      { id: 'later', label: '이후', items: g.later }
    ];
  }

  /** 지난 '진짜 기한'인가: 미완료·날짜 있음·오늘보다 앞·kind deadline·severity info 아님(그날 할 일·임장·내 일정·정보성 기한은 아님) */
  function isPastDeadline(it, today) {
    return !!it && !it.done && !it.undated && !!it.date && it.date < today && it.kind === 'deadline' && it.severity !== 'info';
  }
  /** 최근(RECENT_PAST_DAYS 안)에 지난 진짜 기한 — "다음에 할 일"·홈 칩 맨 앞 */
  function isUrgentPast(it, today) {
    today = isoDateOr(today) || todayISO();
    return isPastDeadline(it, today) && diffDays(it.date, today) <= RECENT_PAST_DAYS;
  }
  /**
   * "다음에 할 일": 미완료 중 ① 최근 14일 안에 지난 진짜 기한(날짜순) → ② 날짜 없음·오늘 이후 1년 안(날짜순) 에서 앞의 n 개.
   * opts.includeDropped 가 아니면 탈락 매물은 뺀다(매물 하나를 골라 보는 화면은 켜서 부른다)
   */
  function nextItems(items, today, n, opts) {
    today = isoDateOr(today) || todayISO();
    var inc = !!(opts && opts.includeDropped);
    var list = (items || []).filter(function (it) { return it && !it.done && (inc || !it.dropped); });
    var urgent = list.filter(function (it) { return isUrgentPast(it, today); });
    var up = list.filter(function (it) { return it.undated || (it.date >= today && diffDays(today, it.date) <= NEXT_HORIZON_DAYS); });
    return urgent.concat(up).slice(0, n || 3);
  }

  /**
   * 홈 카드 칩용 하나: ① 최근 14일 안에 지난 진짜 기한(가장 최근 것) → ② 가장 가까운 다가오는(오늘 포함) 미완료 항목 →
   * ③ 그보다 오래 전에 지난 진짜 기한(가장 최근 것). 지난 '할 일'·정보성 기한은 다가오는 기한을 가리지 않는다. 없으면 null.
   * 탈락 매물은 거르지 않는다(부르는 쪽이 정함)
   */
  function nextFor(items, today) {
    today = isoDateOr(today) || todayISO();
    var urgent = null, up = null, past = null;
    (items || []).forEach(function (it) {
      if (!it || it.done || it.undated || !it.date) return;
      if (it.date >= today) { if (!up || it.date < up.date) up = it; return; } // 같은 날은 먼저 온 것(정렬상 심각도 높은 쪽)
      if (!isPastDeadline(it, today)) return;
      if (isUrgentPast(it, today)) { if (!urgent || it.date > urgent.date) urgent = it; }
      else if (!past || it.date > past.date) past = it;
    });
    return urgent || up || past;
  }

  // ---------------- 캘린더 파일(.ics) ----------------
  function icsEscape(s) {
    return str(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function utf8Len(ch) {
    var c = ch.charCodeAt(0);
    if (c < 0x80) return 1;
    if (c < 0x800) return 2;
    if (c >= 0xD800 && c <= 0xDBFF) return 4; // 짝(surrogate pair)의 앞 글자: 뒤 글자는 0 으로 센다
    if (c >= 0xDC00 && c <= 0xDFFF) return 0;
    return 3;
  }
  /** RFC 5545 줄 접기: 한 줄 75옥텟 안(UTF-8 기준). 이어지는 줄은 공백 하나로 시작 */
  function fold(line) {
    var out = '', cur = '', bytes = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      var n = utf8Len(ch);
      if (bytes + n > 74 && n > 0) { out += cur + '\r\n '; cur = ''; bytes = 1; }
      cur += ch;
      bytes += n;
    }
    return out + cur;
  }
  function icsDate(iso) { return iso.replace(/-/g, ''); }
  function icsStamp(d) {
    d = d || new Date();
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }
  function uidOf(key) { return str(key).replace(/[^A-Za-z0-9_.-]+/g, '-') + '@imjang-checklist'; }
  /**
   * 종일 VEVENT 로 내보낸다. 날짜 없는 항목은 뺀다(완료·탈락은 부르는 쪽이 거른다).
   * opts: { now: Date(DTSTAMP), name: 달력 이름 }. UID 는 항목 key 에서 만들어 같은 항목은 늘 같다(다시 넣어도 겹치지 않게)
   */
  function toICS(items, opts) {
    opts = opts || {};
    var stamp = icsStamp(opts.now);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//imjang-checklist//schedule 1.10.0//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + icsEscape(opts.name || '임장 체크리스트')];
    (items || []).forEach(function (it) {
      var date = isoDateOr(it.date);
      if (!date) return;
      var desc = [it.why, it.kind === 'deadline' ? '기한은 안내일 뿐 법적 효력이 없어요. 공휴일은 반영하지 않았어요. 확인하세요.' : ''].filter(Boolean).join('\n');
      L.push('BEGIN:VEVENT');
      L.push('UID:' + uidOf(it.key));
      L.push('DTSTAMP:' + stamp);
      L.push('DTSTART;VALUE=DATE:' + icsDate(date));
      L.push('DTEND;VALUE=DATE:' + icsDate(addDays(date, 1)));
      L.push('SUMMARY:' + icsEscape('[임장] ' + it.propName + ' — ' + it.title));
      if (desc) L.push('DESCRIPTION:' + icsEscape(desc));
      L.push('CATEGORIES:' + icsEscape(it.kind === 'deadline' ? '기한' : it.kind === 'visit' ? '임장' : '할 일'));
      L.push('END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  return {
    DATE_KEYS: DATE_KEYS,
    DATE_LABELS: DATE_LABELS,
    LOAN_TYPES: LOAN_TYPES,
    LOAN_LABEL: LOAN_LABEL,
    LAW: LAW,
    isoDateOr: isoDateOr,
    addDays: addDays,
    addMonths: addMonths,
    addYears: addYears,
    diffDays: diffDays,
    weekday: weekday,
    weekdayKo: weekdayKo,
    isWeekend: isWeekend,
    todayISO: todayISO,
    dLabel: dLabel,
    dSpoken: dSpoken,
    shortDate: shortDate,
    longDate: longDate,
    buildSchedule: buildSchedule,
    groupItems: groupItems,
    nextItems: nextItems,
    nextFor: nextFor,
    isPastDeadline: isPastDeadline,
    isUrgentPast: isUrgentPast,
    RECENT_PAST_DAYS: RECENT_PAST_DAYS,
    NEXT_HORIZON_DAYS: NEXT_HORIZON_DAYS,
    toICS: toICS,
    icsEscape: icsEscape,
    fold: fold
  };
});
