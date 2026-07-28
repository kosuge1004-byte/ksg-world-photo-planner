export type CelestialVisibility = {
  sun: boolean;
  moon: boolean;
  milkyWay: boolean;
  polaris: boolean;
};

export type CelestialBodyId = keyof CelestialVisibility;

export type CelestialOcclusion = {
  visible: boolean;
  verified: boolean;
  terrainObstructed: boolean;
  photorealisticMeshObstructed: boolean;
  reason: "visible" | "below-horizon" | "terrain" | "building-or-surface" | "unverified";
  obstructionElevationDegrees?: number;
  obstructionDistanceMeters?: number;
  terrainDataSource?: import("./geospatial").TerrainDataSource;
  /** ②建物3D遮蔽の詳細判定（縁サンプリング）を使った場合の、遮蔽サンプル割合（%）。 */
  obstructedFractionPercent?: number;
};

export type CelestialOcclusionMap = Partial<
  Record<CelestialBodyId, CelestialOcclusion>
>;

export type HorizontalCoordinates = {
  azimuthDegrees: number;
  altitudeDegrees: number;
};

export type CelestialScreenPoint = HorizontalCoordinates & {
  id: CelestialBodyId;
  label: string;
  xPercent: number;
  yPercent: number;
  /** カメラの前方半球にあるか。画角外位置マーカーの判定に使う。 */
  inFront?: boolean;
  visibleInFrame: boolean;
  illuminationFraction?: number;
  waxing?: boolean;
  phaseAngleDegrees?: number;
  brightLimbAngleDegrees?: number;
  moonNorthAngleDegrees?: number;
  librationLongitudeDegrees?: number;
  librationLatitudeDegrees?: number;
  angularDiameterDegrees?: number;
  verticalAngularDiameterDegrees?: number;
  diameterWidthPercent?: number;
  diameterHeightPercent?: number;
  distanceKilometers?: number;
};

export type MilkyWayPathPoint = HorizontalCoordinates & {
  xPercent: number;
  yPercent: number;
  northEdgeAzimuthDegrees: number;
  northEdgeAltitudeDegrees: number;
  northEdgeXPercent: number;
  northEdgeYPercent: number;
  southEdgeAzimuthDegrees: number;
  southEdgeAltitudeDegrees: number;
  southEdgeXPercent: number;
  southEdgeYPercent: number;
  visibleInFrame: boolean;
  lineOfSightVisible?: boolean;
};

export type CelestialTrackPoint = HorizontalCoordinates & {
  xPercent: number;
  yPercent: number;
  inFront: boolean;
  visibleInFrame: boolean;
  timestampMilliseconds: number;
  timeLabel: string;
  showTimeLabel: boolean;
};

export type CelestialTrack = {
  id: CelestialBodyId;
  label: string;
  points: CelestialTrackPoint[];
};

export type TripodCandidate = {
  id: CelestialBodyId;
  label: string;
  latitude: number;
  longitude: number;
  height: number;
  distanceMeters: number;
  /**
   * alignedは被写体中心と天体中心の画角内一致をDEM上で解いた地点。
   * direction-onlyは精密解が存在しない場合にも表示する天体方位上の確認地点。
   */
  solutionType?: "aligned" | "direction-only";
};
