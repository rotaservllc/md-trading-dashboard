// tt-quotes.mjs — Batch stock quotes via CBOE (no auth required)
// Matches the pattern used in tt-chain.mjs
// Usage: GET /api/tt-quotes?symbols=BE,AAOI,ALAB,MU,AMD,COHR,LITE,SNDK,GEV,NEE,META,AMZN,AXON,ASTS,NVDA,IWM,SPY,TLT,GLD,SMH,PLTR,GOOGL,DOCN,VRT,SITM,CIEN
import { request as httpsRequest } from 'node:https';

function cboeGet(ticker) {
  return new Promise((resolve) => {
    const path = `/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`;
    const req = httpsRequest(
      { hostname: 'cdn.cboe.com', port: 443, path, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ticker, ok: false, error: `CBOE ${res.statusCode}` });
            return;
          }
          try {
            const data = JSON.parse(d).data || {};
            const price = data.current_price ?? null;
            const prev  = data.prev_day_close ?? null;
            const change    = (price !== null && prev !== null) ? +(price - prev).toFixed(4) : null;
            const changePct = (prev)  ? +((change / prev) * 100).toFixed(2) : null;
            resolve({ ticker, ok: true, last: price, prevClose: prev, change, changePct,
                      iv30: data.iv30 ?? null, volume: data.total_volume ?? null });
          } catch (e) {
            resolve({ ticker, ok: false, error: e.message });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ticker, ok: false, error: e.message }));
    req.end();
  });
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const symbolsParam = new URL(req.url).searchParams.get('symbols');

  if (!symbolsParam) {
    return new Response(
      JSON.stringify({ ok: false, error: 'symbols param required — e.g. ?symbols=BE,AAOI,ALAB' }),
      { status: 400, headers }
    );
  }

  const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const t0 = Date.now();

  try {
    // Fetch all in parallel
    const results = await Promise.all(symbols.map(cboeGet));

    const quotes  = {};
    const errors  = {};
    for (const r of results) {
      if (r.ok) {
        quotes[r.ticker] = { last: r.last, prevClose: r.prevClose, change: r.change,
                             changePct: r.changePct, iv30: r.iv30, volume: r.volume };
      } else {
        errors[r.ticker] = r.error;
      }
    }

    return new Response(
      JSON.stringify({ ok: true, quotes, errors: Object.keys(errors).length ? errors : undefined,
                       count: Object.keys(quotes).length, ms: Date.now() - t0 }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/tt-quotes' };
