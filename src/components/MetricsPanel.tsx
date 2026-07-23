import type { LineMetrics } from "../types/points";

type Props = {
  metrics: LineMetrics | null;
};

function formatDistance(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} km`;
  }

  return `${value.toFixed(1)} m`;
}

export function MetricsPanel({ metrics }: Props) {
  if (!metrics) {
    return (
      <section className="metrics-panel empty">
        被写体ピンと三脚ピンを置くと、距離・方位・標高差を表示します
      </section>
    );
  }

  const prefix =
    metrics.heightDifferenceMeters > 0 ? "+" : "";

  return (
    <section className="metrics-panel">
      <div>
        <span>距離</span>
        <strong>{formatDistance(metrics.distanceMeters)}</strong>
      </div>

      <div>
        <span>方位角</span>
        <strong>{metrics.bearingDegrees.toFixed(1)}°</strong>
      </div>

      <div>
        <span>標高差</span>
        <strong>
          {prefix}
          {metrics.heightDifferenceMeters.toFixed(1)} m
        </strong>
      </div>
    </section>
  );
}
