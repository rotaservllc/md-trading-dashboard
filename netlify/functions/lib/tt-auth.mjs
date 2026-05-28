import { request as httpsRequest } from 'node:https';

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, port: 443, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
      },
    };
    const req = httpsRequest(options, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

export async function getTTToken() {
  const refreshToken = Netlify.env.get('TT_REFRESH_TOKEN');
  const clientId = Netlify.env.get('TT_OAUTH_CLIENT_ID');
  const clientSecret = Netlify.env.get('TT_OAUTH_CLIENT_SECRET');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString();
  const { status, body: responseBody } = await httpsPost('api.tastyworks.com', '/oauth/token', body);
  if (status !== 200) throw new Error(`TT token refresh failed ${status}: ${responseBody.slice(0, 200)}`);
  return JSON.parse(responseBody).access_token;
}
