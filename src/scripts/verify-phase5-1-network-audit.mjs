import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const diagnostics = read("src/network/networkDiagnostics.ts");
const weather = read("src/search/refractionWeather.ts");
const site = read("src/search/siteContext.ts");
const background = read("src/search/backgroundSpotSearch.ts");
const preset = read("src/search/spotPresetSearch.ts");
const app = read("src/App.tsx");
const timeZoneRequest = read("src/network/timeZoneRequest.ts");

const checks = [
  [diagnostics.includes("astrosight-network-diagnostics-v1"), "diagnostic storage key missing"],
  [diagnostics.includes("MAX_RECENT_EVENTS = 200"), "bounded diagnostic history missing"],
  [diagnostics.includes("diagnosticFetch"), "diagnostic fetch wrapper missing"],
  [diagnostics.includes("recordCacheDiagnostic"), "cache diagnostic helper missing"],
  [weather.includes('diagnosticFetch("weather"'), "weather API is not instrumented"],
  [weather.includes('recordCacheDiagnostic("weather"'), "weather cache is not instrumented"],
  [site.includes('diagnosticFetch("osm-site-context"'), "OSM site context is not instrumented"],
  [background.includes('diagnosticFetch("spot-search"'), "background spot search is not instrumented"],
  [preset.includes('diagnosticFetch("geocode"'), "geocode is not instrumented"],
  [preset.includes('diagnosticFetch("google-maps-resolver"'), "Google Maps resolver is not instrumented"],
  [(app.includes("requestTimeZone") && timeZoneRequest.includes('diagnosticFetch("timezone"')), "startup timezone lookup is not instrumented"],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error("Phase5-1 verification failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("Phase5-1 network audit verification passed.");
