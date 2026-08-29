import type { SharedProjectPayloadV1 } from "../sharing/projectShareCode";

type Props = {
  open: boolean;
  payload: SharedProjectPayloadV1 | null;
  importing: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onImport: () => void;
};

export function SharedProjectImportDialog({
  open,
  payload,
  importing,
  errorMessage,
  onCancel,
  onImport,
}: Props) {
  if (!open || !payload) return null;
  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="共有された撮影計画を取り込む"
      >
        <h2>共有された撮影計画</h2>
        <dl>
          <dt>名前</dt>
          <dd>{payload.name || "（名称未設定）"}</dd>
          <dt>撮影日時</dt>
          <dd>{payload.shootingDateTimeLocal.replace("T", " ")}（{payload.timeZone}）</dd>
          <dt>被写体</dt>
          <dd>{payload.subject.label}（{payload.subject.latitude.toFixed(6)}, {payload.subject.longitude.toFixed(6)}）</dd>
          <dt>三脚</dt>
          <dd>{payload.tripod.label}（{payload.tripod.latitude.toFixed(6)}, {payload.tripod.longitude.toFixed(6)}）</dd>
        </dl>
        <p className="project-dialog-note">
          高度（標高）はこの端末で地形データから取り直します。送信側の値はそのまま使いません。
        </p>
        {errorMessage && <p className="project-dialog-error" role="alert">{errorMessage}</p>}
        <div>
          <button type="button" onClick={onCancel} disabled={importing}>
            キャンセル
          </button>
          <button type="button" className="primary" onClick={onImport} disabled={importing}>
            {importing ? "高度を取得しています…" : "この計画を取り込む"}
          </button>
        </div>
      </section>
    </div>
  );
}
