// The native CLI (engine-rs, `hindcast`) against its golden outputs (test/golden/cli.json), which were
// first recorded from the Node CLI it replaced (6b0e08c): stdout, stderr, the exit code and every file
// each command wrote must match (wall-clock timings and temp dirs masked). After an intended change in
// output, --record writes the binary's answers as the new reference.
// npx tsx scripts/cli-golden.ts [filter] [--record]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changed, firstDiff, read, snapshot, store, write, type Stored } from './golden';

const BIN = 'engine-rs/target/release/hindcast';
const out = mkdtempSync(join(tmpdir(), 'cli-golden-'));
const GOLDEN = 'test/golden/cli.json';
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
  ['import', `${fx}/hotrod.import.yaml`, '--out', `${out}/OUT/hotrod.dataset.json`],
  ['import', `${fx}/k8s-shop.import.yaml`, '--out', `${out}/OUT/k8s.dataset.json`, '--json'],
  ['calibrate', 'reference/hotrod/dataset.json', '--out', `${out}/OUT/hotrod.model.json`],
  ['calibrate', 'reference/hotrod/dataset.json', '--out', `${out}/OUT/hotrod2.model.json`, '--holdout', '0.3', '--p99', '400'],
  ['calibrate', 'reference/k8s/shop/runs/normal-1/workspace/dataset.json', '--out', `${out}/OUT/k8s.model.json`, '--json'],
  ['backtest', 'reference/hotrod/model.json', 'reference/hotrod/dataset.json', 'reference/hotrod/strategies/1-customer-replicas.yaml', 'reference/hotrod/strategies/2-graviton.yaml', '--draws', '8'],
  ['backtest', 'reference/hotrod/model.json', 'reference/hotrod/dataset.json', 'reference/hotrod/strategies/3-autoscale-customer.yaml', '--draws', '6', '--md', `${out}/OUT/bt.md`, '--html', `${out}/OUT/bt.html`, '--comment', `${out}/OUT/pr.md`, '--card', `${out}/OUT/card.json`, '--out', `${out}/OUT/bt.json`],
  ['backtest', 'reference/petclinic/model.json', 'reference/petclinic/dataset.json', 'reference/petclinic/strategies/1-app-replicas.yaml', '--draws', '5', '--scale', '2', '--gate'],
  ['backtest', `${out}/OUT/k8s.model.json`, 'reference/k8s/shop/runs/normal-1/workspace/dataset.json', '--draws', '4', '--last', '20m', '--json'],
  ['headroom', 'reference/hotrod/model.json'],
  ['headroom', 'reference/petclinic/model.json', 'reference/petclinic/strategies/4-read-replica.yaml', '--json'],
  ['accuracy', 'reference/shop/model.json'],
  ['accuracy', `${out}/OUT/k8s.model.json`, '--json'],
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
  agent('connect_telemetry', { workspace: ws('c'), prometheus: { url: `${TEL}/broken` }, traceFiles: [`${fx}/traces/hotrod.jsonl`], bill: { cur: 'nowhere.csv', tag: 'user:service' } }),
  agent('connect_telemetry', { workspace: ws('d') }),
  agent('connect_telemetry', { workspace: ws('e'), prometheus: { url: 'not a url' } }),
  agent('connect_telemetry', { workspace: ws('f'), prometheus: { url: `${TEL}/prom`, selector: 'cluster="eu"', namespaces: ['shop'], presets: ['cadvisor'], extra: 1 }, system: { entry: ['api'], ignore: [], exclude: ['db'], hostedBy: { redis: 'api' }, placement: { api: { zone: 'a', foo: 1 } } } }),
  agent('read_cluster', { workspace: ws('g'), context: 'kind-test', namespace: 'shop' }),
  agent('read_cluster', { workspace: ws('h'), context: 'kind-test', selector: 'app=web' }),
  agent('read_cluster', { workspace: ws('i'), context: 'nope' }),
  agent('read_cluster', { workspace: ws('j') }),
  agent('collect_telemetry', { workspace: ws('a'), last: '6h' }),
  agent('collect_telemetry', { workspace: ws('a'), maxTraces: 120 }),
  agent('connect_telemetry', { workspace: ws('k'), prometheus: { url: `${TEL}/prom` }, traceFiles: [`${fx}/traces/hotrod.jsonl`], system: { name: 'HotROD-ish', rename: { 'shop-worker': 'worker' }, hostedBy: { redis: 'api' }, exclude: ['worker'] } }),
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
  ['quickstart'],
  ['quickstart', '--help'],
  ['quickstart', '--prometheus', `${TEL}/broken`, '--workspace', ws('qb')],
  ['quickstart', '--prometheus', `${TEL}/prom`, '--jaeger', `${TEL}/jaeger`, '--last', '6h', '--workspace', ws('q')],
  // no traces: kube-prometheus-stack and ingress-nginx alone, the same with a topology file, and Istio
  ['quickstart', '--prometheus', `${TEL}/kps`, '--last', '6h', '--workspace', ws('qk')],
  ['quickstart', '--prometheus', `${TEL}/kps`, '--topology', `${fx}/topology.yaml`, '--last', '6h', '--workspace', ws('qt')],
  ['quickstart', '--prometheus', `${TEL}/istio`, '--last', '6h', '--workspace', ws('qi')],
  agent('connect_telemetry', { workspace: ws('qn'), prometheus: { url: `${TEL}/kps` }, topologyFile: 'nowhere.yaml' }),
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
  ['audit', `${ex}/sharded.yaml`, '--rps', '9000'],
  ['audit', `${ex}/two-regions-dns.yaml`, '--rps', '600'],
];

