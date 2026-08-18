type Props = {
  active: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function SubjectEditOverlay({
  active,
  onConfirm,
  onCancel,
}: Props) {
  if (!active) return null;

  return (
    <>
      <div className="subject-crosshair" aria-hidden="true">
        <span className="crosshair-horizontal" />
        <span className="crosshair-vertical" />
        <span className="crosshair-center" />
      </div>

      <section className="subject-edit-panel">
        <p>
          3D画面を動かし、狙う位置を中央の十字へ合わせてください
        </p>

        <div className="subject-edit-actions">
          <button
            type="button"
            className="subject-edit-cancel"
            onClick={onCancel}
          >
            キャンセル
          </button>

          <button
            type="button"
            className="subject-edit-confirm"
            onClick={onConfirm}
          >
            ここを被写体にする
          </button>
        </div>
      </section>
    </>
  );
}
