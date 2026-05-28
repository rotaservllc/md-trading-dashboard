// daily-monitor-v2.mjs — 1PM UTC Mon-Fri (fully inlined)
import { request as httpsRequest } from 'node:https';

async function getTTToken() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: Netlify.env.get('TT_REFRESH_TOKEN'), client_id: Netlify.env.get('TT_OAUTH_CLIENT_ID'), client_secret: Netlify.env.get('TT_OAUTH_CLIENT_SECRET') }).toString();
  return new Promise((res, rej) => { const r = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { if (resp.statusCode !== 200) rej(new Error(`TT auth ${resp.statusCode}`)); else res(JSON.parse(d).access_token); }); }); r.on('error', rej); r.write(body); r.end(); });
}
function ttGet(path, token) {
  return new Promise((res, rej) => { const r = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => res({ status: resp.statusCode, body: d })); }); r.on('error', rej); r.end(); });
}

export default async () => {
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return;
  const botToken = Netlify.env.get('TELEGRAM_BOT_TOKEN'); const chatId = Netlify.env.get('TELEGRAM_CHAT_ID');
  const sendTG = async (text) => { if (botToken && chatId) await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); };
  try {
    const token = await getTTToken(); const account = Netlify.env.get('TT_ACCOUNT') || '5WI51792';
    const [balRes, posRes] = await Promise.all([ttGet(`/accounts/${account}/balances`, token), ttGet(`/accounts/${account}/positions`, token)]);
    const bal = JSON.parse(balRes.body).data || {};
    const netLiq = parseFloat(bal['net-liquidating-value'] || 0); const cash = parseFloat(bal['cash-balance'] || 0); const bp = parseFloat(bal['derivative-buying-power'] || 0);
    let posLines = '';
    if (posRes.status === 200) { const items = JSON.parse(posRes.body).data?.items || []; if (items.length > 0) posLines = '\n\n<b>Open Positions:</b>\n' + items.map(p => `  ${p.symbol} ×${p.quantity} @ ${p['average-open-price']}`).join('\n'); }
    const dateStr = now.toISOString().slice(0, 10);
    await sendTG(`📊 <b>Daily Monitor — ${dateStr}</b>\n⏰ ${now.toISOString().slice(11, 16)} UTC\n\n<b>Account ${account}</b>\n💰 Net Liq: $${netLiq.toFixed(2)}\n💵 Cash: $${cash.toFixed(2)}\n🎯 Options BP: $${bp.toFixed(2)}${posLines}`);
  } catch (err) { await sendTG(`⚠️ Daily monitor error: ${err.message}`); }
};
export const config = { schedule: '0 13 * * 1-5' };
