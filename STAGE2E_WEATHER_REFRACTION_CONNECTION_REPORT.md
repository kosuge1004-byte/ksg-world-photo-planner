# Stage 2E: Weather-based atmospheric refraction connection

## Implemented
- Added a Bennett-form refraction correction using geometric altitude.
- Scaled correction by measured surface pressure and temperature.
- Included humidity through water-vapour partial pressure and effective dry-air pressure.
- Applied the same corrected horizontal-coordinate function to:
  - direction-crossing coarse scan,
  - direction-crossing time refinement,
  - in-frame coarse scan,
  - closest-in-frame time refinement.
- Missing, stale, or invalid weather at an individual instant falls back to Astronomy Engine standard refraction without stopping the search.
- Corrected parsing of Open-Meteo GMT timestamps that omit an explicit `Z`, preventing browser-local timezone shifts.

## Safety limits
- No correction below -1 degree geometric altitude.
- No correction near zenith above 89.9 degrees.
- Invalid temperature, humidity, or pressure values trigger standard-atmosphere fallback.
- Correction is capped at 1.5 degrees to reject pathological values.

## Build verification
`npm run build` was attempted. It could not proceed because the extracted dependency tree does not contain the required `vite/client` and Node type definitions. A dependency reinstall was also attempted but the execution environment returned a container client error. Therefore full build success is not claimed.
