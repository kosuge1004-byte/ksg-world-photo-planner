import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { sensorDimensionsMm } from "../cesium/optics";

type Props = {
  focalLengthMm: number;
  minFocalLengthMm: number;
  maxFocalLengthMm: number;
  aspectRatio: number;
  onChangeFocalLength: (value: number) => void;
  onPan: (azimuthDeltaDegrees: number, altitudeDeltaDegrees: number) => void;
};

type PointerPosition = { x: number; y: number };

function distance(a: PointerPosition, b: PointerPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampFocalLength(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function PreviewGestureLayer({
  focalLengthMm,
  minFocalLengthMm,
  maxFocalLengthMm,
  aspectRatio,
  onChangeFocalLength,
  onPan,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const pinchRef = useRef<{ distance: number; focalLength: number } | null>(null);
  const panRef = useRef<PointerPosition | null>(null);
  const lastWheelAtRef = useRef(0);

  const clamp = (value: number) =>
    clampFocalLength(value, minFocalLengthMm, maxFocalLengthMm);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAtRef.current < 70) return;
      lastWheelAtRef.current = now;
      onChangeFocalLength(
        clampFocalLength(
          focalLengthMm * (event.deltaY < 0 ? 1.14 : 0.88),
          minFocalLengthMm,
          maxFocalLengthMm
        )
      );
    };
    // Reactのwheelはpassiveになるため、スクロール抑止が必要な操作面だけnativeで登録する。
    layer.addEventListener("wheel", wheel, { passive: false });
    return () => layer.removeEventListener("wheel", wheel);
  }, [
    focalLengthMm,
    maxFocalLengthMm,
    minFocalLengthMm,
    onChangeFocalLength,
  ]);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointersRef.current.values()];
    if (points.length === 2) {
      pinchRef.current = {
        distance: Math.max(1, distance(points[0], points[1])),
        focalLength: focalLengthMm,
      };
      panRef.current = null;
    } else if (points.length === 1) {
      panRef.current = points[0];
    }
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointersRef.current.values()];
    if (points.length === 2 && pinchRef.current) {
      const ratio = distance(points[0], points[1]) / pinchRef.current.distance;
      onChangeFocalLength(clamp(pinchRef.current.focalLength * ratio));
      return;
    }
    if (points.length === 1 && panRef.current) {
      const layer = layerRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const sensor = sensorDimensionsMm(aspectRatio);
      const horizontalFovDegrees =
        2 * Math.atan(sensor.width / (2 * focalLengthMm)) * 180 / Math.PI;
      const verticalFovDegrees =
        2 * Math.atan(sensor.height / (2 * focalLengthMm)) * 180 / Math.PI;
      const deltaX = points[0].x - panRef.current.x;
      const deltaY = points[0].y - panRef.current.y;
      // 指でつかんだ点が指に付いてくる向き（地図アプリのドラッグと同じ感覚）。
      onPan(
        -(deltaX / rect.width) * horizontalFovDegrees,
        (deltaY / rect.height) * verticalFovDegrees
      );
      panRef.current = points[0];
    }
  }

  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) panRef.current = null;
  }

  return (
    <div
      ref={layerRef}
      className="preview-gesture-layer"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
      onDoubleClick={() => onChangeFocalLength(clamp(focalLengthMm * 1.25))}
      aria-label="プレビューをドラッグで構図調整、ホイールまたはピンチで拡大縮小"
    />
  );
}
