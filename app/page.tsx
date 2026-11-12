'use client';
import { useState } from 'react';
import { ScanFace, ArrowUpRight, ArrowRight, LoaderCircle, Copy, Check, X, UserRound, History } from 'lucide-react';
type Profile = { name: string; avatarUrl: string; profileUrl: string };
export default function Home() {
  const [url,setUrl] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [result,setResult] = useState<Profile|null>(null); const [copied,setCopied] = useState(false); const [imageError,setImageError] = useState(false);
  const [history,setHistory] = useState<Profile[]>([]);
  const [lookupStatus,setLookupStatus] = useState('Finding profile photo…');
  async function extract(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setResult(null); setImageError(false); setCopied(false); setLookupStatus('Starting profile lookup…');
    try {
      let job: string | undefined;
      const started = Date.now();
      const deadline = started+10*60*1000;
      while (Date.now() < deadline) {
        const res = await fetch('/api/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(job ? {job} : {url}),signal:AbortSignal.timeout(35000)});
        const data = await res.json() as Partial<Profile> & {error?:string;code?:string;status?:string;job?:string};
        if (!res.ok) {throw new Error(data.error || 'Unable to extract this avatar.');}
        if (res.status === 202 && data.job) {job=data.job;setLookupStatus('Retrieving profile photo…');await new Promise(resolve=>setTimeout(resolve,Date.now()-started<60000 ? 1000 : 3000));continue;}
        if (!data.name || !data.avatarUrl || !data.profileUrl) throw new Error('The server returned an incomplete profile.');
        const profile = data as Profile; setResult(profile); setHistory(items=>[profile,...items.filter(item=>item.profileUrl!==profile.profileUrl)].slice(0,20)); return;
      }
      throw new Error('This lookup is taking longer than expected. Please try again later.');
    } catch(e) {setError(e instanceof Error && e.name==='TimeoutError' ? 'The lookup service took too long to respond. Please try again later.' : e instanceof Error ? e.message : 'Something went wrong. Please try again.');} finally {setBusy(false);}
  }
  async function copy() { if (!result) return; try { await navigator.clipboard.writeText(result.avatarUrl); setCopied(true); } catch { setError('Your browser could not copy the link. Open the image to copy its address.'); } }
  return <div className="app">
    <header><a className="brand" href="/" aria-label="AvatarExtraction home"><span className="brand-icon"><ScanFace size={22}/></span>AvatarExtraction</a></header>
    <div className="workspace">
    <aside className="history-sidebar" aria-label="Avatar history">
      <div className="history-heading"><h2><History size={16}/> History</h2>{history.length>0&&<button type="button" className="history-clear" onClick={()=>setHistory([])}>Clear</button>}</div>
      {history.length===0?<p className="history-empty">No avatars yet.</p>:<ul className="history-list">{history.map(profile=><li key={profile.profileUrl}><button type="button" className={'history-item '+(result?.profileUrl===profile.profileUrl?'selected':'')} disabled={busy} aria-pressed={result?.profileUrl===profile.profileUrl} onClick={()=>{setResult(profile);setUrl(profile.profileUrl);setImageError(false);setError('');setCopied(false);}}><span className="history-avatar"><UserRound size={18}/><img src={profile.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none';}}/></span><span className="history-name">{profile.name}</span><ArrowRight size={13}/></button></li>)}</ul>}
    </aside>
    <main>
      <h1>LinkedIn avatar</h1>
      <section className="panel" aria-label="Avatar extraction">
        <div className="preview" aria-live="polite" aria-busy={busy}>
          {result && !imageError ? <img className="avatar" src={result.avatarUrl} alt={`${result.name} profile photo`} referrerPolicy="no-referrer" onError={()=>setImageError(true)}/> : <div className="placeholder" aria-hidden="true">{busy?<LoaderCircle size={38} className="spin"/>:<UserRound size={58} strokeWidth={1.2}/>}</div>}
          <div className="preview-label">{imageError?'Image unavailable':result?result.name:busy?lookupStatus:'Avatar preview'}</div>
          {result && <div className="result-actions"><button type="button" onClick={copy}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Copied':'Copy link'}</button><a href={result.avatarUrl} target="_blank" rel="noreferrer">Open image <ArrowUpRight size={15}/></a></div>}
        </div>
        <form onSubmit={extract}>
          <label htmlFor="profile">LinkedIn profile URL</label>
          <div className="input-row"><div className="input-wrap"><span className="linkedin" aria-hidden="true">in</span><input id="profile" value={url} onChange={e=>setUrl(e.target.value)} placeholder="linkedin.com/in/username" required disabled={busy} autoComplete="off" spellCheck={false}/>{url&&!busy&&<button type="button" className="clear" aria-label="Clear URL" onClick={()=>setUrl('')}><X size={16}/></button>}</div><button className="primary" aria-label={busy?"Extracting avatar":"Extract avatar"} disabled={busy||!url.trim()}>{busy?<LoaderCircle className="spin" size={17}/>:<>Extract <ArrowRight size={17}/></>}</button></div>
          {error&&<p className="error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
    </div>
  </div>;
}
