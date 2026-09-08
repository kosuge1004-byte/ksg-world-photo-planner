import fs from 'node:fs';
const manager = fs.readFileSync('src/cache/tripodBearingProfileManager.ts','utf8');
const dialog = fs.readFileSync('src/components/BearingProfileDownloadDialog.tsx','utf8');
const checks = [
  ['per-stage hard timeout exists', /BEARING_TERRAIN_STAGE_TIMEOUT_MS\s*=\s*45_000/.test(manager)],
  ['whole terrain stage is Promise.race bounded', /Promise\.race\(\[operation\(controller\.signal\), timeoutPromise\]\)/.test(manager)],
  ['parent abort propagates', /parentSignal\?\.addEventListener\("abort", onAbort/.test(manager)],
  ['10m profile uses bounded stage', /runBearingTerrainStage\([\s\S]*?sampleWorldTerrain\([\s\S]*?"10m"/.test(manager)],
  ['1m high precision uses bounded stage', /runBearingTerrainStage\([\s\S]*?sampleWorldTerrainNeutral\([\s\S]*?"1m"/.test(manager)],
  ['progress distinguishes profile stage', /terrainStage:\s*"profile"/.test(manager)],
  ['progress distinguishes high precision stage', /terrainStage:\s*"high-precision"/.test(manager)],
  ['dialog exposes current terrain substage', /高精度DEM保存中/.test(dialog) && /地形プロファイル取得中/.test(dialog)],
];
let failures=0;
for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) failures++; }
if(failures) process.exit(1);
