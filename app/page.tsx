'use client';
import {useState,useEffect,useRef} from 'react';
import {ScanFace,ArrowUpRight,ArrowRight,LoaderCircle,Copy,Check,UserRound,History,RotateCcw} from 'lucide-react';
type Profile={name:string;avatarUrl:string;profileUrl:string};
type Job={id:string;profileUrl:string;status:'pending'|'successful'|'failed';phase:string;result:Profile|null;error:string|null;cacheHit:boolean;timings:{submissionMs:number|null;scrapingMs:number|null;retrievalMs:number|null;imageLoadMs:number|null}};
const historyKey='avatar-jobs-v2';
function safeJob(value:unknown):value is Job {if(!value||typeof value!=='object')return false;const j=value as Job;return /^[a-f0-9]{32}$/.test(j.id)&&typeof j.profileUrl==='string'&&['pending','successful','failed'].includes(j.status);}
function safeImage(value:string){try{const u=new URL(value,window.location.origin);return u.origin===window.location.origin&&/^\/api\/images\/[a-f0-9]{64}$/.test(u.pathname)||u.protocol==='https:'&&u.hostname.endsWith('.licdn.com');}catch{return false;}}
async function api(path:string,body?:unknown){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const data=await r.json() as {jobs?:Job[];error?:string}&Job;if(!r.ok)throw new Error(data.error||'Request failed. Please retry.');return data;}
function AvatarImage({job,onFailure}:{job:Job;onFailure:()=>void}){
  const started=useRef(0);const sent=useRef(false);
  return <img className="avatar" src={job.result!.avatarUrl} alt={`${job.result!.name} profile photo`} referrerPolicy="no-referrer" ref={node=>{if(node&&!started.current)started.current=performance.now();}} onError={onFailure} onLoad={()=>{if(sent.current)return;sent.current=true;const duration=Math.max(0,performance.now()-started.current);void fetch(`/api/jobs/${job.id}/metrics`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageLoadMs:duration}),keepalive:true}).catch(()=>{});}}/>;
}
export default function Home(){
  const [input,setInput]=useState('');const [jobs,setJobs]=useState<Job[]>([]);const [selected,setSelected]=useState('');const [loaded,setLoaded]=useState(false);const [submitting,setSubmitting]=useState(false);const [storeImages,setStoreImages]=useState(false);const [error,setError]=useState('');const [copied,setCopied]=useState(false);const [imageError,setImageError]=useState(false);const [connectionError,setConnectionError]=useState(false);
  const jobsRef=useRef(jobs);jobsRef.current=jobs;
  const selectedJob=jobs.find(j=>j.id===selected);const result=selectedJob?.result;
  useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(historyKey)||'[]');if(Array.isArray(saved)){const valid=saved.filter(safeJob).filter(j=>!j.result||safeImage(j.result.avatarUrl)).slice(0,50);setJobs(valid);setSelected(valid[0]?.id||'');}}catch{}setLoaded(true);},[]);
  useEffect(()=>{if(loaded)try{sessionStorage.setItem(historyKey,JSON.stringify(jobs));}catch{}},[jobs,loaded]);
  useEffect(()=>{setCopied(false);setImageError(false);},[selected,result?.avatarUrl]);
  useEffect(()=>{
    if(!loaded)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      const pending=jobsRef.current.filter(j=>j.status==='pending');let failed=false;
      for(let i=0;i<pending.length;i+=3){await Promise.all(pending.slice(i,i+3).map(async job=>{try{const fresh=await api('/api/jobs/'+job.id);if(!stopped)setJobs(items=>items.map(j=>j.id===fresh.id?fresh:j));}catch{failed=true;}}));if(stopped)return;}
      if(!stopped){setConnectionError(failed);timer=setTimeout(poll,failed?8000:2500);}
    }
    void poll();return()=>{stopped=true;clearTimeout(timer);};
  },[loaded]);
  async function submit(urls:string[]){
    if(submitting)return;setSubmitting(true);setError('');
    try{const data=await api('/api/jobs',{urls,storeImages});const next=data.jobs||[];setJobs(items=>[...next,...items.filter(old=>!next.some(j=>j.id===old.id||(old.status!=='pending'&&j.profileUrl===old.profileUrl)))].slice(0,50));setSelected(next[0]?.id||'');setInput('');}catch(e){setError(e instanceof Error?e.message:'Unable to submit.');}finally{setSubmitting(false);}
  }
  async function copy(){if(!result)return;try{await navigator.clipboard.writeText(new URL(result.avatarUrl,window.location.origin).href);setCopied(true);}catch{setError('Copy failed. Open the image to copy its link.');}}
  const status=selectedJob?.status;
  return <div className="app"><header><a className="brand" href="/" aria-label="AvatarExtraction home"><span className="brand-icon"><ScanFace size={22}/></span>AvatarExtraction</a></header><div className="workspace">
    <aside className="history-sidebar" aria-label="Avatar history"><div className="history-heading"><h2><History size={16}/> History</h2>{jobs.length>0&&<button className="history-clear" onClick={()=>{setJobs(items=>items.filter(j=>j.status==='pending'));if(status!=='pending')setSelected('');}}>Clear completed</button>}</div>
      {!jobs.length?<p className="history-empty">No avatars yet.</p>:<ul className="history-list">{jobs.map(job=><li key={job.id}><button className={'history-item '+(selected===job.id?'selected':'')} aria-pressed={selected===job.id} onClick={()=>setSelected(job.id)}><span className="history-avatar">{job.status==='pending'?<LoaderCircle className="spin" size={16}/>:<UserRound size={18}/>} {job.result&&<img src={job.result.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none';}}/>}</span><span className="history-name">{job.result?.name||job.profileUrl.split('/in/')[1]?.replace(/\/$/,'')}<small className={'job-status '+job.status}>{job.status==='pending'?(job.phase==='queued'?'Queued':'Pending'):job.status==='successful'?'Successful':'Failed'}</small></span></button></li>)}</ul>}
    </aside>
    <main><h1>LinkedIn avatar</h1><section className="panel" aria-label="Avatar extraction"><div className="preview" aria-live="polite" aria-busy={status==='pending'}>
      {result&&!imageError?<AvatarImage key={selected+result.avatarUrl} job={selectedJob!} onFailure={()=>setImageError(true)}/>:<div className="placeholder" aria-hidden="true">{status==='pending'?<LoaderCircle className="spin" size={38}/>:<UserRound size={58} strokeWidth={1.2}/>}</div>}
      <div className="preview-label">{imageError?'Image unavailable':result?result.name:status==='pending'?(selectedJob?.phase==='queued'?'Queued':'Retrieving avatar…'):status==='failed'?'Lookup failed':'Avatar preview'}</div>
      {status==='pending'&&<p className="pending-note">You can add more URLs while this runs.</p>}
      {result&&<div className="result-actions"><button onClick={copy}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Copied':'Copy link'}</button><a href={result.avatarUrl} target="_blank" rel="noreferrer">Open image <ArrowUpRight size={15}/></a></div>}
      {status==='failed'&&<div className="job-failure"><p>{selectedJob?.error}</p><button disabled={submitting} onClick={()=>submit([selectedJob!.profileUrl])}><RotateCcw size={14}/> Retry</button></div>}
    </div><form onSubmit={e=>{e.preventDefault();void submit(input.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean));}}><label htmlFor="profile">LinkedIn profile URLs</label><div className="input-row"><div className="input-wrap"><span className="linkedin" aria-hidden="true">in</span><textarea id="profile" value={input} onChange={e=>setInput(e.target.value)} placeholder="linkedin.com/in/username" rows={2} required spellCheck={false} aria-describedby="batch-hint"/></div><button className="primary" disabled={submitting||!input.trim()}>{submitting?<LoaderCircle className="spin" size={17}/>:<>Extract <ArrowRight size={17}/></>}</button></div><div className="form-options"><small id="batch-hint">Up to 20 URLs · 3 at a time</small><label className="store-option"><input type="checkbox" checked={storeImages} onChange={e=>setStoreImages(e.target.checked)}/> Store photos — I have permission</label></div>{error&&<p className="error" role="alert">{error}</p>}{connectionError&&<p className="pending-note" role="status">Connection interrupted. Reconnecting…</p>}</form></section></main>
  </div></div>;
}
