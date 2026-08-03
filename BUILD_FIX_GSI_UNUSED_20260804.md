# Cloudflare build fix: unused GSI elevation code

Removed the unused `keepServerTaskAlive` import and the unused `serializeDecodedElevationTile` function from `server/gsiElevation.ts`.

These were left behind after Workers KV writes for decoded DEM tiles were removed and caused TypeScript TS6133 build failures.

Verification:
- Workers KV static write audit: passed
- Full `npm run build`: not executable in this environment because dependencies are not installed (`geo-tz` is missing before TypeScript compilation starts)
