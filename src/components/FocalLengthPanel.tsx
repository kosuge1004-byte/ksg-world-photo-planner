import type {
  CameraSettings,
} from "../types/camera";

import {
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "../types/camera";

type Props = {
  settings: CameraSettings;
  savedVisible: boolean;
  onChange: (settings: CameraSettings) => void;
  onReset: () => void;
};

export function FocalLengthPanel({
  settings,
  savedVisible,
  onChange,
  onReset,
}: Props) {
  function updateFocalLength(value: number) {
    const normalized = Math.min(
      FOCAL_LENGTH_MAX,
      Math.max(FOCAL_LENGTH_MIN, Math.round(value))
    );

    onChange({
      ...settings,
      focalLengthMm: normalized,
    });
  }

  return (
    <section className="focal-panel">
      <div className="focal-panel-heading">
        <strong>焦点距離</strong>
        <span className="info-mark" title="レンズの焦点距離">i</span>
        <span
          className={
            savedVisible
              ? "save-status visible"
              : "save-status"
          }
        >
          保存済み
        </span>
      </div>

      <div className="focal-main-row">
        <label className="focal-value-control">
          <span className="focal-input-wrap">
            <input
              type="number"
              min={FOCAL_LENGTH_MIN}
              max={FOCAL_LENGTH_MAX}
              value={settings.focalLengthMm}
              onChange={(event) =>
                updateFocalLength(Number(event.target.value))
              }
            />
            <span>mm</span>
          </span>
          <small>{FOCAL_LENGTH_MIN}mm ～ {FOCAL_LENGTH_MAX}mm</small>
        </label>
        <div className="focal-step-buttons">
        {[-100, -10, -1, 1, 10, 100].map((delta) => (
          <button
            type="button"
            key={delta}
            onClick={() =>
              updateFocalLength(settings.focalLengthMm + delta)
            }
          >
            {delta > 0 ? `+${delta}` : delta}
          </button>
        ))}
          <button type="button" className="reset-settings-button" onClick={onReset}>リセット</button>
        </div>
      </div>
    </section>
  );
}
