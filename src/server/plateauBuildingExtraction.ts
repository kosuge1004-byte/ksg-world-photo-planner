// PLATEAU（国土交通省の全国3D都市モデル）の建物3D Tilesから、指定した
// 高さ以上の建物の座標・高さを抽出するための共通ロジック。
//
// データ出典・利用規約: 3D都市モデル（Project PLATEAU）はオープンライセンス
// （公共データ利用規約・CC BY4.0等）で提供されており、商用利用も含めて無料
// で利用可能（https://www.mlit.go.jp/plateau/policy/ 参照）。ただし配信
// サービス自体は「試験的な運用」であり提供期間・サービスレベルは保証され
// ていないため、失敗を許容できる作りにしてある（1タイル失敗しても継続）。
//
// 注意: このファイルはCesium ionを一切経由しない。PLATEAUのタイルURL
// （api.plateauview.mlit.go.jp / tile.plateauview.mlit.go.jp）は国交省が
// 直接ホストしており、Cesium ionの認証・利用枠とは無関係
// （src/cesium/createMapViewer.tsのPLATEAU_*_URLと同じ構成）。

import { load } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import { calculateTransformProps } from "@loaders.gl/tiles";
import { Ellipsoid } from "@math.gl/geospatial";
import { Matrix4 } from "@math.gl/core";
import type { B3DMContent, Tiles3DTilesetJSON, Tiles3DTileJSON, Tile3DBoundingVolume } from "@loaders.gl/3d-tiles";

export const PLATEAU_BUILDINGS_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod2-latest/tileset.json";

export type CityBoundingBox = {
  name: string;
  /** [west, south, east, north] in degrees */
  bounds: [number, number, number, number];
};

// 高層ビルが集中する主要都市の緯度経度範囲。全国のタイル階層を無差別に
// 巡回すると（該当する100m超の建物は全体のごく一部のため）非常に非効率
// なので、対象範囲をあらかじめ絞り込む。将来的に他都市を追加する場合は
// ここに追記するだけでよい。
export const DEFAULT_TARGET_CITIES: CityBoundingBox[] = [
  { name: "東京23区", bounds: [139.56, 35.53, 139.92, 35.82] },
  { name: "横浜・川崎", bounds: [139.55, 35.38, 139.75, 35.58] },
  { name: "さいたま", bounds: [139.55, 35.83, 139.75, 35.95] },
  { name: "大阪", bounds: [135.35, 34.6, 135.6, 34.78] },
  { name: "名古屋", bounds: [136.82, 35.1, 136.98, 35.25] },
  { name: "福岡", bounds: [130.35, 33.55, 130.5, 33.65] },
  { name: "札幌", bounds: [141.28, 43.0, 141.42, 43.12] },
  { name: "仙台", bounds: [140.82, 38.22, 140.92, 38.3] },
  { name: "広島", bounds: [132.4, 34.35, 132.5, 34.42] },
  { name: "神戸", bounds: [135.1, 34.65, 135.25, 34.72] },
];

export type ExtractedBuilding = {
  name: string;
  latitude: number;
  longitude: number;
  heightMeters: number;
  sourceTileUrl: string;
};

const RAD_TO_DEG = 180 / Math.PI;

// PLATEAUのバッチテーブルにおける「建物高さ」の実際のプロパティ名は
// 整備年度・地域によって表記ゆれがあり得るため（例:
// measuredHeight / buildingHeight / 計測高さ など）、候補を複数用意して
// 最初に見つかったものを使う。想定外のデータに当たった場合はnullを返し、
// 呼び出し側でログに残す。
const HEIGHT_PROPERTY_CANDIDATES = [
  "measuredHeight",
  "bldg_measuredHeight",
  "buildingHeight",
  "building_height",
  "height",
  "計測高さ",
  "建築物の高さ",
];

function resolveHeightArray(batchTableJson: Record<string, unknown> | undefined): number[] | null {
  if (!batchTableJson) return null;
  for (const key of HEIGHT_PROPERTY_CANDIDATES) {
    const value = batchTableJson[key];
    if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
      return value as number[];
    }
  }
  return null;
}

