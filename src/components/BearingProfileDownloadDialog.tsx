import { useEffect, useRef } from "react";
import type { BearingBackfillProgress } from "../cache/tripodBearingProfileManager";

export type BearingProfileDialogState = {
  subjectLabel: string;
  /** favorite: お気に入り画面からの従来確認 / spot-search: スポット検索直後の3択。 */
  mode: "favorite" | "spot-search";
  /** null: 確認待ち。値あり: ダウンロード中の進捗。 */
  progress: BearingBackfillProgress | null;
};

type Props = {
  state: BearingProfileDialogState | null;
  onConfirm: () => void;
  onConfirmAndFavorite: () => void;
  onDecline: () => void;
  onCancelDownload: () => void;
};

export function BearingProfileDownloadDialog({ state, onConfirm, onConfirmAndFavorite, onDecline, onCancelDownload }: Props) {
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
  const { subjectLabel, progress, mode } = state;
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
            <h2>{mode === "spot-search" ? `「${subjectLabel}」の周辺データをダウンロードしますか？` : `「${subjectLabel}」の三脚候補データを端末に保存しますか？`}</h2>
            <p className="project-dialog-note">
              この地点を囲む全方位（360方位）の三脚候補点計算用地形データを端末に保存します。
              保存済みデータは次回以降の三脚候補点計算で再利用されます。
            </p>
            <p className="project-dialog-note">
              容量は数十MB程度、計算に数分かかることがあります。サーバー側で処理するため、
              アプリを閉じても中断されず、途中でこの画面を閉じても後から再開できます。
              カメラの高さを変えると、その分だけ保存し直します
              （焦点距離の変更では保存し直しません）。
            </p>
            {mode === "spot-search" ? (
              <div className="bearing-profile-choice-buttons">
                <button type="button" className="primary" onClick={onConfirmAndFavorite}>
                  ダウンロードしてお気に入りに登録
                </button>
                <button type="button" onClick={onConfirm}>
                  ダウンロードしてお気に入りには登録しない
                </button>
                <button type="button" onClick={onDecline}>
                  ダウンロードしない
                </button>
              </div>
            ) : (
              <div>
                <button type="button" onClick={onDecline}>
                  保存しない
                </button>
                <button type="button" className="primary" onClick={onConfirm}>
                  保存する
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <h2>「{subjectLabel}」の三脚候補データを保存しています…</h2>
            <div className="rolling-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="rolling-window-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="project-dialog-note">
              {progress.serverMessage
                ? progress.serverMessage
                : progress.phase === "water"
                ? `水面・河川情報 ${progress.completedSteps} / ${progress.totalSteps}`
                : progress.phase === "osm"
                  ? "道路・立入・建物情報を保存しています…"
                  : progress.phase === "finalizing"
                    ? "端末への保存を確定しています…"
                    : progress.totalSteps === 0
                      ? "既に最新の状態です。"
                      : progress.phase === "terrain" && progress.currentBearingDegrees !== null
                        ? `${progress.completedSteps} / ${progress.totalSteps} 方位（${progress.currentBearingDegrees}°）・${progress.terrainStage === "high-precision" ? "高精度DEM保存中" : "地形プロファイル取得中"}`
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
