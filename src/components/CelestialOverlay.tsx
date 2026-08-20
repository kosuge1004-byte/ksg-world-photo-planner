import { memo } from "react";
import type {
  CelestialScreenPoint,
  CelestialOcclusionMap,
  CelestialTrack,
  CelestialVisibility,
  MilkyWayPathPoint,
} from "../types/celestial";
import { isCelestialOcclusionConfirmedHidden } from "../types/celestial";

type Props = {
  points: CelestialScreenPoint[];
  tracks: CelestialTrack[];
  milkyWayPath: MilkyWayPathPoint[];
  visibility: CelestialVisibility;
  occlusion: CelestialOcclusionMap;
  /** 実際に見えている天体の円盤・ドットにだけ適用する透明度（0-1）。
   * 画面外インジケーター（点線の丸）や、地形等で隠れていることを示す表示は
   * 常に完全な不透明度のまま維持する（薄くすると視認できなくなるため）。 */
  discOpacity?: number;
};

const MOON_MARIA = [
  { id: "procellarum", longitude: -57, latitude: 18, radiusX: 18, radiusY: 22 },
  { id: "imbrium", longitude: -15, latitude: 32, radiusX: 15, radiusY: 13 },
  { id: "serenitatis", longitude: 18, latitude: 28, radiusX: 11, radiusY: 10 },
  { id: "tranquillitatis", longitude: 31, latitude: 8, radiusX: 13, radiusY: 11 },
  { id: "crisium", longitude: 59, latitude: 17, radiusX: 9, radiusY: 8 },
  { id: "fecunditatis", longitude: 51, latitude: -8, radiusX: 11, radiusY: 13 },
  { id: "nectaris", longitude: 35, latitude: -16, radiusX: 7, radiusY: 7 },
  { id: "nubium", longitude: -17, latitude: -21, radiusX: 11, radiusY: 9 },
  { id: "humorum", longitude: -39, latitude: -24, radiusX: 8, radiusY: 8 },
  { id: "frigoris", longitude: 0, latitude: 56, radiusX: 20, radiusY: 5 },
] as const;

function discStyle(point: CelestialScreenPoint): React.CSSProperties {
  return {
    left: `${point.xPercent}%`,
    top: `${point.yPercent}%`,
    width: `${Math.max(0, point.diameterWidthPercent ?? 0)}%`,
    height: `${Math.max(0, point.diameterHeightPercent ?? 0)}%`,
  };
}

function offscreenPositionStyle(point: CelestialScreenPoint): React.CSSProperties {
  return {
    // 端へ寄せすぎると「月の位置」ラベルがフレーム操作ボタンや画面外へ隠れる。
    left: `${Math.max(16, Math.min(84, point.xPercent))}%`,
    top: `${Math.max(14, Math.min(84, point.yPercent))}%`,
  };
}

function moonPhasePath(point: CelestialScreenPoint): string {
  const phaseAngle = Math.max(
    0,
    Math.min(
      180,
      point.phaseAngleDegrees ??
        Math.acos(2 * (point.illuminationFraction ?? 0) - 1) * 180 / Math.PI
    )
  );
  const terminatorScale = Math.cos(phaseAngle * Math.PI / 180);
  const samples = 48;
  const rightLimb = Array.from({ length: samples + 1 }, (_, index) => {
    const y = -1 + 2 * index / samples;
    const x = Math.sqrt(Math.max(0, 1 - y * y));
    return `${50 + x * 49},${50 + y * 49}`;
  });
  const terminator = Array.from({ length: samples + 1 }, (_, index) => {
    const y = 1 - 2 * index / samples;
    const x = -terminatorScale * Math.sqrt(Math.max(0, 1 - y * y));
    return `${50 + x * 49},${50 + y * 49}`;
  });
  return `M ${rightLimb.concat(terminator).join(" L ")} Z`;
}

