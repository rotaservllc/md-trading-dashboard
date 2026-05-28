// cboe.mjs — CBOE fetcher with node:https (HTTP/1.1) + earnings detection
import { request as httpsRequest } from 'node:https';
import { detectEarnings, earningsGatePass } from './earnings-detector.mjs';

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname, port: 443, path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.end();
  });
}

function parseOptionSymbol(sym) {
  let i = 0;
  while (i < sym.length && sym[i].match(/[A-Z^]/)) i++;
  const rest = sym.slice(i);
  const ds = rest.slice(0, 6); const optType = rest[6]; const strike = parseInt(rest.slice(7)) / 1000;
  const exp = `20${ds.slice(0,2)}-${ds.slice(2,4)}-${ds.slice(4,6)}`;
  return { optType, strike, exp };
}

export async function fetchCBOE(ticker) {
  try {
    const path = `/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`;
    const { status, body } = await httpsGet('cdn.cboe.com', path);
    if (status !== 200) return null;
    const json = JSON.parse(body); const d = json.data || {};

    const options = (d.options || []).map(o => {
      try {
        const { optType, strike, exp } = parseOptionSymbol(o.option);
        return { ...o, option_type: optType, strike_price: strike, expiration: exp };
      } catch { return null; }
    }).filter(Boolean);

    const price = d.current_price;
    const earnings = detectEarnings(options, price, new Date().toISOString().slice(0, 10));

    return { ticker, price, iv30: d.iv30, options, earnings };
  } catch { return null; }
}

export async function fetchVIX() {
  try {
    const { status, body } = await httpsGet('cdn.cboe.com', '/api/global/delayed_quotes/options/%5EVIX.json');
    if (status !== 200) return null;
    return JSON.parse(body).data?.current_price || null;
  } catch { return null; }
}

export { detectEarnings, earningsGatePass };
