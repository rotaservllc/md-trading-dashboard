// hsbc-check.mjs — GET /api/hsbc?status=1 (state + trigger spec) · ?force=1 (run now, sends the summary)
// POST /api/hsbc?set=1 with header x-scan-key and JSON body {field: value, ...} → patches the state (fills, statuses). BUILD 2026-10-15
import { getStore } from '@netlify/blobs';
import { runHsbc } from './lib/hsbc-core.mjs';
const ALLOWED = new Set(['t3', 't3Fill', 'v1Fill', 't4', 't5', 'eqqq', 'fired', 'backstopAlerts']);
export default async (req) => {
  const u = new URL(req.url);
  if (req.method === 'POST' && u.searchParams.get('set') === '1') {
    const key = Netlify.env.get('MARKET_SCAN_KEY');
    if (key && req.headers.get('x-scan-key') !== key) return new Response('forbidden', { status: 403 });
    const store = getStore({ name: 'trading-data', consistency: 'strong' });
    const prev = (await store.get('hsbc-state', { type: 'json' })) || {};
    const patch = await req.json();
    for (const k of Object.keys(patch)) if (!ALLOWED.has(k)) return new Response(`field not allowed: ${k}`, { status: 400 });
    const next = { ...prev, ...patch, manualPatch: { at: new Date().toISOString(), fields: Object.keys(patch) } };
    await store.setJSON('hsbc-state', next);
    return new Response(JSON.stringify({ ok: true, state: next }), { headers: { 'Content-Type': 'application/json' } });
  }
  const r = await runHsbc({ force: u.searchParams.get('force') === '1', status: u.searchParams.get('status') === '1' });
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
};
export const config = { path: '/api/hsbc' };
