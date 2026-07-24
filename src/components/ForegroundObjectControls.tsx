import { useEffect, useState } from "react";

import type { ForegroundObject } from "../types/foreground";

type Props = {
  object: ForegroundObject | null;
  /** Placement height even before a person exists. */
  heightCm: number;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
  onHeight: (height: number) => void;
  onDelete: () => void;
};

const HEIGHT_MIN_CM = 50;
const HEIGHT_MAX_CM = 300;

const clampHeight = (value: number): number =>
  Math.max(HEIGHT_MIN_CM, Math.min(HEIGHT_MAX_CM, Math.round(value)));

export function ForegroundObjectControls({
  object,
  heightCm,
  active,
  disabled,
  onToggle,
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
    const nextHeight = clampHeight(value);
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
        className={active ? "active" : ""}
        disabled={disabled}
        onClick={onToggle}
      >
        {active ? "配置を終了" : object ? "配置・移動" : "人物を配置"}
      </button>
      <div className="foreground-height-control">
        <label htmlFor="foreground-height-range">高さ</label>
        <input
          id="foreground-height-range"
          type="range"
          min={HEIGHT_MIN_CM}
          max={HEIGHT_MAX_CM}
          step={1}
          value={height}
          disabled={disabled}
          onChange={(event) => changeHeight(Number(event.target.value))}
        />
        <input
          type="number"
          min={HEIGHT_MIN_CM}
          max={HEIGHT_MAX_CM}
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
            if (Number.isFinite(parsed) && parsed >= HEIGHT_MIN_CM && parsed <= HEIGHT_MAX_CM) {
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
        削除
      </button>
    </div>
  );
}
