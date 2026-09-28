import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [route, client, manager, published, uploader] = await Promise.all([
  readFile("functions/api/bearing-profile-batch.ts", "utf8"),
  readFile("src/cache/bearingProfileBatchClient.ts", "utf8"),
  readFile("src/cache/tripodBearingProfileManager.ts", "utf8"),
  readFile("server/publishedPrecomputedBearingProfiles.ts", "utf8"),
  readFile("scripts/publish-precomputed-profiles-r2.mjs", "utf8"),
]);

assert.doesNotMatch(route, /computeBearingProfileBatch/,
  "Pages must not enter the subrequest-exhausting dynamic calculation");
assert.match(route, /readR2PrecomputedBearingProfileCompressed/);
assert.match(route, /"Content-Encoding": "gzip"/,
  "R2 gzip must be streamed without Worker-side inflation");
assert.match(route, /PRECOMPUTED_PROFILE_UNAVAILABLE/,
  "registered-profile deployment errors must be visible");
assert.match(client, /selectPublishedProfileEnvelope/,
  "the browser must validate the full published R2 envelope");
assert.match(client, /PrecomputedBearingProfileUnavailableError/,
  "a registered R2 miss must not silently enter the hour-long fallback");
assert.match(manager, /const BEARING_BATCH_SIZE = 360/,
  "all registered-spot bearings must use one HTTP/R2 request");
assert.match(published, /precomputedBearingProfileObjectKey/);
assert.match(published, /MAX_COMPRESSED_PROFILE_BYTES = 16 \* 1024 \* 1024/);
assert.match(uploader, /const execute = process\.argv\.includes\("--execute"\)/,
  "the R2 publisher must be dry-run unless explicitly enabled");
assert.match(uploader, /MAX_TOTAL_BYTES = 500 \* 1024 \* 1024/,
  "the profile publication set must have a hard storage ceiling");

console.log("Published R2 bearing-profile download path: PASS");
