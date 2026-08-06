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
};
