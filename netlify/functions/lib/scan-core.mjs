// ─────────────────────────────────────────────────────────────────────────────
// scan-core.mjs — shared v3 scan engine   BUILD: 2026-06-08T12:00:00Z (4% cap + debit module)
// ─────────────────────────────────────────────────────────────────────────────
// Strategy: defined-risk PUT CREDIT SPREADS (income) + one CONVEX sleeve
//   (long call / debit spread) gated by opportunity + Knox trigger.
// Data:  live NLV + real IV rank/percentile + earnings  ← tastytrade (free)
//        per-option delta/OI/IV/bid/ask                 ← CBOE chain
// Fixes vs deployed: parses OCC symbol (no fake strike_price), uses real IV
//        rank (no missing iv_percentile), sizes by MAX LOSS vs live NLV.
// Output written to Blobs 'latest-scan' in a dashboard-compatible shape.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from '@netlify/blobs';
import { getTTToken } from './tt-auth.mjs';

// ─── CONFIG (tunable dials) ──────────────────────────────────────────────────
const CFG = {
  MAX_RISK_PCT:       0.04,   // max loss per credit spread / NLV (raised from 2% — deliberate fixed cap)
  CONVEX_RISK_PCT:    0.01,   // max debit per convex bet / NLV (tier-1/2 names)
  DEBIT_MAX_RISK_PCT: 0.02,   // max debit per satellite lottery play / NLV (~$96)
  DEBIT_MIN_RR:       2.0,    // satellite debit needs ≥ 2:1
  TARGET_SHORT_DELTA: 0.25,   // short-put delta  → ~75% POP
  DELTA_TOL:          0.08,
  MIN_CREDIT_WIDTH:   0.30,   // credit ≥ 30% of width
  CONVEX_MIN_RR:      3.0,    // convex bet needs ≥ 3:1
  MIN_IV_RANK:        30,     // only SELL premium when IV rank rich
  MAX_IV_RANK_CONVEX: 30,     // only BUY premium when IV rank cheap
  DTE_MIN: 21, DTE_MAX: 49,
  MIN_OI: 500, MAX_SPREAD_PCT: 12,
  EARNINGS_BUFFER: 14,
  MIN_LIQUIDITY: 2,           // tastytrade liquidity-rating 1–4
  TOP_N_ENRICH: 12,
  FALLBACK_NLV: 4800.45,
};
const WIDTHS = [5, 2.5, 2, 1];
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const TT = 'https://api.tastyworks.com';

