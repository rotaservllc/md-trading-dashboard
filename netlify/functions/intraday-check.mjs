// intraday-check.mjs — GET /api/intraday?status=1 (state) · ?force=1 (run now, ignores market-hours guard, still dedupes). BUILD 2026-09-27
import { runIntraday } from './lib/intraday-core.mjs';
export default async (req) => {
  const u = new URL(req.url);
  const r = await runIntraday({ force: u.searchParams.get('force') === '1', status: u.searchParams.get('status') === '1' });
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
};
export const config = { path: '/api/intraday' };
