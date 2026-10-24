// lib/hsbc-core.mjs — HSBC tranche triggers, PLAN B (Deployment_Plan_Monday_10Aug2026.md) as reconciled 28 Sep 2026.
// IPS §7b: triggers anchored to OWN fills / CHANGES in DXY / TIME backstops — never a fixed level of a trending index.
// Daily after the US close. Alerts on STATE CHANGE and backstop countdowns; Monday = weekly summary regardless.
// Edit TRIGGERS here in writing when the plan is amended — never ad hoc.  BUILD 2026-10-03 v3
import { getStore } from '@netlify/blobs';
import { sendTelegram } from './scan-core.mjs';

const TRIGGERS = {
  T3: { label: 'T3 — $8,500 (VWRA recommended)', anchor: 'VWRA', t2Fill: 191.76, dropPct: 7, backstop: '2026-10-15', dxyDropPct: 3 },
  T4: { label: 'T4 — COPX ~$13K in thirds, dollar-conditioned', dxyDropPct: 3, secondDropPct: 6 },
  T5: { label: 'T5 — gold ladder (GLDM allowed since 2 Oct)', goldReclaim: 4100, dxyDropPct: 3 },
  GOLD: { t2Fill: 81.885, t3DropPct: 8 },   // 2 Oct: Gold T2 bought in GLDM ($3,500 @ $81.885). T3 fires at −8% from T2 fill ($75.33) or the 1 Dec backstop.
  EM: { label: 'EM headwind (EIMI / VWRA EM sleeve)', dxyLine: 100.60 },
  DATED: [   // Plan Oct–Dec 2026: dated structural steps; the dollar signal can redirect them to COPX (T4 has prior claim on VDST)
    { id: 'V1', date: '2026-11-16', label: 'VDST → VWRA, first half', amount: 5000 },
    { id: 'V2', date: '2026-12-15', label: 'VDST → VWRA, second half', amount: 5000 },
    { id: 'G3', date: '2026-12-01', label: 'Gold T3 backstop ($3,500 → GLDM; GLDM ≤ $75.33 or 10 closes > 200-day fire it earlier)', amount: 3500 },
  ],
  EQQQ: { label: 'EQQQ second half → XDEW', smhLevel: 545, failSessions: 3, holdAbove: 672 },   // 3 Oct: hold level raised 640 → 672 (Knox 29 Sep negation zone 640–671.83). Swap only if SMH closes <545 ×3; SMH >672 closes the question (hold).
};
const UA = { 'User-Agent': 'Mozilla/5.0' };

async function yf(sym, range = '1y') {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
  const d = (await r.json()).chart?.result?.[0];
  const closes = (d?.indicators?.quote?.[0]?.close || []).filter(x => x != null);
  return { last: d?.meta?.regularMarketPrice ?? closes.at(-1), closes };
}
const daysTo = (iso) => Math.ceil((new Date(iso + 'T23:59:59Z') - Date.now()) / 86400000);
const trailing = (closes, n) => closes.slice(-n);

