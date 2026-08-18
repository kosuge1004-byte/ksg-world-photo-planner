# Phase5-4 Cloudflare / R2 cache

## Implementation

- Added optional `NETWORK_CACHE` R2 binding to Cloudflare Pages Functions.
- Added a shared JSON cache with stable canonical keys and SHA-256 object names.
- Cache entries include schema version and absolute expiration time.
- Invalid, expired, or unreadable entries are deleted and regenerated.
- Concurrent identical misses inside one Worker isolate share one producer Promise.
- R2 is optional. Without the binding, requests bypass R2 and preserve existing behavior.

## Cached endpoints

- Time zone: 30 days, coordinates rounded to 4 decimal places.
- Japanese place geocode: 30 days, normalized query.
- GSI elevation batches: 30 days, coordinates rounded to 5 decimal places.
- OSM site context batches: 7 days, coordinates rounded to 5 decimal places and detail mode included in the key.

## Cloudflare configuration

Create an R2 bucket, then bind it to Pages Functions as `NETWORK_CACHE`. No binding is required for local development or deployments that do not use R2.
