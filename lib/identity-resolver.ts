import {sameProfile,isAvatar} from './avatar';
import {backoff,retryableStatus} from './job-policy';
export type LookupProvider='brightdata'|'identity-resolver'|'apify'|'apish';
export const providerLabel=(provider:LookupProvider)=>provider==='apish'?'API.sh':provider==='apify'?'Apify':provider==='identity-resolver'?'Identity Resolver':'Bright Data';
export function isResolverPhoto(value:string):boolean {
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&((u.hostname==='ai.mihajlo.mk'&&u.pathname.startsWith('/storage/identity-resolver/linkedin/'))||isAvatar(value));}catch{return false;}
}
export function identityFailureMessage(data:unknown,status:number):string {
  const record=data&&typeof data==='object'?data as Record<string,unknown>:{};
  const error=record.error&&typeof record.error==='object'?record.error as Record<string,unknown>:{};
  if(error.code==='profile_not_resolved'){
    const upstream=record.last_status_code;
    const prefix='Identity Resolver: profile_not_resolved. ';
    if(upstream===999||upstream===401||upstream===403)return prefix+`LinkedIn denied the provider’s request (upstream HTTP ${upstream}). Try another provider.`;
    if(upstream===429)return prefix+'LinkedIn rate-limited the provider (upstream HTTP 429). Wait before retrying or choose another provider.';
    if(upstream===404)return prefix+'LinkedIn returned HTTP 404 to the provider. Check the profile URL.';
    if(upstream===200)return prefix+'LinkedIn returned HTTP 200, but the provider could not extract both name and picture. It did not identify which field was missing. Try another provider.';
    return prefix+'The provider could not extract both name and picture. The response does not establish photo visibility. Try another provider.';
  }
  if(status===429)return 'Identity Resolver is busy (HTTP 429). Please retry later.';
  if(status===404)return 'Identity Resolver could not find this profile (HTTP 404). Check the URL.';
  if(status===422)return 'Identity Resolver could not process this profile (HTTP 422); no specific reason was supplied. Check the URL or try another provider.';
  return `Identity Resolver request failed (HTTP ${status}). Please retry later.`;
}
export function parseIdentityProfile(data:unknown,profileUrl:string){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Identity Resolver returned an invalid response.');
  const record=data as Record<string,unknown>;
  if(record.ok!==true)throw new Error(identityFailureMessage(data,200));
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
      let detail:unknown;try{detail=await response.json();}catch{detail=null;}
      if(retryableStatus(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
      throw new Error(identityFailureMessage(detail,response.status));
    }
    const retrievalStarted=Date.now();
    let data:unknown;
    try{data=await response.json();}catch{throw new Error('Identity Resolver returned an invalid response.');}
    return {data,submissionMs:retrievalStarted-started,retrievalStarted};
  }
}
