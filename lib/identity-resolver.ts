import {sameProfile,isAvatar} from './avatar';
import {backoff,retryableStatus} from './job-policy';
export type LookupProvider='brightdata'|'identity-resolver'|'apify'|'apish';
export const providerLabel=(provider:LookupProvider)=>provider==='apish'?'API.sh':provider==='apify'?'Apify':provider==='identity-resolver'?'Identity Resolver':'Bright Data';
export function isResolverPhoto(value:string):boolean {
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&((u.hostname==='ai.mihajlo.mk'&&u.pathname.startsWith('/storage/identity-resolver/linkedin/'))||isAvatar(value));}catch{return false;}
}
export function parseIdentityProfile(data:unknown,profileUrl:string){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Identity Resolver returned an invalid response.');
  const record=data as Record<string,unknown>;
  if(record.ok!==true)throw new Error('Identity Resolver could not retrieve this profile. Check the URL or retry.');
  if(record.platform!=='linkedin'||typeof record.profile_url!=='string'||!sameProfile(record.profile_url,profileUrl))throw new Error('Identity Resolver returned a different profile. Please retry.');
  const avatar=[record.avatar,record.picture].find(v=>typeof v==='string'&&isResolverPhoto(v));
  if(typeof avatar!=='string')throw new Error('Identity Resolver found no usable profile photo for this person.');
  return {name:typeof record.name==='string'&&record.name.trim()?record.name:'LinkedIn profile',avatarUrl:avatar,profileUrl};
}
export async function resolveIdentity(profileUrl:string){
  const url=new URL('https://ai.mihajlo.mk/api/identity-resolver/v1/resolve');
  url.search=new URLSearchParams({platform:'linkedin',url:profileUrl}).toString();
  const started=Date.now(),deadline=started+8000;
  for(let attempt=0;;attempt++){
    if(Date.now()>=deadline)throw new Error('Identity Resolver timed out. Please retry.');
    let response:Response;
    try{response=await fetch(url.href,{method:'GET',redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});}
    catch{if(attempt>=2||Date.now()>=deadline)throw new Error('Identity Resolver did not respond. Please retry.');await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
    if(!response.ok){
      await response.body?.cancel();
      if(retryableStatus(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
      throw new Error(response.status===429?'Identity Resolver is busy. Please retry shortly.':response.status===404?'Identity Resolver could not find this profile.':`Identity Resolver request failed (HTTP ${response.status}). Please retry.`);
    }
    const retrievalStarted=Date.now();
    let data:unknown;
    try{data=await response.json();}catch{throw new Error('Identity Resolver returned an invalid response.');}
    return {data,submissionMs:retrievalStarted-started,retrievalStarted};
  }
}
