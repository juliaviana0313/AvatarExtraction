import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
const outfile='/tmp/avatar-jobs-test.mjs';
await build({entryPoints:['lib/avatar-jobs.ts'],bundle:true,platform:'node',format:'esm',outfile});
const {handleAvatarJobs}=await import(outfile);
const photo='https://media.licdn.com/profile-displayphoto/test.jpg';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));
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
 f.sql.prepare('UPDATE avatar_jobs SET submitted_at=?').run(Date.now()-21*60*1000);await f.call('/api/jobs/'+result.data.jobs[0].id);await f.settle();assert.equal(f.sql.prepare('SELECT status FROM avatar_jobs').get().status,'failed');
 globalThis.fetch=async()=>new Response('',{status:402});const next=await f.call('/api/jobs',{urls:['https://linkedin.com/in/no-credits/']});await f.settle();const failed=(await f.call('/api/jobs/'+next.data.jobs[0].id)).data;await f.settle();assert.equal(failed.status,'failed');assert.match(failed.error,/credits/);
});
test('invalid input rejected before provider; ambiguous POST timeout not retried',async()=>{
 const f=fixture();let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('timeout');};
 assert.equal((await f.call('/api/jobs',{urls:['https://example.com']})).status,400);assert.equal(calls,0);
 const r=await f.call('/api/jobs',{urls:['https://linkedin.com/in/timeout/']});await f.settle();assert.equal(calls,1);const done=(await f.call('/api/jobs/'+r.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/outcome is unknown/);
});

test('Identity Resolver uses GET without credentials and isolates cache/history from Bright Data',async()=>{
 const f=fixture();const url='https://www.linkedin.com/in/example/';const resolverPhoto='https://ai.mihajlo.mk/storage/identity-resolver/linkedin/ac/example/profile-picture.jpg';
 let resolverCalls=0,brightCalls=0;
 globalThis.fetch=async(u,options)=>{
  const target=new URL(u);
  if(target.hostname==='ai.mihajlo.mk'){
   resolverCalls++;assert.equal(target.pathname,'/api/identity-resolver/v1/resolve');assert.equal(target.searchParams.get('platform'),'linkedin');assert.equal(target.searchParams.get('url'),url);assert.equal(options.method,'GET');assert.equal(options.headers.Accept,'application/json');assert.equal(options.headers.Authorization,undefined);
   return Response.json({ok:true,platform:'linkedin',profile_url:url,name:'Example',avatar:resolverPhoto});
  }
  assert.equal(target.hostname,'api.brightdata.com');brightCalls++;return Response.json({snapshot_id:'sd_bright'});
 };
 const created=await f.call('/api/jobs',{urls:[url],provider:'identity-resolver'});assert.equal(created.status,202);await f.settle();
 const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.provider,'identity-resolver');assert.equal(done.status,'successful');assert.equal(done.result.avatarUrl,resolverPhoto);assert.equal(brightCalls,0);
 const cached=await f.call('/api/jobs',{urls:[url],provider:'identity-resolver'});await f.settle();assert.equal(cached.data.jobs[0].cacheHit,true);assert.equal(resolverCalls,1);
 const bright=await f.call('/api/jobs',{urls:[url],provider:'brightdata'});await f.settle();assert.equal(bright.data.jobs[0].cacheHit,false);assert.equal(bright.data.jobs[0].provider,'brightdata');assert.equal(brightCalls,1);assert.equal(resolverCalls,1);
 assert.equal((await f.call('/api/jobs/'+done.id+'/callback',{ok:true})).status,404);
});
test('Identity Resolver works without Bright Data key and stores permitted images',async()=>{
 const f=fixture();delete f.env.BRIGHTDATA_API_KEY;
 const url='https://www.linkedin.com/in/example/';const image='https://ai.mihajlo.mk/storage/identity-resolver/linkedin/ac/example/profile-picture.jpg';
 globalThis.fetch=async u=>String(u).includes('/resolve?')?Response.json({ok:true,platform:'linkedin',profile_url:'https://mg.linkedin.com/in/example',name:'Example',picture:image}):new Response(new Uint8Array([255,216,255,0]));
 const created=await f.call('/api/jobs',{urls:[url],provider:'identity-resolver',storeImages:true});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'successful');assert.match(done.result.avatarUrl,/^\/api\/images\//);assert.equal(f.objects.size,1);
});
test('Identity Resolver rejects missing photos, mismatched profiles, unsafe URLs and invalid providers',async()=>{
 for(const record of [{ok:false},{ok:true,platform:'linkedin',profile_url:'https://linkedin.com/in/other/',avatar:photo},{ok:true,platform:'linkedin',profile_url:'https://linkedin.com/in/example/',avatar:null},{ok:true,platform:'linkedin',profile_url:'https://linkedin.com/in/example/',avatar:'http://127.0.0.1/internal'}]){
  const f=fixture();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(record);};
  assert.equal((await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'invalid'})).status,400);assert.equal(calls,0);
  const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'identity-resolver',storeImages:true});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/Identity Resolver/);assert.equal(calls,1);assert.equal(f.objects.size,0);
 }
});
test('Identity Resolver retries transient errors without falling back to Bright Data',async()=>{
 const f=fixture();let calls=0;
 globalThis.fetch=async u=>{assert.equal(new URL(u).hostname,'ai.mihajlo.mk');return ++calls===1?new Response('',{status:503}):Response.json({ok:true,platform:'linkedin',profile_url:'https://linkedin.com/in/example/',avatar:photo});};
 const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'identity-resolver'});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'successful');assert.equal(calls,2);
});

