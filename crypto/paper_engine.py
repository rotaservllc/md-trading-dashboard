#!/usr/bin/env python3
"""Crypto Lane paper engine (Charter v1.1, approved 24 Oct 2026). Python port of lib/crypto-core.mjs, run by GitHub Actions
daily at 00:20 UTC. Signal-only: marks five lanes on a hypothetical $12,000 each at the 00:00 UTC close.
  D main lane: 7-rule trend ensemble on BTC/ETH spot, 50/50, 35% vol target on 30d realised vol, long or flat.
  E paper variant: D with exposure halved when the coin is >15% below its 1-year high.
  C carry: long spot / short perp 1x on half the lane, in when 7d avg annualised funding > 8%, out < 3%.
  S short (paper only, kill rule): 1x short when the ensemble score is 0, vol-scaled.
  R rotation (paper only): top-10 universe, same ensemble per coin, 1/10 budget, active only when BTC/ETH composite >= 0.5.
State: crypto/state.json (committed by the workflow). Ledger: crypto/ledger.csv. Edit PARAMS in writing only.
Usage: paper_engine.py [--force] [--quiet] [--dry]
"""
import json, os, sys, csv, math, time, datetime as dt, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")
LEDGER = os.path.join(HERE, "ledger.csv")
PARAMS = dict(laneUSD=12000, volTarget=0.35, volWindow=30, band=0.05, feeSide=0.002, altFeeSide=0.0035, perpFeeSide=0.0025,
              carryIn=0.08, carryOut=0.03, drawdownDerisk=0.15,
              universe=["BTC", "ETH", "BNB", "XRP", "SOL", "TRX", "ZEC", "DOGE", "LINK", "XMR"])
UA = {"User-Agent": "Mozilla/5.0"}

