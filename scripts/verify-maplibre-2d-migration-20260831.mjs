import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const component = fs.readFileSync(new URL("../src/components/MapLibre2DMap.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const mercator = fs.readFileSync(new URL("../src/map/webMercator.ts", import.meta.url), "utf8");

const checks = [
  ["Google iframe removed", !app.includes("google-map-2d") && !app.includes("googleMapUrl")],
  ["MapLibre renderer wired", app.includes("<MapLibre2DMap")],
  ["OpenFreeMap Bright fixed", component.includes("https://tiles.openfreemap.org/styles/bright")],
  ["GSI seamlessphoto fixed", component.includes("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg")],
  ["2D view uses same App lat/lon state", component.includes("center: [center.longitude, center.latitude]")],
  ["MapLibre rotation disabled", component.includes("dragRotate: false") && component.includes("maxPitch: 0")],
  ["Legacy 256px zoom preserved", component.includes("MAPLIBRE_ZOOM_OFFSET = -1")],
  ["Existing overlay mercator kept", mercator.includes("const scale = 256 * 2 ** zoom")],
  ["No precision/search engine rewrite", app.includes("calculateTripodCandidates") && app.includes("calculateKarneyLineMetrics")],
  ["MapLibre CSS target present", css.includes(".maplibre-2d-map")],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`MapLibre 2D migration verification: ${checks.length}/${checks.length} PASS`);
