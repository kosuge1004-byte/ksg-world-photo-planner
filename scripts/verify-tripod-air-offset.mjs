import fs from 'node:fs';
const d=fs.readFileSync('src/components/PlacementConfirmDialog.tsx','utf8');
const t=fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const checks=[
 ['manual height offset is person-only',d.includes('const allowsHeightOffset = kind === "person"')],
 ['subject/tripod height is automatic',d.includes('DEM・ジオイド・3D表面解決経路から自動で確定')],
 ['candidate observer uses lens-center helper',t.includes('withLensCenterHeight(')],
 ['tripod candidate calculation does not expose user air-offset seed',!t.includes('heightOffsetMeters')],
];
let n=0;for(const [m,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${m}`);if(!ok)n++;}if(n)process.exit(1);
