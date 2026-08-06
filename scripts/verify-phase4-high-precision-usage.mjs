import fs from "node:fs";

const endpoint = fs.readFileSync("functions/api/high-precision-session.ts", "utf8");
const policy = fs.readFileSync("server/highPrecisionUsagePolicy.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");

for (const required of [
  "HIGH_PRECISION_WARNING_LIMIT = 800",
  "HIGH_PRECISION_STOP_LIMIT = 850",
  'timeZone = "America/Los_Angeles"',
  'reason: "service_disabled"',
  'reason: "monthly_limit_reached"',
]) {
  if (!policy.includes(required)) throw new Error(`Missing policy contract: ${required}`);
}
if (!endpoint.includes("HIGH_PRECISION_ENABLED")) {
  throw new Error("Emergency high-precision stop env is missing");
}
if (!endpoint.includes("SPOT_SEARCH_JOBS")) {
  throw new Error("Existing KV binding is not used");
}
if (!app.includes('accuracyMode: "standard"')) {
  throw new Error("UI does not fall back to standard mode");
}
console.log(JSON.stringify({ warning: 800, stop: 850, emergencyStop: true, standardFallback: true }));
