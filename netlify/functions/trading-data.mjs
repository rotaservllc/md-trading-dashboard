// trading-data.mjs — serves scan data + watchlist
export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    let scanData = null; let watchlist = [];
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('trading-data');
      scanData = await store.get('latest-scan', { type: 'json' }).catch(() => null);
      watchlist = await store.get('watchlist', { type: 'json' }).catch(() => []);
    } catch { /* blobs not available */ }
    if (!watchlist?.length) watchlist = [
      { ticker: 'PLTR', strategy: 'CALL' }, { ticker: 'NVDA', strategy: 'CALL' },
      { ticker: 'TSLA', strategy: 'CALL' }, { ticker: 'RKLB', strategy: 'CALL' },
      { ticker: 'MARA', strategy: 'CSP' }, { ticker: 'SOFI', strategy: 'CSP' },
      { ticker: 'IONQ', strategy: 'CSP' }, { ticker: 'KTOS', strategy: 'CSP' },
      { ticker: 'BBAI', strategy: 'CSP' }, { ticker: 'RGTI', strategy: 'CSP' },
    ];
    return new Response(JSON.stringify({ ok: true, scan: scanData, watchlist, ts: new Date().toISOString() }), { status: 200, headers });
  } catch (err) { return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers }); }
};
export const config = { path: '/api/trading-data' };
