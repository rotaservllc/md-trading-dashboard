// nightly-market-scan.mjs — scheduled trigger for the market-wide scan. 01:00 UTC Tue–Sat = 05:00 Dubai, after the US close.
export default async () => {
  const key = Netlify.env.get('MARKET_SCAN_KEY') || '';
  const url = (Netlify.env.get('URL') || 'https://md-trading-dashboard.netlify.app') + '/api/market-scan-run?mode=nightly';
  const r = await fetch(url, { method: 'POST', headers: { 'x-scan-key': key } });
  console.log('nightly-market-scan → market-scan-run', r.status);
};
export const config = { schedule: '0 1 * * 2-6' };
