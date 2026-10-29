// lib/hsbc-core.mjs — HSBC tranche triggers, PLAN B (Deployment_Plan_Monday_10Aug2026.md) as reconciled 28 Sep 2026.
// IPS §7b: triggers anchored to OWN fills / CHANGES in DXY / TIME backstops — never a fixed level of a trending index.
// Daily after the US close. Alerts on STATE CHANGE and backstop countdowns; Monday = weekly summary regardless.
// Edit TRIGGERS here in writing when the plan is amended — never ad hoc.  BUILD 2026-10-14 v3 (T4 price leg + backstop; V1/V2 drawdown accelerators; gold T3 = GLDM −8% / 10 closes > 200-day; GLDM allowed since 2 Oct)
import { getStore } from '@netlify/blobs';
import { sendTelegram } from './scan-core.mjs';

const TRIGGERS = {
  T3: { label: 'T3 — $8,500 (VWRA recommended)', anchor: 'VWRA', t2Fill: 191.76, dropPct: 7, backstop: '2026-10-15', dxyDropPct: 3 },
  T4: { label: 'T4 — COPX ~$13K in thirds', dxyDropPct: 3, secondDropPct: 6, copxDropPct: 20, backstop: '2027-01-15' },   // 14 Oct: dollar leg OR COPX −20% from its 6-month high OR time backstop fires the first third (IPS §7b: a dollar-only gate was unfireable)
  T5: { label: 'Gold T3 — $3,500 (GLDM, allowed since 2 Oct)', gldmT2Fill: 81.885, dropPct: 8, closesAbove200: 10, backstop: '2026-12-01' },   // 14 Oct: replaces the old $4,100+dollar spec; fires on GLDM ≤ −8% from the T2 fill ($75.33) OR 10 consecutive gold closes above the 200-day
  EM: { label: 'EM headwind (EIMI / VWRA EM sleeve)', dxyLine: 100.60 },
  DATED: [   // Plan Oct–Dec 2026: dated structural steps; the dollar signal can redirect them to COPX (T4 has prior claim on VDST)
    { id: 'V1', date: '2026-11-16', label: 'VDST → VWRA, first half', amount: 5000, accelPct: 5, anchor: 't3Fill' },   // 14 Oct: fires early on VWRA −5% from the T3 fill
    { id: 'V2', date: '2026-12-15', label: 'VDST → VWRA, second half', amount: 5000, accelPct: 5, anchor: 'v1Fill' }, // 14 Oct: fires early on VWRA −5% from the V1 fill
    { id: 'G3', date: '2026-12-01', label: 'Gold T3 backstop ($3,500 GLDM; GLDM ≤ $75.33 or 10 gold closes > 200-day fire it earlier)', amount: 3500 },
  ],
  EQQQ: { label: 'EQQQ second half → XDEW', smhLevel: 545, failSessions: 3, holdAbove: 672 },   // 1 Oct: resolved on LEVELS (IPS §7b) — swap only if SMH closes <545 ×3 (bear count confirms); SMH >672 (Knox 29 Sep invalidation; was 640) closes the question (hold). Labels/forecasts do not fire it.
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
    const [vwra, dxy, gold, copx, smh, wti, gldm] = await Promise.all([yf('VWRA.L'), yf('DX-Y.NYB'), yf('GC=F'), yf('COPX'), yf('SMH'), yf('CL=F'), yf('GLDM')]);
    const copx6mHigh = Math.max(...trailing(copx.closes, 126));
    const copxDrop = (copx.last / copx6mHigh - 1) * 100;
    const gold200 = gold.closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, gold.closes.length);
    let goldAbove200Run = 0; for (let i = gold.closes.length - 1; i >= 0 && gold.closes[i] > gold200; i--) goldAbove200Run++;
    const gldmT3Level = +(TRIGGERS.T5.gldmT2Fill * (1 - TRIGGERS.T5.dropPct / 100)).toFixed(2);

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


    const s = {
      lastRun: new Date().toISOString(), plan: 'B (10 Aug 2026, reconciled 28 Sep)',
      vwra: vwra.last, t3Level, vwraFromFill: +vwraFromFill.toFixed(2),
      dxy: dxy.last, dxy6mHigh: +dxy6mHigh.toFixed(2), dxyDrop: +dxyDrop.toFixed(2), dxySignalLevel: +(dxy6mHigh * 0.97).toFixed(2),
      gold: gold.last, gold200: +gold200.toFixed(0), goldAbove200Run, gldm: gldm.last, gldmT3Level, copx: copx.last, copx6mHigh: +copx6mHigh.toFixed(2), copxDrop: +copxDrop.toFixed(2), smh: smh.last, smhBelowRun, wti: wti.last,
      t3Fill: prev.t3Fill || null, v1Fill: prev.v1Fill || null, fired: prev.fired || {},
      t3: prev.t3 || 'waiting', t4: prev.t4 || 'waiting', t5: prev.t5 || 'waiting', eqqq: prev.eqqq || 'watch',
      backstopAlerts: prev.backstopAlerts || {},
    };

    // ── T3 ──
    const d3 = daysTo(TRIGGERS.T3.backstop);
    if (s.t3 === 'waiting') {
      if (vwra.last <= t3Level) { s.t3 = 'FIRED-vwra-7pct'; alerts.push(`🟢 <b>T3 FIRES — VWRA $${vwra.last.toFixed(2)} is ${vwraFromFill.toFixed(1)}% below the T2 fill ($${TRIGGERS.T3.t2Fill}).</b> Deploy $8,500 (VWRA recommended). Deal after 17:30 Dubai. Oil $${wti.last.toFixed(0)}.`); }
      else if (dxySignal1) { s.t3 = 'FIRED-dxy'; alerts.push(`🟢 <b>T3 FIRES — DXY ${dxy.last.toFixed(2)} is ${dxyDrop.toFixed(1)}% off its 6-month high (${dxy6mHigh.toFixed(2)}).</b> Deploy $8,500. (Same signal starts the T4/T5 dollar clock — see below.)`); }
      else if (d3 <= 0) { s.t3 = 'FIRED-backstop'; s.t3Fill = s.t3Fill || +vwra.last.toFixed(2); alerts.push(`⏰ <b>T3 TIME BACKSTOP (15 Oct) — deploy $8,500 today.</b> VWRA $${vwra.last.toFixed(2)} (${vwraFromFill >= 0 ? '+' : ''}${vwraFromFill.toFixed(1)}% vs T2 fill); neither accelerator fired, which is the normal outcome. After this: cash+VDST ≈ 32% of HSBC.`); }
      else if ([7, 3, 1].includes(d3) && !s.backstopAlerts[`t3-${d3}`]) { s.backstopAlerts[`t3-${d3}`] = true; alerts.push(`⏳ T3 backstop in <b>${d3} day${d3 > 1 ? 's' : ''}</b> (15 Oct). VWRA $${vwra.last.toFixed(2)} vs accelerator $${t3Level} · DXY ${dxy.last.toFixed(2)} vs ${s.dxySignalLevel}. Decide the instrument (VWRA recommended) so it's one order on the day.`); }
    }
    // ── T4 (thirds on the dollar) ──
    const d4 = daysTo(TRIGGERS.T4.backstop);
    const copxLeg = copxDrop <= -TRIGGERS.T4.copxDropPct;
    const t4now = dxySignal2 ? 'SIGNAL-2 (second third)' : dxySignal1 ? 'SIGNAL-1 (first third)' : copxLeg ? 'PRICE-LEG (first third)' : d4 <= 0 ? 'BACKSTOP (first third)' : 'waiting';
    if ([7, 3, 1].includes(d4) && !s.backstopAlerts[`t4-${d4}`] && t4now === 'waiting') { s.backstopAlerts[`t4-${d4}`] = true; alerts.push(`⏳ T4 COPX first-third backstop in <b>${d4} day${d4 > 1 ? 's' : ''}</b> (15 Jan). COPX $${copx.last.toFixed(2)} (${copxDrop.toFixed(1)}% vs 6-mo high; price leg ≤ $${(copx6mHigh * 0.8).toFixed(2)}) · DXY ${dxy.last.toFixed(2)} (signal ≤ ${s.dxySignalLevel}).`); }
    if ((prev.t4 || 'waiting') !== t4now) {
      if (t4now.startsWith('SIGNAL-1')) alerts.push(`🟢 <b>T4 — dollar signal 1:</b> DXY ${dxy.last.toFixed(2)}, ${dxyDrop.toFixed(1)}% off the 6-month high. Release COPX tranche ⅓ (~$4.3K) at market (COPX $${copx.last.toFixed(2)}, ${copxDrop.toFixed(0)}% off its 6-mo high). Fund from VDST.`);
      else if (t4now.startsWith('PRICE-LEG')) alerts.push(`🟢 <b>T4 — COPX price leg:</b> COPX $${copx.last.toFixed(2)} is ${copxDrop.toFixed(1)}% below its 6-month high (${copx6mHigh.toFixed(2)}). Release the FIRST third (~$4.3K) from VDST. Second third still needs the dollar signal (DXY ≤ ${s.dxySignalLevel}).`);
      else if (t4now.startsWith('BACKSTOP')) alerts.push(`⏰ <b>T4 COPX TIME BACKSTOP (15 Jan) — release the first third (~$4.3K) today.</b> COPX $${copx.last.toFixed(2)}; neither the dollar nor the price leg fired, which is a valid outcome.`);
      else if (t4now.startsWith('SIGNAL-2')) alerts.push(`🟢 <b>T4 — dollar signal 2:</b> DXY ${dxy.last.toFixed(2)}, ${dxyDrop.toFixed(1)}% off the high. Second COPX third. Final third waits for a Fed pivot (manual).`);
      else if (t4now === 'waiting' && (prev.t4 || '').startsWith('SIGNAL')) alerts.push(`↩️ T4: DXY back within 3% of its 6-month high (${dxy.last.toFixed(2)} vs ${dxy6mHigh.toFixed(2)}) — dollar signal withdrawn. No further COPX thirds.`);
    }
    s.t4 = (prev.t4 || '').startsWith('PRICE-LEG') || (prev.t4 || '').startsWith('BACKSTOP') ? (t4now.startsWith('SIGNAL') ? t4now : prev.t4) : t4now;   // a fired first third stays fired
    // ── Gold T3 (T5 slot): GLDM −8% from the T2 fill OR 10 gold closes above the 200-day; backstop 1 Dec via DATED G3 ──
    const t5now = (prev.t5 || '').startsWith('FIRED') ? prev.t5 : (gldm.last && gldm.last <= gldmT3Level) ? 'FIRED-gldm-8pct' : goldAbove200Run >= TRIGGERS.T5.closesAbove200 ? 'FIRED-200day' : 'waiting';
    if ((prev.t5 || 'waiting') !== t5now) {
      if (t5now === 'FIRED-gldm-8pct') alerts.push(`🟢 <b>GOLD T3 FIRES — GLDM $${gldm.last.toFixed(2)} ≤ $${gldmT3Level} (−8% from the T2 fill $${TRIGGERS.T5.gldmT2Fill}).</b> Buy $3,500 GLDM from VDST. Deal after 17:30 Dubai.`);
      else if (t5now === 'FIRED-200day') alerts.push(`🟢 <b>GOLD T3 FIRES — gold has closed above its 200-day ($${gold200.toFixed(0)}) for ${goldAbove200Run} sessions.</b> Buy $3,500 GLDM ($${gldm.last?.toFixed(2)}) from VDST.`);
    }
    s.t5 = t5now;
    // ── Dated steps (countdowns 7/3/1 days + day-of) ──
    for (const d of TRIGGERS.DATED) {
      if (s.fired[d.id]) continue;
      // 14 Oct: drawdown accelerators — V1 on VWRA −5% from the T3 fill, V2 on VWRA −5% from the V1 fill (anchor missing = not armed)
      if (d.accelPct) {
        const anchor = s[d.anchor];
        if (anchor && vwra.last <= anchor * (1 - d.accelPct / 100)) {
          s.fired[d.id] = new Date().toISOString().slice(0, 10); if (d.id === 'V1') s.v1Fill = s.v1Fill || +vwra.last.toFixed(2);
          alerts.push(`🟢 <b>${d.id} ACCELERATED — VWRA $${vwra.last.toFixed(2)} is ${((vwra.last / anchor - 1) * 100).toFixed(1)}% below the ${d.anchor === 't3Fill' ? 'T3' : 'V1'} fill ($${anchor}).</b> ${d.label}: deploy $${d.amount.toLocaleString()} now instead of ${d.date}.${dxySignal1 ? ' ⚠️ Dollar signal ON → COPX instead (T4 first).' : ''}`);
          continue;
        }
      }
      const n = daysTo(d.date); const key = `${d.id}-${n <= 0 ? 'due' : n}`;
      if (n <= 0 && !s.fired[d.id] && !s.backstopAlerts[key]) { s.fired[d.id] = d.date; if (d.id === 'V1') s.v1Fill = s.v1Fill || +vwra.last.toFixed(2); }
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
      else if (eqNow === 'HOLD-resolved') alerts.push(`🟢 SMH closed above $672 ($${smh.last.toFixed(2)}) — bear count invalidated. EQQQ question closed: HOLD. (Options direction may go to calls.)`);
      else if (smhBelowRun === 1) alerts.push(`👀 SMH closed below $545 ($${smh.last.toFixed(2)}) — day 1 of ${TRIGGERS.EQQQ.failSessions} for the EQQQ swap / bear-count FIRE.`);
    }
    s.eqqq = eqNow;

    await store.setJSON('hsbc-state', s);
    const isMonday = new Date().getUTCDay() === 1;
    if (alerts.length || isMonday || force) {
      const hdr = `🏦 <b>HSBC tranche monitor</b> (Plan B) · ${new Date().toISOString().slice(0, 10)}\nVWRA $${vwra.last.toFixed(2)} (${vwraFromFill >= 0 ? '+' : ''}${vwraFromFill.toFixed(1)}% vs T2 fill; T3 accel ≤ $${t3Level}) · DXY ${dxy.last.toFixed(2)} (${dxyDrop.toFixed(1)}% vs 6m high ${dxy6mHigh.toFixed(2)}; signal ≤ ${s.dxySignalLevel}) · Gold $${gold.last.toFixed(0)} · COPX $${copx.last.toFixed(2)} · SMH $${smh.last.toFixed(0)}\n`;
      const tbl = `T3 ${s.t3}${s.t3 === 'waiting' ? ` (backstop ${d3}d)` : ''}${s.t3Fill ? ` fill $${s.t3Fill}` : ''} · T4 ${s.t4} (COPX ${copxDrop.toFixed(0)}% vs 6m high; backstop ${d4}d) · Gold T3 ${s.t5} (GLDM $${gldm.last?.toFixed(2)} vs $${gldmT3Level}; ${goldAbove200Run}/10 closes > 200d) · EM ${s.em} · EQQQ ${s.eqqq}\n`;
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
