// Shared tastytrade OAuth auth — returns a valid access token using refresh token flow
export async function getTTToken() {
  const refreshToken = Netlify.env.get('TT_REFRESH_TOKEN');
  const clientId = Netlify.env.get('TT_OAUTH_CLIENT_ID');
  const clientSecret = Netlify.env.get('TT_OAUTH_CLIENT_SECRET');

  const resp = await fetch('https://api.tastyworks.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'md-trading-dashboard/1.0' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`TT token refresh failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}
