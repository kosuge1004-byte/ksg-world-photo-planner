# Phase D: Node / Browser dependency separation

## Implemented

- Added `src/search/refractionWeatherModel.ts` for pure weather/refraction data types and calculations.
- Moved `weatherForDate` and `weatherRefractionCorrectionDegrees` into the pure module.
- Updated server-reachable calculation modules to import from the pure module instead of the browser cache/network implementation.
- Kept `prepareRefractionWeatherContext` and IndexedDB-backed cache operations in `refractionWeather.ts`.
- Replaced direct `window.localStorage` access in network diagnostics with a guarded `globalThis` adapter.
- Removed `DOM` from `tsconfig.node.json`.
- Replaced the `DOMException` abort check in weather preparation with a portable `Error.name === "AbortError"` check.

## Verification

Passed:

- Node syntax checks for the modified TypeScript modules using `--experimental-strip-types`.
- `verify-precision-descriptions.mjs`.
- `verify-user-error-handling.mjs`.
- `verify-karney-edge-cases.mjs`.

Not completed in this environment:

- `npm ci`: the package mirror does not contain `youch-core@0.3.3`; resolving without the lock file also fails because the mirror does not contain `@capacitor/android@^8.4.2`.
- `tsc -b` and the full regression suite therefore cannot load project dependencies.

The source lock file was preserved.
