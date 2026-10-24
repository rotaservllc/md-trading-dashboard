// lib/crypto-core.mjs — Crypto Lane paper engine (Charter v1.1, approved 24 Oct 2026). BUILD 2026-10-24 v1
// Signal-only paper test: four lanes marked daily at the 00:00 UTC close on a hypothetical $12,000 each.
//   D  main lane: 7-rule trend ensemble on BTC/ETH spot, 50/50, 35% vol target on 30d realised vol, long or flat.
//   E  paper variant: D with exposure halved when the coin is >15% below its 1-year high (rejected OOS, kept for the record).
//   C  carry: long spot / short perp 1x on half the lane, in when 7d avg annualised funding > 8%, out < 3%.
//   S  short (paper only, written kill rule): 1x short when the ensemble score is 0, vol-scaled. Kill if Sharpe < 0 after 12 weeks.
//   R  rotation (paper only): top-10 universe, same ensemble per coin, 1/10 budget each, active only when BTC/ETH composite score >= 0.5.
// Rules are a straight port of Finance-MD/Crypto/backtest_trend.py + backtest_overlays.py. Edit RULES/PARAMS in writing only.
import { getStore } from '@netlify/blobs';
import { sendTelegram } from './scan-core.mjs';

export const PARAMS = {
  laneUSD: 12000, volTarget: 0.35, volWindow: 30, band: 0.05, feeSide: 0.002, altFeeSide: 0.0035, perpFeeSide: 0.0025,
  carryIn: 0.08, carryOut: 0.03, drawdownDerisk: 0.15,
  universe: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'ZEC', 'DOGE', 'LINK', 'XMR'],   // CMC top-10 ex stables/wrapped, snapshot 4 Oct 2026; refresh quarterly in writing
  start: '2026-10-24',
};
const UA = { 'User-Agent': 'Mozilla/5.0' };

