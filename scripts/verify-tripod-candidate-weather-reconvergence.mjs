import fs from 'node:fs';
const app=fs.readFileSync('src/App.tsx','utf8');
const tripod=fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const checks=[
 ['weather fallback reference exists',app.includes('const weatherReferencePoint = tripodPoint ?? subjectPoint;')],
 ['candidate resolver exists',app.includes('resolveTripodCandidateRefractionWeather')],
 ['resolver prepares context',/resolveTripodCandidateRefractionWeather[\s\S]*prepareRefractionWeatherContext\(/.test(app)],
 ['calculator receives resolver',app.includes('resolveTripodCandidateRefractionWeather') && tripod.includes('refractionWeatherResolver?: RefractionWeatherResolver')],
 ['candidate weather cell cache exists',tripod.includes('candidateWeatherByCell') && tripod.includes('weatherCellKey')],
 ['candidate point is passed to resolver',tripod.includes('refractionWeatherResolver(candidate, signal)')],
 ['candidate-local weather drives recomputation',/calculateCelestialHorizontalCoordinates\([\s\S]*candidateRefractionWeather/.test(tripod)],
 ['final candidate weather is resolved',tripod.includes('const finalCandidateWeather = await resolveCandidateWeather(finalConvergencePoint)')],
 ['final frame uses candidate weather',/const finalHorizontal = calculateCelestialHorizontalCoordinates\([\s\S]*finalCandidateWeather/.test(tripod)],
 ['final altitude convergence enforced',tripod.includes('finalAltitudeError > CONVERGED_HORIZONTAL_DEGREES')],
 ['final azimuth convergence enforced',tripod.includes('finalAzimuthError > CONVERGED_HORIZONTAL_DEGREES')],
 ['1m refinement remains',tripod.includes('"1m"')],
];
let fail=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${n}`); if(!ok) fail++;} process.exitCode=fail?1:0;
