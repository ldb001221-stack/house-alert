"""
집 알림 (house-alert)
 - 국토교통부 실거래가 (매매 / 전세 / 월세 : 아파트·오피스텔·빌라)
 - LH 임대·분양 공고 (공공데이터포털 API)
 - SH 공고 게시판
조건에 맞는 새 항목을 텔레그램으로 보내고, docs/data.json 을 만들어 웹사이트에 보여줍니다.

사용법
  python house_alert.py                 # 실제 실행 (수집 + 텔레그램 + 웹 데이터)
  python house_alert.py --no-telegram   # 텔레그램 없이 수집만
  python house_alert.py --demo          # 예시 데이터로 웹사이트 미리보기
  python house_alert.py --find-chat-id  # 텔레그램 chat id 찾기
  python house_alert.py --telegram-test # 텔레그램 테스트 메시지 보내기
"""
from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.toml"
SECRETS_PATH = ROOT / "secrets.local.toml"
SEEN_PATH = ROOT / "data" / "seen.json"
SITE_DATA_PATH = ROOT / "docs" / "data.json"

KST = dt.timezone(dt.timedelta(hours=9))
UA = "house-alert/1.0 (personal use)"

MOLIT = "https://apis.data.go.kr/1613000"
# (주택종류, 거래종류) -> (서비스 경로, 이름 필드 후보)
MOLIT_APIS = {
    ("아파트", "trade"): ("RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade", ["aptNm"]),
    ("아파트", "rent"): ("RTMSDataSvcAptRent/getRTMSDataSvcAptRent", ["aptNm"]),
    ("오피스텔", "trade"): ("RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade", ["offiNm"]),
    ("오피스텔", "rent"): ("RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent", ["offiNm"]),
    ("빌라", "trade"): ("RTMSDataSvcRHTrade2/getRTMSDataSvcRHTrade2", ["mhouseNm"]),  # 2026-10 주소 변경
    ("빌라", "rent"): ("RTMSDataSvcRHRent/getRTMSDataSvcRHRent", ["mhouseNm"]),
}
LH_URL = "https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1"
LH_LIST_URL = "https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026"
SH_BASE = "https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/"


# --------------------------------------------------------------------------
# 설정 / 비밀값
# --------------------------------------------------------------------------
def load_config() -> dict:
    with open(CONFIG_PATH, "rb") as f:
        return tomllib.load(f)


def load_secrets() -> dict:
    s = {}
    if SECRETS_PATH.exists():
        with open(SECRETS_PATH, "rb") as f:
            s.update({k.upper(): str(v) for k, v in tomllib.load(f).items()})
    for k in ("DATA_GO_KR_KEY", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "SITE_URL"):
        if os.environ.get(k):
            s[k] = os.environ[k].strip()
    if "SITE_URL" not in s and os.environ.get("GITHUB_REPOSITORY"):
        owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
        s["SITE_URL"] = f"https://{owner.lower()}.github.io/{repo}/"
    return s


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def http_get(url: str, params: dict | None = None, timeout: int = 30) -> str:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return r.read().decode(charset, "replace")
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:   # 권한·요청 오류는 다시 해도 같아서 바로 알려요
                raise RuntimeError(f"HTTP {e.code} (권한 없음 또는 잘못된 요청)")
            last = e
            time.sleep(2 + attempt * 3)
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"접속 실패: {last}")


# --------------------------------------------------------------------------
# 국토교통부 실거래가
# --------------------------------------------------------------------------
def _num(v, default=None):
    if v is None:
        return default
    s = str(v).replace(",", "").strip()
    if s == "":
        return default
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return default


def _txt(item: ET.Element, *names: str) -> str:
    for n in names:
        el = item.find(n)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def molit_fetch(key: str, path: str, lawd: str, ym: str) -> list[ET.Element]:
    items: list[ET.Element] = []
    page = 1
    while True:
        text = http_get(f"{MOLIT}/{path}", {
            "serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ym,
            "pageNo": page, "numOfRows": 1000,
        })
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            raise RuntimeError(f"응답 해석 실패: {text[:200]}")
        code = _txt(root, "header/resultCode", "cmmMsgHeader/returnReasonCode")
        if code not in ("000", "00", ""):
            msg = _txt(root, "header/resultMsg", "cmmMsgHeader/returnAuthMsg", "cmmMsgHeader/errMsg")
            raise RuntimeError(f"API 오류 {code}: {msg}")
        page_items = root.findall("body/items/item")
        items.extend(page_items)
        total = _num(_txt(root, "body/totalCount"), 0) or 0
        if page * 1000 >= total or not page_items:
            break
        page += 1
        time.sleep(0.3)
    return items


