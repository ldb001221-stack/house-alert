"""docs/rates.json 이 바뀌면 이전 값과 비교해 텔레그램으로 알려줘요. (GitHub Actions에서 실행)"""
import html
import json
import subprocess
import sys
from pathlib import Path

from house_alert import load_secrets, tg_send

ROOT = Path(__file__).resolve().parent
LABELS = {
    "bank.rate": "은행 주담대 금리(%)", "bank.ltv_first": "은행 생애최초 LTV(%)", "bank.ltv_normal": "은행 일반 LTV(%)",
    "bank.cap": "은행 주담대 한도(만원)", "bank.dsr": "DSR 한도(%)", "bank.stress": "스트레스 가산(%p)",
    "bogeum.rate": "보금자리론 금리(%)", "bogeum.ltv": "보금자리론 LTV(%)", "bogeum.cap": "보금자리론 한도(만원)",
    "bogeum.cap_first": "보금자리론 생애최초 한도(만원)", "bogeum.price_max": "보금자리론 주택가격 상한(만원)",
    "bogeum.income_max": "보금자리론 소득 상한(만원)",
    "didim.rate": "디딤돌 금리(%)", "didim.ltv": "디딤돌 LTV(%)", "didim.cap": "디딤돌 한도(만원)",
    "didim.cap_first": "디딤돌 생애최초 한도(만원)", "didim.price_max": "디딤돌 주택가격 상한(만원)",
    "didim.income_max": "디딤돌 소득 상한(만원)", "didim.income_max_first": "디딤돌 생애최초 소득 상한(만원)",
    "jeonse.rate": "전세대출 금리(%)", "jeonse.ratio": "전세대출 보증금 대비 한도(%)",
}


def flat(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flat(v, key + "."))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[key] = v
    return out


def main():
    new = json.loads((ROOT / "docs" / "rates.json").read_text(encoding="utf-8"))
    try:
        old_txt = subprocess.run(["git", "show", "HEAD~1:docs/rates.json"], cwd=ROOT,
                                 capture_output=True, text=True, encoding="utf-8", check=True).stdout
        old = json.loads(old_txt)
    except Exception:
        old = {}
    a, b = flat(old), flat(new)
    changes = [(k, a.get(k), b[k]) for k in b if a.get(k) != b[k]]
    e = html.escape
    lines = [f"🏦 <b>대출 기준 점검</b> ({e(str(new.get('checked', '')))})"]
    if not a:
        lines.append("대출 기준 자동 점검을 시작했어요. 앞으로 15일마다 최신 기준을 확인해서 알려드릴게요.")
    elif changes:
        lines.append(f"바뀐 항목 {len(changes)}개:")
        for k, x, y in changes:
            lines.append(f"• {e(LABELS.get(k, k))}: {x if x is not None else '없음'} → <b>{y}</b>")
    else:
        lines.append("변동 없음 — 지금 기준이 그대로 유효해요.")
    if new.get("summary"):
        lines += ["", e(new["summary"])]
    secrets = load_secrets()
    if secrets.get("SITE_URL"):
        lines += ["", f"👉 <a href=\"{secrets['SITE_URL']}\">웹사이트에서 대출 계산 다시 보기</a>"]
    msg = "\n".join(lines)
    print(msg)
    tg_send(secrets, msg)


if __name__ == "__main__":
    sys.stdout.reconfigure(errors="replace")
    main()
