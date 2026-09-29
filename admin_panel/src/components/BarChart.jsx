/** Диаграммаи сутунии оддӣ (SVG) — бе китобхонаи беруна. */
export function BarChart({ data, valueKey, labelKey = 'day' }) {
  const width = 640;
  const height = 180;
  const pad = { top: 16, bottom: 26, left: 8, right: 8 };
  const values = data.map((d) => Number(d[valueKey] ?? 0));
  const max = Math.max(1, ...values);
  const slot = (width - pad.left - pad.right) / Math.max(1, data.length);
  const barWidth = Math.max(4, slot * 0.62);
  const scale = (v) => ((height - pad.top - pad.bottom) * v) / max;

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary-2)" />
          <stop offset="100%" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
      {data.map((d, i) => {
        const v = values[i];
        const h = scale(v);
        const x = pad.left + i * slot + (slot - barWidth) / 2;
        const y = height - pad.bottom - h;
        const label = String(d[labelKey] ?? '').slice(5);
        return (
          <g key={d[labelKey] ?? i}>
            <rect className="bar" x={x} y={y} width={barWidth} height={Math.max(h, v > 0 ? 2 : 0)} rx="4">
              <title>{`${d[labelKey]}: ${v}`}</title>
            </rect>
            {v > 0 && (
              <text x={x + barWidth / 2} y={y - 4} textAnchor="middle">
                {v}
              </text>
            )}
            {(data.length <= 14 || i % 2 === 0) && (
              <text x={x + barWidth / 2} y={height - 8} textAnchor="middle">
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
