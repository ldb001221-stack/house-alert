// 🗺️ 지도 탭: 실거래 위치 마커 + 출근지까지 카카오맵 대중교통 길찾기 (정확한 좌표로 연결)
(function () {
  const DESTS = [
    { key: "yongsan", label: "신용산", place: "아모레퍼시픽", lat: 37.52896, lng: 126.96838 },
    { key: "gangnam", label: "강남", place: "강남역", lat: 37.49795, lng: 127.02758 },
    { key: "yeouido", label: "여의도", place: "63빌딩", lat: 37.51987, lng: 126.94030 },
  ];
  const STATIONS = [
    { name: "사당역", lat: 37.47653, lng: 126.98163 },
    { name: "낙성대역", lat: 37.47693, lng: 126.96367 },
    { name: "서울대입구역", lat: 37.48122, lng: 126.95270 },
    { name: "방배역", lat: 37.48150, lng: 126.99752 },
    { name: "총신대입구(이수)역", lat: 37.48659, lng: 126.98184 },
    { name: "봉천역", lat: 37.48249, lng: 126.94180 },
    { name: "당산역", lat: 37.53438, lng: 126.90254 },
    { name: "영등포구청역", lat: 37.52569, lng: 126.89628 },
    { name: "선유도역", lat: 37.53790, lng: 126.89350 },
  ];
  const KIND_LABEL = { sale: "매매", jeonse: "전세", wolse: "월세" };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function load(k) { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch (e) { return {}; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  const GEO_KEY = "ha-geo-v2";
  const geoCache = load(GEO_KEY);

  let map, clusterer, geocoder, places, homeMarker = null, walkLine = null, sdkPromise = null;
  let state = { kind: "sale", htype: "" };
  Object.assign(state, load("ha-map-state"));

  function shortPrice(r) {
    const eok = v => (v / 10000).toFixed(v % 10000 ? 1 : 0).replace(/\.0$/, "") + "억";
    if (r.kind === "sale") return eok(r.price);
    if (r.kind === "jeonse") return "전 " + (r.deposit >= 10000 ? eok(r.deposit) : r.deposit.toLocaleString());
    return `${r.deposit.toLocaleString()}/${r.rent}`;
  }
  // "서울대입구·낙성대 (관악구)" → 괄호 안의 구 이름만 사용
  function guOf(r) { const m = /\((\S+구)/.exec(r.region || ""); return m ? m[1] : ""; }
  function addrOf(r) { return `서울 ${guOf(r)} ${r.dong} ${r.jibun || ""}`.replace(/\s+/g, " ").trim(); }

  function distM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // 직선거리에 골목길 보정(×1.3), 걷는 속도 분당 70m
  const walkMin = m => Math.max(1, Math.round(m * 1.3 / 70));

  function routeUrl(fromName, lat, lng, d) {
    const n = s => encodeURIComponent(String(s).replace(/,/g, " "));
    return `https://map.kakao.com/link/by/traffic/${n(fromName)},${lat},${lng}/${n(d.place)},${d.lat},${d.lng}`;
  }

  function loadSdk(key) {
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services,clusterer&autoload=false`;
      s.onload = () => (window.kakao && kakao.maps ? kakao.maps.load(resolve) : reject(new Error("sdk")));
      s.onerror = () => { sdkPromise = null; reject(new Error("sdk")); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  function geocode(r) {
    const addr = addrOf(r) + "|" + r.name;
    if (addr in geoCache) return Promise.resolve(geoCache[addr]);
    return new Promise(resolve => {
      const done = v => { geoCache[addr] = v; resolve(v); };
      const byKeyword = () => places.keywordSearch(`${r.dong} ${r.name}`, (res, st) => {
        done(st === kakao.maps.services.Status.OK ? [+res[0].y, +res[0].x] : 0);
      }, { location: new kakao.maps.LatLng(37.49, 126.96), radius: 20000 });
      if (!r.jibun) return byKeyword();
      geocoder.addressSearch(addrOf(r), (res, st) => {
        if (st === kakao.maps.services.Status.OK) done([+res[0].y, +res[0].x]);
        else byKeyword();
      });
    });
  }

  async function pool(items, n, fn, onStep) {
    let i = 0, finished = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) { const it = items[i++]; await fn(it); onStep(++finished); }
    }));
  }

  function showDetail(g) {
    const box = document.getElementById("map-detail");
    const r0 = g.items[0];
    const here = { lat: g.lat, lng: g.lng };
    const near = STATIONS.map(s => ({ ...s, m: distM(here, s) })).sort((a, b) => a.m - b.m)[0];
    const q = encodeURIComponent(`${r0.dong} ${r0.name}`);
    box.innerHTML = `
      <div class="row1"><span class="price">${esc(r0.name)}</span><span class="badge type">${esc(r0.htype)}</span></div>
      <div class="meta">${esc(addrOf(r0))} · ${r0.built || "?"}년식</div>
      <div class="meta">🚶 가장 가까운 역: <b>${esc(near.name)}</b> 도보 약 ${walkMin(near.m)}분 (${Math.round(near.m)}m)</div>
      <div class="hm-deals">${g.items.slice(0, 6).map((r, i) => `<div><b>${esc(KIND_LABEL[r.kind])} ${esc(shortPrice(r))}</b>
        ${r.odd ? `<span class="meta warn">⚠️ ${esc(r.flags.join("·"))}</span>` : ""}
        <span class="meta">${r.pyeong}평 · ${r.floor}층 · ${esc(r.date)}</span>
        <button type="button" class="fin-link" data-fin-i="${i}">💰 대출 계산</button>
        ${window.HAFin ? HAFin.summary(r) : ""}</div>`).join("")}
        ${g.items.length > 6 ? `<div class="meta">…외 ${g.items.length - 6}건</div>` : ""}</div>
      <div class="group-label">출근 경로 보기 (카카오맵 대중교통 길찾기, 이 집 위치에서 출발)</div>
      <div class="hm-commute">${DESTS.map(d => `<a class="hm-c" target="_blank" rel="noopener" href="${routeUrl(r0.name, g.lat, g.lng, d)}">
        <span class="hm-c-l">→ ${esc(d.label)}</span><span class="meta">${esc(d.place)}까지 · 시간·환승 보기 ›</span></a>`).join("")}</div>
      <div class="links">
        <a class="strong" target="_blank" rel="noopener" href="https://search.naver.com/search.naver?query=${encodeURIComponent(r0.name + " 매물")}">이 단지 매물 보기</a>
        <a target="_blank" rel="noopener" href="https://map.naver.com/p/search/${q}">네이버지도</a>
        <a target="_blank" rel="noopener" href="https://map.kakao.com/link/roadview/${g.lat},${g.lng}">로드뷰</a>
      </div>`;
    box.hidden = false;
    box.querySelectorAll("[data-fin-i]").forEach(b => b.onclick = () => HAFin.openDetail(g.items[+b.dataset.finI]));
    if (homeMarker) homeMarker.setMap(null);
    if (walkLine) walkLine.setMap(null);
    const home = new kakao.maps.LatLng(g.lat, g.lng);
    homeMarker = new kakao.maps.Marker({ map, position: home });
    walkLine = new kakao.maps.Polyline({ map, path: [home, new kakao.maps.LatLng(near.lat, near.lng)],
      strokeWeight: 4, strokeColor: "#2f5d50", strokeOpacity: .9, strokeStyle: "shortdash" });
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function groups(DATA) {
    const kinds = state.kind ? [state.kind] : ["sale", "jeonse", "wolse"];
    const showOdd = window.HA_SHOW_ODD ? window.HA_SHOW_ODD() : false;
    const items = kinds.flatMap(k => DATA[k] || [])
      .filter(r => !state.htype || r.htype === state.htype)
      .filter(r => showOdd || !r.odd);
    const by = {};
    items.forEach(r => { const a = addrOf(r) + "|" + r.name; (by[a] = by[a] || { items: [] }).items.push(r); });
    Object.values(by).forEach(g => g.items.sort((a, b) => b.date.localeCompare(a.date)));
    return Object.values(by);
  }

  async function plot(DATA) {
    const status = document.getElementById("map-status");
    clusterer.clear();
    const gs = groups(DATA);
    status.textContent = `위치 찾는 중… 0/${gs.length}`;
    await pool(gs, 6, async g => {
      const ll = await geocode(g.items[0]);
      if (ll) { g.lat = ll[0]; g.lng = ll[1]; }
    }, n => { status.textContent = `위치 찾는 중… ${n}/${gs.length}`; });
    save(GEO_KEY, geoCache);
    const ok = gs.filter(g => g.lat);
    clusterer.addMarkers(ok.map(g => {
      const r = g.items[0];
      const el = document.createElement("div");
      el.className = `hm-pin k-${r.kind}`;
      el.textContent = shortPrice(r) + (g.items.length > 1 ? ` +${g.items.length - 1}` : "");
      el.onclick = () => showDetail(g);
      return new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(g.lat, g.lng), content: el, yAnchor: 1 });
    }));
    status.textContent = `${ok.length}곳 표시${gs.length - ok.length ? ` (위치 못 찾음 ${gs.length - ok.length})` : ""} · 가격표를 누르면 출근 경로를 볼 수 있어요`;
  }

  window.renderMap = async function (DATA, listEl, summaryEl) {
    summaryEl.textContent = "";
    const K = window.HA_KEYS || {};
    if (!K.kakao) {
      listEl.innerHTML = `<div class="empty" style="grid-column:1/-1">지도 키가 아직 설정되지 않았어요.</div>`;
      return;
    }
    const types = [...new Set(["sale", "jeonse", "wolse"].flatMap(k => (DATA[k] || []).map(r => r.htype)))];
    listEl.innerHTML = `<div class="hm-wrap">
      <div class="filters">
        <select id="m-kind"><option value="sale">매매</option><option value="jeonse">전세</option><option value="wolse">월세</option><option value="">전체</option></select>
        <select id="m-type"><option value="">전체 유형</option>${types.map(t => `<option>${esc(t)}</option>`).join("")}</select>
        <label class="toggle"><input type="checkbox" id="m-odd"> ⚠️ 이상 거래 보기</label>
      </div>
      <p class="summary" id="map-status">지도 불러오는 중…</p>
      <div id="hmap"></div>
      <div id="map-detail" class="card" hidden></div>
    </div>`;
    document.getElementById("m-kind").value = state.kind;
    document.getElementById("m-type").value = state.htype;
    try { await loadSdk(K.kakao); }
    catch (e) { document.getElementById("map-status").textContent = "지도를 불러오지 못했어요 (카카오 키·도메인 설정을 확인해주세요)"; return; }
    map = new kakao.maps.Map(document.getElementById("hmap"), { center: new kakao.maps.LatLng(37.495, 126.955), level: 7 });
    map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);    clusterer = new kakao.maps.MarkerClusterer({ map, averageCenter: true, minLevel: 6, gridSize: 50,
      styles: [{ width: "40px", height: "40px", background: "rgba(47,93,80,.85)", color: "#fff", borderRadius: "20px",
        textAlign: "center", lineHeight: "40px", fontWeight: "700", fontSize: "13px" }] });
    geocoder = new kakao.maps.services.Geocoder();
    places = new kakao.maps.services.Places();
    DESTS.forEach(d => new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(d.lat, d.lng),
      content: `<div class="hm-dest">🏢 ${esc(d.label)}</div>`, yAnchor: 1.1 }));
    const onChange = () => {
      state.kind = document.getElementById("m-kind").value;
      state.htype = document.getElementById("m-type").value;
      save("ha-map-state", state);
      document.getElementById("map-detail").hidden = true;
      if (homeMarker) homeMarker.setMap(null);
      if (walkLine) walkLine.setMap(null);
      plot(DATA);
    };
    document.getElementById("m-kind").onchange = onChange;
    document.getElementById("m-type").onchange = onChange;
    const mOdd = document.getElementById("m-odd"), fOdd = document.getElementById("f-odd");
    if (fOdd) mOdd.checked = fOdd.checked;
    mOdd.onchange = () => {
      if (fOdd) { fOdd.checked = mOdd.checked; try { localStorage.setItem("ha-odd", mOdd.checked ? "1" : "0"); } catch (e) {} }
      onChange();
    };
    plot(DATA);
  };
})();
