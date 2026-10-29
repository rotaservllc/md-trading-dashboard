// nightly-market-scan.mjs — scheduled trigger for the market-wide scan. Since 5 Oct 2026 it runs DURING US hours so a setup can be traded the same day:
//   14:45 UTC = 10:45 ET (EDT) / 09:45 ET (EST)  → mode "open"     (18:45 Dubai)
//   18:45 UTC = 14:45 ET (EDT) / 13:45 ET (EST)  → mode "midday"   (22:45 Dubai)
// The 05:00-Dubai post-close run was retired (a report on stale closes, not a signal). Both runs still build the scan record for the UW trial comparison (Charter §12).
export default async () => {
  const key = Netlify.env.get('MARKET_SCAN_KEY') || '';
  const h = new Date().getUTCHours();
  const mode = h < 17 ? 'open' : 'midday';
  const url = (Netlify.env.get('URL') || 'https://md-trading-dashboard.netlify.app') + '/api/market-scan-run?mode=' + mode;
  const r = await fetch(url, { method: 'POST', headers: { 'x-scan-key': key } });
  console.log('market-scan schedule →', mode, r.status);
  // 15 Oct: paper lane at a hypothetical $10K NLV (Charter §13 Stage B evidence), midday run only
  if (mode === 'midday') { const p = await fetch(url.replace('mode=midday', 'mode=paper&nlv=10000'), { method: 'POST', headers: { 'x-scan-key': key } }); console.log('paper lane →', p.status); }
};
export const config = { schedule: '45 14,18 * * 1-5' };
