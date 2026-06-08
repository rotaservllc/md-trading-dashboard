// tg-webhook.mjs — Telegram bot with two-way commands
// Commands: /status /prices /scan /check /add /remove /watchlist /help
import { getStore } from '@netlify/blobs';
import { getWatchlist, saveWatchlist } from './lib/watchlist.mjs';
import { getTTToken } from './lib/tt-auth.mjs';

const ALLOWED_CHAT_ID = Netlify.env.get('TELEGRAM_CHAT_ID');
const BOT_TOKEN = Netlify.env.get('TELEGRAM_BOT_TOKEN');
const ACCOUNT = Netlify.env.get('TT_ACCOUNT') || '5WI51792';

async function reply(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function handleStatus(chatId) {
  try {
    const token = await getTTToken();
    const resp = await fetch(`https://api.tastyworks.com/accounts/${ACCOUNT}/balances`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' },
    });
    const data = await resp.json();
    const bal = data.data || {};
    const netLiq = parseFloat(bal['net-liquidating-value'] || 0);
    const cash = parseFloat(bal['cash-balance'] || 0);
    const optionsBP = parseFloat(bal['derivative-buying-power'] || 0);
    await reply(chatId,
      `📊 <b>Account Status</b>\n` +
      `Account: ${ACCOUNT}\n` +
      `💰 Net Liq: $${netLiq.toFixed(2)}\n` +
      `💵 Cash: $${cash.toFixed(2)}\n` +
      `🎯 Options BP: $${optionsBP.toFixed(2)}\n` +
      `⏰ ${new Date().toISOString().slice(0, 16)} UTC`
    );
  } catch (err) {
    await reply(chatId, `❌ Status error: ${err.message}`);
  }
}

async function handlePrices(chatId) {
  try {
    const watchlist = await getWatchlist();
    const tickers = watchlist.map(w => w.ticker);

    // Fetch prices via CBOE for each ticker
    const prices = await Promise.all(
      tickers.map(async (t) => {
        try {
          const resp = await fetch(
            `https://cdn.cboe.com/api/global/delayed_quotes/options/${t}.json`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (!resp.ok) return `${t}: N/A`;
          const data = await resp.json();
          const price = data.data?.current_price;
          const iv = data.data?.iv30;
          const entry = watchlist.find(w => w.ticker === t);
          return `${entry?.strategy === 'CALL' ? '📈' : '📉'} ${t}: $${price?.toFixed(2) || 'N/A'}${iv ? ` (IV ${(iv * 100).toFixed(0)}%)` : ''}`;
        } catch {
          return `${t}: ERR`;
        }
      })
    );

    await reply(chatId, `💹 <b>Watchlist Prices</b>\n\n${prices.join('\n')}\n\n⏰ Delayed ~15min`);
  } catch (err) {
    await reply(chatId, `❌ Prices error: ${err.message}`);
  }
}

async function handleScan(chatId) {
  try {
    const store = getStore('trading-data');
    const scanData = await store.get('latest-scan', { type: 'json' });

    if (!scanData) {
      await reply(chatId, '⚠️ No scan data yet. Run a scan first via the dashboard.');
      return;
    }

    const { generatedAt, regime, candidates } = scanData;
    const date = generatedAt ? new Date(generatedAt).toISOString().slice(0, 16) : 'unknown';
    const top5 = (candidates || []).slice(0, 5);

    let msg = `🔍 <b>Latest Scan</b> (${date} UTC)\n`;
    msg += `VIX Regime: <b>${regime || 'UNKNOWN'}</b>\n\n`;

    if (top5.length === 0) {
      msg += 'No candidates found.';
    } else {
      msg += '<b>Top Candidates:</b>\n';
      for (const c of top5) {
        msg += `\n${c.strategy === 'CSP' ? '📉' : '📈'} <b>${c.ticker}</b> — ${c.strategy}\n`;
        msg += `  Score: ${c.score || '—'} | Conf: ${c.confidence || '—'}\n`;
        msg += `  ${c.rationale || ''}\n`;
      }
    }

    await reply(chatId, msg);
  } catch (err) {
    await reply(chatId, `❌ Scan error: ${err.message}`);
  }
}

async function handleCheck(chatId, ticker, strategy) {
  if (!ticker) {
    await reply(chatId, 'Usage: /check TICKER [CSP|CALL]');
    return;
  }
  try {
    const resp = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) {
      await reply(chatId, `❌ CBOE returned ${resp.status} for ${ticker}`);
      return;
    }
    const data = await resp.json();
    const price = data.data?.current_price;
    const iv30 = data.data?.iv30;
    const ivr = data.data?.iv_percentile;

    let msg = `🔎 <b>${ticker}</b>\n`;
    msg += `Price: $${price?.toFixed(2) || 'N/A'}\n`;
    msg += `IV30: ${iv30 ? (iv30 * 100).toFixed(1) + '%' : 'N/A'}\n`;
    msg += `IVR: ${ivr ? (ivr * 100).toFixed(0) + '%' : 'N/A'}\n`;

    if (strategy) {
      const strat = strategy.toUpperCase();
      if (strat === 'CSP') {
        const ivRank = ivr ? ivr * 100 : 0;
        msg += `\nCSP Assessment: ${ivRank >= 15 ? '✅ IVR eligible' : '⚠️ IVR too low for CSP'}`;
      } else if (strat === 'CALL') {
        const ivRank = ivr ? ivr * 100 : 100;
        msg += `\nCALL Assessment: ${ivRank <= 25 ? '✅ IV not too elevated' : '⚠️ High IV — options expensive'}`;
      }
    }

    await reply(chatId, msg);
  } catch (err) {
    await reply(chatId, `❌ Check error: ${err.message}`);
  }
}

