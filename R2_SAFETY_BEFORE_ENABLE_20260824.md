# R2 safety before enable

Cloudflare R2 has no native "stop exactly at free tier" billing hard cap.

This build therefore fails closed for cache reads and writes:
- monthly AstroSight R2 write budget: 100,000 (10% of Standard free Class A 1,000,000/month)
- monthly AstroSight R2 read budget: 1,000,000 (10% of Standard free Class B 10,000,000/month)
- newly reserved storage: 4,000,000,000 bytes lifetime
- max R2 cache writes per request: 64
- max single cache object: 512 KiB
- shared counters: `R2_WRITE_BUDGET_DB` D1
- if D1 is unavailable or malformed, R2 access is bypassed
- automatic landmark prewarm remains enabled for Mount Fuji and every non-mountain target

Important limitation: this is a conservative application guard, not a Cloudflare billing-system
hard cap. Existing bucket usage must also be checked before deployment.

R2 binding remains commented in wrangler.jsonc until the real bucket exists.
After creating a Standard bucket, bind it as NETWORK_CACHE and redeploy.
