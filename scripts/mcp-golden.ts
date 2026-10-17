// The native MCP server (`hindcast mcp`) against its golden session (test/golden/mcp.json), recorded
// first from the Node server it replaced (6b0e08c): every response and notification of one scripted
// session, and every file the tools wrote, must match (timings, temp dirs and the ports masked).
// After an intended change, --record writes the binary's session as the new reference.
// npx tsx scripts/mcp-golden.ts [filter] [--record]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { handshake, session } from './mcp-session';
import { changed, firstDiff, freePort, mock, ports, read, snapshot, write, type Stored } from './golden';

const BIN = 'engine-rs/target/release/hindcast';
const out = mkdtempSync(join(tmpdir(), 'mcp-golden-'));
const GOLDEN = 'test/golden/mcp.json';
// the mocks' ports as the goldens name them: each runs on a free port, swapped in and out (golden.ts ports)
const TEL = 'http://127.0.0.1:19091';
const DD = 'http://127.0.0.1:19691';
const root = `${out}/OUT`;
const ws = (k: string) => `${root}/ws-${k}`;
const shop = parseYaml(readFileSync('examples/shop.yaml', 'utf8'));
const bf = parseYaml(readFileSync('examples/black-friday.yaml', 'utf8'));
const variants = parseYaml(readFileSync('examples/shop-variants.yaml', 'utf8'));
const variantList = Array.isArray(variants) ? variants : variants.variants;
const tf = JSON.parse(readFileSync('examples/terraform/shop.tfstate.json', 'utf8'));
const k8s = readFileSync('examples/kubernetes/shop.yaml', 'utf8');

