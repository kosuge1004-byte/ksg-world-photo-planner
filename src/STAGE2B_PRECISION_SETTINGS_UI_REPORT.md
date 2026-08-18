# Stage 2B: Precision Settings UI and Persistence

## Implemented

- Added `PrecisionSettings` and `RefractionCorrectionMode` types.
- Added three ground-refraction correction choices:
  - Auto (default)
  - Standard atmosphere
  - No correction
- Added a `精度設定` entry to the hamburger menu.
- Added a compact radio-button panel for ground-refraction correction.
- Added localStorage persistence under `ksg-precision-settings`.
- Added validation when loading saved settings. Missing, malformed, or unsupported values fall back to Auto.

## Not connected in this stage

This stage intentionally does not change astronomical calculations, weather acquisition, or search results. Those will be connected in the next stage so UI/state changes remain independently verifiable.

## Verification status

- Source references and persistence paths were checked.
- Full TypeScript/build verification could not complete because dependencies are absent from the ZIP and `npm ci` failed in the execution environment.
- The first TypeScript blocker is the missing `vite/client` type definition, not an identified error in the added source.
