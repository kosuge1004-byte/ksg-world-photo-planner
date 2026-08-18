export type TerrainDataSource =
  | "GSI_DEM1A_LIDAR"
  | "GSI_DEM5A_LIDAR"
  | "GSI_DEM5B_PHOTOGRAMMETRY"
  | "GSI_DEM5C_PHOTOGRAMMETRY"
  | "GSI_DEM10B_CONTOUR"
  | "CESIUM_WORLD_TERRAIN";

export type GsiElevationApiSample = {
  heightMeters: number | null;
  source: "DEM1A" | "DEM5A" | "DEM5B" | "DEM5C" | "DEM10B" | null;
};

export type LandmarkType =
  | "shrine"
  | "torii"
  | "historic-building"
  | "landmark-building"
  | "hotel"
  | "communications-tower"
  | "communications-mast"
  | "tower";

export type NearbyLandmark = {
  name: string;
  type: LandmarkType;
  distanceMeters: number;
};

export type NearbyBuilding = {
  name: string;
  distanceMeters: number;
  heightMeters: number | null;
  heightSource: "surveyed" | "levels-estimate" | null;
  wikidata: string | null;
};

export type NearbyStructure = {
  name: string;
  type: "hotel" | "communications-tower" | "communications-mast" | "tower";
  latitude: number;
  longitude: number;
  distanceMeters: number;
  groundElevationMeters: number | null;
  groundElevationSource: "GSI_DEM1A_LIDAR" | null;
  structureHeightMeters: number | null;
  heightSource: "surveyed" | "levels-estimate" | null;
  osmType: "node" | "way" | "relation";
  osmId: number;
  sourceUrl: string;
  note: string | null;
};

export type SiteConstraintFlags = {
  walkingOnly: boolean;
  roadsAndPathsOnly: boolean;
  excludePrivateAccess: boolean;
  elevationDifferenceWithin100m: boolean;
  excludeRoads: boolean;
};

export type SiteContext = {
  walkingAccessible: boolean;
  onMappedWay: boolean;
  restrictedAccess: boolean;
  onMotorRoad: boolean;
  nearbyLandmarks: NearbyLandmark[];
  nearbyBuildings: NearbyBuilding[];
  nearbyStructures: NearbyStructure[];
};
