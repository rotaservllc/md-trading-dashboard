// Shared watchlist management via Netlify Blobs
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'trading-data';
const WATCHLIST_KEY = 'watchlist';

const DEFAULT_WATCHLIST = [
  { ticker: 'PLTR', strategy: 'CALL' },
  { ticker: 'NVDA', strategy: 'CALL' },
  { ticker: 'TSLA', strategy: 'CALL' },
  { ticker: 'RKLB', strategy: 'CALL' },
  { ticker: 'MARA', strategy: 'CSP' },
  { ticker: 'SOFI', strategy: 'CSP' },
  { ticker: 'IONQ', strategy: 'CSP' },
  { ticker: 'KTOS', strategy: 'CSP' },
  { ticker: 'BBAI', strategy: 'CSP' },
  { ticker: 'RGTI', strategy: 'CSP' },
];

export async function getWatchlist() {
  try {
    const store = getStore(STORE_NAME);
    const data = await store.get(WATCHLIST_KEY, { type: 'json' });
    return data || DEFAULT_WATCHLIST;
  } catch {
    return DEFAULT_WATCHLIST;
  }
}

export async function saveWatchlist(list) {
  const store = getStore(STORE_NAME);
  await store.setJSON(WATCHLIST_KEY, list);
}
