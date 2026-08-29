export type CelestialVisibility = {
  sun: boolean;
  moon: boolean;
  milkyWay: boolean;
  polaris: boolean;
};

export type CelestialBodyId = keyof CelestialVisibility;

export type CelestialOcclusionVerificationState =
  | "checking"
  | "dem-only"
  | "dem-and-google-3d"
  | "failed";

export type CelestialOcclusion = {
  verificationState: CelestialOcclusionVerificationState;
  visible: boolean;
  verified: boolean;
  terrainObstructed: boolean;
  photorealisticMeshObstructed: boolean;
  reason: "visible" | "below-horizon" | "terrain" | "building-or-surface" | "unverified";
  obstructionElevationDegrees?: number;
  /** 遮蔽判定へ渡した見かけの天体高度。 */
  celestialApparentAltitudeDegrees?: number;
  /** 大気差適用前の幾何学的な天体高度。 */
  celestialGeometricAltitudeDegrees?: number;
  /** 見かけの天体高度 - DEM稜線高度。正なら天体が上。 */
  terrainClearanceDegrees?: number;
  /** DEM稜線との僅差により遮蔽を確定しなかった場合。 */
  terrainBoundaryUncertain?: boolean;
  obstructionDistanceMeters?: number;
  terrainDataSource?: import("./geospatial").TerrainDataSource;
  /** ②建物3D遮蔽の詳細判定（縁サンプリング）を使った場合の、遮蔽サンプル割合（%）。 */
  obstructedFractionPercent?: number;
  failureMessage?: string;
};

export type CelestialOcclusionMap = Partial<
  Record<CelestialBodyId, CelestialOcclusion>
>;

export function checkingCelestialOcclusion(): CelestialOcclusion {
  return {
    verificationState: "checking",
    visible: false,
    verified: false,
    terrainObstructed: false,
    photorealisticMeshObstructed: false,
    reason: "unverified",
  };
}

export function failedCelestialOcclusion(
  failureMessage?: string
): CelestialOcclusion {
  return {
    verificationState: "failed",
    visible: false,
    verified: false,
    terrainObstructed: false,
    photorealisticMeshObstructed: false,
    reason: "unverified",
    failureMessage,
  };
}

/** 判定中・失敗・未検証を遮蔽確定として扱わない、表示共通の判定。 */
export function isCelestialOcclusionConfirmedHidden(
  occlusion: CelestialOcclusion | undefined
): boolean {
  if (
    !occlusion ||
    occlusion.verificationState === "checking" ||
    occlusion.verificationState === "failed"
  ) {
    return false;
  }
  return (
    occlusion.reason === "below-horizon" ||
    occlusion.reason === "terrain" ||
    occlusion.reason === "building-or-surface"
  );
}

export type HorizontalCoordinates = {
  azimuthDegrees: number;
  altitudeDegrees: number;
  /** 大気差適用前の幾何学的な高度。未指定時はaltitudeDegreesと同じ。 */
  geometricAltitudeDegrees?: number;
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
  galacticLongitudeDegrees: number;
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
   * preliminaryは、地形（建物・山などの凹凸）を未確認のまま、地球を
   * 完全な球体とみなした理論値だけで求めた、計算中の暫定地点
   * （2026-08-28追記：最初の候補点が出るまでの待ち時間を、ユーザーに
   * 何も見せずに待たせないための「候補点計算中」表示に使う）。
   */
  solutionType?: "aligned" | "direction-only" | "preliminary";
  /** 同一天体で複数の地形交点がある場合の、遠い順の候補番号。 */
  intersectionIndex?: number;
  /** 同一天体で検出された有効地形交点の総数。 */
  intersectionCount?: number;
  /**
   * 2026-08-29追記: round-trip投影条件は満たすが、候補地点から被写体への
   * 視線が途中の地形（同じレイ上の別の交点の地形など）に遮られている
   * 可能性がある場合にtrue。2026-08-23仕様「複数交点は全て候補として
   * 保持し、遠い候補を勝手に1点へ絞らない」を尊重し、このフラグが立って
   * いても候補からは除外しない。表示側で「視界を確認してください」等の
   * 注意喚起に使う。
   */
  lineOfSightPossiblyObstructed?: boolean;
  /** 視線を遮っている疑いのある地形までの、候補地点からの概算距離(m)。 */
  obstructionDistanceMeters?: number;
};
