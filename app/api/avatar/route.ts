import { AvatarLookupError, extractAvatar, normalizeProfile } from '../../../lib/avatar';
export async function POST(request: Request) {
  const headers = {'Cache-Control':'no-store'};
  if (Number(request.headers.get('content-length') || 0) > 4096) return Response.json({error:'Request is too large.'},{status:413, headers});
  let profileUrl: string;
  try { const body = await request.json(); profileUrl = normalizeProfile(body && typeof body === 'object' && 'url' in body ? body.url : undefined); }
  catch (error) { return Response.json({error:error instanceof Error ? error.message : 'Invalid request.'}, {status:400, headers}); }
  try { return Response.json(await extractAvatar(profileUrl), {headers}); }
  catch (error) {
    if (error instanceof AvatarLookupError) {
      console.warn(JSON.stringify({event:'avatar_lookup_failed', code:error.code, upstreamStatus:error.upstreamStatus}));
      const status = error.code === 'LINKEDIN_ACCESS_BLOCKED' ? 424 : error.code === 'PROFILE_NOT_FOUND' || error.code === 'PHOTO_NOT_AVAILABLE' ? 404 : 502;
      return Response.json({error:error.message, code:error.code, upstreamStatus:error.upstreamStatus}, {status, headers});
    }
    const timeout = error instanceof Error && ['TimeoutError','AbortError'].includes(error.name);
    return Response.json({error:timeout ? 'LinkedIn took too long to respond. Please try again.' : 'The lookup service could not reach LinkedIn. Please try again later.', code:timeout ? 'LOOKUP_TIMEOUT' : 'LOOKUP_NETWORK_ERROR'}, {status:timeout ? 504 : 502, headers});
  }
}
