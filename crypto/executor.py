#!/usr/bin/env python3
"""Crypto lane executor (Executor_Spec_v1, 1 Nov 2026). Spot only, OKX demo (x-simulated-trading: 1) until the Charter says live.
Reads crypto/state.json (lane target weights), compares with OKX spot balances, trades the difference with post-only limits at the touch,
re-priced every 60 s for up to 15 min, then IOC at the far touch for the remainder. Never market orders. Idle cash held as BUIDL.
Reconciles after the window into crypto/fills.csv and crypto/exec_state.json. Kill switch: halted=true stops all orders until a human edits it.
Env: OKX_DEMO_KEY, OKX_DEMO_SECRET, OKX_DEMO_PASSPHRASE, EXEC_LANE (default D), EXEC_LIVE=1 switches off the demo header (never set by the
workflow until the Charter go-live), TELEGRAM_BOT_TOKEN/CHAT_ID. Flags: --dry (no orders, print plan), --reconcile-only.
Deterministic clOrdId = md<yyyymmdd><coin><side><n> so a rerun on the same day finds its own orders instead of duplicating them."""
import base64, csv, datetime as dt, hashlib, hmac, json, os, sys, time, urllib.request, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import paper_engine as pe  # noqa: E402  (shared PARAMS, send_telegram)
STATE = os.path.join(HERE, "state.json"); EXEC = os.path.join(HERE, "exec_state.json"); FILLS = os.path.join(HERE, "fills.csv")
BASE = "https://openapi.okx.com" if not os.environ.get("EXEC_LIVE") else "https://www.okx.com"
LANE = os.environ.get("EXEC_LANE", "D"); COINS = ["BTC", "ETH"]; CASH_ASSET = "BUIDL"
BAND = 0.05; WINDOW_MIN = 15; REPRICE_S = 60; MAX_DEV = 0.01; BUIDL_DEV = 0.003
KEY, SEC, PASS = (os.environ.get(k, "").strip() for k in ("OKX_DEMO_KEY", "OKX_DEMO_SECRET", "OKX_DEMO_PASSPHRASE"))
log_lines = []
def log(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log_lines.append(s)

# ---------- OKX REST ----------
def okx(method, path, body=None, auth=True):
    data = json.dumps(body) if body else ""
    now = dt.datetime.now(dt.timezone.utc); ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    hdr = {"Content-Type": "application/json", "User-Agent": "md-crypto-lane/1.0"}
    if not os.environ.get("EXEC_LIVE"): hdr["x-simulated-trading"] = "1"
    if auth:
        sign = base64.b64encode(hmac.new(SEC.encode(), (ts + method + path + data).encode(), hashlib.sha256).digest()).decode()
        hdr.update({"OK-ACCESS-KEY": KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": PASS})
    req = urllib.request.Request(BASE + path, data=data.encode() if data else None, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: j = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {path}: {e.read()[:300]}")
    if str(j.get("code")) != "0":
        raise RuntimeError(f"OKX {path} code {j.get('code')}: {j.get('msg')} {json.dumps(j.get('data'))[:300]}")
    return j["data"]

def instrument(inst):
    d = okx("GET", f"/api/v5/public/instruments?instType=SPOT&instId={inst}", auth=False)[0]
    return dict(lot=float(d["lotSz"]), tick=float(d["tickSz"]), minSz=float(d["minSz"]))
def ticker(inst):
    d = okx("GET", f"/api/v5/market/ticker?instId={inst}", auth=False)[0]
    return dict(bid=float(d["bidPx"]), ask=float(d["askPx"]), last=float(d["last"]))
def balances():
    """Total balance per ccy (available + frozen in open orders), so a live order from a killed run never shrinks 'current'."""
    d = okx("GET", "/api/v5/account/balance")[0]
    return {x["ccy"]: float(x.get("cashBal") or 0) or (float(x.get("availBal") or 0) + float(x.get("frozenBal") or 0)) for x in d.get("details", [])}
def cancel_pending(insts):
    """Cancel any open spot orders on the lane's instruments (leftovers from a killed run) before planning."""
    try: pend = okx("GET", "/api/v5/trade/orders-pending?instType=SPOT")
    except RuntimeError as e: log("orders-pending", e); return 0
    n = 0
    for o in pend:
        if o.get("instId") in insts:
            try: okx("POST", "/api/v5/trade/cancel-order", dict(instId=o["instId"], ordId=o["ordId"])); n += 1; log("cancelled leftover order", o.get("clOrdId"), o["instId"], o.get("side"), o.get("sz"))
            except RuntimeError as e: log("cancel leftover failed", e)
    return n
def rnd(x, step):
    n = max(0, -int(f"{step:e}".split("e")[1])) if step < 1 else 0
    return float(f"{(int(x / step + 1e-9) * step):.{n}f}")

# ---------- orders ----------
def place(inst, side, sz, px, cl, typ="post_only"):
    body = dict(instId=inst, tdMode="cash", side=side, ordType=typ, sz=f"{sz}", clOrdId=cl)
    if px: body["px"] = f"{px}"
    return okx("POST", "/api/v5/trade/order", body)[0]
def order(inst, cl):
    try: return okx("GET", f"/api/v5/trade/order?instId={inst}&clOrdId={cl}")[0]
    except RuntimeError as e:
        if "51603" in str(e) or "does not exist" in str(e).lower(): return None
        raise
def amend(inst, cl, px): return okx("POST", "/api/v5/trade/amend-order", dict(instId=inst, clOrdId=cl, newPx=f"{px}"))
def cancel(inst, cl):
    try: okx("POST", "/api/v5/trade/cancel-order", dict(instId=inst, clOrdId=cl))
    except RuntimeError as e: log("cancel", cl, e)

def work_order(inst, side, sz_base, meta, day, dry):
    """Post-only at the touch, re-price to the touch every REPRICE_S for WINDOW_MIN, then IOC at far touch for the remainder."""
    coin = inst.split("-")[0]; cl = f"md{day}{coin}{'B' if side == 'buy' else 'S'}1"
    t0 = ticker(inst); px = rnd(t0["bid"] if side == "buy" else t0["ask"], meta["tick"]); sz = rnd(sz_base, meta["lot"])
    if sz < meta["minSz"]: log(f"{inst} {side} size {sz} below minSz {meta['minSz']}, skip"); return dict(filled=0.0, avg=0.0, path="skip")
    log(f"{inst} {side} {sz} post_only @ {px} (bid {t0['bid']} ask {t0['ask']}) cl {cl}")
    if dry: return dict(filled=0.0, avg=0.0, path="dry")
    existing = order(inst, cl)
    if existing: log("order exists from an earlier run today:", existing.get("state"), existing.get("accFillSz"))
    else: place(inst, side, sz, px, cl)
    deadline = time.time() + WINDOW_MIN * 60
    while time.time() < deadline:
        time.sleep(REPRICE_S); o = order(inst, cl)
        if o is None: break
        if o["state"] in ("filled", "canceled"): break
        t = ticker(inst); touch = rnd(t["bid"] if side == "buy" else t["ask"], meta["tick"])
        if touch != px and abs(touch / t0["last"] - 1) < MAX_DEV:
            ok = False
            for attempt in range(3):
                try: amend(inst, cl, touch); px = touch; log(f"  re-priced to {px}"); ok = True; break
                except RuntimeError as e:
                    log(f"  amend failed (try {attempt + 1})", e)
                    if "51503" in str(e) or "51510" in str(e): break   # order already filled or cancelled: terminal
                    time.sleep(5)
            if not ok:
                o = order(inst, cl)
                if o is None or o.get("state") in ("filled", "canceled"): break
    o = order(inst, cl) or {}
    filled = float(o.get("accFillSz") or 0); avg = float(o.get("avgPx") or 0); path = "post_only"
    if o.get("state") not in ("filled", "canceled") and o: cancel(inst, cl); time.sleep(2); o = order(inst, cl) or o; filled = float(o.get("accFillSz") or 0); avg = float(o.get("avgPx") or 0)
    rem = rnd(sz - filled, meta["lot"])
    if rem >= meta["minSz"]:
        t = ticker(inst); far = rnd(t["ask"] if side == "buy" else t["bid"], meta["tick"])
        if abs(far / t0["last"] - 1) <= MAX_DEV:
            cl2 = cl[:-1] + "2"; log(f"  IOC remainder {rem} @ {far} cl {cl2}")
            if not order(inst, cl2): place(inst, side, rem, far, cl2, typ="ioc")
            time.sleep(3); o2 = order(inst, cl2) or {}
            f2 = float(o2.get("accFillSz") or 0); a2 = float(o2.get("avgPx") or 0)
            if f2 > 0: avg = (avg * filled + a2 * f2) / (filled + f2); filled += f2; path = "post_only+ioc"
        else: log(f"  far touch {far} outside {MAX_DEV*100:.0f}% band of {t0['last']}, leaving gap")
    return dict(filled=filled, avg=avg, path=path, mid=(t0["bid"] + t0["ask"]) / 2)

# ---------- main ----------
def main():
    a = sys.argv[1:]; dry = "--dry" in a
    ex = json.load(open(EXEC)) if os.path.exists(EXEC) else dict(halted=False, days=0)
    if ex.get("halted"):
        log("HALTED by kill switch; no orders. Edit exec_state.json to resume."); pe.send_telegram("⛔ Crypto executor halted, no orders placed."); return
    st = json.load(open(STATE)); day = st["lastDate"].replace("-", "")
    if ex.get("lastDate") == st["lastDate"] and "--reconcile-only" not in a and not dry:
        log("already executed for", st["lastDate"]); return
    lane = st["lanes"][LANE]; w = lane["w"]; laneUSD = pe.PARAMS["laneUSD"]
    if not KEY and not dry: raise RuntimeError("OKX secrets missing")
    bal = balances() if (KEY or not dry) else {}
    if dry and not KEY: bal = {c: 0.0 for c in COINS}; bal["USDT"] = laneUSD
    if not dry and KEY:
        if cancel_pending({f"{c}-USDT" for c in COINS} | {f"{CASH_ASSET}-USDT"}): time.sleep(2); bal = balances()
    px = {c: ticker(f"{c}-USDT") for c in COINS}; meta = {c: instrument(f"{c}-USDT") for c in COINS}
    cur = {c: bal.get(c, 0.0) * (px[c]["bid"] + px[c]["ask"]) / 2 for c in COINS}
    # lane cash ledger (lane-level equity, independent of whatever else sits in the account)
    lane_cash = ex.get("lane_cash", laneUSD - sum(cur.values()))
    tgt = {c: w.get(c, 0.0) * laneUSD for c in COINS}
    log(f"lane {LANE} {st['lastDate']} targets {tgt} current { {k: round(v) for k, v in cur.items()} } USDT {bal.get('USDT', 0):.0f} {CASH_ASSET} {bal.get(CASH_ASSET, 0):.0f}")
    plan = []
    for c in COINS:
        diff = tgt[c] - cur[c]; crossing = (tgt[c] == 0) != (cur[c] < 0.02 * laneUSD)
        if abs(diff) > BAND * laneUSD or (crossing and abs(diff) > 10):
            plan.append((c, "buy" if diff > 0 else "sell", abs(diff)))
    log("plan:", plan or "nothing to do")
    big = [p for p in plan if p[2] > 1.5 * laneUSD]
    if big and not dry:
        ex.update(halted=True, halt_reason=f"order larger than 1.5x lane: {big}", lastRun=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        json.dump(ex, open(EXEC, "w"), indent=1); pe.send_telegram(f"⛔ Crypto executor halted: planned order larger than 1.5x the lane {big}. Check the account."); return
    # cash leg: raise USDT from BUIDL for buys
    need = sum(usd for _, s, usd in plan if s == "buy") - bal.get("USDT", 0)
    buidl_ok = True
    try: bm = instrument(f"{CASH_ASSET}-USDT"); bt = ticker(f"{CASH_ASSET}-USDT")
    except Exception as e: buidl_ok = False; log(f"{CASH_ASSET}-USDT not on this book ({e}); cash leg simulated")
    if need > 0 and buidl_ok and not dry:
        if abs(bt["bid"] - 1) > BUIDL_DEV: log(f"{CASH_ASSET} bid {bt['bid']} off par, abort cash raise"); pe.send_telegram(f"⚠️ {CASH_ASSET} bid {bt['bid']} off par, executor skipped buys"); plan = [p for p in plan if p[1] != "buy"]
        else:
            r = work_order(f"{CASH_ASSET}-USDT", "sell", min(need * 1.002, bal.get(CASH_ASSET, 0)), bm, day, dry); log("cash raise", r)
    fills = []
    for c, side, usd in plan:
        p = px[c]["ask" if side == "buy" else "bid"]; qty = usd / p
        if side == "sell": qty = min(qty, bal.get(c, 0.0))          # never sell more than the available balance (OKX 51008)
        if tgt[c] == 0 and side == "sell": qty = bal.get(c, 0.0)     # full exit: clear the position exactly
        r = work_order(f"{c}-USDT", side, qty, meta[c], day, dry)
        slip = ((r["avg"] / r.get("mid", p) - 1) * (1 if side == "buy" else -1) * 1e4) if r.get("avg") else None
        sig_close = st["analysis"][c]["close"] if st.get("analysis") else None
        shortfall = ((r["avg"] / sig_close - 1) * (1 if side == "buy" else -1) * 1e4) if (r.get("avg") and sig_close) else None
        fills.append(dict(date=st["lastDate"], coin=c, side=side, qty=r["filled"], avg_px=r["avg"], mid_at_signal=r.get("mid", p), slippage_bp=None if slip is None else round(slip, 1), path=r["path"], target_usd=round(usd),
                          signal_close=sig_close, shortfall_bp=None if shortfall is None else round(shortfall, 1)))
        if r["filled"]: lane_cash += (-1 if side == "buy" else 1) * r["filled"] * r["avg"]
    # park proceeds in BUIDL
    if not dry and buidl_ok:
        time.sleep(3); b2 = balances(); buffer = 0.25 * laneUSD   # working USDT buffer for the next day's likely buy
        spare = min(b2.get("USDT", 0) - buffer, laneUSD)          # never park more than the lane
        if spare > 50 and abs(bt["ask"] - 1) <= BUIDL_DEV: log("park", work_order(f"{CASH_ASSET}-USDT", "buy", spare / bt["ask"], bm, day, dry))
    # reconcile
    b3 = balances() if not dry else bal
    px2 = {c: ticker(f"{c}-USDT") for c in COINS} if not dry else px   # revalue at fresh prices so a move during the window is not read as a gap
    cur2 = {c: b3.get(c, 0.0) * (px2[c]["bid"] + px2[c]["ask"]) / 2 for c in COINS}
    tgt2 = {c: tgt[c] * ((px2[c]["bid"] + px2[c]["ask"]) / (px[c]["bid"] + px[c]["ask"])) for c in COINS}
    gap = {c: round(cur2[c] - tgt2[c]) for c in COINS}; worst = max(abs(v) for v in gap.values()) if gap else 0
    halted = worst > 0.02 * laneUSD and bool(plan) and not dry
    lane_equity = lane_cash + sum(cur2.values()); paper_eq = lane.get("eq")
    ex.update(lastDate=st["lastDate"], lastRun=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), lane=LANE, demo=not os.environ.get("EXEC_LIVE"),
              positions_usd={c: round(cur2[c]) for c in COINS}, targets_usd={c: round(v) for c, v in tgt.items()}, gap_usd=gap,
              usdt=round(b3.get("USDT", 0), 2), buidl=round(b3.get(CASH_ASSET, 0), 2), halted=halted, days=ex.get("days", 0) + 1, fills_today=fills,
              lane_cash=round(lane_cash, 2), lane_equity=round(lane_equity, 2), paper_equity=paper_eq, live_vs_paper_pts=None if not paper_eq else round((lane_equity - paper_eq) / laneUSD * 100, 2))
    if not dry:
        json.dump(ex, open(EXEC, "w"), indent=1)
        new = not os.path.exists(FILLS)
        with open(FILLS, "a", newline="") as f:
            wri = csv.DictWriter(f, fieldnames=["date", "coin", "side", "qty", "avg_px", "mid_at_signal", "slippage_bp", "path", "target_usd", "signal_close", "shortfall_bp"], extrasaction="ignore")
            if new: wri.writeheader()
            for r in fills: wri.writerow(r)
    msg = (f"🤖 <b>Crypto executor {'DEMO' if ex['demo'] else 'LIVE'} · lane {LANE} · {st['lastDate']}</b>\n"
           + ("\n".join(f"{f['coin']} {f['side']} {f['qty']} @ {f['avg_px']:.2f} ({f['path']}, slip {f['slippage_bp']} bp)" for f in fills) or "no trades (within band)") + "\n"
           + f"Positions ${ex['positions_usd']['BTC']:,} BTC · ${ex['positions_usd']['ETH']:,} ETH · targets ${ex['targets_usd']['BTC']:,} / ${ex['targets_usd']['ETH']:,} · gap {gap}\n"
           + f"Lane equity ${lane_equity:,.0f} vs paper ${paper_eq or 0:,.0f} ({ex['live_vs_paper_pts'] if ex['live_vs_paper_pts'] is not None else 'n/a'} pts) · USDT ${ex['usdt']:,.0f} · {CASH_ASSET} {ex['buidl']:,.0f}" + (" · ⛔ HALTED: gap > 2% of lane" if halted else ""))
    log(msg)
    if not dry:
        pe.send_telegram(msg)
        try: import dash_export; dash_export.build()
        except Exception as ex2: log("dash_export", ex2)

if __name__ == "__main__":
    try: main()
    except Exception as ex:
        print("FAILED", ex, file=sys.stderr)
        try:   # a crash after orders were sent must leave a visible mark and block the next run until a human looks
            st_ = json.load(open(EXEC)) if os.path.exists(EXEC) else {}
            if any(l.startswith(("BTC-USDT", "ETH-USDT", "BUIDL-USDT")) and "post_only" in l for l in log_lines):
                st_.update(halted=True, halt_reason=f"run crashed after sending orders: {str(ex)[:200]}", lastRun=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")); json.dump(st_, open(EXEC, "w"), indent=1)
        except Exception as e2: print("could not write halt", e2, file=sys.stderr)
        if "--dry" not in sys.argv: pe.send_telegram(f"⚠️ <b>Crypto executor</b> failed: {str(ex)[:300]}")
        sys.exit(1)
