import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import * as W from '../src/backtest/wasm/hindcast_engine.js';
import { yamlDocuments } from '../src/backtest/configDiff';
import { importKubernetes } from '../src/spec/kubernetes';
import { importTerraform } from '../src/spec/terraform';
import { specToYaml } from '../src/spec/yaml';

/**
 * The YAML the native CLI writes (engine-rs/src/yaml_out.rs) against what the app writes with the
 * yaml package: specs as the spec editor shows them, and strategies as yaml.stringify does.
 */
type Diff = { where: string; ts: unknown; rs: unknown };

const k8s = ['examples/backtest-ci/deploy/hotrod.yaml', 'examples/kubernetes/shop.yaml', 'reference/k8s/shop/shop.yaml', ...(existsSync('reference/k8s/shop/variants') ? readdirSync('reference/k8s/shop/variants').map((f) => `reference/k8s/shop/variants/${f}`) : [])].filter(existsSync);

describe('Rust spec → YAML matches the yaml package byte for byte', () => {
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const strings = ['plain', 'with space', 'a: b', 'a:b', 'a #b', 'a#b', '#a', '-a', '- a', '?a', '? a', ':a', 'a:', 'true', 'True', 'TRUE', 'yes', 'no', 'on', 'null', 'Null', '~', '', ' lead', 'trail ', '123', '1.5', '1e3', '0x1F', '0o7', '.inf', '.nan', '-.inf', '+1', '1_000', '01', '-1', 'a,b', '[a]', '{a}', 'a]', "it's", 'say "hi"', `both ' and "`, 'tab\there', '%x', '@x', '`x', '!x', '&x', '*x', '|x', '>x', "'x", '"x', 'é', 'a\nb', '日本', 'x -> y', 'a\\b', 'line\n', '\n', ' ', 'a  b', '2026-10-14', '12:30', '0.', '.5', '-', '--', '---', '...', 'a\u0007b', 'a\u0000b', 'x\u001by', 'two\n\nlines', ' indented\nnext', 'ends with space \nnext', 'a long line that is longer than forty characters\nand another', '\n\nlead', 'trail\n\n', 'mixed\n  indented\nback', '---\ndoc', '%dir\nx', 'tab\t\nx', 'x\u0085y', 'emoji 😀', 'a\rb'];
  const numbers = [0, 1, -1, 0.1, 1e21, 1e-7, 123456789012, 0.85, 2.5, 1000000, 3.14159];
  const value = (d: number): unknown => {
    const r = rnd();
    if (d > 2 || r < 0.5) return rnd() < 0.6 ? pick(strings) : rnd() < 0.7 ? pick(numbers) : pick([true, false, null]);
    if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick([...strings.slice(0, 30), 'min', 'max', 'id']), value(d + 1)]));
  };
  const spec = () => ({
    version: 1,
    name: pick(strings),
    ...(rnd() < 0.5 ? { description: pick(strings) } : {}),
    components: Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ id: pick(strings), kind: pick(['server', 'db', 'client']), ...(rnd() < 0.5 ? { autoscale: { min: 1, max: pick(numbers) } } : {}), ...(rnd() < 0.5 ? { extra: value(1) } : {}), ...(rnd() < 0.3 ? { list: [pick(strings), pick(numbers)] } : {}) })),
    connections: Array.from({ length: Math.floor(rnd() * 5) }, () => pick([[pick(strings), pick(strings)], [pick(['a', 'b', 'api']), pick(['db', 'c'])], `${pick(['a', 'b'])} -> ${pick(['c', 'd'])}`, { from: pick(strings), to: pick(strings), latencyMs: pick(numbers) }, [pick(strings)]])),
    ...(rnd() < 0.4 ? { zones: [{ id: pick(strings), label: pick(strings), members: [pick(strings), pick(strings)] }] } : {}),
    ...(rnd() < 0.3 ? { other: value(0) } : {}),
  });
  it('the example specs, imported specs and 500 generated ones', () => {
    const diffs: Diff[] = [];
    const check = (v: unknown, where: string) => {
      const a = specToYaml(v);
      const b = W.specToYaml(v);
      if (a !== b) {
        const la = a.split('\n');
        const lb = b.split('\n');
        let i = 0;
        while (la[i] === lb[i]) i++;
        diffs.push({ where, ts: la.slice(Math.max(0, i - 2), i + 3).join('⏎'), rs: lb.slice(Math.max(0, i - 2), i + 3).join('⏎') });
      }
    };
    for (const f of readdirSync('examples').filter((x) => x.endsWith('.yaml'))) check(parseYaml(readFileSync(`examples/${f}`, 'utf8')), f);
    check(importTerraform(tf0()).spec, 'terraform import');
    for (const f of k8s) check(importKubernetes(yamlDocuments([readFileSync(f, 'utf8')])).spec, f);
    for (let i = 0; i < 500; i++) check(spec(), `spec ${i}`);
    for (const s of strings) check({ k: s, f: [s, 'x'], m: { components: [{ id: s, a: { b: s } }] }, components: [{ id: s, o: { x: s } }], zones: [{ id: 'z', members: [s, 'y'] }], connections: [[s, 'y'], { from: s, to: 'y' }] }, JSON.stringify(s));
    expect(diffs.slice(0, 4)).toEqual([]);
  });
  const tf0 = () => JSON.parse(readFileSync('examples/terraform/shop.tfstate.json', 'utf8'));
});

describe('Rust YAML (package defaults) matches yaml.stringify byte for byte', async () => {
  const { stringify } = await import('yaml');
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const words = ['api', 'frontend', 'replicas', '→', 'CPU', '2', 'autoscale', 'Graviton (arm64)', 'memory', '0.50', 'GiB', '#tag', 'a: b', 'it\'s', 'say "x"', 'x'];
  const sentence = (n: number) => Array.from({ length: n }, () => pick(words)).join(pick([' ', ' ', '; ', ', ']));
  const strings = () => pick([sentence(3), sentence(14), sentence(30), sentence(60), `${sentence(10)}\n${sentence(25)}`, `${sentence(40)}\n\n${sentence(5)}\n`, ' lead ' + sentence(20), sentence(25) + ':', `"${sentence(30)}"`, 'x'.repeat(95), `${'y'.repeat(50)} ${'z'.repeat(50)}`, '', 'true', '12']);
  const value = (d: number): unknown => {
    const r = rnd();
    if (d > 3 || r < 0.45) return rnd() < 0.7 ? strings() : pick([1, 0.5, 300, true, null]);
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(['name', 'description', 'service', 'changes', 'a long key name here', 'autoscale']), value(d + 1)]));
  };
  it('strategies from config diffs and 600 generated documents', () => {
    const diffs: Diff[] = [];
    const check = (v: unknown, where: string) => {
      const a = stringify(v);
      const b = W.toYaml(v);
      if (a !== b) diffs.push({ where, ts: a, rs: b });
    };
    for (const [a] of [['x']]) void a;
    for (let i = 0; i < 600; i++) check(value(0), `doc ${i}`);
    check({ name: 'api 3 → 5 replicas; web CPU 0.5 → 1; db memory 2.00 → 4.00 GiB; cache autoscale 2–8 @ 60% CPU; worker → Graviton (arm64)', description: 'from the pull request diff', changes: [{ service: 'api', replicas: 5 }, { service: 'cache', autoscale: { min: 2, max: 8, targetCpu: 0.6, cooldownS: 300, warmupS: 30 } }] }, 'strategy');
    expect(diffs.slice(0, 3)).toEqual([]);
  });
});
