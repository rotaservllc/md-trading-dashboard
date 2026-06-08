// sunday-scanner.mjs — scheduled Sun 04:00 UTC (08:00 Dubai)   BUILD: 2026-06-05T00:00:00Z
import { runScan } from './lib/scan-core.mjs';

export default async () => { await runScan('sunday'); };

export const config = { schedule: '0 4 * * 0' };