function projectedMoonMaria(point: CelestialScreenPoint) {
  const subEarthLongitude = (point.librationLongitudeDegrees ?? 0) * Math.PI / 180;
  const subEarthLatitude = (point.librationLatitudeDegrees ?? 0) * Math.PI / 180;
  return MOON_MARIA.flatMap((mare) => {
    const longitude = mare.longitude * Math.PI / 180;
    const latitude = mare.latitude * Math.PI / 180;
    const longitudeDelta = longitude - subEarthLongitude;
    const cosineLatitude = Math.cos(latitude);
    const x = cosineLatitude * Math.sin(longitudeDelta);
    const y =
      Math.sin(latitude) * Math.cos(subEarthLatitude) -
      cosineLatitude * Math.cos(longitudeDelta) * Math.sin(subEarthLatitude);
    const visibility =
      Math.sin(latitude) * Math.sin(subEarthLatitude) +
      cosineLatitude * Math.cos(longitudeDelta) * Math.cos(subEarthLatitude);
    if (visibility <= 0) return [];
    const foreshortening = Math.max(0.22, Math.sqrt(visibility));
    return [{
      ...mare,
      x: 50 + x * 49,
      y: 50 - y * 49,
      radiusX: mare.radiusX / 90 * 49 * foreshortening,
      radiusY: mare.radiusY / 90 * 49 * foreshortening,
      opacity: 0.3 + 0.32 * visibility,
    }];
  });
}

type MilkyWayBandSegment = {
  outer: string;
  body: string;
  inner: string;
  darkLane: string;
  center: string;
};

function milkyWayCrossPoint(point: MilkyWayPathPoint, ratio: number): PreviewPoint {
  return {
    x: point.southEdgeXPercent + (point.northEdgeXPercent - point.southEdgeXPercent) * ratio,
    y: point.southEdgeYPercent + (point.northEdgeYPercent - point.southEdgeYPercent) * ratio,
  };
}

function milkyWayStrip(points: MilkyWayPathPoint[], southRatio: number, northRatio: number): string {
  const north = points.map((point) => milkyWayCrossPoint(point, northRatio));
  const south = points.map((point) => milkyWayCrossPoint(point, southRatio));
  return north
    .concat([...south].reverse())
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
}

function milkyWayBandSegments(
  points: MilkyWayPathPoint[],
  lineOfSightVisible: boolean
): MilkyWayBandSegment[] {
  const segments: MilkyWayBandSegment[] = [];
  let current: MilkyWayPathPoint[] = [];
  const flush = () => {
    if (current.length > 1) {
      segments.push({
        outer: milkyWayStrip(current, 0.06, 0.94),
        body: milkyWayStrip(current, 0.18, 0.82),
        inner: milkyWayStrip(current, 0.31, 0.69),
        darkLane: milkyWayStrip(current, 0.46, 0.56),
        center: current.map((point) => `${point.xPercent},${point.yPercent}`).join(" "),
      });
    }
    current = [];
  };
  for (const point of points) {
    if (
      !point.visibleInFrame ||
      (lineOfSightVisible
        ? point.lineOfSightVisible === false
        : point.lineOfSightVisible !== false)
    ) {
      flush();
      continue;
    }
    current.push(point);
  }
  flush();
  return segments;
}

type MilkyWayStar = { x: number; y: number; radius: number; opacity: number; warm: boolean };

