// sunday-scanner.mjs — scheduled Sun 04:00 UTC (08:00 Dubai)   BUILD: 2026-06-05T00:00:00Z
import { runScan } from './lib/scan-core.mjs';

export default async () => { await runScan('sunday'); };

// schedule removed 1 Nov 2026 (options off until January; Netlify_GitHub_Plan_28Oct2026). Re-add: export const config = { schedule: '...' };
