# Step 3 verification

## Scope
Only the celestial transit date search dialog opened from the search button beside the timeline was modified.

## Confirmed behavior
- Search method defaults to `direction-crossing`.
- `direction-crossing` uses the fixed tripod/subject bearing, azimuth crossing detection, and time refinement.
- `in-frame` uses the fixed tripod, subject direction, focal length, and preview aspect ratio.
- `in-frame` does not call tripod candidate search, composition scoring, ranking, or azimuth crossing logic.
- Search results update date/time only in `App.tsx`.
- Samples outside the selected weekday/time range skip celestial calculations.
- Search returns immediately when the display-count limit is reached.
- Overnight ranges continue to use the existing `isLocalTimeWithinSearchRange` implementation.

## Step 3 corrections
- Celestial observations now use the lens-center elevation, matching the preview camera observer.
- Abort checks were added inside refinement loops.
- Duplicate result IDs are suppressed.
- Refinement helpers were made synchronous because they perform no asynchronous work.

## Verification performed
- TypeScript/TSX syntax diagnostics: 0 errors across 59 files.
- Confirmed no `calculateTripodCandidates` reference exists in the transit dialog/search implementation.
- Confirmed result selection changes only `dateTimeLocal`.

## Verification not completed
A full `npm run build` and `npm run lint` could not be completed in this execution environment because the ZIP does not include dependencies and npm package retrieval failed. The observed build errors are missing `vite/client` and `@types/node`, not source diagnostics.
