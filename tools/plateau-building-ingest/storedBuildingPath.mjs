import { createHash } from "node:crypto";
import path from "node:path";

export function storedBuildingBasename(entryName, disambiguate = false) {
  const normalized = String(entryName).replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (!disambiguate) return `${basename}.ndjson.gz`;
  const stem = basename.replace(/\.gml$/iu, "");
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${stem}-${suffix}.gml.ndjson.gz`;
}

export function duplicateBuildingBasenames(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const basename = path.posix.basename(String(entry.name).replaceAll("\\", "/")).toLowerCase();
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([basename]) => basename));
}

export function buildingEntryHasDuplicateBasename(entry, duplicateBasenames) {
  const basename = path.posix.basename(String(entry.name).replaceAll("\\", "/")).toLowerCase();
  return duplicateBasenames.has(basename);
}

export function storedBuildingRelativePath(dataset, entryName, disambiguate = false) {
  return path.posix.join("buildings", dataset, storedBuildingBasename(entryName, disambiguate));
}
