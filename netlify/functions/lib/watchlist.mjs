import { getStore } from '@netlify/blobs';
const DEFAULT_WATCHLIST = [
  { ticker: 'PLTR', strategy: 'CALL' }, { ticker: 'NVDA', strategy: 'CALL' },
  { ticker: 'TSLA', strategy: 'CALL' }, { ticker: 'RKLB', strategy: 'CALL' },
  { ticker: 'MARA', strategy: 'CSP' }, { ticker: 'SOFI', strategy: 'CSP' },
  { ticker: 'IONQ', strategy: 'CSP' }, { ticker: 'KTOS', strategy: 'CSP' },
  { ticker: 'BBAI', strategy: 'CSP' }, { ticker: 'RGTI', strategy: 'CSP' },
];
export async function getWatchlist() {
  try { const s = getStore('trading-data'); return await s.get('watchlist', { type: 'json' }) || DEFAULT_WATCHLIST; }
  catch { return DEFAULT_WATCHLIST; }
}
export async function saveWatchlist(list) { await getStore('trading-data').setJSON('watchlist', list); }
