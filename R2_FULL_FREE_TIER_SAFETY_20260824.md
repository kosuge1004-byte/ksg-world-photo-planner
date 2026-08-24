# R2 full conservative safety guard

Application ceilings:
- tracked R2 storage: 5 GiB
- Class-A-like cache writes: 100,000/month
- Class-B-like cache reads: 1,000,000/month
- one cache object: 512 KiB
- writes/request: 64
- reads/request: 256
- automatic R2 prewarm remains disabled
- missing/malformed accounting KV => R2 access fails closed

The existing SPOT_SEARCH_JOBS KV stores the shared counters.
When a ceiling is reached, R2 is bypassed and AstroSight uses its normal upstream data path.

Important: Workers KV counters are eventually consistent. This is deliberately set far below
R2 Standard free allowances and is not a Cloudflare billing hard cap.
The storage counter begins at zero for objects written through this guarded build; do not put
untracked objects into the same cache bucket.
