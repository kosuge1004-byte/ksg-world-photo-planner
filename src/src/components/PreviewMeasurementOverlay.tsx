import type { PreviewMeasurementPoint } from "../measurement/previewMeasurement";

type Props = {
  points: PreviewMeasurementPoint[];
  distanceMeters: number | null;
};

function formatDistance(distanceMeters: number): string {
  return distanceMeters >= 1000
    ? `${(distanceMeters / 1000).toFixed(2)}km`
    : `${distanceMeters < 10 ? distanceMeters.toFixed(2) : Math.round(distanceMeters)}m`;
}

export function PreviewMeasurementOverlay({ points, distanceMeters }: Props) {
  if (points.length === 0) return null;
  const [a, b] = points;
  // 点・ラベルはSVGのviewBox座標（非等方スケーリング）に置くと、円が楕円に
  // 潰れたりラベル背景が引き伸ばされたりするため、通常のHTML要素を
  // left/top%で配置する（線だけは両端を%指定するだけなのでSVGのままでよい）。
  return (
    <div className="preview-measurement-overlay" aria-hidden="true">
      {a && b && (
        <svg
          className="preview-measurement-line-layer"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <line
            x1={a.xPercent} y1={a.yPercent}
            x2={b.xPercent} y2={b.yPercent}
            className="preview-measurement-line"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {points.map((point, index) => (
        <div
          key={index}
          className="preview-measurement-point"
          style={{ left: `${point.xPercent}%`, top: `${point.yPercent}%` }}
        />
      ))}
      {a && b && distanceMeters !== null && (
        <div
          className="preview-measurement-label"
          style={{
            left: `${(a.xPercent + b.xPercent) / 2}%`,
            top: `${(a.yPercent + b.yPercent) / 2}%`,
          }}
        >
          {formatDistance(distanceMeters)}
        </div>
      )}
    </div>
  );
}
