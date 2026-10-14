// End-to-end check of the agent tools, the way an agent uses them: an MCP client starts the server
// over stdio and drives connect → collect → calibrate → verify with nothing but URLs.
//
//   node scripts/agent-e2e.mjs --prom http://localhost:9090 --jaeger http://localhost:16686 --last 30m \
//        [--p99 1000 --errors 0.03 --timeout 5000] [--out transcript.json]
//
// Against the reference HotROD under load (reference/README.md), it expects: retries without a
// budget fail, Graviton does not. Exits 1 when an expectation fails.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--') ? true : process.argv[i + 1];
};
const prom = arg('prom', 'http://localhost:9090');
const jaeger = arg('jaeger', 'http://localhost:16686');
const workspace = arg('workspace', mkdtempSync(join(tmpdir(), 'hindcast-e2e-')));
const server = { command: 'bin/hindcast', args: ['mcp'] };

const client = new Client({ name: 'hindcast-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({ ...server, env: { ...process.env, HINDCAST_WORKSPACE: workspace }, stderr: 'inherit' }));

const transcript = [];
const call = async (name, args = {}) => {
  const t0 = Date.now();
  // long calls report progress; the timeout restarts with each report
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, resetTimeoutOnProgress: true, onprogress: (p) => console.log(`   … ${p.message ?? ''}`) });
  const text = r.content?.[0]?.text ?? '';
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = text;
  }
  transcript.push({ tool: name, args, ms: Date.now() - t0, isError: !!r.isError, result: out });
  console.log(`\n── ${name} ${r.isError ? '✗' : '✓'} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (r.isError) throw new Error(`${name}: ${text}`);
  return out;
};

const failures = [];
const expect = (ok, what) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(['connect_telemetry', 'collect_telemetry', 'calibrate_model', 'verify_change', 'verify_design', 'read_cluster', 'model_status', 'find_headroom'].every((t) => tools.includes(t)), `the server offers the agent tools (${tools.length} tools)`);

  const status0 = await call('model_status');
  console.log(`   next: ${status0.next}`);

  const slo = arg('p99') ? { p99Ms: Number(arg('p99')), errorRate: Number(arg('errors', 0.01)) } : undefined;
  const con = await call('connect_telemetry', { prometheus: { url: prom }, jaeger: { url: jaeger }, system: { name: arg('name', 'live system'), ...(slo ? { slo } : {}), ...(arg('timeout') ? { timeoutMs: Number(arg('timeout')) } : {}) } });
  console.log(`   presets ${con.prometheus.presets.join(', ')} · entry ${con.system.entry?.join(', ')} · traffic since ${con.prometheus.data?.oldestFound}`);
  for (const p of con.problems) console.log(`   problem: ${p}`);
  expect(con.ready, 'connected');

  const col = await call('collect_telemetry', { last: arg('last', '30m') });
  console.log(`   ${col.window.hours} h in ${col.window.buckets} buckets of ${col.window.stepS} s · ${col.traces} · endpoints ${col.endpoints.join(', ')}`);
  for (const c of col.coverage) console.log(`   ${c.service.padEnd(14)} ${c.has.join(',')}${c.missing.length ? `  (missing ${c.missing.join(',')})` : ''}`);
  for (const w of col.warnings) console.log(`   warning: ${w}`);
  expect(col.endpoints.length > 0, 'endpoints found');

  const cal = await call('calibrate_model');
  for (const s of cal.services) console.log(`   ${s.service.padEnd(14)} ${s.fit.padEnd(11)} ${s.capacityPerReplica === null ? 'no limit' : `${s.capacityPerReplica} req/s/replica`} · ${s.limit} · ${s.basis} · ${s.cost}`);
  for (const a of cal.accuracy) for (const c of a.checks) console.log(`   accuracy ${c.metric} (${a.label}): ${c.pass ? 'pass' : 'MISS'} ${c.error}`);

  const v = await call('verify_change', {
    changes: [
      { strategy: { name: 'Two customer replicas', changes: [{ service: 'customer', replicas: 2 }] } },
      { strategy: { name: 'Everything on Graviton', changes: ['frontend', 'customer', 'route', 'driver'].filter((s) => cal.services.some((x) => x.service === s)).map((service) => ({ service, arch: 'arm' })) } },
      { strategy: { name: 'Clients retry twice, no budget', changes: [{ endpoint: '*', retries: { attempts: 2, budget: 10 } }] } },
    ],
    draws: 20,
  });
  for (const r of v.results) {
    console.log(`   ${r.name}: ${r.verdict.toUpperCase()} (confidence ${r.confidence.level}) — ${r.summary}`);
    for (const x of r.reasons.slice(1)) console.log(`      · ${x}`);
    for (const w of r.confidence.warnings) console.log(`      ? ${w}`);
  }
  console.log(`   report: ${v.reports?.html}`);
  const by = Object.fromEntries(v.results.map((r) => [r.name, r]));
  expect(by['Clients retry twice, no budget'].verdict === 'fail', 'retries without a budget fail');
  expect(by['Everything on Graviton'].verdict !== 'fail', 'Graviton does not fail');
  expect(by['Everything on Graviton'].cost.monthlyDelta.p50 < 0, 'Graviton saves money');

  const sg = await call('suggest_changes');
  console.log(`   saturated: ${sg.saturated.map((x) => `${x.service} ${Math.round(x.historyPeakUtil * 100)}%`).join(', ') || 'none'}`);
  for (const f of sg.fixes) console.log(`   fix  ${f.name}: ${f.verdict} (${f.confidence}) — ${f.summary}; failed ${f.failedRequestsDelta}`);
  for (const f of sg.savings) console.log(`   save ${f.name}: ${f.monthlyDelta}/month`);
  if (sg.combinedSavings) console.log(`   together: ${sg.combinedSavings.verdict}, ${sg.combinedSavings.summary}`);
  expect(sg.savings.length > 0 && sg.savings.every((x) => x.verdict === 'pass'), 'suggest_changes finds savings that pass');
  expect(['mysql', 'customer'].some((id) => sg.saturated.some((x) => x.service === id)), 'suggest_changes sees the saturated lock');

  const h = await call('find_headroom', { strategy: { name: 'Two customer replicas', changes: [{ service: 'customer', replicas: 2 }] } });
  console.log(`   as built ${h.asBuilt.rps} req/s (${h.asBuilt.limitedBy}); with two customer replicas ${h.withStrategy.rps} req/s; history peak ${h.historyPeakRps?.toFixed?.(1)}`);

  const status = await call('model_status');
  expect(status.next === 'verify_change', 'the workspace is ready for more questions');
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify({ workspace, transcript }, null, 1));
  await client.close();
}
console.log(`\n${failures.length ? `✗ ${failures.length} failed` : '✓ all checks passed'} · workspace ${workspace}`);
process.exit(failures.length ? 1 : 0);