function deterministicFraction(value: number): number {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type StarSeed = {
  across: number;
  alongJitter: number;
  radiusFraction: number;
  opacityFraction: number;
  warm: boolean;
};

// 星の「散らばり方」（銀経・インデックスだけで決まり、カメラ位置には依存しない
// 疑似乱数由来の値）をキャッシュする。ドラッグ中に同じ銀経値が毎フレーム
// 再登場するため、Math.sinベースの計算をフレームごとに繰り返さずに済む。
// 実際の画面位置（帯の形・カメラ投影に依存する部分）は毎フレーム計算し直す
// ため、精度・見た目には一切影響しない。
const starSeedCache = new Map<string, StarSeed>();

function starSeedFor(galacticLongitudeDegrees: number, index: number): StarSeed {
  const key = `${galacticLongitudeDegrees}:${index}`;
  const cached = starSeedCache.get(key);
  if (cached) return cached;
  const seed = galacticLongitudeDegrees * 11 + index * 37;
  const computed: StarSeed = {
    across: 0.16 + deterministicFraction(seed + 1) * 0.68,
    alongJitter: (deterministicFraction(seed + 2) - 0.5) * 1.8,
    radiusFraction: deterministicFraction(seed + 3),
    opacityFraction: deterministicFraction(seed + 4),
    warm: deterministicFraction(seed + 5) > 0.72,
  };
  starSeedCache.set(key, computed);
  return computed;
}

function milkyWayStars(points: MilkyWayPathPoint[]): MilkyWayStar[] {
  const stars: MilkyWayStar[] = [];
  for (const point of points) {
    if (!point.visibleInFrame || point.lineOfSightVisible === false) continue;
    const coreDistance = Math.min(
      point.galacticLongitudeDegrees,
      360 - point.galacticLongitudeDegrees
    );
    const coreBoost = Math.exp(-((coreDistance / 42) ** 2));
    const count = coreBoost > 0.45 ? 6 : 3;
    for (let index = 0; index < count; index += 1) {
      const { across, alongJitter, radiusFraction, opacityFraction, warm } =
        starSeedFor(point.galacticLongitudeDegrees, index);
      const cross = milkyWayCrossPoint(point, across);
      const edgeDx = point.northEdgeXPercent - point.southEdgeXPercent;
      const edgeDy = point.northEdgeYPercent - point.southEdgeYPercent;
      const edgeLength = Math.max(0.001, Math.hypot(edgeDx, edgeDy));
      const tangentX = -edgeDy / edgeLength;
      const tangentY = edgeDx / edgeLength;
      stars.push({
        x: cross.x + tangentX * alongJitter,
        y: cross.y + tangentY * alongJitter,
        radius: 0.07 + radiusFraction * (0.12 + coreBoost * 0.08),
        opacity: 0.34 + opacityFraction * (0.38 + coreBoost * 0.18),
        warm,
      });
    }
  }
  return stars;
}

function milkyWayCorePoint(points: MilkyWayPathPoint[]): MilkyWayPathPoint | null {
  let best: MilkyWayPathPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (!point.visibleInFrame || point.lineOfSightVisible === false) continue;
    const distance = Math.min(point.galacticLongitudeDegrees, 360 - point.galacticLongitudeDegrees);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return bestDistance <= 32 ? best : null;
}

type PreviewPoint = { x: number; y: number };

function clipSegmentToPreview(
  start: PreviewPoint,
  end: PreviewPoint
): [PreviewPoint, PreviewPoint] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  const boundaries = [
    [-dx, start.x],
    [dx, 100 - start.x],
    [-dy, start.y],
    [dy, 100 - start.y],
  ] as const;
  for (const [direction, distance] of boundaries) {
    if (Math.abs(direction) < 1e-9) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return null;
  }
  return [
    { x: start.x + dx * minimum, y: start.y + dy * minimum },
    { x: start.x + dx * maximum, y: start.y + dy * maximum },
  ];
}

function trackSegments(track: CelestialTrack): string[] {
  const segments: PreviewPoint[][] = [];
  let current: PreviewPoint[] = [];
  const flush = () => {
    if (current.length > 1) segments.push(current);
    current = [];
  };

  for (let index = 1; index < track.points.length; index += 1) {
    const previous = track.points[index - 1];
    const point = track.points[index];
    if (
      !previous.inFront ||
      !point.inFront ||
      previous.altitudeDegrees < -1 ||
      point.altitudeDegrees < -1
    ) {
      flush();
      continue;
    }
    const clipped = clipSegmentToPreview(
      { x: previous.xPercent, y: previous.yPercent },
      { x: point.xPercent, y: point.yPercent }
    );
    if (!clipped) {
      flush();
      continue;
    }
    const [start, end] = clipped;
    const last = current.at(-1);
    if (!last || Math.hypot(last.x - start.x, last.y - start.y) > 0.1) {
      flush();
      current.push(start);
    }
    current.push(end);
  }
  flush();
  return segments.map((segment) =>
    segment.map((point) => `${point.x},${point.y}`).join(" ")
  );
}

