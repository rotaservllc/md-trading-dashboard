#!/usr/bin/env python3
"""Robustness pack (8 Nov): (A) block-bootstrap drawdown model per candidate config -> what a normal bad run looks like and where
the kill rule should sit; (B) venue-price robustness -> how often rule votes differ between Yahoo (composite) and OKX closes.
Uses tournament_backtest.series/CONFIGS (Yahoo daily) and OKX daily history. Read-only."""
import os, sys, json, math, random, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(os.path.dirname(HERE)))
import tournament_backtest as tb, paper_engine as pe
random.seed(7)
btc, eth = tb.load("BTC", False), tb.load("ETH", False)
dates = sorted(set(d for d, _ in btc) & set(d for d, _ in eth)); bm, em = dict(btc), dict(eth)
cb, ce = [bm[d] for d in dates], [em[d] for d in dates]
i18 = next(i for i, d in enumerate(dates) if d >= "2018-01-01")
def strat(name):
    spec = tb.CONFIGS[name]; rules, vt = spec[0], spec[1]; cap = spec[2] if len(spec) > 2 else 1.0
    return [0.5 * (a + b) for a, b in zip(tb.series(cb, rules, vt, cap), tb.series(ce, rules, vt, cap))][i18:]
def maxdd(xs):
    eq, pk, dd = 1.0, 1.0, 0.0
    for x in xs: eq *= 1 + x; pk = max(pk, eq); dd = min(dd, eq / pk - 1)
    return dd, eq
def longest_underwater(xs):
    eq, pk, run, worst = 1.0, 1.0, 0, 0
    for x in xs:
        eq *= 1 + x
        if eq >= pk: pk = eq; run = 0
        else: run += 1; worst = max(worst, run)
    return worst
print("=== A. Block bootstrap (30-day blocks, 3-year paths, 1000 sims) of each candidate's own 2018-26 daily returns")
print(f"{'config':34s} hist DD  | median DD  90th  95th  99th | P(3y return<0) | median 3y CAGR | 95th underwater days | kill suggestion (95th DD x1.1)")
for name in ["D (7 rules VT35)", "F35 (fast3 VT35)", "B35 (barbell VT35)", "B50 (barbell VT50)", "F50 (fast3 VT50)", "F50L (fast3 VT50, 1.5x cap, no funding cost)", "B50L (barbell VT50, 1.5x cap, no funding cost)"]:
    s = strat(name); n = len(s); hdd = maxdd(s)[0]
    dds, ends, uw = [], [], []
    for _ in range(1000):
        path = []
        while len(path) < 1095:
            j = random.randrange(0, n - 30); path += s[j:j + 30]
        path = path[:1095]; dd, eq = maxdd(path); dds.append(dd); ends.append(eq); uw.append(longest_underwater(path))
    dds.sort(); ends.sort(); uw.sort(); q = lambda a, p: a[int(p * (len(a) - 1))]
    print(f"{name[:34]:34s} {hdd*100:6.0f}%  | {q(dds,0.5)*100:6.0f}% {q(dds,0.10)*100:5.0f}% {q(dds,0.05)*100:5.0f}% {q(dds,0.01)*100:5.0f}% | {sum(1 for e in ends if e < 1)/len(ends)*100:5.1f}%        | {(q(ends,0.5)**(1/3)-1)*100:5.1f}%        | {q(uw,0.95):4d} d            | {q(dds,0.05)*1.1*100:5.0f}%")
print("\n=== B. Venue-price robustness: Yahoo composite vs OKX daily closes, rule-vote agreement")
def okx_daily(sym, need=3300):
    out, after = [], ""
    for _ in range(need // 100 + 2):
        if len(out) >= need: break
        u = f"https://www.okx.com/api/v5/market/history-candles?instId={sym}-USDT&bar=1Dutc&limit=100" + (f"&after={after}" if after else "")
        d = pe.get(u).get("data") or []
        if not d: break
        out += d; after = d[-1][0]
    rows = sorted([(int(x[0]), float(x[4])) for x in out if x[8] == "1"])
    return {dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime("%Y-%m-%d"): c for t, c in rows}
for sym, ym in [("BTC", bm), ("ETH", em)]:
    ok = okx_daily(sym); common = sorted(set(ok) & set(ym)); common = [d for d in common if d >= "2018-01-01"]
    cy = [ym[d] for d in common]; co = [ok[d] for d in common]
    diff = [abs(a / b - 1) for a, b in zip(cy, co)]
    print(f"{sym}: OKX history from {common[0]} ({len(common)} days). median |Yahoo/OKX-1| {sorted(diff)[len(diff)//2]*1e4:.0f} bp, 99th {sorted(diff)[int(0.99*len(diff))]*1e4:.0f} bp")
    for rn, f in {**pe.RULES, **pe.EXTRA_RULES}.items():
        a, b = f(cy), f(co); dis = sum(1 for x, y in zip(a, b) if x != y)
        print(f"   {rn:16s} votes differ on {dis} of {len(a)} days ({dis/len(a)*100:.1f}%)")
    for setname, rules in [("fast3", pe.FAST), ("barbell", pe.BARBELL)]:
        sa = [sum(pe.RULES[k](cy)[i] for k in rules) for i in range(len(cy))]; sb = [sum(pe.RULES[k](co)[i] for k in rules) for i in range(len(co))]
        dis = sum(1 for x, y in zip(sa, sb) if x != y); big = sum(1 for x, y in zip(sa, sb) if abs(x - y) >= 2)
        print(f"   {setname} score differs {dis} days ({dis/len(sa)*100:.1f}%), by 2+ votes {big} days")
