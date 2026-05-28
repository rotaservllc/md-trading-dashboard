// Stub — kills cached broken scheduled version. Real monitor is daily-monitor-v2.mjs
export default async (req) => new Response(JSON.stringify({ok:true,note:'stub'}),{headers:{'Content-Type':'application/json'}});
