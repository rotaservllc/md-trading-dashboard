// sunday-scanner.mjs — scheduled Sunday 4AM UTC, 80-ticker scan with earnings gate
// All shared code inlined (no lib/ imports — esbuild bundling issue)
// BUILD: 2026-04-29

import { request as httpsRequest } from 'node:https';

// ── SHARED: TT Auth ──────────────────────────────────────────
async function getTTToken() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: Netlify.env.get('TT_REFRESH_TOKEN'), client_id: Netlify.env.get('TT_OAUTH_CLIENT_ID'), client_secret: Netlify.env.get('TT_OAUTH_CLIENT_SECRET') }).toString();
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'api.tastyworks.com', port: 443, path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`TT auth failed ${res.statusCode}`)); else resolve(JSON.parse(d).access_token); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── SHARED: CBOE Fetch (node:https for HTTP/1.1) ─────────────
function cboeGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'cdn.cboe.com', port: 443, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.end();
  });
}

function parseOptionSym(sym) {
  let i = 0; while (i < sym.length && sym[i].match(/[A-Z^]/)) i++;
  const rest = sym.slice(i);
  return { optType: rest[6], strike: parseInt(rest.slice(7)) / 1000, exp: `20${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,6)}` };
}

async function fetchCBOE(ticker) {
  try {
    const { status, body } = await cboeGet(`/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`);
    if (status !== 200) return null;
    const d = JSON.parse(body).data || {};
    const options = (d.options || []).map(o => { try { const { optType, strike, exp } = parseOptionSym(o.option); return { ...o, option_type: optType, strike_price: strike, expiration: exp }; } catch { return null; } }).filter(Boolean);
    const earnings = detectEarnings(options, d.current_price);
    return { ticker, price: d.current_price, iv30: d.iv30, options, earnings };
  } catch { return null; }
}

async function fetchVIX() {
  try { const { status, body } = await cboeGet('/api/global/delayed_quotes/options/%5EVIX.json'); if (status !== 200) return null; return JSON.parse(body).data?.current_price || null; } catch { return null; }
}

// ── SHARED: Earnings Detection via IV Term Structure ─────────
function detectEarnings(options, price) {
  if (!options || !options.length || !price) return { hasEarnings: false };
  const today = new Date();
  const expIVs = {};
  for (const o of options) {
    if (!o.expiration || !o.iv) continue;
    if (Math.abs(o.strike_price - price) / price > 0.06) continue;
    if (!expIVs[o.expiration]) expIVs[o.expiration] = [];
    expIVs[o.expiration].push(o.iv * 100);
  }
  const sorted = Object.keys(expIVs).sort().map(exp => ({ exp, dte: Math.round((new Date(exp) - today) / 86400000), iv: expIVs[exp].reduce((a, b) => a + b, 0) / expIVs[exp].length })).filter(e => e.dte >= 0);
  if (sorted.length < 2) return { hasEarnings: false };
  const baseline = sorted.slice(-2).reduce((a, b) => a + b.iv, 0) / 2;
  let best = null; let maxSpike = 0;
  for (const e of sorted) {
    if (e.dte > 45) continue;
    const spike = e.iv / baseline;
    if (spike > 1.25 && spike > maxSpike) { maxSpike = spike; best = e; }
  }
  if (!best) return { hasEarnings: false };
  return { hasEarnings: true, earningsExpiry: best.exp, earningsDTE: best.dte, ivSpike: maxSpike.toFixed(2), warning: `⚠️ Earnings likely before ${best.exp} (${best.dte}d) — IV spike ${((maxSpike - 1) * 100).toFixed(0)}% above baseline` };
}

function earningsGate(earnings, tradeDTE) {
  if (!earnings?.hasEarnings) return { pass: true };
  if (earnings.earningsDTE <= tradeDTE) return { pass: false, reason: `EARNINGS BLOCK: ${earnings.warning}` };
  if (earnings.earningsDTE <= tradeDTE + 7) return { pass: 'warn', reason: earnings.warning };
  return { pass: true };
}

