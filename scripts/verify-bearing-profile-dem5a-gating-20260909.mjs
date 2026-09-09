import fs from "node:fs";
const s=fs.readFileSync("server/gsiElevation.ts","utf8");
const checks=[
 ["DEM5A is isolated first", /dem5aSource[\s\S]*applyResolved\(await resolveSourceTier\(dem5aSource/],
 ["lower 5m sources exclude DEM5A", /lowerFiveMeterSources = fiveMeterSources\.filter\(\(source\) => source\.label !== "DEM5A"\)/],
 ["lower 5m only after unresolved check", /if \(unresolved\.size > 0 && lowerFiveMeterSources\.length > 0\)/],
 ["DEM5B and DEM5C remain parallel", /Promise\.all\([\s\S]*lowerFiveMeterSources\.map/],
 ["DEM10B remains final fallback", /if \(unresolved\.size > 0 && tenMeterSource\)/],
 ["priority application guard remains", /if \(!unresolved\.has\(index\)\) continue/],
];
let failed=0;
for(const [name,re] of checks){const ok=re.test(s); console.log(`${ok?"PASS":"FAIL"} ${name}`); if(!ok) failed++;}
if(failed) process.exit(1);
