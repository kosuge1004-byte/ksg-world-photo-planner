import { useState } from "react";
import type { UserNoticeTone } from "../errors/userFeedback";

type Props = {
  tone: UserNoticeTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  diagnosticDetail?: string;
};

export function UserNotice({
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
  diagnosticDetail,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopyDetail = async () => {
    if (!diagnosticDetail) return;
    try {
      await navigator.clipboard.writeText(diagnosticDetail);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 3_000);
  };

  // 2026-08-26追記: 「Cesium ion接続」のような、見逃すとGoogleタイル
  // モードが使えないままになる重要な案内が、画面上部に小さく表示される
  // だけで気づかれにくかったため、行動を要する通知（actionLabelがある
  // もの）だけ、画面中央に大きく表示する。
  const isActionable = Boolean(actionLabel && onAction);

  return (
    <>
      {isActionable && <div className="user-notice-backdrop" onClick={onDismiss} />}
      <aside
        className={`user-notice ${tone}${isActionable ? " prominent" : ""}`}
        role={tone === "error" ? "alert" : "status"}
        aria-live={tone === "error" ? "assertive" : "polite"}
      >
        <span>{message}</span>
        <div className="user-notice-actions">
          {actionLabel && onAction && (
            <button type="button" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          {diagnosticDetail && (
            <button
              type="button"
              className="user-notice-copy-detail"
              onClick={handleCopyDetail}
              title="開発者に問題を報告する際に役立つ技術的な情報をコピーします"
            >
              {copyState === "copied"
                ? "コピーしました"
                : copyState === "failed"
                  ? "コピーできませんでした"
                  : "詳細をコピー"}
            </button>
          )}
          <button
            type="button"
            className="user-notice-dismiss"
            onClick={onDismiss}
            aria-label="通知を閉じる"
          >
            ×
          </button>
        </div>
      </aside>
    </>
  );
}
