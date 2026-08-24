/**
 * Conservative application-side R2 free-tier safety guard.
 *
 * This is intentionally far below Cloudflare R2 Standard free allowances:
 *   storage: 10 GB-month  -> AstroSight ceiling: 5 GiB tracked stored bytes
 *   Class A: 1,000,000/mo -> AstroSight ceiling: 100,000 writes/mo
 *   Class B:10,000,000/mo -> AstroSight ceiling: 1,000,000 reads/mo
 *
 * Cloudflare does not expose a transactional billing hard-cap API to this app.
 * SPOT_SEARCH_JOBS is Workers KV and is eventually consistent, so these are
 * conservative application ceilings, not a mathematical guarantee against billing.
 * If accounting is unavailable/malformed, R2 access FAILS CLOSED and the caller
 * falls back to the normal upstream path.
 */
export const R2_MONTHLY_WRITE_BUDGET = 100_000;
export const R2_MONTHLY_READ_BUDGET = 1_000_000;
export const R2_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
export const R2_MAX_CACHE_OBJECT_BYTES = 512 * 1024;
export const R2_MAX_WRITES_PER_REQUEST = 64;
export const R2_MAX_READS_PER_REQUEST = 256;

export interface R2SafetyKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

type RequestCounts={reads:number;writes:number};
const perRequest=new WeakMap<object,RequestCounts>();
function counts(id?:object):RequestCounts {
  if(!id) return {reads:0,writes:0};
  let v=perRequest.get(id);
  if(!v){v={reads:0,writes:0};perRequest.set(id,v);}
  return v;
}
function monthKey(d=new Date()){
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
async function numberValue(kv:R2SafetyKv,key:string):Promise<number|null>{
  const raw=await kv.get(key);
  const n=Number(raw ?? "0");
  return Number.isFinite(n)&&n>=0?n:null;
}
async function setCounter(kv:R2SafetyKv,key:string,n:number){
  await kv.put(key,String(Math.max(0,Math.floor(n))),{expirationTtl:40*24*60*60});
}
export async function allowR2Read(kv:R2SafetyKv|undefined,id?:object){
  if(!kv) return false;
  const c=counts(id);
  if(c.reads>=R2_MAX_READS_PER_REQUEST) return false;
  const key=`r2-safety:reads:${monthKey()}`;
  const current=await numberValue(kv,key);
  if(current===null||current>=R2_MONTHLY_READ_BUDGET) return false;
  c.reads++;
  await setCounter(kv,key,current+1);
  return true;
}
export async function reserveR2Write(
  kv:R2SafetyKv|undefined,
  objectKey:string,
  newBytes:number,
  oldBytes:number,
  id?:object
){
  if(!kv||!Number.isFinite(newBytes)||newBytes<0||newBytes>R2_MAX_CACHE_OBJECT_BYTES) return false;
  const c=counts(id);
  if(c.writes>=R2_MAX_WRITES_PER_REQUEST) return false;
  const mk=monthKey();
  const writeKey=`r2-safety:writes:${mk}`;
  const storageKey="r2-safety:tracked-storage-bytes";
  const writes=await numberValue(kv,writeKey);
  const storage=await numberValue(kv,storageKey);
  if(writes===null||storage===null||writes>=R2_MONTHLY_WRITE_BUDGET) return false;
  const projected=Math.max(0,storage-oldBytes+newBytes);
  if(projected>R2_STORAGE_BUDGET_BYTES) return false;
  c.writes++;
  await setCounter(kv,writeKey,writes+1);
  // Persistent counter: no TTL. It tracks current cache bytes, not monthly bytes.
  await kv.put(storageKey,String(Math.floor(projected)));
  await kv.put(`r2-safety:size:${objectKey}`,String(Math.floor(newBytes)));
  return true;
}
export async function trackedObjectBytes(kv:R2SafetyKv|undefined,objectKey:string){
  if(!kv) return null;
  return numberValue(kv,`r2-safety:size:${objectKey}`);
}
export function valueBytes(value:string|ArrayBuffer|Uint8Array){
  return typeof value==="string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}
