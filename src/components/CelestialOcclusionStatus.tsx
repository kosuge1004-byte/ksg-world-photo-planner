import { useMemo } from "react";
import { presentCelestialOcclusionReason } from "../celestial/occlusionReason";
import type {
  CelestialBodyId,
  CelestialOcclusionMap,
  CelestialVisibility,
} from "../types/celestial";

type Props = {
  visibility: CelestialVisibility;
  occlusion: CelestialOcclusionMap;
};

const BODY_LABELS: Record<CelestialBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
  polaris: "北極星",
};

const BODY_ORDER: CelestialBodyId[] = ["sun", "moon", "milkyWay", "polaris"];

export function CelestialOcclusionStatus({ visibility, occlusion }: Props) {
  const presentations = useMemo(() => BODY_ORDER.flatMap((id) => {
    const result = occlusion[id];
    if (!visibility[id] || !result) return [];
    const presentation = presentCelestialOcclusionReason(result);
    return presentation ? [{ id, label: BODY_LABELS[id], ...presentation }] : [];
  }), [visibility, occlusion]);

  const blocked = presentations.filter((item) => item.state === "blocked");
  const checking = presentations.filter((item) => item.state === "checking");
  const unavailable = presentations.filter((item) => item.state === "unavailable");

  if (presentations.length === 0) return null;

  return (
    <section
      className="celestial-occlusion-status"
      role="status"
      aria-live="polite"
      aria-label="天体の遮蔽状態"
    >
      {blocked.map((item) => (
        <span key={item.id} className="blocked">
          <b>{item.label}</b>{item.message}
        </span>
      ))}
      {checking.length > 0 && (
        <span className="checking">
          <b>{checking.map((item) => item.label).join("・")}</b>
          {checking.every((item) => item.message === "建物の遮蔽を確認中です")
            ? "建物の遮蔽を確認中です"
            : "遮蔽を確認中です"}
        </span>
      )}
      {unavailable.length > 0 && (
        <span className="unavailable">
          <b>{unavailable.map((item) => item.label).join("・")}</b>
          {unavailable.every((item) => item.message === "建物の遮蔽を確認できません")
            ? "建物の遮蔽を確認できません"
            : "遮蔽を確認できません"}
        </span>
      )}
    </section>
  );
}
