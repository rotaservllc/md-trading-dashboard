// crypto-check.mjs — GET /api/crypto?status=1 (state + params) · ?force=1&key=MARKET_SCAN_KEY (mark today now, sends Telegram) · ?force=1&quiet=1 (no Telegram). BUILD 2026-10-24
import { runCrypto } from './lib/crypto-core.mjs';
export default async (req) => {
  const u = new URL(req.url);
  const force = u.searchParams.get('force') === '1';
  if (force && u.searchParams.get('key') !== (Netlify.env.get('MARKET_SCAN_KEY') || '')) return new Response('forbidden', { status: 403 });
  if (u.searchParams.get('reset') === '1' && u.searchParams.get('key') === (Netlify.env.get('MARKET_SCAN_KEY') || '')) {
    const { getStore } = await import('@netlify/blobs');
    await getStore({ name: 'crypto-paper', consistency: 'strong' }).delete('state');
    if (!force) return new Response(JSON.stringify({ ok: true, reset: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  const r = await runCrypto({ force, status: !force, quiet: u.searchParams.get('quiet') === '1' });
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
};
export const config = { path: '/api/crypto' };
