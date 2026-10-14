// The native MCP server (`hindcast mcp`) against the Node one (mcp/server.ts): one scripted session
// through each; every response and notification, and every file the tools wrote, must match
// (wall-clock timings, temp dirs and the bundle server's port masked).
// npx tsx scripts/mcp-parity.ts [filter]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { handshake, session } from './mcp-session';

const BIN = 'engine-rs/target/release/hindcast';
const out = mkdtempSync(join(tmpdir(), 'mcp-parity-'));
const TEL = 'http://127.0.0.1:19091';
const ws = (k: string) => `${out}/OUT/ws-${k}`;
const shop = parseYaml(readFileSync('examples/shop.yaml', 'utf8'));
const bf = parseYaml(readFileSync('examples/black-friday.yaml', 'utf8'));
const variants = parseYaml(readFileSync('examples/shop-variants.yaml', 'utf8'));
const variantList = Array.isArray(variants) ? variants : variants.variants;
const tf = JSON.parse(readFileSync('examples/terraform/shop.tfstate.json', 'utf8'));
const k8s = readFileSync('examples/kubernetes/shop.yaml', 'utf8');

/** [label, method, params] — a tools/call when method is a tool name */
type Case = [string, string, Record<string, unknown>?];
const call = (name: string, args?: Record<string, unknown>, progress = false): Case => [`${name} ${JSON.stringify(args ?? null).slice(0, 80)}`, 'tools/call', { name, ...(args === undefined ? {} : { arguments: args }), ...(progress ? { _meta: { progressToken: `p-${name}` } } : {}) }];
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
];

const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
const mask = (s: string) =>
  s
    .replace(/(in |· )\d+ ms/g, '$1# ms')
    .replace(/(\\*"wallMs\\*": ?)\d+(\.\d+)?/g, '$1#')
    .replace(/(\\*"measuredAt\\*": ?)\\*"[^"\\]*\\*"/g, '$1#')
    .replace(/mcp-parity-\w+/g, 'mcp-parity-X')
    .replace(/\/OUT[12]\//g, '/OUT/')
    .replace(/127\.0\.0\.1(%3A|:)1910[12]/g, '127.0.0.1$1PORT');

async function run(tag: '1' | '2') {
  const root = `${out}/OUT${tag}`;
  mkdirSync(`${root}/ws-v`, { recursive: true });
  copyFileSync('reference/hotrod/dataset.json', `${root}/ws-v/dataset.json`);
  mkdirSync(`${root}/ws-n`, { recursive: true });
  writeFileSync(`${root}/ws-n/dataset.json`, JSON.stringify(JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')).dataset));
  // "collected N hours ago" reads the file's mtime
  for (const k of ['v', 'n']) utimesSync(`${root}/ws-${k}/dataset.json`, 1791400000, 1791400000);
  const msgs = [...handshake, ...CASES.map(([, method, params], i) => ({ jsonrpc: '2.0', id: 100 + i, method, ...(params ? { params: JSON.parse(JSON.stringify(params).replaceAll('/OUT/', `/OUT${tag}/`)) } : {}) }))];
  const env = { NO_COLOR: '', HINDCAST_NOW: '1791500000', HINDCAST_KUBECTL: 'test/cli-fixtures/fake-kubectl.mjs', HINDCAST_SERVE_PORT: `1910${tag}` };
  const lines = tag === '1' ? await session('npx', ['tsx', 'mcp/server.ts'], msgs, env) : await session(BIN, ['mcp'], msgs, env);
  const files = existsSync(root) ? walk(root).map((x) => `${x.replace(/OUT[12]/, 'OUT')}\n${mask(readFileSync(x, 'utf8'))}`) : [];
  // each case: its notifications and its response, in order
  const byCase = new Map<number, string[]>();
  let pending: string[] = [];
  for (const l of lines) {
    const s = mask(JSON.stringify(l));
    if ('id' in l) {
      byCase.set(l.id as number, [...pending, s]);
      pending = [];
    } else pending.push(s);
  }
  return { byCase, files };
}

const tel = spawn('node', ['test/cli-fixtures/mock-telemetry.mjs', '19091'], { stdio: 'ignore' });
spawnSync('sleep', ['0.5']);
const filter = process.argv[2];
const ts = await run('1');
const rs = await run('2');
tel.kill();
let failed = 0;
const diff = (k: string, a: string, b: string) => {
  let j = 0;
  while (j < a.length && a[j] === b[j]) j++;
  const cut = (t: string) => (j > 150 ? '…' : '') + t.slice(Math.max(0, j - 150), j + 150);
  console.log(`  ${k} column ${j + 1}:\n    node: ${JSON.stringify(cut(a))}\n    rust: ${JSON.stringify(cut(b))}`);
};
for (const [id, label] of [[1, 'initialize'] as const, ...CASES.map(([l], i) => [100 + i, l] as const)]) {
  if (filter && !label.includes(filter)) continue;
  const a = (ts.byCase.get(id) ?? ['(no answer)']).join('\n');
  const b = (rs.byCase.get(id) ?? ['(no answer)']).join('\n');
  if (a === b) {
    console.log(`ok    ${label}`);
    continue;
  }
  failed++;
  console.log(`DIFF  ${label}`);
  diff('message', a, b);
}
if (!filter) {
  const a = ts.files.join('\n---\n');
  const b = rs.files.join('\n---\n');
  if (a === b) console.log(`ok    files written (${ts.files.length})`);
  else {
    failed++;
    console.log('DIFF  files written');
    diff('files', a, b);
  }
}
console.log(failed ? `\n${failed} differ` : '\nall match');
process.exitCode = failed ? 1 : 0;
