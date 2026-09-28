import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const cataloguePath = path.join(root, "src", "data", "japanLandmarks.ts");
const rowPattern = /\{\s*name:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*latitude:\s*(-?\d+(?:\.\d+)?),\s*longitude:\s*(-?\d+(?:\.\d+)?)/g;
const source = await fs.readFile(cataloguePath, "utf8");
const landmarks = [...source.matchAll(rowPattern)].map((match) => ({
  name: match[1],
  category: match[2],
}));

const kept = landmarks.filter((landmark) => landmark.category !== "mountain" || landmark.name === "富士山");
const keptNames = new Set(kept.map((landmark) => landmark.name));
const categoryCounts = Object.fromEntries(
  [...new Set(kept.map((landmark) => landmark.category))]
    .sort()
    .map((category) => [category, kept.filter((landmark) => landmark.category === category).length]),
);

const variants = ["center", "3km", "10km", "50km"];
const results = [];
for (const variant of variants) {
  const manifestPath = path.join(root, "dem", `gsi-landmark-dem-${variant}-manifest.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const originalEstimatedBytes = manifest.summary.estimatedBytes;
  const meshCodes = Object.entries(manifest.landmarksByMesh)
    .filter(([, owners]) => owners.some((name) => keptNames.has(name)))
    .map(([meshCode]) => meshCode)
    .sort();
  const meshSet = new Set(meshCodes);
  const files = manifest.files.filter((file) => meshSet.has(String(file.meshCode)));
  const byTypeMap = new Map();
  for (const file of files) {
    const current = byTypeMap.get(file.typeCode) ?? { typeCode: file.typeCode, files: 0, estimatedBytes: 0 };
    current.files += 1;
    current.estimatedBytes += file.estimatedBytes;
    byTypeMap.set(file.typeCode, current);
  }
  const estimatedBytes = files.reduce((sum, file) => sum + file.estimatedBytes, 0);
  results.push({
    variant,
    radiusMeters: manifest.radiusMeters,
    landmarkCount: kept.length,
    meshCount: meshCodes.length,
    fileCount: files.length,
    estimatedBytes,
    estimatedGiB: Number((estimatedBytes / 2 ** 30).toFixed(3)),
    originalEstimatedBytes,
    originalEstimatedGiB: Number((originalEstimatedBytes / 2 ** 30).toFixed(3)),
    savedBytes: originalEstimatedBytes - estimatedBytes,
    savedGiB: Number(((originalEstimatedBytes - estimatedBytes) / 2 ** 30).toFixed(3)),
    reductionPercent: Number(((1 - estimatedBytes / originalEstimatedBytes) * 100).toFixed(1)),
    byType: [...byTypeMap.values()].sort((a, b) => a.typeCode.localeCompare(b.typeCode)).map((entry) => ({
      ...entry,
      estimatedGiB: Number((entry.estimatedBytes / 2 ** 30).toFixed(3)),
    })),
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  rule: "Keep every non-mountain landmark and keep Mount Fuji as the only mountain",
  sourceCatalogue: "src/data/japanLandmarks.ts",
  originalLandmarkCount: landmarks.length,
  originalMountainCount: landmarks.filter((landmark) => landmark.category === "mountain").length,
  retainedLandmarkCount: kept.length,
  excludedMountainCount: landmarks.filter((landmark) => landmark.category === "mountain" && landmark.name !== "富士山").length,
  retainedCategoryCounts: categoryCounts,
  results,
};

const outputPath = path.join(root, "evidence", "landmark-dem-fuji-only-audit-20260927.json");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
