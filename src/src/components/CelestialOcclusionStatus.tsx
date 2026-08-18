import { useMemo, useState } from "react";
import { presentCelestialOcclusionReason } from "../celestial/occlusionReason";
import type {
  CelestialBodyId,
  CelestialOcclusionMap,
  CelestialScreenPoint,
  CelestialVisibility,
} from "../types/celestial";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

type Props = {
  visibility: CelestialVisibility;
  occlusion: CelestialOcclusionMap;
  points: CelestialScreenPoint[];
  refractionWeather?: RefractionWeatherContext;
};

const BODY_LABELS: Record<CelestialBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
  polaris: "北極星",
};

const BODY_ORDER: CelestialBodyId[] = ["sun", "moon", "milkyWay", "polaris"];

// 屈折量は高度が下がるほど急増し不確実性も増える。この高度未満では
// 気象データの有無で構図が数分角ずれうることをユーザーへ知らせる。
const REFRACTION_WARNING_ALTITUDE_DEGREES = 5;

export function CelestialOcclusionStatus({
  visibility,
  occlusion,
  points,
  refractionWeather,
}: Props) {
  // プレビューの邪魔にならないよう、内容が同じ間は閉じたままにする。
  // 内容が変わったら（新しい情報なので）また表示する。
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);

  const presentations = useMemo(() => BODY_ORDER.flatMap((id) => {
    const result = occlusion[id];
    if (!visibility[id] || !result) return [];
    const presentation = presentCelestialOcclusionReason(result);
    return presentation ? [{ id, label: BODY_LABELS[id], ...presentation }] : [];
  }), [visibility, occlusion]);

  const blocked = presentations.filter((item) => item.state === "blocked");
  const checking = presentations.filter((item) => item.state === "checking");
  const unavailable = presentations.filter((item) => item.state === "unavailable");
  const reportedIds = new Set(presentations.map((item) => item.id));

  // 実際に画面へ表示されている（遮蔽・確認中でない）低空の天体だけを対象にする。
  const refractionUncertain = useMemo(() => {
    const source = refractionWeather?.source;
    if (source === "forecast") return [];
    const label = source === "climatology"
      ? "平年値による屈折補正のため、実際の見え方と数分角ずれる場合があります"
      : "気象データなしの標準屈折補正のため、地平線付近で構図が数分角ずれる可能性があります";
    const ids = BODY_ORDER.filter((id) => {
      if (!visibility[id] || reportedIds.has(id)) return false;
      const point = points.find((candidate) => candidate.id === id);
      return point !== undefined
        && point.visibleInFrame
        && point.altitudeDegrees < REFRACTION_WARNING_ALTITUDE_DEGREES;
    });
    return ids.length > 0 ? [{ ids, message: label }] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility, points, refractionWeather, presentations]);

  if (presentations.length === 0 && refractionUncertain.length === 0) return null;

  const signature = JSON.stringify([
    presentations.map((item) => [item.id, item.state, item.message]),
    refractionUncertain.map((item) => [item.ids.join(","), item.message]),
  ]);
  if (dismissedSignature === signature) return null;

  return (
    <section
      className="celestial-occlusion-status"
      role="status"
      aria-live="polite"
      aria-label="天体の遮蔽・屈折不確実性"
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
      {refractionUncertain.map(({ ids, message }) => (
        <span key={`refraction-${ids.join("-")}`} className="refraction-uncertain">
          <b>{ids.map((id) => BODY_LABELS[id]).join("・")}</b>{message}
        </span>
      ))}
      <button
        type="button"
        className="celestial-occlusion-status-dismiss"
        aria-label="このメッセージを閉じる"
        onClick={() => setDismissedSignature(signature)}
      >
        閉じる ×
      </button>
    </section>
  );
}
