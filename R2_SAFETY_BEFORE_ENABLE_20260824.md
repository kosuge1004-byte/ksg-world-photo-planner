# R2 safety before enable

Cloudflare R2 has no native "stop exactly at free tier" billing hard cap.

This build therefore fails closed for cache WRITES:
- monthly AstroSight R2 write budget: 100,000 (10% of Standard free Class A 1,000,000/month)
- max R2 cache writes per request: 64
- max single cache object: 512 KiB
- shared monthly counter: existing `SPOT_SEARCH_JOBS` KV
- if the safety KV is unavailable or malformed, new R2 cache writes are refused
- reads from already-cached R2 objects remain allowed
- automatic landmark prewarm R2 writes are disabled

Important limitation:
Workers KV is eventually consistent, so this is a deliberately conservative application guard,
not a Cloudflare billing-system hard cap. The 90% margin is intentional.

R2 binding remains commented in wrangler.jsonc until the real bucket exists.
After creating a Standard bucket, bind it as NETWORK_CACHE and redeploy.
