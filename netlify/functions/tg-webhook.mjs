// tg-webhook.mjs — Telegram bot (fully inlined)
import { request as httpsRequest } from 'node:https';

const BOT_TOKEN = Netlify.env.get('TELEGRAM_BOT_TOKEN');
const ALLOWED = String(Netlify.env.get('TELEGRAM_CHAT_ID'));
const ACCOUNT = Netlify.env.get('TT_ACCOUNT') || '5WI51792';

async function getTTToken() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: Netlify.env.get('TT_REFRESH_TOKEN'), client_id: Netlify.env.get('TT_OAUTH_CLIENT_ID'), client_secret: Netlify.env.get('TT_OAUTH_CLIENT_SECRET') }).toString();
  return new Promise((res, rej) => { const r = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { if (resp.statusCode !== 200) rej(new Error(`TT auth ${resp.statusCode}`)); else res(JSON.parse(d).access_token); }); }); r.on('error', rej); r.write(body); r.end(); });
}
function ttGet(path, token) { return new Promise((res, rej) => { const r = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => res({ status: resp.statusCode, body: d })); }); r.on('error', rej); r.end(); }); }
function cboeGet(path) { return new Promise((res, rej) => { const r = httpsRequest({ hostname: 'cdn.cboe.com', port: 443, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => res({ status: resp.statusCode, body: d })); }); r.on('error', rej); r.end(); }); }
function parseOptionSym(sym) { let i = 0; while (i < sym.length && sym[i].match(/[A-Z^]/)) i++; const rest = sym.slice(i); return { optType: rest[6], strike: parseInt(rest.slice(7)) / 1000, exp: `20${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,6)}` }; }
function detectEarnings(options, price) {
  if (!options?.length || !price) return { hasEarnings: false };
  const today = new Date(); const expIVs = {};
  for (const o of options) { if (!o.expiration || !o.iv) continue; if (Math.abs(o.strike_price - price) / price > 0.06) continue; if (!expIVs[o.expiration]) expIVs[o.expiration] = []; expIVs[o.expiration].push(o.iv * 100); }
  const sorted = Object.keys(expIVs).sort().map(exp => ({ exp, dte: Math.round((new Date(exp) - today) / 86400000), iv: expIVs[exp].reduce((a, b) => a + b, 0) / expIVs[exp].length })).filter(e => e.dte >= 0);
  if (sorted.length < 2) return { hasEarnings: false };
  const baseline = sorted.slice(-2).reduce((a, b) => a + b.iv, 0) / 2;
  let best = null; let maxSpike = 0;
  for (const e of sorted) { if (e.dte > 45) continue; const spike = e.iv / baseline; if (spike > 1.25 && spike > maxSpike) { maxSpike = spike; best = e; } }
  if (!best) return { hasEarnings: false };
  return { hasEarnings: true, earningsExpiry: best.exp, earningsDTE: best.dte, warning: `⚠️ Earnings likely before ${best.exp} (${best.dte}d) — IV spike ${((maxSpike - 1) * 100).toFixed(0)}% above baseline` };
}

const reply = async (chatId, text) => { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); };

const cmds = {
  '/status': async (chatId) => {
    try { const token = await getTTToken(); const res = await ttGet(`/accounts/${ACCOUNT}/balances`, token); const bal = JSON.parse(res.body).data || {}; await reply(chatId, `📊 <b>Account ${ACCOUNT}</b>\n💰 Net Liq: $${parseFloat(bal['net-liquidating-value']||0).toFixed(2)}\n💵 Cash: $${parseFloat(bal['cash-balance']||0).toFixed(2)}\n🎯 BP: $${parseFloat(bal['derivative-buying-power']||0).toFixed(2)}\n⏰ ${new Date().toISOString().slice(0,16)} UTC`); } catch (e) { await reply(chatId, `❌ ${e.message}`); }
  },
  '/check': async (chatId, args) => {
    const ticker = (args[0] || '').toUpperCase();
    if (!ticker) { await reply(chatId, 'Usage: /check TICKER'); return; }
    try {
      const { status, body } = await cboeGet(`/api/global/delayed_quotes/options/${ticker}.json`);
      if (status !== 200) { await reply(chatId, `❌ No data for ${ticker}`); return; }
      const d = JSON.parse(body).data || {}; const price = d.current_price; const iv30 = d.iv30;
      const options = (d.options || []).map(o => { try { const { optType, strike, exp } = parseOptionSym(o.option); return { ...o, option_type: optType, strike_price: strike, expiration: exp }; } catch { return null; } }).filter(Boolean);
      const earnings = detectEarnings(options, price);
      let msg = `🔎 <b>${ticker}</b>\nPrice: $${price?.toFixed(2)||'N/A'}\nIV30: ${iv30?.toFixed(1)||'N/A'}%\n`;
      if (earnings.hasEarnings) msg += `\n${earnings.warning}`;
      else msg += '\n✅ No earnings detected in next 45 days';
      await reply(chatId, msg);
    } catch (e) { await reply(chatId, `❌ ${e.message}`); }
  },
  '/watchlist': async (chatId) => { await reply(chatId, '📋 Use the dashboard to view your watchlist:\nhttps://md-trading-dashboard.netlify.app'); },
  '/help': async (chatId) => { await reply(chatId, `🤖 <b>MD Trading Bot</b>\n\n/status — Account balance\n/check TICKER — IV + earnings check\n/watchlist — Watchlist link\n/help — This message`); },
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 });
  let body; try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const msg = body?.message; if (!msg) return new Response('OK', { status: 200 });
  const chatId = String(msg.chat?.id); const text = (msg.text || '').trim();
  if (chatId !== ALLOWED) return new Response('OK', { status: 200 });
  const parts = text.split(/\s+/); const cmd = (parts[0] || '').toLowerCase().split('@')[0];
  try { const fn = cmds[cmd]; if (fn) await fn(chatId, parts.slice(1)); else await reply(chatId, 'Unknown command. /help'); } catch (e) { await reply(chatId, `⚠️ ${e.message}`); }
  return new Response('OK', { status: 200 });
};
export const config = { path: '/api/tg-webhook' };