/** wall-clock numbers differ run to run */
const mask = (s: string) => s.replace(/(in |· )\d+ ms/g, '$1# ms').replace(/(done in|failed after|Done in) \d+(\.\d+)? s/g, '$1 # s').replace(/"wallMs": \d+(\.\d+)?/g, '"wallMs": #').replace(/Generated by Hindcast on [^.<]+/g, 'Generated by Hindcast on #').replace(/"measuredAt": ?"[^"]*"/g, '"measuredAt": #').replace(/"collectedHoursAgo": -?[\d.]+/g, '"collectedHoursAgo": #').replaceAll(realpathSync(out), '$OUT').replaceAll(out, '$OUT').replaceAll(process.cwd(), '$CWD').replace(/\/[^"\s]*\/system-design-sandbox(?=\/)/g, '$CWD').replace(/(\.\.\/)*\.\.(?=\$CWD)/g, '…');

interface Golden {
  stdout: string;
  stderr: Stored;
  code: number | null;
  files: Record<string, Stored>;
}

const root = `${out}/OUT`;
const DUMP = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : '';
let dumped = 0;
let files = snapshot(root, mask);
function run(args: string[], record: boolean): Golden {
  for (const x of args) if (x.startsWith(`${root}/`)) mkdirSync(x.slice(0, x.lastIndexOf('/')), { recursive: true });
  const env = { ...process.env, NO_COLOR: '', HINDCAST_NOW: '1791500000', HINDCAST_KUBECTL: 'test/cli-fixtures/fake-kubectl.mjs' };
  const r = spawnSync(BIN, args, { encoding: 'utf8', env });
  // everything the command wrote: named outputs, workspaces, reports
  const now = snapshot(root, mask);
  const g = { stdout: mask(r.stdout), stderr: store(mask(r.stderr)), code: r.status, files: changed(files, now) };
  // --dump <dir>: every case's output in full, to diff two runs
  if (DUMP) {
    const d = `${DUMP}/${String(++dumped).padStart(3, '0')}`;
    mkdirSync(d, { recursive: true });
    writeFileSync(`${d}/stdout`, g.stdout);
    for (const [k, v] of now) if (files.get(k) !== v) mkdirSync(join(d, 'files', k, '..'), { recursive: true }), writeFileSync(join(d, 'files', k), v);
  }
  files = now;
  return g;
}

const prom = spawn('node', ['test/cli-fixtures/mock-prometheus.mjs', '19090'], { stdio: 'ignore' });
const tel = spawn('node', ['test/cli-fixtures/mock-telemetry.mjs', '19091'], { stdio: 'ignore' });
spawnSync('sleep', ['0.5']);
// workspaces seeded with recorded histories, for the verdict tools ("collected N hours ago" reads the mtime)
mkdirSync(`${root}/ws-v`, { recursive: true });
copyFileSync('reference/hotrod/dataset.json', `${root}/ws-v/dataset.json`);
mkdirSync(`${root}/ws-n`, { recursive: true });
writeFileSync(`${root}/ws-n/dataset.json`, JSON.stringify(JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')).dataset));
for (const k of ['v', 'n']) utimesSync(`${root}/ws-${k}/dataset.json`, 1791400000, 1791400000);
files = snapshot(root, mask);

const record = process.argv.includes('--record');
const filter = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dump');
const golden: Record<string, Golden> = record ? {} : read(GOLDEN);
let failed = 0;
for (const c of CASES) {
  const name = mask(c.join(' ')) || '(no args)';
  // cases share workspaces: a filter still runs the ones before it, unreported
  const g = run(c, record);
  if (record) {
    golden[name] = g;
    console.log(`rec   ${name}`);
    continue;
  }
  if (filter && !name.includes(filter)) continue;
  const want = golden[name];
  if (!want) {
    failed++;
    console.log(`NEW   ${name}  (no golden output: npx tsx scripts/cli-golden.ts --record)`);
    continue;
  }
  const diffs = [firstDiff('stdout', want.stdout, g.stdout), PARSER_MESSAGE.has(name) ? null : firstDiff('stderr', want.stderr, g.stderr), firstDiff('exit code', String(want.code), String(g.code)), firstDiff('files', want.files, g.files)].filter(Boolean);
  if (!diffs.length) {
    console.log(`ok    ${name}`);
    continue;
  }
  failed++;
  console.log(`DIFF  ${name}\n${diffs.join('\n')}`);
}
prom.kill();
tel.kill();
if (record) write(GOLDEN, golden);
console.log(record ? `\nrecorded ${Object.keys(golden).length} cases in ${GOLDEN}` : failed ? `\n${failed} differ` : '\nall match');
process.exitCode = failed ? 1 : 0;
