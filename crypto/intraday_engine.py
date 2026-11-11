#!/usr/bin/env python3
"""6-hour-bar paper lanes (2 Nov 2026 intraday test: 6h bars add ~3 pts/yr over daily at 0.2% fees, more at live fees).
Lanes: F50h (fast 3 rules, VT50) and B50h (barbell, VT50) on BTC/ETH 50/50, long or flat, marked every 6h at 00/06/12/18 UTC closes.
Rule windows scale with bars per day so lookbacks in TIME match the daily lanes. Lag 1 bar. State: crypto/state_6h.json, ledger_6h.csv.
Also the intraday alert net: if BTC or ETH is more than ALERT_MOVE from the last daily close in state.json, send a Telegram alert (never trades).
Usage: intraday_engine.py [--force] [--quiet] [--dry]"""
import json, os, sys, csv, math, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import paper_engine as pe  # noqa: E402
STATE = os.path.join(HERE, "state_6h.json"); LEDGER = os.path.join(HERE, "ledger_6h.csv"); DAILY = os.path.join(HERE, "state.json")
H = 6; BPD = 24 // H; VT = 0.50; FEE = pe.PARAMS["feeSide"]; BAND = pe.PARAMS["band"]; LANE_USD = pe.PARAMS["laneUSD"]; ALERT_MOVE = 0.10
FAST = ["D20", "D30", "T30"]; BARBELL = ["D20", "T30", "S200", "D100"]; LANES = {"F50h": FAST, "B50h": BARBELL}

def candles(sym, need=240 * BPD):
    out, after = [], ""
    for _ in range(need // 100 + 3):
        if len(out) >= need: break
        u = f"https://www.okx.com/api/v5/market/history-candles?instId={sym}-USDT&bar={H}Hutc&limit=100" + (f"&after={after}" if after else "")
        d = pe.get(u).get("data") or []
        if not d: break
        out += d; after = d[-1][0]
    rows = sorted([(int(x[0]), float(x[4])) for x in out if x[8] == "1"])
    return [dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M") for t, _ in rows], [c for _, c in rows]

def rules(c):
    i = len(c) - 1
    def donch(n_in, n_out):
        s = 0
        for k in range(len(c)):
            hi = max(c[k - n_in * BPD:k]) if k >= n_in * BPD else None; lo = min(c[k - n_out * BPD:k]) if k >= n_out * BPD else None
            if hi is not None and c[k] > hi: s = 1
            elif lo is not None and c[k] < lo: s = 0
        return s
    sma = lambda n: sum(c[i - n * BPD + 1:i + 1]) / (n * BPD)
    return {"D20": donch(20, 10), "D30": donch(30, 15), "T30": 1 if c[i] > c[i - 30 * BPD] else 0, "S200": 1 if c[i] > sma(200) else 0, "D100": donch(100, 50)}

def analyse(c):
    i = len(c) - 1; R = rules(c)
    rets = [c[k] / c[k - 1] - 1 for k in range(i - 30 * BPD + 1, i + 1)]; mu = sum(rets) / len(rets)
    rv = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(365 * BPD); sc = min(1.0, VT / rv)
    return dict(close=c[i], rv=pe.r4(rv), fired=R, w={k: pe.r4(sum(R[x] for x in v) / len(v) * sc) for k, v in LANES.items()})

def run(force=False, quiet=False, dry=False):
    prev = json.load(open(STATE)) if os.path.exists(STATE) else dict(lanes={}, ledger=[])
    data = {s: candles(s) for s in ["BTC", "ETH"]}
    stamp = data["BTC"][0][-1]
    if not force and prev.get("lastBar") == stamp: print("already marked", stamp); return prev
    A = {s: analyse(data[s][1]) for s in data}; px = {s: A[s]["close"] for s in A}; prev_px = prev.get("px") or px
    lanes = dict(prev.get("lanes") or {})
    for k in LANES: lanes[k] = pe.lane_step(lanes.get(k, {}), {s: A[s]["w"][k] / 2 for s in A}, px, prev_px, FEE)
    row = dict(bar=stamp, px=px, eq={k: v["eq"] for k, v in lanes.items()}, w={k: v["w"] for k, v in lanes.items()})
    ledger = ([r for r in (prev.get("ledger") or []) if r["bar"] != stamp] + [row])[-1600:]
    state = dict(lastRun=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), lastBar=stamp, px=px, analysis=A, lanes=lanes, ledger=ledger,
                 start=prev.get("start") or stamp, bars=len(ledger))
    changed = any(abs(lanes[k]["w"][s] - ((prev.get("lanes") or {}).get(k, {}).get("w") or {}).get(s, 0)) > 1e-4 for k in LANES for s in px)
    # intraday alert net against the last DAILY close
    alert = ""
    if os.path.exists(DAILY):
        dpx = json.load(open(DAILY)).get("px") or {}
        moves = {s: px[s] / dpx[s] - 1 for s in px if dpx.get(s)}
        big = {s: m for s, m in moves.items() if abs(m) >= ALERT_MOVE}
        if big: alert = "🚨 " + " · ".join(f"{s} {m*100:+.1f}% vs last daily close" for s, m in big.items())
    if not dry:
        json.dump(state, open(STATE, "w"), indent=1)
        with open(LEDGER, "w", newline="") as f:
            w = csv.writer(f); w.writerow(["bar", "btc", "eth"] + [f"eq{k}" for k in LANES] + [f"w{k}_{s}" for k in LANES for s in ["BTC", "ETH"]])
            for r in ledger: w.writerow([r["bar"], r["px"]["BTC"], r["px"]["ETH"]] + [r["eq"][k] for k in LANES] + [r["w"][k][s] for k in LANES for s in ["BTC", "ETH"]])
    eq = lambda k: f"{k} ${lanes[k]['eq']:,.0f} ({(lanes[k]['eq'] / LANE_USD - 1) * 100:+.1f}%)"
    msg = (f"⏱ <b>Crypto 6h paper · {stamp} UTC</b>{' · TARGET CHANGED' if changed else ''}\n"
           + " · ".join(f"{s} ${px[s]:,.0f} fast {sum(A[s]['fired'][x] for x in FAST)}/3 barbell {sum(A[s]['fired'][x] for x in BARBELL)}/4" for s in px) + "\n"
           + f"Exposure F50h {pe.pct(sum(lanes['F50h']['w'].values()))} · B50h {pe.pct(sum(lanes['B50h']['w'].values()))}\n"
           + f"Bar {state['bars']}: {eq('F50h')} · {eq('B50h')}" + (f"\n{alert}" if alert else ""))
    print(msg)
    daily_run = stamp.endswith("18:00")   # bar stamps are open times; the 18:00 bar closes at 00:00 UTC
    if not quiet and (changed or daily_run or alert or force): pe.send_telegram(msg)
    return state

if __name__ == "__main__":
    a = sys.argv[1:]
    try: run(force="--force" in a, quiet="--quiet" in a, dry="--dry" in a)
    except Exception as ex:
        print("FAILED", ex, file=sys.stderr)
        if "--quiet" not in a: pe.send_telegram(f"⚠️ <b>Crypto 6h paper</b> run failed: {ex}")
        sys.exit(1)
