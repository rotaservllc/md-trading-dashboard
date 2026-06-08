// tt-auth.mjs — stub only, kills ghost at /api/tt-auth-stub
// Real auth logic is in lib/tt-auth.mjs
export default async (req) => {
  return new Response(JSON.stringify({ ok: true, note: 'Auth handled via refresh token flow in tt-account' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/api/tt-auth-stub',
};
