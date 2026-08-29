import fs from 'node:fs';

const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');

const checks = [
  ['audit type exists', tripod.includes('export type TripodPhysicsAudit')],
  ['audit accessor exists', tripod.includes('getLastTripodPhysicsAudits')],
  ['reference observer is not lens-height adjusted again', !/buildTripodPhysicsAudit[\s\S]*withLensCenterHeight\(\s*referenceLensObserver/.test(tripod)],
  ['camera height is explicitly logged', app.includes('カメラ高=${audit.lensCenterHeightMeters.toFixed(3)}m')],
  ['ellipsoid and orthometric heights logged', app.includes('ellipsoid=${audit.referenceObserver.ellipsoidalHeightMeters') && app.includes('orthometric=${audit.referenceObserver.orthometricHeightMeters')],
  ['ECEF logged', app.includes('観測点ECEF=') && app.includes('被写体ECEF=')],
  ['earth curvature logged', app.includes('地球曲率診断: 球面落差=')],
  ['terrestrial refraction logged', app.includes('地表屈折角=')],
  ['astronomical refraction logged', app.includes('astronomicalRefraction=')],
  ['weather temperature pressure humidity logged', app.includes('temp=${audit.weather.temperatureCelsius') && app.includes('pressure=${audit.weather.surfacePressureHpa') && app.includes('humidity=${audit.weather.relativeHumidityPercent')],
  ['centerline equivalent vertical error logged', app.includes('距離換算垂直差=')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
