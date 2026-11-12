import assert from 'node:assert/strict';
import { AvatarLookupError, normalizeProfile, parseProfile, extractAvatar } from '../lib/avatar.ts';
assert.equal(normalizeProfile('linkedin.com/in/example/?trk=test'), 'https://www.linkedin.com/in/example/');
for (const url of ['https://evil.com/in/test','https://linkedin.com.evil.com/in/test','http://linkedin.com/in/test','https://www.linkedin.com/company/test','https://user:password@linkedin.com/in/test','https://linkedin.com:8443/in/test']) assert.throws(()=>normalizeProfile(url));
const photo='https://media.licdn.com/dms/image/v2/test/profile-displayphoto-shrink_800_800/0/test?e=1&v=2';
const html=`<meta content="Test Person - Example | LinkedIn" property="og:title"><meta property='og:image' content='${photo.replace('&','&amp;')}'>`;
assert.deepEqual(parseProfile(html), {avatarUrl:photo,name:'Test Person'});
assert.equal(parseProfile('<meta property="og:image" content="https://evil.com/photo.jpg">'),null);
assert.equal(parseProfile('<meta property="og:image" content="https://static.licdn.com/logo.png">'),null);
const success=await extractAvatar('linkedin.com/in/test',async()=>new Response(html,{headers:{'Content-Type':'text/html'}}));
assert.equal(success.avatarUrl,photo);
await assert.rejects(extractAvatar('linkedin.com/in/test',async()=>new Response('',{status:403})),/blocked this server/);
await assert.rejects(extractAvatar('linkedin.com/in/test',async()=>new Response('<html>Sign in</html>',{headers:{'Content-Type':'text/html'}})),/did not return a usable/);
await assert.rejects(extractAvatar('linkedin.com/in/test',async()=>new Response('',{status:302,headers:{location:'https://evil.com'}})),/blocked this server/);
console.log('PASS: URL validation, photo parsing, success, blocked access, redirects, and missing-photo handling.');

// Regression: the actual failing upstream response is LinkedIn's nonstandard 999.
await assert.rejects(extractAvatar('https://www.linkedin.com/in/renzo-cole-b20684446/', async()=>({ok:false,status:999})), e=>e instanceof AvatarLookupError && e.code==='LINKEDIN_ACCESS_BLOCKED' && e.upstreamStatus===999 && !e.message.includes('Check that the profile'));
await assert.rejects(extractAvatar('linkedin.com/in/test', async()=>new Response('<title>LinkedIn Sign In</title>',{headers:{'Content-Type':'text/html'}})), e=>e.code==='LINKEDIN_ACCESS_BLOCKED');
await assert.rejects(extractAvatar('linkedin.com/in/test', async()=>new Response('',{status:404})), e=>e.code==='PROFILE_NOT_FOUND');
await assert.rejects(extractAvatar('linkedin.com/in/test', async()=>new Response('',{status:500})), e=>e.code==='LINKEDIN_UPSTREAM_ERROR');
console.log('PASS: HTTP 999, login wall, missing profile, and upstream outage are classified separately.');
