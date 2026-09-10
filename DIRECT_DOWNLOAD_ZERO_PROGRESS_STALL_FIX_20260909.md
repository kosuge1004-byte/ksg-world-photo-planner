# Direct-download zero-progress stall fix — 2026-09-09

Observed on device: progress remained at `0 / 356` while high-precision DEM was being saved.

The immediately preceding optimization changed a ~640-point bearing from ~107-point requests to ~160-point requests. That reduced HTTP batch count but increased the amount of DEM-tile work inside each Cloudflare Worker invocation. The real-device symptom appeared after this change.

Fix: restore the safer six-way point split (`ceil(totalPoints / MAX_CONCURRENT_REQUESTS)`) while retaining the shared global request queue and the four-large-request concurrency cap.

No sample points, DEM source priority, interpolation, bearing resolution, or final precision were reduced.
