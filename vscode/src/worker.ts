import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { initSync } from '../../src/backtest/wasm/hindcast_engine.js';
import { validateSpec } from '../../src/spec/validate';
import { audit } from '../../src/sim/audit';
import { auditMarkdown } from '../../src/sim/auditReport';
import { summary } from './summary';
import type { AuditDone, Request } from './protocol';

// The engine (WebAssembly) in a worker thread, so a long audit never blocks the editor.
initSync({ module: readFileSync(join(__dirname, 'hindcast_engine_bg.wasm')) });

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
