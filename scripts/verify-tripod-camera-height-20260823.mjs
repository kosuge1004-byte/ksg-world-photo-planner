import fs from 'node:fs';
const app = fs.readFileSync('src/App.tsx','utf8');
const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const celestial = fs.readFileSync('src/cesium/celestial.ts','utf8');
const camera = fs.readFileSync('src/types/camera.ts','utf8');

const checks = [
  ['camera height is user-configurable, not fixed to 1.6 in candidate calculation', /lensCenterHeightMeters: number/.test(camera) && !/const lensCenterHeightMeters\s*=\s*1\.6/.test(tripod)],
  ['initial candidate observer uses current UI camera height via shared helper', /withLensCenterHeight\(\s*subjectPoint,\s*cameraSettings\.lensCenterHeightMeters/s.test(app)],
  ['existing tripod direction observer uses current UI camera height via shared helper', /withLensCenterHeight\(\s*tripodPoint,\s*cameraSettings\.lensCenterHeightMeters/s.test(app)],
  ['candidate lens observer uses same current camera height', /withLensCenterHeight\(\s*candidatePoint,\s*lensCenterHeightMeters/s.test(tripod)],
  ['final candidate observer uses same current camera height', /withLensCenterHeight\(\s*finalCandidatePoint,\s*lensCenterHeightMeters/s.test(tripod)],
  ['terrain intersection subtracts the configured lens-center height from the ECEF ray', /\(rayPoint\.height - lensCenterHeightMeters\) - sample\.height/.test(tripod)],
  ['preview uses the same lens-center-height helper', /withLensCenterHeight\(tripod, settings\.lensCenterHeightMeters\)/.test(celestial)],
  ['no stale-height App shortcut remains for initial observer', !/const initialObserver = \{\s*\.\.\.subjectPoint,\s*height: subjectPoint\.height \+ cameraSettings\.lensCenterHeightMeters/s.test(app)],
];
let failed=false;
for (const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed=true;}
if(failed) process.exit(1);
