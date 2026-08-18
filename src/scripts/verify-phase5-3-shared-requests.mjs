import fs from "node:fs";

const required = [
  ["src/network/sharedRequests.ts", ["shareInFlightRequest", "shared-in-flight", "awaitWithAbort", "inFlight.delete"]],
  ["src/network/timeZoneRequest.ts", ["coordinateRequestKey", "shareInFlightRequest", "diagnosticFetch"]],
  ["src/search/siteContext.ts", ["osm-site-context:", "shareInFlightRequest", "toFixed(5)"]],
  ["src/search/spotPresetSearch.ts", ["requestTimeZone"]],
  ["src/App.tsx", ["requestTimeZone(latitude, longitude"]],
];
for (const [file, needles] of required) {
  const text = fs.readFileSync(file, "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${file}: ${needle} がありません`);
  }
}
const shared = fs.readFileSync("src/network/sharedRequests.ts", "utf8");
if (!shared.includes("finally")) throw new Error("失敗・完了時の共有要求解除がありません");
if (shared.includes("factory: () => Promise<T>, signal")) throw new Error("共有基礎通信に個別AbortSignalが混入しています");
console.log("Phase5-3 shared request verification passed");