const UNIVERSE = [
  { ticker:'NVDA',sector:'AI Accelerators',tier:1 },{ ticker:'AMD',sector:'AI Accelerators',tier:1 },{ ticker:'AVGO',sector:'AI Accelerators',tier:1 },
  { ticker:'LITE',sector:'AI Networking',tier:1 },{ ticker:'ALAB',sector:'AI Networking',tier:1 },{ ticker:'AAOI',sector:'AI Networking',tier:1 },{ ticker:'COHR',sector:'AI Networking',tier:1 },
  { ticker:'RDDT',sector:'AI Software',tier:1 },{ ticker:'META',sector:'AI Software',tier:1 },{ ticker:'PLTR',sector:'AI Software',tier:1 },
  { ticker:'BE',sector:'AI Energy',tier:1 },{ ticker:'GEV',sector:'AI Energy',tier:1 },{ ticker:'MU',sector:'AI Memory',tier:1 },{ ticker:'SNDK',sector:'AI Memory',tier:1 },
  { ticker:'NET',sector:'AI Infra',tier:1 },{ ticker:'CRWV',sector:'AI Infra',tier:1 },
  { ticker:'TSLA',sector:'EV/Auto',tier:2 },{ ticker:'AXON',sector:'AI SaaS',tier:2 },{ ticker:'DOCN',sector:'AI SaaS',tier:2 },{ ticker:'APP',sector:'AI SaaS',tier:2 },
  { ticker:'RKLB',sector:'Space',tier:2 },{ ticker:'ASTS',sector:'Space',tier:2 },{ ticker:'IONQ',sector:'Quantum',tier:2 },{ ticker:'RGTI',sector:'Quantum',tier:2 },
  { ticker:'BBAI',sector:'Defense AI',tier:2 },{ ticker:'KTOS',sector:'Defense AI',tier:2 },{ ticker:'MARA',sector:'Crypto',tier:2 },{ ticker:'SOFI',sector:'Fintech',tier:2 },
  { ticker:'HOOD',sector:'Fintech',tier:2 },{ ticker:'COIN',sector:'Crypto',tier:2 },
  { ticker:'AAPL',sector:'Big Tech',tier:3 },{ ticker:'MSFT',sector:'Big Tech',tier:3 },{ ticker:'AMZN',sector:'Big Tech',tier:3 },{ ticker:'GOOGL',sector:'Big Tech',tier:3 },
  { ticker:'ORCL',sector:'Cloud',tier:3 },{ ticker:'CRM',sector:'Cloud SaaS',tier:3 },{ ticker:'NOW',sector:'Cloud SaaS',tier:3 },{ ticker:'SNOW',sector:'Cloud SaaS',tier:3 },
  { ticker:'DDOG',sector:'Cloud SaaS',tier:3 },{ ticker:'ZS',sector:'Cybersec',tier:3 },{ ticker:'PANW',sector:'Cybersec',tier:3 },{ ticker:'CRWD',sector:'Cybersec',tier:3 },
  { ticker:'SMCI',sector:'AI Infra',tier:3 },{ ticker:'DELL',sector:'AI Infra',tier:3 },{ ticker:'HPE',sector:'AI Infra',tier:3 },{ ticker:'ARM',sector:'Semiconductors',tier:3 },
  { ticker:'QCOM',sector:'Semiconductors',tier:3 },{ ticker:'INTC',sector:'Semiconductors',tier:3 },{ ticker:'ON',sector:'Semiconductors',tier:3 },{ ticker:'MRVL',sector:'Semiconductors',tier:3 },
  { ticker:'NFLX',sector:'Media',tier:3 },{ ticker:'SPOT',sector:'Media',tier:3 },{ ticker:'UBER',sector:'Mobility',tier:3 },{ ticker:'LYFT',sector:'Mobility',tier:3 },
  { ticker:'ABNB',sector:'Travel',tier:3 },{ ticker:'BKNG',sector:'Travel',tier:3 },{ ticker:'SHOP',sector:'E-Commerce',tier:3 },{ ticker:'SE',sector:'E-Commerce',tier:3 },
  { ticker:'MELI',sector:'E-Commerce',tier:3 },{ ticker:'PTON',sector:'Consumer',tier:3 },{ ticker:'W',sector:'E-Commerce',tier:3 },{ ticker:'ROKU',sector:'Media',tier:3 },
  { ticker:'PINS',sector:'Social',tier:3 },{ ticker:'SNAP',sector:'Social',tier:3 },{ ticker:'TWLO',sector:'SaaS',tier:3 },{ ticker:'MDB',sector:'SaaS',tier:3 },
  { ticker:'GTLB',sector:'SaaS',tier:3 },{ ticker:'PATH',sector:'AI SaaS',tier:3 },{ ticker:'AI',sector:'AI SaaS',tier:3 },{ ticker:'SOUN',sector:'AI SaaS',tier:3 },
  { ticker:'HIMS',sector:'Health',tier:3 },{ ticker:'CELH',sector:'Consumer',tier:3 },{ ticker:'RIVN',sector:'EV',tier:3 },{ ticker:'LCID',sector:'EV',tier:3 },
  { ticker:'NIO',sector:'EV',tier:3 },{ ticker:'XPEV',sector:'EV',tier:3 },{ ticker:'F',sector:'Auto',tier:3 },{ ticker:'GM',sector:'Auto',tier:3 },
  { ticker:'RDFN',sector:'PropTech',tier:3 },{ ticker:'OPEN',sector:'PropTech',tier:3 },
];
const TIER_W = { 1: 100, 2: 70, 3: 40 };