def get(url, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

# ---------- data ----------
def okx_candles(inst, need=420):
    out, after = [], ""
    for _ in range(6):
        if len(out) >= need: break
        u = f"https://www.okx.com/api/v5/market/history-candles?instId={inst}&bar=1Dutc&limit=100" + (f"&after={after}" if after else "")
        d = get(u).get("data") or []
        if not d: break
        out += d; after = d[-1][0]
    rows = sorted([(int(x[0]), float(x[4])) for x in out if x[8] == "1"])
    return dict(dates=[dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime("%Y-%m-%d") for t, _ in rows], closes=[c for _, c in rows], src="okx")

def yf_candles(sym):
    j = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=2y&interval=1d")["chart"]["result"][0]
    ts, cl = j.get("timestamp", []), j["indicators"]["quote"][0]["close"]
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    rows = [(t, c) for t, c in zip(ts, cl) if c is not None and dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d") < today]
    return dict(dates=[dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d") for t, _ in rows], closes=[c for _, c in rows], src="yahoo")

def candles(sym):
    try:
        c = okx_candles(f"{sym}-USDT")
        if len(c["closes"]) >= 380: return c
    except Exception as e:
        print("okx", sym, e, file=sys.stderr)
    return yf_candles(f"{sym}-USD")

def okx_funding(inst):
    d = get(f"https://www.okx.com/api/v5/public/funding-rate-history?instId={inst}&limit=24").get("data") or []
    rates = [float(x["fundingRate"]) for x in d if x.get("fundingRate") not in (None, "")]
    if not rates: return dict(ann7=None, last=None, day=None, n=0)
    k = min(len(rates), 21)
    return dict(ann7=sum(rates[:k]) / k * 3 * 365, last=rates[0], day=sum(rates[:3]), n=len(rates))

# ---------- rules (identical to backtest_trend.py / crypto-core.mjs) ----------
def sma(a, n, i):
    return None if i + 1 < n else sum(a[i - n + 1:i + 1]) / n
def donchian(c, n_in, n_out):
    p, s = [0] * len(c), 0
    for i in range(len(c)):
        hi = max(c[i - n_in:i]) if i >= n_in else None
        lo = min(c[i - n_out:i]) if i >= n_out else None
        if hi is not None and c[i] > hi: s = 1
        elif lo is not None and c[i] < lo: s = 0
        p[i] = s
    return p
def r_sma100_rising(c):
    out = []
    for i, x in enumerate(c):
        m = sma(c, 100, i); m10 = sma(c, 100, i - 10) if i >= 10 else None
        out.append(1 if (m is not None and m10 is not None and x > m and m > m10) else 0)
    return out
def r_sma200(c): return [1 if (sma(c, 200, i) is not None and x > sma(c, 200, i)) else 0 for i, x in enumerate(c)]
def r_tsmom30(c): return [1 if (i >= 30 and x > c[i - 30]) else 0 for i, x in enumerate(c)]
RULES = {
    "SMA100 rising": r_sma100_rising, "Donchian 100/50": lambda c: donchian(c, 100, 50), "Donchian 50/25": lambda c: donchian(c, 50, 25),
    "SMA200": r_sma200, "Donchian 20/10": lambda c: donchian(c, 20, 10), "Donchian 30/15": lambda c: donchian(c, 30, 15), "TSMOM 30": r_tsmom30,
}
def analyse(closes):
    i = len(closes) - 1
    fired = {k: f(closes)[i] for k, f in RULES.items()}
    score = sum(fired.values()) / len(fired)
    rets = [closes[k] / closes[k - 1] - 1 for k in range(i - PARAMS["volWindow"] + 1, i + 1)]
    mu = sum(rets) / len(rets)
    rv = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(365)
    scale = min(1.0, PARAMS["volTarget"] / rv)
    hi1y = max(closes[-365:]); dd = closes[i] / hi1y - 1
    return dict(close=closes[i], score=score, fired=fired, rv=rv, scale=scale, hi1y=hi1y, dd=dd,
                wD=score * scale, wE=score * scale * (0.5 if dd < -PARAMS["drawdownDerisk"] else 1.0), wS=(-scale if score == 0 else 0.0))

# ---------- ledger ----------
r4 = lambda x: round(x * 1e4) / 1e4
def apply_band(cur, tgt):
    return tgt if ((cur == 0) != (tgt == 0) or (cur > 0) != (tgt > 0) or abs(tgt - cur) > PARAMS["band"]) else cur
def lane_step(lane, new_w, px, prev_px, fee):
    ret = 0.0
    for k in new_w:
        w = (lane.get("w") or {}).get(k, 0)
        if prev_px.get(k) and px.get(k): ret += w * (px[k] / prev_px[k] - 1)
    w2, turn = {}, 0.0
    for k in new_w:
        cur = (lane.get("w") or {}).get(k, 0); w2[k] = r4(apply_band(cur, new_w[k])); turn += abs(w2[k] - cur)
    cost = turn * fee
    eq = lane.get("eq", PARAMS["laneUSD"]) * (1 + ret - cost)
    return dict(lane, w=w2, eq=round(eq * 100) / 100, peak=max(lane.get("peak", PARAMS["laneUSD"]), eq), ret=r4(ret - cost),
                trades=lane.get("trades", 0) + (1 if turn > 0 else 0), turnover=r4(lane.get("turnover", 0) + turn))

def trim(a):
    return dict(close=a["close"], score=a["score"], fired=a["fired"], rv=r4(a["rv"]), scale=r4(a["scale"]), dd=r4(a["dd"]), wD=r4(a["wD"]), wE=r4(a["wE"]), wS=r4(a["wS"]))

def pct(x): return f"{x * 100:.0f}%"
def format_msg(s, changed):
    L, b, e = s["lanes"], s["analysis"]["BTC"], s["analysis"]["ETH"]
    eq = lambda k: f"{k} ${L[k]['eq']:,.0f} ({(L[k]['eq'] / PARAMS['laneUSD'] - 1) * 100:+.1f}%)"
    rsum = sum(L["R"]["w"].values())
    f = L["C"].get("funding") or {}
    fb = "n/a" if f.get("BTC") is None else pct(f["BTC"]); fe = "n/a" if f.get("ETH") is None else pct(f["ETH"])
    return (f"🪙 <b>Crypto lane paper · {s['lastDate']}</b>{' · TARGET CHANGED' if changed else ''}\n"
            f"BTC ${b['close']:,.0f} score {b['score']:.2f} vol {pct(b['rv'])} → D {pct(L['D']['w']['BTC'] * 2)} of half\n"
            f"ETH ${e['close']:,.0f} score {e['score']:.2f} vol {pct(e['rv'])} → D {pct(L['D']['w']['ETH'] * 2)} of half\n"
            f"Lane D exposure {pct(L['D']['w']['BTC'] + L['D']['w']['ETH'])} · E {pct(L['E']['w']['BTC'] + L['E']['w']['ETH'])} · S {pct(-(L['S']['w']['BTC'] + L['S']['w']['ETH']))} short · R {pct(rsum)}\n"
            f"Carry: BTC {fb} {'IN' if L['C']['in'].get('BTC') else 'out'} · ETH {fe} {'IN' if L['C']['in'].get('ETH') else 'out'} (gate {pct(PARAMS['carryIn'])}/{pct(PARAMS['carryOut'])})\n"
            f"Paper equity day {s['days']}: {' · '.join(eq(k) for k in ['D', 'E', 'C', 'S', 'R'])}\n"
            f"Data {s['src']['BTC']}/{s['src']['ETH']}. Signal only, no orders. Runner: GitHub Actions.")

def send_telegram(text):
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat: print("telegram: no token/chat", file=sys.stderr); return
    body = json.dumps(dict(chat_id=chat, text=text, parse_mode="HTML", disable_web_page_preview=True)).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: print("telegram", r.status)
    except Exception as ex: print("telegram error", ex, file=sys.stderr)

def run(force=False, quiet=False, dry=False):
    prev = json.load(open(STATE)) if os.path.exists(STATE) else dict(lanes={}, ledger=[])
    btc, eth = candles("BTC"), candles("ETH")
    date = btc["dates"][-1]
    if not force and prev.get("lastDate") == date:
        print("already marked", date); return prev
    A = dict(BTC=analyse(btc["closes"]), ETH=analyse(eth["closes"]))
    px = dict(BTC=A["BTC"]["close"], ETH=A["ETH"]["close"]); prev_px = prev.get("px") or px
    funding = {}
    try: funding = dict(BTC=okx_funding("BTC-USDT-SWAP"), ETH=okx_funding("ETH-USDT-SWAP"))
    except Exception as ex: print("funding", ex, file=sys.stderr)
    lanes = dict(prev.get("lanes") or {})
    lanes["D"] = lane_step(lanes.get("D", {}), dict(BTC=A["BTC"]["wD"] / 2, ETH=A["ETH"]["wD"] / 2), px, prev_px, PARAMS["feeSide"])
    lanes["E"] = lane_step(lanes.get("E", {}), dict(BTC=A["BTC"]["wE"] / 2, ETH=A["ETH"]["wE"] / 2), px, prev_px, PARAMS["feeSide"])
    lanes["S"] = lane_step(lanes.get("S", {}), dict(BTC=A["BTC"]["wS"] / 2, ETH=A["ETH"]["wS"] / 2), px, prev_px, PARAMS["perpFeeSide"])
    C = lanes.get("C") or {"in": {}, "eq": PARAMS["laneUSD"], "peak": PARAMS["laneUSD"], "trades": 0}
    cret, cturn, in_now = 0.0, 0.0, {}
    for k in ["BTC", "ETH"]:
        f = funding.get(k); was = 1 if (C.get("in") or {}).get(k) else 0; now = was
        if f and f["ann7"] is not None:
            if f["ann7"] > PARAMS["carryIn"]: now = 1
            elif f["ann7"] < PARAMS["carryOut"]: now = 0
        in_now[k] = now
        if was and f and f["day"] is not None: cret += 0.25 * f["day"]
        cturn += abs(now - was) * 0.25
    ccost = cturn * (PARAMS["feeSide"] + PARAMS["perpFeeSide"])
    ceq = round(C["eq"] * (1 + cret - ccost) * 100) / 100
    lanes["C"] = dict(C, **{"in": in_now}, eq=ceq, ret=r4(cret - ccost), trades=C.get("trades", 0) + (1 if cturn > 0 else 0),
                      funding={k: (None if v["ann7"] is None else r4(v["ann7"])) for k, v in funding.items()}, peak=max(C.get("peak", PARAMS["laneUSD"]), ceq))
    composite = (A["BTC"]["score"] + A["ETH"]["score"]) / 2
    rpx = dict(px); RA = dict(BTC=A["BTC"], ETH=A["ETH"])
    for s in PARAMS["universe"]:
        if s in ("BTC", "ETH"): continue
        try:
            c = candles(s)
            if len(c["closes"]) >= 380: RA[s] = analyse(c["closes"]); rpx[s] = RA[s]["close"]
        except Exception as ex: print(s, ex, file=sys.stderr)
    rot = {s: (RA[s]["wD"] / len(PARAMS["universe"]) if (composite >= 0.5 and s in RA) else 0.0) for s in PARAMS["universe"]}
    lanes["R"] = lane_step(lanes.get("R", {}), rot, rpx, prev.get("rpx") or rpx, PARAMS["altFeeSide"])
    row = dict(date=date, px=px, composite=r4(composite), eq={k: v["eq"] for k, v in lanes.items()}, wD=lanes["D"]["w"], wE=lanes["E"]["w"], wS=lanes["S"]["w"],
               carryIn=in_now, funding=lanes["C"]["funding"], rot=lanes["R"]["w"])
    ledger = [r for r in (prev.get("ledger") or []) if r["date"] != date] + [row]
    ledger = ledger[-400:]
    state = dict(lastRun=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), lastDate=date, src=dict(BTC=btc["src"], ETH=eth["src"]), px=px, rpx=rpx,
                 analysis=dict(BTC=trim(A["BTC"]), ETH=trim(A["ETH"])), composite=r4(composite), lanes=lanes, ledger=ledger, start=prev.get("start") or date, days=len(ledger))
    pD = (prev.get("lanes") or {}).get("D", {}).get("w") or {}
    changed = any(abs(lanes["D"]["w"][k] - pD.get(k, 0)) > 1e-4 for k in ["BTC", "ETH"]) \
        or in_now != ((prev.get("lanes") or {}).get("C", {}).get("in") or {}) or lanes["S"]["w"] != ((prev.get("lanes") or {}).get("S", {}).get("w") or {})
    monday = dt.datetime.now(dt.timezone.utc).weekday() == 0
    if not dry:
        json.dump(state, open(STATE, "w"), indent=1)
        with open(LEDGER, "w", newline="") as f:
            w = csv.writer(f); w.writerow(["date", "btc", "eth", "composite", "eqD", "eqE", "eqC", "eqS", "eqR", "wD_btc", "wD_eth", "carry_btc", "carry_eth"])
            for r in ledger: w.writerow([r["date"], r["px"]["BTC"], r["px"]["ETH"], r["composite"], r["eq"]["D"], r["eq"]["E"], r["eq"]["C"], r["eq"]["S"], r["eq"]["R"], r["wD"]["BTC"], r["wD"]["ETH"], r["carryIn"]["BTC"], r["carryIn"]["ETH"]])
    msg = format_msg(state, changed)
    print(msg)
    if not quiet and (changed or monday or force): send_telegram(msg)
    return state

if __name__ == "__main__":
    a = sys.argv[1:]
    try:
        run(force="--force" in a, quiet="--quiet" in a, dry="--dry" in a)
    except Exception as ex:
        print("FAILED", ex, file=sys.stderr)
        if "--quiet" not in a: send_telegram(f"⚠️ <b>Crypto lane</b> paper run failed: {ex}")
        sys.exit(1)
