import fs from "node:fs";

const r2 = fs.readFileSync(new URL("../functions/_shared/r2Cache.ts", import.meta.url), "utf8");
const elev = fs.readFileSync(new URL("../functions/api/gsi-elevation.ts", import.meta.url), "utf8");
const geoid = fs.readFileSync(new URL("../functions/api/gsi-geoid.ts", import.meta.url), "utf8");
const dem = fs.readFileSync(new URL("../server/gsiElevation.ts", import.meta.url), "utf8");
const geoidCore = fs.readFileSync(new URL("../server/gsiGeoid.ts", import.meta.url), "utf8");

const checks = [
  [r2.includes('ttlSeconds?: number | null'), 'R2 helper supports no-expiry'],
  [r2.includes('envelope.expiresAt === null'), 'R2 helper accepts non-expiring envelope'],
  [elev.includes('namespace: "gsi-elevation", version: "v3", ttlSeconds: null'), 'elevation result cache is non-expiring'],
  [geoid.includes('namespace: "gsi-geoid", version: "v2", ttlSeconds: null'), 'point geoid cache is non-expiring'],
  [geoid.includes('namespace: "gsi-geoid-batch", version: "v2", ttlSeconds: null'), 'batch geoid cache is non-expiring'],
  [dem.includes('gsi-decoded-dem-v2/'), 'decoded DEM tiles remain persistent/versioned'],
  [geoidCore.includes('geoid/v1/'), 'raw geoid values remain persistent/versioned'],
];
let failed = 0;
for (const [ok, name] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
