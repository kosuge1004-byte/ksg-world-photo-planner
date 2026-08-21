# Tripod candidate hybrid sightline implementation

## Purpose
Make direct celestial -> subject -> ground sightline geometry the primary tripod-candidate seed while preserving every existing precision/correction path and the previous terrain search as validation/fallback.

## Primary path
1. Use the current apparent celestial azimuth/altitude.
2. Build the reverse sightline through the subject in local ENU and convert it to ECEF.
3. Intersect that ray with the WGS84 ellipsoid to obtain a direct first-distance seed.
4. Do NOT accept the ellipsoid intersection as the final tripod point.
5. Validate the seed with the existing 1 m terrain sampling and apparent-elevation equation.
6. If it fails tolerance, refine around the seed.
7. If local refinement still fails, execute the existing full terrain-distance scan automatically.
8. Recompute the celestial coordinates at the solved tripod lens center and iterate to convergence.
9. Run the unchanged final azimuth/elevation/FOV validation.

## Existing precision/corrections retained
- WGS84 ellipsoid and ECEF geometry / Earth curvature.
- Karney/GeographicLib direct and inverse geodesics.
- Resolved ellipsoidal / orthometric / geoid height model.
- Terrain DEM sampling; final refinement remains 1 m request mode.
- Lens-center height.
- Celestial atmospheric refraction:
  - weather mode uses temperature, surface pressure and relative humidity,
  - missing weather falls back to Astronomy Engine normal refraction in pro mode.
- Terrestrial sightline refraction remains the existing standard k=0.13 model in pro mode. No unsupported weather-derived k-factor was introduced.
- Existing calculationMode semantics.
- Existing 0.002 degree precision/acceptance path.
- Final camera FOV and solar/lunar disc-radius checks.
- Existing previous-distance reuse remains available as a fallback hint when a direct seed cannot be produced.
- Existing allSettled per-celestial failure isolation and terrain retries remain intact.

## Safety principle
The direct WGS84 ray is only a first seed. It can never bypass DEM, apparent-elevation correction, iterative celestial recalculation, or final validation. Complex terrain therefore falls back to the previous high-precision search rather than accepting a lower-quality shortcut.

## Verification performed in this environment
Static source checks passed for:
- direct ECEF/WGS84 seed present,
- WGS84 ellipsoid use present,
- Karney geodesics retained,
- celestial weather/refraction path retained,
- terrestrial apparent-elevation/refraction path retained,
- 1 m final terrain sampling retained,
- full terrain-search fallback retained,
- final FOV check retained.

A full npm build could not be run because the supplied archive has an incomplete node_modules tree: node_modules/geo-tz/index.js is missing during the existing prebuild step. This is an input-archive dependency issue and not evidence of either success or failure of the modified TypeScript build.
