import { useEffect, useRef } from "react";
import type { BearingBackfillProgress } from "../cache/tripodBearingProfileManager";

export type BearingProfileDialogState = {
  subjectLabel: string;
  /** null: 確認待ち。値あり: ダウンロード中の進捗。 */
  progress: BearingBackfillProgress | null;
};

type Props = {
  state: BearingProfileDialogState | null;
  onConfirm: () => void;
  onDecline: () => void;
  onCancelDownload: () => void;
};

export function BearingProfileDownloadDialog({ state, onConfirm, onDecline, onCancelDownload }: Props) {
  const dialogRef = useRef<HTMLElement>(null);

  // 2026-09-05追記（実機で繰り返し報告されたため）: position:fixed;
  // inset:0 のバックドロップは、CSSのdvh/vh計算だけに頼ると、実機
  // （特に古いAndroid WebView）で実際に見えている画面より大きく計算され、
  // 中身（.project-dialog）がその「見えない下側」に押し出されてしまう
  // ことがある。CSS側の調整だけでは直せなかったため、開いた瞬間に
  // JavaScriptで確実に画面内へスクロールさせる、CSSに依存しない
  // 安全策を追加する。
  useEffect(() => {
    if (!state) return;
    dialogRef.current?.scrollIntoView({ block: "center", inline: "center" });
  }, [state]);

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
        ref={dialogRef}
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="三脚候補データの端末保存"
      >
        {!isDownloading ? (
          <>
            <h2>「{subjectLabel}」の三脚候補データを端末に保存しますか？</h2>
            <p className="project-dialog-note">
              この地点を囲む全方位（360方位）の三脚候補点計算用地形データを端末に保存します。
              保存済みデータは次回以降の三脚候補点計算で再利用されます。
            </p>
            <p className="project-dialog-note">
              容量は数十MB程度、計算に数分かかることがあります。他のアプリに切り替えても
              処理は続きますが、アプリを完全に終了すると中断されます。カメラの高さを
              変えると、その分だけ保存し直します（焦点距離の変更では保存し直しません）。
            </p>
            <div>
              <button type="button" onClick={onDecline}>
                保存しない
              </button>
              <button type="button" className="primary" onClick={onConfirm}>
                保存する
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>「{subjectLabel}」の三脚候補データを保存しています…</h2>
            <div className="rolling-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="rolling-window-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="project-dialog-note">
              {progress.phase === "finalizing"
                ? "端末への保存を確定しています…"
                : progress.totalSteps === 0
                  ? "既に最新の状態です。"
                  : progress.phase === "terrain" && progress.currentBearingDegrees !== null
                    ? `試行 ${progress.completedSteps} / ${progress.totalSteps} 方位（${progress.currentBearingDegrees}°）・${progress.terrainStage === "high-precision" ? "高精度DEM保存中" : "地形プロファイル取得中"}` +
                      (progress.successfulSteps !== undefined && progress.failedSteps !== undefined
                        ? `（成功${progress.successfulSteps}・失敗${progress.failedSteps}）`
                        : "")
                    : `試行 ${progress.completedSteps} / ${progress.totalSteps} 方位${progress.currentBearingDegrees !== null ? `（${progress.currentBearingDegrees}°）` : ""}` +
                      (progress.successfulSteps !== undefined && progress.failedSteps !== undefined
                        ? `（成功${progress.successfulSteps}・失敗${progress.failedSteps}）`
                        : "")}
            </p>
            {progress.lastFailureReason && (
              <p className="project-dialog-note project-dialog-note-warning">
                直近の失敗理由: {progress.lastFailureReason}
              </p>
            )}
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