function CelestialOverlayComponent({
  points,
  tracks,
  milkyWayPath,
  visibility,
  occlusion,
  discOpacity = 1,
}: Props) {
  const milkyWaySegments = milkyWayBandSegments(milkyWayPath, true);
  const hiddenMilkyWaySegments = milkyWayBandSegments(milkyWayPath, false);
  const milkyWayStarField = milkyWayStars(milkyWayPath);
  const milkyWayCore = milkyWayCorePoint(milkyWayPath);

  return (
    <div
      className="celestial-overlay"
      aria-hidden="true"
      data-occlusion-sun={occlusion.sun?.reason ?? "pending"}
      data-occlusion-moon={occlusion.moon?.reason ?? "pending"}
      data-occlusion-polaris={occlusion.polaris?.reason ?? "pending"}
      data-occlusion-milky-way={occlusion.milkyWay?.reason ?? "pending"}
      data-occlusion-sun-state={occlusion.sun?.verificationState ?? "checking"}
      data-occlusion-moon-state={occlusion.moon?.verificationState ?? "checking"}
      data-occlusion-moon-apparent-altitude={occlusion.moon?.celestialApparentAltitudeDegrees}
      data-occlusion-moon-geometric-altitude={occlusion.moon?.celestialGeometricAltitudeDegrees}
      data-occlusion-moon-terrain-elevation={occlusion.moon?.obstructionElevationDegrees}
      data-occlusion-moon-terrain-clearance={occlusion.moon?.terrainClearanceDegrees}
      data-occlusion-moon-obstruction-distance={occlusion.moon?.obstructionDistanceMeters}
      data-occlusion-moon-terrain-source={occlusion.moon?.terrainDataSource}
      data-occlusion-moon-failure={occlusion.moon?.failureMessage}
      data-occlusion-polaris-state={occlusion.polaris?.verificationState ?? "checking"}
      data-occlusion-milky-way-state={occlusion.milkyWay?.verificationState ?? "checking"}
    >
      <svg className="celestial-track-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <g className="celestial-track-line-group">
          {tracks.map((track) => {
            if (!visibility[track.id]) return null;
            return trackSegments(track).map((segment, index) => (
              <polyline
                key={`${track.id}-${index}`}
                className={`celestial-track-line track-${track.id}`}
                points={segment}
              />
            ));
          })}
        </g>
      </svg>

      {tracks.flatMap((track) => {
        if (!visibility[track.id]) return [];
        return track.points
          .filter((point) => point.visibleInFrame && point.showTimeLabel)
          .map((point) => (
            <span
              key={`${track.id}-${point.timestampMilliseconds}`}
              className={`celestial-track-time track-time-${track.id}`}
              style={{ left: `${point.xPercent}%`, top: `${point.yPercent}%` }}
            >
              {point.timeLabel}
            </span>
          ));
      })}

      {visibility.milkyWay && (milkyWaySegments.length > 0 || hiddenMilkyWaySegments.length > 0) && (
        <svg className="milky-way-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <radialGradient id="milky-way-core-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#fff5df" stopOpacity="0.72" />
              <stop offset="0.28" stopColor="#e9d7bd" stopOpacity="0.32" />
              <stop offset="0.68" stopColor="#9fb0c5" stopOpacity="0.08" />
              <stop offset="1" stopColor="#8799ad" stopOpacity="0" />
            </radialGradient>
          </defs>
          {milkyWaySegments.map((segment, index) => (
            <g key={`visible-${index}`} className="milky-way-natural-segment">
              <polygon className="milky-way-ribbon-outer" points={segment.outer} />
              <polygon className="milky-way-ribbon-body" points={segment.body} />
              <polygon className="milky-way-ribbon-inner" points={segment.inner} />
              <polygon className="milky-way-ribbon-dark-lane" points={segment.darkLane} />
              <polyline className="milky-way-center-highlight" points={segment.center} />
            </g>
          ))}
          {hiddenMilkyWaySegments.map((segment, index) => (
            <g key={`hidden-${index}`} className="milky-way-natural-segment hidden">
              <polygon className="milky-way-ribbon-outer" points={segment.outer} />
              <polyline className="milky-way-center-highlight" points={segment.center} />
            </g>
          ))}
          {milkyWayCore && (() => {
            const width = Math.max(3.5, Math.min(18, Math.hypot(
              milkyWayCore.northEdgeXPercent - milkyWayCore.southEdgeXPercent,
              milkyWayCore.northEdgeYPercent - milkyWayCore.southEdgeYPercent
            ) * 1.15));
            return (
              <ellipse
                className="milky-way-core-glow"
                cx={milkyWayCore.xPercent}
                cy={milkyWayCore.yPercent}
                rx={width}
                ry={Math.max(2.2, width * 0.42)}
                fill="url(#milky-way-core-glow)"
              />
            );
          })()}
          <g className="milky-way-star-field">
            {milkyWayStarField.map((star, index) => (
              <circle
                key={`mw-star-${index}`}
                className={star.warm ? "milky-way-star warm" : "milky-way-star"}
                cx={star.x}
                cy={star.y}
                r={star.radius}
                opacity={star.opacity}
              />
            ))}
          </g>
        </svg>
      )}

      {points.map((point) => {
        const offscreenPosition =
          !point.visibleInFrame &&
          point.inFront === true &&
          point.altitudeDegrees > -1 &&
          point.id !== "milkyWay";
        if (
          (point.id === "milkyWay") ||
          !visibility[point.id] ||
          (!point.visibleInFrame && !offscreenPosition)
        ) {
          return null;
        }

        const physicalDisc = point.id === "sun" || point.id === "moon";
        const hiddenByScene = isCelestialOcclusionConfirmedHidden(
          occlusion[point.id]
        );
        const positionOnly = hiddenByScene || offscreenPosition;
        // 画面外インジケーターの位置は表示枠内へ寄せるが、太陽・月であれば
        // 大きさは実際の視直径をそのまま使う（北極星は点光源のため対象外）。
        const markerStyle: React.CSSProperties = offscreenPosition
          ? {
              ...offscreenPositionStyle(point),
              ...(physicalDisc
                ? {
                    width: `${Math.max(0, point.diameterWidthPercent ?? 0)}%`,
                    height: `${Math.max(0, point.diameterHeightPercent ?? 0)}%`,
                  }
                : {}),
            }
          : physicalDisc
            ? discStyle(point)
            : { left: `${point.xPercent}%`, top: `${point.yPercent}%` };
        // 透明度は「実際に見えている円盤・ドット」にだけ効かせる。画面外
        // インジケーターや隠れ表示は、薄くすると見えなくなるため対象外にする。
        if (!positionOnly) {
          markerStyle.opacity = discOpacity;
        }

        return (
          <div
            key={point.id}
            className={`celestial-marker celestial-${point.id}${
              physicalDisc ? " celestial-physical-marker" : ""
            }${positionOnly ? " celestial-hidden-position" : ""}${
              offscreenPosition ? " celestial-offscreen-position" : ""
            }`}
            style={markerStyle}
          >
            {positionOnly ? (
              <span className="celestial-hidden-dot" />
            ) : point.id === "moon" ? (
              <svg className="celestial-physical-disc moon-disc" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <clipPath id="moon-disc-clip"><circle cx="50" cy="50" r="49" /></clipPath>
                  <mask id="moon-phase-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                    <rect width="100" height="100" fill="black" />
                    <g transform={`rotate(${point.brightLimbAngleDegrees ?? 0} 50 50)`}>
                      <path fill="white" d={moonPhasePath(point)} />
                    </g>
                  </mask>
                </defs>
                <circle className="moon-shadow" cx="50" cy="50" r="49" />
                <g clipPath="url(#moon-disc-clip)" mask="url(#moon-phase-mask)">
                  <circle className="moon-light-surface" cx="50" cy="50" r="49" />
                  <g transform={`rotate(${(point.moonNorthAngleDegrees ?? -90) + 90} 50 50)`}>
                    {projectedMoonMaria(point).map((mare) => (
                      <ellipse
                        key={mare.id}
                        className="moon-mare"
                        cx={mare.x}
                        cy={mare.y}
                        rx={mare.radiusX}
                        ry={mare.radiusY}
                        opacity={mare.opacity}
                      />
                    ))}
                    <circle className="moon-crater-tycho" cx="44" cy="72" r="2.3" />
                  </g>
                </g>
                <circle className="moon-limb" cx="50" cy="50" r="49" />
              </svg>
            ) : point.id === "sun" ? (
              <svg className="celestial-physical-disc sun-disc" viewBox="0 0 100 100" preserveAspectRatio="none">
                <circle cx="50" cy="50" r="48" />
              </svg>
            ) : (
              <span className="celestial-dot" />
            )}
            <span className="celestial-label">
              {positionOnly ? `${point.label}の位置` : point.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const CelestialOverlay = memo(CelestialOverlayComponent);
