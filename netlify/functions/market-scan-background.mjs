// market-scan-background.mjs — Charter v1.0 §12 stage-1/stage-2 market-wide scan (Netlify background function, 15-min budget)
// Trigger: POST /api/market-scan-run  (header x-scan-key = MARKET_SCAN_KEY)  ← called by nightly-market-scan.mjs
// Output: Blobs 'trading-data' / 'market-scan'  +  Telegram summary.   BUILD 2026-09-27
import { getStore } from '@netlify/blobs';
import { getTTToken } from './lib/tt-auth.mjs';
import { CFG, getNLV, fetchMetrics, fetchVIX, regimeOf, fetchChain, buildPCS, buildDebit, pcsCandidate, convexCandidate, sendTelegram } from './lib/scan-core.mjs';
import { MARKET_UNIVERSE, sourceOf } from './lib/universe.mjs';

const MIN_PRICE = 10;
const TOP_CREDIT = 40;      // stage-2 chain pulls for the credit lane
const TOP_DEBIT  = 120;     // stage-2 chain pulls for the debit lane (IV rank <40, both directions; armed direction labelled)

async function metricsParallel(token, tickers, conc = 4) {
  const chunks = []; for (let i = 0; i < tickers.length; i += 50) chunks.push(tickers.slice(i, i + 50));
  const out = {};
  for (let i = 0; i < chunks.length; i += conc) {
    const res = await Promise.all(chunks.slice(i, i + conc).map(c => fetchMetrics(token, c)));
    for (const r of res) Object.assign(out, r);
  }
  return out;
}

