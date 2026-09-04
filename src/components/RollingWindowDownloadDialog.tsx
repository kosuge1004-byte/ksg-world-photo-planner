import { useState } from "react";
import { ROLLING_WINDOW_MAX_DAYS, ROLLING_WINDOW_PERIOD_OPTIONS, type RollingWindowProgress } from "../cache/tripodRollingWindowManager";

export type RollingWindowDialogState = {
  subjectLabel: string;
  /** null: 確認待ち（ダウンロードするか聞いている段階）。値あり: ダウンロード中の進捗。 */
  progress: RollingWindowProgress | null;
};

type Props = {
  state: RollingWindowDialogState | null;
  onConfirm: (windowDays: number) => void;
  onDecline: () => void;
  onCancelDownload: () => void;
};

function periodLabel(days: number): string {
  if (days >= ROLLING_WINDOW_MAX_DAYS) return "全部（1年）";
  if (days % 30 === 0) return `${days / 30}ヶ月`;
  return `${days}日`;
}

export function RollingWindowDownloadDialog({ state, onConfirm, onDecline, onCancelDownload }: Props) {
  const [selectedDays, setSelectedDays] = useState<number>(ROLLING_WINDOW_PERIOD_OPTIONS[1]);
  if (!state) return null;
  const { subjectLabel, progress } = state;
  const isDownloading = progress !== null;
  const percent =
    isDownloading && progress.totalSteps > 0
      ? Math.round((progress.completedSteps / progress.totalSteps) * 100)
      : isDownloading
        ? 100
        : 0;

  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="周辺データの端末保存"
      >
        {!isDownloading ? (
          <>
            <h2>「{subjectLabel}」の周辺データを端末に保存しますか？</h2>
            <p className="project-dialog-note">
              日の出・日の入り・月の出・月の入りのタイミングで、太陽・月と重なる三脚候補の位置を
              あらかじめ計算・保存します（容量はごく小さく、多くても数MB程度です）。
            </p>
            <div className="rolling-window-period-choices" role="radiogroup" aria-label="保存する期間">
              {ROLLING_WINDOW_PERIOD_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={days === selectedDays ? "rolling-window-period-choice active" : "rolling-window-period-choice"}
                  aria-pressed={days === selectedDays}
                  onClick={() => setSelectedDays(days)}
                >
                  {periodLabel(days)}
                </button>
              ))}
            </div>
            <p className="project-dialog-note">
              計算に数分かかることがあります（期間が長いほど時間がかかります）。バックグラウンドで進み、
              途中でやめても後から再開できます。カメラの高さを変えると、その分だけ計算し直します
              （焦点距離の変更では計算し直しません）。
            </p>
            <div>
              <button type="button" onClick={onDecline}>
                保存しない
              </button>
              <button type="button" className="primary" onClick={() => onConfirm(selectedDays)}>
                保存する
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>「{subjectLabel}」の周辺データを保存しています…</h2>
            <div className="rolling-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="rolling-window-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="project-dialog-note">
              {progress.totalSteps === 0
                ? "既に最新の状態です。"
                : `${progress.completedSteps} / ${progress.totalSteps} 日${progress.currentDateText ? `（${progress.currentDateText}）` : ""}`}
            </p>
            <div>
              <button type="button" onClick={onCancelDownload}>
                中断する
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
