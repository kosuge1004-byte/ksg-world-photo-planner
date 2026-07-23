import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type Props = {
  focalLengthMm: number;
  minFocalLengthMm: number;
  maxFocalLengthMm: number;
  onChangeFocalLength: (value: number) => void;
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
  onChangeFocalLength,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const pinchRef = useRef<{ distance: number; focalLength: number } | null>(null);
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
    if (event.pointerType !== "touch") return;
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
    if (points.length !== 2 || !pinchRef.current) return;
    const ratio = distance(points[0], points[1]) / pinchRef.current.distance;
    onChangeFocalLength(clamp(pinchRef.current.focalLength * ratio));
  }

  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
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
      aria-label="プレビューをホイールまたはピンチで拡大縮小"
    />
  );
}