/** [label, method, params] — a tools/call when method is a tool name */
type Case = [string, string, Record<string, unknown>?];
// the label is cut after the temp dir is masked, so it reads the same on every machine
const call = (name: string, args?: Record<string, unknown>, progress = false): Case => [`${name} ${JSON.stringify(args ?? null).replaceAll(out, '$OUT').slice(0, 80)}`, 'tools/call', { name, ...(args === undefined ? {} : { arguments: args }), ...(progress ? { _meta: { progressToken: `p-${name}` } } : {}) }];
const CASES: Case[] = [
  ['ping', 'ping'],
  ['tools/list', 'tools/list'],
  ['prompts/list', 'prompts/list'],
  ['resources/list', 'resources/list'],
  ['resources/templates/list', 'resources/templates/list'],
  ['resources/read canvas', 'resources/read', { uri: 'ui://hindcast/canvas.html' }],
  ['resources/read nope', 'resources/read', { uri: 'ui://nope' }],
  ['prompts/get verify', 'prompts/get', { name: 'verify-infra-change', arguments: { change: 'customer ×3' } }],
  ['prompts/get verify bad', 'prompts/get', { name: 'verify-infra-change', arguments: {} }],
  ['prompts/get design', 'prompts/get', { name: 'check-my-design', arguments: { design: 'a shop', rps: '800', budget: '400' } }],
  ['prompts/get design bare', 'prompts/get', { name: 'check-my-design', arguments: { design: 'a shop' } }],
  ['nonsense method', 'nonsense/method'],
  call('nope', {}),
  call('list_components', {}),
  call('validate_architecture', { architecture: shop }),
  call('validate_architecture', { architecture: { components: [{ id: 'a', kind: 'server' }, { id: 'b', kind: 'cache' }], connections: [['a', 'b']] } }),
  call('validate_architecture', { architecture: { components: [{ id: 'a', kind: 'blimp' }] } }),
  call('validate_architecture', {}),
  call('validate_architecture'),
  call('simulate', { architecture: shop }),
  call('simulate', { architecture: shop, scenario: bf, include_timeline: true }),
  call('simulate', { architecture: shop, scenario: { duration: 20 }, engine: 'des', seed: 7 }),
  call('simulate', { architecture: shop, engine: 'warp' }),
  call('simulate', { architecture: shop, scenario: { duration: 'long', events: [{ at: 'x' }] } }),
  call('compare_architectures', { architecture: shop, variants: [{ name: 'zap', changes: [{ op: 'zap' }] }] }),
  call('compare_architectures', { architecture: shop, variants: [{ name: 'x', changes: [{ op: 'set' }, 3, { id: 'a' }] }] }),
  call('compare_architectures', { architecture: shop, variants: [{ changes: [{ op: 'add', component: { id: 'q' } }] }], scenario: { events: [{ at: 1, action: { type: 'zap' } }, { at: 2, action: 5 }, { at: 3, action: { type: 'kill' } }] } }),
  call('compare_architectures', { architecture: shop, variants: variantList }),
  call('compare_architectures', { architecture: shop, variants: [] }),
  call('find_breaking_point', { architecture: shop }),
  call('find_breaking_point', { architecture: shop, readRatio: 0.8, slo: { maxP99Ms: 300 } }),
  call('analyze', { architecture: shop, scenario: { duration: 20 }, runs: 4 }),
  call('optimize_cost', { architecture: shop }),
  call('optimize_cost', { architecture: shop, scenario: bf, allow_runtimes: true, slo: { maxP99Ms: 200 } }),
  call('audit_resilience', { architecture: shop }),
  call('audit_resilience', { architecture: shop, rps: 1500, incident_cost_per_minute: 2000, read_ratio: 0.7 }),
  call('import_terraform', { terraform_json: tf, name: 'My shop' }),
  call('import_kubernetes', { manifests_yaml: k8s }),
  call('open_in_app', { architecture: shop }),
  call('open_in_app', { architecture: shop, compare_with: variantList[0], scenario: bf }),
  call('show_architecture', { architecture: shop }),
  call('show_architecture', { architecture: shop, compare_with: variantList[0] }),
  call('backtest_strategy', { model: 'reference/hotrod/model.json', dataset: 'reference/hotrod/dataset.json', strategies: [readFileSync('reference/hotrod/strategies/1-customer-replicas.yaml', 'utf8'), { name: 'graviton', changes: [{ service: 'route', arch: 'Graviton' }] }], draws: 5 }),
  call('backtest_strategy', { model: 'reference/hotrod/model.json', dataset: 'reference/hotrod/dataset.json', strategies: [], last: '1h', draws: 3 }),
  call('backtest_strategy', { model: 'missing.json', strategies: [] }),
  call('replay_outage', { model: 'reference/shop/model.json', outage: 'aws-use1-2025-10-20' }),
  call('replay_outage', { model: 'reference/hotrod/model.json', outage: 'github-2018-10-21', rps: 50, strategies: [{ name: 'more', changes: [{ service: 'customer', replicas: 3 }] }] }),
  call('replay_outage', { model: 'reference/shop/model.json', outage: 'nope' }),
  call('connect_telemetry', { workspace: ws('a'), prometheus: { url: `${TEL}/prom` }, jaeger: { url: `${TEL}/jaeger` } }),
  call('connect_telemetry', { workspace: ws('e'), prometheus: { url: 'not a url' } }),
  call('connect_telemetry', { workspace: 7 }),
  call('verify_change', { workspace: ws('v'), changes: [{ strategy: 1 }, { nonsense: true }] }),
  call('read_cluster', { workspace: ws('g'), context: 'kind-test', namespace: 'shop' }),
  call('collect_telemetry', { workspace: ws('a'), last: '6h' }, true),
  call('model_status', { workspace: ws('a') }),
  call('calibrate_model', { workspace: ws('v') }, true),
  call('model_status', { workspace: ws('v') }),
  call('find_headroom', { workspace: ws('v') }),
  call('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'customer ×3', changes: [{ service: 'customer', replicas: 3 }] } }], draws: 4 }, true),
  call('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'cut', changes: [{ service: 'mysql', cpu: 0.25 }] } }], draws: 3, last: '20m', report: false }),
  call('verify_change', { workspace: ws('v'), changes: [{ strategy: { name: 'nope', changes: [{ service: 'ghost', replicas: 2 }] } }] }),
  call('calibrate_model', { workspace: ws('n'), holdout: 0.2 }),
  call('check_node_loss', { workspace: ws('n') }, true),
  call('verify_design', { spec: readFileSync('examples/shop.yaml', 'utf8'), rps: 2000, budgetMonthly: 500 }),
  call('suggest_changes', { workspace: ws('v'), draws: 3 }, true),
  call('review_capacity', { workspace: ws('n'), draws: 3 }, true),
  // no traces: who calls whom from Istio's metrics
  call('connect_telemetry', { workspace: ws('i'), prometheus: { url: `${TEL}/istio` } }),
  call('collect_telemetry', { workspace: ws('i'), last: '6h' }, true),
  call('calibrate_model', { workspace: ws('i') }),
  call('review_capacity', { workspace: ws('i'), draws: 3 }),
  // the request tracer (appended, so the cases before keep their ids)
  call('trace_request', { architecture: parseYaml(readFileSync('test/cli-fixtures/slow-db.yaml', 'utf8')), scenario: { rps: 14, duration: 20 }, component: 'db', failed_only: true, count: 2 }),
  call('trace_request', { architecture: shop, scenario: { duration: 10 }, component: 'api', seed: 3 }),
  call('trace_request', { architecture: shop, component: 'nope' }),
  call('trace_request', { architecture: shop, count: 50 }),
  // Datadog instead of Prometheus (a mock built from the documented API; its first query is answered 429 once)
  call('connect_telemetry', { workspace: ws('d'), datadog: { url: `${DD}/shop` } }, true),
  call('collect_telemetry', { workspace: ws('d'), last: '6h' }, true),
  call('calibrate_model', { workspace: ws('d') }),
  call('review_capacity', { workspace: ws('d'), draws: 3 }),
  call('connect_telemetry', { workspace: ws('dk'), datadog: { site: 'datadoghq.eu', apiKeyEnv: 'HINDCAST_NO_SUCH_KEY' } }),
];

// the mocks on free ports (the cases and the goldens name the canonical ones above), and one for the
// app server the binary starts, masked as PORT
const mocks = await Promise.all([mock('test/cli-fixtures/mock-telemetry.mjs', 19091), mock('test/cli-fixtures/mock-datadog.mjs', 19691)]);
const wire = ports(mocks);
const SERVE_PORT = await freePort();
const mask = (s: string) =>
  wire
    .from(s)
    .replace(/(in |· )\d+ ms/g, '$1# ms')
    .replace(/(\\*"wallMs\\*": ?)\d+(\.\d+)?/g, '$1#')
    .replace(/(\\*"measuredAt\\*": ?)\\*"[^"\\]*\\*"/g, '$1#')
    .replace(new RegExp(`127\\.0\\.0\\.1(%3A|:)${SERVE_PORT}(?!\\d)`, 'g'), '127.0.0.1$1PORT')
    .replaceAll(realpathSync(out), '$OUT')
    .replaceAll(out, '$OUT')
    .replaceAll(process.cwd(), '$CWD')
    // committed reference datasets name the absolute path they were recorded in
    .replace(/\/[^"\s\\]*\/system-design-sandbox(?=\/)/g, '$CWD')
    // a path relative from the temp dir back to the checkout: its depth is the machine's
    .replace(/(\.\.\/)*\.\.(?=\$CWD)/g, '…');

interface Golden {
  /** each case: its notifications and its response, masked */
  cases: Record<string, string[]>;
  files: Record<string, Stored>;
}

async function run(record: boolean): Promise<Golden> {
  mkdirSync(`${root}/ws-v`, { recursive: true });
  copyFileSync('reference/hotrod/dataset.json', `${root}/ws-v/dataset.json`);
  mkdirSync(`${root}/ws-n`, { recursive: true });
  writeFileSync(`${root}/ws-n/dataset.json`, JSON.stringify(JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')).dataset));
  // "collected N hours ago" reads the mtime of a dataset collect_telemetry did not write
  for (const k of ['v', 'n']) utimesSync(`${root}/ws-${k}/dataset.json`, 1791400000, 1791400000);
  const seeded = snapshot(root, mask);
  const msgs = [...handshake, ...CASES.map(([, method, params], i) => ({ jsonrpc: '2.0', id: 100 + i, method, ...(params ? { params: JSON.parse(wire.to(JSON.stringify(params))) } : {}) }))];
  const env = { NO_COLOR: '', HINDCAST_NOW: '1791500000', HINDCAST_KUBECTL: 'test/cli-fixtures/fake-kubectl.mjs', HINDCAST_SERVE_PORT: String(SERVE_PORT), DD_API_KEY: 'mock-api-key', DD_APP_KEY: 'mock-app-key' };
  const lines = await session(BIN, ['mcp'], msgs, env);
  // a call's name: its label, and a hash of everything it sent (labels are cut short)
  const key = ([l, method, params]: Case) => `${mask(l)} [${createHash('sha256').update(mask(JSON.stringify([method, params ?? null]))).digest('hex').slice(0, 8)}]`;
  const labels = new Map<number, string>([[1, 'initialize'], ...CASES.map((c, i) => [100 + i, key(c)] as [number, string])]);
  const cases: Record<string, string[]> = {};
  let pending: string[] = [];
  for (const l of lines) {
    // the canvas is the app's build (dist-mcp/), not the server's: its URI, type and metadata are checked
    for (const c of ((l as { result?: { contents?: { text?: string }[] } }).result?.contents ?? [])) if (c.text) c.text = '#canvas html';
    const s = mask(JSON.stringify(l));
    if ('id' in l) {
      cases[labels.get(l.id as number) ?? String(l.id)] = [...pending, s];
      pending = [];
    } else pending.push(s);
  }
  return { cases, files: changed(seeded, snapshot(root, mask)) };
}

const record = process.argv.includes('--record');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const got = await run(record);
for (const m of mocks) m.proc.kill();
if (record) {
  write(GOLDEN, got);
  console.log(`recorded ${Object.keys(got.cases).length} calls in ${GOLDEN}`);
} else {
  const want = read<Golden>(GOLDEN);
  let failed = 0;
  for (const [label, w] of Object.entries(want.cases)) {
    if (filter && !label.includes(filter)) continue;
    const d = firstDiff('message', w.join('\n'), (got.cases[label] ?? ['(no answer)']).join('\n'));
    if (!d) console.log(`ok    ${label}`);
    else failed++, console.log(`DIFF  ${label}\n${d}`);
  }
  for (const label of Object.keys(got.cases)) if (!(label in want.cases)) failed++, console.log(`NEW   ${label}  (no golden output: --record)`);
  if (!filter) {
    const d = firstDiff('files', want.files, got.files);
    if (!d) console.log(`ok    files written (${Object.keys(want.files).length})`);
    else failed++, console.log(`DIFF  files written\n${d}`);
  }
  console.log(failed ? `\n${failed} differ` : '\nall match');
  process.exitCode = failed ? 1 : 0;
}
