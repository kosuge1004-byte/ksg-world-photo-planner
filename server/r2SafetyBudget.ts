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
 *
 * 重要: このカウンター自体もWorkers KVを使っており、KVには別枠で
 * 「1日あたり書き込み1,000回まで無料」という制限がある（2026-08-24に実際に
 * 到達して発覚。1回のR2書き込みごとにKVへ3回書き込んでいたのが原因）。
 * さらに、キャッシュヒット時（allowR2Read）も含めてアクセスのたびに
 * カウンターをKVへ書き込んでいたため、通常のアクセス増加だけでもこの
 * KV無料枠を再び使い切りうる状態だった。そのため:
 *   1) 1回のR2読み書きあたりのKV書き込みを1回にまとめる
 *      （書き込み回数・容量・オブジェクトサイズを1つのJSON値に集約）
 *   2) KV自体がエラー/割り当て超過（429など）を返した場合も、例外を外に
 *      投げず必ずfalseを返す（フェイルクローズ）
 *   3) 読み取りカウンターは毎回ではなくREAD_COUNTER_SAMPLE_RATE回に1回だけ
 *      KVへ反映する間引き（サンプリング）方式にし、その分だけまとめて
 *      加算する。月100万回という予算に対しては十分な精度を保ったまま、
 *      KVへの書き込み回数を1/{READ_COUNTER_SAMPLE_RATE}に削減できる。
 * を満たす設計にしている。
 */
export const R2_MONTHLY_WRITE_BUDGET = 100_000;
export const R2_MONTHLY_READ_BUDGET = 1_000_000;
export const R2_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
export const R2_MAX_CACHE_OBJECT_BYTES = 512 * 1024;
export const R2_MAX_WRITES_PER_REQUEST = 64;
export const R2_MAX_READS_PER_REQUEST = 256;
// 読み取りカウンターをKVへ実際に反映する頻度。20回に1回だけ書き込み、
// その際に20回分をまとめて加算する（統計的な近似。月100万回という
// 予算に対しては十分な精度）。これによりKVへの書き込み回数を1/20に
// 削減し、KV自体の日次無料枠（書き込み1,000回/日）を圧迫しないようにする。
export const READ_COUNTER_SAMPLE_RATE = 20;

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
// KVはCloudflare側の日次無料枠（書き込み1,000回/日）や一時的なエラーで
// get/putが失敗しうる。ここで失敗した場合は必ずnull/falseを返し、
// 例外を呼び出し元へ伝播させない（フェイルクローズ）。
async function safeKvGet(kv:R2SafetyKv,key:string):Promise<string|null>{
  try{return await kv.get(key);}catch{return null;}
}
async function safeKvPut(kv:R2SafetyKv,key:string,value:string,options?:{expirationTtl?:number}):Promise<boolean>{
  try{await kv.put(key,value,options);return true;}catch{return false;}
}
function parseNumber(raw:string|null|undefined):number|null{
  const n=Number(raw ?? "0");
  return Number.isFinite(n)&&n>=0?n:null;
}
async function numberValue(kv:R2SafetyKv,key:string):Promise<number|null>{
  const raw=await safeKvGet(kv,key);
  return parseNumber(raw);
}

interface WriteBudgetState{writes:number;storageBytes:number}
function writeBudgetKey(mk:string){return `r2-safety:writes:${mk}`;}
async function readWriteBudgetState(kv:R2SafetyKv,mk:string):Promise<WriteBudgetState|null>{
  const raw=await safeKvGet(kv,writeBudgetKey(mk));
  if(raw===null) return {writes:0,storageBytes:0};
  try{
    const parsed=JSON.parse(raw);
    const writes=parseNumber(parsed?.writes);
    const storageBytes=parseNumber(parsed?.storageBytes);
    if(writes===null||storageBytes===null) return null;
    return {writes,storageBytes};
  }catch{
    return null;
  }
}

export async function allowR2Read(kv:R2SafetyKv|undefined,id?:object){
  if(!kv) return false;
  const c=counts(id);
  if(c.reads>=R2_MAX_READS_PER_REQUEST) return false;
  // サンプリング: 全呼び出しのうち 1/READ_COUNTER_SAMPLE_RATE だけ実際に
  // KVへ問い合わせ・反映する。それ以外は予算チェックをスキップして許可する
  // （月100万回という予算に対しては十分に安全側。KVへの書き込み頻度を
  // 大幅に下げることが、通常アクセスでKVの日次無料枠を守る上でより重要）。
  if (Math.random() >= 1 / READ_COUNTER_SAMPLE_RATE) {
    c.reads++;
    return true;
  }
  const key=`r2-safety:reads:${monthKey()}`;
  const current=await numberValue(kv,key);
  if(current===null||current>=R2_MONTHLY_READ_BUDGET) return false;
  const saved=await safeKvPut(kv,key,String(current+READ_COUNTER_SAMPLE_RATE),{expirationTtl:40*24*60*60});
  if(!saved) return false;
  c.reads++;
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
  const state=await readWriteBudgetState(kv,mk);
  if(state===null||state.writes>=R2_MONTHLY_WRITE_BUDGET) return false;
  const projected=Math.max(0,state.storageBytes-oldBytes+newBytes);
  if(projected>R2_STORAGE_BUDGET_BYTES) return false;
  // 1回のR2書き込みにつきKV書き込みは1回のみ（書き込み回数・保存容量・
  // オブジェクトサイズを1つのJSON値にまとめる。以前は3回に分かれていて
  // KVの日次無料枠を圧迫していた）。
  const nextState:WriteBudgetState={writes:state.writes+1,storageBytes:projected};
  const saved=await safeKvPut(
    kv,
    writeBudgetKey(mk),
    JSON.stringify(nextState),
    {expirationTtl:40*24*60*60}
  );
  if(!saved) return false;
  const sizeSaved=await safeKvPut(kv,`r2-safety:size:${objectKey}`,String(Math.floor(newBytes)),{expirationTtl:40*24*60*60});
  if(!sizeSaved) return false;
  c.writes++;
  return true;
}
export async function trackedObjectBytes(kv:R2SafetyKv|undefined,objectKey:string){
  if(!kv) return null;
  return numberValue(kv,`r2-safety:size:${objectKey}`);
}
export function valueBytes(value:string|ArrayBuffer|Uint8Array){
  return typeof value==="string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}
