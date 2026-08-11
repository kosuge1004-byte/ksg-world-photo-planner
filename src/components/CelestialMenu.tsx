import type { CelestialVisibility } from "../types/celestial";

type Props = {
  open: boolean;
  visibility: CelestialVisibility;
  onToggleOpen: () => void;
  onChangeVisibility: (visibility: CelestialVisibility) => void;
  lightPollutionEnabled: boolean;
  onChangeLightPollution: (enabled: boolean) => void;
};

const items: Array<{
  key: keyof CelestialVisibility;
  label: string;
  symbol: string;
}> = [
  { key: "sun", label: "太陽", symbol: "☀" },
  { key: "moon", label: "月", symbol: "☾" },
  { key: "milkyWay", label: "天の川", symbol: "✦" },
  { key: "polaris", label: "北極星", symbol: "★" },
];

export function CelestialMenu({
  open,
  visibility,
  onToggleOpen,
  onChangeVisibility,
  lightPollutionEnabled,
  onChangeLightPollution,
}: Props) {
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
          <div className="celestial-checks">
            {items.map((item) => (
              <label key={item.key}>
                <span className="celestial-symbol">{item.symbol}</span>
                <span>{item.label}</span>
                <input
                  type="checkbox"
                  checked={visibility[item.key]}
                  onChange={(event) =>
                    onChangeVisibility({
                      ...visibility,
                      [item.key]: event.target.checked,
                    })
                  }
                />
              </label>
            ))}
          </div>
          {visibility.milkyWay && (
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
          <button
            type="button"
            className="celestial-reset-button"
            onClick={() =>
              onChangeVisibility({
                sun: true,
                moon: true,
                milkyWay: true,
                polaris: true,
              })
            }
          >
            すべて表示
          </button>
        </div>
      )}
    </section>
  );
}
