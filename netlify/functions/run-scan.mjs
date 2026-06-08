// run-scan.mjs — manual scan trigger (HTTP)   BUILD: 2026-06-05T00:00:00Z
import { runScan } from './lib/scan-core.mjs';

export default async () => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const r = await runScan('manual');
    return new Response(JSON.stringify({ ok: true, ...r }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/run-scan' };
