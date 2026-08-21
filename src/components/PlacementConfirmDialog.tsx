const KIND_LABEL: Record<"subject" | "tripod" | "person", string> = {
  subject: "被写体",
  tripod: "三脚",
  person: "人物",
};

type Props = {
  open: boolean;
  kind: "subject" | "tripod" | "person" | null;
  heightOffsetMeters: number;
  onHeightOffsetChange: (value: number) => void;
  busy: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function PlacementConfirmDialog({
  open,
  kind,
  heightOffsetMeters,
  onHeightOffsetChange,
  busy,
  errorMessage,
  onConfirm,
  onCancel,
}: Props) {
  if (!open || !kind) return null;
  const label = KIND_LABEL[kind];
  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${label}ピンの配置確認`}
      >
        <h2>ここに{label}ピンを置きますか？</h2>
        <label>
          選択位置より上空に置く高さ
          <span className="placement-offset-input">
            <input
              type="number"
              step="0.1"
              value={heightOffsetMeters}
              onChange={(event) => onHeightOffsetChange(Number(event.target.value))}
              disabled={busy}
            />
            <b>m</b>
          </span>
        </label>
        <p className="project-dialog-note">
          三脚で高さを入力した場合は、選択した緯度経度の地表面を基準に、その高さから入力した分だけ上空へ配置します。0mでは選択した3D表面（地面・屋上・橋面など）へ配置します。
        </p>
        {errorMessage && <p className="project-dialog-error" role="alert">{errorMessage}</p>}
        <div>
          <button type="button" onClick={onCancel} disabled={busy}>
            いいえ
          </button>
          <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "高度を取得しています…" : "はい、ここに置く"}
          </button>
        </div>
      </section>
    </div>
  );
}
