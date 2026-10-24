// crypto-daily.mjs — scheduled: marks the Crypto Lane paper test once a day at 00:20 UTC (04:20 Dubai), after the 00:00 UTC daily close. BUILD 2026-10-24
import { runCrypto } from './lib/crypto-core.mjs';
export default async () => {
  const r = await runCrypto({});
  console.log('crypto-daily', r.ok ? (r.skipped || 'marked ' + r.state?.lastDate) : r.error);
};
export const config = { schedule: '20 0 * * *' };
