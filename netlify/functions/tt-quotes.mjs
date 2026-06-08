// tt-quotes.mjs — batch price-only quotes from CBOE   BUILD: 2026-06-07 (new: portfolio valuation / briefings)
// GET /api/tt-quotes?symbols=AAPL,MSFT,NVDA
//   -> { ok, count, quotes: { AAPL: {last, prevClose, change, changePct, iv30, volume}, ... }, ts }
// Same CBOE source as tt-chain, but takes a symbol list and returns a flat per-symbol record,
// discarding the option chain. One round trip for valuing a whole portfolio.
async function fetchUnderlying(sym) {
  const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!r.ok) return { error: `CBOE ${r.status}` };
  const u = (await r.json())?.data;
  if (!u) return { error: 'no data' };
  return {
    last: +u.current_price || 0,
    prevClose: +u.prev_day_close || +u.close || 0,
    change: +u.price_change || 0,
    changePct: +u.price_change_percent || 0,
    iv30: +u.iv30 || 0,
    volume: +u.volume || 0,
  };
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const symbols = (new URL(req.url).searchParams.get('symbols') || '')
    .toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return new Response(JSON.stringify({ ok: false, error: 'symbols param required (e.g. ?symbols=AAPL,MSFT)' }), { status: 400, headers });
  }
  try {
    const quotes = {};
    for (let i = 0; i < symbols.length; i += 10) { // batch to stay under the function timeout
      const batch = symbols.slice(i, i + 10);
      const results = await Promise.all(batch.map(s => fetchUnderlying(s).then(q => [s, q]).catch(e => [s, { error: e.message }])));
      for (const [s, q] of results) quotes[s] = q;
    }
    return new Response(JSON.stringify({ ok: true, count: symbols.length, quotes, ts: new Date().toISOString() }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/tt-quotes' };
