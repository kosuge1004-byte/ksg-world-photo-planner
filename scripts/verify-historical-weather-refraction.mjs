import fs from "node:fs";
import assert from "node:assert/strict";

const weather = fs.readFileSync("src/search/refractionWeather.ts", "utf8");
const model = fs.readFileSync("src/search/refractionWeatherModel.ts", "utf8");
const policies = fs.readFileSync("src/cache/cachePolicies.ts", "utf8");

assert.match(weather, /archive-api\.open-meteo\.com\/v1\/archive/);
assert.match(weather, /source:\s*"historical"/);
assert.match(weather, /rangeIsPast/);
assert.match(weather, /loadHistorical\(/);
assert.match(weather, /temperature_2m,relative_humidity_2m,surface_pressure/);
assert.match(model, /context\.source === "forecast" \|\| context\.source === "historical"/);
assert.match(policies, /weatherHistorical:/);
console.log("Historical weather refraction verification passed");
