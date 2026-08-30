import type { CSSProperties } from "react";

import type {
  CelestialScreenPoint,
  CelestialTrack,
  CelestialVisibility,
  MilkyWayPathPoint,
  TripodCandidate,
} from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { ForegroundObject } from "../types/foreground";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
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
  tripodCandidatesCalculating: boolean;
  onMoveForeground: (coordinates: { latitude: number; longitude: number }) => void;
  onSelectCandidate: (candidate: TripodCandidate) => void;
};

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

export function Map2DOverlay({
  center,
  zoom,
  size,
  subject,
  tripod,
  tripodSubjectDistanceMeters,
  visibility,
  candidates,
  tripodSearchLines,
  foregroundObject,
  foregroundEditing,
  tripodCandidatesCalculating,
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


  return (
    <div className="map-2d-overlay">
      <svg
        className="map-celestial-svg"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
      >
        {tripodSearchLines.map((line) => {
          const start = projectCoordinatesToMapPixel(line.start, center, zoom, size);
          // 250km先の地理座標をWeb Mercatorへ投影して直線で結ぶと、
          // 測地線とMercator投影の非線形差で近距離（~1km）の候補点からも
          // 線が目に見えて外れる。画面上の方向は被写体直近1kmの測地線接線から
          // 求め、そこから画面端まで延長する。
          const matchingCandidate = candidates
            .filter((candidate) => candidate.id === line.id)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
          const localDirectionCoordinate = calculateKarneyDestinationPoint(
            line.start,
            line.bearingDegrees,
            1_000
          );
          // 確定/暫定候補がある場合は、その実座標を画面上の方向基準にする。
          // これにより「被写体→天体線」と三脚候補点が同じ投影経路を使い、
          // 表示上の線だけが候補点から外れることを防ぐ。候補未算出時だけ
          // 被写体直近1kmの測地線接線を使う。
          const directionPixel = projectCoordinatesToMapPixel(
            matchingCandidate ?? localDirectionCoordinate,
            center,
            zoom,
            size
          );
          const extendedTarget = extendRayPastTarget(start, directionPixel, size);
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
          <div
            key={`${candidate.id}-tripod-candidate-${candidate.intersectionIndex ?? 1}-${candidate.distanceMeters.toFixed(1)}`}
            className="map-tripod-candidate-anchor"
            style={{ left: pixel.x, top: pixel.y }}
          >
            <button
              type="button"
              className={`map-tripod-candidate-marker map-candidate-marker-${candidate.id}`}
              onClick={() => onSelectCandidate(candidate)}
              aria-label={`${candidate.label} 三脚候補 ${Math.round(candidate.distanceMeters)}m`}
              title={`${candidate.label}の三脚候補点`}
            />
            <button
              type="button"
              className={`map-tripod-candidate-label map-candidate-label-${candidate.id}`}
              onClick={() => onSelectCandidate(candidate)}
              title={
              candidate.solutionType === "direction-only"
                ? `${candidate.label}の三脚方位候補（要確認）`
                : candidate.solutionType === "preliminary"
                  ? (tripodCandidatesCalculating
                      ? `${candidate.label}の三脚概算候補（地形確認中）`
                      : `${candidate.label}の三脚概算候補（確定解なし・地形未確認のまま）`)
                  : candidate.lineOfSightPossiblyObstructed
                    ? `${candidate.label}の三脚位置（幾何学的条件は満たすが、途中の地形に被写体への視界を遮られている可能性があります）`
                    : `${candidate.label}の三脚位置`
            }
            >
              {candidate.label}{" "}
              {candidate.solutionType === "direction-only"
                ? "三脚方位候補"
                : candidate.solutionType === "preliminary"
                  ? (tripodCandidatesCalculating ? "三脚概算候補（計算中）" : "三脚概算候補（確定解なし）")
                  : "三脚候補"}
              {candidate.intersectionCount && candidate.intersectionCount > 1
                ? ` ${candidate.intersectionIndex}/${candidate.intersectionCount}`
                : ""}{" "}
              {Math.round(candidate.distanceMeters)}m
              {candidate.lineOfSightPossiblyObstructed ? " ⚠視界不良の可能性" : ""}
            </button>
          </div>
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
