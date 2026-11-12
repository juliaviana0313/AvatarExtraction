import {sameProfile,isAvatar} from './avatar';
import {backoff,retryableStatus} from './job-policy';
export function parseApishProfile(data:unknown,profileUrl:string){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('API.sh returned an invalid response.');
  const r=data as Record<string,unknown>;
  if(r.error||r.success===false)throw new Error('API.sh could not retrieve this profile. Check the URL or try another provider.');
  if(typeof r.url!=='string'||!sameProfile(r.url,profileUrl))throw new Error('API.sh returned a different profile. Please retry.');
  if(typeof r.image!=='string'||!isAvatar(r.image))throw new Error('API.sh found no usable profile photo for this person.');
  return {name:typeof r.name==='string'&&r.name.trim()?r.name:'LinkedIn profile',avatarUrl:r.image,profileUrl};
}
export async function resolveApish(profileUrl:string,key:string){
  if(!key)throw new Error('API.sh is not configured. Add APISH_API_KEY.');
  const url=new URL('https://api.api.sh/linkedin/v1/profile');url.searchParams.set('url',profileUrl);
  const started=Date.now(),deadline=started+8000;
  for(let attempt=0;;attempt++){
    if(Date.now()>=deadline)throw new Error('API.sh timed out. Please retry later.');
    let response:Response;
    try{response=await fetch(url.href,{method:'GET',redirect:'manual',headers:{'x-api-key':key,Accept:'application/json'},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});}
    catch{if(attempt>=2||Date.now()>=deadline)throw new Error('API.sh did not respond. Please retry later.');await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
    if(!response.ok){await response.body?.cancel();
      if(retryableStatus(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,backoff(attempt)));continue;}
      throw new Error([401,403].includes(response.status)?'API.sh rejected the API key or endpoint access.':response.status===402?'API.sh needs account credits.':response.status===429?'API.sh is busy. Please retry shortly.':response.status===422?'API.sh could not process this profile. Check the URL or try another provider.':response.status===404?'API.sh could not find this profile.':`API.sh request failed (HTTP ${response.status}). Please retry.`);
    }
    const retrievalStarted=Date.now();let data:unknown;
    try{data=await response.json();}catch{throw new Error('API.sh returned an invalid response.');}
    return {data,submissionMs:retrievalStarted-started,retrievalStarted};
  }
}
