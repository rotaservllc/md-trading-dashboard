// hsbc-monitor.mjs — daily HSBC tranche-trigger check, 01:15 UTC Tue–Sat (05:15 Dubai, after the US close). BUILD 2026-09-28
import { runHsbc } from './lib/hsbc-core.mjs';
export default async () => { const r = await runHsbc(); console.log('hsbc-monitor', JSON.stringify(r).slice(0, 300)); };
export const config = { schedule: '15 1 * * 2-6' };
