# Step 4 verification

## Implemented
- Frame-search coarse sampling is now adaptive to the current focal length and preview aspect ratio.
- The interval is bounded to 1-10 minutes and targets at least four coarse samples across the shortest frame dimension, using a conservative apparent-motion bound of 0.3 degrees/minute.
- This reduces missed frame entries at long focal lengths while retaining 10-minute scanning for wide fields.
- Entry boundary refinement remains approximately one second.

## Local checks
- TypeScript/TSX syntax transpilation: 59 files, 0 diagnostics.
- Full `npm ci`: blocked by the execution environment's internal npm proxy returning HTTP 503 for `@parcel/watcher-wasm@2.5.6`.
- Therefore full `tsc -b`, `oxlint`, and `vite build` remain unverified in this environment.
