import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
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
import type { TripodSearchBaseLine } from "./tripodSearchLine";
import type { GroundPoint } from "../types/points";
import { celestialWorldDirection } from "./celestialOcclusion";

const PREFIX = "ksg-celestial-map-";
const EARTH_RADIUS_METERS = 6_371_008.8;
const CELESTIAL_RAY_DISTANCE_METERS = 1_000_000;
const entityCache = new WeakMap<Viewer, {
  trackKey: string;
  candidateKey: string;
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
}

const COLORS = {
  sun: Color.GOLD,
  moon: Color.LIGHTCYAN,
  milkyWay: Color.MEDIUMPURPLE,
  polaris: Color.WHITE,
} as const;

function destinationPoint(
  origin: GroundPoint,
  azimuthDegrees: number,
  altitudeDegrees: number,
  distanceMeters: number
): Cartesian3 {
  const bearing = (azimuthDegrees * Math.PI) / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const lat1 = (origin.latitude * Math.PI) / 180;
  const lon1 = (origin.longitude * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  const height =
    origin.height +
    Math.tan((altitudeDegrees * Math.PI) / 180) * distanceMeters;

  return Cartesian3.fromRadians(lon2, lat2, height);
}

function destinationGroundPoint(
  origin: GroundPoint,
  azimuthDegrees: number,
  distanceMeters: number
): Cartesian3 {
  const bearing = (azimuthDegrees * Math.PI) / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const lat1 = (origin.latitude * Math.PI) / 180;
  const lon1 = (origin.longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
  return Cartesian3.fromRadians(lon2, lat2, origin.height + 1);
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
  const requiresVerifiedLineOfSight = path.some(
    (point) => point.lineOfSightVisible !== undefined
  );
  for (const point of path) {
    const visible = (
      Math.max(
        point.altitudeDegrees,
        point.northEdgeAltitudeDegrees,
        point.southEdgeAltitudeDegrees
      ) > -6 &&
      (!requiresVerifiedLineOfSight || point.lineOfSightVisible === true)
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
  lensCenterHeightMeters: number
): void {
  const trackKey = JSON.stringify({
    mapViewMode,
    tripod: tripod && [tripod.latitude, tripod.longitude, tripod.height],
    lensCenterHeightMeters,
    visibility,
    tracks: tracks.map((track) => [
      track.id,
      track.points.length,
      track.points[0]?.timestampMilliseconds,
      track.points.at(-1)?.timestampMilliseconds,
    ]),
  });
  const candidateKey = JSON.stringify({
    subject: subject && [subject.latitude, subject.longitude, subject.height],
    visibility,
    candidates: tripodCandidates.map((candidate) => [
      candidate.id,
      candidate.latitude,
      candidate.longitude,
      candidate.height,
    ]),
  });
  const previousCache = entityCache.get(viewer);
  const replaceTracks = previousCache?.trackKey !== trackKey;
  const replaceCandidates = previousCache?.candidateKey !== candidateKey;

  for (const entity of [...viewer.entities.values]) {
    if (typeof entity.id === "string" && entity.id.startsWith(PREFIX)) {
      const isTrack = entity.id.includes("-track-") || entity.id.includes("-time-");
      const isCandidate = entity.id.includes("-tripod-candidate");
      const isSharedGroundLine = entity.id.includes("-tripod-search-base-line");
      // 基礎ラインはCallbackPropertyの座標だけを更新し、Entityを再生成しない。
      if (
        isSharedGroundLine ||
        (isTrack && !replaceTracks) ||
        (isCandidate && !replaceCandidates)
      ) {
        continue;
      }
      viewer.entities.remove(entity);
    }
  }

  if (!tripod) {
    updateSharedGroundLines(viewer, []);
    entityCache.delete(viewer);
    return;
  }
  entityCache.set(viewer, { trackKey, candidateKey });

  const origin = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + lensCenterHeightMeters
  );
  const distanceMeters = 1500;
  updateSharedGroundLines(viewer, tripodSearchLines);

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
      occlusion[point.id]?.visible !== true;
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

    viewer.entities.add({
      id: `${PREFIX}${point.id}-line`,
      polyline: {
        positions: [origin, target],
        width: positionOnly ? 1 : 2,
        material: positionOnly
          ? new PolylineDashMaterialProperty({
              color: color.withAlpha(.38),
              dashLength: 8,
            })
          : color.withAlpha(0.55),
        clampToGround: false,
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
      viewer.entities.add({
        id: `${PREFIX}milkyWay-band-wide-${segmentIndex}`,
        polyline: {
          positions: centerPositions,
          width: 12,
          material: Color.MEDIUMPURPLE.withAlpha(0.18),
          clampToGround: false,
        },
      });
      viewer.entities.add({
        id: `${PREFIX}milkyWay-band-core-${segmentIndex}`,
        polyline: {
          positions: centerPositions,
          width: 3,
          material: new PolylineDashMaterialProperty({
            color: Color.MEDIUMPURPLE.withAlpha(0.9),
            dashLength: 14,
          }),
          clampToGround: false,
        },
      });
      [northEdgePositions, southEdgePositions].forEach((positions, edgeIndex) => {
        viewer.entities.add({
          id: `${PREFIX}milkyWay-band-edge-${segmentIndex}-${edgeIndex}`,
          polyline: {
            positions,
            width: 1.5,
            material: new PolylineDashMaterialProperty({
              color: Color.MEDIUMPURPLE.withAlpha(0.65),
              dashLength: 9,
            }),
            clampToGround: false,
          },
        });
      });
    });
  }

  if (subject && replaceCandidates) {
    for (const candidate of tripodCandidates) {
      if (!visibility[candidate.id]) continue;
      const color = COLORS[candidate.id];
      const target = Cartesian3.fromDegrees(
        candidate.longitude,
        candidate.latitude,
        candidate.height + 0.2
      );
      // 候補点は共通基礎ライン上に載せる。候補専用ラインは作らず二重描画を防ぐ。
      viewer.entities.add({
        id: `${PREFIX}${candidate.id}-tripod-candidate`,
        name: `${candidate.label} 三脚候補`,
        position: target,
        point: {
          pixelSize: 11,
          color,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${candidate.label} 三脚候補\n${Math.round(candidate.distanceMeters)}m`,
          font: "bold 12px sans-serif",
          fillColor: color,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -13),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
}
