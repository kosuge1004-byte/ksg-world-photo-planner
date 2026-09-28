import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFile(path.join(root, relativePath), "utf8");

const [
  config,
  start,
  app,
  readOnlyCache,
  readOnlyProfiles,
  gateway,
  runtime,
  env,
  elevation,
  bearingManager,
  tunnelTemplate,
  ignore,
] = await Promise.all([
  read("tools/local-dem-server/config.ts"),
  read("tools/local-dem-server/start.ps1"),
  read("tools/local-dem-server/app.ts"),
  read("tools/local-dem-server/readOnlyDemCache.ts"),
  read("tools/local-dem-server/readOnlyBearingProfileStore.ts"),
  read("server/localDemGateway.ts"),
  read("server/cloudflareRuntime.ts"),
  read("functions/_shared/env.ts"),
  read("server/gsiElevation.ts"),
  read("src/cache/tripodBearingProfileManager.ts"),
  read("tools/local-dem-server/cloudflared-config.yml.example"),
  read(".gitignore"),
]);

assert.match(config, /configuredHost\s*!==\s*["']127\.0\.0\.1["']/);
assert.match(config, /LOCAL_DEM_DATA_ROOT must be an absolute path/);
assert.match(config, /LOCAL_DEM_ORIGIN_TOKEN["'],\s*32/);
assert.match(start, /LOCAL_DEM_HOST\s*=\s*['"]127\.0\.0\.1['"]/);

assert.match(app, /const ENDPOINT = ["']\/v1\/elevation\/batch["']/);
assert.match(app, /PRECOMPUTED_PROFILE_ENDPOINT = ["']\/v1\/bearing-profile\/precomputed["']/);
assert.match(app, /x-astrosight-origin-token/);
assert.match(app, /timingSafeEqual/);
assert.match(app, /maximumBodyBytes/);
assert.match(app, /maximumConcurrentRequests/);
assert.doesNotMatch(app, /readdir|unlink|rm\(|writeFile/);

assert.match(readOnlyCache, /const ALLOWED_KEY = \/\^gsi-local-dem-v1/);
assert.match(readOnlyCache, /constants\.O_RDONLY/);
assert.match(readOnlyCache, /local DEM asset store is read-only/);
assert.doesNotMatch(readOnlyCache, /O_WRONLY|O_RDWR|writeFile|unlink|rm\(/);
assert.match(readOnlyProfiles, /constants\.O_RDONLY/);
assert.match(readOnlyProfiles, /checksum mismatch/);
assert.doesNotMatch(readOnlyProfiles, /O_WRONLY|O_RDWR|writeFile|unlink|rm\(/);

assert.match(gateway, /url\.protocol !== ["']https:["']/);
assert.match(gateway, /url\.pathname !== ["']\/v1\/elevation\/batch["']/);
for (const header of [
  "CF-Access-Client-Id",
  "CF-Access-Client-Secret",
  "X-AstroSight-Origin-Token",
]) {
  assert.match(gateway, new RegExp(header, "i"));
}
assert.match(gateway, /MAX_POINTS_PER_REQUEST = 512/);
assert.match(gateway, /MAX_RESPONSE_BYTES = 256 \* 1024/);
assert.match(gateway, /FAILURE_COOLDOWN_MS/);
assert.match(gateway, /export async function lookupLocalDemGatewayAuto/);
assert.match(gateway, /export async function lookupLocalPrecomputedBearingProfile/);
assert.match(app, /record\.mode === ["']auto["']/);
assert.match(app, /complete:\s*true/);
assert.match(elevation, /lookupLocalDemGatewayAuto\(gatewayPoints, signal\)/);
assert.match(bearingManager, /const BEARING_BATCH_SIZE = 32/);
assert.match(bearingManager, /usesPrecomputedRegisteredSpotProfile/);

assert.match(runtime, /new AsyncLocalStorage<RuntimeConfiguration>/);
assert.match(runtime, /gateway\?\.endpoint && gateway\.originToken &&\s*gateway\.accessClientId && gateway\.accessClientSecret/);
for (const name of [
  "LOCAL_DEM_API_URL",
  "LOCAL_DEM_ORIGIN_TOKEN",
  "LOCAL_DEM_ACCESS_CLIENT_ID",
  "LOCAL_DEM_ACCESS_CLIENT_SECRET",
]) {
  assert.match(env, new RegExp(name));
}
assert.match(env, /runWithServerRuntime\(cloudflareServerRuntimeConfiguration\(context\), task\)/);

const tierStart = elevation.indexOf("async function resolveSourceTier");
const tierEnd = elevation.indexOf("function applyResolved", tierStart);
assert.ok(tierStart >= 0 && tierEnd > tierStart, "source-tier resolver must exist");
const tier = elevation.slice(tierStart, tierEnd);
const r2Index = tier.indexOf("lookupLocalDemElevationsForSource");
const driveIndex = tier.indexOf("lookupLocalDemGatewayForSource");
const publicIndex = tier.indexOf("fetchDecodedTile");
assert.ok(r2Index >= 0 && driveIndex > r2Index && publicIndex > driveIndex,
  "each precision tier must keep R2 -> E-drive -> public GSI order");

assert.match(tunnelTemplate, /service:\s*http:\/\/127\.0\.0\.1:8789/);
assert.match(tunnelTemplate, /service:\s*http_status:404/);
assert.match(tunnelTemplate, /<TUNNEL-UUID>/);
assert.doesNotMatch(tunnelTemplate, /eyJ[A-Za-z0-9_-]{20,}\./);
assert.match(ignore, /\.wrangler\*\//);
assert.match(ignore, /\.cloudflared\//);
assert.match(ignore, /tunnel-credentials/);

for (const configName of [
  "wrangler.jsonc",
  "wrangler.spot-search.jsonc",
  "wrangler.bearing-profile-download.jsonc",
  "wrangler.prewarm.jsonc",
]) {
  const cloudflareConfig = await read(configName);
  assert.match(cloudflareConfig, /"binding"\s*:\s*"NETWORK_CACHE"/,
    `${configName}: R2 binding must remain enabled`);
  assert.match(cloudflareConfig, /"binding"\s*:\s*"R2_WRITE_BUDGET_DB"/,
    `${configName}: R2 safety budget must remain enabled`);
}

console.log("Local DEM origin security and fallback ordering: PASS");
