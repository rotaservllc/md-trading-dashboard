// board-history.mjs — daily closes for the Portfolio Board performance panel   BUILD: 2026-10-23
// GET /api/board-history?symbols=LITE,VWRA.L,SMH&range=2y
//   -> { ok, range, series: { SYM: [[YYYY-MM-DD, close], ...] }, ts }
// Yahoo chart endpoint; closes are split-adjusted. Used by Portfolio-Tracker/build_history.py (runs on the PC).
const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=900' };
const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y']);

async function hist(sym, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: UA });
  if (!r.ok) return { error: `yahoo ${r.status}` };
  const res = (await r.json())?.chart?.result?.[0];
  if (!res?.timestamp) return { error: 'no data' };
  const closes = res.indicators?.quote?.[0]?.close || [];
  const out = [];
  res.timestamp.forEach((t, i) => { if (closes[i] != null) out.push([new Date(t * 1000).toISOString().slice(0, 10), +closes[i].toFixed(4)]); });
  return out;
}

export default async (req) => {
  const u = new URL(req.url);
  const symbols = (u.searchParams.get('symbols') || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  const range = RANGES.has(u.searchParams.get('range')) ? u.searchParams.get('range') : '1y';
  if (!symbols.length) return new Response(JSON.stringify({ ok: false, error: 'symbols param required' }), { status: 400, headers: HEADERS });
  const series = {};
  for (let i = 0; i < symbols.length; i += 6) {
    const batch = symbols.slice(i, i + 6);
    const out = await Promise.all(batch.map(s => hist(s, range).then(q => [s, q]).catch(e => [s, { error: e.message }])));
    for (const [s, q] of out) series[s] = q;
  }
  return new Response(JSON.stringify({ ok: true, range, series, ts: new Date().toISOString() }), { status: 200, headers: HEADERS });
};

export const config = { path: '/api/board-history' };
