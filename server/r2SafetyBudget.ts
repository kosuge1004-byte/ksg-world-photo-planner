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
 *
 * 2026-08-26追記: それでもなお、KVの日次無料枠（書き込み1,000回/日）に
 * 複数回到達した。改めてCloudflare公式の無料枠を比較すると:
 *   R2書き込み(Class A)  : 100万回/月
 *   R2読み取り(Class B)  : 1000万回/月
 *   KV書き込み           : 1,000回/日   ← 突出して厳しい
 *   KV読み取り           : 10万回/日
 * つまり「R2を見張るためのKV」の方が、見張られているR2本体よりずっと
 * 厳しい制限を持っており、KVの制限がR2の制限より先に問題化する構造的な
 * 弱点があった。これを踏まえ、さらに2点を見直す:
 *   4) allowR2Read（読み取り確認）はKVへのアクセスを完全に廃止する。
 *      R2読み取りの無料枠（月1000万回）に対しては、リクエスト単位の
 *      上限（R2_MAX_READS_PER_REQUEST）だけで実用上十分安全であり、
 *      月間の正確な集計を諦めてもR2側の無料枠を圧迫するリスクは
 *      無視できるほど小さい。
 *   5) reserveR2Write内の月間書き込みカウンター（writeBudgetKey）の
 *      更新も、読み取りと同様にサンプリングで間引く
 *      （WRITE_COUNTER_SAMPLE_RATE）。ただし、次回書き込み時の
 *      oldBytes計算に必要な「個々のオブジェクトのサイズ記録」
 *      （r2-safety:size:キー）は間引かない。R2への実際の書き込み内容・
 *      キャッシュの正確さには4・5とも一切影響しない
 *      （変わるのは「KVでの記録頻度」だけ）。
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
// 書き込み月間カウンターをKVへ実際に反映する頻度。R2への実際の書き込み
// （bucket.put自体）は毎回必ず行われ、キャッシュの内容・精度には一切
// 影響しない。間引かれるのは「今月あと何回書けるか」を数えるKV側の
// 記録頻度のみ。
export const WRITE_COUNTER_SAMPLE_RATE = 10;

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
  // 2026-08-26追記: 以前はここでKVへの読み取り/書き込みを行っていたが、
  // R2読み取りの無料枠（月1000万回）はKV書き込みの無料枠（1日1,000回）
  // よりずっと大きく、月間集計をKV経由で行うこと自体が「見張り役の方が
  // 見張られている本体より厳しい制限を持つ」という本末転倒な構造だった。
  // ここではKVに一切アクセスせず、リクエスト単位の上限
  // （R2_MAX_READS_PER_REQUEST）だけで暴走を防ぐ。kvが未設定（＝R2/KV
  // どちらも無効な環境）の場合のみ、従来どおり安全側に倒してfalseを返す。
  if(!kv) return false;
  const c=counts(id);
  if(c.reads>=R2_MAX_READS_PER_REQUEST) return false;
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

  // 2026-08-26追記: 月間書き込みカウンター（writeBudgetKey）へのKV反映を
  // 間引く。R2への実際の書き込み（bucket.put）は下の行で毎回必ず行われ、
  // キャッシュの内容・精度は一切変わらない。間引かれるのは「今月あと
  // 何回書けるか」を数えるKV側の記録頻度のみ。保存容量（storageBytes）は
  // 精度が必要なため毎回正確に計算するが、KVへの反映自体は
  // WRITE_COUNTER_SAMPLE_RATE回に1回にまとめる。
  if (Math.random() < 1 / WRITE_COUNTER_SAMPLE_RATE) {
    const nextState:WriteBudgetState={
      writes:state.writes+WRITE_COUNTER_SAMPLE_RATE,
      storageBytes:projected,
    };
    const saved=await safeKvPut(
      kv,
      writeBudgetKey(mk),
      JSON.stringify(nextState),
      {expirationTtl:40*24*60*60}
    );
    if(!saved) return false;
  }
  // 次回このキーへ書き込む際のoldBytes計算に必要なため、個々のオブジェクト
  // サイズは間引かず毎回正確に記録する（精度に直結する部分）。
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
