type Props = {
  subjectActive: boolean;
  tripodActive: boolean;
  onSubjectToggle: () => void;
  onSubjectEdit: () => void;
  onTripodToggle: () => void;
};

export function PinControls({
  subjectActive,
  tripodActive,
  onSubjectToggle,
  onSubjectEdit,
  onTripodToggle,
}: Props) {
  return (
    <section className="pin-controls" aria-label="ピン設定">
      <button
        type="button"
        className={
          subjectActive
            ? "pin-button subject active"
            : "pin-button subject"
        }
        onClick={onSubjectToggle}
      >
        {subjectActive
          ? "地図をクリックして被写体変更"
          : "被写体ピンを変更"}
      </button>

      <button
        type="button"
        className="subject-edit-start-button"
        onClick={onSubjectEdit}
      >
        3Dで被写体を指定
      </button>

      <button
        type="button"
        className={
          tripodActive
            ? "pin-button tripod active"
            : "pin-button tripod"
        }
        onClick={onTripodToggle}
      >
        {tripodActive
          ? "地図をクリックして三脚設置"
          : "三脚ピンを設置"}
      </button>
    </section>
  );
}
