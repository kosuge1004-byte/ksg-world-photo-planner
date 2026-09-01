import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const data = fs.readFileSync(path.join(root, "src/data/japanLandmarks.ts"), "utf8");
const search = fs.readFileSync(path.join(root, "src/search/spotPresetSearch.ts"), "utf8");
const seed = fs.readFileSync(path.join(root, "server/landmarkPrewarmSeed.ts"), "utf8");

const seedCount = [...seed.matchAll(/\{ name: "[^"]+", category: "[^"]+", latitude:/g)].length;
const staticCount = [...data.matchAll(/\{ name: "[^"]+", category: "[^"]+", latitude:/g)].length;
if (seedCount !== 278) throw new Error(`unexpected seed count: ${seedCount}`);
if (staticCount < seedCount) throw new Error(`static landmark count ${staticCount} < seed ${seedCount}`);
if (!search.includes("resolveStaticJapanLandmark(normalizedQuery)")) throw new Error("static resolver is not wired before network search");
const staticIndex = search.indexOf("resolveStaticJapanLandmark(normalizedQuery)");
const cacheIndex = search.indexOf("readCachedSpotLocation(normalizedQuery)");
if (!(staticIndex >= 0 && cacheIndex > staticIndex)) throw new Error("static landmark lookup must precede cache/network path");
for (const name of ["岐阜城", "東京タワー", "東京スカイツリー", "牛久大仏", "東京ディズニーランド", "富士山", "コスモクロック21", "ダイヤと花の大観覧車", "Sky-Boat", "HEP FIVE観覧車", "Fuji Sky View", "アミュラン"]) {
  if (!data.includes(`name: \"${name}\"`)) throw new Error(`missing static landmark: ${name}`);
}
if (!data.includes('"USJ"')) throw new Error("USJ alias missing");
if (!data.includes('"名古屋テレビ塔"')) throw new Error("Nagoya TV Tower alias missing");
console.log(`static landmark search: PASS (${staticCount} entries)`);