/** [west, south, east, north] （度）どうしが重なっているか。 */
function boundsIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  const [aw, as_, ae, an] = a;
  const [bw, bs, be, bn] = b;
  return aw <= be && ae >= bw && as_ <= bn && an >= bs;
}

/** 3D Tilesのregion境界（ラジアン）を対象都市の範囲（度）と比較する。 */
function regionIntersectsAnyCity(
  region: number[] | undefined,
  cities: CityBoundingBox[]
): boolean {
  if (!region) return true; // regionが無い（box/sphere等）場合は安全側に倒して巡回する
  const [west, south, east, north] = region;
  const regionDegrees: [number, number, number, number] = [
    west * RAD_TO_DEG,
    south * RAD_TO_DEG,
    east * RAD_TO_DEG,
    north * RAD_TO_DEG,
  ];
  return cities.some((city) => boundsIntersect(regionDegrees, city.bounds));
}

function getRegion(boundingVolume: Tile3DBoundingVolume | undefined): number[] | undefined {
  return boundingVolume?.region;
}

type QueuedTile = { tile: Tiles3DTileJSON; transform: Matrix4; baseUrl: string };

/**
 * tileset.jsonを起点に、対象都市の範囲と交差するタイルだけを再帰的に
 * たどり、末端（子を持たない、またはcontentのみのREPLACE想定）タイルの
 * contentのURLと、そこに至るまでの累積transformを集める。
 *
 * 3D Tilesの refine="REPLACE" が一般的なため、親タイルは子で置き換え
 * られる低詳細プロキシであることが多い。二重集計を避けるため、既定では
 * 子を持たないタイル（末端）のcontentのみを対象とする。
 */
export async function collectLeafTileContents(
  tilesetUrl: string,
  cities: CityBoundingBox[] = DEFAULT_TARGET_CITIES,
  fetchJson: (url: string) => Promise<unknown> = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`tileset取得失敗 ${response.status}: ${url}`);
    return response.json();
  }
): Promise<{ url: string; transform: Matrix4 }[]> {
  const tileset = (await fetchJson(tilesetUrl)) as Tiles3DTilesetJSON;
  const baseUrl = tilesetUrl.slice(0, tilesetUrl.lastIndexOf("/") + 1);
  const results: { url: string; transform: Matrix4 }[] = [];

  const queue: QueuedTile[] = [{ tile: tileset.root, transform: new Matrix4().identity(), baseUrl }];

  while (queue.length > 0) {
    const { tile, transform, baseUrl: currentBaseUrl } = queue.shift()!;

    const region = getRegion(tile.boundingVolume);
    if (!regionIntersectsAnyCity(region, cities)) continue;

    const localTransform = tile.transform
      ? new Matrix4(tile.transform)
      : new Matrix4().identity();
    const cumulativeTransform = new Matrix4(transform).multiplyRight(localTransform);

    const hasChildren = Array.isArray(tile.children) && tile.children.length > 0;

    if (!hasChildren && tile.content?.uri) {
      const contentUrl = resolveUrl(currentBaseUrl, tile.content.uri);
      if (contentUrl.endsWith(".json")) {
        // 外部tilesetへの参照（implicit tilingや大規模データの分割）。
        // 再帰的にたどる。
        try {
          const childTileset = (await fetchJson(contentUrl)) as Tiles3DTilesetJSON;
          const childBaseUrl = contentUrl.slice(0, contentUrl.lastIndexOf("/") + 1);
          queue.push({ tile: childTileset.root, transform: cumulativeTransform, baseUrl: childBaseUrl });
        } catch {
          // 個別タイルセットの取得失敗は無視して継続する
          // （PLATEAU配信サービスは試験運用のため一部欠損を許容する）。
        }
      } else {
        results.push({ url: contentUrl, transform: cumulativeTransform });
      }
    }

    if (hasChildren) {
      for (const child of tile.children) {
        queue.push({ tile: child, transform: cumulativeTransform, baseUrl: currentBaseUrl });
      }
    }
  }

  return results;
}