// ---------- data ----------
async function okxCandles(inst, need = 420) {
  // OKX returns newest first, max 100 per page; paginate with `after` (ts). bar=1Dutc = UTC daily.
  const out = []; let after = '';
  for (let i = 0; i < 6 && out.length < need; i++) {
    const u = `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`;
    const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(`okx ${inst} ${r.status}`);
    const d = (await r.json()).data || []; if (!d.length) break;
    out.push(...d); after = d.at(-1)[0];
  }
  // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]; keep only confirmed candles, oldest first
  const rows = out.filter(x => x[8] === '1').map(x => ({ t: +x[0], c: +x[4] })).sort((a, b) => a.t - b.t);
  return { dates: rows.map(x => new Date(x.t).toISOString().slice(0, 10)), closes: rows.map(x => x.c), src: 'okx' };
}
async function yfCandles(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
  const d = (await r.json()).chart?.result?.[0];
  const ts = d?.timestamp || [], cl = d?.indicators?.quote?.[0]?.close || [];
  const rows = ts.map((t, i) => ({ t, c: cl[i] })).filter(x => x.c != null);
  // drop today's partial candle (Yahoo includes the live day)
  const today = new Date().toISOString().slice(0, 10);
  const keep = rows.filter(x => new Date(x.t * 1000).toISOString().slice(0, 10) < today);
  return { dates: keep.map(x => new Date(x.t * 1000).toISOString().slice(0, 10)), closes: keep.map(x => x.c), src: 'yahoo' };
}
export async function candles(sym) {
  try { const c = await okxCandles(`${sym}-USDT`); if (c.closes.length >= 380) return c; } catch (e) { console.warn('okx', sym, e.message); }
  return yfCandles(`${sym}-USD`);
}
async function okxFunding(inst) {
  // last ~7 days of 8h funding (21 payments) + current; rates are per 8h.
  const r = await fetch(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=24`, { headers: UA });
  if (!r.ok) throw new Error(`okx funding ${inst} ${r.status}`);
  const d = (await r.json()).data || [];
  const rates = d.map(x => +x.fundingRate).filter(Number.isFinite);
  const ann7 = rates.length ? rates.slice(0, 21).reduce((a, b) => a + b, 0) / Math.min(rates.length, 21) * 3 * 365 : null;
  const day = rates.slice(0, 3).reduce((a, b) => a + b, 0);   // last three 8h payments = one day of funding
  return { ann7, last: rates[0] ?? null, day, n: rates.length };
}

// ---------- rules (port of backtest_trend.py) ----------
const sma = (a, n, i) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
const maxPrev = (a, n, i) => { if (i < n) return null; let m = -Infinity; for (let k = i - n; k < i; k++) if (a[k] > m) m = a[k]; return m; };
const minPrev = (a, n, i) => { if (i < n) return null; let m = Infinity; for (let k = i - n; k < i; k++) if (a[k] < m) m = a[k]; return m; };
function donchian(c, nIn, nOut) { // stateful: 1 when close > prior nIn-day high, 0 when close < prior nOut-day low, else carry
  const p = new Array(c.length).fill(0); let s = 0;
  for (let i = 0; i < c.length; i++) { const hi = maxPrev(c, nIn, i), lo = minPrev(c, nOut, i); if (hi != null && c[i] > hi) s = 1; else if (lo != null && c[i] < lo) s = 0; p[i] = s; }
  return p;
}
export const RULES = {
  'SMA100 rising': c => c.map((x, i) => { const m = sma(c, 100, i), m10 = i >= 10 ? sma(c, 100, i - 10) : null; return m != null && m10 != null && x > m && m > m10 ? 1 : 0; }),
  'Donchian 100/50': c => donchian(c, 100, 50),
  'Donchian 50/25': c => donchian(c, 50, 25),
  'SMA200': c => c.map((x, i) => { const m = sma(c, 200, i); return m != null && x > m ? 1 : 0; }),
  'Donchian 20/10': c => donchian(c, 20, 10),
  'Donchian 30/15': c => donchian(c, 30, 15),
  'TSMOM 30': c => c.map((x, i) => i >= 30 && x > c[i - 30] ? 1 : 0),
};
export function analyse(closes) {
  const i = closes.length - 1;
  const fired = Object.entries(RULES).map(([k, f]) => [k, f(closes)[i]]);
  const score = fired.reduce((a, [, v]) => a + v, 0) / fired.length;
  const rets = []; for (let k = i - PARAMS.volWindow + 1; k <= i; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const rv = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)) * Math.sqrt(365);
  const scale = Math.min(1, PARAMS.volTarget / rv);
  const hi1y = Math.max(...closes.slice(-365));
  const dd = closes[i] / hi1y - 1;
  return { close: closes[i], score, fired: Object.fromEntries(fired), rv, scale, hi1y, dd, wD: score * scale, wE: score * scale * (dd < -PARAMS.drawdownDerisk ? 0.5 : 1), wS: score === 0 ? -scale : 0 };
}

// ---------- paper ledger ----------
const r4 = x => Math.round(x * 1e4) / 1e4;
// band: always act on entries/exits (zero crossings); otherwise only when the change exceeds `band` of the lane
function applyBand(cur = 0, tgt) { return (cur === 0) !== (tgt === 0) || Math.sign(cur) !== Math.sign(tgt) || Math.abs(tgt - cur) > PARAMS.band ? tgt : cur; }
function laneStep(lane, newW, px, prevPx, fee) {
  // mark yesterday's weights on today's return, then move to new weights (band applied) and pay costs on the change
  let ret = 0; for (const k of Object.keys(newW)) { const w = lane.w?.[k] ?? 0; if (prevPx[k] && px[k]) ret += w * (px[k] / prevPx[k] - 1); }
  const w2 = {}; let turn = 0;
  for (const k of Object.keys(newW)) { const cur = lane.w?.[k] ?? 0; w2[k] = r4(applyBand(cur, newW[k])); turn += Math.abs(w2[k] - cur); }
  const cost = turn * (typeof fee === 'function' ? fee() : fee);
  const eq = (lane.eq ?? PARAMS.laneUSD) * (1 + ret - cost);
  const peak = Math.max(lane.peak ?? PARAMS.laneUSD, eq);
  return { ...lane, w: w2, eq: Math.round(eq * 100) / 100, peak, ret: r4(ret - cost), trades: (lane.trades ?? 0) + (turn > 0 ? 1 : 0), turnover: r4((lane.turnover ?? 0) + turn) };
}

export async function runCrypto({ force = false, status = false, quiet = false } = {}) {
  const store = getStore({ name: 'crypto-paper', consistency: 'strong' });
  const prev = (await store.get('state', { type: 'json' })) || { lanes: {}, ledger: [] };
  if (status) return { ok: true, params: PARAMS, state: prev };
  try {
    const [btc, eth] = await Promise.all([candles('BTC'), candles('ETH')]);
    const date = btc.dates.at(-1);
    if (!force && prev.lastDate === date) return { ok: true, skipped: 'already marked ' + date, state: prev };
    const A = { BTC: analyse(btc.closes), ETH: analyse(eth.closes) };
    const px = { BTC: A.BTC.close, ETH: A.ETH.close }, prevPx = prev.px || px;
    let funding = {}; try { const [fb, fe] = await Promise.all([okxFunding('BTC-USDT-SWAP'), okxFunding('ETH-USDT-SWAP')]); funding = { BTC: fb, ETH: fe }; } catch (e) { console.warn('funding', e.message); }

    // lanes D, E, S on BTC/ETH
    const lanes = { ...prev.lanes };
    lanes.D = laneStep(lanes.D || {}, { BTC: A.BTC.wD / 2, ETH: A.ETH.wD / 2 }, px, prevPx, PARAMS.feeSide);
    lanes.E = laneStep(lanes.E || {}, { BTC: A.BTC.wE / 2, ETH: A.ETH.wE / 2 }, px, prevPx, PARAMS.feeSide);
    lanes.S = laneStep(lanes.S || {}, { BTC: A.BTC.wS / 2, ETH: A.ETH.wS / 2 }, px, prevPx, PARAMS.perpFeeSide);
    // carry: gated on 7d avg annualised funding; P&L = funding received on the hedged half (notional = 0.5 lane per coin in, split 50/50)
    const C = lanes.C || { in: {}, eq: PARAMS.laneUSD, peak: PARAMS.laneUSD, trades: 0 };
    let cret = 0, cturn = 0; const inNow = {};
    for (const k of ['BTC', 'ETH']) {
      const f = funding[k]; const was = C.in?.[k] ? 1 : 0;
      let now = was; if (f?.ann7 != null) { if (f.ann7 > PARAMS.carryIn) now = 1; else if (f.ann7 < PARAMS.carryOut) now = 0; }
      inNow[k] = now; if (was && f?.day != null) cret += 0.25 * f.day;  // yesterday's position earned the day's 3 payments on 25% of lane notional per coin
      cturn += Math.abs(now - was) * 0.25;
    }
    const ccost = cturn * (PARAMS.feeSide + PARAMS.perpFeeSide);
    lanes.C = { ...C, in: inNow, eq: Math.round(C.eq * (1 + cret - ccost) * 100) / 100, ret: r4(cret - ccost), trades: C.trades + (cturn > 0 ? 1 : 0), funding: Object.fromEntries(Object.entries(funding).map(([k, v]) => [k, v.ann7 == null ? null : r4(v.ann7)])) };
    lanes.C.peak = Math.max(C.peak ?? PARAMS.laneUSD, lanes.C.eq);
    // rotation (paper): only when BTC/ETH composite >= 0.5
    const composite = (A.BTC.score + A.ETH.score) / 2;
    const rot = {}; const rpx = { ...px }; const alts = PARAMS.universe.filter(s => s !== 'BTC' && s !== 'ETH');
    const altData = await Promise.all(alts.map(s => candles(s).catch(e => { console.warn(s, e.message); return null; })));
    const RA = { BTC: A.BTC, ETH: A.ETH }; alts.forEach((s, j) => { if (altData[j] && altData[j].closes.length >= 380) { RA[s] = analyse(altData[j].closes); rpx[s] = RA[s].close; } });
    for (const s of PARAMS.universe) rot[s] = composite >= 0.5 && RA[s] ? RA[s].wD / PARAMS.universe.length : 0;
    lanes.R = laneStep(lanes.R || {}, rot, rpx, prev.rpx || rpx, PARAMS.altFeeSide);

    const row = { date, px, composite: r4(composite), eq: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.eq])), wD: lanes.D.w, wE: lanes.E.w, wS: lanes.S.w, carryIn: inNow, funding: lanes.C.funding, rot: lanes.R.w };
    const ledger = [...(prev.ledger || []).filter(r => r.date !== date), row].slice(-400);
    const state = { lastRun: new Date().toISOString(), lastDate: date, src: { BTC: btc.src, ETH: eth.src }, px, rpx, analysis: { BTC: trim(A.BTC), ETH: trim(A.ETH) }, composite: r4(composite), lanes, ledger, start: prev.start || date, days: ledger.length };
    await store.setJSON('state', state);

    // Telegram: on target change > band in D, on carry/short/rotation state change, or Monday summary
    const changed = ['BTC', 'ETH'].some(k => Math.abs((lanes.D.w[k] ?? 0) - (prev.lanes?.D?.w?.[k] ?? 0)) > 0.0001)
      || JSON.stringify(inNow) !== JSON.stringify(prev.lanes?.C?.in || {}) || JSON.stringify(lanes.S.w) !== JSON.stringify(prev.lanes?.S?.w || {});
    const monday = new Date().getUTCDay() === 1;
    if (!quiet && (changed || monday || force)) await sendTelegram(formatMsg(state, changed));
    return { ok: true, state };
  } catch (e) {
    console.error('crypto', e);
    if (!quiet) await sendTelegram(`⚠️ <b>Crypto lane</b> run failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
const trim = a => ({ close: a.close, score: a.score, fired: a.fired, rv: r4(a.rv), scale: r4(a.scale), dd: r4(a.dd), wD: r4(a.wD), wE: r4(a.wE), wS: r4(a.wS) });
const pct = x => (x * 100).toFixed(0) + '%';
export function formatMsg(s, changed) {
  const L = s.lanes, b = s.analysis.BTC, e = s.analysis.ETH;
  const eqLine = k => `${k} $${L[k].eq.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${((L[k].eq / PARAMS.laneUSD - 1) * 100).toFixed(1)}%)`;
  return `🪙 <b>Crypto lane paper · ${s.lastDate}</b>${changed ? ' · TARGET CHANGED' : ''}\n` +
    `BTC $${b.close.toLocaleString('en-US', { maximumFractionDigits: 0 })} score ${b.score.toFixed(2)} vol ${pct(b.rv)} → D ${pct(L.D.w.BTC * 2)} of half\n` +
    `ETH $${e.close.toLocaleString('en-US', { maximumFractionDigits: 0 })} score ${e.score.toFixed(2)} vol ${pct(e.rv)} → D ${pct(L.D.w.ETH * 2)} of half\n` +
    `Lane D exposure ${pct(L.D.w.BTC + L.D.w.ETH)} · E ${pct(L.E.w.BTC + L.E.w.ETH)} · S ${pct(-(L.S.w.BTC + L.S.w.ETH))} short · R ${pct(Object.values(L.R.w).reduce((a, x) => a + x, 0))}\n` +
    `Carry: BTC ${L.C.funding?.BTC == null ? 'n/a' : pct(L.C.funding.BTC)} ${L.C.in.BTC ? 'IN' : 'out'} · ETH ${L.C.funding?.ETH == null ? 'n/a' : pct(L.C.funding.ETH)} ${L.C.in.ETH ? 'IN' : 'out'} (gate ${pct(PARAMS.carryIn)}/${pct(PARAMS.carryOut)})\n` +
    `Paper equity day ${s.days}: ${['D', 'E', 'C', 'S', 'R'].map(eqLine).join(' · ')}\n` +
    `Data ${s.src.BTC}/${s.src.ETH}. Signal only, no orders. /crypto for detail.`;
}
