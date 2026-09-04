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
  measuring?: boolean;
  onMeasureTap?: (xPercent: number, yPercent: number) => void;
  subjectPicking?: boolean;
  onSubjectTap?: (xPercent: number, yPercent: number) => void;
};

type PointerPosition = { x: number; y: number };

function distance(a: PointerPosition, b: PointerPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampFocalLength(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

// この距離未満・この時間未満の指の動きは「タップ」とみなす（計測タップ用）。
const TAP_MAX_MOVEMENT_PX = 10;
const TAP_MAX_DURATION_MS = 400;

// 2026-09-04追記: 被写体ピン指定は誤操作（構図をドラッグで動かそうとした
// だけなのに指が一瞬止まってタップ判定されてしまう等）を防ぐため、
// 短いタップではなく「長押し」で確定する方式に変更。長押し中の許容移動量は
// 通常タップよりわずかに広く取り、指の自然なブレを吸収する。
const LONG_PRESS_DURATION_MS = 550;
const LONG_PRESS_MAX_MOVEMENT_PX = 14;

export function PreviewGestureLayer({
  focalLengthMm,
  minFocalLengthMm,
  maxFocalLengthMm,
  aspectRatio,
  onChangeFocalLength,
  onPan,
  measuring = false,
  onMeasureTap,
  subjectPicking = false,
  onSubjectTap,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const pinchRef = useRef<{ distance: number; focalLength: number } | null>(null);
  const panRef = useRef<PointerPosition | null>(null);
  const tapStartRef = useRef<{ position: PointerPosition; time: number } | null>(null);
  const dragActivatedRef = useRef(false);
  const lastWheelAtRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerIdRef = useRef<number | null>(null);

  function hideLongPressIndicator() {
    const indicator = indicatorRef.current;
    if (indicator) indicator.style.opacity = "0";
  }

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPointerIdRef.current = null;
    hideLongPressIndicator();
  }

  // 2026-09-04追記: 被写体ピン指定はタップではなく長押しで確定する。
  // 押し始めた位置に進捗リングを表示し、既定時間まで指を動かさず
  // 保持し続けたら確定する。移動量が閾値を超えたり途中で離したりした
  // 場合はキャンセルする（＝構図ドラッグとして扱われる）。
  function scheduleLongPress(pointerId: number, position: PointerPosition) {
    cancelLongPress();
    longPressPointerIdRef.current = pointerId;
    const layer = layerRef.current;
    const rect = layer?.getBoundingClientRect();
    const indicator = indicatorRef.current;
    if (indicator && rect) {
      indicator.style.left = `${position.x - rect.left}px`;
      indicator.style.top = `${position.y - rect.top}px`;
      indicator.style.setProperty("--long-press-duration", `${LONG_PRESS_DURATION_MS}ms`);
      // 直前のアニメーションをリセットしてから再生する。
      indicator.classList.remove("filling");
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      indicator.offsetWidth;
      indicator.style.opacity = "1";
      indicator.classList.add("filling");
    }
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressPointerIdRef.current = null;
      hideLongPressIndicator();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const xPercent = ((position.x - rect.left) / rect.width) * 100;
      const yPercent = ((position.y - rect.top) / rect.height) * 100;
      onSubjectTap?.(xPercent, yPercent);
      // 確定後はドラッグへ移行させない。
      dragActivatedRef.current = true;
    }, LONG_PRESS_DURATION_MS);
  }

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

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointersRef.current.values()];
    // 1本指で押し始めた位置は、通常時を含めてタップ判定用に記録する。
    // 2本指になった時点でタップ候補から外し、ピンチ操作だけを扱う。
    if (points.length === 1) {
      tapStartRef.current = { position: points[0], time: performance.now() };
      dragActivatedRef.current = false;
      // 被写体ピン指定は、明示的な「位置指定」モード中はタップで、
      // それ以外の通常画面では長押しで確定する（誤操作防止）。
      if (!measuring && !subjectPicking) scheduleLongPress(event.pointerId, points[0]);
    } else {
      tapStartRef.current = null;
      dragActivatedRef.current = false;
      cancelLongPress();
    }
    if (measuring || subjectPicking) {
      // 計測モード中はドラッグで構図を動かさずタップ位置だけを拾う。
      // 明示的被写体指定モード中もドラッグはさせず、長押しの確定だけを待つ。
      return;
    }
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
    // 長押し中に指が既定距離以上動いたら、被写体確定をキャンセルする。
    if (
      longPressPointerIdRef.current === event.pointerId &&
      tapStartRef.current &&
      distance(tapStartRef.current.position, {
        x: event.clientX,
        y: event.clientY,
      }) > LONG_PRESS_MAX_MOVEMENT_PX
    ) {
      cancelLongPress();
    }
    if (measuring || subjectPicking) return;
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

      // 指の微小なブレをタップと誤って構図移動にしない。
      // 閾値を越えた時点からは、押し始めからの移動量を一度に反映し、
      // 以降は従来どおり連続的にパンするためスワイプ量を失わない。
      if (!dragActivatedRef.current) {
        const start = tapStartRef.current?.position;
        if (start && distance(start, points[0]) <= TAP_MAX_MOVEMENT_PX) return;
        dragActivatedRef.current = true;
      }

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
    // 計測モード、および明示的な被写体「位置指定」モード中は、
    // 従来どおり短いタップで確定する。通常画面での被写体ピン指定は
    // 長押し（scheduleLongPress）側で確定するため、ここでは離した時点で
    // 未確定なら何もしない（＝キャンセル）。
    if ((measuring || subjectPicking) && tapStartRef.current && pointersRef.current.has(event.pointerId)) {
      const start = tapStartRef.current;
      const end = { x: event.clientX, y: event.clientY };
      const layer = layerRef.current;
      if (
        layer &&
        distance(start.position, end) <= TAP_MAX_MOVEMENT_PX &&
        performance.now() - start.time <= TAP_MAX_DURATION_MS
      ) {
        const rect = layer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const xPercent = ((end.x - rect.left) / rect.width) * 100;
          const yPercent = ((end.y - rect.top) / rect.height) * 100;
          if (subjectPicking) onSubjectTap?.(xPercent, yPercent);
          else onMeasureTap?.(xPercent, yPercent);
        }
      }
    }
    if (longPressPointerIdRef.current === event.pointerId) cancelLongPress();
    tapStartRef.current = null;
    dragActivatedRef.current = false;
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
      onDoubleClick={() => { if (!measuring && !subjectPicking) onChangeFocalLength(clamp(focalLengthMm * 1.25)); }}
      aria-label={
        subjectPicking
          ? "プレビューをタップして正式な被写体3D位置を指定"
          : measuring
          ? "プレビューをタップして2点間の距離を計測"
          : "プレビューを長押しで被写体ピン指定、ドラッグで構図調整、ホイールまたはピンチで拡大縮小"
      }
    >
      <div ref={indicatorRef} className="preview-long-press-indicator" aria-hidden="true" />
    </div>
  );
}
