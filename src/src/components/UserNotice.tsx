import type { UserNoticeTone } from "../errors/userFeedback";

type Props = {
  tone: UserNoticeTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
};

export function UserNotice({
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: Props) {
  return (
    <aside
      className={`user-notice ${tone}`}
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
  );
}
