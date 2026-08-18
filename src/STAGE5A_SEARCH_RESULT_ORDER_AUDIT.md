# Stage 5A — Search result ordering audit

## Finding

The in-frame search previously returned immediately once the number of completed intervals reached `displayCount`.
That early return is safe for direction-crossing results because crossings are finalized in chronological scan order.
It is not safe for in-frame intervals: another celestial body may still be inside the frame, and its eventual closest time can be earlier than a result already collected.

## Change

Early return by `displayCount` is now limited to `direction-crossing` mode.
In-frame mode scans through the requested range, finalizes every continuous in-frame interval, sorts the finalized closest times, and then applies `slice(0, displayCount)`.

## Scope

Changed file:
- `src/search/celestialTransitSearch.ts`

No UI, refraction, weather, progress, ECEF, geoid, or frame-boundary calculations were changed.

## Verification

- Confirmed all three early-return sites are now guarded by `input.criteria.mode === "direction-crossing"`.
- TypeScript syntax transpilation of the changed source completed with zero syntax diagnostics.
- Full `npm run build` remains unavailable in this container because the package gateway returns HTTP 503 for `@parcel/watcher-wasm`; therefore full dependency-based type checking and Vite bundling are not claimed as successful.
