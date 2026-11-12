import {normalizeProfile,isAvatar} from './avatar';
import {backoff,retryableStatus} from './job-policy';
export const APIFY_ACTOR='true-data~linkedin-profile-scraper';
export const apifyId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9]{1,80}$/.test(value);
export function parseApifyProfile(data:unknown,profileUrl:string){
  if(!Array.isArray(data)||data.length!==1||!data[0]||typeof data[0]!=='object')throw new Error('Apify returned no unique profile result. Check the URL or retry.');
  const r=data[0];
  if(r.error||r.error_code)throw new Error('Apify could not retrieve this profile. Check the URL or retry.');
  const returned=r.inputUrl??r.url;
  if(typeof returned!=='string'||normalizeProfile(returned)!==profileUrl)throw new Error('Apify returned a different profile. Please retry.');
  if(r.default_avatar===true||typeof r.avatar!=='string'||!isAvatar(r.avatar))throw new Error('Apify found no usable profile photo for this person.');
  return {name:typeof r.name==='string'&&r.name.trim()?r.name:'LinkedIn profile',avatarUrl:r.avatar,profileUrl};
}
export async function apifyRequest(path:string,key:string,body?:unknown):Promise<any>{
  if(!key)throw new Error('Apify is not configured. Add APIFY_API_KEY.');
  const deadline=Date.now()+8000;
  for(let attempt=0;;attempt++){
    if(Date.now()>=deadline)throw new Error('Apify timed out. Please retry later.');
    let response:Response;
    try{response=await fetch('https://api.apify.com/v2'+path,{method:body?'POST':'GET',redirect:'manual',headers:{Authorization:`Bearer ${key}`,Accept:'application/json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});}
    catch{if(body)throw new Error('Apify submission timed out; its outcome is unknown. Retry later.');if(attempt>=2)throw new Error('Apify did not respond. Please retry later.');await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
    if(!response.ok){await response.body?.cancel();if(attempt<2&&(body?response.status===429:retryableStatus(response.status))){await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
      throw new Error([401,403].includes(response.status)?'Apify rejected the API key or actor access.':response.status===402?'Apify needs account credits.':response.status===429?'Apify is busy. Please retry shortly.':`Apify request failed (HTTP ${response.status}). Please retry.`);
    }
    try{return await response.json();}catch{throw new Error('Apify returned an invalid response.');}
  }
}
