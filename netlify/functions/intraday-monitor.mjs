// intraday-monitor.mjs — scheduled every 15 min, 13:00–21:00 UTC Mon–Fri (covers EDT/EST cash sessions; core trims to cash hours). BUILD 2026-09-27
import { runIntraday } from './lib/intraday-core.mjs';
export default async () => { const r = await runIntraday(); console.log('intraday-monitor', JSON.stringify(r).slice(0, 300)); };
export const config = { schedule: '*/15 13-21 * * 1-5' };