// ── UNIVERSE ─────────────────────────────────────────────────
const UNIVERSE = [
  { ticker: 'NVDA', sector: 'AI Accelerators', tier: 1 }, { ticker: 'AVGO', sector: 'AI Accelerators', tier: 1 },
  { ticker: 'LITE', sector: 'AI Networking', tier: 1 }, { ticker: 'ALAB', sector: 'AI Networking', tier: 1 },
  { ticker: 'AAOI', sector: 'AI Networking', tier: 1 }, { ticker: 'COHR', sector: 'AI Networking', tier: 1 },
  { ticker: 'RDDT', sector: 'AI Software', tier: 1 }, { ticker: 'META', sector: 'AI Software', tier: 1 },
  { ticker: 'PLTR', sector: 'AI Software', tier: 1 }, { ticker: 'BE', sector: 'AI Energy', tier: 1 },
  { ticker: 'GEV', sector: 'AI Energy', tier: 1 }, { ticker: 'MU', sector: 'AI Memory', tier: 1 },
  { ticker: 'NET', sector: 'AI Infra', tier: 1 }, { ticker: 'CRWV', sector: 'AI Infra', tier: 1 },
  { ticker: 'TSLA', sector: 'EV/Auto', tier: 2 }, { ticker: 'AXON', sector: 'AI SaaS', tier: 2 },
  { ticker: 'DOCN', sector: 'AI SaaS', tier: 2 }, { ticker: 'APP', sector: 'AI SaaS', tier: 2 },
  { ticker: 'RKLB', sector: 'Space', tier: 2 }, { ticker: 'ASTS', sector: 'Space', tier: 2 },
  { ticker: 'IONQ', sector: 'Quantum', tier: 2 }, { ticker: 'RGTI', sector: 'Quantum', tier: 2 },
  { ticker: 'BBAI', sector: 'Defense AI', tier: 2 }, { ticker: 'KTOS', sector: 'Defense AI', tier: 2 },
  { ticker: 'MARA', sector: 'Crypto', tier: 2 }, { ticker: 'SOFI', sector: 'Fintech', tier: 2 },
  { ticker: 'HOOD', sector: 'Fintech', tier: 2 }, { ticker: 'COIN', sector: 'Crypto', tier: 2 },
  { ticker: 'ACHR', sector: 'Air Taxi', tier: 2 }, { ticker: 'JOBY', sector: 'Air Taxi', tier: 2 },
  { ticker: 'AAPL', sector: 'Big Tech', tier: 3 }, { ticker: 'MSFT', sector: 'Big Tech', tier: 3 },
  { ticker: 'AMZN', sector: 'Big Tech', tier: 3 }, { ticker: 'GOOGL', sector: 'Big Tech', tier: 3 },
  { ticker: 'ORCL', sector: 'Cloud', tier: 3 }, { ticker: 'CRM', sector: 'Cloud SaaS', tier: 3 },
  { ticker: 'NOW', sector: 'Cloud SaaS', tier: 3 }, { ticker: 'SNOW', sector: 'Cloud SaaS', tier: 3 },
  { ticker: 'DDOG', sector: 'Cloud SaaS', tier: 3 }, { ticker: 'ZS', sector: 'Cybersec', tier: 3 },
  { ticker: 'PANW', sector: 'Cybersec', tier: 3 }, { ticker: 'CRWD', sector: 'Cybersec', tier: 3 },
  { ticker: 'DELL', sector: 'AI Infra', tier: 3 }, { ticker: 'ARM', sector: 'Semiconductors', tier: 3 },
  { ticker: 'QCOM', sector: 'Semiconductors', tier: 3 }, { ticker: 'MRVL', sector: 'Semiconductors', tier: 3 },
  { ticker: 'NFLX', sector: 'Media', tier: 3 }, { ticker: 'SPOT', sector: 'Media', tier: 3 },
  { ticker: 'UBER', sector: 'Mobility', tier: 3 }, { ticker: 'LYFT', sector: 'Mobility', tier: 3 },
  { ticker: 'ABNB', sector: 'Travel', tier: 3 }, { ticker: 'SHOP', sector: 'E-Commerce', tier: 3 },
  { ticker: 'MELI', sector: 'E-Commerce', tier: 3 }, { ticker: 'ROKU', sector: 'Media', tier: 3 },
  { ticker: 'SNAP', sector: 'Social', tier: 3 }, { ticker: 'TWLO', sector: 'SaaS', tier: 3 },
  { ticker: 'MDB', sector: 'SaaS', tier: 3 }, { ticker: 'PATH', sector: 'AI SaaS', tier: 3 },
  { ticker: 'SOUN', sector: 'AI SaaS', tier: 3 }, { ticker: 'HIMS', sector: 'Health', tier: 3 },
  { ticker: 'RIVN', sector: 'EV', tier: 3 }, { ticker: 'NIO', sector: 'EV', tier: 3 },
  { ticker: 'F', sector: 'Auto', tier: 3 }, { ticker: 'GM', sector: 'Auto', tier: 3 },
  { ticker: 'OPEN', sector: 'PropTech', tier: 3 },
];