test('300-profile batch keeps all jobs, limits concurrency, bulk polls, and does not expire queued work',async()=>{
 const f=fixture();let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({snapshot_id:'sd_batch'+calls});};
 const urls=Array.from({length:300},(_,i)=>`https://linkedin.com/in/batch-${i}/`);
 assert.equal((await f.call('/api/jobs',{urls:[...urls,'https://linkedin.com/in/too-many/']})).status,400);assert.equal(calls,0);
 const result=await f.call('/api/jobs',{urls});assert.equal(result.status,202);assert.equal(result.data.jobs.length,300);await f.settle();assert.equal(calls,3);
 const ids=result.data.jobs.map(j=>j.id);
 const statuses=await f.call('/api/jobs/status',{ids});await f.settle();assert.equal(statuses.data.jobs.length,300);assert.equal(statuses.data.jobs.filter(j=>j.phase==='queued').length,297);
 f.sql.prepare("UPDATE avatar_jobs SET created_at=? WHERE status='queued'").run(Date.now()-21*60*1000);
 await f.call('/api/jobs/status',{ids});await f.settle();assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM avatar_jobs WHERE status='queued'").get().n,297);
 assert.equal((await f.call('/api/jobs/status',{ids:['invalid']})).status,400);
});
test('all 300 Identity Resolver jobs finish without dropping results',async()=>{
 const f=fixture();let active=0,peak=0,calls=0;
 globalThis.fetch=async u=>{active++;peak=Math.max(peak,active);calls++;await new Promise(r=>setTimeout(r,1));active--;return Response.json({ok:true,platform:'linkedin',profile_url:new URL(u).searchParams.get('url'),avatar:photo});};
 const urls=Array.from({length:300},(_,i)=>`https://linkedin.com/in/identity-batch-${i}/`);
 const result=await f.call('/api/jobs',{urls,provider:'identity-resolver'});await f.settle();
 const statuses=await f.call('/api/jobs/status',{ids:result.data.jobs.map(j=>j.id)});await f.settle();assert.equal(statuses.data.jobs.length,300);assert.ok(statuses.data.jobs.every(j=>j.status==='successful'));assert.equal(calls,300);assert.ok(peak<=3);
});

test('Apify async submission, signed callback, selected fields, cache and provider isolation',async()=>{
 const f=fixture();f.env.APIFY_API_KEY='apify-test';delete f.env.BRIGHTDATA_API_KEY;
 const url='https://www.linkedin.com/in/apify-example/';let submissions=0,webhook;
 globalThis.fetch=async(u,options)=>{
  const target=new URL(u);assert.equal(target.hostname,'api.apify.com');assert.equal(options.headers.Authorization,'Bearer apify-test');
  if(target.pathname.endsWith('/runs')){submissions++;assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{profileUrls:[url],maxProfiles:1});webhook=JSON.parse(Buffer.from(target.searchParams.get('webhooks'),'base64').toString())[0];return Response.json({data:{id:'testRun123'}});}
  if(target.pathname==='/v2/actor-runs/testRun123')return Response.json({data:{id:'testRun123',status:'SUCCEEDED',defaultDatasetId:'testData123'}});
  assert.equal(target.pathname,'/v2/datasets/testData123/items');assert.match(target.searchParams.get('fields'),/avatar/);return Response.json([{name:'Example',inputUrl:url,avatar:photo}]);
 };
 const created=await f.call('/api/jobs',{urls:[url],provider:'apify'});await f.settle();assert.equal(created.data.jobs[0].provider,'apify');assert.equal(submissions,1);
 const path=new URL(webhook.requestUrl).pathname;const auth=JSON.parse(webhook.headersTemplate);
 assert.equal((await f.call(path,{resource:{id:'testRun123'}})).status,401);
 assert.equal((await f.call(path,{resource:{id:'other'}},auth)).status,400);
 assert.equal((await f.call(path,{resource:{id:'testRun123'}},auth)).status,200);await f.settle();
 const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'successful');assert.equal(done.provider,'apify');assert.equal(done.result.avatarUrl,photo);
 const cached=await f.call('/api/jobs',{urls:[url],provider:'apify'});await f.settle();assert.equal(cached.data.jobs[0].cacheHit,true);assert.equal(submissions,1);
 assert.equal((await f.call(path,{resource:{id:'testRun123'}},auth)).status,200);await f.settle();
 const other=await f.call('/api/jobs',{urls:[url],provider:'brightdata'});await f.settle();assert.equal(other.data.jobs[0].cacheHit,false);
});
test('Apify progress polling completes without webhook; failed runs and missing photos are clear',async()=>{
 for(const scenario of ['SUCCEEDED','FAILED','TIMED-OUT','ABORTED','no-photo','wrong-profile']){
  const f=fixture();f.env.APIFY_API_KEY='apify-test';
  globalThis.fetch=async u=>{
   const path=new URL(u).pathname;
   if(path.endsWith('/runs'))return Response.json({data:{id:'testRun'}});
   if(path.includes('/actor-runs/'))return Response.json({data:{id:'testRun',status:['no-photo','wrong-profile'].includes(scenario)?'SUCCEEDED':scenario,defaultDatasetId:'testDataset'}});
   return Response.json([{inputUrl:'https://www.linkedin.com/in/'+(scenario==='wrong-profile'?'other':'example')+'/',avatar:scenario==='no-photo'?null:photo}]);
  };
  const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'apify'});await f.settle();f.sql.prepare('UPDATE avatar_jobs SET next_check=0').run();await f.call('/api/jobs/'+created.data.jobs[0].id);await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,scenario==='SUCCEEDED'?'successful':'failed');if(done.error)assert.match(done.error,/Apify/);
 }
});
test('Apify credentials and submission failures never fall back to another provider',async()=>{
 for(const status of [401,402,'timeout']){
  const f=fixture();f.env.APIFY_API_KEY='apify-test';let calls=0;
  globalThis.fetch=async u=>{calls++;assert.equal(new URL(u).hostname,'api.apify.com');if(status==='timeout')throw Error('timeout');return new Response('',{status});};
  const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'apify'});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/Apify/);assert.equal(calls,1);
 }
});

