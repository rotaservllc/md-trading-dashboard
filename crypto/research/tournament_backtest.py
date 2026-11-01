#!/usr/bin/env python3
"""Weekly re-test for the crypto lane tournament. Self-contained: fetches BTC/ETH daily closes from Yahoo (2017+), backtests
every candidate config with the SAME rule functions the paper engine trades (crypto/paper_engine.py), and prints the
in-sample (2018-22) / out-of-sample (2023-now) table plus the trailing 30/90-day figures. Also reads crypto/state.json
and scores the live paper lanes. Read-only; writes crypto/research/latest_tournament.md for the weekly review.
Usage: python3 crypto/research/tournament_backtest.py [--no-fetch]"""
import json, math, os, sys, urllib.request, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "crypto"))
import paper_engine as pe  # noqa: E402
DATA = os.path.join(HERE, "data"); os.makedirs(DATA, exist_ok=True)
CASH = 0.035; FEE = pe.PARAMS["feeSide"]; LAG = 2

def fetch(sym):
    p1 = int(dt.datetime(2017, 1, 1, tzinfo=dt.timezone.utc).timestamp()); p2 = int(dt.datetime.now(dt.timezone.utc).timestamp())
    j = pe.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}-USD?period1={p1}&period2={p2}&interval=1d")["chart"]["result"][0]
    ts, cl = j["timestamp"], j["indicators"]["quote"][0]["close"]
    rows = [(dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d"), c) for t, c in zip(ts, cl) if c is not None]
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"); rows = [r for r in rows if r[0] < today]
    with open(os.path.join(DATA, f"{sym}.csv"), "w") as f: f.write("date,close\n" + "\n".join(f"{d},{c}" for d, c in rows))
    return rows

def load(sym, refetch=True):
    fp = os.path.join(DATA, f"{sym}.csv")
    if refetch or not os.path.exists(fp):
        try: return fetch(sym)
        except Exception as ex: print("fetch", sym, ex, file=sys.stderr)
    return [(l.split(",")[0], float(l.split(",")[1])) for l in open(fp).read().splitlines()[1:]]

CONFIGS = {  # name: (rule names, vol target or None)
    "D (7 rules VT35)": (list(pe.RULES), 0.35), "D50 (7 rules VT50)": (list(pe.RULES), 0.50), "D70": (list(pe.RULES), 0.70), "D00 (no cap)": (list(pe.RULES), None),
    "F35 (fast3 VT35)": (pe.FAST, 0.35), "F50 (fast3 VT50)": (pe.FAST, 0.50), "F70": (pe.FAST, 0.70), "F00": (pe.FAST, None),
    "B35 (barbell VT35)": (pe.BARBELL, 0.35), "B50 (barbell VT50)": (pe.BARBELL, 0.50), "B70 (barbell VT70)": (pe.BARBELL, 0.70),
    "slow4 VT35": ([k for k in pe.RULES if k not in pe.FAST], 0.35), "slow4 VT50": ([k for k in pe.RULES if k not in pe.FAST], 0.50),
}

def series(closes, rules, vt):
    fired = [pe.RULES[k](closes) for k in rules]
    n = len(closes); pos = [0.0] * n; out = [0.0] * n
    for i in range(1, n):
        score = sum(f[i] for f in fired) / len(fired)
        if i >= pe.PARAMS["volWindow"]:
            rets = [closes[k] / closes[k - 1] - 1 for k in range(i - pe.PARAMS["volWindow"] + 1, i + 1)]
            mu = sum(rets) / len(rets); rv = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(365)
        else: rv = None
        sc = 1.0 if (vt is None or not rv) else min(1.0, vt / rv)
        pos[i] = score * sc if rv else 0.0
    for i in range(LAG + 1, n):
        w, wp = pos[i - LAG], pos[i - LAG - 1]
        out[i] = w * (closes[i] / closes[i - 1] - 1) - abs(w - wp) * FEE + max(0.0, 1 - w) * CASH / 365
    return out

def stats(xs):
    if len(xs) < 30: return (float("nan"),) * 3
    eq, pk, dd = 1.0, 1.0, 0.0
    for x in xs:
        eq *= 1 + x; pk = max(pk, eq); dd = min(dd, eq / pk - 1)
    yrs = len(xs) / 365.25; cg = eq ** (1 / yrs) - 1
    mu = sum(xs) / len(xs); sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / (len(xs) - 1)) * math.sqrt(365)
    return cg, dd, (cg / sd if sd else float("nan"))

def main():
    refetch = "--no-fetch" not in sys.argv
    btc, eth = load("BTC", refetch), load("ETH", refetch)
    dates = sorted(set(d for d, _ in btc) & set(d for d, _ in eth)); bm, em = dict(btc), dict(eth)
    cb, ce = [bm[d] for d in dates], [em[d] for d in dates]
    lines = [f"# Crypto lane tournament re-test, {dates[-1]} (data Yahoo, cash {CASH*100:.1f}%, lag {LAG}d, fee {FEE*100:.1f}%/side)", "",
             "| config | 2018-now CAGR / maxDD / Sharpe | 2018-22 | 2023-now CAGR / maxDD / Sharpe | last 90d | last 30d |", "|---|---|---|---|---|---|"]
    ranked = []
    for name, (rules, vt) in CONFIGS.items():
        s = [0.5 * (a + b) for a, b in zip(series(cb, rules, vt), series(ce, rules, vt))]
        idx = {d: i for i, d in enumerate(dates)}
        i18 = next(i for i, d in enumerate(dates) if d >= "2018-01-01"); i23 = next(i for i, d in enumerate(dates) if d >= "2023-01-01")
        full, ins, oos = stats(s[i18:]), stats(s[i18:i23]), stats(s[i23:])
        r90 = math.prod(1 + x for x in s[-90:]) - 1; r30 = math.prod(1 + x for x in s[-30:]) - 1
        f = lambda t: f"{t[0]*100:.1f}% / {t[1]*100:.0f}% / {t[2]:.2f}"
        lines.append(f"| {name} | {f(full)} | {f(ins)} | {f(oos)} | {r90*100:+.1f}% | {r30*100:+.1f}% |")
        ranked.append((oos[2], oos[0], name))
    ranked.sort(reverse=True)
    lines += ["", "Both-halves rule: a config qualifies only if Sharpe > 0 in both halves and OOS Sharpe >= lane D's.",
              f"Best OOS Sharpe: {ranked[0][2]} ({ranked[0][0]:.2f}, CAGR {ranked[0][1]*100:.1f}%)."]
    st = os.path.join(ROOT, "crypto", "state.json")
    if os.path.exists(st):
        S = json.load(open(st)); L = S.get("lanes", {})
        lines += ["", f"## Live paper lanes, day {S.get('days')} (start {S.get('start')})", "| lane | equity | return | peak DD | trades |", "|---|---|---|---|---|"]
        for k in sorted(L, key=lambda k: -L[k]["eq"]):
            v = L[k]; lines.append(f"| {k} | ${v['eq']:,.0f} | {(v['eq']/pe.PARAMS['laneUSD']-1)*100:+.2f}% | {(v['eq']/v.get('peak',v['eq'])-1)*100:.1f}% | {v.get('trades',0)} |")
    out = "\n".join(lines); print(out)
    open(os.path.join(HERE, "latest_tournament.md"), "w").write(out + "\n")

if __name__ == "__main__": main()
