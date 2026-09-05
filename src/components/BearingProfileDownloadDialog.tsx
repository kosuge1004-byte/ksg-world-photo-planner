import { useEffect, useRef } from "react";
import type { BearingBackfillProgress } from "../cache/tripodBearingProfileManager";

export type BearingProfileDialogState = {
  subjectLabel: string;
  /** null: 確認待ち（ダウンロードするか聞いている段階）。値あり: ダウンロード中の進捗。 */
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
              この地点を囲む全方位（360方位）の地形を実測して保存します。保存後は、太陽・月がどの高さ・
              どの日時にあっても、通信なしで即座に三脚候補を確認できるようになります
              （方位ごとに地形が変わらない限り、季節や年をまたいでもずっと使えます）。
            </p>
            <p className="project-dialog-note">
              容量は数十MB程度、計算に数分かかることがあります。バックグラウンドで進み、途中でやめても
              後から再開できます。カメラの高さを変えると、その分だけ保存し直します
              （焦点距離の変更では保存し直しません）。
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
              {progress.totalSteps === 0
                ? "既に最新の状態です。"
                : `${progress.completedSteps} / ${progress.totalSteps} 方位${progress.currentBearingDegrees !== null ? `（${progress.currentBearingDegrees}°）` : ""}`}
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
