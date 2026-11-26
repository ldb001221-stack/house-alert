// 🔨 경매·공매 탭: 온비드 공매 물건(관심 구 주거용) + 법원경매·공매 초보 가이드
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function money(v) {
    v = Math.round(+v || 0); const eok = Math.floor(v / 10000), man = v % 10000;
    if (eok && man) return `${eok}억 ${man.toLocaleString()}`;
    if (eok) return `${eok}억`;
    return `${man.toLocaleString()}만`;
  }
  const dt = s => { s = String(s || "").replace(/\D/g, ""); return s.length >= 8 ? `${+s.slice(4, 6)}/${+s.slice(6, 8)}${s.length >= 12 ? " " + s.slice(8, 10) + ":" + s.slice(10, 12) : ""}` : ""; };

  function card(DATA, a) {
    const isNew = a.first_seen === DATA.today;
    const low = a.low ? money(a.low) : (a.low_text || "비공개");
    const q = encodeURIComponent(a.name);
    const tags = [a.use, a.kind, a.status].filter(Boolean).map(t => `<span class="badge type">${esc(t)}</span>`).join(" ");
    const warn = [a.share && "지분 물건", a.fails >= 2 && `유찰 ${a.fails}회`, a.private_contract && "수의계약 가능"].filter(Boolean);
    return `<article class="card ${isNew ? "is-new" : ""}">
      <div class="row1"><span class="price">${esc(low)}</span>${isNew ? '<span class="badge new">NEW</span>' : ""}</div>
      <div class="meta">${a.appraisal ? `감정가 ${money(a.appraisal)}` : ""}${a.low_ratio ? ` · 감정가의 <b>${Math.round(a.low_ratio)}%</b>` : ""}</div>
      <div class="name">${esc(a.name)}</div>
      <div class="meta">${tags}</div>
      <div class="meta">${a.pyeong ? `${a.pyeong}평 (${a.area}㎡) · ` : ""}입찰 ${esc(dt(a.bid_start))} ~ <b>${esc(dt(a.bid_end))}</b></div>
      ${warn.length ? `<div class="odd-note">⚠️ ${esc(warn.join(" · "))}<span class="meta">유찰이 많거나 지분 물건이면 권리관계를 특히 꼼꼼히 확인하세요</span></div>` : ""}
      ${a.handover ? `<div class="meta">인도 책임: ${esc(a.handover)}</div>` : ""}
      <div class="meta">온비드 물건번호 <b>${esc(a.onbid_no)}</b> · ${esc(a.org)}</div>
      <div class="links">
        <a class="strong" target="_blank" rel="noopener" href="https://www.onbid.co.kr">온비드에서 물건번호 검색</a>
        <a target="_blank" rel="noopener" href="https://map.naver.com/p/search/${q}">네이버지도</a>
      </div>
    </article>`;
  }

  const GUIDE = `<div class="yt-guide">
    <h3>🔨 경매·공매 처음이라면</h3>
    <table class="fin-t">
      <tr><th></th><td><b>법원 경매</b></td><td><b>공매 (온비드)</b></td></tr>
      <tr><th>파는 곳</th><td>법원 (빚 못 갚은 집을 채권자가 신청)</td><td>한국자산관리공사 (세금 체납 압류재산, 국유재산 등)</td></tr>
      <tr><th>입찰 방법</th><td>정해진 날 법원에 직접 가서 입찰</td><td>온비드 사이트에서 인터넷 입찰</td></tr>
      <tr><th>입찰보증금</th><td>최저매각가격의 10% (재매각은 20%)</td><td>입찰가의 10%</td></tr>
      <tr><th>유찰 시</th><td>다음 회차 최저가가 보통 20~30% 낮아짐</td><td>보통 회차마다 10%씩 낮아짐</td></tr>
      <tr><th>점유자 내보내기(명도)</th><td>인도명령 제도로 비교적 수월</td><td>인도명령 없음 → 협의·명도소송 필요할 수 있음</td></tr>
    </table>
    <div class="group-label">입찰 전 꼭 확인할 것</div>
    <ul class="yt-check">
      <li><b>권리분석:</b> 등기부등본에서 '말소기준권리'(가장 먼저 설정된 근저당·압류 등)를 찾고, 그보다 앞선 권리는 낙찰자가 떠안을 수 있어요.</li>
      <li><b>선순위 임차인:</b> 말소기준권리보다 먼저 전입한 세입자가 배당을 다 못 받으면 <b>남은 보증금을 낙찰자가 물어줘야</b> 해요. 매각물건명세서·전입세대열람으로 확인하세요.</li>
      <li><b>서류 3종:</b> 매각물건명세서 · 현황조사서 · 감정평가서 (법원경매정보에서 무료 열람)</li>
      <li><b>위험 신호:</b> 지분 물건, 대지권 미등기, 토지별도등기, 위반건축물, 유치권 신고, 유찰이 유독 많은 물건</li>
      <li><b>자금:</b> 낙찰 후 보통 약 1개월 안에 잔금을 내야 해요. 경락잔금대출도 일반 주담대처럼 LTV·DSR 규제를 받으니 <b>💰 대출 계산</b>으로 미리 확인하세요. 취득세는 일반 매매와 같아요.</li>
      <li><b>현장 확인:</b> 실제 상태, 관리비 체납, 점유자 여부는 직접 가서 보는 게 가장 확실해요.</li>
    </ul>
    <div class="links">
      <a class="strong" target="_blank" rel="noopener" href="https://www.courtauction.go.kr">법원경매정보 (관악·동작·서초·영등포 검색)</a>
      <a target="_blank" rel="noopener" href="https://www.onbid.co.kr">온비드 (공매)</a>
      <a target="_blank" rel="noopener" href="https://www.iros.go.kr">인터넷등기소 (등기부등본)</a>
      <a target="_blank" rel="noopener" href="https://www.gov.kr">정부24 (건축물대장)</a>
    </div>
    <p class="fin-note">경매는 일반 매매보다 싸게 살 수 있지만 권리관계 위험이 있어요. 처음이라면 입찰 전에 법무사나 경매 전문가 상담을 권해요.
      법원 경매는 공식 API가 없어서 자동 수집 대신 위 링크로 직접 검색하도록 했어요.</p>
  </div>`;

  window.renderAuction = function (DATA, listEl, summaryEl) {
    const st = (DATA.status || {})["공매(온비드)"];
    const items = DATA.auctions || [];
    let top = "";
    if (st && !st.ok) {
      top = `<div class="demo">공매 물건을 가져오지 못했어요: ${esc((st.errors || [])[0] || "")}<br>
        공공데이터포털에서 <a target="_blank" rel="noopener" href="https://www.data.go.kr/data/15157207/openapi.do">한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스</a>를
        활용신청하면 다음 날부터 자동으로 채워져요 (기존 인증키 그대로 사용).</div>`;
    }
    summaryEl.textContent = st && st.ok ? `공매 진행·예정 주거용 물건 ${items.length}건 (관심 구, 최저입찰가 조건 이내)` : "";
    listEl.innerHTML = `<div class="yt-wrap">${top}
      <div class="grid">${items.length ? items.map(a => card(DATA, a)).join("") : (st && st.ok ? `<div class="empty">지금 조건에 맞는 공매 물건이 없어요.</div>` : "")}</div>
      ${GUIDE}</div>`;
  };
  window.auctionCount = DATA => (DATA.auctions || []).length;
})();
