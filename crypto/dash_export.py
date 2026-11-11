#!/usr/bin/env python3
"""Builds crypto/dashboard_data.json for the Crypto Lane Tournament dashboard from state.json, ledger.csv, state_6h.json,
ledger_6h.csv, exec_state.json and fills.csv. Called by the paper engine and the executor after they write; also runnable alone."""
import csv, json, os, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
LANE_INFO = {  # id: (group, description, backtest OOS 2023-26 CAGR %, max drawdown %, Sharpe) from the tournament log
    "D": ("charter", "7 rules, VT35 (Charter v1.1 config)", 20.3, -20, 0.99), "E": ("charter", "D with de-risk below 15% off the 1y high", None, None, None),
    "C": ("carry", "Spot-perp carry, funding gate 8%/3%", None, None, None), "S": ("short", "Short when all 7 rules are off (kill test 23 Nov)", None, None, None),
    "R": ("rotation", "Top-10 alt rotation", 11.9, -35, 0.44),
    "F35": ("fast", "Fast 3 rules, VT35", 24.2, -25, 1.14), "F50": ("fast", "Fast 3 rules, VT50", 26.8, -30, 1.00), "F70": ("fast", "Fast 3 rules, VT70", 29.4, -32, 1.00),
    "D50": ("charter", "7 rules, VT50", 23.2, -23, 0.90), "D00": ("charter", "7 rules, no vol cap", 25.3, -27, 0.87),
    "B50": ("barbell", "Barbell 2 fast + 2 slow, VT50", 26.6, -25, 0.99), "B70": ("barbell", "Barbell, VT70", 28.6, -28, 0.97), "B35": ("barbell", "Barbell, VT35", 21.6, -21, 1.03),
    "B50L": ("levered", "Barbell VT50, 1.5x cap via perps", 31.9, -29, 1.06), "F50L": ("levered", "Fast 3 VT50, 1.5x cap via perps", 33.0, -34, 1.07),
    "B50R": ("tilt", "Barbell VT50, 90d relative-strength tilt 70/30", 28.8, -27, 1.04), "F50R": ("tilt", "Fast 3 VT50, relative-strength tilt", 28.5, -33, 1.04),
    "B50LR": ("stack", "Barbell VT50, 1.5x cap + tilt (full stack)", 33.6, -29, 1.08), "F50LR": ("stack", "Fast 3 VT50, 1.5x cap + tilt (full stack)", 35.8, -34, 1.13),
    "X16": ("candidate", "Fast 3 + Donchian 55/20, VT35", 26.6, -27, 1.09), "X3": ("candidate", "Donchian 55/20 AND SMA200, VT35", 20.1, -12, 1.08), "B50V60": ("candidate", "Barbell VT50, 60-day vol window", 28.5, -25, 1.06),
    "F50h": ("6h", "Fast 3 VT50 on 6-hour bars", 27.0, -31, 0.99), "B50h": ("6h", "Barbell VT50 on 6-hour bars", 26.3, -28, 0.96),
}
LANE_USD = 12000

def build():
    st = json.load(open(os.path.join(HERE, "state.json")))
    rows = list(csv.DictReader(open(os.path.join(HERE, "ledger.csv"))))
    lanes = []
    for lid, lane in st["lanes"].items():
        col = f"eq{lid}"; series = [[r["date"], float(r[col])] for r in rows if r.get(col) not in (None, "")]
        if lid in ("D", "E", "C", "S", "R"): series = [[r["date"], float(r[col])] for r in rows if r.get(col)]
        if not series: series = [[st["lastDate"], lane["eq"]]]
        info = LANE_INFO.get(lid, ("other", lid, None, None, None))
        start = series[0][0]; eq = lane["eq"]; peak = lane.get("peak", LANE_USD)
        lanes.append(dict(id=lid, group=info[0], description=info[1], start=start, days=len(series), equity=eq, ret_pct=round((eq / LANE_USD - 1) * 100, 2),
                          dd_pct=round((eq / peak - 1) * 100, 2), trades=lane.get("trades", 0), exposure=round(sum(abs(v) for v in (lane.get("w") or {}).values()) * 100),
                          bt_oos_cagr=info[2], bt_maxdd=info[3], bt_sharpe=info[4], series=series))
    h6 = []
    p6 = os.path.join(HERE, "state_6h.json")
    if os.path.exists(p6):
        s6 = json.load(open(p6)); rows6 = list(csv.DictReader(open(os.path.join(HERE, "ledger_6h.csv"))))
        for lid, lane in s6["lanes"].items():
            series = [[r["bar"], float(r[f"eq{lid}"])] for r in rows6 if r.get(f"eq{lid}")]
            info = LANE_INFO.get(lid, ("6h", lid, None, None, None))
            h6.append(dict(id=lid, group="6h", description=info[1], start=series[0][0] if series else s6["lastBar"], days=len(series), equity=lane["eq"], ret_pct=round((lane["eq"] / LANE_USD - 1) * 100, 2),
                           dd_pct=round((lane["eq"] / lane.get("peak", LANE_USD) - 1) * 100, 2), trades=lane.get("trades", 0), exposure=round(sum(abs(v) for v in lane["w"].values()) * 100),
                           bt_oos_cagr=info[2], bt_maxdd=info[3], bt_sharpe=info[4], series=series))
    fills = []
    pf = os.path.join(HERE, "fills.csv")
    if os.path.exists(pf):
        for r in csv.DictReader(open(pf)):
            fills.append({k: (float(v) if k in ("qty", "avg_px", "mid_at_signal", "slippage_bp", "target_usd", "signal_close", "shortfall_bp") and v not in ("", None) else v) for k, v in r.items()})
    ex = {}
    pe_ = os.path.join(HERE, "exec_state.json")
    if os.path.exists(pe_):
        e = json.load(open(pe_)); ex = {k: e.get(k) for k in ("lastDate", "lastRun", "lane", "demo", "positions_usd", "targets_usd", "gap_usd", "halted", "halt_reason", "lane_equity", "paper_equity", "live_vs_paper_pts", "days")}
    prices = [[r["date"], float(r["btc"]), float(r["eth"])] for r in rows]
    a = st["analysis"]
    out = dict(generated=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), lastDate=st["lastDate"], laneUSD=LANE_USD,
               btc=dict(close=a["BTC"]["close"], score=a["BTC"]["score"], fired=a["BTC"]["fired"], rv=a["BTC"]["rv"]), eth=dict(close=a["ETH"]["close"], score=a["ETH"]["score"], fired=a["ETH"]["fired"], rv=a["ETH"]["rv"]),
               prices=prices, lanes=lanes, lanes6h=h6, fills=fills, executor=ex)
    json.dump(out, open(os.path.join(HERE, "dashboard_data.json"), "w"), separators=(",", ":"))
    return out

if __name__ == "__main__":
    o = build(); print("dashboard_data.json", len(o["lanes"]), "lanes", len(o["fills"]), "fills", o["lastDate"])
