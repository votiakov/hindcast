interface Props {
  values: number[];
  max?: number;
  width?: number;
  height?: number;
  color: string;
}

export function Sparkline({ values, max, width = 180, height = 28, color }: Props) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const top = max ?? Math.max(1e-6, ...values);
  const n = 90;
  const pts = values.map((v, i) => {
    const x = ((i + n - values.length) / (n - 1)) * width;
    const y = height - 2 - (Math.min(v, top) / top) * (height - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const gid = `sg-${color.replace('#', '')}`;
  return (
    <svg width={width} height={height} className="sparkline">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
