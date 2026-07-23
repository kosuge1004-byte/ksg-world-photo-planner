export type ForegroundObjectType = "person";

export type ForegroundObject = {
  id: string;
  type: ForegroundObjectType;
  latitude: number;
  longitude: number;
  /** Terrain height at the object's own placement point, in meters. */
  groundHeightMeters?: number;
  heightCm: number;
  enabled: boolean;
};
