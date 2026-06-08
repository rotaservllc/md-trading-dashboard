// tt-callback.mjs — OAuth callback handler (stub for OAuth flow)
export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  return new Response(
    JSON.stringify({ ok: true, received: { code: code ? 'present' : 'missing', state } }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = {
  path: '/api/tt-callback',
};
