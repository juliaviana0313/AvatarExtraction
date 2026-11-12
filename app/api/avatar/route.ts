import { env } from 'cloudflare:workers';
import { AvatarLookupError, beginBrightLookup, pollBrightLookup } from '../../../lib/avatar';
export async function POST(request: Request) {
  const headers = {'Cache-Control':'no-store'};
  if (Number(request.headers.get('content-length') || 0) > 8192) return Response.json({error:'Request is too large.'},{status:413,headers});
  let body: {url?:unknown;job?:unknown};
  try {
    const raw = await request.text();
    if (raw.length > 8192) return Response.json({error:'Request is too large.'},{status:413,headers});
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object') throw new Error();
  } catch { return Response.json({error:'Invalid request.'},{status:400,headers}); }
  try {
    const key = (env as {BRIGHTDATA_API_KEY?:string}).BRIGHTDATA_API_KEY || process.env.BRIGHTDATA_API_KEY || '';
    const data = body.job ? await pollBrightLookup(body.job,key) : await beginBrightLookup(body.url,key);
    return Response.json(data,{status:'status' in data && data.status === 'pending' ? 202 : 200,headers});
  } catch (error) {
    if (error instanceof AvatarLookupError) {
      console.warn(JSON.stringify({event:'avatar_lookup_failed',code:error.code,upstreamStatus:error.upstreamStatus}));
      const status = error.code === 'LOOKUP_EXPIRED' ? 400 : error.code === 'PROVIDER_RATE_LIMIT' ? 429 : ['PROFILE_NOT_FOUND','PHOTO_NOT_AVAILABLE'].includes(error.code) ? 404 : 424;
      return Response.json({error:error.message,code:error.code},{status,headers});
    }
    const timeout = error instanceof Error && ['TimeoutError','AbortError'].includes(error.name);
    // Validation errors contain no upstream data.
    if (error instanceof Error && /^(Enter a valid|Use a personal)/.test(error.message)) return Response.json({error:error.message},{status:400,headers});
    return Response.json({error:timeout ? 'The profile lookup service took too long to respond. Please try again.' : 'The profile lookup service could not be reached. Please try again later.',code:timeout?'LOOKUP_TIMEOUT':'LOOKUP_NETWORK_ERROR'},{status:timeout?504:502,headers});
  }
}
