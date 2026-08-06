export type GroundPoint = {
  latitude: number;
  longitude: number;
  height: number;
  label: string;
};

export type LineMetrics = {
  distanceMeters: number;
  bearingDegrees: number;
  heightDifferenceMeters: number;
  /** false when tripod and subject are coincident and the bearing is undefined. */
  bearingDefined?: boolean;
  coincident?: boolean;
};
