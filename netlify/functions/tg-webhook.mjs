// tg-webhook.mjs — Telegram bot with two-way commands
// Commands: /status /prices /scan /check /add /remove /watchlist /help
import { getStore } from '@netlify/blobs';
import { getWatchlist, saveWatchlist } from './lib/watchlist.mjs';
import { getTTToken } from './lib/tt-auth.mjs';
import { CFG, getNLV, fetchMetrics, fetchVIX, regimeOf, fetchChain, buildPCS, buildDebit } from './lib/scan-core.mjs';
import { sourceOf } from './lib/universe.mjs';

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


// ─── Charter v1.0 gate check from the phone: /gate TICKER [calls|puts|credit] ─────────────────
async function handleGate(chatId, ticker, want) {
  if (!ticker) { await reply(chatId, 'Usage: /gate TICKER [calls|puts|credit]'); return; }
  const t = ticker.toUpperCase(); want = (want || '').toLowerCase();
  const token = await getTTToken();
  const [nlv, vix, metrics, chain] = await Promise.all([getNLV(token), fetchVIX(), fetchMetrics(token, [t]), fetchChain(t).catch(e => ({ err: e.message }))]);
  const m = metrics[t]; const regime = regimeOf(vix);
  const veto = (Netlify.env.get('IO_FUND_VETO_LIST') || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const trigger = (Netlify.env.get('KNOX_TRIGGER') || 'off').toLowerCase();
  const src = sourceOf(t);
  const g = []; const fail = (x) => g.push(`❌ ${x}`), pass = (x) => g.push(`✅ ${x}`), warn = (x) => g.push(`⚠️ ${x}`);
  if (!m) fail('no tastytrade metrics — not optionable / unknown symbol'); else {
    (m.liquidity >= CFG.MIN_LIQUIDITY ? pass : fail)(`liquidity ${m.liquidity ?? '?'}/4 (need ≥${CFG.MIN_LIQUIDITY})`);
    if (m.earningsKnown) ((m.earningsDays > CFG.EARNINGS_BUFFER || m.earningsDays < 0) ? pass : fail)(`earnings in ${m.earningsDays}d (need >${CFG.EARNINGS_BUFFER})`); else warn('earnings date unknown — verify manually');
    const ivr = m.ivRank;
    if (ivr == null) warn('IV rank unavailable');
    else if (ivr >= CFG.IV_SELL_CLEAR) pass(`IV rank ${ivr} → SELL-CLEAR band (credit ok)`);
    else if (ivr >= CFG.IV_SELL_FLOOR) warn(`IV rank ${ivr} → MID band 20–40 (either; state the case in the log)`);
    else pass(`IV rank ${ivr} → BUY-ONLY band (no short premium)`);
    if (m.ivPct != null && m.ivPct < CFG.IV_PCTL_WARN) warn(`IV percentile ${m.ivPct} <10 — 1-yr low, default no-trade unless the directional case is strong`);
  }
  if (veto.includes(t) || src === 'IO Fund') warn(`${t} is an IO Fund name — no directional trade AGAINST it (no puts/bear); bullish structures only`);
  g.push(`ℹ️ source ${src} · regime ${regime} (VIX ${vix.toFixed(1)}) · armed direction ${trigger}`);
  if (src === 'IO Fund') g.push('ℹ️ IO lane: months-quarters horizon → ≥60 DTE or hold as stock in Sarwa; never a <30 DTE option');
  if (src === 'CML Pro') g.push('ℹ️ CML lane: 45–90 DTE debit structures');

  let structures = '';
  if (chain?.err) structures = `\nchain: ${chain.err}`;
  else if (chain?.price) {
    structures += `\n<b>Structures that fit (${nlv.toFixed(0)} NLV, DTE ${CFG.DTE_MIN}–${CFG.DTE_MAX}, spot $${chain.price})</b>`;
    const canSell = m?.ivRank != null && m.ivRank >= CFG.IV_SELL_FLOOR && want !== 'calls' && want !== 'puts';
    if (canSell) {
      const s1 = buildPCS(chain, nlv, CFG.MAX_RISK_PCT), s2 = buildPCS(chain, nlv, CFG.TIER2_RISK_PCT);
      structures += s1 ? `\n📉 PCS T1 ${s1.short}/${s1.long} ${s1.expiry} (${s1.dte}d) cr $${s1.credit} maxL $${s1.maxLoss} POP ${Math.round(s1.pop*100)}% c/w ${s1.cw}` : '\n📉 PCS Tier-1 (2%): none fits';
      structures += (s2 && s2.pop >= CFG.TIER2_MIN_POP && s2.cw >= CFG.TIER2_MIN_CW) ? `\n🔶 PCS T2 ${s2.short}/${s2.long} ${s2.expiry} (${s2.dte}d) cr $${s2.credit} maxL $${s2.maxLoss} POP ${Math.round(s2.pop*100)}% — 3 signals required` : '\n🔶 PCS Tier-2 (4%): none meets POP≥70/cw≥.35';
    } else if (want === 'credit') structures += '\n📉 credit blocked: IV rank below 20 (Charter §3)';
    for (const dir of (want === 'calls' ? ['calls'] : want === 'puts' ? ['puts'] : ['calls', 'puts'])) {
      if (dir === 'puts' && (veto.includes(t) || src === 'IO Fund')) { structures += `\n🎟️ ${dir}: blocked (IO veto)`; continue; }
      const x = buildDebit(chain, nlv, dir, CFG.DEBIT_MAX_RISK_PCT);
      structures += x ? `\n🎟️ ${dir.toUpperCase()} debit ${x.long}/${x.short} ${x.expiry} (${x.dte}d) $${x.debit} · ${x.rr}:1 · maxL $${x.maxLoss} maxG $${x.maxGain}${trigger === dir ? ' · armed ✅' : ' · NOT armed — needs written regime case'}` : `\n🎟️ ${dir.toUpperCase()} debit: none ≥2:1 within 2%`;
    }
  }
  const hard = g.filter(x => x.startsWith('❌')).length;
  const head = hard ? `🚫 <b>${t} — ${hard} hard gate(s) failed</b>` : `🟢 <b>${t} — mechanical gates pass</b> (judgement still required)`;
  const foot = `\n\n<b>Exits (pre-commit):</b> target 50% of max gain · stop 50% of debit / 2× credit, stop-limit · time-stop 5d (event trades)\n<b>To log:</b> /log ${t} 1 knox CDS | signal one ; signal two   (tier 2 needs 3 signals)`;
  await reply(chatId, `${head}\n${g.join('\n')}${structures}${foot}`);
}

// ─── Trade log from the phone: /log TICKER TIER LANE STRUCTURE | sig1 ; sig2 [; sig3] ─────────
async function handleLog(chatId, text) {
  const body = text.replace(/^\/log(@\w+)?\s*/i, '');
  const [head, sigs] = body.split('|').map(x => (x || '').trim());
  const [ticker, tier, lane, structure] = head.split(/\s+/);
  const signals = (sigs || '').split(';').map(x => x.trim()).filter(Boolean);
  if (!ticker || !tier || !lane || !structure || signals.length < 2) { await reply(chatId, 'Usage: /log TICKER TIER(1|2|HEDGE) LANE(knox|cml|io|scan|uw) STRUCTURE(PCS|PDS|CDS|LONG_CALL|LONG_PUT) | signal one ; signal two [; signal three]'); return; }
  if (String(tier) === '2' && signals.length < 3) { await reply(chatId, '🔶 Tier-2 needs 3 independent signals. Add one or log as Tier 1.'); return; }
  const store = getStore('trading-data');
  const log = (await store.get('trade-log', { type: 'json' })) || [];
  const open = log.filter(e => !e.outcome);
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = log.filter(e => e.entry?.date?.startsWith(month)).length;
  const openT2 = open.filter(e => String(e.tier) === '2').length, t2Month = log.filter(e => String(e.tier) === '2' && e.entry?.date?.startsWith(month)).length;
  const caps = [];
  if (open.length >= 2) caps.push(`${open.length} positions already open (cap 2)`);
  if (thisMonth >= 4) caps.push(`${thisMonth} trades this month (cap 4)`);
  if (String(tier) === '2' && openT2 >= 1) caps.push('a Tier-2 is already open (cap 1)');
  if (String(tier) === '2' && t2Month >= 2) caps.push(`${t2Month} Tier-2 this month (cap 2)`);
  const token = await getTTToken(); const [nlv, vix, metrics] = await Promise.all([getNLV(token), fetchVIX(), fetchMetrics(token, [ticker.toUpperCase()])]);
  const m = metrics[ticker.toUpperCase()] || {};
  const id = `T-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ticker.toUpperCase()}`;
  const entry = { id, tier: String(tier).toUpperCase() === 'HEDGE' ? 'HEDGE' : Number(tier), lane: lane.toLowerCase(), ticker: ticker.toUpperCase(), structure: structure.toUpperCase(),
    entry: { date: new Date().toISOString(), signals, iv: { ivRank: m.ivRank ?? null, ivPercentile: m.ivPct ?? null, iv: m.iv ?? null }, earningsDays: m.earningsKnown ? m.earningsDays : null,
             regime: { vix, regime: regimeOf(vix), knoxTrigger: (Netlify.env.get('KNOX_TRIGGER') || 'off') }, nlv, capWarnings: caps, plan: { target: '50% max gain', stop: '50% debit / 2x credit, stop-limit', timeStopDays: 5 } },
    fills: [], outcome: null };
  log.push(entry); await store.setJSON('trade-log', log);
  await reply(chatId, `${caps.length ? '🚫 <b>CAP BREACH — logged but DO NOT place:</b>\n' + caps.join('\n') + '\n\n' : '📝 '}<b>Logged ${id}</b> · Tier ${entry.tier} · ${entry.lane} · ${entry.structure}\nIVR ${m.ivRank ?? '?'} · pctl ${m.ivPct ?? '?'} · earnings ${m.earningsKnown ? m.earningsDays + 'd' : '?'} · ${regimeOf(vix)}\nSignals:\n• ${signals.join('\n• ')}\n\nNow place the order in tastytrade WITH the stop-limit exit. Fills get reconciled from the API — never type them.`);
}

async function handleJournal(chatId) {
  const log = (await getStore('trading-data').get('trade-log', { type: 'json' })) || [];
  const month = new Date().toISOString().slice(0, 7);
  const open = log.filter(e => !e.outcome), tm = log.filter(e => e.entry?.date?.startsWith(month));
  let msg = `📒 <b>Trade log</b> · ${log.length} entries · open ${open.length}/2 · this month ${tm.length}/4\n`;
  for (const e of log.slice(-6).reverse()) msg += `\n${e.outcome ? '✔' : '⏳'} ${e.id} · T${e.tier} ${e.lane} ${e.structure} · IVR ${e.entry?.iv?.ivRank ?? '?'}${e.outcome ? ` · $${e.outcome.netPL}` : ''}`;
  await reply(chatId, msg);
}

async function handleMarket(chatId) {
  const r = await getStore('trading-data').get('market-scan', { type: 'json' });
  if (!r) { await reply(chatId, 'No market scan yet (runs 05:00 Dubai Tue–Sat).'); return; }
  const armed = r.debit.filter(c => c.armed).slice(0, 5), t1 = r.credit.filter(c => !c.tier2).slice(0, 3);
  let msg = `🌐 <b>Market scan</b> ${r.generatedAt.slice(0, 16)}Z · VIX ${r.vix} ${r.regime} · dir ${r.trigger}\nstage-1 ${r.gates.passedStage1}/${r.universe} · rich ${r.lanes.rich} · cheap ${r.lanes.cheap} · spikes ${r.lanes.ivSpike}\n`;
  msg += t1.length ? `\n📉 credit: ` + t1.map(c => `${c.ticker} ${c.suggestedStrike} $${c.credit}`).join(' · ') : '\n📉 credit: 0 (expected at this NLV)';
  msg += armed.length ? `\n🎟️ ${r.trigger}: ` + armed.map(c => `${c.ticker} ${c.suggestedStrike} ${c.rr}:1`).join(' · ') : `\n🎟️ ${r.trigger}: 0`;
  msg += `\n\n/gate TICKER to run the charter check on any of them.`;
  await reply(chatId, msg);
}

async function handleHsbc(chatId) {
  const st = await getStore('trading-data').get('hsbc-state', { type: 'json' });
  if (!st) { await reply(chatId, 'No HSBC monitor state yet.'); return; }
  await reply(chatId, `🏦 <b>HSBC tranches</b> (Plan B) · ${st.lastRun?.slice(0, 10)}\nVWRA $${st.vwra?.toFixed(2)} (${st.vwraFromFill}% vs T2 fill; T3 ≤ $${st.t3Level}) · DXY ${st.dxy?.toFixed(2)} (${st.dxyDrop}% vs 6m high; signal ≤ ${st.dxySignalLevel}) · Gold $${st.gold?.toFixed(0)} · COPX $${st.copx?.toFixed(2)} · SMH $${st.smh?.toFixed(0)}\nT3 ${st.t3} · T4 ${st.t4} · T5 ${st.t5} · EM ${st.em} · EQQQ ${st.eqqq}`);
}

async function handleCrypto(chatId) {
  // Crypto Lane paper state is committed by the GitHub Actions workflow `crypto-paper` (repo rotaservllc/md-trading-dashboard)
  const r = await fetch('https://raw.githubusercontent.com/rotaservllc/md-trading-dashboard/main/crypto/state.json?t=' + Date.now());
  if (!r.ok) { await reply(chatId, 'Crypto paper state not readable (' + r.status + ').'); return; }
  const st = await r.json(); const L = st.lanes, b = st.analysis.BTC, e = st.analysis.ETH;
  const pct = x => (x * 100).toFixed(0) + '%';
  const eq = k => `${k} $${L[k].eq.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${((L[k].eq / 12000 - 1) * 100).toFixed(1)}%)`;
  const f = Object.entries(b.fired).map(([k, v]) => `${v ? '✅' : '▫️'} ${k}`).join(' · ');
  await reply(chatId, `🪙 <b>Crypto lane paper · ${st.lastDate}</b> (day ${st.days}, marked ${(st.lastRun || '').slice(0, 16)}Z)\n` +
    `BTC $${b.close.toLocaleString('en-US', { maximumFractionDigits: 0 })} score ${b.score.toFixed(2)} vol ${pct(b.rv)} · ETH $${e.close.toLocaleString('en-US', { maximumFractionDigits: 0 })} score ${e.score.toFixed(2)} vol ${pct(e.rv)}\n` +
    `Lane D ${pct(L.D.w.BTC + L.D.w.ETH)} (BTC ${pct(L.D.w.BTC)} ETH ${pct(L.D.w.ETH)}) · E ${pct(L.E.w.BTC + L.E.w.ETH)} · S ${pct(-(L.S.w.BTC + L.S.w.ETH))} short · R ${pct(Object.values(L.R.w).reduce((a, x) => a + x, 0))}\n` +
    `Carry: BTC ${L.C.funding?.BTC == null ? 'n/a' : pct(L.C.funding.BTC)} ${L.C.in.BTC ? 'IN' : 'out'} · ETH ${L.C.funding?.ETH == null ? 'n/a' : pct(L.C.funding.ETH)} ${L.C.in.ETH ? 'IN' : 'out'}\n` +
    `Equity: ${['D', 'E', 'C', 'S', 'R'].map(eq).join(' · ')}\nBTC rules: ${f}`);
}

async function handleHelp(chatId) {
  await reply(chatId,
    `🤖 <b>MD Trading Bot Commands</b>\n\n` +
    `/status — Account balance & Net Liq\n` +
    `/prices — Watchlist prices (delayed)\n` +
    `/scan — Latest scan results (top 5)\n` +
    `/check TICKER [CSP|CALL] — Quick IV check\n` +
    `/gate TICKER [calls|puts|credit] — Charter v1.0 gate check + structures that fit\n` +
    `/log TICKER TIER LANE STRUCTURE | sig1 ; sig2 — write the entry log (before the order)\n` +
    `/journal — trade log & caps · /market — latest market scan · /hsbc — tranche triggers · /crypto — crypto lane paper test\n` +
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
      case '/gate':     await handleGate(chatId, parts[1], parts[2]); break;
      case '/log':      await handleLog(chatId, text); break;
      case '/journal':  await handleJournal(chatId); break;
      case '/market':   await handleMarket(chatId); break;
      case '/hsbc':     await handleHsbc(chatId); break;
      case '/crypto':   await handleCrypto(chatId); break;
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