// Satellite universe — liquid, lower-priced names where defined-risk DEBIT spreads fit a small
// account (credit spreads can't). Off-research/technical; only scanned when KNOX_TRIGGER is armed.
const SATELLITE = [
  { ticker:'XLF', sector:'Financials ETF' }, { ticker:'KRE', sector:'Regional Banks' }, { ticker:'BAC', sector:'Banks' },
  { ticker:'SOFI',sector:'Fintech' }, { ticker:'HOOD',sector:'Fintech' }, { ticker:'AFRM',sector:'Fintech' }, { ticker:'UPST',sector:'Fintech' },
  { ticker:'F',   sector:'Auto' }, { ticker:'GM', sector:'Auto' }, { ticker:'RIVN',sector:'EV' }, { ticker:'LCID',sector:'EV' }, { ticker:'NIO',sector:'EV' },
  { ticker:'AAL', sector:'Airlines' }, { ticker:'CCL',sector:'Travel' }, { ticker:'NCLH',sector:'Travel' },
  { ticker:'CLF', sector:'Steel' }, { ticker:'X', sector:'Steel' }, { ticker:'AA',sector:'Aluminum' }, { ticker:'VALE',sector:'Mining' },
  { ticker:'MARA',sector:'Crypto' }, { ticker:'RIOT',sector:'Crypto' }, { ticker:'COIN',sector:'Crypto' }, { ticker:'PLUG',sector:'Clean Energy' },
  { ticker:'SNAP',sector:'Social' }, { ticker:'PINS',sector:'Social' }, { ticker:'WBD',sector:'Media' }, { ticker:'DKNG',sector:'Gaming' },
  { ticker:'CHWY',sector:'Consumer' }, { ticker:'GRAB',sector:'Tech' }, { ticker:'JMIA',sector:'E-Commerce' }, { ticker:'OPEN',sector:'PropTech' },
  { ticker:'SOUN',sector:'AI spec' }, { ticker:'BBAI',sector:'AI spec' }, { ticker:'PATH',sector:'AI spec' }, { ticker:'IONQ',sector:'Quantum' },
  { ticker:'RGTI',sector:'Quantum' }, { ticker:'RKLB',sector:'Space' }, { ticker:'ACHR',sector:'eVTOL' }, { ticker:'PLTR',sector:'AI SaaS' },
  { ticker:'INTC',sector:'Semis' }, { ticker:'T', sector:'Telecom' }, { ticker:'PFE',sector:'Pharma' }, { ticker:'GDX',sector:'Gold Miners' },
  { ticker:'SLV', sector:'Silver' }, { ticker:'FXI',sector:'China' }, { ticker:'EWZ',sector:'Brazil' },
];

