// tt-chain.mjs — options chain + IV context + earnings gate for one ticker
// BUILD: 2026-09-27 (v2: DTE window, IV rank/percentile, tastytrade earnings date)
//
// GET /api/tt-chain?ticker=SOFI                → expiries with 21–49 DTE (default trading window)
// GET /api/tt-chain?ticker=SOFI&dte=14-60      → custom DTE window
// GET /api/tt-chain?ticker=SOFI&all=1          → every expiry CBOE returns
// GET /api/tt-chain?ticker=SOFI&width=0.15     → strikes within ±15% of spot (default 25%)
//
// Sources:
//   • CBOE delayed quotes  — chain (bid/ask/iv/delta/volume/oi), spot, IV30, IV-term-structure earnings heuristic
//   • tastytrade /market-metrics — IV rank, IV percentile, IV index, liquidity rating, next earnings date
//     (uses the same OAuth refresh token as /api/tt-live; failure here degrades gracefully, chain still returns)
//
// Backward compatible: ok / ticker / price / expirations{exp:[contracts]} are unchanged.

import { getTTToken } from './lib/tt-auth.mjs';

const DAY = 86400000;
const TT_UA = 'md-trading-dashboard/1.0';

function parseOCC(sym) {
  const m = (sym || '').match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, typ, k] = m;
  return { expiration: `20${yy}-${mm}-${dd}`, option_type: typ, strike: parseInt(k, 10) / 1000 };
}

function dteOf(expStr, today) {
  return Math.round((new Date(expStr + 'T00:00:00Z') - today) / DAY);
}

// IV term-structure earnings heuristic (same logic as lib/earnings-detector, inlined on the parsed chain)
function detectEarningsFromIV(byExpiry, spot, today) {
  const rows = [];
  for (const [exp, contracts] of Object.entries(byExpiry)) {
    const atm = contracts.filter(c => c.iv > 0 && Math.abs(c.strike - spot) / spot <= 0.06);
    if (!atm.length) continue;
    rows.push({ exp, dte: dteOf(exp, today), iv: atm.reduce((a, c) => a + c.iv, 0) / atm.length });
  }
  rows.sort((a, b) => a.exp.localeCompare(b.exp));
  const fwd = rows.filter(r => r.dte >= 0);
  if (fwd.length < 2) return { detected: false };
  const baseline = fwd.slice(-2).reduce((a, r) => a + r.iv, 0) / 2;
  let hit = null, maxSpike = 0;
  for (const r of fwd) {
    if (r.dte > 45) continue;
    const spike = r.iv / baseline;
    if (spike > 1.25 && spike > maxSpike) { maxSpike = spike; hit = r; }
  }
  if (!hit) return { detected: false, baselineIV: +baseline.toFixed(3) };
  return { detected: true, beforeExpiry: hit.exp, dte: hit.dte, ivSpike: +maxSpike.toFixed(2), baselineIV: +baseline.toFixed(3) };
}

