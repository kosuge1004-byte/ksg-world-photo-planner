# Direct download startup bulk-read optimization — 2026-09-09

Confirmed bottleneck:
`backfillBearingProfiles()` checked every bearing with a sequential
`await getBearingProfile(...)` before the first terrain request.

The shared device cache already provides `getDeviceCacheMany()`, which uses one
IndexedDB readonly transaction for multiple keys and preserves memory/TTL semantics.

Change:
- added `getBearingProfilesMany()` to tripodBearingProfileCache.ts
- startup scan now reads all bearing keys in one bulk transaction
- forceRefresh skips the cache read entirely
- DEM precision, bearing interval, terrain sampling and final verification unchanged
