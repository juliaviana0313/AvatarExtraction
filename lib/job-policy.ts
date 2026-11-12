export const MAX_ACTIVE=3;
export const MAX_BATCH=20;
export const JOB_TIMEOUT=20*60*1000;
export const OUTPUT_FIELDS='name|url|avatar';
export const isTerminal=(status:string)=>status==='successful'||status==='failed';
export const retryableStatus=(status:number)=>[429,502,503,504].includes(status);
export const backoff=(attempt:number)=>Math.min(8000,500*2**attempt);
export function imageType(bytes:Uint8Array):string|null {
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return 'image/png';
  if(new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP')return 'image/webp';
  return null;
}
export async function boundedMap<T,R>(values:T[],limit:number,fn:(value:T)=>Promise<R>):Promise<R[]> {
  const results:R[]=new Array(values.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(next<values.length){const index=next++;results[index]=await fn(values[index]);}}));return results;
}
