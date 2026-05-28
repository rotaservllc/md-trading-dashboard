// earnings-detector.mjs
// Detects upcoming earnings dates using IV term structure from CBOE
// When a near-term expiry has significantly elevated IV vs longer-term expiries,
// it signals earnings are expected before that expiry.
//
// No external API needed — uses the same CBOE data already fetched.

export function detectEarnings(options, currentPrice, todayStr) {
  if (!options || options.length === 0) return { hasEarnings: false };

  const today = new Date(todayStr || new Date().toISOString().slice(0, 10));

  // Group ATM options by expiry, calculate avg IV per expiry
  const expIVs = {};
  for (const o of options) {
    if (!o.expiration || !o.iv) continue;
    const pctFromATM = Math.abs(o.strike_price - currentPrice) / currentPrice;
    if (pctFromATM > 0.06) continue; // only near-ATM
    if (!expIVs[o.expiration]) expIVs[o.expiration] = [];
    expIVs[o.expiration].push(o.iv * 100); // convert to percentage
  }

  const sortedExps = Object.keys(expIVs).sort();
  if (sortedExps.length < 2) return { hasEarnings: false };

  // Calculate avg IV per expiry
  const expAvgIV = sortedExps.map(exp => ({
    exp,
    dte: Math.round((new Date(exp) - today) / 86400000),
    iv: expIVs[exp].reduce((a, b) => a + b, 0) / expIVs[exp].length,
  })).filter(e => e.dte >= 0);

  if (expAvgIV.length < 2) return { hasEarnings: false };

  // Baseline IV = average of the 2 longest dated expiries
  const baseline = expAvgIV.slice(-2).reduce((a, b) => a + b.iv, 0) / 2;

  // Find the expiry with the biggest IV spike relative to baseline
  let earningsExpiry = null;
  let maxSpike = 0;

  for (const e of expAvgIV) {
    if (e.dte > 45) continue; // only look within 45 days
    const spike = e.iv / baseline;
    if (spike > 1.25 && spike > maxSpike) { // 25% elevated = earnings signal
      maxSpike = spike;
      earningsExpiry = e;
    }
  }

  if (!earningsExpiry) return { hasEarnings: false, baseline: baseline.toFixed(0) };

  return {
    hasEarnings: true,
    earningsExpiry: earningsExpiry.exp,
    earningsDTE: earningsExpiry.dte,
    ivSpike: maxSpike.toFixed(2),
    baseline: baseline.toFixed(0),
    spikeIV: earningsExpiry.iv.toFixed(0),
    warning: `⚠️ Earnings likely before ${earningsExpiry.exp} (${earningsExpiry.dte}d) — IV spike ${(maxSpike * 100 - 100).toFixed(0)}% above baseline`,
  };
}

// Gate check: should we block this trade due to earnings?
// tradeDTE = days to expiry of the CSP/call we want to enter
export function earningsGatePass(earningsResult, tradeDTE) {
  if (!earningsResult.hasEarnings) return { pass: true, reason: 'No earnings detected in window' };
  
  // Block if earnings are within our trade window
  if (earningsResult.earningsDTE <= tradeDTE) {
    return {
      pass: false,
      reason: `BLOCKED: Earnings in ${earningsResult.earningsDTE}d, inside your ${tradeDTE}d trade window. ${earningsResult.warning}`,
    };
  }

  // Warn if earnings are close to the window
  if (earningsResult.earningsDTE <= tradeDTE + 7) {
    return {
      pass: 'warn',
      reason: `CAUTION: Earnings in ${earningsResult.earningsDTE}d, close to your ${tradeDTE}d window.`,
    };
  }

  return { pass: true, reason: `Earnings in ${earningsResult.earningsDTE}d — outside trade window` };
}
