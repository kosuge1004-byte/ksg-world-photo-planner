import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const cache = read("functions/_shared/r2Cache.ts");
const env = read("functions/_shared/env.ts");
const files = ["timezone.ts", "geocode.ts", "gsi-elevation.ts", "gsi-geoid.ts", "osm-site-context.ts"].map((name) => read(`functions/api/${name}`));

const checks = [
  [env.includes("NETWORK_CACHE?: R2Bucket"), "optional R2 binding"],
  [cache.includes("stableSerialize") && cache.includes("SHA-256"), "stable hashed key"],
  [cache.includes("expiresAt") && cache.includes("version"), "TTL and version envelope"],
  [cache.includes("inFlight") && cache.includes('cache: "shared"'), "stampede protection"],
  [cache.includes("allowR2Read") && cache.includes("reserveR2Write"), "R2 read/write budget guards"],
  [cache.includes("trackedObjectBytes"), "R2 storage accounting"],
  [!cache.includes("bucket.delete(key)"), "no unguarded R2 delete"],
  [files.every((text) => text.includes("getOrCreateR2Json")), "endpoint integration"],
  [files.some((text) => text.includes('namespace: "gsi-elevation"')), "GSI cache"],
  [files.some((text) => text.includes('namespace: "osm-site-context"')), "OSM cache"],
];
for (const [ok, label] of checks) {
  if (!ok) throw new Error(`Phase5-4 verification failed: ${label}`);
}
console.log("Phase5-4 verification passed");
