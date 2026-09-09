# Cloudflare TS6133 build fix — 2026-09-09

Cloudflare `tsc -b` failed at:
`src/cache/tripodBearingProfileManager.ts(332,11): TS6133 'captured' is declared but its value is never read.`

Fix:
- Abort path changed from
  `const captured = await finishGsiDeviceTileCapture(subjectId);`
  to
  `await finishGsiDeviceTileCapture(subjectId);`

The finalizer call is preserved. Only the unused local binding was removed.
No terrain precision, cache behavior, download logic, or completion semantics were changed.