// ─── tastytrade: live NLV ────────────────────────────────────────────────────
async function getNLV(token) {
  try {
    const acct = Netlify.env.get('TT_ACCOUNT') || '5WI51792';
    const r = await fetch(`${TT}/accounts/${acct}/balances`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' } });
    if (!r.ok) throw new Error(`balances ${r.status}`);
    const d = await r.json();
    const nlv = parseFloat(d?.data?.['net-liquidating-value'] ?? 0);
    return nlv > 0 ? nlv : CFG.FALLBACK_NLV;
  } catch (e) { console.warn('getNLV fallback:', e.message); return CFG.FALLBACK_NLV; }
}

// ─── tastytrade: market-metrics → real IV rank/percentile/liquidity/earnings ──
async function fetchMetrics(token, tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    try {
      const r = await fetch(`${TT}/market-metrics?symbols=${chunk.join(',')}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'md-trading-dashboard/1.0' } });
      if (!r.ok) { console.warn(`market-metrics ${r.status}`); continue; }
      const d = await r.json();
      for (const it of (d?.data?.items ?? [])) {
        const erd = it?.earnings?.['expected-report-date'];
        out[it.symbol] = {
          ivRank: ivPctNum(it['implied-volatility-index-rank'] ?? it['tw-implied-volatility-index-rank']),
          ivPct:  ivPctNum(it['implied-volatility-percentile']),
          iv:     Math.round((parseFloat(it['implied-volatility-index'] ?? 0)) * 100),
          liquidity: parseInt(it['liquidity-rating'] ?? 0, 10),
          mktCap: parseFloat(it['market-cap'] ?? 0),
          earningsDays: erd ? Math.round((new Date(erd).getTime() - Date.now()) / 86400000) : 999,
          earningsKnown: !!erd,
        };
      }
    } catch (e) { console.warn('metrics chunk:', e.message); }
  }
  return out;
}
const ivPctNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 1000) / 10 : null; }; // 0.453 → 45.3

// ─── VIX (CBOE, same source as deployed) ─────────────────────────────────────
async function fetchVIX() {
  try {
    const r = await fetch(`${CBOE}/%5EVIX.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    return parseFloat(d?.data?.current_price ?? 20);
  } catch { return 20; }
}
const regimeOf = (v) => v >= 25 ? 'RISK-OFF' : v >= 20 ? 'MIXED' : 'RISK-ON';

// ─── CBOE chain (parse OCC symbol; real greeks) ──────────────────────────────
function parseOCC(sym) {
  const m = sym.match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, typ, k] = m;
  return { expiry: `20${yy}-${mm}-${dd}`, type: typ === 'C' ? 'call' : 'put', strike: parseInt(k, 10) / 1000 };
}
async function fetchChain(ticker) {
  const r = await fetch(`${CBOE}/${ticker}.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`CBOE ${r.status}`);
  const d = await r.json();
  const price = parseFloat(d?.data?.current_price ?? 0);
  const now = Date.now();
  const opts = (d?.data?.options ?? []).map(o => {
    const p = parseOCC(o.option); if (!p) return null;
    const dte = Math.round((new Date(p.expiry).getTime() - now) / 86400000);
    return { ...p, dte, bid:+o.bid||0, ask:+o.ask||0, oi:+o.open_interest||0, iv:+o.iv||0, delta:+o.delta||0 };
  }).filter(Boolean).filter(o => o.dte >= CFG.DTE_MIN && o.dte <= CFG.DTE_MAX);
  return { price, opts };
}
const spreadPct = (o) => o.ask > 0 ? ((o.ask - o.bid) / o.ask) * 100 : 999;

// ─── Build best PUT CREDIT SPREAD ────────────────────────────────────────────
function buildPCS(chain, nlv) {
  const maxRisk = CFG.MAX_RISK_PCT * nlv;
  const puts = chain.opts.filter(o => o.type === 'put' && o.delta < 0 && o.bid > 0 && o.iv > 0);
  const shorts = puts.filter(o =>
    Math.abs(Math.abs(o.delta) - CFG.TARGET_SHORT_DELTA) <= CFG.DELTA_TOL &&
    o.oi >= CFG.MIN_OI && spreadPct(o) <= CFG.MAX_SPREAD_PCT);
  if (!shorts.length) return null;
  const short = shorts.sort((a,b) => Math.abs(Math.abs(a.delta)-CFG.TARGET_SHORT_DELTA) - Math.abs(Math.abs(b.delta)-CFG.TARGET_SHORT_DELTA))[0];

  let best = null;
  for (const w of WIDTHS) { // widest that fits the risk cap wins (max credit)
    const long = chain.opts.find(o => o.type === 'put' && o.expiry === short.expiry && Math.abs(o.strike - (short.strike - w)) < 0.01 && o.ask >= 0);
    if (!long) continue;
    const credit = +(short.bid - long.ask).toFixed(2);
    if (credit <= 0) continue;
    const maxLoss = +((w - credit) * 100).toFixed(2);
    if (maxLoss > maxRisk) continue;
    if (credit / w < CFG.MIN_CREDIT_WIDTH) continue;
    best = { kind:'PCS', short:short.strike, long:long.strike, width:w, credit, maxLoss,
      expiry:short.expiry, dte:short.dte, pop:+(1-Math.abs(short.delta)).toFixed(2),
      cw:+(credit/w).toFixed(2), retOnRisk:+((credit*100/maxLoss)*100).toFixed(0), shortIV:+(short.iv*100).toFixed(0) };
    break;
  }
  return best;
}

// ─── Build CONVEX sleeve (long call or debit spread) ─────────────────────────
function buildDebit(chain, nlv, dir, budgetPct) { // dir: 'calls' | 'puts'
  const maxDebit = budgetPct * nlv;
  const type = dir === 'calls' ? 'call' : 'put';
  const legs = chain.opts.filter(o => o.type === type && o.oi >= 150 && o.ask > 0 && o.iv > 0);
  if (legs.length < 2) return null;
  const long = legs.sort((a,b) => Math.abs(Math.abs(a.delta)-0.42) - Math.abs(Math.abs(b.delta)-0.42))[0];
  let best = null;
  for (const s of legs) {
    if (s.expiry !== long.expiry) continue;
    const further = dir === 'calls' ? s.strike > long.strike : s.strike < long.strike;
    if (!further || Math.abs(s.delta) >= Math.abs(long.delta) || Math.abs(s.delta) < 0.12) continue;
    const debit = +(long.ask - s.bid).toFixed(2);
    const width = +Math.abs(long.strike - s.strike).toFixed(2);
    if (debit <= 0 || width <= 0 || debit * 100 > maxDebit) continue;
    const rr = +((width - debit) / debit).toFixed(1);
    if (rr < CFG.DEBIT_MIN_RR) continue;
    if (!best || rr > best.rr) best = { kind:`DEBIT_${dir.toUpperCase()}`, long:long.strike, short:s.strike, debit,
      maxLoss:+(debit*100).toFixed(2), maxGain:+((width-debit)*100).toFixed(2), rr, expiry:long.expiry, dte:long.dte };
  }
  return best;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function scorePCS(s, m, tier) {
  const pop = Math.round(s.pop * 100);
  const cw  = Math.min(100, Math.round(s.cw * 200));
  const ivr = m?.ivRank != null ? Math.min(100, m.ivRank) : 50;
  return Math.round(pop*0.35 + cw*0.25 + ivr*0.20 + (TIER_W[tier]??40)*0.20);
}
function conf(score, regime) {
  let c = score;
  if (regime === 'RISK-OFF') c -= 15;
  if (regime === 'MIXED')    c -= 8;
  c = Math.min(95, Math.max(5, c));
  return { pct: c, label: c >= 70 ? 'HIGH' : c >= 50 ? 'MEDIUM' : 'LOW' };
}

// ─── Map to dashboard-compatible candidate ───────────────────────────────────
function pcsCandidate(u, chain, m, s, regime) {
  const score = scorePCS(s, m, u.tier);
  const c = conf(score, regime);
  return {
    ticker:u.ticker, sector:u.sector, tier:u.tier, strategy:'PCS',
    price:chain.price, ivrPct:m?.ivRank ?? '?', ivPct:m?.iv ?? '?',
    suggestedStrike:`${s.short}/${s.long}P`, nearExpiry:s.expiry,
    confidence:c.label, score:String(c.pct),
    credit:s.credit, maxLoss:s.maxLoss, pop:Math.round(s.pop*100), cw:s.cw, width:s.width, dte:s.dte,
    rationale:`Sell ${s.short}P / buy ${s.long}P · ${s.dte}d · credit $${s.credit} (${Math.round(s.cw*100)}% of width) · POP ~${Math.round(s.pop*100)}% · IVR ${m?.ivRank ?? '?'}.`,
    keyRisk:`Defined max loss $${s.maxLoss}. Assignment risk if it closes below $${s.short} near expiry.`,
  };
}
function convexCandidate(u, chain, m, x, regime) {
  return {
    ticker:u.ticker, sector:u.sector, tier:u.tier, strategy:'DEBIT',
    price:chain.price, ivrPct:m?.ivRank ?? '?', ivPct:m?.iv ?? '?',
    suggestedStrike:`${x.long}/${x.short}`, nearExpiry:x.expiry,
    confidence:'LOTTERY', score:'—',
    optionCost:x.debit, maxLoss:x.maxLoss, maxGain:x.maxGain, rr:x.rr, expDays:x.dte,
    rationale:`Convex ${x.kind.includes('CALLS')?'call':'put'} debit ${x.long}/${x.short} · debit $${x.debit} · ${x.rr}:1 · ${x.dte}d.`,
    keyRisk:`Lottery sleeve — expect full loss of $${x.maxLoss} most times.`,
  };
}

// ─── Main scan ───────────────────────────────────────────────────────────────
export async function runScan(mode = 'manual') {
  const t0 = Date.now();
  const token = await getTTToken();
  const nlv = await getNLV(token);
  const veto = (Netlify.env.get('IO_FUND_VETO_LIST') || 'AMD,AVGO,LITE').split(',').map(t=>t.trim().toUpperCase()).filter(Boolean);
  const trigger = (Netlify.env.get('KNOX_TRIGGER') || 'off').toLowerCase();
  const vix = await fetchVIX();
  const regime = regimeOf(vix);
  const metrics = await fetchMetrics(token, UNIVERSE.map(u => u.ticker));

  // Stage 1 — eligibility from real metrics
  const eligible = [];
  for (const u of UNIVERSE) {
    if (veto.includes(u.ticker)) continue;
    const m = metrics[u.ticker];
    if (!m) continue;
    if (m.earningsKnown && m.earningsDays < CFG.EARNINGS_BUFFER) continue;
    if (m.liquidity && m.liquidity < CFG.MIN_LIQUIDITY) continue;
    const sellable = m.ivRank != null && m.ivRank >= CFG.MIN_IV_RANK && !(regime === 'RISK-OFF' && u.sector.startsWith('AI'));
    const convexOK = (trigger === 'calls' || trigger === 'puts') && (m.ivRank == null || m.ivRank <= CFG.MAX_IV_RANK_CONVEX) && u.tier <= 2;
    if (!sellable && !convexOK) continue;
    eligible.push({ ...u, m, sellable, convexOK, rankScore: (TIER_W[u.tier]??40) + (m.ivRank ?? 0) });
  }
  eligible.sort((a,b) => b.rankScore - a.rankScore);

  // Stage 2 — enrich top N with real chains
  const candidates = [];
  for (const u of eligible.slice(0, CFG.TOP_N_ENRICH)) {
    try {
      const chain = await fetchChain(u.ticker);
      if (!chain.price) continue;
      if (u.sellable) { const s = buildPCS(chain, nlv); if (s) candidates.push(pcsCandidate(u, chain, u.m, s, regime)); }
      if (u.convexOK) { const x = buildDebit(chain, nlv, trigger, CFG.CONVEX_RISK_PCT); if (x) candidates.push(convexCandidate(u, chain, u.m, x, regime)); }
    } catch (e) { console.warn(`chain ${u.ticker}:`, e.message); }
  }

  // Satellite debit sweep — only when a Knox direction is armed (puts now, calls after the flip)
  if (trigger === 'puts' || trigger === 'calls') {
    for (let i = 0; i < SATELLITE.length; i += 8) {
      const batch = SATELLITE.slice(i, i + 8);
      const chains = await Promise.all(batch.map(async (s) => {
        try { return [s, await fetchChain(s.ticker)]; } catch { return [s, null]; }
      }));
      for (const [s, chain] of chains) {
        if (!chain || !chain.price) continue;
        const x = buildDebit(chain, nlv, trigger, CFG.DEBIT_MAX_RISK_PCT);
        if (x) candidates.push(convexCandidate({ ...s, tier: 'S' }, chain, null, x, regime));
      }
    }
  }

  // Rank: credit spreads first (by score), then debit plays (by reward:risk)
  candidates.sort((a, b) => {
    const rank = (c) => c.strategy === 'PCS' ? 1000 + (parseFloat(c.score) || 0) : (parseFloat(c.rr) || 0);
    return rank(b) - rank(a);
  });

  const scanResult = {
    generatedAt:new Date().toISOString(), mode, vix:vix.toFixed(2), regime, nlv,
    trigger, universe:UNIVERSE.length, candidateCount:candidates.length,
    candidates:candidates.slice(0, 12), all:candidates, durationMs:Date.now()-t0,
  };
  const store = getStore('trading-data');
  await store.setJSON('latest-scan', scanResult);
  if (mode === 'sunday') await store.setJSON('sunday-snapshot', scanResult);
  await sendTelegram(buildMessage(scanResult));
  return scanResult;
}

// ─── Telegram (HTML, same channel as deployed) ───────────────────────────────
function buildMessage(r) {
  const pcs = r.candidates.filter(c => c.strategy === 'PCS').slice(0, 4);
  const lot = r.candidates.filter(c => c.strategy === 'DEBIT').slice(0, 6);
  let m = `🔍 <b>Scan v3 — ${r.mode}</b>\n`;
  m += `VIX ${r.vix} · <b>${r.regime}</b> · NLV $${r.nlv.toLocaleString()} · lottery ${r.trigger}\n\n`;
  if (!pcs.length) m += `No credit-spread setup cleared the gates — <i>no-trade is a valid output.</i>\n`;
  for (const c of pcs) {
    m += `📉 <b>${c.ticker}</b> ${c.short ?? ''} PCS [${c.confidence} ${c.score}]\n`;
    m += `  ${c.suggestedStrike} · ${c.dte}d · credit $${c.credit} · maxLoss $${c.maxLoss}\n`;
    m += `  POP ~${c.pop}% · c/w ${c.cw} · IVR ${c.ivrPct}\n`;
  }
  if (lot.length) {
    m += `\n🎟️ <b>Debit plays — ${r.trigger.toUpperCase()} (defined risk):</b>\n`;
    for (const c of lot) m += `  ${c.ticker} ${c.suggestedStrike} · $${c.optionCost} · ${c.rr}:1 · ${c.expDays}d\n`;
  }
  m += `\n<a href="https://md-trading-dashboard.netlify.app">Dashboard</a>`;
  return m;
}
export async function sendTelegram(text) {
  const token = Netlify.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Netlify.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id:chatId, text, parse_mode:'HTML', disable_web_page_preview:true }),
  });
  const d = await r.json();
  if (!d.ok) console.warn('Telegram:', JSON.stringify(d));
}
