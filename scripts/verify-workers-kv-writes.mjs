import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["server", "functions", "workers", "src"];
const allowedPutCountsByFile = new Map([
  ["server/spotSearchJobs.ts", 1],
  ["functions/api/high-precision-session.ts", 2],
]);
const ignoredDirectories = new Set(["node_modules", "dist", ".git"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

const putLocations = [];
const putCountByFile = new Map();
const forbiddenUiWriteHints = [];
const uiWriteTerms = [
  "timeline", "dateTime", "datetime", "tripodCandidate", "progressPercent",
  "foreground", "camera", "celestial", "trajectory",
];

for (const sourceRoot of sourceRoots) {
  const directory = path.join(root, sourceRoot);
  if (!fs.existsSync(directory)) continue;
  for (const file of walk(directory)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      const isWorkerKvPut = /\b(?:kv|[A-Za-z0-9_]*KV|[A-Za-z0-9_]*Kv)\.put\s*\(/u.test(line) ||
        /env\.[A-Za-z0-9_]+\.put\s*\(/u.test(line);
      if (isWorkerKvPut) {
        putLocations.push(`${relative}:${index + 1}`);
        putCountByFile.set(relative, (putCountByFile.get(relative) ?? 0) + 1);
      }
      if (/\.put\s*\(/u.test(line) && uiWriteTerms.some((term) => line.includes(term))) {
        forbiddenUiWriteHints.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

const unexpectedFiles = [...putCountByFile.keys()].filter(
  (file) => !allowedPutCountsByFile.has(file)
);
const wrongCounts = [...allowedPutCountsByFile.entries()].filter(
  ([file, expected]) => (putCountByFile.get(file) ?? 0) !== expected
);

if (unexpectedFiles.length > 0 || wrongCounts.length > 0 || forbiddenUiWriteHints.length > 0) {
  console.error("Workers KV write audit failed.");
  if (unexpectedFiles.length > 0) console.error("Unexpected KV put files:", unexpectedFiles);
  if (wrongCounts.length > 0) console.error("Unexpected KV put counts:", wrongCounts);
  if (forbiddenUiWriteHints.length > 0) {
    console.error("Possible UI-state put calls:", forbiddenUiWriteHints);
  }
  process.exit(1);
}

console.log("Workers KV write audit passed.");
console.log(`Allowed Workers KV put locations: ${putLocations.length}`);
console.log(putLocations.join("\n"));
