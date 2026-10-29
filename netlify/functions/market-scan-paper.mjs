// market-scan-paper.mjs — GET /api/market-scan-paper → latest paper-lane scan + the running paper log (hypothetical $10K NLV). BUILD 2026-10-15
import { getStore } from '@netlify/blobs';
export default async () => {
  const store = getStore('trading-data');
  const [scan, log] = await Promise.all([store.get('market-scan-paper', { type: 'json' }), store.get('paper-log', { type: 'json' })]);
  return new Response(JSON.stringify({ ok: true, scan: scan || null, log: log || [] }), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { path: '/api/market-scan-paper' };
