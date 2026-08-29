import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  HeightReference,
  LabelStyle,
  NearFarScalar,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  Viewer,
} from "cesium";

import type {
  CelestialScreenPoint,
  CelestialOcclusionMap,
  CelestialTrack,
  CelestialVisibility,
  MilkyWayPathPoint,
  TripodCandidate,
} from "../types/celestial";
import { isCelestialOcclusionConfirmedHidden } from "../types/celestial";
import type { TripodSearchBaseLine } from "./tripodSearchLine";
import type { GroundPoint } from "../types/points";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { celestialWorldDirection } from "./celestialOcclusion";

const PREFIX = "ksg-celestial-map-";
const CELESTIAL_RAY_DISTANCE_METERS = 1_000_000;
const entityCache = new WeakMap<Viewer, {
  tracks: CelestialTrack[];
  mapViewMode: "2d" | "3d";
  tripodLatitude: number | null;
  tripodLongitude: number | null;
  tripodHeight: number | null;
  lensCenterHeightMeters: number;
  visibilitySun: boolean;
  visibilityMoon: boolean;
  visibilityMilkyWay: boolean;
  visibilityPolaris: boolean;
}>();

type SharedGroundLineState = { positions: Cartesian3[] };
const sharedGroundLineStates = new WeakMap<
  Viewer,
  Map<string, SharedGroundLineState>
>();

function updateSharedGroundLines(
  viewer: Viewer,
  lines: TripodSearchBaseLine[]
): void {
  let states = sharedGroundLineStates.get(viewer);
  if (!states) {
    states = new Map();
    sharedGroundLineStates.set(viewer, states);
  }
  const activeIds = new Set<string>();

  for (const line of lines) {
    const id = `${PREFIX}${line.id}-tripod-search-base-line`;
    activeIds.add(id);
    const positions = [
      Cartesian3.fromDegrees(
        line.start.longitude,
        line.start.latitude,
        line.start.height + 0.2
      ),
      Cartesian3.fromDegrees(
        line.end.longitude,
        line.end.latitude,
        line.end.height + 0.2
      ),
    ];
    const existing = states.get(id);
    if (existing) {
      existing.positions[0] = positions[0];
      existing.positions[1] = positions[1];
      continue;
    }

    const state: SharedGroundLineState = { positions };
    states.set(id, state);
    viewer.entities.add({
      id,
      name: `${line.label}の三脚探索基礎ライン`,
      polyline: {
        positions: new CallbackProperty(() => state.positions, false),
        width: 4,
        material: new PolylineDashMaterialProperty({
          color: COLORS[line.id].withAlpha(0.92),
          dashLength: 11,
        }),
        clampToGround: true,
      },
    });
  }

  for (const [id] of states) {
    if (activeIds.has(id)) continue;
    viewer.entities.removeById(id);
    states.delete(id);
  }

  // ViewerはrequestRenderMode=true。既存EntityはCallbackPropertyの参照値だけを
  // 更新するため、Cesium側が変更を自動検知せず画面が更新されない場合がある。
  // 候補の追加・移動・削除後は明示的に1フレーム要求して描画を確実にする。
  viewer.scene.requestRender();
}

const COLORS = {
  sun: Color.GOLD,
  moon: Color.LIGHTCYAN,
  milkyWay: Color.fromCssColorString("#d8d0c5"),
  polaris: Color.WHITE,
} as const;

type TripodCandidateEntityState = {
  position: Cartesian3;
  text: string;
};
const tripodCandidateEntityStates = new WeakMap<
  Viewer,
  Map<string, TripodCandidateEntityState>
>();

