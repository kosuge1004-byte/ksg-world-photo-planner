import { useEffect, useRef } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

import { coordinatesAtMapPixel } from "../map/webMercator";
import type { MapSize } from "../map/webMercator";
import type { GroundPoint } from "../types/points";

type Props = {
  stageRef: RefObject<HTMLDivElement | null>;
  center: Pick<GroundPoint, "latitude" | "longitude">;
  zoom: number;
  size: MapSize;
  onChangeCenter: (center: { latitude: number; longitude: number }) => void;
  onChangeZoom: (zoom: number) => void;
};

type PointerPosition = { x: number; y: number };

function distance(a: PointerPosition, b: PointerPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampZoom(value: number): number {
  return Math.min(20, Math.max(3, Math.round(value)));
}

export function Map2DInteractionLayer({
  stageRef,
  center,
  zoom,
  size,
  onChangeCenter,
  onChangeZoom,
}: Props) {
  const interactionRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const panStartRef = useRef<PointerPosition | null>(null);
  const panOffsetRef = useRef<PointerPosition>({ x: 0, y: 0 });
  const pinchRef = useRef<{
    startDistance: number;
    lastRatio: number;
  } | null>(null);
  const lastWheelAtRef = useRef(0);

  useEffect(() => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAtRef.current < 120) return;
      lastWheelAtRef.current = now;
      onChangeZoom(clampZoom(zoom + (event.deltaY < 0 ? 1 : -1)));
    };
    // 2D地図のホイールはページではなく地図へ適用するためnon-passiveで登録する。
    interaction.addEventListener("wheel", wheel, { passive: false });
    return () => interaction.removeEventListener("wheel", wheel);
  }, [onChangeZoom, zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    return () => {
      if (!stage) return;
      stage.style.transform = "";
      stage.style.transformOrigin = "";
      stage.classList.remove("dragging");
    };
  }, [stageRef]);

  function resetStage() {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.transform = "";
    stage.style.transformOrigin = "";
    stage.classList.remove("dragging");
  }

  function commitPanOffset() {
    const offset = panOffsetRef.current;
    if (Math.hypot(offset.x, offset.y) >= 3) {
      onChangeCenter(
        coordinatesAtMapPixel(
          size.width / 2 - offset.x,
          size.height / 2 - offset.y,
          center,
          zoom,
          size
        )
      );
    }
    panOffsetRef.current = { x: 0, y: 0 };
  }

  function startGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const points = [...pointersRef.current.values()];
    if (points.length === 1) {
      panStartRef.current = points[0];
      panOffsetRef.current = { x: 0, y: 0 };
      stageRef.current?.classList.add("dragging");
    } else if (points.length === 2) {
      // 1本指パンの見た目を消す前に、移動量を地図中心へ確定する。
      commitPanOffset();
      resetStage();
      panStartRef.current = null;
      pinchRef.current = {
        startDistance: Math.max(1, distance(points[0], points[1])),
        lastRatio: 1,
      };
      stageRef.current?.classList.add("dragging");
    }
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const stage = stageRef.current;
    if (!stage) return;
    const points = [...pointersRef.current.values()];

    if (points.length >= 2 && pinchRef.current) {
      const ratio = Math.min(
        1.65,
        Math.max(
        0.78,
          distance(points[0], points[1]) / pinchRef.current.startDistance
        )
      );
      pinchRef.current.lastRatio = ratio;
      const midpoint = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      const rect = event.currentTarget.getBoundingClientRect();
      stage.style.transformOrigin = `${midpoint.x - rect.left}px ${midpoint.y - rect.top}px`;
      stage.style.transform = `scale(${ratio})`;
      return;
    }

    const start = panStartRef.current;
    if (!start || points.length !== 1) return;
    const rawOffset = {
      x: points[0].x - start.x,
      y: points[0].y - start.y,
    };
    const offset = {
      x: Math.min(size.width * 0.42, Math.max(-size.width * 0.42, rawOffset.x)),
      y: Math.min(size.height * 0.42, Math.max(-size.height * 0.42, rawOffset.y)),
    };
    panOffsetRef.current = offset;
    stage.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  }

  function finishGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();

    if (pinchRef.current) {
      const ratio = pinchRef.current.lastRatio;
      const logarithmicDelta = Math.log2(ratio);
      if (Math.abs(logarithmicDelta) >= 0.08) {
        const step = Math.sign(logarithmicDelta) *
          Math.max(1, Math.round(Math.abs(logarithmicDelta)));
        onChangeZoom(clampZoom(zoom + step));
      }
    } else {
      commitPanOffset();
    }

    pointersRef.current.clear();
    panStartRef.current = null;
    pinchRef.current = null;
    panOffsetRef.current = { x: 0, y: 0 };
    resetStage();
  }

  function cancelGesture() {
    pointersRef.current.clear();
    panStartRef.current = null;
    pinchRef.current = null;
    panOffsetRef.current = { x: 0, y: 0 };
    resetStage();
  }

  return (
    <div
      ref={interactionRef}
      className="map-2d-pan-layer"
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={finishGesture}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={cancelGesture}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && event.buttons === 0) {
          cancelGesture();
        }
      }}
      onDoubleClick={() => onChangeZoom(clampZoom(zoom + 1))}
      onContextMenu={(event) => event.preventDefault()}
      aria-label="2D地図をドラッグ、ホイールまたはピンチで操作"
    />
  );
}
