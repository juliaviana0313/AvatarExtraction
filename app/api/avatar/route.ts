import { extractAvatar, normalizeProfile } from '../../../lib/avatar';
export async function POST(request: Request) {
  const headers = {'Cache-Control':'no-store'};
  if (Number(request.headers.get('content-length') || 0) > 4096) return Response.json({error:'Request is too large.'},{status:413, headers});
  let profileUrl: string;
  try { const body = await request.json(); profileUrl = normalizeProfile(body && typeof body === 'object' && 'url' in body ? body.url : undefined); }
  catch (error) { return Response.json({error:error instanceof Error ? error.message : 'Invalid request.'}, {status:400, headers}); }
  try { return Response.json(await extractAvatar(profileUrl), {headers}); }
  catch (error) { const timeout = error instanceof Error && ['TimeoutError','AbortError'].includes(error.name); return Response.json({error:timeout ? 'LinkedIn took too long to respond. Please try again.' : error instanceof Error ? error.message : 'Unable to retrieve this profile.'}, {status:502, headers}); }
}