async function handleAdd(chatId, ticker, strategy) {
  if (!ticker || !strategy) {
    await reply(chatId, 'Usage: /add TICKER STRATEGY (CSP or CALL)');
    return;
  }
  const strat = strategy.toUpperCase();
  if (!['CSP', 'CALL'].includes(strat)) {
    await reply(chatId, '❌ Strategy must be CSP or CALL');
    return;
  }
  const watchlist = await getWatchlist();
  if (watchlist.find(w => w.ticker === ticker.toUpperCase())) {
    await reply(chatId, `⚠️ ${ticker.toUpperCase()} already in watchlist`);
    return;
  }
  watchlist.push({ ticker: ticker.toUpperCase(), strategy: strat });
  await saveWatchlist(watchlist);
  await reply(chatId, `✅ Added ${ticker.toUpperCase()} (${strat}) to watchlist`);
}

async function handleRemove(chatId, ticker) {
  if (!ticker) {
    await reply(chatId, 'Usage: /remove TICKER');
    return;
  }
  const watchlist = await getWatchlist();
  const updated = watchlist.filter(w => w.ticker !== ticker.toUpperCase());
  if (updated.length === watchlist.length) {
    await reply(chatId, `⚠️ ${ticker.toUpperCase()} not found in watchlist`);
    return;
  }
  await saveWatchlist(updated);
  await reply(chatId, `✅ Removed ${ticker.toUpperCase()} from watchlist`);
}

async function handleWatchlist(chatId) {
  const watchlist = await getWatchlist();
  const calls = watchlist.filter(w => w.strategy === 'CALL').map(w => w.ticker).join(', ');
  const csps = watchlist.filter(w => w.strategy === 'CSP').map(w => w.ticker).join(', ');
  await reply(chatId,
    `📋 <b>Watchlist</b>\n\n` +
    `📈 <b>CALL:</b> ${calls || 'none'}\n` +
    `📉 <b>CSP:</b> ${csps || 'none'}`
  );
}

async function handleHelp(chatId) {
  await reply(chatId,
    `🤖 <b>MD Trading Bot Commands</b>\n\n` +
    `/status — Account balance & Net Liq\n` +
    `/prices — Watchlist prices (delayed)\n` +
    `/scan — Latest scan results (top 5)\n` +
    `/check TICKER [CSP|CALL] — Quick IV check\n` +
    `/add TICKER CSP|CALL — Add to watchlist\n` +
    `/remove TICKER — Remove from watchlist\n` +
    `/watchlist — Show watchlist\n` +
    `/help — This message`
  );
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const message = body?.message;
  if (!message) return new Response('OK', { status: 200 });

  const chatId = String(message.chat?.id);
  const text = (message.text || '').trim();

  // Security: only respond to authorized chat
  if (chatId !== String(ALLOWED_CHAT_ID)) {
    console.log(`Unauthorized chat ${chatId}`);
    return new Response('OK', { status: 200 });
  }

  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase().split('@')[0];

  try {
    switch (cmd) {
      case '/status':   await handleStatus(chatId); break;
      case '/prices':   await handlePrices(chatId); break;
      case '/scan':     await handleScan(chatId); break;
      case '/check':    await handleCheck(chatId, parts[1], parts[2]); break;
      case '/add':      await handleAdd(chatId, parts[1], parts[2]); break;
      case '/remove':   await handleRemove(chatId, parts[1]); break;
      case '/watchlist': await handleWatchlist(chatId); break;
      case '/help':     await handleHelp(chatId); break;
      default:
        await reply(chatId, `Unknown command. Type /help for the command list.`);
    }
  } catch (err) {
    await reply(chatId, `⚠️ Error: ${err.message}`);
  }

  return new Response('OK', { status: 200 });
};

export const config = {
  path: '/api/tg-webhook',
};
