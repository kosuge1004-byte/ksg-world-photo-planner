import fs from 'node:fs';
import assert from 'node:assert/strict';

const tripod = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const cache = fs.readFileSync(new URL('../src/cesium/tripodCandidateExactCache.ts', import.meta.url), 'utf8');

assert.match(tripod, /const apparentSeed = await scanTerrainDistanceRange\([\s\S]*point\.altitudeDegrees/,
  'apparent preview seed must be searched independently of the geometric ECEF ray');
assert.match(tripod, /seedKind: "apparent-preview"/,
  'apparent preview seed must be tagged');
assert.match(tripod, /initialSolution\.seedKind !== "apparent-preview"/,
  'apparent seed must not be forced back through geometric-ray convergence');
assert.match(tripod, /const subjectScreen = projectHorizontalToPreview\([\s\S]*dxPercent: screen\.xPercent - subjectScreen\.xPercent[\s\S]*dyPercent: screen\.yPercent - subjectScreen\.yPercent/,
  'round-trip must compare celestial center with projected subject center, not fixed 50/50');
assert.match(tripod, /createCameraProjection\([\s\S]*calculationMode,[\s\S]*viewCorrection/,
  'round-trip must use the same viewCorrection as the preview');
assert.match(app, /calculateTripodCandidates\([\s\S]*previewViewCorrection\s*\n\s*\);/,
  'App must pass previewViewCorrection into candidate round-trip');
assert.match(cache, /viewCorrection:[\s\S]*azimuthDegrees[\s\S]*altitudeDegrees/,
  'exact cache key must include viewCorrection');
assert.doesNotMatch(tripod, /dxPercent:\s*screen\.xPercent\s*-\s*50/,
  'fixed 50% target must not remain in candidate round-trip');

console.log('PASS tripod preview inverse root fix static regression');
