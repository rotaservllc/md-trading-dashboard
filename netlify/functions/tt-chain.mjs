// tt-chain.mjs — fetch options chain from CBOE for a ticker   BUILD: 2026-06-07 (OCC-parse fix)
// CBOE options carry the OCC symbol in o.option (e.g. AAPL260117C00200000); strike/type/expiry
// must be parsed from it — there is no strike_price/option_type/expiration field.
function parseOCC(sym) {
  const m = (sym || '').match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, typ, k] = m;
  return { expiration: `20${yy}-${mm}-${dd}`, option_type: typ, strike: parseInt(k, 10) / 1000 };
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const url = new URL(req.url);
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
  if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'ticker param required' }), { status: 400, headers });

  try {
    const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;
    const resp = await fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!resp.ok) return new Response(JSON.stringify({ ok: false, error: `CBOE returned ${resp.status} for ${ticker}` }), { status: 502, headers });

    const data = await resp.json();
    const quote = parseFloat(data.data?.current_price) || 0;
    const options = data.data?.options || [];

    const expiryMap = {};
    for (const o of options) {
      const p = parseOCC(o.option);
      if (!p) continue;
      if (quote && Math.abs(p.strike - quote) / quote >= 0.25) continue; // strikes within 25% of spot
      (expiryMap[p.expiration] ||= []).push({
        option_type: p.option_type, strike: p.strike, expiration: p.expiration,
        bid: +o.bid || 0, ask: +o.ask || 0, iv: +o.iv || 0,
        volume: +o.volume || 0, oi: +o.open_interest || 0, delta: +o.delta || 0,
      });
    }
    const sortedExpiries = Object.keys(expiryMap).sort().slice(0, 3); // soonest 3 expiries
    const filtered = {};
    for (const exp of sortedExpiries) filtered[exp] = expiryMap[exp].sort((a, b) => a.strike - b.strike);

    return new Response(JSON.stringify({ ok: true, ticker, price: quote, expirations: filtered }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/tt-chain' };
