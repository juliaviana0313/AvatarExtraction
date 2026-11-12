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
