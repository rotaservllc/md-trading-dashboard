// market-scan.mjs — GET /api/market-scan → latest market-wide scan result (Blobs). ?summary=1 for the compact view.
import { getStore } from '@netlify/blobs';
export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const url = new URL(req.url);
  const r = await getStore('trading-data').get('market-scan', { type: 'json' });
  if (!r) return new Response(JSON.stringify({ ok: false, error: 'no market scan yet' }), { status: 404, headers });
  if (url.searchParams.get('summary') === '1') {
    const { credit, debit, watch, ...rest } = r;
    return new Response(JSON.stringify({ ok: true, ...rest, credit: credit.slice(0, 8), debit: debit.slice(0, 5), ivSpike: watch.ivSpike.slice(0, 8) }), { headers });
  }
  return new Response(JSON.stringify({ ok: true, ...r }), { headers });
};
export const config = { path: '/api/market-scan' };
