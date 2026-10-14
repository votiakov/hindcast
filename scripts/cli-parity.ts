// The native CLI (engine-rs, `hindcast`) against the Node one (cli/bottleneck.ts): every case runs
// through both; stdout, stderr and the exit code must match (wall-clock timings masked).
// npx tsx scripts/cli-parity.ts [filter]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = 'engine-rs/target/release/hindcast';
const out = mkdtempSync(join(tmpdir(), 'cli-parity-'));
const ex = 'examples';
const fx = 'test/cli-fixtures';
/** cases whose stderr is a YAML parser's syntax message: only the exit code has to agree */
const PARSER_MESSAGE = new Set([`validate ${ex}/kubernetes/shop.yaml`]);
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
];

/** wall-clock numbers differ run to run */
const mask = (s: string) => s.replace(/(in |· )\d+ ms/g, '$1# ms').replace(/"wallMs": \d+(\.\d+)?/g, '"wallMs": #').replace(/cli-parity-\w+/g, 'cli-parity-X').replace(/\/OUT[12]\//g, '/OUT/');

function run(cmd: string, args: string[], tag: string) {
  const a = args.map((x) => x.replace('/OUT/', `/OUT${tag}/`));
  for (const x of a) if (x.includes(`/OUT${tag}/`)) spawnSync('mkdir', ['-p', x.slice(0, x.lastIndexOf('/'))]);
  const r = spawnSync(cmd, cmd === 'npx' ? ['tsx', 'cli/bottleneck.ts', ...a] : a, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '' } });
  const files = a.filter((x) => x.includes(`/OUT${tag}/`) && existsSync(x)).map((x) => readFileSync(x, 'utf8'));
  return { stdout: mask(r.stdout), stderr: mask(r.stderr), code: r.status, files };
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
    console.log(`  ${k} line ${i + 1}:\n    node: ${JSON.stringify(la.slice(i, i + 3))}\n    rust: ${JSON.stringify(lb.slice(i, i + 3))}`);
  }
}
console.log(failed ? `\n${failed} differ` : '\nall match');
process.exitCode = failed ? 1 : 0;
