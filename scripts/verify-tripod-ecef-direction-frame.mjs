import fs from 'node:fs';

const tripodSource = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');
const appSource = fs.readFileSync('src/App.tsx', 'utf8');

const checks = [
  ['horizontal angles are converted in their own observer ENU frame', /horizontalToEcefUnitDirection\(\s*directionObserver,\s*celestialAzimuthDegrees,\s*geometricAltitudeDegrees\s*\)/s.test(tripodSource)],
  ['backward ray accepts an explicit direction observer', /buildCelestialBackwardRay\([\s\S]*?directionObserver: GroundPoint = subject/s.test(tripodSource)],
  ['candidate reconvergence rebuilds ECEF direction at candidate lens observer', /buildCelestialBackwardRay\(\s*subject,\s*horizontal\.azimuthDegrees,\s*geometricRayAltitudeDegrees,\s*candidateLensObserver\s*\)/s.test(tripodSource)],
  ['preview tripod lens observer is forwarded with shared lens-height helper', /withLensCenterHeight\(\s*tripodPoint,\s*cameraSettings\.lensCenterHeightMeters,\s*"三脚候補初期方向観測点"\s*\)/s.test(appSource)],
  ['old candidate az-alt to subject ENU shortcut is absent', !/buildCelestialBackwardRay\(subject, horizontal\.azimuthDegrees, horizontal\.altitudeDegrees\)/.test(tripodSource)],
  ['initial ECEF ray uses celestial geometric altitude directly', /initialGeometricRayAltitudeDegrees\s*=\s*Number\.isFinite\(point\.geometricAltitudeDegrees\)/s.test(tripodSource)],
  ['reconverged ECEF ray uses celestial geometric altitude directly', /geometricRayAltitudeDegrees\s*=\s*Number\.isFinite\(horizontal\.geometricAltitudeDegrees\)/s.test(tripodSource)],
  ['terrestrial refraction is not subtracted from celestial altitude', !/horizontal\.altitudeDegrees\s*-\s*groundRefractionDegrees/.test(tripodSource)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}

const subject = { lat: 35.35768320944909, lon: 136.8090747234574 };
const tripod = { lat: 35.35556780866144, lon: 136.8194024751617 };
const rad = Math.PI / 180;
const up = ({lat, lon}) => {
  const p = lat * rad, l = lon * rad;
  return [Math.cos(p)*Math.cos(l), Math.cos(p)*Math.sin(l), Math.sin(p)];
};
const a = up(subject), b = up(tripod);
const dot = Math.max(-1, Math.min(1, a[0]*b[0] + a[1]*b[1] + a[2]*b[2]));
const frameRotationDegrees = Math.acos(dot) / rad;
const convergenceToleranceDegrees = 0.002;
const frameCheck = frameRotationDegrees > convergenceToleranceDegrees;
console.log(`${frameCheck ? 'PASS' : 'FAIL'}: field-case local-frame rotation ${frameRotationDegrees.toFixed(6)}° exceeds ${convergenceToleranceDegrees.toFixed(3)}° convergence tolerance`);
if (!frameCheck) failed = true;

if (failed) process.exit(1);