function resolveUrl(baseUrl: string, uri: string): string {
  if (/^https?:\/\//.test(uri)) return uri;
  return new URL(uri, baseUrl).toString();
}

/**
 * 1枚のb3dmタイルを読み込み、バッチテーブルの高さと、_BATCHIDごとの
 * 頂点重心（ECEF座標）から緯度経度を計算して、閾値以上の建物を返す。
 */
export async function extractTallBuildingsFromTile(
  contentUrl: string,
  tileTransform: Matrix4,
  heightThresholdMeters: number,
  fetchArrayBuffer: (url: string) => Promise<ArrayBuffer> = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`タイル取得失敗 ${response.status}: ${url}`);
    return response.arrayBuffer();
  }
): Promise<ExtractedBuilding[]> {
  const arrayBuffer = await fetchArrayBuffer(contentUrl);
  const content = (await load(arrayBuffer, Tiles3DLoader)) as B3DMContent;

  const heights = resolveHeightArray(content.batchTableJson as Record<string, unknown> | undefined);
  if (!heights) return [];

  const gltf = content.gltf;
  if (!gltf) return [];

  // content.cartesianModelMatrix は生のload()だけでは計算されない
  // （@loaders.gl/tilesのTileset3D/Tile3Dトラバーサルが内部で呼ぶ
  // calculateTransformProps()を経由して初めて設定される）。このモジュールは
  // レンダリング用のTileset3Dを使わず独自にタイル階層をたどっているため、
  // 同じ関数を直接呼び出して正しいmodelMatrix（RTC_CENTER・glTFのY-up→Z-up
  // 補正・量子化オフセット等を含む）を計算する。合成b3dmでの実地検証で、
  // この呼び出しを省略すると座標が大きくずれることを確認済み。
  calculateTransformProps(
    { computedTransform: tileTransform, boundingVolume: { center: [0, 0, 0] } } as never,
    content as never
  );
  const modelMatrix = content.cartesianModelMatrix
    ? new Matrix4(content.cartesianModelMatrix)
    : new Matrix4(tileTransform);

  const buildings: ExtractedBuilding[] = [];

  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const position = primitive.attributes.POSITION;
      const batchId = primitive.attributes._BATCHID;
      if (!position || !batchId) continue;

      const sums = new Map<number, { x: number; y: number; z: number; count: number }>();
      const positionValues = position.value;
      const batchIdValues = batchId.value;
      const vertexCount = position.count;

      for (let i = 0; i < vertexCount; i++) {
        const id = batchIdValues[i];
        const x = positionValues[i * 3];
        const y = positionValues[i * 3 + 1];
        const z = positionValues[i * 3 + 2];
        const entry = sums.get(id) ?? { x: 0, y: 0, z: 0, count: 0 };
        entry.x += x;
        entry.y += y;
        entry.z += z;
        entry.count += 1;
        sums.set(id, entry);
      }

      for (const [id, sum] of sums.entries()) {
        const heightMeters = heights[id];
        if (typeof heightMeters !== "number" || heightMeters < heightThresholdMeters) continue;

        const centroidLocal: [number, number, number] = [
          sum.x / sum.count,
          sum.y / sum.count,
          sum.z / sum.count,
        ];
        const cartesian = modelMatrix.transformAsPoint(centroidLocal, [0, 0, 0]);
        const cartographic = Ellipsoid.WGS84.cartesianToCartographic(cartesian, [0, 0, 0]);
        const [lonRad, latRad] = cartographic;

        buildings.push({
          name: `建物(${heightMeters.toFixed(0)}m)`,
          latitude: latRad * RAD_TO_DEG,
          longitude: lonRad * RAD_TO_DEG,
          heightMeters,
          sourceTileUrl: contentUrl,
        });
      }
    }
  }

  return buildings;
}
