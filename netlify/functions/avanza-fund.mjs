// avanza-fund.mjs — Swedish fund NAV history from Avanza's public fund guide   BUILD: 2026-10-23
// GET /api/avanza-fund?isin=SE0005796331
//   -> { ok, isin, orderbookId, name, series: [[YYYY-MM-DD, nav_sek], ...], ts }
// Daily NAV for the last year (one_year?raw=true) merged with weekly NAV for five years (five_years?raw=true).
// Used by Portfolio-Tracker/build_history.py for the Avanza sleeve (Swedish mutual funds are not on Yahoo).
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json', 'Accept-Language': 'sv-SE', 'Content-Type': 'application/json' };
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' };

async function j(url, init) { const r = await fetch(url, { headers: UA, ...init }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
const day = ms => new Date(ms).toISOString().slice(0, 10);

export default async (req) => {
  const u = new URL(req.url);
  const isin = (u.searchParams.get('isin') || '').toUpperCase().trim();
  let id = u.searchParams.get('id'), name = '';
  if (!isin && !id) return new Response(JSON.stringify({ ok: false, error: 'isin or id required' }), { status: 400, headers: HEADERS });
  try {
    if (!id) {
      const s = await j('https://www.avanza.se/_api/search/filtered-search', { method: 'POST', body: JSON.stringify({ query: isin, pagination: { from: 0, size: 5 } }) });
      const hit = (s.hits || []).find(h => h.orderBookId) ;
      if (!hit) return new Response(JSON.stringify({ ok: false, isin, error: 'no search hit' }), { status: 404, headers: HEADERS });
      id = hit.orderBookId; name = hit.title || '';
    }
    const nav = new Map();
    for (const period of ['five_years', 'three_years', 'one_year']) {
      try {
        const c = await j(`https://www.avanza.se/_api/fund-guide/chart/${id}/${period}?raw=true`);
        for (const p of (c.dataSerie || [])) if (p.y != null) nav.set(day(p.x), +(+p.y).toFixed(4));
        if (!name) name = c.name || '';
      } catch (e) { /* a period can 500; the others still fill the map */ }
    }
    const series = [...nav.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    return new Response(JSON.stringify({ ok: series.length > 0, isin, orderbookId: id, name, count: series.length, from: series[0]?.[0], to: series.at(-1)?.[0], series, ts: new Date().toISOString() }), { status: 200, headers: HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, isin, error: err.message }), { status: 500, headers: HEADERS });
  }
};

export const config = { path: '/api/avanza-fund' };
