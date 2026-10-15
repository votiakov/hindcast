import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { initSync } from '../../src/backtest/wasm/hindcast_engine.js';
import { validateSpec } from '../../src/spec/validate';
import { simulate } from '../../src/sim/headless';
import { audit } from '../../src/sim/audit';
import { auditMarkdown } from '../../src/sim/auditReport';
import type { AuditDone, Request, Summary } from './protocol';

// The engine (WebAssembly) in a worker thread, so a long audit never blocks the editor.
initSync({ module: readFileSync(join(__dirname, 'hindcast_engine_bg.wasm')) });

export function summary(value: unknown, rps: number | undefined): Summary {
  const r = simulate(value, rps ? { rps } : {});
  const top = r.bottlenecks[0];
  return {
    scenario: r.scenario,
    p99Ms: r.summary.peakP99Ms,
    errorRate: r.summary.meanErrorRate,
    monthly: r.summary.meanCostPerHour * 730,
    sloCompliance: r.summary.sloCompliance,
    slo: r.slo,
    bottleneck: top && top.peakUtil >= 0.8 ? { id: top.id, note: top.note } : null,
  };
}

function run(req: Request): unknown {
  switch (req.op) {
    case 'validate': {
      const v = validateSpec(req.value);
      return { ok: v.ok, issues: v.issues };
    }
    case 'summary':
      return summary(req.value, req.rps);
    case 'audit': {
      const r = audit(req.value, {
        rps: req.rps,
        incidentCostPerMinute: req.costPerMinute,
        onProgress: (done, total, label) => parentPort!.postMessage({ id: req.id, progress: { done, total, label } }),
      });
      const done: AuditDone = { markdown: auditMarkdown(r), score: r.score, critical: r.findings.filter((f) => f.severity === 'critical').length };
      return done;
    }
  }
}

parentPort?.on('message', (req: Request) => {
  try {
    parentPort!.postMessage({ id: req.id, result: run(req) });
  } catch (e) {
    parentPort!.postMessage({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
});
