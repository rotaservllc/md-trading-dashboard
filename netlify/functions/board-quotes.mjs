// board-quotes.mjs — live prices for the Portfolio Board artifact   BUILD: 2026-10-23
// GET /api/board-quotes?symbols=LITE,AMD,VWRA.L,COPX.L
//   -> { ok, quotes: { SYM: {last, prevClose, changePct, ccy, ts}, ... }, ts }
// Yahoo chart endpoint (same source as hsbc-core) so LSE/EBS lines (.L/.SW) and US names come from one place.
// CORS is open: the board is served from claude.ai, not from this site. Prices only; nothing sensitive.
const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };

async function yq(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: UA });
  if (!r.ok) return { error: `yahoo ${r.status}` };
  const res = (await r.json())?.chart?.result?.[0];
  const meta = res?.meta;
  if (!meta) return { error: 'no data' };
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(x => x != null);
  const last = +meta.regularMarketPrice || closes.at(-1) || 0;
  // chartPreviousClose is the close before the range (5 days back), not yesterday: prefer the penultimate daily close
  const prev = (closes.length >= 2 ? closes.at(-2) : 0) || +meta.previousClose || +meta.chartPreviousClose || 0;
  return { last, prevClose: prev, changePct: prev ? +((last / prev - 1) * 100).toFixed(2) : 0, ccy: meta.currency || '', ts: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null };
}

export default async (req) => {
  const symbols = (new URL(req.url).searchParams.get('symbols') || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!symbols.length) return new Response(JSON.stringify({ ok: false, error: 'symbols param required' }), { status: 400, headers: HEADERS });
  const quotes = {};
  for (let i = 0; i < symbols.length; i += 8) {
    const batch = symbols.slice(i, i + 8);
    const out = await Promise.all(batch.map(s => yq(s).then(q => [s, q]).catch(e => [s, { error: e.message }])));
    for (const [s, q] of out) quotes[s] = q;
  }
  return new Response(JSON.stringify({ ok: true, quotes, ts: new Date().toISOString() }), { status: 200, headers: HEADERS });
};

export const config = { path: '/api/board-quotes' };
