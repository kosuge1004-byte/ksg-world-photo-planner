import { useState } from "react";
import { zonedDateTimeLocalFromDate } from "../time/zonedTime";
import type { PreviewFrameMode } from "../types/camera";

type Props = {
  dateTimeLocal: string;
  timeZone: string;
  frameMode: PreviewFrameMode;
  onChangeDateTime: (value: string) => void;
  onChangeFrameMode: (mode: PreviewFrameMode) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSavePreview: () => void;
};

export function PreviewChrome({
  dateTimeLocal,
  timeZone,
  frameMode,
  onChangeDateTime,
  onChangeFrameMode,
  onZoomIn,
  onZoomOut,
  onSavePreview,
}: Props) {
  const [frameMenuOpen, setFrameMenuOpen] = useState(false);

  function openFullscreen() {
    const preview = document.querySelector<HTMLElement>(".preview-section");
    void preview?.requestFullscreen?.();
  }

  function exitFullscreen() {
    void document.exitFullscreen?.();
  }

  return (
    <div className="preview-chrome">
      <div className="preview-tool-rail">
        <button
          type="button"
          className={frameMode !== "screen" ? "active" : ""}
          onClick={() => setFrameMenuOpen((current) => !current)}
          aria-expanded={frameMenuOpen}
        >
          <span>▣</span><small>フレーム</small>
        </button>
        {frameMenuOpen && (
          <div className="preview-frame-menu" role="menu" aria-label="撮影フレーム">
            {([
              ["screen", "画面全体"],
              ["landscape-3-2", "3:2 横構図"],
              ["portrait-3-2", "3:2 縦構図"],
            ] as const).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                className={frameMode === mode ? "active" : ""}
                onClick={() => {
                  onChangeFrameMode(mode);
                  setFrameMenuOpen(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="preview-zoom-control" aria-label="プレビューの拡大縮小">
          <button type="button" onClick={onZoomIn} aria-label="プレビューを拡大">
            ＋
          </button>
          <button type="button" onClick={onZoomOut} aria-label="プレビューを縮小">
            −
          </button>
        </div>
      </div>

      <div className="preview-date-control">
        <label className="preview-date-time" title="撮影日時を変更">
          <input
            type="datetime-local"
            step="60"
            value={dateTimeLocal}
            onChange={(event) => onChangeDateTime(event.target.value)}
            aria-label="撮影日時を変更"
          />
        </label>
        <button
          type="button"
          className="preview-now-button"
          onClick={() =>
            onChangeDateTime(zonedDateTimeLocalFromDate(new Date(), timeZone))
          }
        >
          現時刻
        </button>
      </div>

      <div className="preview-actions">
        <button type="button" onClick={onSavePreview}><span>▧</span><small>保存</small></button>
        <button type="button" onClick={openFullscreen}><span>⛶</span><small>全画面</small></button>
      </div>

      <button
        type="button"
        className="fullscreen-exit-button preview-fullscreen-exit"
        onClick={exitFullscreen}
      >
        <span aria-hidden="true">✕</span>
        全画面を終了
      </button>
    </div>
  );
}