export async function runHsbc({ force = false, status = false } = {}) {
  const store = getStore({ name: 'trading-data', consistency: 'strong' });
  const prev = (await store.get('hsbc-state', { type: 'json' })) || {};
  if (status) return { ok: true, state: prev, triggers: TRIGGERS };
  const alerts = [];
  try {
    const [vwra, dxy, gold, copx, smh, wti] = await Promise.all([yf('VWRA.L'), yf('DX-Y.NYB'), yf('GC=F'), yf('COPX'), yf('SMH'), yf('CL=F')]);

    // Dollar signal (shared by T3 accelerator, T4, T5): −3% from the trailing 6-month high of DXY closes
    const dxy6mHigh = Math.max(...trailing(dxy.closes, 126));
    const dxyDrop = (dxy.last / dxy6mHigh - 1) * 100;                  // negative = below the high
    const dxySignal1 = dxyDrop <= -TRIGGERS.T4.dxyDropPct;
    const dxySignal2 = dxyDrop <= -TRIGGERS.T4.secondDropPct;

    // T3 accelerator: VWRA −7% from the T2 fill
    const t3Level = +(TRIGGERS.T3.t2Fill * (1 - TRIGGERS.T3.dropPct / 100)).toFixed(2);
    const vwraFromFill = (vwra.last / TRIGGERS.T3.t2Fill - 1) * 100;

    // EQQQ tell: consecutive SMH closes below 600 since the break
    let smhBelowRun = 0; for (let i = smh.closes.length - 1; i >= 0 && smh.closes[i] < TRIGGERS.EQQQ.smhLevel; i--) smhBelowRun++;

    const goldAbove = gold.last >= TRIGGERS.T5.goldReclaim;

    const s = {
      lastRun: new Date().toISOString(), plan: 'B (10 Aug 2026, reconciled 28 Sep)',
      vwra: vwra.last, t3Level, vwraFromFill: +vwraFromFill.toFixed(2),
      dxy: dxy.last, dxy6mHigh: +dxy6mHigh.toFixed(2), dxyDrop: +dxyDrop.toFixed(2), dxySignalLevel: +(dxy6mHigh * 0.97).toFixed(2),
      gold: gold.last, goldAbove, copx: copx.last, smh: smh.last, smhBelowRun, wti: wti.last,
      t3: prev.t3 || 'waiting', t4: prev.t4 || 'waiting', t5: prev.t5 || 'waiting', eqqq: prev.eqqq || 'watch',
      backstopAlerts: prev.backstopAlerts || {},
    };

    // ── T3 ──
    const d3 = daysTo(TRIGGERS.T3.backstop);
    if (s.t3 === 'waiting') {
      if (vwra.last <= t3Level) { s.t3 = 'FIRED-vwra-7pct'; alerts.push(`🟢 <b>T3 FIRES — VWRA $${vwra.last.toFixed(2)} is ${vwraFromFill.toFixed(1)}% below the T2 fill ($${TRIGGERS.T3.t2Fill}).</b> Deploy $8,500 (VWRA recommended). Deal after 17:30 Dubai. Oil $${wti.last.toFixed(0)}.`); }
      else if (dxySignal1) { s.t3 = 'FIRED-dxy'; alerts.push(`🟢 <b>T3 FIRES — DXY ${dxy.last.toFixed(2)} is ${dxyDrop.toFixed(1)}% off its 6-month high (${dxy6mHigh.toFixed(2)}).</b> Deploy $8,500. (Same signal starts the T4/T5 dollar clock — see below.)`); }
      else if (d3 <= 0) { s.t3 = 'FIRED-backstop'; alerts.push(`⏰ <b>T3 TIME BACKSTOP (15 Oct) — deploy $8,500 today.</b> VWRA $${vwra.last.toFixed(2)} (${vwraFromFill >= 0 ? '+' : ''}${vwraFromFill.toFixed(1)}% vs T2 fill); neither accelerator fired, which is the normal outcome. After this: cash+VDST ≈ 32% of HSBC.`); }
      else if ([7, 3, 1].includes(d3) && !s.backstopAlerts[`t3-${d3}`]) { s.backstopAlerts[`t3-${d3}`] = true; alerts.push(`⏳ T3 backstop in <b>${d3} day${d3 > 1 ? 's' : ''}</b> (15 Oct). VWRA $${vwra.last.toFixed(2)} vs accelerator $${t3Level} · DXY ${dxy.last.toFixed(2)} vs ${s.dxySignalLevel}. Decide the instrument (VWRA recommended) so it's one order on the day.`); }
    }
    // ── T4 (thirds on the dollar) ──
    const t4now = dxySignal2 ? 'SIGNAL-2 (second third)' : dxySignal1 ? 'SIGNAL-1 (first third)' : 'waiting';
    if ((prev.t4 || 'waiting') !== t4now) {
      if (t4now.startsWith('SIGNAL-1')) alerts.push(`🟢 <b>T4 — dollar signal 1:</b> DXY ${dxy.last.toFixed(2)}, ${dxyDrop.toFixed(1)}% off the 6-month high. Release COPX tranche ⅓ (~$4.3K) at market (COPX $${copx.last.toFixed(2)}, ${((copx.last / Math.max(...copx.closes) - 1) * 100).toFixed(0)}% off its 1-yr high). Fund from VDST.`);
      else if (t4now.startsWith('SIGNAL-2')) alerts.push(`🟢 <b>T4 — dollar signal 2:</b> DXY ${dxy.last.toFixed(2)}, ${dxyDrop.toFixed(1)}% off the high. Second COPX third. Final third waits for a Fed pivot (manual).`);
      else alerts.push(`↩️ T4: DXY back within 3% of its 6-month high (${dxy.last.toFixed(2)} vs ${dxy6mHigh.toFixed(2)}) — dollar signal withdrawn. No further COPX thirds.`);
    }
    s.t4 = t4now;
    // ── T5 gold ──
    const t5now = goldAbove && dxySignal1 ? 'BOTH-LEGS' : goldAbove ? 'price-leg-only' : 'waiting';
    if ((prev.t5 || 'waiting') !== t5now) {
      if (t5now === 'BOTH-LEGS') alerts.push(`🟢 <b>T5 GOLD — both legs met:</b> gold $${gold.last.toFixed(0)} ≥ $4,100 AND dollar signal. Ladder ⅓ (GLDM — Irish ETCs are blocked at HSBC).`);
      else if (t5now === 'price-leg-only') alerts.push(`🟡 T5 gold: price leg met (gold $${gold.last.toFixed(0)} ≥ $4,100); dollar leg not (DXY ${dxy.last.toFixed(2)}, needs ≤ ${s.dxySignalLevel}). Spec requires both.`);
      else alerts.push(`↩️ T5 gold back below $4,100 ($${gold.last.toFixed(0)}) — price leg lost.`);
    }
    s.t5 = t5now;
    // ── Dated steps (countdowns 7/3/1 days + day-of) ──
    for (const d of TRIGGERS.DATED) {
      const n = daysTo(d.date); const key = `${d.id}-${n <= 0 ? 'due' : n}`;
      if ((n <= 0 || [7, 3, 1].includes(n)) && !s.backstopAlerts[key] && n > -3) {
        s.backstopAlerts[key] = true;
        const copx = dxySignal1 ? ` ⚠️ Dollar signal is ON → this $${d.amount.toLocaleString()} goes to COPX instead (T4 first).` : '';
        alerts.push(n <= 0 ? `⏰ <b>DUE TODAY — ${d.label}</b> ($${d.amount.toLocaleString()}). Deal after 17:30 Dubai.${copx}` : `⏳ ${d.label} in <b>${n} day${n > 1 ? 's' : ''}</b> (${d.date}).${copx}`);
      }
    }
    // ── EM headwind ──
    const emNow = dxy.last > TRIGGERS.EM.dxyLine ? 'headwind' : 'clear';
    if (prev.em && prev.em !== emNow) alerts.push(emNow === 'headwind' ? `⚠️ DXY above 100.60 (${dxy.last.toFixed(2)}) — EM headwind on EIMI / VWRA EM sleeve.` : `🟢 DXY below 100.60 (${dxy.last.toFixed(2)}) — EM headwind lifting.`);
    s.em = emNow;
    // ── EQQQ second half ──
    const eqNow = smhBelowRun >= TRIGGERS.EQQQ.failSessions ? 'COMPLETE-SWAP' : smhBelowRun > 0 ? `below-545-${smhBelowRun}` : (smh.last >= TRIGGERS.EQQQ.holdAbove ? 'HOLD-resolved' : 'hold');
    if ((prev.eqqq || 'watch') !== eqNow && (eqNow === 'COMPLETE-SWAP' || eqNow === 'hold' || smhBelowRun === 1)) {
      if (eqNow === 'COMPLETE-SWAP') alerts.push(`🔁 <b>EQQQ second half → XDEW:</b> SMH has closed below $545 for ${smhBelowRun} sessions ($${smh.last.toFixed(2)}) — Knox bear count CONFIRMED. Sell remaining EQQQ (~$10.7K), buy XDEW; pause AI-hardware adds.`);
      else if (eqNow === 'hold' && (prev.eqqq || '').startsWith('below')) alerts.push(`🟢 SMH back above $545 ($${smh.last.toFixed(2)}) — EQQQ swap tell reset; hold.`);
      else if (eqNow === 'HOLD-resolved') alerts.push(`🟢 SMH closed above $${TRIGGERS.EQQQ.holdAbove} ($${smh.last.toFixed(2)}) — bear count invalidated (Knox 29 Sep). Resume Sarwa adds at IO weights. EQQQ question closed: HOLD. (Options direction may go to calls.)`);
      else if (smhBelowRun === 1) alerts.push(`👀 SMH closed below $545 ($${smh.last.toFixed(2)}) — day 1 of ${TRIGGERS.EQQQ.failSessions} for the EQQQ swap / bear-count FIRE.`);
    }
    s.eqqq = eqNow;

    await store.setJSON('hsbc-state', s);
    const isMonday = new Date().getUTCDay() === 1;
    if (alerts.length || isMonday || force) {
      const hdr = `🏦 <b>HSBC tranche monitor</b> (Plan B) · ${new Date().toISOString().slice(0, 10)}\nVWRA $${vwra.last.toFixed(2)} (${vwraFromFill >= 0 ? '+' : ''}${vwraFromFill.toFixed(1)}% vs T2 fill; T3 accel ≤ $${t3Level}) · DXY ${dxy.last.toFixed(2)} (${dxyDrop.toFixed(1)}% vs 6m high ${dxy6mHigh.toFixed(2)}; signal ≤ ${s.dxySignalLevel}) · Gold $${gold.last.toFixed(0)} · COPX $${copx.last.toFixed(2)} · SMH $${smh.last.toFixed(0)}\n`;
      const tbl = `T3 ${s.t3}${s.t3 === 'waiting' ? ` (backstop ${d3}d)` : ''} · T4 ${s.t4} · T5 ${s.t5} · EM ${s.em} · EQQQ ${s.eqqq}\n`;
      await sendTelegram(hdr + tbl + (alerts.length ? '\n' + alerts.join('\n\n') : '\n<i>No trigger changes.</i>'));
    }
    return { ok: true, alerts, state: s };
  } catch (err) {
    console.error('hsbc-monitor:', err);
    if (prev.lastError !== err.message) await sendTelegram(`⚠️ HSBC monitor error: ${err.message}`);
    await store.setJSON('hsbc-state', { ...prev, lastError: err.message });
    return { ok: false, error: err.message };
  }
}
