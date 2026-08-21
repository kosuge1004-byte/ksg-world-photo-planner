import fs from 'node:fs';

const app = fs.readFileSync('src/App.tsx', 'utf8');
const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');

const checks = [
  ['tripod-missing weather falls back to subject', app.includes('const weatherReferencePoint = tripodPoint ?? subjectPoint;')],
  ['candidate weather resolver exists', app.includes('resolveTripodCandidateRefractionWeather')],
  ['candidate resolver calls prepareRefractionWeatherContext', /resolveTripodCandidateRefractionWeather[\s\S]*prepareRefractionWeatherContext\(/.test(app)],
  ['candidate calculator receives weather resolver', /calculateTripodCandidates\([\s\S]*preferredDistancesById,\s*resolveTripodCandidateRefractionWeather/.test(app)],
  ['tripod candidate module accepts weather resolver', tripod.includes('export type RefractionWeatherResolver')],
  ['candidate point weather is resolved after terrain solution', /if \(refractionWeatherResolver\)[\s\S]*三脚候補気象地点/.test(tripod)],
  ['candidate-local weather drives celestial recomputation', /calculateCelestialHorizontalCoordinates\([\s\S]*activeRefractionWeather/.test(tripod)],
  ['final frame validation uses active candidate weather', /const finalHorizontal = calculateCelestialHorizontalCoordinates\([\s\S]*activeRefractionWeather/.test(tripod)],
  ['hybrid WGS84 sightline remains', tripod.includes('directSightlineSeedDistanceMeters') && tripod.includes('Ellipsoid.WGS84')],
  ['1m DEM refinement remains', tripod.includes('"1m"')],
  ['existing apparent ground refraction remains', tripod.includes('computeApparentElevation')],
  ['per-celestial failure isolation remains', tripod.includes('Promise.allSettled')],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
