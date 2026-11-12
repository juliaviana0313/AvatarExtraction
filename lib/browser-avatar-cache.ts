export type SavedAvatar={name:string;avatarUrl:string;profileUrl:string;savedAt:number};
export const storageKey='avatar-history-v1';
export function canonicalProfile(value:string) {
  try {const u=new URL(value.includes('://')?value:`https://${value}`);if(u.protocol!=='https:'||! /^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(u.hostname)||!/^\/in\/[\w%\-]+\/?$/.test(u.pathname)||u.username||u.password||u.port)return '';return 'https://www.linkedin.com'+u.pathname.replace(/\/$/,'')+'/';}catch{return '';}
}
export function validSavedAvatar(value:unknown,now=Date.now()):value is SavedAvatar {
  if(!value||typeof value!=='object')return false;
  const p=value as SavedAvatar;
  if(typeof p.name!=='string'||typeof p.profileUrl!=='string'||canonicalProfile(p.profileUrl)!==p.profileUrl||typeof p.savedAt!=='number'||p.savedAt>now||now-p.savedAt>=86400000)return false;
  try {const u=new URL(p.avatarUrl);const expires=Number(u.searchParams.get('e'))*1000;return u.protocol==='https:'&&u.hostname.endsWith('.licdn.com')&&/profile-displayphoto|profile-framedphoto/.test(u.pathname)&&(!expires||expires>now+60000);}catch{return false;}
}
export function readSavedAvatars(raw:string|null):SavedAvatar[]{try{const data=JSON.parse(raw||'[]');return Array.isArray(data)?data.filter(p=>validSavedAvatar(p)).slice(0,20):[];}catch{return [];}}