def recent_months(n: int) -> list[str]:
    today = dt.datetime.now(KST).date()
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append(f"{y}{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def to_record(item: ET.Element, htype: str, deal: str, name_fields: list[str], region: dict) -> dict | None:
    dong = _txt(item, "umdNm")
    if not any(dong.startswith(d) for d in region["dongs"]):
        return None
    if _txt(item, "cdealType") == "O":  # 계약 해제된 거래
        return None
    area = _num(_txt(item, "excluUseAr", "totalFloorAr"), 0.0) or 0.0
    floor = _num(_txt(item, "floor"))
    y, mo, d = _txt(item, "dealYear"), _txt(item, "dealMonth"), _txt(item, "dealDay")
    rec = {
        "htype": htype,
        "region": region["name"],
        "dong": dong,
        "name": _txt(item, *name_fields) or "(이름 없음)",
        "jibun": _txt(item, "jibun"),
        "area": round(float(area), 2),
        "pyeong": round(float(area) / 3.3058, 1),
        "floor": floor,
        "built": _num(_txt(item, "buildYear")),
        "date": f"{y}-{int(mo):02d}-{int(d):02d}" if y and mo and d else "",
    }
    if deal == "trade":
        rec["kind"] = "sale"
        rec["price"] = _num(_txt(item, "dealAmount"), 0)
        rec["dealing"] = _txt(item, "dealingGbn")              # 중개거래 / 직거래
        rec["land_lease"] = _txt(item, "landLeaseholdGbn") == "Y"  # 토지임대부 (건물만 분양)
    else:
        rec["deposit"] = _num(_txt(item, "deposit"), 0)
        rec["rent"] = _num(_txt(item, "monthlyRent"), 0)
        rec["kind"] = "jeonse" if not rec["rent"] else "wolse"
        rec["contract"] = _txt(item, "contractType")  # 신규/갱신
    val = rec.get("price", f"{rec.get('deposit')}/{rec.get('rent')}")
    rec["id"] = "|".join(str(x) for x in (
        rec["kind"], htype, region["code"], dong, rec["jibun"], rec["name"],
        rec["area"], floor, rec["date"], val))
    return rec


def passes(rec: dict, cfg: dict) -> bool:
    c = cfg["common"]
    if rec["area"] < c["min_area_m2"]:
        return False
    if rec["floor"] is None or rec["floor"] < c["min_floor"]:
        return False
    k = rec["kind"]
    if k == "sale":
        s = cfg["sale"]
        return s["enabled"] and s["min_price"] <= rec["price"] <= s["max_price"]
    if k == "jeonse":
        s = cfg["jeonse"]
        return s["enabled"] and rec["deposit"] <= s["max_deposit"]
    s = cfg["wolse"]
    return s["enabled"] and rec["deposit"] <= s["max_deposit"] and rec["rent"] <= s["max_rent"]


# 같은 지역·유형 평당가 중간값 대비 이 비율 미만이면 '시세 대비 낮음'.
# 월세는 보증금·월세 조합이 제각각이라 비교가 부정확해서 판정하지 않아요.
ODD_RATIO = {"sale": 0.6, "jeonse": 0.5}
ODD_RATIO_DIRECT = 0.85  # 직거래는 85% 미만이면 이상 거래 (가족·지인 간 저가 거래 의심)
MIN_GROUP = 5            # 비교 대상이 이보다 적으면 판단하지 않음
RENT_TO_DEPOSIT = 200    # 월세 1만원 ≈ 보증금 200만원 (전월세 전환율 약 6% 가정)


def deal_value(r: dict) -> float:
    if r["kind"] == "sale":
        return r["price"]
    return r["deposit"] + (r.get("rent") or 0) * RENT_TO_DEPOSIT


def flag_odd(deals: list[dict]) -> None:
    """직거래·토지임대부·시세 대비 지나치게 싼 거래에 표시를 붙여요.
    직거래는 신축 빌라 분양처럼 정상 거래도 많아서, 시세보다 확실히 쌀 때만 이상 거래로 봐요."""
    import statistics
    groups: dict = {}
    for r in deals:
        r.pop("ratio", None)
        r["flags"], r["odd"] = [], False
        if r["pyeong"]:
            groups.setdefault((r["kind"], r["htype"], r["region"]), []).append(r)
    for rs in groups.values():
        base = [deal_value(r) / r["pyeong"] for r in rs if r.get("dealing") != "직거래" and not r.get("land_lease")]
        med = statistics.median(base) if len(base) >= MIN_GROUP else None
        for r in rs:
            ratio = deal_value(r) / r["pyeong"] / med if med else None
            if ratio is not None and r["kind"] in ODD_RATIO:
                r["ratio"] = round(ratio, 2)
            direct = r.get("dealing") == "직거래"
            if direct:
                r["flags"].append("직거래")
            if r.get("land_lease"):
                r["flags"].append("토지임대부")
                r["odd"] = True
            limit = ODD_RATIO.get(r["kind"])
            if ratio is not None and limit and ratio < limit:
                r["flags"].append("시세 대비 낮음")
                r["odd"] = True
            elif direct and ratio is not None and ratio < ODD_RATIO_DIRECT:
                r["flags"].append("시세보다 싼 직거래")
                r["odd"] = True


def collect_deals(cfg: dict, key: str, status: dict) -> list[dict]:
    want_trade = cfg["sale"]["enabled"]
    want_rent = cfg["jeonse"]["enabled"] or cfg["wolse"]["enabled"]
    months = recent_months(cfg["common"]["months_back"])
    out: dict[str, dict] = {}
    errors = []
    calls = 0
    for (htype, deal), (path, name_fields) in MOLIT_APIS.items():
        if htype not in cfg["common"]["house_types"]:
            continue
        if (deal == "trade" and not want_trade) or (deal == "rent" and not want_rent):
            continue
        for region in cfg["regions"]:
            for ym in months:
                try:
                    items = molit_fetch(key, path, region["code"], ym)
                    calls += 1
                except Exception as e:
                    errors.append(f"{htype} {'매매' if deal == 'trade' else '전월세'} {region['name']} {ym}: {e}")
                    continue
                for it in items:
                    rec = to_record(it, htype, deal, name_fields, region)
                    if rec and passes(rec, cfg):
                        out[rec["id"]] = rec
                time.sleep(0.2)
    status["실거래가"] = {"ok": not errors, "calls": calls, "errors": errors[:10],
                       "error_count": len(errors)}
    return list(out.values())


# --------------------------------------------------------------------------
# LH / SH 공고
# --------------------------------------------------------------------------
def _walk(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def collect_lh(key: str) -> list[dict]:
    today = dt.datetime.now(KST).date()
    start = today - dt.timedelta(days=60)
    rows = []
    for fmt in ("%Y.%m.%d", "%Y%m%d"):
        text = http_get(LH_URL, {
            "serviceKey": key, "PG_SZ": 100, "PAGE": 1, "CNP_CD": 11,
            "PAN_ST_DT": start.strftime(fmt), "PAN_ED_DT": today.strftime(fmt),
        })
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise RuntimeError(f"응답 해석 실패: {text[:200]}")
        rows = [d for d in _walk(data) if "PAN_NM" in d]
        if rows:
            break
    out = []
    for r in rows:
        title = r.get("PAN_NM", "").strip()
        kind = r.get("AIS_TP_CD_NM") or r.get("UPP_AIS_TP_NM") or ""
        if any(w in title + kind for w in ("토지", "상가", "용지", "공장")):
            continue
        out.append({
            "id": f"LH|{r.get('PAN_ID') or title}",
            "source": "LH",
            "title": title,
            "category": kind,
            "status": r.get("PAN_SS", ""),
            "date": (r.get("PAN_NT_ST_DT") or r.get("PAN_DT") or "").replace(".", "-"),
            "deadline": (r.get("CLSG_DT") or "").replace(".", "-"),
            "region": r.get("CNP_CD_NM", ""),
            "url": r.get("DTL_URL") or LH_LIST_URL,
        })
    return out


def collect_sh() -> list[dict]:
    text = http_get(SH_BASE + "list.do")
    out = []
    for row in re.findall(r"<tr>(.*?)</tr>", text, re.S):
        m = re.search(r"getDetailView\('(\d+)'\)[^>]*>(.*?)</a>", row, re.S)
        if not m:
            continue
        seq = m.group(1)
        title = html.unescape(re.sub(r"<[^>]+>|\s+", " ", m.group(2))).strip()
        title = re.sub(r"^(NEW\s+)+", "", title).strip()   # 게시판이 붙이는 'NEW' 표시 제거
        date = re.search(r"(\d{4}-\d{2}-\d{2})", row)
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        dept = ""
        if len(tds) >= 3:
            dept = re.sub(r"<[^>]+>|\s+", " ", tds[2]).strip()
        out.append({
            "id": f"SH|{seq}",
            "source": "SH",
            "title": title,
            "category": dept,
            "status": "",
            "date": date.group(1) if date else "",
            "deadline": "",
            "region": "서울",
            "url": SH_BASE + "view.do?" + urllib.parse.urlencode({"seq": seq}),
        })
    return out


SOCO_LIST = "https://soco.seoul.go.kr/youth/pgm/home/yohome/bbsListJson.json"
SOCO_VIEW = "https://soco.seoul.go.kr/youth/bbs/BMSR00015/view.do"
SOCO_REFERER = "https://soco.seoul.go.kr/youth/bbs/BMSR00015/list.do?menuNo=400008"


def collect_soco(cfg: dict) -> list[dict]:
    """서울시 청년안심주택 모집공고 (서울주거포털 SOCO)."""
    yc = cfg.get("youth", {})
    pages = int(yc.get("soco_pages", 2))
    fav = set(yc.get("soco_fav_gu_codes", []))
    out = []

    def fetch(page: int, gu: str = "") -> list[dict]:
        body = urllib.parse.urlencode({"bbsId": "BMSR00015", "pageIndex": page, "searchAdresGu": gu,
                                       "searchCondition": "", "searchKeyword": "", "optn2": "", "optn5": ""}).encode()
        req = urllib.request.Request(SOCO_LIST, data=body, headers={"User-Agent": UA, "Referer": SOCO_REFERER})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8")).get("resultList", [])

    fav_ids = set()
    if fav:
        for x in fetch(1, ",".join(sorted(fav))):
            fav_ids.add(x.get("boardId"))
    for p in range(1, pages + 1):
        for x in fetch(p):
            bid = x.get("boardId")
            kind = {"1": "공공임대", "2": "민간임대"}.get(str(x.get("optn2")), "")
            rnd = {"1": "최초모집", "2": "추가모집"}.get(str(x.get("optn5")), "")
            out.append({
                "id": f"SOCO|{bid}",
                "source": "청년안심주택",
                "title": (x.get("nttSj") or "").strip(),
                "category": " · ".join(v for v in (kind, rnd) if v),
                "status": "",
                "date": x.get("optn1") or "",
                "deadline": x.get("optn4") or "",      # 청약신청일
                "org": x.get("optn3") or "",
                "region": "관심 구" if bid in fav_ids else "서울",
                "fav": bid in fav_ids,
                "url": f"{SOCO_VIEW}?{urllib.parse.urlencode({'boardId': bid, 'menuNo': 400008})}",
            })
        time.sleep(0.5)
    return out


# 청년 대상 공고 구분 (제목 키워드 → 프로그램)
YOUTH_PROGRAMS = [
    ("청년안심주택", ("청년안심주택", "역세권 청년", "역세권청년")),
    ("행복주택", ("행복주택",)),
    ("청년 매입임대", ("청년 매입임대", "청년매입임대", "청년 매입", "기숙사형")),
    ("청년 전세임대", ("청년 전세임대", "청년전세임대")),
]
YOUTH_WORDS = ("청년", "대학생", "사회초년생", "행복주택", "기숙사형")


def tag_youth(n: dict) -> None:
    t = n["title"]
    prog = ""
    if n["source"] == "청년안심주택":
        prog = "청년안심주택"
    else:
        for name, words in YOUTH_PROGRAMS:
            if any(w in t for w in words):
                prog = name
                break
    n["program"] = prog
    n["youth"] = bool(prog) or any(w in t for w in YOUTH_WORDS)


# --------------------------------------------------------------------------
# 온비드 공매 (한국자산관리공사, 공공데이터포털 API — 별도 활용신청 필요)
# --------------------------------------------------------------------------
ONBID_URL = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2"
ONBID_PRPT = "0002,0003,0004,0005,0006,0007,0008,0010,0011"   # 재산유형 전체
HOUSING_WORDS = ("주거", "아파트", "다세대", "연립", "오피스텔", "주택", "빌라", "다가구")


def _won_to_man(v) -> int | None:
    s = re.sub(r"[^\d]", "", str(v or ""))
    return int(s) // 10000 if s else None


def collect_onbid(cfg: dict, key: str) -> list[dict]:
    ac = cfg.get("auction", {})
    max_man = int(ac.get("max_price", 60000))
    out: dict[str, dict] = {}
    errors = []
    for gu in ac.get("gus", []):
        for pvct in ("N", "Y"):
            page = 1
            while page <= 5:
                params = {
                    "serviceKey": key, "pageNo": page, "numOfRows": 100, "resultType": "json",
                    "prptDivCd": ONBID_PRPT, "pvctTrgtYn": pvct, "dspsMthodCd": "0001",
                    "lctnSdnm": "서울특별시", "lctnSggnm": gu,
                }
                if not ac.get("include_share"):
                    params["alcYn"] = "N"
                text = http_get(ONBID_URL, params)
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    # 미승인 키 등은 XML 오류로 와요
                    msg = re.search(r"<(?:returnAuthMsg|resultMsg|errMsg)>(.*?)<", text)
                    raise RuntimeError(f"온비드 응답 오류: {msg.group(1) if msg else text[:150]}")
                body = data.get("response", data).get("body", {}) if isinstance(data, dict) else {}
                head = data.get("response", data).get("header", {}) if isinstance(data, dict) else {}
                if str(head.get("resultCode", "00")) not in ("00", "000", "0"):
                    raise RuntimeError(f"온비드 API 오류 {head.get('resultCode')}: {head.get('resultMsg')}")
                items = body.get("items") or []
                if isinstance(items, dict):
                    items = items.get("item") or []
                if isinstance(items, dict):
                    items = [items]
                for it in items:
                    names = " ".join(str(it.get(k) or "") for k in
                                     ("cltrUsgLclsCtgrNm", "cltrUsgMclsCtgrNm", "cltrUsgSclsCtgrNm", "onbidCltrNm"))
                    if not any(w in names for w in HOUSING_WORDS):
                        continue
                    low = _won_to_man(it.get("lowstBidPrcIndctCont"))
                    appr = _won_to_man(it.get("apslEvlAmt"))
                    if low is not None and low > max_man:
                        continue
                    bld = _num(it.get("bldSqms"), 0) or 0
                    rec = {
                        "id": f"ONBID|{it.get('cltrMngNo')}|{it.get('pbctCdtnNo')}",
                        "name": (it.get("onbidCltrNm") or "").strip(),
                        "gu": gu,
                        "dong": it.get("lctnEmdNm") or "",
                        "use": it.get("cltrUsgSclsCtgrNm") or it.get("cltrUsgMclsCtgrNm") or "",
                        "kind": it.get("prptDivNm") or "",
                        "status": it.get("pbctStatNm") or "",
                        "low": low, "low_text": it.get("lowstBidPrcIndctCont") or "",
                        "appraisal": appr,
                        "low_ratio": _num(it.get("apslPrcCtrsLowstBidRto")),
                        "fails": _num(it.get("usbdNft"), 0),
                        "bid_start": it.get("cltrBidBgngDt") or "",
                        "bid_end": it.get("cltrBidEndDt") or "",
                        "area": round(float(bld), 2), "pyeong": round(float(bld) / 3.3058, 1) if bld else 0,
                        "share": it.get("alcYn") == "Y",
                        "private_contract": it.get("pvctTrgtYn") == "Y",
                        "org": it.get("orgNm") or "",
                        "onbid_no": it.get("onbidCltrno") or "",
                        "img": it.get("thnlImgUrlAdr") or "",
                        "handover": it.get("evcRsbyTrgtCont") or "",
                    }
                    out[rec["id"]] = rec
                total = _num(body.get("totalCount"), 0) or 0
                if page * 100 >= total or not items:
                    break
                page += 1
                time.sleep(0.3)
    if errors:
        raise RuntimeError("; ".join(errors))
    return sorted(out.values(), key=lambda r: r["bid_end"] or "")


def notice_wanted(n: dict, cfg: dict) -> bool:
    c = cfg["notices"]
    t = n["title"]
    if any(w in t for w in c["exclude_keywords"]):
        return False
    return any(w in t for w in c["include_keywords"])


# --------------------------------------------------------------------------
# 텔레그램
# --------------------------------------------------------------------------
def tg_call(token: str, method: str, params: dict) -> dict:
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data,
                                 headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode() or "{}")


SILENT = False   # --silent: 소리 없이 알림 (밤에 수동 실행할 때)


def tg_send(secrets: dict, text: str) -> None:
    token, chat = secrets.get("TELEGRAM_TOKEN"), secrets.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("[텔레그램] 토큰/채팅 ID가 없어 건너뜀")
        return
    chunks, buf = [], ""
    for line in text.split("\n"):
        if len(buf) + len(line) + 1 > 3800:
            chunks.append(buf)
            buf = ""
        buf += line + "\n"
    if buf.strip():
        chunks.append(buf)
    for c in chunks:
        res = tg_call(token, "sendMessage", {"chat_id": chat, "text": c, "parse_mode": "HTML",
                                             "disable_web_page_preview": "true",
                                             "disable_notification": "true" if SILENT else "false"})
        if not res.get("ok"):
            print("[텔레그램] 전송 실패:", res.get("description"))
        time.sleep(0.5)


def money(v) -> str:
    v = int(v or 0)
    eok, man = divmod(v, 10000)
    if eok and man:
        return f"{eok}억 {man:,}"
    if eok:
        return f"{eok}억"
    return f"{man:,}"


def deal_line(r: dict) -> str:
    e = html.escape
    if r["kind"] == "sale":
        price = money(r["price"])
    elif r["kind"] == "jeonse":
        price = f"전세 {money(r['deposit'])}"
    else:
        price = f"{money(r['deposit'])}/{r['rent']}"
    q = urllib.parse.quote(f"{r['dong']} {r['name']}")
    return (f"• <b>{price}</b> | {e(r['htype'])} {e(r['name'])} ({e(r['dong'])})\n"
            f"   {r['pyeong']}평({r['area']}㎡) · {r['floor']}층 · {r['built'] or '?'}년식 · 계약 {r['date']}"
            f" · <a href=\"https://map.naver.com/p/search/{q}\">지도</a>")


def fmt_dt(s: str) -> str:
    """202611301700 → 11/30 17:00"""
    s = re.sub(r"[^\d]", "", s or "")
    if len(s) >= 8:
        t = f"{int(s[4:6])}/{int(s[6:8])}"
        return t + (f" {s[8:10]}:{s[10:12]}" if len(s) >= 12 else "")
    return s


def build_message(new: dict[str, list], secrets: dict, cfg: dict, status: dict, first_run: bool, totals: dict) -> str:
    site = secrets.get("SITE_URL", "")
    today = dt.datetime.now(KST).strftime("%Y-%m-%d")
    lines = [f"🏠 <b>집 알림</b> {today}"]
    if first_run:
        lines.append("처음 실행이라 현재 데이터를 기준으로 저장했어요. 내일부터 새 항목만 알려드릴게요.")
        lines.append(f"현재 조건에 맞는 거래: 매매 {totals['sale']}건 · 전세 {totals['jeonse']}건 · 월세 {totals['wolse']}건 · 공고 {totals['notices']}건")
    else:
        limit = cfg["telegram"]["max_items_per_section"]
        sections = [("sale", "🔑 매매 신규 실거래"), ("jeonse", "📄 전세 신규 실거래"), ("wolse", "📄 월세 신규 실거래")]
        any_new = False
        for k, title in sections:
            items = sorted(new.get(k, []), key=lambda r: r.get("price", r.get("deposit", 0)))
            if not items:
                continue
            any_new = True
            lines += ["", f"<b>{title} ({len(items)}건)</b>"]
            lines += [deal_line(r) for r in items[:limit]]
            if len(items) > limit:
                lines.append(f"   …외 {len(items) - limit}건은 웹사이트에서")
        youth = [n for n in new.get("notices", []) if n.get("youth")]
        other = [n for n in new.get("notices", []) if not n.get("youth")]
        if youth:
            any_new = True
            lines += ["", f"<b>🧑 청년임대 새 공고 ({len(youth)}건)</b>"]
            for n in sorted(youth, key=lambda n: not n.get("fav"))[:limit]:
                extra = " · ".join(v for v in (n.get("program"), n.get("category"),
                                              f"신청 {n['deadline']}" if n.get("deadline") else "") if v)
                star = "⭐ " if n.get("fav") else ""
                lines.append(f"• {star}[{html.escape(n['source'])}] <a href=\"{html.escape(n['url'])}\">{html.escape(n['title'])}</a>"
                             + (f"\n   {html.escape(extra)}" if extra else ""))
        if other:
            any_new = True
            lines += ["", f"<b>📢 LH·SH 새 공고 ({len(other)}건)</b>"]
            for n in other[:limit]:
                lines.append(f"• [{n['source']}] <a href=\"{html.escape(n['url'])}\">{html.escape(n['title'])}</a>")
        if new.get("auctions"):
            any_new = True
            lines += ["", f"<b>🔨 새 공매 물건 ({len(new['auctions'])}건)</b>"]
            for a in new["auctions"][:limit]:
                low = money(a["low"]) if a.get("low") else (a.get("low_text") or "비공개")
                ratio = f" (감정가의 {a['low_ratio']:.0f}%)" if a.get("low_ratio") else ""
                lines.append(f"• <b>{html.escape(low)}</b>{ratio} | {html.escape(a['use'])} {html.escape(a['name'][:40])}\n"
                             f"   유찰 {a.get('fails') or 0}회 · 입찰 {fmt_dt(a.get('bid_start'))}~{fmt_dt(a.get('bid_end'))} · 온비드 {html.escape(a.get('onbid_no') or '')}")
        if not any_new:
            lines.append("오늘은 조건에 맞는 새 항목이 없어요.")
        if new.get("odd"):
            lines += ["", f"<i>직거래·시세 대비 지나치게 싼 거래 {len(new['odd'])}건은 알림에서 뺐어요 (웹사이트에서 '이상 거래 보기'로 확인)</i>"]
    errs = [f"{k}: {v.get('error_count', 1)}건 오류" for k, v in status.items() if not v.get("ok")]
    if errs:
        lines += ["", "⚠️ 일부 수집 실패 — " + ", ".join(errs)]
    if site:
        lines += ["", f"👉 <a href=\"{site}\">한눈에 보기 (웹사이트)</a>"]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 저장
# --------------------------------------------------------------------------
def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def criteria_summary(cfg: dict) -> dict:
    c = cfg["common"]
    return {
        "regions": [r["name"] for r in cfg["regions"]],
        "house_types": c["house_types"],
        "min_area": f"전용 {c['min_area_m2']}㎡ (약 {c['min_area_m2'] / 3.3058:.0f}평) 이상",
        "min_floor": f"{c['min_floor']}층 이상",
        "sale": f"{money(cfg['sale']['min_price'])} ~ {money(cfg['sale']['max_price'])}" if cfg["sale"]["enabled"] else "끔",
        "jeonse": f"보증금 {money(cfg['jeonse']['max_deposit'])} 이하" if cfg["jeonse"]["enabled"] else "끔",
        "wolse": f"보증금 {money(cfg['wolse']['max_deposit'])} / 월 {cfg['wolse']['max_rent']} 이하" if cfg["wolse"]["enabled"] else "끔",
        "months_back": c["months_back"],
    }


# --------------------------------------------------------------------------
# 메인
# --------------------------------------------------------------------------
def run(send_telegram: bool = True) -> None:
    cfg = load_config()
    secrets = load_secrets()
    key = urllib.parse.unquote(secrets.get("DATA_GO_KR_KEY", ""))
    now = dt.datetime.now(KST)
    today = now.strftime("%Y-%m-%d")
    status: dict = {}

    deals: list[dict] = []
    if key:
        deals = collect_deals(cfg, key, status)
    else:
        status["실거래가"] = {"ok": False, "errors": ["DATA_GO_KR_KEY(공공데이터포털 인증키)가 없어요"], "error_count": 1}

    notices: list[dict] = []
    if cfg["notices"]["lh_enabled"]:
        if key:
            try:
                lh = collect_lh(key)
                notices += lh
                status["LH"] = {"ok": True, "count": len(lh)}
            except Exception as e:
                status["LH"] = {"ok": False, "errors": [str(e)], "error_count": 1}
        else:
            status["LH"] = {"ok": False, "errors": ["인증키 없음"], "error_count": 1}
    if cfg["notices"]["sh_enabled"]:
        try:
            sh = collect_sh()
            notices += sh
            status["SH"] = {"ok": True, "count": len(sh)}
        except Exception as e:
            status["SH"] = {"ok": False, "errors": [str(e)], "error_count": 1}
    if cfg.get("youth", {}).get("soco_enabled", True):
        try:
            soco = collect_soco(cfg)
            notices += soco
            status["청년안심주택"] = {"ok": True, "count": len(soco)}
        except Exception as e:
            status["청년안심주택"] = {"ok": False, "errors": [str(e)], "error_count": 1}
    for n in notices:
        tag_youth(n)

    auctions: list[dict] = []
    auction_ok = False
    if cfg.get("auction", {}).get("enabled") and key:
        try:
            auctions = collect_onbid(cfg, key)
            auction_ok = True
            status["공매(온비드)"] = {"ok": True, "count": len(auctions)}
        except Exception as e:
            msg = str(e)[:200]
            if "403" in msg or "SERVICE_KEY" in msg or "등록되지 않은" in msg:
                msg = "온비드 API 활용신청이 필요해요 (공공데이터포털 '차세대 온비드 부동산 물건목록 조회서비스')"
            status["공매(온비드)"] = {"ok": False, "errors": [msg], "error_count": 1, "setup": True}

    seen = load_json(SEEN_PATH, None)
    first_run = seen is None
    seen = seen or {}
    # 첫 실행에서는 전부 NEW로 보이지 않도록 '어제 본 것'으로 기록
    mark = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d") if first_run else today

    # 수집에 실패한 출처의 기존 데이터는 웹사이트에서 유지
    prev = load_json(SITE_DATA_PATH, {})
    if not status.get("실거래가", {}).get("calls") and prev and not prev.get("demo"):
        deals = prev.get("sale", []) + prev.get("jeonse", []) + prev.get("wolse", [])
    for src in ("LH", "SH", "청년안심주택"):
        if src in status and not status[src]["ok"] and prev and not prev.get("demo"):
            notices += [n for n in prev.get("notices", []) if n["source"] == src]
    if not auction_ok and prev and not prev.get("demo"):
        auctions = prev.get("auctions", [])

    # 새로 추가된 출처는 처음 한 번은 조용히 '본 것'으로 기록 (알림 폭탄 방지)
    yesterday = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")

    def quiet_first(prefix: str, ids: list[str]) -> None:
        if not any(k.startswith(prefix) for k in seen):
            for i in ids:
                seen[i] = yesterday   # NEW 표시도 붙지 않게 '어제 본 것'으로
    quiet_first("SOCO|", [n["id"] for n in notices if n["id"].startswith("SOCO|")])
    quiet_first("ONBID|", [a["id"] for a in auctions])

    flag_odd(deals)
    new: dict[str, list] = {"sale": [], "jeonse": [], "wolse": [], "notices": [], "odd": [], "auctions": []}
    for a in auctions:
        a["first_seen"] = seen.get(a["id"], mark)
        if a["id"] not in seen:
            seen[a["id"]] = mark
            new["auctions"].append(a)
    for r in deals:
        r["first_seen"] = seen.get(r["id"], mark)
        if r["id"] not in seen:
            seen[r["id"]] = mark
            new["odd" if r["odd"] else r["kind"]].append(r)
    for n in notices:
        n["wanted"] = notice_wanted(n, cfg)
        n["first_seen"] = seen.get(n["id"], mark)
        if n["id"] not in seen:
            seen[n["id"]] = mark
            if n["wanted"]:
                new["notices"].append(n)

    # 오래된 seen 정리 (1년)
    cutoff = (now - dt.timedelta(days=365)).strftime("%Y-%m-%d")
    seen = {k: v for k, v in seen.items() if v >= cutoff}

    by_kind = {k: sorted([r for r in deals if r["kind"] == k], key=lambda r: r["date"], reverse=True)
               for k in ("sale", "jeonse", "wolse")}
    notices.sort(key=lambda n: n.get("date", ""), reverse=True)
    site_data = {
        "updated": now.strftime("%Y-%m-%d %H:%M"),
        "today": today,
        "criteria": criteria_summary(cfg),
        "status": status,
        **by_kind,
        "notices": notices,
        "auctions": auctions,
        "auction_enabled": bool(cfg.get("auction", {}).get("enabled")),
    }
    save_json(SITE_DATA_PATH, site_data)
    save_json(SEEN_PATH, seen)

    totals = {k: len(v) for k, v in by_kind.items()}
    totals["notices"] = sum(1 for n in notices if n["wanted"])
    print(f"[완료] 매매 {totals['sale']} · 전세 {totals['jeonse']} · 월세 {totals['wolse']} · 공고 {len(notices)}"
          f" · 공매 {len(auctions)}"
          f" | 신규 매매 {len(new['sale'])} 전세 {len(new['jeonse'])} 월세 {len(new['wolse'])} 공고 {len(new['notices'])}"
          f" 공매 {len(new['auctions'])}")
    for k, v in status.items():
        if not v.get("ok"):
            print(f"[경고] {k}: {v.get('errors')}")

    if send_telegram and cfg["telegram"]["enabled"]:
        tg_send(secrets, build_message(new, secrets, cfg, status, first_run, totals))


def demo() -> None:
    """웹사이트 미리보기용 예시 데이터 (실제 거래 아님)"""
    cfg = load_config()
    today = dt.datetime.now(KST).strftime("%Y-%m-%d")
    samples = [
        ("sale", "아파트", "사당 (동작구)", "사당동", "예시아파트", 59.9, 7, 2004, {"price": 48500}),
        ("sale", "오피스텔", "서울대입구·낙성대 (관악구)", "봉천동", "예시오피스텔", 33.1, 12, 2019, {"price": 31000}),
        ("sale", "빌라", "당산 (영등포구)", "당산동6가", "예시빌라", 41.2, 3, 2016, {"price": 36000}),
        ("jeonse", "빌라", "서울대입구·낙성대 (관악구)", "봉천동", "예시하우스", 36.5, 4, 2015, {"deposit": 18000, "rent": 0}),
        ("wolse", "오피스텔", "사당 남측 (서초구 방배동)", "방배동", "예시타워", 28.0, 9, 2018, {"deposit": 3000, "rent": 65}),
    ]
    data = {"sale": [], "jeonse": [], "wolse": []}
    for i, (k, ht, rg, dong, nm, ar, fl, by, extra) in enumerate(samples):
        r = {"id": f"demo{i}", "kind": k, "htype": ht, "region": rg, "dong": dong, "name": nm, "jibun": "",
             "area": ar, "pyeong": round(ar / 3.3058, 1), "floor": fl, "built": by, "date": today,
             "first_seen": today, **extra}
        data[k].append(r)
    notices = [
        {"id": "demoL", "source": "LH", "title": "(예시) 서울 행복주택 입주자 모집공고", "category": "행복주택",
         "status": "접수중", "date": today, "deadline": today, "region": "서울", "url": LH_LIST_URL,
         "wanted": True, "first_seen": today},
        {"id": "demoS", "source": "SH", "title": "(예시) 청년안심주택 입주자 모집공고", "category": "맞춤주택공급부",
         "status": "", "date": today, "deadline": "", "region": "서울", "url": SH_BASE + "list.do",
         "wanted": True, "first_seen": today},
    ]
    save_json(SITE_DATA_PATH, {"demo": True, "updated": today + " (예시 데이터)", "today": today,
                               "criteria": criteria_summary(cfg), "status": {}, **data, "notices": notices})
    print("예시 데이터를 docs/data.json 에 저장했어요.")


def find_chat_id() -> None:
    token = load_secrets().get("TELEGRAM_TOKEN")
    if not token:
        print("secrets.local.toml 에 TELEGRAM_TOKEN 을 먼저 넣어주세요.")
        return
    res = tg_call(token, "getUpdates", {})
    chats = {}
    for u in res.get("result", []):
        msg = u.get("message") or u.get("channel_post") or {}
        if msg.get("chat"):
            c = msg["chat"]
            chats[c["id"]] = c.get("first_name") or c.get("title") or ""
    if not chats:
        print("찾지 못했어요. 텔레그램에서 내 봇에게 아무 메시지나 보낸 뒤 다시 실행하세요.")
    for cid, name in chats.items():
        print(f"chat id: {cid}  ({name})")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    args = set(sys.argv[1:])
    if "--demo" in args:
        demo()
    elif "--find-chat-id" in args:
        find_chat_id()
    elif "--telegram-test" in args:
        tg_send(load_secrets(), "✅ 집 알림 봇 연결 성공!")
    else:
        SILENT = "--silent" in args
        run(send_telegram="--no-telegram" not in args)
