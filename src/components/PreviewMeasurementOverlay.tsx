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
  return (
    <svg
      className="preview-measurement-overlay"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {a && b && (
        <line
          x1={a.xPercent} y1={a.yPercent}
          x2={b.xPercent} y2={b.yPercent}
          className="preview-measurement-line"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.xPercent}
          cy={point.yPercent}
          r={1.4}
          className="preview-measurement-point"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {a && b && distanceMeters !== null && (
        <foreignObject
          x={Math.min(a.xPercent, b.xPercent, 92)}
          y={Math.min(a.yPercent, b.yPercent, 92)}
          width={40}
          height={12}
        >
          <div className="preview-measurement-label">{formatDistance(distanceMeters)}</div>
        </foreignObject>
      )}
    </svg>
  );
}
