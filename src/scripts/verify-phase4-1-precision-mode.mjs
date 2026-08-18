import assert from "node:assert/strict";
import fs from "node:fs";

const weather = fs.readFileSync("src/search/refractionWeather.ts", "utf8");
const dialog = fs.readFileSync("src/components/CelestialTransitSearchDialog.tsx", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const storage = fs.readFileSync("src/precision/precisionSettingsStorage.ts", "utf8");

assert.match(weather, /accuracyMode: AccuracyMode/);
assert.match(weather, /options\.accuracyMode === "standard"/);
assert.match(dialog, /accuracyMode: precisionSettings\.accuracyMode/);
assert.match(app, /loadPrecisionSettingsFromStorage/);
assert.match(app, /savePrecisionSettingsToStorage\(precisionSettings\)/);
assert.match(storage, /PRECISION_SETTINGS_STORAGE_KEY/);
assert.match(storage, /normalizePrecisionSettings/);
console.log("Phase4-1 precision mode verification passed");
