# Stage 3B: In-frame closest-time search

## Scope
Only the in-frame celestial transit search was changed. Direction-crossing search was not modified.

## Changes
- Preserve one result per continuous in-frame interval.
- Refine the entry boundary between the last outside sample and first inside sample by binary search.
- Refine the exit boundary between the last inside sample and first outside sample by binary search.
- Restrict closest-time minimization to the refined in-frame interval.
- Keep cancellation checks throughout boundary and closest-time refinement.
- Reset frame sample continuity when weekday/time-range filtering creates a discontinuity.

## Accuracy
Boundary refinement stops when the bracket is 1 second or less. Closest-time refinement also stops at approximately 1 second.

## Verification
- Source inspection confirms direction-crossing code is unchanged.
- Global TypeScript compiler was invoked with `tsc -p tsconfig.app.json --noEmit`.
- Compilation could not start because the archive does not contain the `vite/client` type package.
- `npm ci --ignore-scripts` failed due to the container environment, so a complete build could not be certified here.
