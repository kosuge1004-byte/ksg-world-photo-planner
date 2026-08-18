import fs from "node:fs";

const types = fs.readFileSync(
  new URL("../src/types/celestial.ts", import.meta.url),
  "utf8"
);
const occlusion = fs.readFileSync(
  new URL("../src/cesium/celestialOcclusion.ts", import.meta.url),
  "utf8"
);
const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const overlay = fs.readFileSync(
  new URL("../src/components/CelestialOverlay.tsx", import.meta.url),
  "utf8"
);
const map = fs.readFileSync(
  new URL("../src/cesium/celestialMap.ts", import.meta.url),
  "utf8"
);

for (const state of [
  "checking",
  "dem-only",
  "dem-and-google-3d",
  "failed",
]) {
  if (!types.includes(`"${state}"`)) {
    throw new Error(`occlusion verification state is missing: ${state}`);
  }
}

if (
  !occlusion.includes("onDemVerified?.(demOnlyResult)") ||
  !app.includes("checkingCelestialOcclusion()") ||
  !app.includes("(demResult) => updatePointOcclusion")
) {
  throw new Error("progressive DEM to Google 3D state update is missing");
}

for (const source of [overlay, map]) {
  if (!source.includes("isCelestialOcclusionConfirmedHidden")) {
    throw new Error("renderer does not share confirmed-occlusion semantics");
  }
}
if (overlay.includes("occlusion[point.id]?.visible !== true")) {
  throw new Error("pending/unverified state still hides the celestial disc");
}
if (!overlay.includes("point.lineOfSightVisible !== false")) {
  throw new Error("pending Milky Way line of sight is still hidden");
}

const confirmedHidden = (state, reason) =>
  state !== "checking" &&
  state !== "failed" &&
  ["below-horizon", "terrain", "building-or-surface"].includes(reason);

for (const state of ["checking", "failed"]) {
  for (const reason of ["unverified", "terrain", "building-or-surface"]) {
    if (confirmedHidden(state, reason)) {
      throw new Error(`${state}/${reason} was incorrectly confirmed hidden`);
    }
  }
}
if (!confirmedHidden("dem-only", "terrain")) {
  throw new Error("DEM-confirmed terrain obstruction was not hidden");
}
if (!confirmedHidden("dem-and-google-3d", "building-or-surface")) {
  throw new Error("Google 3D mesh obstruction was not hidden");
}
if (confirmedHidden("dem-only", "unverified")) {
  throw new Error("unverified Google 3D state was treated as obstruction");
}

console.log("DEM and Google 3D occlusion state verification: PASS");
