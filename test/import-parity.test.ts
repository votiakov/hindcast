import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initSync, importBundle as importBundleRs, readWorkloads as readWorkloadsRs, strategyFromDiff as strategyFromDiffRs } from '../src/backtest/wasm/hindcast_engine.js';
import { readWorkloadsTs, strategyFromDiffTs, yamlDocuments } from '../src/backtest/configDiff';
import { importBundleTs, ImportManifest } from '../src/backtest/import/manifest';
import { fileAccess } from '../cli/files';

/**
 * The Rust importers (engine-rs/src/import) against the TypeScript ones: every import manifest in the
 * repository goes through both, and the datasets and logs must agree.
 */
type Diff = { where: string; ts: unknown; rs: unknown };

function compare(a: unknown, b: unknown, where: string, out: Diff[]) {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!(Math.abs(a - b) <= tol)) out.push({ where, ts: a, rs: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return void out.push({ where: `${where}.length`, ts: a.length, rs: b.length });
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined && (b as Record<string, unknown>)[k] !== null).sort();
    const ka2 = ka.filter((k) => (a as Record<string, unknown>)[k] !== null || kb.includes(k));
    if (ka2.join() !== kb.join()) return void out.push({ where: `${where} keys`, ts: ka2, rs: kb });
    for (const k of kb) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, out);
    return;
  }
  if (a !== b) out.push({ where, ts: a, rs: b });
}

function manifests(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) manifests(p, out);
    else if (/^(bottleneck|hindcast)\.import\.yaml$/.test(e)) out.push(p);
  }
  return out;
}

beforeAll(() => initSync({ module: readFileSync('src/backtest/wasm/hindcast_engine_bg.wasm') }));

const all = [...manifests('demos'), ...manifests('reference')].sort();

describe.each(all)('Rust import matches TypeScript on %s', (path) => {
  it('dataset and log', () => {
    const m = ImportManifest.parse(parse(readFileSync(path, 'utf8')));
    const fs = fileAccess(path);
    const ts = importBundleTs(m, fs);
    const rs = importBundleRs(m, fs);
    const diffs: Diff[] = [];
    compare(JSON.parse(JSON.stringify(ts)), JSON.parse(JSON.stringify(rs)), 'import', diffs);
    expect(diffs).toEqual([]);
  });
});

const k8s = ['examples/backtest-ci/deploy/hotrod.yaml', 'examples/kubernetes/shop.yaml', 'reference/k8s/shop/shop.yaml', ...(existsSync('reference/k8s/shop/variants') ? readdirSync('reference/k8s/shop/variants').map((f) => `reference/k8s/shop/variants/${f}`) : [])].filter(existsSync);

describe('Rust config diff matches TypeScript', () => {
  // each manifest alone, and the reference shop with every variant laid over it (later documents win)
  const sets: [string, string[]][] = [...k8s.map((f): [string, string[]] => [f, [readFileSync(f, 'utf8')]]), ...k8s.filter((f) => f.includes('/variants/')).map((f): [string, string[]] => [`shop + ${f}`, [readFileSync('reference/k8s/shop/shop.yaml', 'utf8'), readFileSync(f, 'utf8')]])];
  it.each(sets)('workloads of %s', (_, texts) => {
    const diffs: Diff[] = [];
    compare(JSON.parse(JSON.stringify([...readWorkloadsTs(texts)])), readWorkloadsRs(yamlDocuments(texts)), 'workloads', diffs);
    expect(diffs).toEqual([]);
  });
  it('the strategy between every pair', () => {
    const diffs: Diff[] = [];
    for (const [a, ta] of sets)
      for (const [b, tb] of sets) {
        const wa = readWorkloadsTs(ta);
        const wb = readWorkloadsTs(tb);
        const known = new Set([...wa.keys()].slice(1));
        for (const opts of [{}, { known }, { name: 'x' }]) {
          const ts = strategyFromDiffTs(wa, wb, opts);
          const rs = strategyFromDiffRs([...wa], [...wb], (opts as { name?: string }).name, 'known' in opts ? [...known] : undefined);
          compare(JSON.parse(JSON.stringify(ts)), rs, `${a} → ${b}`, diffs);
        }
      }
    expect(diffs).toEqual([]);
  });
});