test('API.sh uses x-api-key GET, parses image, caches independently and stores permitted photos',async()=>{
 const f=fixture();f.env.APISH_API_KEY='apish-test';delete f.env.BRIGHTDATA_API_KEY;
 const url='https://www.linkedin.com/in/example/';let apiCalls=0;
 globalThis.fetch=async(u,options)=>{
  if(u===photo)return new Response(new Uint8Array([255,216,255,0]));
  const target=new URL(u);assert.equal(target.origin,'https://api.api.sh');assert.equal(target.pathname,'/linkedin/v1/profile');assert.equal(target.searchParams.get('url'),url);assert.equal(options.method,'GET');assert.equal(options.headers['x-api-key'],'apish-test');assert.equal(options.headers.Authorization,undefined);apiCalls++;
  return Response.json({name:'Example',url:url.replace(/\/$/,''),image:photo,description:'must not persist'});
 };
 const created=await f.call('/api/jobs',{urls:[url],provider:'apish',storeImages:true});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.provider,'apish');assert.equal(done.status,'successful');assert.match(done.result.avatarUrl,/^\/api\/images\//);assert.deepEqual(Object.keys(done.result).sort(),['avatarUrl','name','profileUrl']);
 const cached=await f.call('/api/jobs',{urls:[url],provider:'apish'});await f.settle();assert.equal(cached.data.jobs[0].cacheHit,true);assert.equal(apiCalls,1);
 const other=await f.call('/api/jobs',{urls:[url],provider:'apify'});await f.settle();assert.equal(other.data.jobs[0].cacheHit,false);assert.equal(apiCalls,1);
 assert.equal((await f.call('/api/jobs/'+done.id+'/callback',{status:'ready'})).status,404);
});
test('API.sh rejects mismatches and missing photos, and surfaces account errors',async()=>{
 for(const payload of [{url:'https://linkedin.com/in/other/',image:photo},{url:'https://linkedin.com/in/example/',image:null},{url:'https://linkedin.com/in/example/',image:'http://127.0.0.1/private'},{error:'failed'}]){
  const f=fixture();f.env.APISH_API_KEY='apish-test';globalThis.fetch=async()=>Response.json(payload);
  const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'apish'});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/API.sh/);
 }
 for(const status of [401,402,422]){
  const f=fixture();f.env.APISH_API_KEY='apish-test';let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status});};
  const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'apish'});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'failed');assert.match(done.error,/API.sh/);assert.equal(calls,1);
 }
});
test('API.sh transient errors retry only its own endpoint',async()=>{
 const f=fixture();f.env.APISH_API_KEY='apish-test';let calls=0;
 globalThis.fetch=async u=>{assert.equal(new URL(u).hostname,'api.api.sh');return ++calls===1?new Response('',{status:503}):Response.json({name:'Example',url:'https://linkedin.com/in/example/',image:photo});};
 const created=await f.call('/api/jobs',{urls:['https://linkedin.com/in/example/'],provider:'apish'});await f.settle();const done=(await f.call('/api/jobs/'+created.data.jobs[0].id)).data;await f.settle();assert.equal(done.status,'successful');assert.equal(calls,2);
});
