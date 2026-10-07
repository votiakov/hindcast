import { useSim } from '../sim/store';

/** Transit mark: two lines squeezed through one station — a bottleneck on a metro map. */
function TransitMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <path d="M2 9 H11 Q17 9 17 17 Q17 25 23 25 H32" fill="none" stroke="#D7261E" strokeWidth="5" strokeLinecap="round" />
      <path d="M2 25 H11 Q17 25 17 17 Q17 9 23 9 H32" fill="none" stroke="#0A3FA8" strokeWidth="5" strokeLinecap="round" />
      <circle cx="17" cy="17" r="6.5" fill="#fff" stroke="#16161A" strokeWidth="3.5" />
    </svg>
  );
}

/** Reference mark: a funnel — wide intake, narrow throat. */
function ReferenceMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <path d="M2 3 H20 L13 11 V19 L9 17 V11 Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export function BrandMark() {
  const theme = useSim((s) => s.settings.theme);
  return <div className="brand-mark">{theme === 'transit' ? <TransitMark /> : <ReferenceMark />}</div>;
}
