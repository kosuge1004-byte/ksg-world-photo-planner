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
  fastMode: boolean;
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
  outline: string;
  northEdge: string;
  southEdge: string;
  center: string;
};

function milkyWayBandSegments(
  points: MilkyWayPathPoint[],
  lineOfSightVisible: boolean
): MilkyWayBandSegment[] {
  const segments: MilkyWayBandSegment[] = [];
  let current: MilkyWayPathPoint[] = [];
  const flush = () => {
    if (current.length > 1) {
      const north = current.map(
        (point) => `${point.northEdgeXPercent},${point.northEdgeYPercent}`
      );
      const south = current.map(
        (point) => `${point.southEdgeXPercent},${point.southEdgeYPercent}`
      );
      segments.push({
        outline: north.concat([...south].reverse()).join(" "),
        northEdge: north.join(" "),
        southEdge: south.join(" "),
        center: current.map(
          (point) => `${point.xPercent},${point.yPercent}`
        ).join(" "),
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
  fastMode,
}: Props) {
  const milkyWaySegments = milkyWayBandSegments(milkyWayPath, true);
  const hiddenMilkyWaySegments = milkyWayBandSegments(milkyWayPath, false);

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
      data-occlusion-polaris-state={occlusion.polaris?.verificationState ?? "checking"}
      data-occlusion-milky-way-state={occlusion.milkyWay?.verificationState ?? "checking"}
    >
      <svg className="celestial-track-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
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
            <linearGradient id="milky-way-base" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#a9b9cf" stopOpacity="0.08" />
              <stop offset="0.35" stopColor="#f2e5d3" stopOpacity="0.34" />
              <stop offset="0.5" stopColor="#fff7e9" stopOpacity="0.72" />
              <stop offset="0.68" stopColor="#c7d3df" stopOpacity="0.28" />
              <stop offset="1" stopColor="#8aa0bc" stopOpacity="0.06" />
            </linearGradient>
            <filter id="milky-way-clouds" x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence type="fractalNoise" baseFrequency="0.11 0.025" numOctaves="4" seed="23" result="noise" />
              <feColorMatrix in="noise" type="saturate" values="0" result="mono" />
              <feComponentTransfer in="mono" result="contrast">
                <feFuncR type="gamma" amplitude="1.25" exponent="1.8" offset="-0.08" />
                <feFuncG type="gamma" amplitude="1.18" exponent="1.7" offset="-0.07" />
                <feFuncB type="gamma" amplitude="1.1" exponent="1.6" offset="-0.05" />
                <feFuncA type="table" tableValues="0 0.15 0.55 0.9" />
              </feComponentTransfer>
              <feBlend in="SourceGraphic" in2="contrast" mode="screen" />
            </filter>
          </defs>
          {milkyWaySegments.map((segment, index) => (
            <g key={`visible-${index}`}>
              <polygon className="milky-way-photo-band" points={segment.outline} fill="url(#milky-way-base)" filter="url(#milky-way-clouds)" />
            </g>
          ))}
          {milkyWayPath.filter((point, index) => point.visibleInFrame && index % 9 === 0).map((point, index) => {
            const visible = point.lineOfSightVisible !== false;
            const width = Math.hypot(
              point.northEdgeXPercent - point.southEdgeXPercent,
              point.northEdgeYPercent - point.southEdgeYPercent
            );
            return (
              <circle
                key={`milky-way-marker-${index}`}
                className={visible ? "milky-way-position-marker visible" : "milky-way-position-marker hidden"}
                cx={point.xPercent}
                cy={point.yPercent}
                r={Math.max(0.55, Math.min(3.2, width * 0.22))}
              />
            );
          })}
        </svg>
      )}

      {points.map((point) => {
        const offscreenPosition =
          !point.visibleInFrame &&
          point.inFront === true &&
          point.altitudeDegrees > -1 &&
          point.id !== "milkyWay";
        if (
          (point.id === "milkyWay" && !fastMode) ||
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
        const markerStyle = offscreenPosition
          ? offscreenPositionStyle(point)
          : physicalDisc
            ? discStyle(point)
            : { left: `${point.xPercent}%`, top: `${point.yPercent}%` };

        return (
          <div
            key={point.id}
            className={`celestial-marker celestial-${point.id}${
              physicalDisc ? " celestial-physical-marker" : ""
            }${positionOnly ? " celestial-hidden-position" : ""}${
              offscreenPosition ? " celestial-offscreen-position" : ""
            }${
              fastMode && point.id === "milkyWay" ? " celestial-fast-position" : ""
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
