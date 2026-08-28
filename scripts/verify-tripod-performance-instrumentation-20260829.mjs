import fs from "node:fs";
const tripod=fs.readFileSync(new URL("../src/cesium/tripodCandidates.ts", import.meta.url),"utf8");
const app=fs.readFileSync(new URL("../src/App.tsx", import.meta.url),"utf8");
const required=[
  "totalElapsedMs: number | null",
  "initialScanMs: number",
  "weatherResolveMs: number",
  "doubleCheckMs: number",
  "totalBodyMs: number",
  "initialScanStartedAt = performance.now()",
  "convergenceLoopTotalMs += convergenceLoopMs",
  "refinementTotalMs += refinementMs",
  "doubleCheckStartedAt = performance.now()",
];
for(const x of required) if(!tripod.includes(x)) throw new Error(`missing ${x}`);
for(const x of ["総確定時間(ms)", "初期探索", "天体総時間"]) if(!app.includes(x)) throw new Error(`App missing ${x}`);
console.log("PASS tripod performance instrumentation wiring");
