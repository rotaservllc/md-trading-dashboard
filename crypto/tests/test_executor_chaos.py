#!/usr/bin/env python3
"""Replay and chaos tests for crypto/executor.py against a scripted fake OKX. No network, no secrets, no real orders.
Run: python3 crypto/tests/test_executor_chaos.py   (exit 1 on any failure). Each scenario builds a fake exchange, a fake
state.json target, runs executor.main() with time.sleep stubbed, and asserts on orders sent, fills, exec_state and halts."""
import os, sys, json, types, tempfile, importlib, traceback
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); sys.path.insert(0, ROOT)
os.environ.update(OKX_DEMO_KEY="k", OKX_DEMO_SECRET="s", OKX_DEMO_PASSPHRASE="p", EXEC_LANE="D")
import paper_engine as pe
pe.send_telegram = lambda text: TG.append(text)
TG = []
import executor as ex

class FakeOKX:
    """Minimal OKX spot simulator. Script behaviours via flags."""
    def __init__(self, bal, bid=75000.0, ask=75001.0, ebid=2100.0, eask=2100.1):
        self.bal = dict(bal); self.px = {"BTC-USDT": [bid, ask], "ETH-USDT": [ebid, eask]}
        self.orders = {}; self.sent = []; self.fill_fraction = 1.0; self.reject_code = None; self.down = False
        self.amend_fail = False; self.ioc_fill = 1.0; self.move_after_place = 0.0; self.no_buidl = True
    def call(self, method, path, body=None, auth=True):
        if self.down: raise RuntimeError("HTTP 503 /api: exchange down")
        if "public/instruments" in path:
            inst = path.split("instId=")[1]
            if inst.startswith("BUIDL") and self.no_buidl: raise RuntimeError("OKX code 51001: Instrument ID doesn't exist")
            lot = {"BTC-USDT": "0.00000001", "ETH-USDT": "0.000001"}.get(inst, "0.0001"); tick = {"BTC-USDT": "0.1", "ETH-USDT": "0.01"}.get(inst, "0.0001")
            return [dict(lotSz=lot, tickSz=tick, minSz="0.00001")]
        if "market/ticker" in path:
            inst = path.split("instId=")[1]; b, a = self.px[inst]; return [dict(bidPx=str(b), askPx=str(a), last=str((a + b) / 2))]
        if "account/balance" in path:
            return [dict(details=[dict(ccy=k, availBal=str(v)) for k, v in self.bal.items()])]
        if path.endswith("/trade/order") and method == "POST":
            self.sent.append(dict(body))
            if self.reject_code: return self._err(self.reject_code)
            inst, side, sz, cl, typ = body["instId"], body["side"], float(body["sz"]), body["clOrdId"], body["ordType"]
            if cl in self.orders: return self._err("51016")   # duplicate clOrdId
            coin = inst.split("-")[0]
            if side == "sell" and sz > self.bal.get(coin, 0) + 1e-12: return self._err("51008")
            frac = self.ioc_fill if typ == "ioc" else self.fill_fraction
            filled = sz * frac; pxf = float(body["px"])
            self.orders[cl] = dict(instId=inst, state="filled" if frac >= 1 else ("partially_filled" if frac > 0 else "live"), accFillSz=f"{filled:.8f}", avgPx=f"{pxf}" if filled else "", sz=sz, side=side)
            if filled:
                if side == "buy": self.bal[coin] = self.bal.get(coin, 0) + filled; self.bal["USDT"] -= filled * pxf
                else: self.bal[coin] = self.bal.get(coin, 0) - filled; self.bal["USDT"] += filled * pxf
            if self.move_after_place: self.px[inst] = [p * (1 + self.move_after_place) for p in self.px[inst]]
            return [dict(clOrdId=cl, ordId="1", sCode="0")]
        if "trade/order?" in path and method == "GET":
            cl = path.split("clOrdId=")[1]
            if cl not in self.orders: raise RuntimeError("OKX code 51603: Order does not exist")
            return [self.orders[cl]]
        if path.endswith("/trade/amend-order"):
            if self.amend_fail: raise RuntimeError("OKX code 51400: amend failed")
            return [dict(sCode="0")]
        if path.endswith("/trade/cancel-order"):
            o = self.orders.get(body["clOrdId"])
            if o and o["state"] != "filled": o["state"] = "canceled"
            return [dict(sCode="0")]
        raise RuntimeError("unexpected path " + path)
    def _err(self, code): raise RuntimeError(f"OKX /api/v5/trade/order code 1: All operations failed sCode {code}")

def scenario(name, bal, wBTC, wETH, setup=None, prev_exec=None, expect=None):
    d = tempfile.mkdtemp(); ex.STATE = os.path.join(d, "state.json"); ex.EXEC = os.path.join(d, "exec_state.json"); ex.FILLS = os.path.join(d, "fills.csv")
    json.dump(dict(lastDate="2026-11-11", lanes={"D": dict(w=dict(BTC=wBTC, ETH=wETH), eq=12000)}), open(ex.STATE, "w"))
    if prev_exec: json.dump(prev_exec, open(ex.EXEC, "w"))
    fake = FakeOKX(bal); setup and setup(fake)
    class FakeTime:   # each call to time() advances 30 s, so the 15-minute chase loop ends after ~30 iterations
        t = 0.0
        def time(self): FakeTime.t += 30.0; return FakeTime.t
        def sleep(self, s): pass
    ex.time = FakeTime(); ex.okx = fake.call; TG.clear(); ex.log_lines.clear()
    err = None
    try: ex.main()
    except Exception as e: err = e
    st = json.load(open(ex.EXEC)) if os.path.exists(ex.EXEC) else {}
    try:
        expect(fake, st, err, TG)
        print(f"PASS  {name}")
        return True
    except AssertionError as e:
        print(f"FAIL  {name}: {e}"); print("   sent:", fake.sent); print("   exec_state:", {k: st.get(k) for k in ('halted', 'positions_usd', 'targets_usd', 'gap_usd')}); print("   err:", err); return False

