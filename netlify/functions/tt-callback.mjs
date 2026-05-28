export default async (req) => {
  const url=new URL(req.url);
  return new Response(JSON.stringify({ok:true,received:{code:url.searchParams.get('code')?'present':'missing'}}),{headers:{'Content-Type':'application/json'}});
};
export const config = { path: '/api/tt-callback' };
