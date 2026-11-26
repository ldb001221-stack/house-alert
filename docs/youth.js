// 🧑 청년임대 탭: 청년안심주택·행복주택·LH/SH 청년 공고 + 프로그램별 요건 정리 + 간단 자가진단
// ※ 요건은 2026년 공개 자료를 정리한 '대략적인 기준'이에요. 실제 자격은 반드시 각 모집공고문으로 확인해야 해요.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY = "ha-youth-v1";
  // 2026년 도시근로자 가구원수별 월평균소득 (1인 가구 100%, 원)
  const BASE_1P = 3813363;
  const CHECKED = "2026-11";

  const PROGRAMS = [
    {
      name: "청년안심주택", who: "서울시 · 역세권 청년주택",
      rent: "공공임대: 주변 시세의 약 30~50% · 민간임대: 약 75~95% (공급유형별 다름)",
      req: ["만 19~39세", "무주택", "미혼(청년 유형)", "공공임대·민간 특별공급: 소득 기준 있음 (보통 도시근로자 월평균소득 100~120% 이하)", "민간 일반공급: 대체로 소득·자산 제한 없음"],
      stay: "청년 최장 6~10년 (유형별)",
      link: "https://soco.seoul.go.kr/youth/main/main.do",
      check: p => ageOk(p) && p.single && p.noHome
        ? (p.income <= BASE_1P * 1.0 ? ok("공공·민간 모두 지원 가능성 높음")
          : p.income <= BASE_1P * 1.2 ? warn("공공은 공고별 소득 기준 확인, 민간 일반공급은 가능")
          : warn("민간 일반공급 위주로 지원 가능 (소득 기준 초과 가능성)"))
        : no(basicFail(p)),
    },
    {
      name: "행복주택", who: "LH·SH · 청년 계층",
      rent: "주변 시세의 약 60~80%",
      req: ["만 19~39세 (또는 소득 있는 사회초년생)", "미혼 · 무주택", "소득: 도시근로자 월평균소득 100% 이하 (1인 120%, 2인 110%)",
            "총자산 2억 5,100만원 이하", "자동차 4,542만원 이하", "주택청약통장 가입"],
      stay: "청년 최장 6년",
      link: "https://www.myhome.go.kr",
      check: p => {
        if (!(ageOk(p) && p.single && p.noHome)) return no(basicFail(p));
        const fails = [];
        if (p.income > BASE_1P * 1.2) fails.push("소득");
        if (p.asset > 25100) fails.push("총자산");
        if (p.car > 4542) fails.push("자동차");
        return fails.length ? no(fails.join("·") + " 기준 초과") : ok("기본 요건 충족 (1인 가구 기준)");
      },
    },
    {
      name: "청년 매입임대", who: "LH·SH가 사들인 다가구·원룸",
      rent: "주변 시세의 약 40~50%",
      req: ["만 19~39세 · 미혼 · 무주택", "1순위: 생계·의료급여, 차상위 등", "2순위: 본인+부모 소득 100% 이하 (자산 기준 있음)",
            "3순위: 본인 소득 100% 이하 (자산 기준 있음)"],
      stay: "최장 6년 (2년 단위 재계약)",
      link: "https://apply.lh.or.kr",
      check: p => !(ageOk(p) && p.single && p.noHome) ? no(basicFail(p))
        : p.income <= BASE_1P ? ok("3순위 소득 기준 충족 (자산 기준은 공고 확인)")
        : no("본인 소득 100% 초과 — 순위 내 지원 어려움"),
    },
    {
      name: "청년 전세임대", who: "LH가 전셋집을 빌려 재임대",
      rent: "지원 보증금에 대한 낮은 이자 + 본인 부담금 일부",
      req: ["만 19~39세 · 미혼 · 무주택", "순위·소득 기준은 매입임대와 비슷", "지원 한도·본인부담은 공고 확인"],
      stay: "최장 6년",
      link: "https://apply.lh.or.kr",
      check: p => !(ageOk(p) && p.single && p.noHome) ? no(basicFail(p))
        : p.income <= BASE_1P ? ok("소득 기준 충족 가능성 (공고 확인)") : no("본인 소득 100% 초과 가능성"),
    },
  ];
  const ageOk = p => p.age >= 19 && p.age <= 39;
  const basicFail = p => [!ageOk(p) && "나이(만 19~39세)", !p.single && "혼인", !p.noHome && "주택 소유"].filter(Boolean).join("·") + " 조건 미충족";
  const ok = t => ({ c: "ok", icon: "✅", t });
  const warn = t => ({ c: "warn", icon: "⚠️", t });
  const no = t => ({ c: "no", icon: "❌", t });

  function loadP() {
    let p = { age: "", single: true, noHome: true, income: "", asset: "", car: "" };
    try { Object.assign(p, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
    if (p.income === "") {   // 대출 계산에 입력한 연소득이 있으면 월소득으로 채워줌
      try { const f = JSON.parse(localStorage.getItem("ha-fin-v2") || "{}"); if (f.income) p.income = Math.round(f.income / 12); } catch (e) {}
    }
    return p;
  }
  function saveP(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {} }

  const isUpcoming = n => !n.deadline || n.deadline >= new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const isNew = (DATA, n) => n.first_seen === DATA.today;

  function noticeCard(DATA, n) {
    const tags = [n.program, n.category].filter(Boolean).map(t => `<span class="badge type">${esc(t)}</span>`).join(" ");
    return `<article class="card notice ${isNew(DATA, n) ? "is-new" : ""}">
      <div class="row1"><span>${n.fav ? "⭐ " : ""}<span class="badge type">${esc(n.source)}</span> ${isNew(DATA, n) ? '<span class="badge new">NEW</span>' : ""}</span>
        <span class="meta">${esc(n.date)}</span></div>
      <a class="title" target="_blank" rel="noopener" href="${esc(n.url)}">${esc(n.title)}</a>
      <div class="meta">${tags}${n.deadline ? ` · <b>${n.source === "청년안심주택" ? "청약신청" : "마감"} ${esc(n.deadline)}</b>` : ""}${n.org ? " · " + esc(n.org) : ""}</div>
    </article>`;
  }

  function guideHtml(p) {
    const filled = p.age !== "" && p.income !== "";
    return `<div class="yt-guide">
      <h3>🧑 내 조건으로 자가진단 <span class="meta">(1인 가구 기준 · 대략 판정)</span></h3>
      <div class="fin-grid">
        <label class="fin-f"><span>만 나이</span><span class="fin-in"><input id="y-age" type="number" value="${esc(p.age)}"><em>세</em></span></label>
        <label class="fin-f"><span>월 소득 (세전)</span><span class="fin-in"><input id="y-inc" type="number" value="${esc(p.income)}"><em>만원</em></span></label>
        <label class="fin-f"><span>총자산 (예금·전세보증금 등)</span><span class="fin-in"><input id="y-asset" type="number" value="${esc(p.asset)}"><em>만원</em></span></label>
        <label class="fin-f"><span>자동차 가액</span><span class="fin-in"><input id="y-car" type="number" value="${esc(p.car)}"><em>만원</em></span></label>
        <label class="fin-f"><span>미혼</span><span class="fin-in"><input id="y-single" type="checkbox" ${p.single ? "checked" : ""}><em>해당</em></span></label>
        <label class="fin-f"><span>무주택</span><span class="fin-in"><input id="y-nohome" type="checkbox" ${p.noHome ? "checked" : ""}><em>해당</em></span></label>
      </div>
      <p class="meta">입력값은 이 기기에만 저장돼요. 2026년 1인 가구 도시근로자 월평균소득(100%)은 약 ${Math.round(BASE_1P / 10000)}만원이에요.</p>
      <div class="yt-progs">${PROGRAMS.map(pr => {
        const r = filled ? pr.check({ ...p, age: +p.age, income: (+p.income || 0) * 10000, asset: +p.asset || 0, car: +p.car || 0 }) : null;
        return `<div class="yt-prog">
          <div class="fin-prod-h"><b>${esc(pr.name)}</b>${r ? `<span class="fin-tag ${r.c === "ok" ? "ok" : r.c === "warn" ? "warn" : "no"}">${r.icon} ${esc(r.t)}</span>` : ""}</div>
          <div class="meta">${esc(pr.who)} · ${esc(pr.rent)} · ${esc(pr.stay)}</div>
          <ul>${pr.req.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <a target="_blank" rel="noopener" href="${pr.link}">공식 사이트 ›</a>
        </div>`;
      }).join("")}</div>
      <p class="fin-note">요건은 ${CHECKED} 기준 공개 자료를 정리한 대략적인 값이에요. 공고마다 소득·자산 기준, 우선순위, 거주지 요건이 달라요.
        지원 전에 <b>해당 모집공고문</b>과 <a href="https://www.myhome.go.kr" target="_blank" rel="noopener">마이홈포털 자가진단</a>으로 꼭 확인하세요.</p>
    </div>`;
  }

  window.renderYouth = function (DATA, listEl, summaryEl) {
    const all = (DATA.notices || []).filter(n => n.youth && n.wanted);
    const state = window.__ytState || (window.__ytState = { past: false, fav: false });
    let items = all.filter(n => state.past || isUpcoming(n)).filter(n => !state.fav || n.fav);
    items.sort((a, b) => (+!!b.fav - +!!a.fav) || (b.date || "").localeCompare(a.date || ""));
    summaryEl.textContent = `청년 대상 모집공고 ${items.length}건 (청년안심주택·행복주택·LH/SH) · ⭐ = 관심 구`;
    const p = loadP();
    listEl.innerHTML = `<div class="yt-wrap">
      <div class="filters">
        <label class="toggle"><input type="checkbox" id="y-fav" ${state.fav ? "checked" : ""}> ⭐ 관심 구만</label>
        <label class="toggle"><input type="checkbox" id="y-past" ${state.past ? "checked" : ""}> 신청일 지난 공고도</label>
      </div>
      <div class="grid">${items.length ? items.map(n => noticeCard(DATA, n)).join("") : `<div class="empty">조건에 맞는 공고가 없어요.</div>`}</div>
      ${guideHtml(p)}
    </div>`;
    listEl.querySelector("#y-fav").onchange = e => { state.fav = e.target.checked; window.renderYouth(DATA, listEl, summaryEl); };
    listEl.querySelector("#y-past").onchange = e => { state.past = e.target.checked; window.renderYouth(DATA, listEl, summaryEl); };
    const upd = () => {
      const q = { age: listEl.querySelector("#y-age").value, income: listEl.querySelector("#y-inc").value,
        asset: listEl.querySelector("#y-asset").value, car: listEl.querySelector("#y-car").value,
        single: listEl.querySelector("#y-single").checked, noHome: listEl.querySelector("#y-nohome").checked };
      saveP(q);
      const g = listEl.querySelector(".yt-guide");
      const scrollY = window.scrollY;
      g.outerHTML = guideHtml(q);
      window.scrollTo(0, scrollY);
      bind();
    };
    function bind() {
      ["#y-age", "#y-inc", "#y-asset", "#y-car", "#y-single", "#y-nohome"].forEach(s => listEl.querySelector(s).addEventListener("change", upd));
    }
    bind();
  };
  window.youthCount = DATA => (DATA.notices || []).filter(n => n.youth && n.wanted && isUpcoming(n)).length;
})();