def assert_(cond, msg):
    if not cond: raise AssertionError(msg)

results = []
# 1. normal buy from cash
results.append(scenario("buy BTC and ETH from cash", dict(USDT=12000.0), 0.25, 0.125, expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(len(f.sent) == 2 and all(o["ordType"] == "post_only" for o in f.sent), "two post-only orders"),
    assert_(abs(s["positions_usd"]["BTC"] - 3000) < 5 and abs(s["positions_usd"]["ETH"] - 1500) < 5, "positions at target"), assert_(not s["halted"], "not halted"))))
# 2. full exit sells exactly the balance (9 Nov bug)
results.append(scenario("full exit sells exact balance", dict(USDT=5000.0, BTC=0.04, ETH=0.364414), 0.0685, 0.0, expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(any(o["instId"] == "ETH-USDT" and o["side"] == "sell" and abs(float(o["sz"]) - 0.364414) < 1e-9 for o in f.sent), "ETH sell equals balance"),
    assert_(s["positions_usd"]["ETH"] == 0, "ETH flat"), assert_(not s["halted"], "not halted"))))
# 3. rerun same day does nothing
results.append(scenario("rerun same day is a no-op", dict(USDT=12000.0), 0.25, 0.125, prev_exec=dict(lastDate="2026-11-11", halted=False, days=3), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(len(f.sent) == 0, "no orders on rerun"))))
# 4. halted state blocks all orders
results.append(scenario("kill switch blocks orders", dict(USDT=12000.0), 0.25, 0.125, prev_exec=dict(lastDate="2026-11-10", halted=True, days=3), expect=lambda f, s, e, tg: (
    assert_(len(f.sent) == 0, "no orders while halted"), assert_(any("halted" in t.lower() for t in tg), "telegram halt notice"))))
# 5. post-only never fills, IOC remainder fills
results.append(scenario("post-only unfilled -> IOC remainder", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: setattr(f, "fill_fraction", 0.0), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(any(o["ordType"] == "ioc" for o in f.sent), "IOC sent"), assert_(abs(s["positions_usd"]["BTC"] - 3000) < 5, "filled via IOC"), assert_(not s["halted"], "not halted"))))
# 6. partial post-only fill, IOC for the rest
results.append(scenario("partial fill then IOC", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: setattr(f, "fill_fraction", 0.4), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(sum(1 for o in f.sent if o["ordType"] == "ioc") == 1, "one IOC"), assert_(abs(s["positions_usd"]["BTC"] - 3000) < 5, "complete"))))
# 7. nothing fills at all -> gap -> halt
results.append(scenario("no fills at all -> halt", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: (setattr(f, "fill_fraction", 0.0), setattr(f, "ioc_fill", 0.0)), expect=lambda f, s, e, tg: (
    assert_(s.get("halted") is True, "halted on 25% gap"), assert_(any("HALT" in t for t in tg), "telegram says halted"))))
# 8. exchange down -> failure alert, no state written, no halt flag set
results.append(scenario("exchange down", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: setattr(f, "down", True), expect=lambda f, s, e, tg: (
    assert_(e is not None, "raises"), assert_(len(f.sent) == 0, "no orders"), assert_(s == {}, "no exec_state written"))))
# 9. order rejected (unknown code) -> failure, no silent continue
results.append(scenario("order rejected", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: setattr(f, "reject_code", "51000"), expect=lambda f, s, e, tg: (
    assert_(e is not None, "raises on rejection"), assert_(s == {}, "no exec_state written"))))
# 10. amend fails mid-chase -> falls through to cancel + IOC
results.append(scenario("amend fails -> cancel + IOC", dict(USDT=12000.0), 0.25, 0.0, setup=lambda f: (setattr(f, "fill_fraction", 0.0), setattr(f, "amend_fail", True)), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(any(o["ordType"] == "ioc" for o in f.sent), "IOC after amend failure"), assert_(abs(s["positions_usd"]["BTC"] - 3000) < 5, "complete"))))
# 11. 15% price gap on a held position: $450 gap is 3.75% of the lane, inside the 5% band -> no trade, and no false halt (kill switch only checks after trading)
results.append(scenario("price gap inside band -> no trade, no halt", dict(USDT=9000.0, BTC=0.04), 0.25, 0.0, setup=lambda f: f.px.update({"BTC-USDT": [63750.0, 63751.0]}), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(len(f.sent) == 0, "no orders inside band"), assert_(not s["halted"], "not halted"))))
# 13. 25% price gap on a held position: $750 gap is 6.25% of the lane -> rebalance buy
results.append(scenario("price gap beyond band -> rebalance", dict(USDT=9000.0, BTC=0.04), 0.25, 0.0, setup=lambda f: f.px.update({"BTC-USDT": [56250.0, 56251.0]}), expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(len(f.sent) == 1 and f.sent[0]["side"] == "buy", "one rebalance buy"), assert_(abs(s["positions_usd"]["BTC"] - 3000) < 5, "back at target"))))
# 12. within band -> no orders
results.append(scenario("within 5% band -> no orders", dict(USDT=9000.0, BTC=0.0395), 0.25, 0.0, expect=lambda f, s, e, tg: (
    assert_(e is None, f"error {e}"), assert_(len(f.sent) == 0, "no orders"), assert_(not s["halted"], "not halted"))))

n_fail = sum(1 for r in results if not r)
print(f"\n{len(results) - n_fail} passed, {n_fail} failed")
sys.exit(1 if n_fail else 0)
