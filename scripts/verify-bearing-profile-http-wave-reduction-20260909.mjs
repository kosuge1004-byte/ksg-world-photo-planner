import fs from "node:fs";
const s=fs.readFileSync("src/cesium/gsiElevationClient.ts","utf8");
const checks=[
 ["per-call reserve remains two", /const PER_CALL_WORKER_RESERVE = 2/],
 ["effective per-call workers derived from global cap", /MAX_PER_CALL_WORKERS = Math\.max\(1, MAX_CONCURRENT_REQUESTS - PER_CALL_WORKER_RESERVE\)/],
 ["chunking uses actual per-call worker count", /Math\.ceil\(totalPoints \/ MAX_PER_CALL_WORKERS\)/],
 ["worker count uses same effective cap", /Math\.min\(MAX_PER_CALL_WORKERS, batches\.length\)/],
 ["request batch upper bound remains 1024", /const REQUEST_BATCH_SIZE = 1024/],
 ["global request cap remains six", /const MAX_CONCURRENT_REQUESTS = 6/],
];
let failed=0;
for (const [name,re] of checks){
  const ok=re.test(s);
  console.log(`${ok?"PASS":"FAIL"} ${name}`);
  if(!ok) failed++;
}
if(failed) process.exit(1);
