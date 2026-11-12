export class AvatarLookupError extends Error {
  code: string;
  upstreamStatus?: number;
  constructor(code: string, message: string, upstreamStatus?: number) {
    super(message); this.name = 'AvatarLookupError'; this.code = code; this.upstreamStatus = upstreamStatus;
  }
}
const blockedMessage = 'LinkedIn blocked this server’s request. This does not mean your profile or photo is private. Automatic lookup needs a profile-data service connected by the dashboard owner.';

export function normalizeProfile(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid LinkedIn profile URL.');
  const input = value.trim();
  let url: URL;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); } catch { throw new Error('Enter a valid LinkedIn profile URL.'); }
  if (url.protocol !== 'https:' || !/^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(url.hostname) || url.username || url.password || url.port || !/^\/in\/[a-zA-Z0-9_%\-]+\/?$/.test(url.pathname)) {
    throw new Error('Use a personal profile URL, such as https://www.linkedin.com/in/your-name/.');
  }
  return `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}/`;
}
function decode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => { const code = Number(n); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; });
}
export function isAvatar(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'media.licdn.com' || u.hostname.endsWith('.licdn.com')) && /profile-displayphoto|profile-framedphoto/.test(u.pathname); } catch { return false; }
}
export function parseProfile(html: string) {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[match[1].toLowerCase()] = decode(match[3]);
    const key = attrs.property || attrs.name;
    if (key) meta[key] = attrs.content;
  }
  const candidates = [meta['og:image'], meta['twitter:image']];
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    if (!/profile|photo/i.test(tag)) continue;
    for (const m of tag.matchAll(/(?:src|data-delayed-url)\s*=\s*(["'])([\s\S]*?)\1/g)) candidates.push(decode(m[2]));
  }
  const avatarUrl = candidates.find(v => v && isAvatar(v));
  if (!avatarUrl) return null;
  return { avatarUrl, name: (meta['og:title'] || 'LinkedIn profile').replace(/\s*[|–-]\s*LinkedIn.*$/i, '').split(' - ')[0].trim() };
}
export async function extractAvatar(value: unknown, fetcher: typeof fetch = fetch) {
  const profileUrl = normalizeProfile(value);
  const response = await fetcher(profileUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'AvatarExtraction/1.0', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
  if ([999, 401, 403, 429].includes(response.status) || (response.status >= 300 && response.status < 400)) {
    throw new AvatarLookupError('LINKEDIN_ACCESS_BLOCKED', blockedMessage, response.status);
  }
  if (response.status === 404) throw new AvatarLookupError('PROFILE_NOT_FOUND', 'LinkedIn could not find that profile. Check the profile URL.', 404);
  if (!response.ok) throw new AvatarLookupError('LINKEDIN_UPSTREAM_ERROR', 'LinkedIn could not complete the request. Please try again later.', response.status);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('LinkedIn returned an unexpected response. Please try again later.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LinkedIn returned an empty response.');
  let html = ''; let size = 0; const decoder = new TextDecoder();
  try { while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new Error('The profile response was too large to process.'); html += decoder.decode(value, {stream:true}); } } finally { await reader.cancel(); }
  html += decoder.decode();
  if (/<(?:form|iframe)\b[^>]*(?:authwall|checkpoint|challenge|login-submit)/i.test(html) || /<title[^>]*>[^<]*(?:sign in|log in|security verification)/i.test(html)) {
    throw new AvatarLookupError('LINKEDIN_ACCESS_BLOCKED', blockedMessage, response.status);
  }
  const result = parseProfile(html);
  if (!result) throw new AvatarLookupError('PHOTO_NOT_AVAILABLE', 'LinkedIn did not return a usable profile photo. We cannot determine the photo’s visibility from this response.');
  return {...result, profileUrl};
}

const brightBase = 'https://api.brightdata.com/datasets/v3';
const dataset = 'gd_l1viktl72bvl7bjuj0';
export async function brightRequest(path: string, key: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (!key.trim()) throw new AvatarLookupError('PROVIDER_NOT_CONFIGURED', 'The dashboard owner needs to configure the profile lookup service.');
  const response = await fetcher(brightBase + path, {method: body === undefined ? 'GET' : 'POST', redirect:'manual', signal:AbortSignal.timeout(25000), headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const raw = await response.text();
  // Provider errors can be plain text. Never forward arbitrary upstream text or credentials.
  if (/customer is not active|account is (?:inactive|suspended)|activate (?:your|the) account/i.test(raw)) throw new AvatarLookupError('PROVIDER_ACCOUNT_INACTIVE', 'The Bright Data account is not active. The dashboard owner must activate it in Bright Data before avatar lookup can work.', response.status);
  if (/insufficient (?:balance|credit)|not enough (?:balance|credit)/i.test(raw) || response.status === 402) throw new AvatarLookupError('PROVIDER_CREDITS_REQUIRED', 'The profile lookup account needs credits. Please contact the dashboard owner.', response.status);
  if ([401,403].includes(response.status)) throw new AvatarLookupError('PROVIDER_AUTH_FAILED', 'Bright Data rejected the API key or account permissions. Please contact the dashboard owner.', response.status);
  if (response.status === 429) throw new AvatarLookupError('PROVIDER_RATE_LIMIT', 'The profile lookup service is busy. Please wait before trying again.', 429);
  if (!response.ok) throw new AvatarLookupError('PROVIDER_ERROR', 'The profile lookup service could not complete this request. Please try again later.', response.status);
  try { return JSON.parse(raw); } catch { throw new AvatarLookupError('PROVIDER_RESPONSE_INVALID', 'The profile lookup service returned an unreadable response.'); }
}
type LookupJob = {snapshot: string; profileUrl: string; expires: number};
const encoder = new TextEncoder();
async function signingKey(key: string) { return crypto.subtle.importKey('raw', encoder.encode(key), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
function encode64(bytes: Uint8Array) { return btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function decode64(value: string) { return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)); }
export async function signLookup(job: LookupJob, key: string) {
  const payload = encode64(encoder.encode(JSON.stringify(job)));
  const sig = await crypto.subtle.sign('HMAC',await signingKey(key),encoder.encode('avatar-job:'+payload));
  return payload+'.'+encode64(new Uint8Array(sig));
}
export async function verifyLookup(token: unknown, key: string): Promise<LookupJob> {
  try {
    if (typeof token !== 'string' || token.length > 6000) throw new Error();
    const parts = token.split('.'); if(parts.length !== 2) throw new Error();
    const valid = await crypto.subtle.verify('HMAC',await signingKey(key),decode64(parts[1]),encoder.encode('avatar-job:'+parts[0]));
    if (!valid) throw new Error();
    const job = JSON.parse(new TextDecoder().decode(decode64(parts[0]))) as LookupJob;
    if (!/^s[d]?_[a-zA-Z0-9]+$/.test(job.snapshot) || !Number.isFinite(job.expires) || job.expires < Date.now() || normalizeProfile(job.profileUrl) !== job.profileUrl) throw new Error();
    return job;
  } catch { throw new AvatarLookupError('LOOKUP_EXPIRED', 'This lookup has expired or is invalid. Please extract the avatar again.'); }
}
export function parseBrightProfile(data: unknown, profileUrl: string) {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') throw new AvatarLookupError('PROVIDER_RESPONSE_INVALID','The profile lookup service returned an unexpected result.');
  const record = data[0] as Record<string, unknown>;
  if (record.error || record.error_code) throw new AvatarLookupError('PROFILE_NOT_FOUND','Bright Data could not retrieve this profile. Check the URL or try again later.');
  // Verify the input association; never use another person's recommended profile photo.
  const input = record.input as {url?:unknown} | undefined;
  const returnedUrl = record.input_url ?? input?.url ?? record.url;
  if (returnedUrl && normalizeProfile(returnedUrl) !== profileUrl) throw new AvatarLookupError('PROFILE_MISMATCH','The lookup service returned a different profile. Please try again.');
  if (record.default_avatar === true || typeof record.avatar !== 'string' || !isAvatar(record.avatar)) throw new AvatarLookupError('PHOTO_NOT_AVAILABLE','The profile lookup service found no public profile photo for this person.');
  return {name:typeof record.name === 'string' && record.name.trim() ? record.name : 'LinkedIn profile', avatarUrl:record.avatar, profileUrl};
}
export async function beginBrightLookup(value: unknown, key: string, fetcher: typeof fetch = fetch) {
  const profileUrl = normalizeProfile(value);
  const data = await brightRequest(`/trigger?dataset_id=${dataset}&include_errors=true&format=json`,key,{input:[{url:profileUrl}]},fetcher) as {snapshot_id?:unknown};
  if (typeof data?.snapshot_id !== 'string' || !/^s[d]?_[a-zA-Z0-9]+$/.test(data.snapshot_id)) throw new AvatarLookupError('PROVIDER_RESPONSE_INVALID','The lookup service did not start a valid request.');
  return {status:'pending', job:await signLookup({snapshot:data.snapshot_id,profileUrl,expires:Date.now()+30*60*1000},key)};
}
export async function pollBrightLookup(token: unknown, key: string, fetcher: typeof fetch = fetch) {
  const job = await verifyLookup(token,key);
  const progress = await brightRequest(`/progress/${job.snapshot}`,key,undefined,fetcher) as {status?:string;dataset_id?:string};
  if (progress.dataset_id && progress.dataset_id !== dataset) throw new AvatarLookupError('PROVIDER_RESPONSE_INVALID','Unexpected lookup dataset.');
  if (['starting','running'].includes(progress.status || '')) return {status:'pending',job:token};
  if (progress.status !== 'ready') throw new AvatarLookupError('PROVIDER_JOB_FAILED','The profile lookup could not finish. Please try again later.');
  return parseBrightProfile(await brightRequest(`/snapshot/${job.snapshot}?format=json`,key,undefined,fetcher),job.profileUrl);
}

// Cache only the minimal public photo result, never the full provider record.
export type AvatarResult = {name:string;avatarUrl:string;profileUrl:string};
export type CachedLookup = {data:AvatarResult | {status:string;job:unknown};expires:number;checked:number};
export interface AvatarCache { get(key:string):Promise<CachedLookup|undefined>; put(key:string,value:CachedLookup):Promise<void>; delete(key:string):Promise<void> }
const memory = new Map<string,CachedLookup>();
const inFlight = new Map<string,Promise<CachedLookup['data']>>();
export function edgeAvatarCache(origin:string): AvatarCache {
  const edge = typeof caches !== 'undefined' ? (caches as CacheStorage & {default?:Cache}).default : undefined;
  const request = (key:string)=>new Request(`${origin}/__avatar_cache/v1/${key}`);
  return {
    async get(key) {
      let entry=memory.get(key);
      if (!entry && edge) {try {const response=await edge.match(request(key)); if(response) entry=await response.json() as CachedLookup;} catch { /* Cache availability must not block extraction. */ }}
      if (!entry || entry.expires<=Date.now()) {memory.delete(key);return undefined;}
      return entry;
    },
    async put(key,entry) {
      if(memory.size>=200) memory.delete(memory.keys().next().value!);
      memory.set(key,entry);
      if(edge) try {await edge.put(request(key),Response.json(entry,{headers:{'Cache-Control':`public, max-age=${Math.max(1,Math.floor((entry.expires-Date.now())/1000))}`}}));} catch { /* Bounded memory cache remains usable. */ }
    },
    async delete(key) {memory.delete(key);if(edge) try {await edge.delete(request(key));} catch {}}
  };
}
export async function fastAvatarLookup(body:{url?:unknown;job?:unknown},key:string,cache:AvatarCache,fetcher:typeof fetch=fetch,now=Date.now()) {
  const profileUrl=body.job ? (await verifyLookup(body.job,key)).profileUrl : normalizeProfile(body.url);
  // Scope cache entries to this provider credential without storing it in a URL.
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(key+'\n'+profileUrl));
  const id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const cached=await cache.get(id);
  if(cached && cached.expires>now && ('avatarUrl' in cached.data || !body.job || now-cached.checked<900)) return cached.data;
  const lock=id+(body.job?':poll':':start');
  const existing=inFlight.get(lock);if(existing) return existing;
  const work=(async()=>{
    try {
      const data=body.job ? await pollBrightLookup(body.job,key,fetcher) : await beginBrightLookup(profileUrl,key,fetcher);
      let ttl='avatarUrl' in data ? 86400000 : 600000;
      if('avatarUrl' in data) {
        const signedExpiry=Number(new URL(data.avatarUrl).searchParams.get('e'))*1000;
        if(signedExpiry>0) ttl=Math.max(0,Math.min(ttl,signedExpiry-Date.now()-60000));
      }
      if(ttl>0) await cache.put(id,{data,expires:Date.now()+ttl,checked:Date.now()});
      return data;
    } catch(error) {await cache.delete(id);throw error;}
  })();
  inFlight.set(lock,work);
  try {return await work;} finally {inFlight.delete(lock);}
}
