import { useEffect, useState } from "react";

import {
  FOREGROUND_HEIGHT_MAX_CM,
  FOREGROUND_HEIGHT_MIN_CM,
  normalizeForegroundHeightCm,
  type ForegroundObject,
} from "../types/foreground";

type Props = {
  object: ForegroundObject | null;
  /** Placement height even before a person exists. */
  heightCm: number;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPlaceAtSubject: () => void;
  subjectAvailable: boolean;
  onHeight: (height: number) => void;
  onDelete: () => void;
};


export function ForegroundObjectControls({
  object,
  heightCm,
  active,
  disabled,
  onToggle,
  onPlaceAtSubject,
  subjectAvailable,
  onHeight,
  onDelete,
}: Props) {
  const height = object?.heightCm ?? heightCm;
  const [heightText, setHeightText] = useState(String(height));

  useEffect(() => {
    setHeightText(String(height));
  }, [height]);

  const changeHeight = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextHeight = normalizeForegroundHeightCm(value);
    setHeightText(String(nextHeight));
    onHeight(nextHeight);
  };

  const commitHeightText = (): void => {
    const parsed = Number(heightText);
    if (!Number.isFinite(parsed)) {
      setHeightText(String(height));
      return;
    }
    changeHeight(parsed);
  };

  return (
    <div className="foreground-controls">
      <div className="foreground-controls-title">
        <strong>前景・中景オブジェクト</strong>
        <small>人物（1個まで）</small>
      </div>
      <button
        type="button"
        className="subject-person-placement-button"
        disabled={disabled || !subjectAvailable}
        onClick={onPlaceAtSubject}
      >
        被写体ピン位置に人物を置く
      </button>
      <button
        type="button"
        className={active ? "active" : ""}
        disabled={disabled}
        onClick={onToggle}
      >
        {active ? "配置場所の選択を終了" : "人物を置く場所をマップで選択"}
      </button>
      <div className="foreground-height-control">
        <label htmlFor="foreground-height-range">高さ</label>
        <input
          id="foreground-height-range"
          type="range"
          min={FOREGROUND_HEIGHT_MIN_CM}
          max={FOREGROUND_HEIGHT_MAX_CM}
          step={1}
          value={height}
          disabled={disabled}
          onChange={(event) => changeHeight(Number(event.target.value))}
        />
        <input
          type="number"
          min={FOREGROUND_HEIGHT_MIN_CM}
          max={FOREGROUND_HEIGHT_MAX_CM}
          step={1}
          value={heightText}
          disabled={disabled}
          inputMode="numeric"
          aria-label="人物の高さ（cm）"
          onChange={(event) => {
            const value = event.target.value;
            setHeightText(value);
            if (value === "") return;
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= FOREGROUND_HEIGHT_MIN_CM && parsed <= FOREGROUND_HEIGHT_MAX_CM) {
              onHeight(Math.round(parsed));
            }
          }}
          onBlur={commitHeightText}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitHeightText();
              event.currentTarget.blur();
            }
          }}
        />
        <span>cm</span>
      </div>
      <button
        type="button"
        className="foreground-delete"
        disabled={!object}
        onClick={onDelete}
      >
        人物を削除
      </button>
    </div>
  );
}
