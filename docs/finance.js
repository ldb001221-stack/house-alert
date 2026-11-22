// 💰 자금 계획: 자기자본·소득을 넣으면 집마다 필요한 대출, LTV, 상품별 한도, 월 상환액을 계산해요.
// ※ 참고용 계산기예요. 한도·금리 기본값은 docs/rates.json (15일마다 자동 갱신)에서 읽어요.
(function () {
  const KEY = "ha-fin-v2";
  const DEFAULTS = {
    equity: 0,          // 자기자본 (만원)
    income: 0,          // 연소득, 부부합산 (만원)
    otherDebt: 0,       // 기존 대출 연간 원리금 (만원)
    firstHome: true,    // 생애최초 주택구입
    method: "equal",    // equal 원리금균등 / principal 원금균등 / bullet 만기일시
    years: 30,
    ov: {},             // 내가 직접 고친 금리 (없으면 rates.json 값 사용)
  };
  // rates.json 을 못 읽을 때 쓰는 예비값
  let R = {
    updated: "2026-11-22", checked: "2026-11-22",
    bank: { name: "시중은행 주담대", rate: 4.2, ltv_first: 70, ltv_normal: 40, cap: 60000, dsr: 40, stress: 1.5,
      note_first: "서울(규제지역) 생애최초 LTV 70% · 6개월 내 전입", note_normal: "서울(규제지역) 무주택 LTV 40%" },
    bogeum: { name: "보금자리론", rate: 5.0, ltv: 70, cap: 36000, cap_first: 42000, price_max: 60000, income_max: 7000, dti: 60, note: "고정금리 · 주택금융공사" },
    didim: { name: "디딤돌대출", rate: 3.5, ltv: 70, cap: 20000, cap_first: 24000, price_max: 50000, area_max: 85, income_max: 6000, income_max_first: 7000, dti: 60,
      note: "무주택 세대주 · 순자산 기준 있음 · 주택도시기금" },
    jeonse: { rate: 4.0, ratio: 80 },
  };
  const RATE_KEYS = {
    rateBank: () => R.bank.rate, stress: () => R.bank.stress, rateBogeum: () => R.bogeum.rate,
    rateDidim: () => R.didim.rate, rateJeonse: () => R.jeonse.rate,
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function load() {
    try {
      const old = JSON.parse(localStorage.getItem("ha-fin-v1") || "null"); // 이전 버전 개인정보 옮기기
      const cur = JSON.parse(localStorage.getItem(KEY) || "null");
      const base = cur || (old ? { equity: old.equity, income: old.income, otherDebt: old.otherDebt, firstHome: old.firstHome, method: old.method, years: old.years } : {});
      return { ...DEFAULTS, ...base, ov: { ...(base.ov || {}) } };
    } catch (e) { return { ...DEFAULTS, ov: {} }; }
  }
  function save(s) {
    const { equity, income, otherDebt, firstHome, method, years, ov } = s;
    try { localStorage.setItem(KEY, JSON.stringify({ equity, income, otherDebt, firstHome, method, years, ov })); } catch (e) {}
  }
  // 실제 계산에 쓰는 금리 = 내가 고친 값 ?? rates.json 값
  function applyRates() { for (const k in RATE_KEYS) S[k] = k in S.ov ? S.ov[k] : RATE_KEYS[k](); }
  let S = load();
  applyRates();
  fetch("rates.json?t=" + Date.now()).then(r => r.json()).then(j => {
    if (j && j.bank && j.bogeum && j.didim) { R = { ...R, ...j }; applyRates(); document.dispatchEvent(new Event("hafin-change")); }
  }).catch(() => {});

  function money(v) {
    v = Math.round(+v || 0);
    const neg = v < 0; v = Math.abs(v);
    const eok = Math.floor(v / 10000), man = v % 10000;
    const t = eok && man ? `${eok}억 ${man.toLocaleString()}` : eok ? `${eok}억` : `${man.toLocaleString()}`;
    return (neg ? "-" : "") + t + (eok ? "" : "만");
  }
  const won = v => `${Math.round(v).toLocaleString()}만원`;

  // ---- 상환액 계산 ----
  function payment(P, ratePct, years, method) {
    const r = ratePct / 100 / 12, n = years * 12;
    if (P <= 0) return { first: 0, last: 0, interest: 0 };
    if (method === "bullet") return { first: P * r, last: P * r + P, interest: P * r * n };
    if (method === "principal") {
      const base = P / n;
      return { first: base + P * r, last: base + base * r, interest: P * r * (n + 1) / 2 };
    }
    const m = r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n));
    return { first: m, last: m, interest: m * n - P };
  }
  // 연간 상환 한도로 빌릴 수 있는 원금 (원리금균등 기준)
  function principalFor(annualPay, ratePct, years) {
    if (annualPay <= 0) return 0;
    const r = ratePct / 100 / 12, n = years * 12, m = annualPay / 12;
    return r === 0 ? m * n : m * (1 - Math.pow(1 + r, -n)) / r;
  }

  // ---- 취득 부대비용 (85㎡ 이하·1주택 가정) ----
  function buyCosts(price, area) {
    const taxRate = price <= 60000 ? 0.01 : price <= 90000 ? (price * 2 / 30000 - 3) / 100 : 0.03;
    let tax = price * taxRate + price * taxRate * 0.1;           // 취득세 + 지방교육세
    if (area > 85) tax += price * 0.002;                           // 농어촌특별세
    const relief = S.firstHome && price <= 120000 ? Math.min(200, price * taxRate) : 0; // 생애최초 감면(최대 200만원)
    const broker = price * (price < 20000 ? 0.005 : price < 90000 ? 0.004 : 0.005) * 1.1; // 중개보수+VAT
    const etc = price * 0.003;                                     // 법무사·등기·채권 등 약 0.3%
    return { tax, relief, broker, etc, total: tax - relief + broker + etc };
  }

  // ---- 매매 대출 상품 ----
  function products(r) {
    const price = r.price, inc = S.income, first = S.firstHome;
    const B = R.bank, Q = R.bogeum, D = R.didim;
    const didimInc = first ? (D.income_max_first || D.income_max) : D.income_max;
    const list = [
      {
        key: "bank", name: B.name, rate: S.rateBank,
        ltv: first ? B.ltv_first : B.ltv_normal, cap: B.cap,
        limitBy: `DSR ${B.dsr}%`, dsrRate: S.rateBank + S.stress, ratio: B.dsr / 100,
        checks: [], note: first ? B.note_first : B.note_normal,
      },
      {
        key: "bogeum", name: Q.name, rate: S.rateBogeum,
        ltv: Q.ltv, cap: first ? (Q.cap_first || Q.cap) : Q.cap,
        limitBy: `DTI ${Q.dti}%`, dsrRate: S.rateBogeum, ratio: Q.dti / 100,
        checks: [[price <= Q.price_max, `주택가격 ${money(Q.price_max)} 이하`], [!inc || inc <= Q.income_max, `연소득 ${money(Q.income_max)}원 이하`]],
        note: Q.note,
      },
      {
        key: "didim", name: D.name, rate: S.rateDidim,
        ltv: D.ltv, cap: first ? (D.cap_first || D.cap) : D.cap,
        limitBy: `DTI ${D.dti}%`, dsrRate: S.rateDidim, ratio: D.dti / 100,
        checks: [[price <= D.price_max, `주택가격 ${money(D.price_max)} 이하`], [r.area <= D.area_max, `전용 ${D.area_max}㎡ 이하`],
                 [!inc || inc <= didimInc, `연소득 ${money(didimInc)}원 이하`]],
        note: D.note,
      },
    ];
    const costs = buyCosts(price, r.area);
    const need = Math.max(0, price + costs.total - S.equity);
    return {
      costs, need,
      items: list.map(p => {
        const fails = p.checks.filter(c => !c[0]).map(c => c[1]);
        const byLtv = price * p.ltv / 100;
        const byIncome = inc ? principalFor(inc * p.ratio - S.otherDebt, p.dsrRate, S.years) : Infinity;
        const max = Math.max(0, Math.min(byLtv, p.cap, byIncome));
        const loan = Math.min(need, max);
        const pay = payment(loan, p.rate, S.years, S.method);
        const binding = max === byLtv ? `LTV ${p.ltv}%` : max === p.cap ? "상품 한도" : p.limitBy;
        return { ...p, ok: !fails.length, fails, byLtv, byIncome, max, loan, short: Math.max(0, need - max), pay, binding,
          ltvUsed: loan / price * 100 };
      }),
    };
  }

  function best(res) {
    const ok = res.items.filter(p => p.ok);
    const full = ok.filter(p => p.short === 0).sort((a, b) => a.pay.first - b.pay.first);
    return full[0] || ok.sort((a, b) => a.short - b.short)[0];
  }

  // ---- 전세 / 월세 ----
  function rentCalc(r) {
    const need = Math.max(0, r.deposit - S.equity);
    const max = r.deposit * (R.jeonse.ratio || 80) / 100;
    const loan = Math.min(need, max);
    return { need, max, loan, short: Math.max(0, need - max), interest: loan * S.rateJeonse / 100 / 12 };
  }

  const ready = () => S.equity > 0;
  const methodLabel = { equal: "원리금균등", principal: "원금균등", bullet: "만기일시" };

  // 카드에 들어갈 한 줄 요약
  function summary(r) {
    if (!ready()) return "";
    if (r.kind === "sale") {
      const res = products(r), b = best(res);
      if (res.need === 0) return `<div class="fin-line">💰 자기자본으로 충분 (부대비용 포함)</div>`;
      if (!b) return `<div class="fin-line warn">💰 필요 대출 ${money(res.need)} · 조건 맞는 상품 없음</div>`;
      return `<div class="fin-line${b.short ? " warn" : ""}">💰 필요 대출 ${money(res.need)} · ${esc(b.name)} 월 약 ${won(b.pay.first)}${b.short ? ` · ${money(b.short)} 부족` : ""}</div>`;
    }
    const c = rentCalc(r);
    if (c.need === 0) return `<div class="fin-line">💰 자기자본으로 보증금 충분</div>`;
    const monthly = c.interest + (r.rent || 0);
    return `<div class="fin-line${c.short ? " warn" : ""}">💰 전세대출 ${money(c.loan)} · 월 부담 약 ${won(monthly)}${c.short ? ` · ${money(c.short)} 부족` : ""}</div>`;
  }

  // ---- 자세히 (대화상자) ----
  function dlg() {
    let d = document.getElementById("fin-dialog");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "fin-dialog";
      d.className = "fin-dialog";
      document.body.appendChild(d);
      d.addEventListener("click", e => { if (e.target === d) d.close(); });
    }
    return d;
  }

  function row(k, v, cls = "") { return `<tr class="${cls}"><th>${k}</th><td>${v}</td></tr>`; }

  function detailHtml(r) {
    const head = `<div class="fin-head"><div><b>${esc(r.name)}</b> <span class="meta">${esc(r.dong)} · ${r.pyeong}평(${r.area}㎡) · ${r.floor}층</span></div>
      <button class="fin-x" onclick="this.closest('dialog').close()" aria-label="닫기">✕</button></div>`;
    if (!ready()) return head + `<p>먼저 <b>💰 내 자금 설정</b>에서 자기자본을 입력해주세요.</p>
      <button class="fin-btn" onclick="this.closest('dialog').close();HAFin.openSettings()">자금 설정 열기</button>`;
    if (r.kind !== "sale") {
      const c = rentCalc(r);
      return head + `<table class="fin-t">
        ${row("보증금", money(r.deposit))}${r.rent ? row("월세", won(r.rent)) : ""}
        ${row("내 자기자본", money(S.equity))}
        ${row("부족한 보증금", money(c.need), "em")}
        ${row(`전세대출 한도(보증금 ${R.jeonse.ratio || 80}% 가정)`, money(c.max))}
        ${row("대출 금액", money(c.loan))}
        ${row(`월 이자 (연 ${S.rateJeonse}%, 만기일시)`, won(c.interest))}
        ${row("월 주거비 합계 (이자+월세)", won(c.interest + (r.rent || 0)), "em")}
        ${c.short ? row("그래도 부족한 금액", money(c.short), "warn") : ""}
      </table>
      <p class="fin-note">전세대출은 보증기관(HUG·HF·SGI)과 소득·보증금 조건에 따라 한도가 달라요. 버팀목 등 정책 전세대출은 조건이 맞으면 금리가 더 낮을 수 있어요.</p>`;
    }
    const res = products(r), b = best(res), c = res.costs;
    const cards = res.items.map(p => {
      const status = !p.ok ? `<span class="fin-tag no">대상 아님</span>` : p.short ? `<span class="fin-tag warn">${money(p.short)} 부족</span>` : `<span class="fin-tag ok">가능</span>`;
      return `<div class="fin-prod${p === b ? " best" : ""}">
        <div class="fin-prod-h"><b>${esc(p.name)}</b>${status}</div>
        <div class="meta">${esc(p.note)}</div>
        ${!p.ok ? `<div class="meta warn">조건 미충족: ${p.fails.map(esc).join(", ")}</div>` : ""}
        <table class="fin-t sm">
          ${row("금리", `연 ${p.rate}%`)}
          ${row("최대 한도", `${money(p.max)} <span class="meta">(${esc(p.binding)}에 걸림)</span>`)}
          ${row("· LTV 기준", `${p.ltv}% → ${money(p.byLtv)}`)}
          ${row("· 상품 한도", money(p.cap))}
          ${row(`· 소득 기준 (${p.limitBy})`, S.income ? money(p.byIncome) : "소득 미입력")}
          ${row("이 집 대출 금액", `${money(p.loan)} <span class="meta">(LTV ${p.ltvUsed.toFixed(0)}%)</span>`, "em")}
          ${row(`월 상환 (${methodLabel[S.method]}, ${S.years}년)`, S.method === "equal" ? won(p.pay.first)
            : S.method === "bullet" ? `${won(p.pay.first)} (이자만, 만기에 원금)` : `첫 달 ${won(p.pay.first)} → 마지막 ${won(p.pay.last)}`, "em")}
          ${row("총 이자", money(p.pay.interest))}
        </table></div>`;
    }).join("");
    return head + `
      <table class="fin-t">
        ${row("매매가", money(r.price))}
        ${row("+ 취득세·지방교육세", won(c.tax) + (c.relief ? ` <span class="meta">(생애최초 감면 -${won(c.relief)})</span>` : ""))}
        ${row("+ 중개보수(부가세 포함)", won(c.broker))}
        ${row("+ 등기·법무사 등 (약)", won(c.etc))}
        ${row("총 필요 자금", money(r.price + c.total), "em")}
        ${row("− 내 자기자본", money(S.equity))}
        ${row("필요한 대출", money(res.need), "em")}
      </table>
      ${res.need === 0 ? `<p>자기자본만으로 살 수 있어요.</p>` : `
      <div class="group-label">상품별 비교 ${b ? `<span class="meta">· 테두리 = 가능한 상품 중 월 상환액이 가장 적은 것</span>` : ""}</div>
      <div class="fin-prods">${cards}</div>`}
      <p class="fin-note">참고용 계산이에요. 한도·금리 기준일 ${esc(R.updated)} (마지막 확인 ${esc(R.checked || R.updated)}, 15일마다 자동 점검)${Object.keys(S.ov).length ? " · 일부 금리는 직접 고친 값" : ""}. 실제로는 은행·주택금융공사 심사, 기존 대출, 시세(KB시세 등), 정책 변경에 따라 달라져요.
      DSR은 기존 대출 연 상환액을 반영하고, 은행 대출은 스트레스 금리(+${S.stress}%p)를 적용했어요.
      신청 전에 <a href="https://www.hf.go.kr" target="_blank" rel="noopener">한국주택금융공사</a>·<a href="https://enhuf.molit.go.kr" target="_blank" rel="noopener">주택도시기금</a>·은행에서 꼭 확인하세요.</p>`;
  }

  function openDetail(r) { const d = dlg(); d.innerHTML = detailHtml(r); d.showModal(); }

  function field(id, label, val, unit, extra = "") {
    return `<label class="fin-f"><span>${label}</span><span class="fin-in"><input id="${id}" type="number" inputmode="decimal" value="${val}" ${extra}><em>${unit}</em></span></label>`;
  }

  function openSettings() {
    const d = dlg();
    d.innerHTML = `<div class="fin-head"><b>💰 내 자금 설정</b><button class="fin-x" onclick="this.closest('dialog').close()" aria-label="닫기">✕</button></div>
      <p class="meta">입력한 값은 이 기기에만 저장돼요. 금액 단위는 만원이에요 (1억 = 10000).</p>
      <div class="fin-grid">
        ${field("f-eq", "납입 가능한 자기자본", S.equity, "만원", 'min="0" step="500"')}
        ${field("f-inc", "연소득 (부부합산, 세전)", S.income, "만원", 'min="0" step="100"')}
        ${field("f-debt", "기존 대출 연간 원리금", S.otherDebt, "만원", 'min="0" step="50"')}
        <label class="fin-f"><span>생애최초 주택구입</span><span class="fin-in"><input id="f-first" type="checkbox" ${S.firstHome ? "checked" : ""}><em>해당</em></span></label>
        <label class="fin-f"><span>상환 방식</span><select id="f-method">
          <option value="equal">원리금균등 (매달 같은 금액)</option><option value="principal">원금균등 (처음에 많고 점점 줄어듦)</option><option value="bullet">만기일시 (이자만, 만기에 원금)</option></select></label>
        <label class="fin-f"><span>대출 기간</span><select id="f-years">${[10, 15, 20, 30, 40, 50].map(y => `<option value="${y}">${y}년</option>`).join("")}</select></label>
      </div>
      <details class="fin-adv"><summary>금리 직접 수정 (기본값: ${esc(R.updated)} 기준, 15일마다 자동 갱신)</summary>
        <div class="fin-grid">
          ${field("f-rb", "시중은행 주담대", S.rateBank, "%", 'step="0.05"')}
          ${field("f-st", "스트레스 DSR 가산", S.stress, "%p", 'step="0.1"')}
          ${field("f-rq", "보금자리론", S.rateBogeum, "%", 'step="0.05"')}
          ${field("f-rd", "디딤돌", S.rateDidim, "%", 'step="0.05"')}
          ${field("f-rj", "전세자금대출", S.rateJeonse, "%", 'step="0.05"')}
        </div></details>
      <div class="fin-actions"><button class="fin-btn ghost" id="f-reset">기본값으로</button><button class="fin-btn" id="f-save">저장</button></div>`;
    d.querySelector("#f-method").value = S.method;
    d.querySelector("#f-years").value = String(S.years);
    const num = id => Math.max(0, parseFloat(d.querySelector(id).value) || 0);
    d.querySelector("#f-save").onclick = () => {
      const ov = {};
      const typed = { rateBank: num("#f-rb"), stress: num("#f-st"), rateBogeum: num("#f-rq"), rateDidim: num("#f-rd"), rateJeonse: num("#f-rj") };
      for (const k in typed) if (Math.abs(typed[k] - RATE_KEYS[k]()) > 1e-9) ov[k] = typed[k]; // 기본값과 다를 때만 저장
      S = { ...S, equity: num("#f-eq"), income: num("#f-inc"), otherDebt: num("#f-debt"),
        firstHome: d.querySelector("#f-first").checked, method: d.querySelector("#f-method").value,
        years: +d.querySelector("#f-years").value, ov };
      applyRates(); save(S); d.close();
      document.dispatchEvent(new Event("hafin-change"));
    };
    d.querySelector("#f-reset").onclick = () => { S.ov = {}; S.method = DEFAULTS.method; S.years = DEFAULTS.years; applyRates(); save(S); openSettings(); };
    d.showModal();
  }

  window.HAFin = { summary, openDetail, openSettings, ready, label: () => ready() ? `💰 자기자본 ${money(S.equity)}` : "💰 내 자금 설정" };
})();
