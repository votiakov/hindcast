import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/**
 * Risk lens: while the failure audit is open, components carry their worst finding, and the
 * selected incident's target and blast radius are ringed on the board.
 */
export function RiskMark({ id }: { id: string }) {
  const b = useBoardId();
  const on = useSim((s) => b === 'main' && s.auditOpen && !!s.audit.result);
  const worst = useSim((s) => {
    if (!on) return null;
    const fs = s.audit.result!.findings.filter((f) => f.target === id && (f.severity === 'critical' || f.severity === 'major') && f.kind !== 'surge' && f.kind !== 'headroom');
    if (!fs.length) return null;
    const crit = fs.filter((f) => f.severity === 'critical');
    // a primitive, so the selector is stable between renders
    return `${crit.length ? 'critical' : 'major'}|${fs.length}|${fs.some((f) => f.kind === 'component' && f.severity === 'critical') ? 1 : 0}`;
  });
  const role = useSim((s) => {
    if (!on || !s.audit.selected) return null;
    const f = s.audit.result!.findings.find((x) => x.id === s.audit.selected);
    if (!f) return null;
    return f.target === id ? 'target' : f.blastRadius.includes(id) ? 'blast' : null;
  });
  if (!on) return null;
  const [sev, n, spof] = worst ? worst.split('|') : [];
  return (
    <>
      {role && <div className={`risk-ring ${role}`} />}
      {worst && <div className={`risk-mark sev-${sev}`}>{spof === '1' ? 'SINGLE POINT OF FAILURE' : `${n} RISK${+n > 1 ? 'S' : ''}`}</div>}
    </>
  );
}
