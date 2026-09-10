import fs from "node:fs";
const manager=fs.readFileSync("src/cache/tripodBearingProfileManager.ts","utf8");
const cache=fs.readFileSync("src/cache/tripodBearingProfileCache.ts","utf8");
const device=fs.readFileSync("src/cache/deviceCache.ts","utf8");
const checks=[
 ["bulk device cache API exists", /export async function getDeviceCacheMany/.test(device)],
 ["bearing cache imports bulk API", /getDeviceCacheMany/.test(cache)],
 ["bearing cache exposes bulk getter", /export async function getBearingProfilesMany/.test(cache)],
 ["manager uses bulk getter", /await getBearingProfilesMany\(subjectId, cameraSettings\.lensCenterHeightMeters, bearings\)/.test(manager)],
 ["manager no longer sequentially awaits getBearingProfile in startup loop", !/for \(const bearing of bearings\)[\s\S]{0,700}await getBearingProfile\(subjectId/.test(manager)],
 ["force refresh skips IndexedDB bulk read", /forceRefresh\s*\?\s*bearings\.map\(\(\) => null\)/.test(manager)],
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?"PASS":"FAIL"} ${name}`); if(!ok) failed++;}
if(failed)process.exit(1);
console.log(`PASS ${checks.length}/${checks.length}`);
