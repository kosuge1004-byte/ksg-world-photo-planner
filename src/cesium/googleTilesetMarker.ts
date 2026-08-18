import type { Cesium3DTileset, PrimitiveCollection, Viewer } from "cesium";

/**
 * Googleの利用規約（Map Tiles API Policies）は、Photorealistic 3D Tilesを
 * 可視化以外の用途（オブジェクト検出・ジオデータ抽出等）に使うことを禁止している。
 * このアプリの遮蔽判定（太陽・月が建物に隠れているかの判定）はシーンに対して
 * レイピックを行うため、シーン内にGoogleのタイルセットが存在すると、意図せず
 * その形状データを読み取ってしまう。
 *
 * そのため、Google由来のタイルセットにはこの目印を付け、遮蔽判定のレイピック
 * からは常に除外する（画面表示そのものは通常通り行われる＝見た目には影響しない）。
 */
const GOOGLE_TILESET_MARKER = Symbol("astrosight-google-tileset");

export function markAsGoogleTileset(tileset: Cesium3DTileset): void {
  (tileset as unknown as Record<symbol, boolean>)[GOOGLE_TILESET_MARKER] = true;
}

function isGoogleTileset(primitive: unknown): boolean {
  return Boolean(
    primitive && (primitive as Record<symbol, boolean>)[GOOGLE_TILESET_MARKER]
  );
}

function collectFrom(primitives: PrimitiveCollection, result: unknown[]): void {
  for (let i = 0; i < primitives.length; i += 1) {
    const primitive = primitives.get(i);
    if (isGoogleTileset(primitive)) {
      result.push(primitive);
    } else if (primitive && typeof primitive === "object" && "length" in primitive) {
      collectFrom(primitive as PrimitiveCollection, result);
    }
  }
}

/**
 * シーン内でGoogle由来としてマークされている全プリミティブを返す。
 * drillPickFromRayMostDetailedのobjectsToExcludeにそのまま渡すことを想定。
 */
export function collectGoogleTilesetsToExclude(viewer: Viewer): unknown[] {
  const result: unknown[] = [];
  collectFrom(viewer.scene.primitives, result);
  return result;
}
