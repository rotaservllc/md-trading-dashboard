// lib/intraday-core.mjs — Charter v1.0 intraday triggers (shared by intraday-monitor [cron] and intraday-check [HTTP]). Runs every 15 min during US cash hours (Mon–Fri 13:30–20:00 UTC),
// alerts on STATE CHANGES only (crossings), never on every poll. State kept in Blobs 'trading-data'/'intraday-state'.
// Manual run: GET /api/intraday-monitor?force=1 (ignores market-hours guard; still dedupes) · ?status=1 shows current state.
// BUILD 2026-09-27
import { getStore } from '@netlify/blobs';
import { getTTToken } from './tt-auth.mjs';
import { fetchVIX, sendTelegram } from './scan-core.mjs';
import { getWatchlist } from './watchlist.mjs';
import { RESEARCH_TAGS } from './universe.mjs';

const TT = 'https://api.tastyworks.com';
const UA = { 'User-Agent': 'md-trading-dashboard/1.0' };

// ── Levels (Charter §4 / Knox 21 Sep charts: FIRE <545 ×3, INVALIDATE >672 (Knox 29 Sep negation 640–671.83; was 640), TLT WARN <80.91) — edit here in writing, never ad hoc ──
const LEVELS = [
  { sym: 'SMH', level: 545,   above: 'SMH back above $545 — bear FIRE level reclaimed',            below: '🔴 SMH below $545 — Knox bear-count FIRE level (3 closes = pause AI-hardware adds, execute IO trims, flip KNOX_TRIGGER)' },
  { sym: 'SMH', level: 672,   above: '🟢 SMH above $672 — Knox negation zone (640–671.83) cleared; bear count invalidated → resume Sarwa adds at IO weights; KNOX_TRIGGER may go to calls', below: '⚠️ SMH back below $672 — gate shut again: no new semi adds (Knox 29 Sep: (b) wave, 5-wave drop → $507–430)' },
  { sym: 'TLT', level: 80.91, above: '🟢 TLT reclaimed $80.91 — bond WARN cleared',               below: '⚠️ TLT below $80.91 — Knox WARN (leading indicator; watch SMH)' },
];
const VIX_BANDS = [20, 25];                 // regimeOf thresholds: MIXED ≥20, RISK-OFF ≥25
const VIX_JUMP_PCT = 15;                    // intraday jump vs prior poll
const IV_SHOCK_PCT = 25;                    // IV30 vs prior poll, research/watchlist names
const KILL_SWITCH_NLV = 4000;               // Charter §2
const TARGET_PCT = 0.50, STOP_PCT = 0.50;   // Charter §6: 50% of max gain / 50% of debit (long premium) — flags, execution is manual

// New York cash session 09:30–16:00 local, DST-aware (Intl handles EDT/EST); the cron (13–21 UTC) covers both halves of the year.
function nyOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd = get('weekday'); if (wd === 'Sat' || wd === 'Sun') return false;
  const m = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  return m >= 9 * 60 + 30 && m <= 16 * 60;
}

async function quotes(symbols) {
  const r = await fetch(`https://md-trading-dashboard.netlify.app/api/tt-quotes?symbols=${symbols.join(',')}`, { headers: UA });
  if (!r.ok) throw new Error(`tt-quotes ${r.status}`);
  return (await r.json()).quotes || {};
}

async function account(token) {
  const acct = Netlify.env.get('TT_ACCOUNT') || '5WI51792';
  const [b, p] = await Promise.all([
    fetch(`${TT}/accounts/${acct}/balances`, { headers: { Authorization: `Bearer ${token}`, ...UA } }),
    fetch(`${TT}/accounts/${acct}/positions`, { headers: { Authorization: `Bearer ${token}`, ...UA } }),
  ]);
  const bal = b.ok ? (await b.json()).data || {} : {};
  const pos = p.ok ? ((await p.json()).data?.items || []) : [];
  return {
    nlv: parseFloat(bal['net-liquidating-value'] || 0),
    positions: pos.map(x => ({
      symbol: x.symbol, type: x['instrument-type'], qty: +x.quantity, dir: x['quantity-direction'],
      open: parseFloat(x['average-open-price'] || 0), mark: parseFloat(x['mark-price'] ?? x['close-price'] ?? 0),
      mult: +x.multiplier || 100, exp: x['expires-at'] ? x['expires-at'].slice(0, 10) : null,
    })),
  };
}

