import type { CSSProperties } from "react";

import type {
  CelestialScreenPoint,
  CelestialTrack,
  CelestialTrackPoint,
  CelestialVisibility,
  MilkyWayPathPoint,
  TripodCandidate,
} from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { ForegroundObject } from "../types/foreground";
import type { TripodSearchBaseLine } from "../cesium/tripodSearchLine";
import {
  coordinatesAtMapPixel,
  projectCoordinatesToMapPixel,
} from "../map/webMercator";
import type { MapPixelPoint, MapSize } from "../map/webMercator";


type Props = {
  center: Pick<GroundPoint, "latitude" | "longitude">;
  zoom: number;
  size: MapSize;
  subject: GroundPoint | null;
  tripod: GroundPoint | null;
  tripodSubjectDistanceMeters: number | null;
  points: CelestialScreenPoint[];
  tracks: CelestialTrack[];
  milkyWayPath: MilkyWayPathPoint[];
  visibility: CelestialVisibility;
  candidates: TripodCandidate[];
  tripodSearchLines: TripodSearchBaseLine[];
  foregroundObject: ForegroundObject | null;
  foregroundEditing: boolean;
  onMoveForeground: (coordinates: { latitude: number; longitude: number }) => void;
  onSelectCandidate: (candidate: TripodCandidate) => void;
};

function projectToSkyDome(
  origin: MapPixelPoint,
  azimuthDegrees: number,
  altitudeDegrees: number,
  radius: number
): MapPixelPoint {
  const azimuthRadians = azimuthDegrees * Math.PI / 180;
  // Sun Surveyor型の天空ドーム表示。天頂を中心、地平線を外周へ正距方位投影する。
  const zenithDistance =
    (90 - Math.max(0, Math.min(90, altitudeDegrees))) / 90;
  const projectedRadius = radius * zenithDistance;
  return {
    x: origin.x + Math.sin(azimuthRadians) * projectedRadius,
    y: origin.y - Math.cos(azimuthRadians) * projectedRadius,
  };
}

