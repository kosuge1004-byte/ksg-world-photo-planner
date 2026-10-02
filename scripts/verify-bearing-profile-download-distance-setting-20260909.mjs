import fs from "node:fs";
const app=fs.readFileSync("src/App.tsx","utf8");
const mgr=fs.readFileSync("src/cache/tripodBearingProfileManager.ts","utf8");
const precision=fs.readFileSync("src/types/precision.ts","utf8");
const targets=fs.readFileSync("src/data/precomputedBearingProfileTargets.ts","utf8");
const checks=[
 ["default precision distance remains 10km", /TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS = 10_000/.test(precision)],
 ["App passes the requested distance through registered-profile coverage", /maxDistanceMeters: registeredProfileCoverageDistanceMeters\([\s\S]*?precisionSettings\.tripodSearchMaxDistanceMeters[\s\S]*?\)/.test(app)],
 ["only the exact registered Mount Fuji target expands to 100km", /name === "富士山"[\s\S]*?MOUNT_FUJI_PROFILE_DISTANCE_METERS/.test(targets) && /findPrecomputedBearingProfileTarget\(latitude, longitude\)/.test(targets)],
 ["download accepts maxDistanceMeters", /maxDistanceMeters\?: number/.test(mgr)],
 ["download clamps to the absolute distance ceiling", /Math\.min\(\s*ABSOLUTE_MAX_DISTANCE_METERS/.test(mgr)],
 ["terrain profile generation uses requested max", /maxMeters: requestedMaxDistanceMeters/.test(mgr)],
 ["existing short profile is rejected when requested range is longer", /existingMaxDistanceMeters \+ 0\.01 < requestedMaxDistanceMeters/.test(mgr)],
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?"PASS":"FAIL"} ${name}`);if(!ok)failed++;}
if(failed)process.exit(1);
console.log(`PASS ${checks.length}/${checks.length}`);
