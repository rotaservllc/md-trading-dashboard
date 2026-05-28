export default async (req) => new Response(JSON.stringify({ok:true,note:'Auth via refresh token in tt-account'}),{headers:{'Content-Type':'application/json'}});
export const config = { path: '/api/tt-auth-stub' };
