type Props = {
  subjectActive: boolean;
  tripodActive: boolean;
  onSubjectToggle: () => void;
  onOpenSubjectInGoogleMaps: () => void;
  subjectAvailable: boolean;
  onTripodToggle: () => void;
  onOpenTripodInGoogleMaps: () => void;
  tripodAvailable: boolean;
  onPlaceTripodCandidate: () => void;
  tripodCandidateAvailable: boolean;
};

export function PinControls({
  subjectActive,
  tripodActive,
  onSubjectToggle,
  onOpenSubjectInGoogleMaps,
  subjectAvailable,
  onTripodToggle,
  onOpenTripodInGoogleMaps,
  tripodAvailable,
  onPlaceTripodCandidate,
  tripodCandidateAvailable,
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
        className="subject-google-maps-button"
        onClick={onOpenSubjectInGoogleMaps}
        disabled={!subjectAvailable}
      >
        Googleマップへ被写体位置を送る
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

      <button
        type="button"
        className="tripod-candidate-pin-button"
        onClick={onPlaceTripodCandidate}
        disabled={!tripodCandidateAvailable}
      >
        三脚候補点に三脚ピンを置く
      </button>

      <button
        type="button"
        className="tripod-google-maps-button"
        onClick={onOpenTripodInGoogleMaps}
        disabled={!tripodAvailable}
      >
        Googleマップへ三脚ピンを送る
      </button>
    </section>
  );
}
