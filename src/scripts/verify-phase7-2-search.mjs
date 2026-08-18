import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const spotScreen = await read("src/components/SpotSearchScreen.tsx");
const spotSearch = await read("src/search/spotPresetSearch.ts");
const googleUrl = await read("src/search/googleMapsUrl.ts");
const nativeResolver = await read("src/search/nativeGoogleMapsResolver.ts");
const progress = await read("src/search/searchProgress.ts");

assert.match(spotScreen, /new AbortController\(\)/u);
assert.match(spotScreen, /controllerRef\.current\?\.abort\(\)/u);
assert.match(spotScreen, /setIsSearching\(false\)/u);
assert.match(spotScreen, /onResumeSearch/u);
assert.match(spotScreen, /isPaused/u);
assert.match(spotSearch, /extractGoogleMapsSharedUrl/u);
assert.match(spotSearch, /resolveGoogleMapsSharedUrlNatively/u);
assert.match(googleUrl, /maps\.app\.goo\.gl/u);
assert.match(googleUrl, /extractGoogleMapsCoordinates/u);
assert.match(nativeResolver, /disableRedirects/u);
assert.match(progress, /Math\.max\(currentPercent, bounded\)/u);

for (const script of [
  "scripts/verify-search-progress.mjs",
  "scripts/verify-search-generation.mjs",
  "scripts/verify-phase6-4-search-speed.mjs",
]) {
  const result = spawnSync(process.execPath, [script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
}

console.log("Phase7-2 search integration verification: PASS");
