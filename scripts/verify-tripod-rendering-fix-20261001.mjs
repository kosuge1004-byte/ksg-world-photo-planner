import fs from 'node:fs';

const overlay = fs.readFileSync(new URL('../src/components/Map2DOverlay.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const entities = fs.readFileSync(new URL('../src/cesium/tripodCandidateEntities.ts', import.meta.url), 'utf8');

const checks = [
  ['2D uses viewport ray clipping', /function clipRayToViewport\([\s\S]*tEnter[\s\S]*tExit/.test(overlay)],
  ['2D no longer uses fixed diagonal x4 extension', !/Math\.hypot\(size\.width, size\.height\) \* 4/.test(overlay)],
  ['2D draws clipped visible segment', /x1=\{visibleRay\.start\.x\}[\s\S]*x2=\{visibleRay\.end\.x\}/.test(overlay)],
  ['3D candidate entity updater exists', /export function updateTripodCandidateEntities/.test(entities)],
  ['3D candidates use exact candidate lon-lat-height', /Cartesian3\.fromDegrees\([\s\S]*candidate\.longitude[\s\S]*candidate\.latitude[\s\S]*candidate\.height/.test(entities)],
  ['3D candidates remain visible over 3D tiles', /disableDepthTestDistance:\s*Number\.POSITIVE_INFINITY/.test(entities)],
  ['App feeds displayed candidates and the subject origin to 3D entities', /updateTripodCandidateEntities\(viewer, visibleCandidates, subjectPoint\)/.test(app)],
  ['App applies same celestial visibility filter in 3D', /displayedTripodCandidates\.filter\([\s\S]*celestialVisibility\[candidate\.id\]/.test(app)],
  ['3D candidate entities are cleared outside 3D mode', /mapDisplayMode !== "3d"[\s\S]*clearTripodCandidateEntities\(viewer\)/.test(app)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}

// Slab intersection regression: reproduce the former failure case where the
// subject is very far off-screen after zooming but the ray crosses the map.
function clipRay(origin, directionPoint, size) {
  const dx = directionPoint.x - origin.x;
  const dy = directionPoint.y - origin.y;
  if (Math.hypot(dx, dy) < 0.001) return null;
  const padding = 40;
  const bounds = [[origin.x, dx, -padding, size.width + padding], [origin.y, dy, -padding, size.height + padding]];
  let tEnter = 0;
  let tExit = Infinity;
  for (const [o, d, min, max] of bounds) {
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return null;
      continue;
    }
    let t0 = (min - o) / d;
    let t1 = (max - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tEnter = Math.max(tEnter, t0);
    tExit = Math.min(tExit, t1);
    if (tExit < tEnter) return null;
  }
  if (!Number.isFinite(tExit) || tExit < 0) return null;
  const enter = Math.max(0, tEnter);
  return {
    start: {x: origin.x + dx * enter, y: origin.y + dy * enter},
    end: {x: origin.x + dx * tExit, y: origin.y + dy * tExit},
  };
}

const zoomed = clipRay({x: -120000, y: 340}, {x: 320, y: 340}, {width: 688, height: 600});
const zoomedOk = zoomed && zoomed.start.x >= -40.001 && zoomed.end.x <= 728.001 && zoomed.start.y === 340 && zoomed.end.y === 340;
console.log(`${zoomedOk ? 'PASS' : 'FAIL'}: zoomed far-offscreen subject still yields visible clipped ray`);
if (!zoomedOk) failed += 1;

const miss = clipRay({x: -120000, y: -10000}, {x: 320, y: -10000}, {width: 688, height: 600});
const missOk = miss === null;
console.log(`${missOk ? 'PASS' : 'FAIL'}: ray that does not cross viewport is not drawn`);
if (!missOk) failed += 1;

if (failed) process.exit(1);
