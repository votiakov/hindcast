// The native CLI (engine-rs, `hindcast`) against the Node one (cli/bottleneck.ts): every case runs
// through both; stdout, stderr and the exit code must match (wall-clock timings masked).
// npx tsx scripts/cli-parity.ts [filter]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = 'engine-rs/target/release/hindcast';
const out = mkdtempSync(join(tmpdir(), 'cli-parity-'));
const ex = 'examples';
const fx = 'test/cli-fixtures';
const PROM = 'http://127.0.0.1:19090';
const TEL = 'http://127.0.0.1:19091';
const ws = (k: string) => `${out}/OUT/ws-${k}`;
const agent = (tool: string, args: Record<string, unknown>) => ['agent', tool, JSON.stringify(args)];
/** cases whose stderr is a YAML parser's syntax message: only the exit code has to agree */
const PARSER_MESSAGE = new Set([`validate ${ex}/kubernetes/shop.yaml`, `audit ${ex}/kubernetes/shop.yaml`]);
export const CASES: string[][] = [
  [],
  ['nonsense'],
  ['validate', `${ex}/shop.yaml`],
  ['validate', `${ex}/shop.yaml`, '--json'],
  ['validate', `${fx}/bad-spec.yaml`],
  ['validate', `${fx}/bad-spec.yaml`, '--json'],
  ['validate', `${fx}/lint-spec.yaml`],
  ['validate', `${ex}/terraform/shop.yaml`],
  ['validate', `${ex}/kubernetes/shop.yaml`],
  ['validate', 'missing.yaml'],
  ['simulate', `${ex}/shop.yaml`],
  ['simulate', `${ex}/shop.yaml`, `${ex}/black-friday.yaml`],
  ['simulate', `${ex}/shop.yaml`, '--rps', '2500', '--duration', '30'],
  ['simulate', `${ex}/shop.yaml`, '--traffic', `${fx}/traffic.csv`],
  ['simulate', `${ex}/shop.yaml`, `${ex}/black-friday.yaml`, '--json'],
  ['simulate', `${ex}/shop.yaml`, '--engine', 'des', '--duration', '20'],
  ['simulate', `${ex}/shop.yaml`, '--engine', 'des', '--duration', '20', '--seed', '7', '--json'],
  ['simulate', `${fx}/bad-spec.yaml`],
  ['simulate', `${fx}/bad-conns.yaml`],
  ['simulate', `${fx}/bad-top.yaml`],
  ['simulate', `${fx}/bad-version.yaml`],
  ['validate', `${fx}/bad-conns.yaml`],
  ['validate', `${fx}/bad-conns.yaml`, '--json'],
  ['validate', `${fx}/bad-top.yaml`],
  ['validate', `${fx}/bad-version.yaml`],
  ['compare', `${ex}/shop.yaml`, `${ex}/shop-variants.yaml`],
  ['compare', `${ex}/shop.yaml`, `${ex}/shop-variants.yaml`, '--json'],
  ['compare', `${ex}/shop.yaml`, `${ex}/shop-variants.yaml`, `${ex}/black-friday.yaml`],
  ['breaking-point', `${ex}/shop.yaml`],
  ['breaking-point', `${ex}/shop.yaml`, '--p99', '300', '--errors', '0.02'],
  ['breaking-point', `${ex}/shop.yaml`, '--json'],
  ['import-terraform', `${ex}/terraform/shop.tfstate.json`],
  ['import-terraform', `${ex}/terraform/shop.tfstate.json`, '--name', 'My shop', '--json'],
  ['import-terraform', `${ex}/terraform/shop.tfstate.json`, '--out', `${out}/OUT/tf.yaml`],
  ['import-k8s', `${ex}/kubernetes/shop.yaml`],
  ['import-k8s', `${ex}/kubernetes/shop.yaml`, 'reference/k8s/shop/shop.yaml', '--name', 'Both'],
  ['import-k8s', `${ex}/kubernetes/shop.yaml`, '--json'],
  ['catalog'],
  ['link', `${ex}/shop.yaml`],
  ['link', `${ex}/shop.yaml`, `${ex}/shop-variants.yaml`],
  ['link', `${ex}/terraform/shop.yaml`],
  ['import', 'reference/hotrod/runs/history/bottleneck.import.yaml', '--out', `${out}/OUT/hotrod.dataset.json`],
  ['import', 'reference/k8s/shop/runs/normal-1/workspace/telemetry/bottleneck.import.yaml', '--out', `${out}/OUT/k8s.dataset.json`, '--json'],
  ['import', 'demos/ws/telemetry/bottleneck.import.yaml', '--out', `${out}/OUT/ws.dataset.json`],
  ['calibrate', 'reference/hotrod/dataset.json', '--out', `${out}/OUT/hotrod.model.json`],
  ['calibrate', 'reference/hotrod/dataset.json', '--out', `${out}/OUT/hotrod2.model.json`, '--holdout', '0.3', '--p99', '400'],
  ['calibrate', 'demos/ws/dataset.json', '--out', `${out}/OUT/ws.model.json`, '--json'],
  ['backtest', 'reference/hotrod/model.json', 'reference/hotrod/dataset.json', 'reference/hotrod/strategies/1-customer-replicas.yaml', 'reference/hotrod/strategies/2-graviton.yaml', '--draws', '8'],
  ['backtest', 'reference/hotrod/model.json', 'reference/hotrod/dataset.json', 'reference/hotrod/strategies/3-autoscale-customer.yaml', '--draws', '6', '--md', `${out}/OUT/bt.md`, '--html', `${out}/OUT/bt.html`, '--comment', `${out}/OUT/pr.md`, '--card', `${out}/OUT/card.json`, '--out', `${out}/OUT/bt.json`],
  ['backtest', 'reference/petclinic/model.json', 'reference/petclinic/dataset.json', 'reference/petclinic/strategies/1-app-replicas.yaml', '--draws', '5', '--scale', '2', '--gate'],
  ['backtest', 'demos/ws/model.json', 'demos/ws/dataset.json', '--draws', '4', '--last', '1h', '--json'],
  ['headroom', 'reference/hotrod/model.json'],
  ['headroom', 'reference/petclinic/model.json', 'reference/petclinic/strategies/4-read-replica.yaml', '--json'],
  ['accuracy', 'reference/shop/model.json'],
  ['accuracy', 'demos/ws/model.json', '--json'],
  ['diff-strategy', '--base', 'reference/k8s/shop/variants/frontend-1.yaml', '--head', 'reference/k8s/shop/variants/frontend-hpa.yaml'],
  ['diff-strategy', '--base', 'reference/k8s/shop/variants/frontend-2.yaml', '--head', 'reference/k8s/shop/variants/frontend-1-750m.yaml', '--name', 'smaller', '--out', `${out}/OUT/s.yaml`],
  ['diff-strategy', '--base', 'reference/k8s/shop/shop.yaml', '--head', 'reference/k8s/shop/variants', '--model', 'reference/shop/model.json'],
  ['diff-strategy', '--base', 'reference/k8s/shop/shop.yaml', '--head', 'reference/k8s/shop/shop.yaml', '--out', `${out}/OUT/none.yaml`],
  ['export-prometheus', '--url', PROM, '--start', '2026-09-01T00:00:00Z', '--end', '2026-09-01T01:00:00Z', '--out', `${out}/OUT/exp1`],
  ['export-prometheus', '--url', `${PROM}/prefix/`, '--start', '1791390000', '--end', '1791410000', '--step', '1', '--preset', 'kubernetes,ingress-nginx,spring,http-server', '--selector', 'namespace="shop"', '--window', '5m', '--name', 'Shop', '--out', `${out}/OUT/exp2`],
  ['export-prometheus', '--url', PROM, '--start', 'yesterday', '--end', '2026-09-01'],
  ['export-prometheus', '--url', PROM, '--start', '2026-09-01', '--end', '2026-09-02', '--preset', 'nonsense', '--out', `${out}/OUT/exp3`],
  ['agent'],
  ['agent', 'list'],
  ['agent', 'nonsense'],
  agent('connect_telemetry', { workspace: ws('a'), prometheus: { url: `${TEL}/prom` }, jaeger: { url: `${TEL}/jaeger` } }),
  agent('connect_telemetry', { workspace: ws('b'), prometheus: { url: `${TEL}/gappy`, tokenEnv: 'HINDCAST_TEST_UNSET_TOKEN' }, tempo: { url: `${TEL}/tempo` }, system: { name: 'Gappy', slo: { errorRate: 0.02, p99Ms: 300 }, rename: { 'shop-worker': 'other' } } }),
  agent('connect_telemetry', { workspace: ws('c'), prometheus: { url: `${TEL}/broken` }, traceFiles: ['reference/hotrod/runs/history/raw/*.jsonl'], bill: { cur: 'nowhere.csv', tag: 'user:service' } }),
  agent('connect_telemetry', { workspace: ws('d') }),
  agent('connect_telemetry', { workspace: ws('e'), prometheus: { url: 'not a url' } }),
  agent('connect_telemetry', { workspace: ws('f'), prometheus: { url: `${TEL}/prom`, selector: 'cluster="eu"', namespaces: ['shop'], presets: ['cadvisor'], extra: 1 }, system: { entry: ['api'], ignore: [], exclude: ['db'], hostedBy: { redis: 'api' }, placement: { api: { zone: 'a', foo: 1 } } } }),
  agent('read_cluster', { workspace: ws('g'), context: 'kind-test', namespace: 'shop' }),
  agent('read_cluster', { workspace: ws('h'), context: 'kind-test', selector: 'app=web' }),
  agent('read_cluster', { workspace: ws('i'), context: 'nope' }),
  agent('read_cluster', { workspace: ws('j') }),
  agent('collect_telemetry', { workspace: ws('a'), last: '6h' }),
  agent('collect_telemetry', { workspace: ws('a'), maxTraces: 120 }),
  agent('connect_telemetry', { workspace: ws('k'), prometheus: { url: `${TEL}/prom` }, traceFiles: ['reference/hotrod/runs/history/raw/*.jsonl'], system: { name: 'HotROD-ish', rename: { 'shop-worker': 'worker' }, hostedBy: { redis: 'api' }, exclude: ['worker'] } }),
  agent('collect_telemetry', { workspace: ws('k'), windows: [{ start: '2026-10-08T12:00:00Z', end: '2026-10-08T14:00:00Z' }, { start: 1791480000, end: 1791490000 }], stepS: 60 }),
  agent('connect_telemetry', { workspace: ws('m'), prometheus: { url: `${TEL}/prom` }, tempo: { url: `${TEL}/tempo` } }),
  agent('collect_telemetry', { workspace: ws('m'), start: '2026-10-09T00:00:00Z', end: '2026-10-09T02:00:00Z' }),
  agent('collect_telemetry', { workspace: ws('z') }),
  agent('model_status', { workspace: ws('a') }),
  agent('calibrate_model', { workspace: ws('v') }),
  agent('model_status', { workspace: ws('v') }),
  agent('find_headroom', { workspace: ws('v') }),
  agent('find_headroom', { workspace: ws('v'), strategy: 'name: more customer\nchanges:\n  - service: customer\n    replicas: 3\n' }),
  agent('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'customer ×3', changes: [{ service: 'customer', replicas: 3, extra: 1 }] } }], draws: 4 }),
  agent('verify_change', { workspace: ws('v'), changes: [{ strategy: 'name: graviton\nchanges:\n  - service: route\n    arch: Graviton\n  - endpoint: "*"\n    retries: { attempts: 2 }\n' }, { terraformPlan: { resource_changes: [{ address: 'aws_ecs_service.customer', type: 'aws_ecs_service', name: 'customer', change: { actions: ['update'], before: { name: 'customer', desired_count: 1 }, after: { name: 'customer', desired_count: 2 } } }] } }], draws: 3, traffic: { scale: 2 }, gateMinutes: 1 }),
  agent('verify_change', { workspace: ws('v'), changes: [{ kubernetes: { base: 'examples/backtest-ci/deploy/hotrod.yaml', head: 'examples/backtest-ci/deploy/hotrod.yaml' } }], draws: 3 }),
  agent('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'cut', changes: [{ service: 'mysql', cpu: 0.25 }] } }], draws: 3, last: '20m', report: false }),
  agent('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'nope', changes: [{ service: 'ghost', replicas: 2 }] } }] }),
  agent('verify_change', { workspace: ws('v'), changes: [] }),
  agent('calibrate_model', { workspace: ws('n'), holdout: 0.2, slo: { p99Ms: 400, errorRate: 0.02 } }),
  agent('check_node_loss', { workspace: ws('n') }),
  agent('check_node_loss', { workspace: ws('n'), strategy: { name: 'spread', changes: [{ service: 'frontend', replicas: 3, spread: 'even' }] }, traffic: { scale: 1.5 } }),
  agent('verify_change', { workspace: ws('n'), changes: [{ strategy: { name: 'frontend ×3 spread', changes: [{ service: 'frontend', replicas: 3, spread: 'even' }] } }], draws: 3 }),
  agent('verify_design', { spec: readFileSync('examples/shop.yaml', 'utf8') }),
  agent('verify_design', { spec: readFileSync('examples/shop.yaml', 'utf8'), rps: 2000, budgetMonthly: 500, slo: { maxP99Ms: 200 } }),
  agent('verify_design', { spec: 'components: []' }),
  agent('suggest_changes', { workspace: ws('v'), draws: 3 }),
  agent('suggest_changes', { workspace: ws('v'), draws: 3, goal: 'cost', idleBelow: 0.6, last: '30m' }),
  agent('suggest_changes', { workspace: ws('n'), draws: 3, goal: 'reliability' }),
  agent('review_capacity', { workspace: ws('v'), draws: 3 }),
  agent('review_capacity', { workspace: ws('n'), draws: 3 }),
  ['outage', 'reference/shop/model.json', 'list'],
  ['outage', 'reference/shop/model.json', 'aws-use1-2025-10-20'],
  ['outage', 'reference/shop/model.json', 'slack-2021-01-04', 'reference/shop/strategies/1-autoscale-frontend.yaml', '--md', `${out}/OUT/o.md`],
  ['outage', 'reference/hotrod/model.json', 'github-2018-10-21', '--rps', '50', '--json'],
  ['analyze', `${ex}/shop.yaml`, '--runs', '6', '--duration', '20'],
  ['analyze', `${ex}/shop.yaml`, `${ex}/black-friday.yaml`, '--runs', '4', '--seed', '3', '--json'],
  ['optimize', `${ex}/shop.yaml`],
  ['optimize', `${ex}/shop.yaml`, `${ex}/black-friday.yaml`, '--runtimes', '--out', `${out}/OUT/opt.yaml`],
  ['optimize', `${ex}/shop.yaml`, '--p99', '200', '--json'],
  ['audit', `${ex}/shop.yaml`],
  ['audit', `${ex}/shop.yaml`, '--rps', '1500', '--cost-per-min', '2000', '--md', `${out}/OUT/a.md`, '--html', `${out}/OUT/a.html`],
  ['audit', `${ex}/terraform/shop.yaml`, '--json'],
  ['audit', `${ex}/kubernetes/shop.yaml`],
];

/** wall-clock numbers differ run to run */
const mask = (s: string) => s.replace(/(in |· )\d+ ms/g, '$1# ms').replace(/"wallMs": \d+(\.\d+)?/g, '"wallMs": #').replace(/"measuredAt": ?"[^"]*"/g, '"measuredAt": #').replace(/cli-parity-\w+/g, 'cli-parity-X').replace(/\/OUT[12]\//g, '/OUT/');

function run(cmd: string, args: string[], tag: string) {
  const a = args.map((x) => x.replace('/OUT/', `/OUT${tag}/`));
  for (const x of a) if (x.startsWith(`${out}/OUT${tag}/`)) spawnSync('mkdir', ['-p', x.slice(0, x.lastIndexOf('/'))]);
  const r = spawnSync(cmd, cmd === 'npx' ? ['tsx', 'cli/bottleneck.ts', ...a] : a, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '', HINDCAST_NOW: '1791500000', HINDCAST_KUBECTL: 'test/cli-fixtures/fake-kubectl.mjs' } });
  // everything either CLI wrote: named outputs, workspaces, reports
  const root = `${out}/OUT${tag}`;
  const files = existsSync(root) ? walk(root).map((x) => `${x.replace(/OUT[12]/, 'OUT')}\n${mask(readFileSync(x, 'utf8'))}`) : [];
  return { stdout: mask(r.stdout), stderr: mask(r.stderr), code: r.status, files };
}

const prom = spawn('node', ['test/cli-fixtures/mock-prometheus.mjs', '19090'], { stdio: 'ignore' });
const tel = spawn('node', ['test/cli-fixtures/mock-telemetry.mjs', '19091'], { stdio: 'ignore' });
spawnSync('sleep', ['0.5']);
// workspaces seeded with recorded histories, for the verdict tools
import { writeFileSync as wf, mkdirSync as md, copyFileSync } from 'node:fs';
for (const tag of ['1', '2']) {
  md(`${out}/OUT${tag}/ws-v`, { recursive: true });
  copyFileSync('reference/hotrod/dataset.json', `${out}/OUT${tag}/ws-v/dataset.json`);
  md(`${out}/OUT${tag}/ws-n`, { recursive: true });
  wf(`${out}/OUT${tag}/ws-n/dataset.json`, JSON.stringify(JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')).dataset));
}
const filter = process.argv[2];
let failed = 0;
for (const c of CASES) {
  const name = c.join(' ') || '(no args)';
  if (filter && !name.includes(filter)) continue;
  const ts = run('npx', c, '1');
  const rs = run(BIN, c, '2');
  const same = ts.stdout === rs.stdout && (ts.stderr === rs.stderr || PARSER_MESSAGE.has(name)) && ts.code === rs.code && JSON.stringify(ts.files) === JSON.stringify(rs.files);
  if (same) {
    console.log(`ok    ${name}`);
    continue;
  }
  failed++;
  console.log(`DIFF  ${name}  (exit ${ts.code} vs ${rs.code})`);
  for (const [k, a, b] of [['stdout', ts.stdout, rs.stdout], ['stderr', ts.stderr, rs.stderr], ['files', ts.files.join('\n---\n'), rs.files.join('\n---\n')]] as const) {
    if (a === b) continue;
    const la = a.split('\n');
    const lb = b.split('\n');
    let i = 0;
    while (la[i] === lb[i]) i++;
    const x = la[i] ?? '';
    const y = lb[i] ?? '';
    let j = 0;
    while (j < x.length && x[j] === y[j]) j++;
    const cut = (t: string) => (j > 120 ? '…' : '') + t.slice(Math.max(0, j - 120), j + 120);
    console.log(`  ${k} line ${i + 1}, column ${j + 1}:\n    node: ${JSON.stringify(cut(x))}\n    rust: ${JSON.stringify(cut(y))}`);
  }
}
prom.kill();
tel.kill();
console.log(failed ? `\n${failed} differ` : '\nall match');
process.exitCode = failed ? 1 : 0;