export async function runIntraday({ force = false, status = false } = {}) {
  const store = getStore({ name: 'trading-data', consistency: 'strong' });
  const prev = (await store.get('intraday-state', { type: 'json' })) || {};
  if (status) return { ok: true, state: prev };
  if (!force && !nyOpen()) return { ok: true, skipped: 'market closed' };

  const alerts = [];
  const state = { ...prev, lastRun: new Date().toISOString() };
  try {
    const token = await getTTToken();
    const wl = await getWatchlist();
    const ivNames = [...new Set([...Object.keys(RESEARCH_TAGS), ...wl.map(w => w.ticker)])].filter(t => !['SPY','QQQ','SMH','TLT','IWM','DIA'].includes(t));
    const [vix, q, acct] = await Promise.all([fetchVIX(), quotes(['SMH', 'TLT', ...ivNames]), account(token)]);

    // 1) Knox levels — crossing detection
    state.levels ||= {};
    for (const L of LEVELS) {
      const px = q[L.sym]?.last; if (!px) continue;
      const key = `${L.sym}@${L.level}`; const side = px >= L.level ? 'above' : 'below';
      if (prev.levels?.[key] && prev.levels[key] !== side) alerts.push(`${side === 'above' ? L.above : L.below} (now $${px.toFixed(2)})`);
      state.levels[key] = side;
    }

    // 2) VIX bands + jump
    state.vix = vix;
    const band = v => v >= 25 ? 'RISK-OFF' : v >= 20 ? 'MIXED' : 'RISK-ON';
    if (prev.vix && band(prev.vix) !== band(vix)) alerts.push(`${band(vix) === 'RISK-ON' ? '🟢' : '⚠️'} VIX regime ${band(prev.vix)} → <b>${band(vix)}</b> (VIX ${vix.toFixed(2)})`);
    if (prev.vix && (vix - prev.vix) / prev.vix * 100 >= VIX_JUMP_PCT) alerts.push(`⚡ VIX +${((vix - prev.vix) / prev.vix * 100).toFixed(0)}% since last poll (${prev.vix.toFixed(1)} → ${vix.toFixed(1)}) — something is happening`);

    // 3) IV shocks on research / watchlist names
    state.iv30 ||= {};
    for (const t of ivNames) {
      const iv = q[t]?.iv30; if (!iv) continue;
      const p0 = prev.iv30?.[t];
      if (p0 && (iv - p0) / p0 * 100 >= IV_SHOCK_PCT) alerts.push(`⚡ <b>${t}</b> IV30 ${p0.toFixed(0)} → ${iv.toFixed(0)} (+${((iv - p0) / p0 * 100).toFixed(0)}%) · px $${q[t].last} · ${RESEARCH_TAGS[t] || 'watchlist'} — check news/earnings before anything`);
      state.iv30[t] = iv;
    }

    // 4) Account — kill switch + open positions vs Charter §6 exits
    state.nlv = acct.nlv;
    if (acct.nlv > 0 && acct.nlv < KILL_SWITCH_NLV && !(prev.nlv > 0 && prev.nlv < KILL_SWITCH_NLV)) alerts.push(`🛑 <b>KILL SWITCH</b>: NLV $${acct.nlv.toFixed(2)} < $${KILL_SWITCH_NLV}. No new trades until a written review (Charter §2).`);
    state.positions ||= {};
    const seen = new Set();
    for (const p of acct.positions.filter(p => p.type === 'Equity Option')) {
      seen.add(p.symbol);
      const isLong = p.dir === 'Long';
      const pl = (isLong ? (p.mark - p.open) : (p.open - p.mark)) * p.qty * p.mult;
      const dte = p.exp ? Math.round((new Date(p.exp) - Date.now()) / 86400000) : null;
      let flag = null;
      if (isLong && p.mark <= p.open * (1 - STOP_PCT)) flag = 'STOP';
      else if (isLong && p.mark >= p.open * (1 + TARGET_PCT)) flag = 'TARGET-50%';   // long-premium proxy; spreads: check the combo in tastytrade
      else if (!isLong && p.mark <= p.open * (1 - TARGET_PCT)) flag = 'TARGET-50%';
      else if (!isLong && p.mark >= p.open * 2) flag = 'STOP-2x';
      if (dte != null && dte <= 3) flag = (flag ? flag + ' + ' : '') + `EXPIRY ${dte}d`;
      if (flag && prev.positions?.[p.symbol] !== flag) alerts.push(`📌 <b>${p.symbol}</b> ${flag} · open ${p.open} → mark ${p.mark} · P/L $${pl.toFixed(0)} · ${dte}d — execute the pre-committed exit (stop-limit)`);
      state.positions[p.symbol] = flag || 'open';
    }
    for (const k of Object.keys(state.positions)) if (!seen.has(k)) delete state.positions[k];

    await store.setJSON('intraday-state', state);
    if (alerts.length) {
      const hdr = `⏱ <b>Intraday monitor</b> · ${new Date().toISOString().slice(11, 16)} UTC · VIX ${vix.toFixed(2)} · SMH $${q.SMH?.last ?? '?'} · TLT $${q.TLT?.last ?? '?'}\n\n`;
      await sendTelegram(hdr + alerts.join('\n\n'));
    }
    return { ok: true, alerts, vix, smh: q.SMH?.last, tlt: q.TLT?.last, nlv: acct.nlv, positions: acct.positions.length, first: !prev.vix };
  } catch (err) {
    console.error('intraday-monitor:', err);
    // don't spam: only alert on error state change
    if (prev.lastError !== err.message) await sendTelegram(`⚠️ Intraday monitor error: ${err.message}`);
    await store.setJSON('intraday-state', { ...state, lastError: err.message });
    return { ok: false, error: err.message };
  }
}

