// daily-monitor-v2.mjs — renamed from daily-monitor.mjs to bypass Netlify hash cache
// Schedule: 0 13 * * 1-5 (1PM UTC = 5PM Dubai, Mon-Fri)
// BUILD: 2026-04-06T15:00:00Z
import { getTTToken } from './lib/tt-auth.mjs';
import { getWatchlist } from './lib/watchlist.mjs';

async function sendTelegram(message) {
  const botToken = Netlify.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Netlify.env.get('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
}

export default async (req) => {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('Weekend — skipping daily monitor');
    return;
  }

  try {
    const token = await getTTToken();
    const account = Netlify.env.get('TT_ACCOUNT') || '5WI51792';

    const [balanceResp, positionsResp] = await Promise.all([
      fetch(`https://api.tastyworks.com/accounts/${account}/balances`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' },
      }),
      fetch(`https://api.tastyworks.com/accounts/${account}/positions`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' },
      }),
    ]);

    const balData = await balanceResp.json();
    const bal = balData.data || {};
    const netLiq = parseFloat(bal['net-liquidating-value'] || 0);
    const cash = parseFloat(bal['cash-balance'] || 0);
    const optionsBP = parseFloat(bal['derivative-buying-power'] || 0);

    let positionLines = '';
    if (positionsResp.ok) {
      const posData = await positionsResp.json();
      const positions = posData.data?.items || [];
      if (positions.length > 0) {
        positionLines = '\n\n<b>Open Positions:</b>\n' +
          positions.map(p => `  ${p.symbol} ×${p.quantity} @ ${p['average-open-price']}`).join('\n');
      }
    }

    const watchlist = await getWatchlist();
    const wlLine = watchlist.map(w => `${w.ticker}(${w.strategy})`).join(' · ');

    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16) + ' UTC';

    const msg = `📊 <b>Daily Monitor — ${dateStr}</b>\n` +
      `⏰ ${timeStr}\n\n` +
      `<b>Account ${account}</b>\n` +
      `💰 Net Liq: $${netLiq.toFixed(2)}\n` +
      `💵 Cash: $${cash.toFixed(2)}\n` +
      `🎯 Options BP: $${optionsBP.toFixed(2)}` +
      positionLines +
      `\n\n<b>Watchlist:</b>\n${wlLine}`;

    await sendTelegram(msg);
    console.log('Daily monitor sent successfully');
  } catch (err) {
    console.error('Daily monitor error:', err.message);
    await sendTelegram(`⚠️ Daily monitor error: ${err.message}`);
  }
};

// schedule removed 1 Nov 2026 (options off until January; Netlify_GitHub_Plan_28Oct2026). Re-add: export const config = { schedule: '...' };