function pointsAttribute(points: MapPixelPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function pinStyle(point: MapPixelPoint): CSSProperties {
  return { left: point.x, top: point.y };
}

function isInside(point: MapPixelPoint, size: MapSize): boolean {
  return (
    point.x >= -30 &&
    point.x <= size.width + 30 &&
    point.y >= -30 &&
    point.y <= size.height + 30
  );
}

function extendRayPastTarget(
  origin: MapPixelPoint,
  target: MapPixelPoint,
  size: MapSize
): MapPixelPoint {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return target;
  // SVG側で画面端にクリップさせ、候補点を越えて同じ方位へ続く線として見せる。
  const extension = Math.hypot(size.width, size.height) * 4;
  return {
    x: origin.x + dx / length * extension,
    y: origin.y + dy / length * extension,
  };
}

function isClearOfMapControls(point: MapPixelPoint, size: MapSize): boolean {
  if (!isInside(point, size)) return false;
  if (point.x < 58) return false;
  if (point.x < 190 && point.y < 62) return false;
  if (point.x > size.width - 78 && point.y < 82) return false;
  if (point.x > size.width - 78 && point.y > size.height - 132) return false;
  return true;
}

function contiguousVisibleSegments(track: CelestialTrack): CelestialTrackPoint[][] {
  const segments: CelestialTrack["points"][] = [];
  let current: CelestialTrack["points"] = [];
  for (const point of track.points) {
    if (point.altitudeDegrees < 0) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function skyDomeRadius(size: MapSize): number {
  return Math.max(72, Math.min(size.width * 0.4, size.height * 0.4, 220));
}

function isHourlyPoint(point: CelestialTrackPoint): boolean {
  return point.timeLabel.endsWith(":00");
}

function currentBodyRadius(point: CelestialScreenPoint): number {
  if (point.id === "sun") return 12;
  if (point.id === "moon") return 11;
  if (point.id === "polaris") return 6;
  return 7;
}

type MilkyWayDomePoint = {
  center: MapPixelPoint;
  north: MapPixelPoint;
  south: MapPixelPoint;
  lineOfSightVisible?: boolean;
};

function milkyWayDomeSegments(
  path: MilkyWayPathPoint[],
  origin: MapPixelPoint,
  radius: number
): MilkyWayDomePoint[][] {
  const segments: MilkyWayDomePoint[][] = [];
  let current: MilkyWayDomePoint[] = [];
  const flush = () => {
    if (current.length > 1) segments.push(current);
    current = [];
  };
  for (const point of path) {
    const aboveHorizon = Math.max(
      point.altitudeDegrees,
      point.northEdgeAltitudeDegrees,
      point.southEdgeAltitudeDegrees
    ) >= 0;
    if (!aboveHorizon) {
      flush();
      continue;
    }
    current.push({
      center: projectToSkyDome(
        origin,
        point.azimuthDegrees,
        Math.max(0, point.altitudeDegrees),
        radius
      ),
      north: projectToSkyDome(
        origin,
        point.northEdgeAzimuthDegrees,
        Math.max(0, point.northEdgeAltitudeDegrees),
        radius
      ),
      south: projectToSkyDome(
        origin,
        point.southEdgeAzimuthDegrees,
        Math.max(0, point.southEdgeAltitudeDegrees),
        radius
      ),
      lineOfSightVisible: point.lineOfSightVisible,
    });
  }
  flush();
  return segments;
}

export function Map2DOverlay({
  center,
  zoom,
  size,
  subject,
  tripod,
  tripodSubjectDistanceMeters,
  points,
  tracks,
  milkyWayPath,
  visibility,
  candidates,
  tripodSearchLines,
  foregroundObject,
  foregroundEditing,
  onMoveForeground,
  onSelectCandidate,
}: Props) {
  if (size.width <= 0 || size.height <= 0) return null;

  const subjectPixel = subject
    ? projectCoordinatesToMapPixel(subject, center, zoom, size)
    : null;
  const tripodPixel = tripod
    ? projectCoordinatesToMapPixel(tripod, center, zoom, size)
    : null;
  const foregroundPixel = foregroundObject?.enabled
    ? projectCoordinatesToMapPixel(foregroundObject, center, zoom, size)
    : null;
  const domeRadius = skyDomeRadius(size);
  const milkyWaySegments = tripodPixel && visibility.milkyWay
    ? milkyWayDomeSegments(milkyWayPath, tripodPixel, domeRadius)
    : [];
  const compassTicks = tripodPixel
    ? Array.from({ length: 24 }, (_, index) => {
        const azimuthDegrees = index * 15;
        return {
          azimuthDegrees,
          pixel: projectToSkyDome(tripodPixel, azimuthDegrees, 0, domeRadius),
        };
      })
    : [];
  const cardinals = tripodPixel
    ? [
        { label: "N", azimuthDegrees: 0, className: "north" },
        { label: "E", azimuthDegrees: 90, className: "east" },
        { label: "S", azimuthDegrees: 180, className: "south" },
        { label: "W", azimuthDegrees: 270, className: "west" },
      ].map((cardinal) => ({
        ...cardinal,
        pixel: projectToSkyDome(
          tripodPixel,
          cardinal.azimuthDegrees,
          0,
          domeRadius + 14
        ),
      }))
    : [];

  return (
    <div className="map-2d-overlay">
      <svg
        className="map-celestial-svg"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
      >
        {tripodPixel && subjectPixel && (
          <line
            className="map-tripod-subject-line"
            x1={tripodPixel.x}
            y1={tripodPixel.y}
            x2={subjectPixel.x}
            y2={subjectPixel.y}
          />
        )}

        {tripodPixel && (
          <g className="map-sky-dome">
            <circle
              className="map-horizon-outline"
              cx={tripodPixel.x}
              cy={tripodPixel.y}
              r={domeRadius}
            />
            <circle
              className="map-horizon-circle"
              cx={tripodPixel.x}
              cy={tripodPixel.y}
              r={domeRadius}
            />
            {compassTicks.map(({ azimuthDegrees, pixel }) => (
              <circle
                key={`compass-${azimuthDegrees}`}
                className={azimuthDegrees % 90 === 0
                  ? "map-compass-tick cardinal"
                  : "map-compass-tick"}
                cx={pixel.x}
                cy={pixel.y}
                r={azimuthDegrees % 90 === 0 ? 4 : 2.4}
              />
            ))}
            {cardinals.map((cardinal) => (
              <text
                key={cardinal.label}
                className={`map-cardinal-label ${cardinal.className}`}
                x={cardinal.pixel.x}
                y={cardinal.pixel.y}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {cardinal.label}
              </text>
            ))}
          </g>
        )}

        {milkyWaySegments.map((segment, segmentIndex) => (
          <g key={`milky-way-markers-${segmentIndex}`} className="map-milky-way-markers">
            {segment.filter((_, index) => index % 7 === 0).map((point, pointIndex) => {
              const halfWidth = Math.hypot(
                point.north.x - point.south.x,
                point.north.y - point.south.y
              ) / 2;
              return (
                <circle
                  key={`${segmentIndex}-${pointIndex}`}
                  className={point.lineOfSightVisible === false ? "map-milky-way-marker hidden" : "map-milky-way-marker visible"}
                  cx={point.center.x}
                  cy={point.center.y}
                  r={Math.max(3, Math.min(18, halfWidth * 0.42))}
                />
              );
            })}
          </g>
        ))}

        {tripodPixel && tracks.flatMap((track) => {
          if (!visibility[track.id]) return null;
          const segments = contiguousVisibleSegments(track);
          return segments.flatMap((segment, segmentIndex) => {
            const visiblePoints = segment.map((point) =>
              projectToSkyDome(
                tripodPixel,
                point.azimuthDegrees,
                point.altitudeDegrees,
                domeRadius
              )
            );
            const horizonPoints = [segment[0], segment.at(-1)].filter(
              (point): point is CelestialTrackPoint =>
                Boolean(point && point.altitudeDegrees <= 3)
            );
            return (
              <g key={`${track.id}-${segmentIndex}`}>
                {horizonPoints.map((point, endpointIndex) => {
                  const endpoint = projectToSkyDome(
                    tripodPixel,
                    point.azimuthDegrees,
                    point.altitudeDegrees,
                    domeRadius
                  );
                  return (
                    <line
                      key={`${point.timestampMilliseconds}-${endpointIndex}`}
                      className={`map-rise-set-ray map-ray-${track.id}`}
                      x1={tripodPixel.x}
                      y1={tripodPixel.y}
                      x2={endpoint.x}
                      y2={endpoint.y}
                    />
                  );
                })}
                <polyline
                  className={`map-celestial-track map-track-${track.id}`}
                  points={pointsAttribute(visiblePoints)}
                />
              </g>
            );
          });
        })}

        {tripodPixel && tracks.flatMap((track) => {
          if (!visibility[track.id]) return [];
          return track.points
            .filter((point) => point.altitudeDegrees >= 0 && isHourlyPoint(point))
            .map((point) => {
              const pixel = projectToSkyDome(
                tripodPixel,
                point.azimuthDegrees,
                point.altitudeDegrees,
                domeRadius
              );
              return (
                <g key={`${track.id}-hour-${point.timestampMilliseconds}`}>
                  <circle
                    className={`map-track-hour-dot map-track-hour-${track.id}`}
                    cx={pixel.x}
                    cy={pixel.y}
                    r={track.id === "sun" || track.id === "moon" ? 4 : 2.5}
                  />
                  {(track.id === "sun" || track.id === "moon") && (
                    <text
                      className={`map-track-hour-label map-track-hour-label-${track.id}`}
                      x={pixel.x + 6}
                      y={pixel.y + 1}
                      dominantBaseline="central"
                    >
                      {Number(point.timeLabel.slice(0, 2))}
                    </text>
                  )}
                </g>
              );
            });
        })}

        {tripodPixel && points.map((point) => {
          if (!visibility[point.id] || point.altitudeDegrees < 0) return null;
          const pixel = projectToSkyDome(
            tripodPixel,
            point.azimuthDegrees,
            point.altitudeDegrees,
            domeRadius
          );
          const radius = currentBodyRadius(point);
          return (
            <g key={`${point.id}-current`}>
              <line
                className={`map-current-body-ray map-ray-${point.id}`}
                x1={tripodPixel.x}
                y1={tripodPixel.y}
                x2={pixel.x}
                y2={pixel.y}
              />
              <circle
                className={`map-current-body map-current-body-${point.id}`}
                cx={pixel.x}
                cy={pixel.y}
                r={radius}
              />
              {point.id === "moon" && (
                <circle
                  className="map-current-moon-light"
                  cx={pixel.x}
                  cy={pixel.y}
                  r={radius - 1}
                  opacity={Math.max(0, Math.min(1, point.illuminationFraction ?? 0))}
                />
              )}
            </g>
          );
        })}

        {tripodPixel && (
          <circle
            className="map-observer-center"
            cx={tripodPixel.x}
            cy={tripodPixel.y}
            r="5"
          />
        )}

        {tripodSearchLines.map((line) => {
          const start = projectCoordinatesToMapPixel(line.start, center, zoom, size);
          const end = projectCoordinatesToMapPixel(line.end, center, zoom, size);
          const extendedTarget = extendRayPastTarget(start, end, size);
          return (
            <line
              key={`${line.id}-tripod-search-base-line`}
              className={`map-tripod-candidate-line map-candidate-${line.id}`}
              x1={start.x}
              y1={start.y}
              x2={extendedTarget.x}
              y2={extendedTarget.y}
            />
          );
        })}
      </svg>

      {candidates.map((candidate) => {
        if (!visibility[candidate.id]) return null;
        const pixel = projectCoordinatesToMapPixel(
          candidate,
          center,
          zoom,
          size
        );
        if (!isClearOfMapControls(pixel, size)) return null;
        return (
          <button
            type="button"
            key={`${candidate.id}-tripod-candidate`}
            className={`map-tripod-candidate-label map-candidate-label-${candidate.id}`}
            style={{ left: pixel.x, top: pixel.y }}
            onClick={() => onSelectCandidate(candidate)}
            title={
              candidate.solutionType === "direction-only"
                ? `${candidate.label}の三脚方位候補（要確認）`
                : `${candidate.label}の三脚位置`
            }
          >
            <span aria-hidden="true">●</span>
            {candidate.label}{" "}
            {candidate.solutionType === "direction-only"
              ? "三脚方位候補"
              : "三脚候補"}{" "}
            {Math.round(candidate.distanceMeters)}m
          </button>
        );
      })}

      {subjectPixel && isInside(subjectPixel, size) && (
        <div className="map-2d-pin map-2d-subject-pin" style={pinStyle(subjectPixel)}>
          <svg viewBox="0 0 28 40">
            <path d="M14 39C11 32 2 24 2 14A12 12 0 0 1 26 14c0 10-9 18-12 25Z" />
            <circle cx="14" cy="14" r="4.5" />
          </svg>
        </div>
      )}
      {tripodPixel && isInside(tripodPixel, size) && (
        <div className="map-2d-pin map-2d-tripod-pin" style={pinStyle(tripodPixel)}>
          <svg viewBox="0 0 28 40">
            <path d="M14 39C11 32 2 24 2 14A12 12 0 0 1 26 14c0 10-9 18-12 25Z" />
            <circle cx="14" cy="14" r="4.5" />
          </svg>
          {tripodSubjectDistanceMeters !== null && (
            <small className="map-tripod-distance">
              {tripodSubjectDistanceMeters >= 1_000
                ? `${(tripodSubjectDistanceMeters / 1_000).toFixed(1)}km`
                : `${Math.round(tripodSubjectDistanceMeters)}m`}
            </small>
          )}
        </div>
      )}
    
      {/* 2D map always uses the fixed-size person pin, regardless of zoom or distance. */}
      {foregroundPixel && isInside(foregroundPixel, size) && (
        <button
          type="button"
          className={`map-2d-foreground-pin ${foregroundEditing ? "editing" : ""}`}
          style={pinStyle(foregroundPixel)}
          aria-label={`前景・中景 人物 ${foregroundObject?.heightCm ?? 170}cm`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (!rect) return;
            onMoveForeground(coordinatesAtMapPixel(
              event.clientX - rect.left, event.clientY - rect.top, center, zoom, size
            ));
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        >
          <svg viewBox="0 0 64 88" aria-hidden="true"><path className="person-pin-body" d="M32 86C27 73 8 58 8 32C8 18.7 18.7 8 32 8s24 10.7 24 24C56 58 37 73 32 86Z"/><circle className="person-pin-head" cx="32" cy="27" r="7"/><path className="person-pin-figure" d="M25 38Q32 34 39 38L42 55H37L39 69H34L32 53L30 69H25L27 55H22Z"/></svg>
        </button>
      )}
</div>
  );
}
