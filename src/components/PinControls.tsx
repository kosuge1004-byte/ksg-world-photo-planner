import { memo } from "react";

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

export function PinControlsComponent({
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
          : "被写体をマップで選択"}
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
          : "三脚位置をマップで選択"}
      </button>

      <button
        type="button"
        className="tripod-candidate-pin-button"
        onClick={onPlaceTripodCandidate}
        disabled={!tripodCandidateAvailable}
      >
        三脚候補点に三脚設置
      </button>

      <button
        type="button"
        className="tripod-google-maps-button"
        onClick={onOpenTripodInGoogleMaps}
        disabled={!tripodAvailable}
      >
        Googleマップへ三脚位置を送る
      </button>
    </section>
  );
}

// 2026-09-02追記（合理化）: 無関係な状態変化での再実行を防ぐためmemo化。
export const PinControls = memo(PinControlsComponent);
