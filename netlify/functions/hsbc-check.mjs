// hsbc-check.mjs — GET /api/hsbc?status=1 (state + trigger spec) · ?force=1 (run now, sends the summary). BUILD 2026-09-28
import { runHsbc } from './lib/hsbc-core.mjs';
export default async (req) => {
  const u = new URL(req.url);
  const r = await runHsbc({ force: u.searchParams.get('force') === '1', status: u.searchParams.get('status') === '1' });
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
};
export const config = { path: '/api/hsbc' };
