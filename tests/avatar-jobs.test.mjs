import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const outfile='/tmp/avatar-jobs-test.mjs';
await build({entryPoints:['lib/avatar-jobs.ts'],bundle:true,platform:'node',format:'esm',outfile});
const {handleAvatarJobs}=await import(outfile);
const photo='https://media.licdn.com/profile-displayphoto/test.jpg';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const file of ['0000_exotic_tarantula.sql','0001_nervous_mephistopheles.sql'])sql.exec(readFileSync('drizzle/'+file,'utf8'));
 function prepare(query){let args=[];return {bind(...values){args=values;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return sql.prepare(query).run(...args);}};}
 const objects=new Map();const env={BRIGHTDATA_API_KEY:'test-key',DB:{prepare,async batch(items){return Promise.all(items.map(x=>x.run()));}},BUCKET:{async put(k,v,meta){objects.set(k,{body:v,httpMetadata:meta.httpMetadata,httpEtag:'test'});},async get(k){return objects.get(k);}}};
 let tasks=[];const ctx={waitUntil(p){tasks.push(p);}};
 async function settle(){while(tasks.length){const current=tasks;tasks=[];await Promise.all(current);}}
 async function call(path,body,headers={}){const response=await handleAvatarJobs(new Request('https://example.test'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);return {status:response.status,data:await response.json()};}
 return {sql,env,objects,settle,call};
}
test('durable queue: immediate response, global concurrency, authenticated callback, deduplication, cache and metrics',async()=>{
 const f=fixture();let submits=[];globalThis.fetch=async(url,options)=>{assert.match(String(url),/\/trigger\?/);submits.push({url:new URL(url),body:JSON.parse(options.body)});return Response.json({snapshot_id:'sd_test'+submits.length});};
 const urls=Array.from({length:5},(_,i)=>`https://www.linkedin.com/in/person-${i}/`);
 const created=await f.call('/api/jobs',{urls});assert.equal(created.status,202);assert.equal(created.data.jobs.length,5);assert.ok(created.data.jobs.every(j=>j.status==='pending'));
 await f.settle();assert.equal(submits.length,3);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM avatar_jobs WHERE status='queued'").get().n,2);
 await f.call('/api/jobs',{urls:[urls[0]]});await f.settle();assert.equal(submits.length,3);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM avatar_jobs').get().n,5);
 const target=submits[0];assert.equal(target.url.searchParams.get('custom_output_fields'),'name|url|avatar');assert.equal(target.body.custom_output_fields,'name|url|avatar');
 const callback=new URL(target.url.searchParams.get('endpoint')).pathname;const payload=[{url:target.body.input[0].url,name:'Example',avatar:photo}];
 assert.equal((await f.call(callback,payload)).status,401);
 assert.equal((await f.call(callback,payload,{authorization:target.url.searchParams.get('auth_header')})).status,200);await f.settle();assert.equal(submits.length,4);
 const done=(await f.call(callback.replace('/callback',''))).data;assert.equal(done.status,'successful');assert.equal(done.result.avatarUrl,photo);assert.ok(done.timings.retrievalMs>=0);assert.ok(done.timings.scrapingMs>=0);
 const cached=await f.call('/api/jobs',{urls:[payload[0].url]});assert.equal(cached.status,200);assert.equal(cached.data.jobs[0].cacheHit,true);await f.settle();assert.equal(submits.length,4);assert.equal(f.objects.size,0);
 assert.equal((await f.call(`/api/jobs/${done.id}/metrics`,{imageLoadMs:123})).status,200);assert.equal((await f.call(`/api/jobs/${done.id}/metrics`,{imageLoadMs:-1})).status,400);
 assert.equal((await f.call(callback,payload,{authorization:target.url.searchParams.get('auth_header')})).status,200);await f.settle();assert.equal(submits.length,4);
});
test('cached external photo can be stored with permission without another provider call',async()=>{
 const f=fixture();const url='https://www.linkedin.com/in/example/';const ck=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('test-key\n'+url))).toString('hex');
 f.sql.prepare('INSERT INTO avatar_cache VALUES(?,?,?)').run(ck,JSON.stringify({data:{name:'Example',profileUrl:url,avatarUrl:photo}}),Date.now()+100000);
 let downloads=0;globalThis.fetch=async u=>{assert.equal(u,photo);downloads++;return new Response(new Uint8Array([255,216,255,0]));};
 const result=await f.call('/api/jobs',{urls:[url],storeImages:true});await f.settle();const done=(await f.call('/api/jobs/'+result.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'successful');assert.match(done.result.avatarUrl,/^\/api\/images\/[a-f0-9]{64}$/);assert.equal(downloads,1);assert.equal(f.objects.size,1);
 const cached=await f.call('/api/jobs',{urls:[url],storeImages:true});await f.settle();assert.equal(cached.status,200);assert.equal(downloads,1);
 const response=await handleAvatarJobs(new Request('https://example.test'+done.result.avatarUrl),f.env,{waitUntil(){}});assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');
});
test('transient submission retries; permanent errors and stale jobs fail clearly',async()=>{
 const f=fixture();let attempts=0;globalThis.fetch=async()=>++attempts===1?new Response('',{status:503}):Response.json({snapshot_id:'sd_retry'});
 const result=await f.call('/api/jobs',{urls:['https://linkedin.com/in/retry/']});await f.settle();assert.equal(attempts,2);
 f.sql.prepare('UPDATE avatar_jobs SET created_at=?').run(Date.now()-21*60*1000);await f.call('/api/jobs/'+result.data.jobs[0].id);await f.settle();assert.equal(f.sql.prepare('SELECT status FROM avatar_jobs').get().status,'failed');
 globalThis.fetch=async()=>new Response('',{status:402});const next=await f.call('/api/jobs',{urls:['https://linkedin.com/in/no-credits/']});await f.settle();const failed=(await f.call('/api/jobs/'+next.data.jobs[0].id)).data;await f.settle();assert.equal(failed.status,'failed');assert.match(failed.error,/credits/);
});
test('invalid input rejected before provider; ambiguous POST timeout not retried',async()=>{
 const f=fixture();let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('timeout');};
 assert.equal((await f.call('/api/jobs',{urls:['https://example.com']})).status,400);assert.equal(calls,0);
 const r=await f.call('/api/jobs',{urls:['https://linkedin.com/in/timeout/']});await f.settle();assert.equal(calls,1);const done=(await f.call('/api/jobs/'+r.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/outcome is unknown/);
});
