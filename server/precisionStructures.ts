import { calculateKarneySurfaceDistanceMeters } from "../src/geodesy/karneyGeodesic.ts";
export type PrecisionStructureType =
  | "hotel"
  | "communications-tower"
  | "communications-mast"
  | "tower";

export type PrecisionStructure = {
  id: string;
  name: string;
  type: PrecisionStructureType;
  latitude: number;
  longitude: number;
  groundElevationMeters: number;
  groundElevationSource: "GSI_DEM1A_LIDAR";
  structureHeightMeters: number | null;
  osmType: "node" | "way" | "relation";
  osmId: number;
  sourceUrl: string;
  note: string;
};

const OSM_NODE_BASE_URL = "https://www.openstreetmap.org/node/";

// 王ヶ頭周辺は塔の高さがOSM未登録のため推測値を入れない。
// 座標はOSM各ノード、地盤標高は2026-07-20取得の国土地理院DEM1Aを使用する。
export const OUGATOU_PRECISION_STRUCTURES: readonly PrecisionStructure[] = [
  {
    id: "ougatou-hotel",
    name: "王ヶ頭ホテル",
    type: "hotel",
    latitude: 36.2257334,
    longitude: 138.1087099,
    groundElevationMeters: 2029.1,
    groundElevationSource: "GSI_DEM1A_LIDAR",
    structureHeightMeters: null,
    osmType: "node",
    osmId: 1150853443,
    sourceUrl: `${OSM_NODE_BASE_URL}1150853443`,
    note: "ホテル公式情報では王ヶ頭山頂（標高2,034m）に立地。建物高は未検証。",
  },
  ...([
    [1, 8247387026, 36.2261699, 138.1070149, 2031.74, "王ヶ頭"],
    [2, 8247387027, 36.2260488, 138.1078732, 2032.3, "王ヶ頭"],
    [3, 8247387028, 36.2260661, 138.1083345, 2032.71, "王ヶ頭"],
    [4, 8247387029, 36.2261267, 138.1089782, 2031.1, "王ヶ頭"],
    [5, 8247387030, 36.2260228, 138.1095147, 2027.94, "王ヶ頭"],
    [6, 8247387031, 36.2266373, 138.1093216, 2026.67, "王ヶ頭"],
    [7, 8247387032, 36.2265248, 138.1102335, 2018.2, "王ヶ頭"],
    [8, 8247387033, 36.2277278, 138.096683, 2000.8, "王ヶ鼻"],
    [9, 8247387034, 36.2280134, 138.0974126, 2003.29, "王ヶ鼻"],
  ] as const).map(([
    index,
    osmId,
    latitude,
    longitude,
    groundElevationMeters,
    area,
  ]): PrecisionStructure => ({
    id: `utsukushigahara-communications-tower-${index}`,
    name: `美ヶ原・${area} 通信塔 ${index}`,
    type: "communications-tower",
    latitude,
    longitude,
    groundElevationMeters,
    groundElevationSource: "GSI_DEM1A_LIDAR",
    structureHeightMeters: null,
    osmType: "node",
    osmId,
    sourceUrl: `${OSM_NODE_BASE_URL}${osmId}`,
    note: "OSMに通信塔として登録。塔体高と運営者の対応は未検証のため推測しない。",
  })),
] as const;

function distanceMeters(
  origin: { latitude: number; longitude: number },
  target: { latitude: number; longitude: number }
): number {
  return calculateKarneySurfaceDistanceMeters(origin, target);
}

export function precisionStructuresNear(
  point: { latitude: number; longitude: number },
  radiusMeters = 1_800
): Array<PrecisionStructure & { distanceMeters: number }> {
  return OUGATOU_PRECISION_STRUCTURES.flatMap((structure) => {
    const distance = distanceMeters(point, structure);
    return distance <= radiusMeters
      ? [{ ...structure, distanceMeters: Math.round(distance) }]
      : [];
  });
}
