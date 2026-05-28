// tt-chain.mjs — CBOE options chain with earnings detection
import { request as httpsRequest } from 'node:https';

function cboeGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'cdn.cboe.com', port: 443, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.end();
  });
}

function parseOptionSym(sym) {
  let i = 0; while (i < sym.length && sym[i].match(/[A-Z^]/)) i++;
  const rest = sym.slice(i);
  return { optType: rest[6], strike: parseInt(rest.slice(7)) / 1000, exp: `20${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,6)}` };
}

function detectEarnings(options, price) {
  if (!options || !options.length || !price) return { hasEarnings: false };
  const today = new Date();
  const expIVs = {};
  for (const o of options) {
    if (!o.expiration || !o.iv) continue;
    if (Math.abs(o.strike_price - price) / price > 0.06) continue;
    if (!expIVs[o.expiration]) expIVs[o.expiration] = [];
    expIVs[o.expiration].push(o.iv * 100);
  }
  const sorted = Object.keys(expIVs).sort().map(exp => ({ exp, dte: Math.round((new Date(exp) - today) / 86400000), iv: expIVs[exp].reduce((a, b) => a + b, 0) / expIVs[exp].length })).filter(e => e.dte >= 0);
  if (sorted.length < 2) return { hasEarnings: false };
  const baseline = sorted.slice(-2).reduce((a, b) => a + b.iv, 0) / 2;
  let best = null; let maxSpike = 0;
  for (const e of sorted) {
    if (e.dte > 45) continue;
    const spike = e.iv / baseline;
    if (spike > 1.25 && spike > maxSpike) { maxSpike = spike; best = e; }
  }
  if (!best) return { hasEarnings: false };
  return { hasEarnings: true, earningsExpiry: best.exp, earningsDTE: best.dte, ivSpike: maxSpike.toFixed(2), warning: `⚠️ Earnings likely before ${best.exp} (${best.dte}d) — IV spike ${((maxSpike - 1) * 100).toFixed(0)}% above baseline` };
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const ticker = (new URL(req.url).searchParams.get('ticker') || '').toUpperCase().trim();
  if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'ticker param required' }), { status: 400, headers });
  try {
    const { status, body } = await cboeGet(`/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`);
    if (status !== 200) return new Response(JSON.stringify({ ok: false, error: `CBOE ${status}` }), { status: 502, headers });
    const d = JSON.parse(body).data || {};
    const price = d.current_price;
    const options = (d.options || []).map(o => { try { const { optType, strike, exp } = parseOptionSym(o.option); return { ...o, option_type: optType, strike_price: strike, expiration: exp }; } catch { return null; } }).filter(Boolean);
    const earnings = detectEarnings(options, price);
    const expMap = {};
    for (const o of options) {
      if (Math.abs(o.strike_price - price) / price > 0.25) continue;
      if (!expMap[o.expiration]) expMap[o.expiration] = [];
      expMap[o.expiration].push({ type: o.option_type, strike: o.strike_price, bid: o.bid, ask: o.ask, iv: o.iv, volume: o.volume, oi: o.open_interest, delta: o.delta });
    }
    const expirations = {};
    for (const exp of Object.keys(expMap).sort().slice(0, 4)) expirations[exp] = expMap[exp];
    return new Response(JSON.stringify({ ok: true, ticker, price, iv30: d.iv30, earnings, expirations }), { status: 200, headers });
  } catch (err) { return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers }); }
};
export const config = { path: '/api/tt-chain' };