export default async (req) => {
  const key = Netlify.env.get('MARKET_SCAN_KEY');
  if (key && req.headers.get('x-scan-key') !== key) return new Response('forbidden', { status: 403 });
  const t0 = Date.now();
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') || 'nightly';
  const paper = mode === 'paper';                                   // 15 Oct: paper lane — same gates, hypothetical NLV, no real sizing
  const nlvOverride = parseFloat(url.searchParams.get('nlv') || '0');
  // paper-only gate overrides for sensitivity tests (never applied to the real lane)
  if (paper) { const cw = parseFloat(url.searchParams.get('cw') || '0'); if (cw > 0) CFG.MIN_CREDIT_WIDTH = cw; const dl = parseFloat(url.searchParams.get('delta') || '0'); if (dl > 0) CFG.TARGET_SHORT_DELTA = dl; }
  try {
    const token = await getTTToken();
    const [nlvReal, vix] = await Promise.all([getNLV(token), fetchVIX()]);
    const nlv = paper && nlvOverride > 0 ? nlvOverride : nlvReal;
    const regime = regimeOf(vix);
    const veto = (Netlify.env.get('IO_FUND_VETO_LIST') || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    const trigger = (Netlify.env.get('KNOX_TRIGGER') || 'off').toLowerCase();

    const tickers = MARKET_UNIVERSE.map(([t]) => t);
    const metrics = await metricsParallel(token, tickers);
    const tMetrics = Date.now() - t0;

    // ── Stage 1: mechanical gates + flags ──────────────────────────────────
    const rows = [];
    let gLiq = 0, gEarn = 0, gNoData = 0;
    for (const [t, idx] of MARKET_UNIVERSE) {
      const m = metrics[t];
      if (!m) { gNoData++; continue; }
      if (!m.liquidity || m.liquidity < CFG.MIN_LIQUIDITY) { gLiq++; continue; }
      if (m.earningsKnown && m.earningsDays >= 0 && m.earningsDays < CFG.EARNINGS_BUFFER) { gEarn++; continue; }
      const ivr = m.ivRank, ivp = m.ivPct;
      const flags = [];
      if (ivr != null && ivr >= CFG.IV_SELL_CLEAR) flags.push('RICH');
      else if (ivr != null && ivr >= CFG.IV_SELL_FLOOR) flags.push('MID');
      if (ivr != null && ivr < CFG.IV_SELL_FLOOR) flags.push('CHEAP');
      if (ivp != null && ivp < CFG.IV_PCTL_WARN) flags.push('IV-1Y-LOW');
      if (m.iv5d != null && m.iv > 0 && m.iv5d / m.iv >= 0.20) flags.push('IV-SPIKE');
      rows.push({ ticker: t, index: idx, source: sourceOf(t), ivRank: ivr, ivPct: ivp, iv: m.iv, iv5d: m.iv5d ?? null,
                  liquidity: m.liquidity, earningsDays: m.earningsDays, veto: veto.includes(t), flags });
    }
    const rich  = rows.filter(r => r.flags.includes('RICH')).sort((a, b) => (b.liquidity - a.liquidity) || (b.ivRank - a.ivRank));
    const mid   = rows.filter(r => r.flags.includes('MID')).sort((a, b) => b.ivRank - a.ivRank);
    const cheap = rows.filter(r => r.flags.includes('CHEAP')).sort((a, b) => (a.ivPct ?? 99) - (b.ivPct ?? 99));
    const spike = rows.filter(r => r.flags.includes('IV-SPIKE')).sort((a, b) => (b.iv5d / b.iv) - (a.iv5d / a.iv));

    // ── Stage 2: real chains for the top of each lane ──────────────────────
    const credit = [];
    for (const r of rich.slice(0, TOP_CREDIT)) {
      try {
        const chain = await fetchChain(r.ticker);
        if (!chain.price || chain.price < MIN_PRICE) continue;
        const u = { ticker: r.ticker, sector: r.index, tier: 3, source: r.source, ivBand: 'SELL-CLEAR', ivLowWarn: false };
        const m = { ivRank: r.ivRank, iv: r.iv, earningsDays: r.earningsDays, liquidity: r.liquidity };
        const s1 = buildPCS(chain, nlv, CFG.MAX_RISK_PCT);
        if (s1) credit.push(pcsCandidate(u, chain, m, s1, regime));
        const s2 = buildPCS(chain, nlv, CFG.TIER2_RISK_PCT);
        if (s2 && s2.pop >= CFG.TIER2_MIN_POP && s2.cw >= CFG.TIER2_MIN_CW && (!s1 || s2.maxLoss > s1.maxLoss * 1.3)) {
          const c2 = pcsCandidate(u, chain, m, s2, regime); c2.sizeTier = 'TIER-2 CONVICTION (4%)'; c2.tier2 = true; credit.push(c2);
        }
      } catch (e) { console.warn('chain', r.ticker, e.message); }
    }
    credit.sort((a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0));

    // Debit lane: both directions, over buy-side IV names (rank <40) ranked by liquidity; direction gating is the trader's (Charter §4)
    const debit = [];
    const buyable = rows.filter(r => r.ivRank != null && r.ivRank < CFG.MAX_IV_RANK_CONVEX)
      .sort((a, b) => (b.liquidity - a.liquidity) || ((a.ivPct ?? 99) - (b.ivPct ?? 99))).slice(0, TOP_DEBIT);
    const chainCache = {};
    for (let i = 0; i < buyable.length; i += 8) {
      const batch = buyable.slice(i, i + 8);
      const got = await Promise.all(batch.map(async r => { try { return [r, await fetchChain(r.ticker)]; } catch { return [r, null]; } }));
      for (const [r, chain] of got) {
        if (!chain || !chain.price || chain.price < MIN_PRICE) continue;
        chainCache[r.ticker] = chain;
        for (const dir of ['calls', 'puts']) {
          if (dir === 'puts' && r.veto) continue;                       // never a put against an IO Fund name
          const x = buildDebit(chain, nlv, dir, CFG.DEBIT_MAX_RISK_PCT);
          if (!x) continue;
          const c = convexCandidate({ ticker: r.ticker, sector: r.index, tier: 'M', source: r.source, ivBand: r.ivRank < CFG.IV_SELL_FLOOR ? 'BUY-ONLY' : 'MID' }, chain, { ivRank: r.ivRank, iv: r.iv, earningsDays: r.earningsDays, liquidity: r.liquidity }, x, regime);
          c.direction = dir; c.armed = (trigger === dir); c.sizeTier = 'DEBIT TIER-1 (≤2%)'; c.ivPctl = r.ivPct; c.ivLowWarn = r.ivPct != null && r.ivPct < CFG.IV_PCTL_WARN;
          debit.push(c);
        }
      }
    }
    debit.sort((a, b) => (b.armed - a.armed) || ((b.rr || 0) - (a.rr || 0)));

    const result = {
      generatedAt: new Date().toISOString(), mode, charter: 'v1.0', vix: vix.toFixed(2), regime, nlv, trigger,
      universe: MARKET_UNIVERSE.length, withMetrics: rows.length + gLiq + gEarn,
      gates: { noData: gNoData, liquidityBelow3: gLiq, earningsWithin14d: gEarn, passedStage1: rows.length },
      lanes: { rich: rich.length, mid: mid.length, cheap: cheap.length, ivSpike: spike.length },
      credit, debit, debitArmed: debit.filter(c => c.armed).length, debitCounter: debit.filter(c => !c.armed).length,
      watch: { rich: rich.slice(0, 25), ivSpike: spike.slice(0, 15), cheapest: cheap.slice(0, 15) },
      timing: { metricsMs: tMetrics, totalMs: Date.now() - t0 },
    };
    const store = getStore('trading-data');
    if (paper) {
      // Paper lane: record every gate-passing credit setup at the hypothetical NLV so expectancy can be measured before any capital is added (Charter §13 Stage B evidence).
      result.paperNlv = nlv; result.realNlv = nlvReal;
      await store.setJSON('market-scan-paper', result);
      const log = (await store.get('paper-log', { type: 'json' })) || [];
      const day = result.generatedAt.slice(0, 10);
      for (const c of credit.slice(0, 10)) {
        const id = `${day}:${c.ticker}:${c.suggestedStrike}:${c.expiry || c.nearExpiry || ''}`;
        if (log.some(x => x.id === id)) continue;
        log.push({ id, day, ticker: c.ticker, source: c.source, strikes: c.suggestedStrike, expiry: c.expiry || c.nearExpiry || null, dte: c.dte ?? null, credit: c.credit, maxLoss: c.maxLoss, pop: c.pop, ivr: c.ivrPct, tier2: !!c.tier2, status: 'open' });
      }
      await store.setJSON('paper-log', log.slice(-400));
      await sendTelegram(`🧪 <b>Paper lane</b> (NLV $${nlv.toLocaleString()} hypothetical) · ${credit.length} credit setups cleared all gates${credit.length ? ': ' + credit.slice(0, 5).map(c => `${c.ticker} ${c.suggestedStrike} cr $${c.credit} maxL $${c.maxLoss} POP ${c.pop}%`).join(' · ') : ''} · log ${log.length} entries. Nothing is traded from this lane.`);
      return new Response(JSON.stringify({ ok: true, paper: true, credit: credit.length, logged: log.length }), { headers: { 'Content-Type': 'application/json' } });
    }
    await store.setJSON('market-scan', result);
    await sendTelegram(buildMsg(result));
    return new Response(JSON.stringify({ ok: true, credit: credit.length, debit: debit.length, ms: result.timing.totalMs }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('market-scan:', err);
    await sendTelegram(`⚠️ Market scan failed: ${err.message}`);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

function buildMsg(r) {
  const g = r.gates, l = r.lanes;
  let m = `🌐 <b>Market scan — ${r.mode}</b> · Charter v1.0\n`;
  m += `VIX ${r.vix} · <b>${r.regime}</b> · NLV $${r.nlv.toLocaleString()} · direction ${r.trigger}\n`;
  m += `Universe ${r.universe} → liq≥3 & no earnings 14d: <b>${g.passedStage1}</b> (liq −${g.liquidityBelow3}, earnings −${g.earningsWithin14d}, no data −${g.noData})\n`;
  m += `IV lanes: rich ≥40 <b>${l.rich}</b> · mid 20–40 ${l.mid} · cheap &lt;20 ${l.cheap} · IV spikes ${l.ivSpike}\n\n`;
  const t1 = r.credit.filter(c => !c.tier2).slice(0, 5), t2 = r.credit.filter(c => c.tier2).slice(0, 3);
  if (!t1.length && !t2.length) m += `📉 Credit lane: <b>0 setups cleared all gates</b> (${r.lanes.rich} rich-IV names; at $${Math.round(r.nlv/1000)}K NLV a 2–4% cap fits only $1–2.5 wide spreads) — no-trade is the output.\n`;
  else {
    m += `📉 <b>Credit setups (Tier-1, 2%)</b>\n`;
    for (const c of t1) m += `  <b>${c.ticker}</b> ${c.suggestedStrike} · ${c.dte}d · cr $${c.credit} · maxL $${c.maxLoss} · POP ${c.pop}% · IVR ${c.ivrPct} · ${c.source}${c.veto ? ' · IO name' : ''}\n`;
    if (t2.length) { m += `🔶 <b>Tier-2 candidates (4%) — 3 signals required, written first</b>\n`; for (const c of t2) m += `  <b>${c.ticker}</b> ${c.suggestedStrike} · ${c.dte}d · cr $${c.credit} · maxL $${c.maxLoss} · POP ${c.pop}%\n`; }
  }
  const armed = r.debit.filter(c => c.armed).slice(0, 6), counter = r.debit.filter(c => !c.armed).slice(0, 6);
  if (armed.length) { m += `\n🎟️ <b>Debit lane — ${r.trigger.toUpperCase()} (armed direction)</b>\n`; for (const c of armed) m += `  <b>${c.ticker}</b> ${c.suggestedStrike} · $${c.optionCost} · ${c.rr}:1 · ${c.expDays}d · IVR ${c.ivrPct}${c.ivLowWarn ? ' (1y-low)' : ''} · ${c.source}\n`; }
  else if (r.trigger === 'calls' || r.trigger === 'puts') m += `\n🎟️ Debit lane (${r.trigger}): 0 setups ≥2:1 within 2% — no-trade.\n`;
  if (counter.length) { const d = counter[0].direction.toUpperCase(); m += `\n🔁 <b>Debit lane — ${d} (NOT armed; needs a written regime case, Charter §4)</b>\n`; for (const c of counter) m += `  ${c.ticker} ${c.suggestedStrike} · $${c.optionCost} · ${c.rr}:1 · ${c.expDays}d · ${c.source}\n`; }
  if (r.watch.ivSpike.length) { m += `\n⚡ <b>IV spikes (something is happening — thesis required)</b>\n`; for (const w of r.watch.ivSpike.slice(0, 5)) m += `  ${w.ticker} IV ${w.iv}% (+${Math.round(w.iv5d)} 5d) · IVR ${w.ivRank} · ${w.source}\n`; }
  m += `\n<i>§12 thesis rule: a name not covered by IO/CML/Knox is a watch entry until the 2–3 signals are written by hand.</i>`;
  return m;
}

export const config = { path: '/api/market-scan-run' };
