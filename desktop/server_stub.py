"""
電腦版接頭（預留）— 家中電腦 Python 服務的最小骨架
=====================================================
手機 App 與 GAS 中繼都會依「統一回傳格式」呼叫這支服務；把 search() 內的 TODO 換成
fast-flights（faster-flights）查詢並轉成統一格式，手機版就會自動優先走家中電腦、零成本無上限。

啟動：
  pip install fastapi uvicorn
  set FP_TOKEN=你的密碼            (Windows)  /  export FP_TOKEN=你的密碼 (macOS/Linux)
  uvicorn server_stub:app --host 0.0.0.0 --port 8787

對外：用 Tailscale Funnel 或 Cloudflare Tunnel 把 8787 埠對外成 https 網址，
      填到手機 App「家中電腦網址」，例如 https://xxxx.ts.net

API（與 GAS 中繼一致）
  GET /ping?token=...
  GET /search?token=...&q=<JSON>
  GET /returns?token=...&q=<JSON>&dt=<departureToken>
  GET /booking?token=...&q=<JSON>&bt=<token>
統一回傳格式見 backend/Code.gs 檔頭註解。
"""
import json, os
from datetime import datetime, timezone
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware

TOKEN = os.environ.get("FP_TOKEN", "")
app = FastAPI(title="Flight price home server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


def auth(token: str):
    if not TOKEN or token != TOKEN:
        raise HTTPException(401, "AUTH")


@app.get("/ping")
def ping(token: str = ""):
    auth(token)
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat(), "providers": {"homepc": {"configured": True, "used": 0, "quota": None}, "order": ["homepc"]}}


@app.get("/search")
def search(token: str = "", q: str = Query("{}")):
    auth(token)
    qq = json.loads(q)
    # TODO: 以 fast-flights 查詢 qq['o'], qq['d'], qq['dep'], qq['ret'] ...
    #   from fast_flights import FlightQuery, Passengers, create_query, get_flights
    #   並把每筆結果轉成 flights[] 的統一欄位（segments/layovers/price/totalDuration）
    return {"ok": False, "error": "NOT_IMPLEMENTED", "message": "家中電腦查價尚未實作，請改走雲端中繼"}


@app.get("/returns")
def returns(token: str = "", q: str = Query("{}"), dt: str = ""):
    auth(token)
    # TODO: 來回第二步：依 dt（去程選項 token）回傳回程選項，每筆含 bookingToken
    return {"ok": False, "error": "NOT_IMPLEMENTED", "message": "家中電腦回程查詢尚未實作"}


@app.get("/booking")
def booking(token: str = "", q: str = Query("{}"), bt: str = ""):
    auth(token)
    return {"ok": False, "message": "家中電腦尚未提供訂票管道查詢"}
