// A retrodiction, not a validation: the node-kill run (`normal-nodeloss`) replayed again with
// check_node_loss's sensitivity for callers that stay broken — every gRPC caller of a service the node
// took failing its calls to it for 252 s more after the replacement is up. The 252 s were read off this
// same run (cart ready 348 s after the node stopped, the frontend's calls to it failing until 600 s), so
// agreeing with the measurement here says nothing about other clusters.
//
// Run `npx tsx reference/k8s/evaluate.ts shop` first (it builds validation/calm/, the ordinary day's
// model), then: npx tsx reference/k8s/retrodict-reconnect.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviveModel, type Model } from '../../src/backtest/model';
import type { Dataset } from '../../src/backtest/dataset';
import { nodeLoss } from '../../src/backtest/resilience';
import { loadEngine } from '../../src/backtest/native';

await loadEngine();
const SYS = join(dirname(fileURLToPath(import.meta.url)), 'shop');
const read = <T>(p: string) => JSON.parse(readFileSync(join(SYS, p), 'utf8')) as T;
const run = 'normal-nodeloss';

// the gRPC calls: shop.yaml's *_ADDR settings with no http:// scheme (EMAIL_ADDR and QUOTE_ADDR are
// HTTP, VALKEY_ADDR is Redis), each caller to the service it names
const GRPC: [string, string][] = [
  ...['ad', 'cart', 'checkout', 'currency', 'product-catalog', 'recommendation', 'shipping'].map((s) => ['frontend', s] as [string, string]),
  ...['cart', 'currency', 'payment', 'product-catalog', 'shipping'].map((s) => ['checkout', s] as [string, string]),
  ['recommendation', 'product-catalog'],
];
// the one the run showed stuck
const OBSERVED: [string, string][] = [['frontend', 'cart']];

const ref = JSON.parse(readFileSync(join(SYS, '../../../public/reference/k8s-shop.json'), 'utf8')) as { nodeLosses: { node: string; atS: number; pods: Record<string, Record<string, number>>; predicted: { minutesOutOfSlo: number; failedRequests: number }; measured: { minutesOutOfSlo: number; failedRequests: number } }[] };
const x = ref.nodeLosses[0];
const m = reviveModel(read<Model>('validation/calm/model.json'));
const calm = read<Dataset>('validation/calm/dataset.json');
const day = read<Dataset>(`validation/runs/${run}/dataset.json`);
const info = read<{ kill: { at: number } }>(`runs/${run}/run.json`);

const row = (label: string, d: Dataset, atS: number) => {
  const r = (grpcCalls?: [string, string][]) => nodeLoss(m, d, { pods: x.pods, nodes: [x.node], atS, draws: 10, ...(grpcCalls ? { grpcCalls } : {}) }).results[0];
  const plain = r();
  const all = r(GRPC).ifCallersStayBroken!;
  const seen = r(OBSERVED).ifCallersStayBroken!;
  console.log(`${label}: +${plain.minutesOutOfSlo} min, +${plain.failedRequests} failed | every gRPC caller stuck ${all.reconnectS} s: +${all.minutesOutOfSlo} min, +${all.failedRequests} failed (${all.calls.map((c) => c.join('→')).join(', ')}) | frontend→cart alone: +${seen.minutesOutOfSlo} min, +${seen.failedRequests} failed`);
};
row('before the day (ordinary day, placement at the kill)', calm, x.atS);
row('on the day (the run’s own traffic)', day, info.kill.at - day.start);
console.log(`measured: +${x.measured.minutesOutOfSlo} min, +${x.measured.failedRequests} failed`);
