import type { CelestialBodyId, CelestialVisibility } from "../types/celestial";

type Props = {
  open: boolean;
  visibility: CelestialVisibility;
  onToggleOpen: () => void;
  onChangeVisibility: (visibility: CelestialVisibility) => void;
  lightPollutionEnabled: boolean;
  onChangeLightPollution: (enabled: boolean) => void;
};

const items: Array<{
  key: CelestialBodyId;
  label: string;
  symbol: string;
}> = [
  { key: "sun", label: "太陽", symbol: "☀" },
  { key: "moon", label: "月", symbol: "☾" },
  { key: "milkyWay", label: "天の川", symbol: "✦" },
  { key: "polaris", label: "北極星", symbol: "★" },
];

const ALL_OFF: CelestialVisibility = {
  sun: false,
  moon: false,
  milkyWay: false,
  polaris: false,
};

function singleSelection(visibility: CelestialVisibility): CelestialBodyId {
  return (items.find((item) => visibility[item.key])?.key) ?? "sun";
}

/**
 * 2026-09-02変更（明示指示により）: 天体は同時に複数表示せず、必ず1つだけを
 * 選ぶプルダウン方式にする。計算・描画が同時に走る天体の数を確実に1つへ
 * 減らし、候補探索・プレビューの負荷を直接下げる狙い。
 * CelestialVisibility型自体（4つの真偽値を持つオブジェクト）は保存済み
 * プロジェクト・共有リンクとの互換性のため変更せず、常にどれか1つだけが
 * trueになるよう、この画面からの変更経路だけで制御する。
 */
export function CelestialMenu({
  open,
  visibility,
  onToggleOpen,
  onChangeVisibility,
  lightPollutionEnabled,
  onChangeLightPollution,
}: Props) {
  const selected = singleSelection(visibility);

  return (
    <section className="celestial-menu">
      <button
        type="button"
        className="celestial-menu-button"
        onClick={onToggleOpen}
        aria-expanded={open}
      >
        天体の表示 {open ? "▲" : "▼"}
      </button>

      {open && (
        <div className="celestial-menu-popover">
          <label className="celestial-select-label">
            <span>表示する天体</span>
            <select
              className="celestial-select"
              value={selected}
              onChange={(event) =>
                onChangeVisibility({
                  ...ALL_OFF,
                  [event.target.value as CelestialBodyId]: true,
                })
              }
            >
              {items.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.symbol} {item.label}
                </option>
              ))}
            </select>
          </label>
          {selected === "milkyWay" && (
            <label className="light-pollution-toggle">
              <span className="celestial-symbol">◉</span>
              <span>光害マップ</span>
              <input
                type="checkbox"
                checked={lightPollutionEnabled}
                onChange={(event) => onChangeLightPollution(event.target.checked)}
              />
            </label>
          )}
        </div>
      )}
    </section>
  );
}
