// 高さ未確認の登録スポットについて、OpenStreetMapの建物高さタグ（height /
// building:levels）を登録座標の周囲60mから集め、調査候補として出力する。
// 国土地理院・Overpassへ接続できる環境で実行する:
//   node scripts/research-unverified-structure-heights-osm.mjs
// 出力は「候補」であり、カタログへ登録する前に公表値・PLATEAU等で確認すること。
import { readFileSync } from "node:fs";

const allowlist = JSON.parse(readFileSync(
  new URL("../tests/regression/fixtures/landmark-height-unverified-allowlist.json", import.meta.url), "utf8"
)).names;
const catalogue = readFileSync(new URL("../src/data/japanLandmarks.ts", import.meta.url), "utf8");
const rowPattern = /\{ name: "([^"]+)", category: "\w+", latitude: (-?[\d.]+), longitude: (-?[\d.]+)/g;
const coordinates = new Map([...catalogue.matchAll(rowPattern)].map((match) => [match[1], [Number(match[2]), Number(match[3])]]));

for (const name of allowlist) {
  const [latitude, longitude] = coordinates.get(name) ?? [];
  if (!Number.isFinite(latitude)) continue;
  const query = `[out:json][timeout:25];(way(around:60,${latitude},${longitude})["building"];relation(around:60,${latitude},${longitude})["building"];);out tags center;`;
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", body: new URLSearchParams({ data: query }),
    });
    const body = await response.json();
    const candidates = (body.elements ?? [])
      .map((element) => ({ name: element.tags?.name ?? "", height: element.tags?.height ?? "", levels: element.tags?.["building:levels"] ?? "" }))
      .filter((candidate) => candidate.height || candidate.levels);
    console.log(`${name}: ${candidates.length === 0 ? "候補なし" : candidates.map((candidate) => `${candidate.name || "(無名)"} height=${candidate.height || "-"} levels=${candidate.levels || "-"}`).join(" / ")}`);
  } catch (error) {
    console.log(`${name}: 取得失敗 ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