function updateTripodCandidateEntities(
  viewer: Viewer,
  subject: GroundPoint | null,
  candidates: TripodCandidate[],
  visibility: CelestialVisibility,
  isCalculating: boolean
): void {
  let states = tripodCandidateEntityStates.get(viewer);
  if (!states) {
    states = new Map();
    tripodCandidateEntityStates.set(viewer, states);
  }
  const activeIds = new Set<string>();

  if (subject) {
    for (const candidate of candidates) {
      if (!visibility[candidate.id]) continue;
      const candidateIndex = candidate.intersectionIndex ?? 1;
      const id = `${PREFIX}${candidate.id}-tripod-candidate-${candidateIndex}`;
      activeIds.add(id);
      const position = Cartesian3.fromDegrees(
        candidate.longitude,
        candidate.latitude,
        candidate.height + 0.2
      );
      // 2026-08-29修正: 以前はsolutionType==="preliminary"であれば常に
      // 「候補点計算中」と表示していた。しかしv20の仕様により、精密計算が
      // 「確定解なし」「通信失敗」で終わった天体は、暫定候補（solutionType
      // はpreliminaryのまま）を消さずに残す設計になっている。そのため
      // 計算が実際には完了しているのに、ラベルは「計算中」のまま止まって
      // 見え、ユーザーから見ると「候補点が出ない・止まっている」ように
      // 見えるバグになっていた（isCalculatingで実際の計算状態を区別する）。
      const candidateKind =
        candidate.solutionType === "direction-only"
          ? "三脚方位候補（要確認）"
          : candidate.solutionType === "preliminary"
            ? (isCalculating ? "候補点計算中" : "概算候補（確定解なし）")
            : "三脚候補";
      const candidateNumber = candidate.intersectionCount && candidate.intersectionCount > 1
        ? ` ${candidateIndex}/${candidate.intersectionCount}`
        : "";
      // 2026-08-29追記: round-trip投影条件は満たすが、途中の地形（同じ
      // レイ上の別の交点の地形等）に被写体への視線を遮られている可能性が
      // ある候補には、その旨をラベルへ明記する。候補としては除外しない
      // （2026-08-23仕様「複数交点は全て保持」を尊重）が、そのまま現地へ
      // 行っても被写体が見えない可能性があることをユーザーに伝える。
      const obstructionWarning = candidate.lineOfSightPossiblyObstructed
        ? "\n⚠視界不良の可能性"
        : "";
      const text =
        `${candidate.label} ${candidateKind}${candidateNumber}\n${Math.round(candidate.distanceMeters)}m${obstructionWarning}`;
      const existing = states.get(id);
      if (existing) {
        // 時間軸ドラッグ中はEntityを作り直さず、参照中の座標だけを更新する。
        existing.position = position;
        existing.text = text;
        continue;
      }

      // 2026-08-28追記: 暫定（計算中）候補は、地形（建物・山などの凹凸）を
      // 未確認の理論値であることが視覚的にひと目で分かるよう、色を半透明
      // にする。精密計算が完了し確定候補に置き換わると、通常の不透明な
      // 色で再描画される。
      const baseColor = COLORS[candidate.id];
      const color = candidate.solutionType === "preliminary"
        ? baseColor.withAlpha(0.45)
        : baseColor;
      const state: TripodCandidateEntityState = { position, text };
      states.set(id, state);
      viewer.entities.add({
        id,
        name: `${candidate.label} ${candidateKind}`,
        position: new CallbackPositionProperty(() => state.position, false),
        point: {
          pixelSize: 11,
          color,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: new CallbackProperty(() => state.text, false),
          font: "bold 12px sans-serif",
          fillColor: color,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -13),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
  }

  for (const [id] of states) {
    if (activeIds.has(id)) continue;
    viewer.entities.removeById(id);
    states.delete(id);
  }

  // ViewerはrequestRenderMode=true。既存EntityはCallbackPropertyの参照値だけを
  // 更新するため、候補位置・ラベル更新後は明示的に1フレーム描画する。
  viewer.scene.requestRender();
}

function destinationPoint(
  origin: GroundPoint,
  azimuthDegrees: number,
  altitudeDegrees: number,
  distanceMeters: number
): Cartesian3 {
  const destination = calculateKarneyDestinationPoint(
    origin,
    azimuthDegrees,
    distanceMeters
  );
  const height =
    origin.height +
    Math.tan((altitudeDegrees * Math.PI) / 180) * distanceMeters;

  return Cartesian3.fromDegrees(
    destination.longitude,
    destination.latitude,
    height
  );
}

function destinationGroundPoint(
  origin: GroundPoint,
  azimuthDegrees: number,
  distanceMeters: number
): Cartesian3 {
  const destination = calculateKarneyDestinationPoint(
    origin,
    azimuthDegrees,
    distanceMeters
  );

  return Cartesian3.fromDegrees(
    destination.longitude,
    destination.latitude,
    origin.height + 1
  );
}

function celestialRayTarget(
  origin: Cartesian3,
  horizontal: { azimuthDegrees: number; altitudeDegrees: number }
): Cartesian3 {
  return Cartesian3.add(
    origin,
    Cartesian3.multiplyByScalar(
      celestialWorldDirection(origin, horizontal),
      CELESTIAL_RAY_DISTANCE_METERS,
      new Cartesian3()
    ),
    new Cartesian3()
  );
}

function contiguousVisibleSegments(track: CelestialTrack): CelestialTrack["points"][] {
  const segments: CelestialTrack["points"][] = [];
  let current: CelestialTrack["points"] = [];
  for (const point of track.points) {
    if (point.altitudeDegrees < -1) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function contiguousMilkyWaySegments(
  path: MilkyWayPathPoint[]
): MilkyWayPathPoint[][] {
  const segments: MilkyWayPathPoint[][] = [];
  let current: MilkyWayPathPoint[] = [];
  for (const point of path) {
    const visible = (
      Math.max(
        point.altitudeDegrees,
        point.northEdgeAltitudeDegrees,
        point.southEdgeAltitudeDegrees
      ) > -6 &&
      point.lineOfSightVisible !== false
    );
    if (!visible) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export function updateCelestialMapEntities(
  viewer: Viewer,
  tripod: GroundPoint | null,
  subject: GroundPoint | null,
  points: CelestialScreenPoint[],
  tracks: CelestialTrack[],
  milkyWayPath: MilkyWayPathPoint[],
  visibility: CelestialVisibility,
  tripodCandidates: TripodCandidate[],
  tripodSearchLines: TripodSearchBaseLine[],
  occlusion: CelestialOcclusionMap,
  mapViewMode: "2d" | "3d",
  lensCenterHeightMeters: number,
  tripodCandidatesCalculating: boolean
): void {
  // tracksは呼び出し側useMemoで内容変更時だけ参照が変わる。
  // 数千点の軌道配列を毎更新JSON.stringifyするのをやめ、参照と小さな
  // プリミティブ値だけで再生成要否を判定する。描画内容は変えない。
  const previousCache = entityCache.get(viewer);
  const replaceTracks = !previousCache ||
    previousCache.tracks !== tracks ||
    previousCache.mapViewMode !== mapViewMode ||
    previousCache.tripodLatitude !== (tripod?.latitude ?? null) ||
    previousCache.tripodLongitude !== (tripod?.longitude ?? null) ||
    previousCache.tripodHeight !== (tripod?.height ?? null) ||
    previousCache.lensCenterHeightMeters !== lensCenterHeightMeters ||
    previousCache.visibilitySun !== visibility.sun ||
    previousCache.visibilityMoon !== visibility.moon ||
    previousCache.visibilityMilkyWay !== visibility.milkyWay ||
    previousCache.visibilityPolaris !== visibility.polaris;
  const nextCache = {
    tracks,
    mapViewMode,
    tripodLatitude: tripod?.latitude ?? null,
    tripodLongitude: tripod?.longitude ?? null,
    tripodHeight: tripod?.height ?? null,
    lensCenterHeightMeters,
    visibilitySun: visibility.sun,
    visibilityMoon: visibility.moon,
    visibilityMilkyWay: visibility.milkyWay,
    visibilityPolaris: visibility.polaris,
  };

  for (const entity of [...viewer.entities.values]) {
    if (typeof entity.id === "string" && entity.id.startsWith(PREFIX)) {
      const isTrack = entity.id.includes("-track-") || entity.id.includes("-time-");
      const isCandidate = entity.id.includes("-tripod-candidate");
      const isSharedGroundLine = entity.id.includes("-tripod-search-base-line");
      // 基礎ラインはCallbackPropertyの座標だけを更新し、Entityを再生成しない。
      if (
        isSharedGroundLine ||
        isCandidate ||
        (isTrack && !replaceTracks)
      ) {
        continue;
      }
      viewer.entities.remove(entity);
    }
  }

  // 被写体だけを置いた段階でも、共通基礎ラインと候補点を3D地図へ表示する。
  updateSharedGroundLines(viewer, tripodSearchLines);
  updateTripodCandidateEntities(
    viewer,
    subject,
    tripodCandidates,
    visibility,
    tripodCandidatesCalculating
  );

  if (!tripod) {
    entityCache.set(viewer, nextCache);
    return;
  }
  entityCache.set(viewer, nextCache);

  const origin = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + lensCenterHeightMeters
  );
  const distanceMeters = 1500;

  if (replaceTracks) for (const track of tracks) {
    if (!visibility[track.id]) continue;
    contiguousVisibleSegments(track).forEach((segment, segmentIndex) => {
      viewer.entities.add({
        id: `${PREFIX}${track.id}-track-${segmentIndex}`,
        name: `${track.label}の軌跡`,
        polyline: {
          positions: segment.map((point) => mapViewMode === "3d"
            ? celestialRayTarget(origin, point)
            : destinationGroundPoint(tripod, point.azimuthDegrees, distanceMeters)),
          width: 3,
          material: new PolylineDashMaterialProperty({
            color: COLORS[track.id].withAlpha(0.88),
            dashLength: 12,
          }),
          clampToGround: mapViewMode === "2d",
        },
      });
    });

    for (const point of track.points) {
      if (
        point.altitudeDegrees < -1 ||
        !point.showTimeLabel
      ) continue;
      viewer.entities.add({
        id: `${PREFIX}${track.id}-time-${point.timestampMilliseconds}`,
        position: mapViewMode === "3d"
          ? celestialRayTarget(origin, point)
          : destinationGroundPoint(tripod, point.azimuthDegrees, distanceMeters),
        point: {
          pixelSize: 5,
          color: COLORS[track.id],
          outlineColor: Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: point.timeLabel,
          font: "bold 11px sans-serif",
          fillColor: COLORS[track.id],
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, -10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }

  for (const point of points) {
    if (
      !visibility[point.id] ||
      point.altitudeDegrees < -2
    ) {
      continue;
    }

    const target = mapViewMode === "3d"
      ? celestialRayTarget(origin, point)
      : destinationPoint(
          tripod,
          point.azimuthDegrees,
          Math.max(-1, Math.min(45, point.altitudeDegrees)),
          distanceMeters
        );
    const color = COLORS[point.id];
    const positionOnly = mapViewMode === "3d" &&
      isCelestialOcclusionConfirmedHidden(occlusion[point.id]);
    const displayLabel = positionOnly ? `${point.label}の位置` : point.label;
    viewer.entities.add({
      id: `${PREFIX}${point.id}`,
      name: displayLabel,
      position: target,
      point: {
        pixelSize: positionOnly ? 7 : point.id === "polaris" ? 18 : 15,
        color: positionOnly ? color.withAlpha(.42) : color,
        outlineColor: positionOnly ? Color.WHITE.withAlpha(.75) : Color.BLACK,
        outlineWidth: positionOnly ? 1 : 3,
        disableDepthTestDistance: positionOnly || mapViewMode === "2d"
          ? Number.POSITIVE_INFINITY
          : 0,
        scaleByDistance: new NearFarScalar(100, 1.5, 2_000_000, 0.7),
      },
      label: {
        text: displayLabel,
        font: positionOnly ? "12px sans-serif" : "bold 15px sans-serif",
        fillColor: positionOnly ? Color.WHITE.withAlpha(.75) : Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: positionOnly ? 2 : 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, positionOnly ? -10 : -18),
        disableDepthTestDistance: positionOnly || mapViewMode === "2d"
          ? Number.POSITIVE_INFINITY
          : 0,
      },
    });

  }

  if (visibility.milkyWay) {
    contiguousMilkyWaySegments(milkyWayPath).forEach((segment, segmentIndex) => {
      const centerPositions = segment.map((point) => mapViewMode === "3d"
        ? celestialRayTarget(origin, point)
        : destinationPoint(
            tripod,
            point.azimuthDegrees,
            Math.max(-2, Math.min(45, point.altitudeDegrees)),
            distanceMeters
          ));
      const northEdgePositions = segment.map((point) => mapViewMode === "3d"
        ? celestialRayTarget(origin, {
            azimuthDegrees: point.northEdgeAzimuthDegrees,
            altitudeDegrees: point.northEdgeAltitudeDegrees,
          })
        : destinationPoint(
            tripod,
            point.northEdgeAzimuthDegrees,
            Math.max(-2, Math.min(45, point.northEdgeAltitudeDegrees)),
            distanceMeters
          ));
      const southEdgePositions = segment.map((point) => mapViewMode === "3d"
        ? celestialRayTarget(origin, {
            azimuthDegrees: point.southEdgeAzimuthDegrees,
            altitudeDegrees: point.southEdgeAltitudeDegrees,
          })
        : destinationPoint(
            tripod,
            point.southEdgeAzimuthDegrees,
            Math.max(-2, Math.min(45, point.southEdgeAltitudeDegrees)),
            distanceMeters
          ));
      // 天の川は「紫の点線」ではなく、写真の銀河面に近い自然色の連続帯として示す。
      // 3D地図では地形を隠さないよう幅と不透明度を抑え、中心方向だけを明確にする。
      viewer.entities.add({
        id: `${PREFIX}milkyWay-band-wide-${segmentIndex}`,
        polyline: {
          positions: centerPositions,
          width: 9,
          material: Color.fromCssColorString("#9aa8b8").withAlpha(0.11),
          clampToGround: false,
        },
      });
      viewer.entities.add({
        id: `${PREFIX}milkyWay-band-body-${segmentIndex}`,
        polyline: {
          positions: centerPositions,
          width: 5,
          material: Color.fromCssColorString("#d7d1c7").withAlpha(0.22),
          clampToGround: false,
        },
      });
      viewer.entities.add({
        id: `${PREFIX}milkyWay-band-core-${segmentIndex}`,
        polyline: {
          positions: centerPositions,
          width: 1.4,
          material: Color.fromCssColorString("#f3e7d4").withAlpha(0.70),
          clampToGround: false,
        },
      });
      [northEdgePositions, southEdgePositions].forEach((positions, edgeIndex) => {
        viewer.entities.add({
          id: `${PREFIX}milkyWay-band-edge-${segmentIndex}-${edgeIndex}`,
          polyline: {
            positions,
            width: 0.7,
            material: Color.fromCssColorString("#b7c1cc").withAlpha(0.20),
            clampToGround: false,
          },
        });
      });
    });
  }
}
