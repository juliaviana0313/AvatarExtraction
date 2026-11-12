import {parseApishProfile,resolveApish} from './apish';
import {APIFY_ACTOR,apifyId,apifyRequest,parseApifyProfile} from './apify';
import {type LookupProvider,parseIdentityProfile,resolveIdentity,isResolverPhoto} from './identity-resolver';
import {normalizeProfile,parseBrightProfile,isAvatar} from './avatar';
import {MAX_ACTIVE,MAX_BATCH,JOB_TIMEOUT,OUTPUT_FIELDS,isTerminal,retryableStatus,backoff,imageType,boundedMap} from './job-policy';
interface Env {DB?:D1Database;BUCKET?:R2Bucket;BRIGHTDATA_API_KEY?:string;APIFY_API_KEY?:string;APISH_API_KEY?:string}
type Ctx={waitUntil(promise:Promise<unknown>):void};
type Row={provider:LookupProvider;id:string;cache_key:string;active_key:string|null;profile_url:string;origin:string;status:string;storage_allowed:number;snapshot:string|null;result:string|null;error:string|null;created_at:number;submitted_at:number|null;ready_at:number|null;completed_at:number|null;next_check:number;lease_until:number;attempts:number;submission_ms:number|null;scraping_ms:number|null;retrieval_ms:number|null;storage_ms:number|null;image_load_ms:number|null;cache_hit:number};
const base='https://api.brightdata.com/datasets/v3';
const dataset='gd_l1viktl72bvl7bjuj0';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const db=(env:Env)=>{if(!env.DB)throw new Error('Job database unavailable.');return env.DB;};
const key=(env:Env)=>env.BRIGHTDATA_API_KEY||process.env.BRIGHTDATA_API_KEY||'';
const apifyKey=(env:Env)=>env.APIFY_API_KEY||process.env.APIFY_API_KEY||'';
const apishKey=(env:Env)=>env.APISH_API_KEY||process.env.APISH_API_KEY||'';
const enc=new TextEncoder();
const hex=(data:ArrayBuffer)=>Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('');
async function cacheKey(url:string,env:Env,selected:LookupProvider){return hex(await crypto.subtle.digest('SHA-256',enc.encode((selected==='brightdata'?key(env):selected==='apish'?'apish:v1:'+apishKey(env):selected==='apify'?'apify:'+APIFY_ACTOR+':'+apifyKey(env):'identity-resolver:v1')+'\n'+url)));}
async function callbackKey(id:string,env:Env,selected:LookupProvider='brightdata'){const k=await crypto.subtle.importKey('raw',enc.encode(selected==='apify'?apifyKey(env):key(env)),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode('avatar-callback:'+id)));}
async function row(id:string,env:Env){return db(env).prepare('SELECT * FROM avatar_jobs WHERE id=?').bind(id).first<Row>();}
function view(r:Row){return {id:r.id,provider:r.provider,profileUrl:r.profile_url,status:isTerminal(r.status)?r.status:'pending',phase:r.status,error:r.error,result:r.result?JSON.parse(r.result):null,cacheHit:!!r.cache_hit,timings:{queueMs:r.submitted_at?r.submitted_at-r.created_at:null,submissionMs:r.submission_ms,scrapingMs:r.scraping_ms,retrievalMs:r.retrieval_ms,storageMs:r.storage_ms,imageLoadMs:r.image_load_ms,totalMs:r.completed_at?r.completed_at-r.created_at:null}};}
async function fail(id:string,message:string,env:Env){await db(env).prepare("UPDATE avatar_jobs SET status='failed',error=?,completed_at=?,active_key=NULL,lease_until=0 WHERE id=? AND status NOT IN ('successful','failed')").bind(message,Date.now(),id).run();console.warn(JSON.stringify({event:'avatar_job_failed',id,error:message}));}
class ProviderError extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status;}}
async function provider(path:string,env:Env,body?:unknown,retry=true):Promise<unknown>{
  if(!key(env))throw new Error('The profile provider is not configured.');
  const deadline=Date.now()+(body?8000:6000);
  for(let attempt=0;;attempt++){
    if(Date.now()>=deadline)throw new Error('The provider did not respond in time.');
    let response:Response;
    try{response=await fetch(base+path,{method:body?'POST':'GET',redirect:'manual',headers:{Authorization:`Bearer ${key(env)}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});}catch{
      // A timed-out POST may already have created a charged job; never submit it twice automatically.
      if(body||!retry||attempt>=2)throw new Error(body?'Submission timed out; its outcome is unknown. Retry later.':'The provider did not respond in time.');
      await new Promise(r=>setTimeout(r,backoff(attempt)));continue;
    }
    const text=await response.text();
    if(!response.ok){
      if(retry&&retryableStatus(response.status)&&attempt<2&&(!body||response.status===429||response.status===503)){await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
      const message=/not active|suspended/i.test(text)?'The Bright Data account is inactive.':response.status===402?'The provider account needs credits.':[401,403].includes(response.status)?'The provider rejected the account credentials.':response.status===429?'The provider is busy. Try again shortly.':'The provider request failed. Please retry.';
      throw new ProviderError(response.status,message);
    }
    try{return JSON.parse(text);}catch{throw new Error('The provider returned an invalid response.');}
  }
}
async function storePhoto(r:Row,source:string,env:Env):Promise<string>{
  if(!r.storage_allowed||!env.BUCKET)return source;
  if(!(r.provider==='identity-resolver'?isResolverPhoto(source):isAvatar(source)))throw new Error('Invalid photo source.');
  const started=Date.now();
  try{
    const response=await fetch(source,{redirect:'manual',signal:AbortSignal.timeout(5000)});
    if(!response.ok||Number(response.headers.get('content-length')||0)>2_000_000)throw new Error('Image unavailable.');
    const reader=response.body?.getReader();if(!reader)throw new Error();
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>2_000_000)throw new Error();chunks.push(value.value);}}finally{await reader.cancel();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const type=imageType(bytes);if(!type)throw new Error('Unsupported image format.');
    const objectKey='avatars/'+hex(await crypto.subtle.digest('SHA-256',bytes));
    await env.BUCKET.put(objectKey,bytes,{httpMetadata:{contentType:type,cacheControl:'public, max-age=86400'},customMetadata:{permission:'requester-confirmed',storedAt:String(Date.now())}});
    return '/api/images/'+objectKey.split('/')[1];
  }catch{console.warn(JSON.stringify({event:'avatar_storage_fallback',id:r.id}));return source;}
  finally{await db(env).prepare('UPDATE avatar_jobs SET storage_ms=? WHERE id=?').bind(Date.now()-started,r.id).run();}
}
async function finish(r:Row,data:unknown,env:Env,retrievalStarted:number){
  try{
    const photo=r.cache_hit&&r.result?JSON.parse(r.result):r.provider==='identity-resolver'?parseIdentityProfile(data,r.profile_url):r.provider==='apish'?parseApishProfile(data,r.profile_url):r.provider==='apify'?parseApifyProfile(data,r.profile_url):parseBrightProfile(data,r.profile_url);
    const retrievalMs=Date.now()-retrievalStarted;
    photo.avatarUrl=await storePhoto(r,photo.avatarUrl,env);
    let expires=Date.now()+86400000;
    if(photo.avatarUrl.startsWith('https:')){const e=Number(new URL(photo.avatarUrl).searchParams.get('e'))*1000;if(e)expires=Math.min(expires,e-60000);}
    const payload=JSON.stringify({data:photo,expires,checked:Date.now()});
    const completed=Date.now();
    await db(env).batch([
      db(env).prepare('INSERT INTO avatar_cache(key,payload,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires=excluded.expires').bind(r.cache_key,payload,expires),
      db(env).prepare("UPDATE avatar_jobs SET status='successful',result=?,error=NULL,active_key=NULL,completed_at=?,retrieval_ms=?,lease_until=0 WHERE id=?").bind(JSON.stringify(photo),completed,retrievalMs,r.id)
    ]);
    console.log(JSON.stringify({event:'avatar_job_complete',id:r.id,submissionMs:r.submission_ms,scrapingMs:r.scraping_ms,retrievalMs,totalMs:completed-r.created_at}));
  }catch(error){await fail(r.id,error instanceof Error?error.message:'Unable to retrieve the photo.',env);}
}
async function retrieve(r:Row,env:Env,data?:unknown,apifyDataset?:string){
  const claimed=await db(env).prepare("UPDATE avatar_jobs SET status='retrieving',lease_until=? WHERE id=? AND status IN ('running','submitting','retrieving') AND lease_until<? RETURNING *").bind(Date.now()+25000,r.id,Date.now()).first<Row>();
  if(!claimed)throw new Error('Retrieval is already in progress; retry callback.');
  const start=Date.now();
  const scrape=Math.max(0,start-(r.submitted_at||r.created_at));
  await db(env).prepare('UPDATE avatar_jobs SET ready_at=?,scraping_ms=? WHERE id=?').bind(start,scrape,r.id).run();claimed.scraping_ms=scrape;
  try{await finish(claimed,data??(r.provider==='apify'?await apifyRequest(`/datasets/${apifyDataset}/items?format=json&fields=name,inputUrl,url,avatar,default_avatar,error,error_code&limit=2`,apifyKey(env)):await provider(`/snapshot/${r.snapshot}?format=json`,env)),env,start);}catch(error){
    await db(env).prepare("UPDATE avatar_jobs SET status='running',lease_until=0,next_check=? WHERE id=? AND status='retrieving'").bind(Date.now()+5000,r.id).run();throw error;
  }
}
async function checkApify(r:Row,env:Env){
  if(!apifyId(r.snapshot))throw new Error('Apify run is not yet recorded; retry callback.');
  const response=await apifyRequest(`/actor-runs/${r.snapshot}`,apifyKey(env));const run=response?.data;
  if(!run||run.id!==r.snapshot)throw new Error('Apify returned an invalid run.');
  if(run.status==='SUCCEEDED'){
    if(!apifyId(run.defaultDatasetId))throw new Error('Apify returned an invalid dataset.');
    await retrieve(r,env,undefined,run.defaultDatasetId);
  }else if(['FAILED','TIMED-OUT','ABORTED'].includes(run.status))await fail(r.id,`Apify lookup ${run.status.toLowerCase()}. Please retry.`,env);
}
async function check(r:Row,env:Env){
  const claim=await db(env).prepare("UPDATE avatar_jobs SET next_check=? WHERE id=? AND status='running' AND next_check<=? RETURNING id").bind(Date.now()+5000,r.id,Date.now()).first();if(!claim||!r.snapshot)return;
  try{if(r.provider==='apify'){await checkApify(r,env);return;}const progress=await provider(`/progress/${r.snapshot}`,env) as {status:string};if(progress.status==='ready')await retrieve(r,env);else if(['failed','canceled'].includes(progress.status))await fail(r.id,'The provider could not retrieve this profile. Retry later.',env);}catch{console.warn(JSON.stringify({event:'avatar_progress_retry',id:r.id}));}
}
async function submit(r:Row,env:Env){
  const started=Date.now();
  try{
    if(r.cache_hit&&r.result){
      const photo=JSON.parse(r.result);
      await finish(r,[{name:photo.name,url:r.profile_url,avatar:photo.avatarUrl}],env,started);
      return;
    }
    if(r.provider==='identity-resolver'||r.provider==='apish'){
      const resolved=r.provider==='apish'?await resolveApish(r.profile_url,apishKey(env)):await resolveIdentity(r.profile_url);
      await db(env).prepare('UPDATE avatar_jobs SET submitted_at=?,submission_ms=? WHERE id=?').bind(started,resolved.submissionMs,r.id).run();
      r.submission_ms=resolved.submissionMs;
      await finish(r,resolved.data,env,resolved.retrievalStarted);
      return;
    }
    if(r.provider==='apify'){
      const webhook=[{eventTypes:['ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED','ACTOR.RUN.TIMED_OUT','ACTOR.RUN.ABORTED'],requestUrl:`${r.origin}/api/jobs/${r.id}/callback`,headersTemplate:JSON.stringify({Authorization:`Bearer ${await callbackKey(r.id,env,'apify')}`})}];
      const params=new URLSearchParams({timeout:'1200',webhooks:btoa(JSON.stringify(webhook))});
      const response=await apifyRequest(`/acts/${APIFY_ACTOR}/runs?${params}`,apifyKey(env),{profileUrls:[r.profile_url],maxProfiles:1});
      if(!apifyId(response?.data?.id))throw new Error('Apify returned an invalid run.');
      await db(env).prepare("UPDATE avatar_jobs SET status='running',snapshot=?,submission_ms=?,next_check=? WHERE id=? AND status='submitting'").bind(response.data.id,Date.now()-started,Date.now()+3000,r.id).run();
      return;
    }
    const params=new URLSearchParams({dataset_id:dataset,format:'json',include_errors:'true',custom_output_fields:OUTPUT_FIELDS,notify:'true',endpoint:`${r.origin}/api/jobs/${r.id}/callback`,auth_header:`Bearer ${await callbackKey(r.id,env)}`,uncompressed_webhook:'true'});
    const data=await provider('/trigger?'+params,env,{input:[{url:r.profile_url}],custom_output_fields:OUTPUT_FIELDS}) as {snapshot_id?:string};
    if(!data.snapshot_id||!/^s[d]?_[\w]+$/.test(data.snapshot_id))throw new Error('The provider returned an invalid job.');
    await db(env).prepare("UPDATE avatar_jobs SET status=CASE WHEN status='submitting' THEN 'running' ELSE status END,snapshot=?,submission_ms=?,submitted_at=?,next_check=?,lease_until=0 WHERE id=?").bind(data.snapshot_id,Date.now()-started,Date.now(),Date.now()+3000,r.id).run();
  }catch(error){await fail(r.id,error instanceof Error?error.message:'Submission failed.',env);}
}
async function drain(env:Env,deadline:number){
  await db(env).prepare("UPDATE avatar_jobs SET status='failed',error='Lookup timed out. Please retry.',active_key=NULL,completed_at=? WHERE status IN ('submitting','running','retrieving') AND submitted_at<?").bind(Date.now(),Date.now()-JOB_TIMEOUT).run();
  // Each claim is one atomic SQLite statement. All workers share the same global limit.
  do {
  const tasks:Promise<void>[]=[];
  for(let i=0;i<MAX_ACTIVE;i++){
    const claimed=await db(env).prepare("UPDATE avatar_jobs SET status='submitting',submitted_at=?,attempts=attempts+1,lease_until=0 WHERE id=(SELECT id FROM avatar_jobs WHERE status='queued' ORDER BY created_at LIMIT 1) AND (SELECT COUNT(*) FROM avatar_jobs WHERE status IN ('submitting','running','retrieving'))<? RETURNING *").bind(Date.now(),MAX_ACTIVE).first<Row>();
    if(!claimed)break;tasks.push(submit(claimed,env));
  }
  if(!tasks.length)break;
  await Promise.allSettled(tasks);
  } while(Date.now()<deadline);
}
async function service(env:Env){
  const deadline=Date.now()+12000;
  const active=await db(env).prepare("SELECT * FROM avatar_jobs WHERE status='running' AND next_check<=? ORDER BY next_check LIMIT 3").bind(Date.now()).all<Row>();
  await boundedMap(active.results,MAX_ACTIVE,r=>check(r,env));if(Date.now()<deadline)await drain(env,deadline);
}
function kick(ctx:Ctx,env:Env){ctx.waitUntil(service(env).catch(()=>console.warn('avatar_background_service_failed')));}
async function create(url:string,store:boolean,origin:string,env:Env,selected:LookupProvider){
  const profileUrl=normalizeProfile(url),id=crypto.randomUUID().replace(/-/g,''),ck=await cacheKey(profileUrl,env,selected),now=Date.now();
  const cached=await db(env).prepare('SELECT payload FROM avatar_cache WHERE key=? AND expires>?').bind(ck,now).first<{payload:string}>();
  const photo=cached?JSON.parse(cached.payload).data:null;
  if(photo?.avatarUrl&&(!store||photo.avatarUrl.startsWith('/api/images/'))){
    await db(env).prepare("INSERT INTO avatar_jobs(id,cache_key,profile_url,origin,status,storage_allowed,result,created_at,completed_at,cache_hit,provider) VALUES(?,?,?,?,'successful',?,?,?,?,1,?)").bind(id,ck,profileUrl,origin,store?1:0,JSON.stringify(photo),now,Date.now(),selected).run();
    return view((await row(id,env))!);
  }
  const activeKey=ck+':'+(store?'store':'link');
  await db(env).prepare("INSERT OR IGNORE INTO avatar_jobs(id,cache_key,active_key,profile_url,origin,status,storage_allowed,created_at,result,cache_hit,provider) VALUES(?,?,?,?,?,'queued',?,?,?,?,?)").bind(id,ck,activeKey,profileUrl,origin,store?1:0,now,photo?JSON.stringify(photo):null,photo?1:0,selected).run();
  const current=await db(env).prepare('SELECT * FROM avatar_jobs WHERE id=? OR active_key=? ORDER BY created_at DESC LIMIT 1').bind(id,activeKey).first<Row>();
  if(!current)return create(url,store,origin,env,selected);
  return view(current);

}
async function body(request:Request){if(Number(request.headers.get('content-length')||0)>1048576)throw new Error('Request too large.');const text=await request.text();if(text.length>1048576)throw new Error('Request too large.');return JSON.parse(text);}
export async function handleAvatarJobs(request:Request,env:Env,ctx:Ctx):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/jobs')&&!path.startsWith('/api/images/'))return null;
  try{
    if(path.startsWith('/api/images/')){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      const id=path.slice('/api/images/'.length);if(!/^[a-f0-9]{64}$/.test(id))return json({error:'Not found.'},404);
      const object=await env.BUCKET?.get('avatars/'+id);if(!object)return json({error:'Image not found.'},404);
      return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType||'image/jpeg','Cache-Control':'public, max-age=86400','ETag':object.httpEtag,'X-Content-Type-Options':'nosniff'}});
    }
    if(path==='/api/jobs/status'&&request.method==='POST'){
      const input=await body(request);
      if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>MAX_BATCH||input.ids.some((id:unknown)=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))return json({error:'Enter 1–300 valid job IDs.'},400);
      const ids=[...new Set(input.ids)] as string[];
      const groups:string[][]=[];for(let i=0;i<ids.length;i+=80)groups.push(ids.slice(i,i+80));
      const rows=await boundedMap(groups,3,async group=>(await db(env).prepare(`SELECT * FROM avatar_jobs WHERE id IN (${group.map(()=>'?').join(',')})`).bind(...group).all<Row>()).results);
      kick(ctx,env);return json({jobs:rows.flat().map(view)});
    }
    if(path==='/api/jobs'&&request.method==='POST'){
      const input=await body(request);const urls=input.urls??[input.url];if(!Array.isArray(urls)||!urls.length||urls.length>MAX_BATCH)return json({error:'Enter 1–300 LinkedIn profile URLs.'},400);
      const selected=input.provider??'brightdata';
      if(!['brightdata','identity-resolver','apify','apish'].includes(selected))return json({error:'Choose Bright Data, Identity Resolver, Apify, or API.sh.'},400);
      const normalized=[...new Set(urls.map(normalizeProfile))];
      const items=await boundedMap(normalized,3,u=>create(u,input.storeImages===true,url.origin,env,selected));kick(ctx,env);return json({jobs:items},items.some(j=>j.status==='pending')?202:200);
    }
    const match=path.match(/^\/api\/jobs\/([a-f0-9]{32})(?:\/(callback|metrics))?$/);if(!match)return json({error:'Not found.'},404);
    const r=await row(match[1],env);if(!r)return json({error:'Job not found.'},404);
    if(match[2]==='callback'&&request.method==='POST'){
      if(r.provider==='identity-resolver'||r.provider==='apish')return json({error:'Not found.'},404);
      if(request.headers.get('authorization')!==`Bearer ${await callbackKey(r.id,env,r.provider)}`)return json({error:'Unauthorized.'},401);
      if(isTerminal(r.status))return json({ok:true});
      const payload=await body(request);
      if(r.provider==='apify'){
        if(!r.snapshot)return json({error:'Submission is not yet recorded; retry callback.'},503);
        if(payload.resource?.id!==r.snapshot)return json({error:'Run mismatch.'},400);
        await checkApify(r,env);kick(ctx,env);return json({ok:true});
      }
      if(payload.snapshot_id&&r.snapshot&&payload.snapshot_id!==r.snapshot)return json({error:'Snapshot mismatch.'},400);
      if(Array.isArray(payload))await retrieve(r,env,payload);
      else if(payload.status==='failed')await fail(r.id,'The provider could not retrieve this profile.',env);
      else if(r.snapshot)await retrieve(r,env);
      else return json({error:'Submission is not yet recorded; retry callback.'},503);
      kick(ctx,env);return json({ok:true});
    }
    if(match[2]==='metrics'&&request.method==='POST'){
      const input=await body(request);if(r.status!=='successful'||!Number.isFinite(input.imageLoadMs)||input.imageLoadMs<0||input.imageLoadMs>120000)return json({error:'Invalid timing.'},400);
      await db(env).prepare('UPDATE avatar_jobs SET image_load_ms=? WHERE id=? AND image_load_ms IS NULL').bind(Math.round(input.imageLoadMs),r.id).run();console.log(JSON.stringify({event:'avatar_image_loaded',id:r.id,imageLoadMs:Math.round(input.imageLoadMs)}));return json({ok:true});
    }
    if(!match[2]&&request.method==='GET'){kick(ctx,env);return json(view(r));}
    return json({error:'Method not allowed.'},405);
  }catch(error){console.warn(JSON.stringify({event:'avatar_job_api_error',message:error instanceof Error?error.message.slice(0,180):'Unknown'}));return json({error:error instanceof Error&&/^(Enter|Use|Request)/.test(error.message)?error.message:'Unable to process this request. Please retry.'},path.endsWith('/callback')?503:400);}
}