const ACCOUNT_BALANCE = parseFloat(Netlify.env.get('ACCOUNT_BALANCE') || '15000');
const IO_FUND_VETO = (Netlify.env.get('IO_FUND_VETO_LIST') || 'AMD,AVGO,LITE').split(',').map(t => t.trim().toUpperCase());

function scoreCandidate(td, strategy) {
  const { price, iv30, options, earnings } = td;
  if (!price || !iv30 || !options.length) return null;

  if (strategy === 'CSP') {
    if (iv30 < 50) return null;
    if (price * 100 > ACCOUNT_BALANCE * 0.15) return null;
    const today = new Date();
    const exps = [...new Set(options.map(o => o.expiration))].sort();
    const nearExp = exps.find(e => { const d = (new Date(e) - today) / 86400000; return d >= 18 && d <= 38; }) || exps[0];
    if (!nearExp) return null;
    const dte = Math.max(1, (new Date(nearExp) - today) / 86400000);

    // GATE 10: Earnings block
    const eg = earningsGate(earnings, Math.round(dte));
    if (eg.pass === false) return null;

    const puts = options.filter(o => o.expiration === nearExp && o.option_type === 'P' && o.strike_price <= price * 0.96 && o.strike_price >= price * 0.80);
    const atm = puts.filter(p => p.strike_price <= price).sort((a, b) => b.strike_price - a.strike_price)[0];
    if (!atm) return null;
    const mid = ((atm.bid || 0) + (atm.ask || 0)) / 2;
    if (mid <= 0) return null;
    const ann = (mid / atm.strike_price) * (365 / dte) * 100;
    const pctOTM = (price - atm.strike_price) / price * 100;
    const score = iv30 * 0.35 + Math.min(pctOTM * 4, 24) * 0.30 + Math.min((atm.open_interest || 0) / 1000, 15) * 1.5 + Math.min(ann, 100) * 0.20;
    return { ticker: td.ticker, strategy: 'CSP', price, iv30: iv30.toFixed(1), score: score.toFixed(1), confidence: iv30 >= 80 && pctOTM >= 6 ? 'HIGH' : iv30 >= 60 ? 'MEDIUM' : 'LOW', nearExpiry: nearExp, dte: Math.round(dte), suggestedStrike: atm.strike_price, bid: atm.bid, ask: atm.ask, mid: mid.toFixed(2), collateral: (price * 100).toFixed(0), annReturn: ann.toFixed(0), openInterest: atm.open_interest, earningsWarning: eg.pass === 'warn' ? eg.reason : null, rationale: `IV30 ${iv30.toFixed(0)}% elevated. $${atm.strike_price}P exp ${nearExp} (${Math.round(dte)}d). ${pctOTM.toFixed(1)}% OTM. Ann ~${ann.toFixed(0)}%.`, keyRisk: `Assignment below $${atm.strike_price}. Collateral $${(price * 100).toFixed(0)}.` };
  }

  if (strategy === 'CALL') {
    if (iv30 > 45) return null;
    const today = new Date();
    const exps = [...new Set(options.map(o => o.expiration))].sort();
    const target = exps.find(e => { const d = (new Date(e) - today) / 86400000; return d >= 20 && d <= 55; }) || exps[1] || exps[0];
    if (!target) return null;
    const dte = Math.max(1, (new Date(target) - today) / 86400000);
    const eg = earningsGate(earnings, Math.round(dte));
    if (eg.pass === false) return null;
    const calls = options.filter(o => o.expiration === target && o.option_type === 'C');
    const maxCost = ACCOUNT_BALANCE * 0.02;
    const otm = calls.filter(c => c.strike_price >= price * 1.02 && c.strike_price <= price * 1.20 && (c.ask || 0) <= maxCost && (c.ask || 0) > 0).sort((a, b) => (b.open_interest || 0) - (a.open_interest || 0))[0];
    if (!otm) return null;
    const score = (45 - iv30) * 0.6 + (otm.open_interest || 0) / 500 * 0.4;
    return { ticker: td.ticker, strategy: 'CALL', price, iv30: iv30.toFixed(1), score: score.toFixed(1), confidence: iv30 <= 25 ? 'HIGH' : iv30 <= 35 ? 'MEDIUM' : 'LOW', nearExpiry: target, dte: Math.round(dte), suggestedStrike: otm.strike_price, ask: otm.ask, cost: otm.ask?.toFixed(2), openInterest: otm.open_interest, earningsWarning: eg.pass === 'warn' ? eg.reason : null, rationale: `IV30 ${iv30.toFixed(0)}% low. $${otm.strike_price}C exp ${target} (${Math.round(dte)}d) costs $${otm.ask?.toFixed(2)}.`, keyRisk: `Needs +${((otm.strike_price - price) / price * 100).toFixed(1)}% move.` };
  }
  return null;
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  const t0 = Date.now();
  try {
    const vix = await fetchVIX();
    const regime = vix == null ? 'UNKNOWN' : vix < 16 ? 'RISK-ON' : vix < 25 ? 'MIXED' : 'RISK-OFF';

    const results = [];
    for (let i = 0; i < UNIVERSE.length; i += 10) {
      const batch = UNIVERSE.slice(i, i + 10);
      const fetched = await Promise.all(batch.map(u => fetchCBOE(u.ticker)));
      results.push(...fetched.map((td, j) => ({ ...batch[j], data: td })));
    }

    const earningsBlocked = [];
    const candidates = [];
    for (const { sector, tier, data } of results) {
      if (!data) continue;
      if (IO_FUND_VETO.includes(data.ticker)) continue;
      if (data.earnings?.hasEarnings) earningsBlocked.push({ ticker: data.ticker, warning: data.earnings.warning });
      const csp = scoreCandidate(data, 'CSP');
      const call = scoreCandidate(data, 'CALL');
      if (csp) candidates.push({ ...csp, sector, tier });
      if (call) candidates.push({ ...call, sector, tier });
    }
    candidates.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
    const top10 = candidates.slice(0, 10);

    // Save to Blobs using env-based store key approach (no @netlify/blobs needed)
    // Use the built-in Netlify Blobs API via fetch
    const siteId = 'cd39a088-9fc0-42bd-8e33-b72febd040c2';
    const token = Netlify.env.get('NETLIFY_API_TOKEN') || '';
    const scanResult = { generatedAt: new Date().toISOString(), vix: vix?.toFixed(2) ?? null, regime, universe: UNIVERSE.length, scanned: results.filter(r => r.data).length, candidateCount: candidates.length, earningsBlocked, candidates: top10, all: candidates, durationMs: Date.now() - t0 };

    // Try native blobs
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('trading-data');
      await store.setJSON('latest-scan', scanResult);
      await store.setJSON('sunday-snapshot', scanResult);
    } catch { /* Blobs unavailable, continue */ }

    const botToken = Netlify.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Netlify.env.get('TELEGRAM_CHAT_ID');
    if (botToken && chatId && top10.length > 0) {
      let msg = `🔍 <b>Scan Complete</b> — ${new Date().toISOString().slice(0, 10)}\nVIX: ${vix?.toFixed(1) ?? '?'} | Regime: <b>${regime}</b>\nScanned ${scanResult.scanned} → <b>${candidates.length} candidates</b>`;
      if (earningsBlocked.length > 0) msg += `\n🚫 Earnings-blocked: ${earningsBlocked.map(e => e.ticker).join(', ')}`;
      msg += '\n\n<b>Top 5:</b>\n';
      for (const c of top10.slice(0, 5)) {
        msg += `${c.strategy === 'CSP' ? '📉' : '📈'} <b>${c.ticker}</b> ${c.strategy} [${c.confidence}]\n  ${c.rationale}\n`;
        if (c.earningsWarning) msg += `  ⚠️ ${c.earningsWarning}\n`;
      }
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }) });
    }

    return new Response(JSON.stringify(scanResult), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { schedule: '0 4 * * 0' };
