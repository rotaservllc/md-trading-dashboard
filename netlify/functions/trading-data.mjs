// trading-data.mjs — serves latest scan data and watchlist to the dashboard
import { getStore } from '@netlify/blobs';
import { getWatchlist } from './lib/watchlist.mjs';

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const store = getStore('trading-data');

    // Get latest scan results
    let scanData = null;
    try {
      scanData = await store.get('latest-scan', { type: 'json' });
    } catch {
      scanData = null;
    }

    const watchlist = await getWatchlist();

    return new Response(
      JSON.stringify({ ok: true, scan: scanData, watchlist, ts: new Date().toISOString() }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = {
  path: '/api/trading-data',
};
