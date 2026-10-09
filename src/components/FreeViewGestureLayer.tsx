import { useRef } from "react";

import {
  freeViewFocalLengthAfterPinch,
  freeViewPoseAfterDrag,
  type FreeViewPose,
} from "../cesium/freeViewCamera";

type Props = {
  pose: FreeViewPose;
  focalLengthMm: number;
  fov: { horizontalFovDegrees: number; verticalFovDegrees: number } | null;
  disabled?: boolean;
  onPoseChange: (pose: FreeViewPose) => void;
  onFocalLengthChange: (focalLengthMm: number) => void;
  onInteractionChange?: (interacting: boolean) => void;
};

type Gesture =
  | { kind: "drag"; pointerId: number; startX: number; startY: number; startPose: FreeViewPose;
      fov: { horizontalFovDegrees: number; verticalFovDegrees: number } }
  | { kind: "pinch"; startDistance: number; startFocalLengthMm: number };

/**
 * 自由ビューモードの固定視点ジェスチャー（2026-10-09）。
 *
 * - 1本指ドラッグ: 方位角・仰角だけを変える（視点の位置は動かさない）。
 * - 2本指ピンチ: 焦点距離（画角）だけを変える。
 * 画面上の指の動きだけを使い、端末の傾き・向き・ジャイロ・GPS・カメラ映像は
 * 一切参照しない（DeviceOrientation等のイベントを購読しない）。
 * Cesium標準のカメラ操作はこの層がキャンバスの上で受け止めるため届かない。
 */
export function FreeViewGestureLayer({
  pose,
  focalLengthMm,
  fov,
  disabled,
  onPoseChange,
  onFocalLengthChange,
  onInteractionChange,
}: Props) {
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);
  const latestRef = useRef({ pose, focalLengthMm, fov });
  latestRef.current = { pose, focalLengthMm, fov };

  const pinchDistance = (): number => {
    const [first, second] = Array.from(pointersRef.current.values());
    if (!first || !second) return 0;
    return Math.hypot(second.x - first.x, second.y - first.y);
  };

  const beginGestureFromPointers = (): void => {
    const latest = latestRef.current;
    const pointers = pointersRef.current;
    if (pointers.size >= 2) {
      gestureRef.current = {
        kind: "pinch",
        startDistance: pinchDistance(),
        startFocalLengthMm: latest.focalLengthMm,
      };
      return;
    }
    const only = Array.from(pointers.entries())[0];
    if (only && latest.fov) {
      // ドラッグ開始時の画角で回転量を決める（途中で画角が変わっても指と景色がずれない）。
      gestureRef.current = {
        kind: "drag",
        pointerId: only[0],
        startX: only[1].x,
        startY: only[1].y,
        startPose: latest.pose,
        fov: latest.fov,
      };
      return;
    }
    gestureRef.current = null;
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // すでに解放済み。
    }
    // 2本指→1本指になった時は、残った指の現在位置からドラッグをやり直す
    // （ピンチ終了の瞬間に向きが跳ねないようにする）。
    beginGestureFromPointers();
    if (pointersRef.current.size === 0) onInteractionChange?.(false);
  };

  return (
    <div
      className="free-view-gesture-layer"
      aria-label="景色をドラッグして向きを変更、ピンチで画角を変更"
      onPointerDown={(event) => {
        if (disabled) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        beginGestureFromPointers();
        onInteractionChange?.(true);
      }}
      onPointerMove={(event) => {
        const pointers = pointersRef.current;
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const gesture = gestureRef.current;
        if (!gesture) return;
        if (gesture.kind === "pinch") {
          onFocalLengthChange(freeViewFocalLengthAfterPinch(
            gesture.startFocalLengthMm,
            gesture.startDistance,
            pinchDistance()
          ));
          return;
        }
        if (gesture.pointerId !== event.pointerId) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        onPoseChange(freeViewPoseAfterDrag(
          gesture.startPose,
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
          { widthPixels: bounds.width, heightPixels: bounds.height },
          gesture.fov
        ));
      }}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={(event) => {
        if (disabled) return;
        // PCのホイール: ピンチと同じく画角だけを変える。
        onFocalLengthChange(freeViewFocalLengthAfterPinch(
          latestRef.current.focalLengthMm, 1, Math.exp(-event.deltaY / 600)
        ));
      }}
      onDoubleClick={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
