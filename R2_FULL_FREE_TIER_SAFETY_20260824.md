# R2 full conservative safety guard

Application ceilings:
- newly reserved R2 storage: 4,000,000,000 bytes lifetime
- Class-A-like cache writes: 100,000/month
- Class-B-like cache reads: 1,000,000/month
- one cache object: 512 KiB
- writes/request: 64
- reads/request: 256
- automatic R2 prewarm remains enabled for Mount Fuji and all 194 non-mountain landmarks
- missing/malformed accounting D1 => R2 access fails closed

The shared `R2_WRITE_BUDGET_DB` D1 stores the counters.
When a ceiling is reached, R2 is bypassed and AstroSight uses its normal upstream data path.

The limits are deliberately set far below R2 Standard free allowances. The storage reservation
counter begins at zero for objects written through this guarded build; existing bucket usage must
also be checked in the Cloudflare dashboard. Do not bulk-upload nationwide DEM archives.
