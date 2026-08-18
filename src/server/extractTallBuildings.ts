// PLATEAU建物3D Tilesから、高さ100m以上（既定）の建物を抽出し、
// server/landmarkPrewarmSeed.ts に追記できる形式で出力するCLIスクリプト。
//
// 使い方（例）:
//   npx tsx server/extractTallBuildings.ts
//   npx tsx server/extractTallBuildings.ts --threshold=150
//   npx tsx server/extractTallBuildings.ts --city="東京23区"
//
// 注意（実行前に必ず読むこと）:
// - この環境（Claude作業用サンドボックス）はネットワーク制限により
//   plateauview.mlit.go.jp へアクセスできないため、このスクリプトは
//   実際のPLATEAUデータに対して一度も実行・検証できていない。
//   3D Tiles / glTF のパース処理自体は実在するライブラリ（loaders.gl、
//   math.gl）を使い、型定義とAPIシグネチャの整合性は確認済みだが、
//   PLATEAUの実データに対する動作は利用者側で確認してほしい。
// - バッチテーブルの高さプロパティ名は
//   server/plateauBuildingExtraction.ts の HEIGHT_PROPERTY_CANDIDATES
//   に無いものだった場合、該当タイルの建物は抽出されずログにも出ない
//   （静かに0件になる）。実行後の件数が想定より少ない場合はまずここを疑う。
// - 対象都市は主要10都市に絞ってある（DEFAULT_TARGET_CITIES）。
//   全国を漏れなく探すものではない。

import {
  collectLeafTileContents,
  extractTallBuildingsFromTile,
  PLATEAU_BUILDINGS_TILESET_URL,
  DEFAULT_TARGET_CITIES,
  type ExtractedBuilding,
  type CityBoundingBox,
} from "./plateauBuildingExtraction.ts";

const REQUEST_DELAY_MS = 300; // PLATEAU配信サービスへの配慮

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(): { threshold: number; city?: string } {
  const args = process.argv.slice(2);
  const get = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    threshold: Number(get("threshold") ?? 100),
    city: get("city"),
  };
}

async function main() {
  const { threshold, city } = parseArgs();
  const cities: CityBoundingBox[] = city
    ? DEFAULT_TARGET_CITIES.filter((c) => c.name === city)
    : DEFAULT_TARGET_CITIES;

  if (cities.length === 0) {
    console.error(`指定された都市が見つかりません: ${city}`);
    console.error(`利用可能: ${DEFAULT_TARGET_CITIES.map((c) => c.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`対象都市: ${cities.map((c) => c.name).join(", ")}`);
  console.log(`高さ閾値: ${threshold}m以上`);
  console.log("タイル階層を巡回中...");

  const contents = await collectLeafTileContents(PLATEAU_BUILDINGS_TILESET_URL, cities);
  console.log(`対象タイル: ${contents.length}件`);

  const allBuildings: ExtractedBuilding[] = [];
  let failures = 0;

  for (const [index, { url, transform }] of contents.entries()) {
    try {
      const buildings = await extractTallBuildingsFromTile(url, transform, threshold);
      if (buildings.length > 0) {
        console.log(`  [${index + 1}/${contents.length}] ${buildings.length}件 (${url})`);
      }
      allBuildings.push(...buildings);
    } catch (error) {
      failures += 1;
      console.warn(`  ! タイル処理失敗 (${url}):`, (error as Error).message);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n完了。${allBuildings.length}件の建物（${threshold}m以上）、失敗タイル${failures}件。`);

  // 高さ順にソートし、landmarkPrewarmSeed.ts に貼り付けやすい形式で出力する。
  allBuildings.sort((a, b) => b.heightMeters - a.heightMeters);
  const lines = allBuildings.map(
    (b) =>
      `  { name: "${b.name}", category: "building", latitude: ${b.latitude.toFixed(6)}, longitude: ${b.longitude.toFixed(6)} }, // ${b.heightMeters.toFixed(0)}m`
  );
  console.log("\n--- landmarkPrewarmSeed.ts に貼り付ける内容（要:名称の手動確認） ---");
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error("建物抽出スクリプトが失敗しました:", error);
  process.exitCode = 1;
});
