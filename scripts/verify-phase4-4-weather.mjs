import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const dialog = fs.readFileSync("src/components/CelestialTransitSearchDialog.tsx", "utf8");
const weather = fs.readFileSync("src/search/refractionWeather.ts", "utf8");

const checks = [
  [app.includes("prepareRefractionWeatherContext"), "App must prepare preview weather"],
  [app.includes("searchStart: selectedDayStart"), "Preview weather must cover selected day"],
  [app.includes("now: new Date()"), "Preview weather must use actual current time"],
  [app.includes("preview-weather-unavailable"), "Preview weather failure must be visible"],
  [dialog.includes("now: new Date()"), "Transit search must use actual current time"],
  [weather.includes('accuracyMode === "standard"'), "Standard mode must avoid weather communication"],
  [weather.includes("inFlightRequests"), "Weather requests must be deduplicated"],
  [weather.includes("climatologyByMonthHour"), "Out-of-range dates must have climatology support"],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Phase4-4 weather verification passed");
