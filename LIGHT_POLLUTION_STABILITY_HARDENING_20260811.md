# Light pollution stability hardening (2026-08-11)

- Added bounded tile image cache (96 entries) to prevent long-session memory growth.
- Added 8 second tile load timeout so stalled network requests cannot keep an overlay render pending indefinitely.
- Cache eviction targets settled least-recently-used entries first.
- Existing stale-render generation guard and canvas-only visible-crop rendering are retained.
