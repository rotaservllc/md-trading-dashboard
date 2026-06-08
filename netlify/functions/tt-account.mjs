// tt-account.mjs — tastytrade live account data via OAuth refresh token
// Renamed from tt-live.mjs to bypass Netlify esbuild hash cache (hash 9f58cedb was stuck)
// BUILD: 2026-04-06T15:00:00Z
import { getTTToken } from './lib/tt-auth.mjs';

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const t0 = Date.now();
    const token = await getTTToken();
    const t1 = Date.now();

    const account = Netlify.env.get('TT_ACCOUNT') || '5WI51792';

    const [balanceResp, positionsResp] = await Promise.all([
      fetch(`https://api.tastyworks.com/accounts/${account}/balances`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' },
      }),
      fetch(`https://api.tastyworks.com/accounts/${account}/positions`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' },
      }),
    ]);

    const t2 = Date.now();

    if (!balanceResp.ok) {
      const txt = await balanceResp.text();
      return new Response(
        JSON.stringify({ ok: false, error: `Balance fetch failed ${balanceResp.status}`, detail: txt }),
        { status: 502, headers }
      );
    }

    const balData = await balanceResp.json();
    const bal = balData.data || {};

    let positions = [];
    if (positionsResp.ok) {
      const posData = await positionsResp.json();
      positions = (posData.data?.items || []).map((p) => ({
        symbol: p.symbol,
        type: p['instrument-type'],
        quantity: p.quantity,
        costBasis: p['average-open-price'],
        multiplier: p.multiplier || 1,
      }));
    }

    const netLiq = parseFloat(bal['net-liquidating-value'] || 0);
    const cash = parseFloat(bal['cash-balance'] || 0);
    const optionsBP = parseFloat(bal['derivative-buying-power'] || 0);
    const dayPnL = parseFloat(bal['day-trading-buying-power'] || 0);

    return new Response(
      JSON.stringify({
        ok: true,
        summary: {
          netLiq,
          cash,
          optionsBP,
          dayPnL,
          positions,
          account,
          timing: { tokenMs: t1 - t0, dataMs: t2 - t1, totalMs: t2 - t0 },
        },
      }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers }
    );
  }
};

export const config = {
  path: '/api/tt-live',
};
