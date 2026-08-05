import fs from "node:fs";

const source = fs.readFileSync(new URL("../server/surfaceObstructionLineOfSight.ts", import.meta.url), "utf8");
const required = [
  '["natural"="tree_row"]',
  '["barrier"="hedge"]',
  '["landuse"="orchard"]',
  'vegetationKind: VegetationKind | null',
  'DEFAULT_HEDGE_HEIGHT_METERS = 2',
  '各辺と視線の交差・最接近点も評価',
  'vegetationKind === "tree-row"',
  'vegetationKind === "orchard"',
];
for (const token of required) {
  if (!source.includes(token)) throw new Error(`Phase4-3 token missing: ${token}`);
}
const aroundCoverage = (source.match(/nwr\(\$\{around\}\)/g) ?? []).length;
const bboxCoverage = (source.match(/nwr\[[^\n]+\]\(\$\{bbox\}\)/g) ?? []).length;
if (Math.max(aroundCoverage, bboxCoverage) < 6) {
  throw new Error("Phase4-3 Overpass vegetation coverage is incomplete");
}
console.log("Phase4-3 vegetation verification passed");