async function fetchMarketMetrics(ticker) {
  const token = await getTTToken();
  const resp = await fetch(`https://api.tastyworks.com/market-metrics?symbols=${encodeURIComponent(ticker)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': TT_UA },
  });
  if (!resp.ok) throw new Error(`market-metrics ${resp.status}`);
  const item = (await resp.json()).data?.items?.[0];
  if (!item) throw new Error('market-metrics: no item');
  const n = v => (v === undefined || v === null || v === '') ? null : Number(v);
  return {
    ivIndex: n(item['implied-volatility-index']),
    ivRank: n(item['implied-volatility-index-rank']),
    ivPercentile: n(item['implied-volatility-percentile']),
    iv5dChange: n(item['implied-volatility-index-5-day-change']),
    liquidityRating: n(item['liquidity-rating']),
    liquidityRank: n(item['liquidity-rank']),
    beta: n(item['beta']),
    earningsDate: item.earnings?.['expected-report-date'] || null,
    earningsTimeOfDay: item.earnings?.['time-of-day'] || null,
    dividendExDate: item['dividend-ex-date'] || null,
    updatedAt: item['updated-at'] || null,
  };
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const url = new URL(req.url);
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
  if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'ticker param required' }), { status: 400, headers });

  const all = url.searchParams.get('all') === '1';
  const width = Math.min(Math.max(parseFloat(url.searchParams.get('width')) || 0.25, 0.02), 1);
  let [dteMin, dteMax] = (url.searchParams.get('dte') || '21-49').split('-').map(Number);
  if (!Number.isFinite(dteMin)) dteMin = 21;
  if (!Number.isFinite(dteMax)) dteMax = 49;

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const t0 = Date.now();

  try {
    // Fire tastytrade metrics in parallel with CBOE; metrics failure must not sink the chain.
    const metricsP = fetchMarketMetrics(ticker).then(m => ({ ok: true, ...m })).catch(e => ({ ok: false, error: e.message }));

    const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;
    const resp = await fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!resp.ok) return new Response(JSON.stringify({ ok: false, error: `CBOE returned ${resp.status} for ${ticker}` }), { status: 502, headers });

    const data = await resp.json();
    const d = data.data || {};
    const spot = parseFloat(d.current_price) || 0;
    const options = d.options || [];

    // Full chain grouped by expiry, strikes within ±width of spot
    const byExpiry = {};
    for (const o of options) {
      const p = parseOCC(o.option);
      if (!p) continue;
      if (spot && Math.abs(p.strike - spot) / spot > width) continue;
      (byExpiry[p.expiration] ||= []).push({
        option_type: p.option_type, strike: p.strike, expiration: p.expiration,
        bid: +o.bid || 0, ask: +o.ask || 0, last: +o.last_trade_price || 0,
        iv: +o.iv || 0, delta: +o.delta || 0, theta: +o.theta || 0,
        volume: +o.volume || 0, oi: +o.open_interest || 0,
      });
    }

    const allExps = Object.keys(byExpiry).sort();
    const selected = all ? allExps : allExps.filter(e => { const x = dteOf(e, today); return x >= dteMin && x <= dteMax; });

    const expirations = {};
    const expiryMeta = [];
    for (const exp of selected) {
      const contracts = byExpiry[exp].sort((a, b) => a.strike - b.strike || a.option_type.localeCompare(b.option_type));
      expirations[exp] = contracts;
      const dte = dteOf(exp, today);
      const atmPut = contracts.filter(c => c.option_type === 'P' && c.strike <= spot).sort((a, b) => b.strike - a.strike)[0];
      expiryMeta.push({ expiration: exp, dte, contracts: contracts.length, atmPutIV: atmPut ? +atmPut.iv.toFixed(3) : null });
    }

    const ivHeuristic = detectEarningsFromIV(byExpiry, spot, today);
    const metrics = await metricsP;

    // Earnings gate: prefer tastytrade's confirmed date; fall back to IV heuristic.
    let earnings;
    if (metrics.ok && metrics.earningsDate) {
      const days = dteOf(metrics.earningsDate, today);
      earnings = { source: 'tastytrade', date: metrics.earningsDate, timeOfDay: metrics.earningsTimeOfDay, daysTo: days,
                   heuristic: ivHeuristic, gate14dPass: days > 14 || days < 0 };
    } else if (ivHeuristic.detected) {
      earnings = { source: 'iv-term-structure', date: null, daysTo: ivHeuristic.dte, heuristic: ivHeuristic,
                   gate14dPass: ivHeuristic.dte > 14 };
    } else {
      earnings = { source: 'none', date: null, daysTo: null, heuristic: ivHeuristic, gate14dPass: true };
    }

    const body = {
      ok: true,
      ticker,
      price: spot,
      asOf: new Date().toISOString(),
      iv: {
        iv30: d.iv30 != null ? +d.iv30 : null,
        iv30Change: d.iv30_change != null ? +d.iv30_change : null,
        ivIndex: metrics.ok ? metrics.ivIndex : null,
        ivRank: metrics.ok ? metrics.ivRank : null,
        ivPercentile: metrics.ok ? metrics.ivPercentile : null,
        iv5dChange: metrics.ok ? metrics.iv5dChange : null,
      },
      liquidity: metrics.ok ? { rating: metrics.liquidityRating, rank: metrics.liquidityRank } : null,
      beta: metrics.ok ? metrics.beta : null,
      earnings,
      dividendExDate: metrics.ok ? metrics.dividendExDate : null,
      metricsError: metrics.ok ? undefined : metrics.error,
      dteWindow: all ? 'all' : `${dteMin}-${dteMax}`,
      strikeWidth: width,
      availableExpirations: allExps.map(e => ({ expiration: e, dte: dteOf(e, today) })),
      expiryMeta,
      expirations,
      timing: { totalMs: Date.now() - t0 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/tt-chain' };
