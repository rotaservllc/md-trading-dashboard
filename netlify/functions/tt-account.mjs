// tt-account.mjs — TT live account data (fully inlined)
import { request as httpsRequest } from 'node:https';

async function getTTToken() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: Netlify.env.get('TT_REFRESH_TOKEN'), client_id: Netlify.env.get('TT_OAUTH_CLIENT_ID'), client_secret: Netlify.env.get('TT_OAUTH_CLIENT_SECRET') }).toString();
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`TT auth ${res.statusCode}`)); else resolve(JSON.parse(d).access_token); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
function ttGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.end();
  });
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const t0 = Date.now(); const token = await getTTToken(); const t1 = Date.now();
    const account = Netlify.env.get('TT_ACCOUNT') || '5WI51792';
    const [balRes, posRes] = await Promise.all([ttGet(`/accounts/${account}/balances`, token), ttGet(`/accounts/${account}/positions`, token)]);
    const t2 = Date.now();
    if (balRes.status !== 200) return new Response(JSON.stringify({ ok: false, error: `Balance ${balRes.status}` }), { status: 502, headers });
    const bal = JSON.parse(balRes.body).data || {};
    let positions = [];
    if (posRes.status === 200) positions = (JSON.parse(posRes.body).data?.items || []).map(p => ({ symbol: p.symbol, type: p['instrument-type'], quantity: p.quantity, costBasis: p['average-open-price'] }));
    return new Response(JSON.stringify({ ok: true, summary: { netLiq: parseFloat(bal['net-liquidating-value'] || 0), cash: parseFloat(bal['cash-balance'] || 0), optionsBP: parseFloat(bal['derivative-buying-power'] || 0), positions, account, timing: { tokenMs: t1 - t0, dataMs: t2 - t1, totalMs: t2 - t0 } } }), { status: 200, headers });
  } catch (err) { return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers }); }
};
export const config = { path: '/api/tt-live' };
