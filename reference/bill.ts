import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A synthetic AWS Cost and Usage Report (legacy CSV columns) for a reference run, priced as if each
 * compose service ran on AWS Fargate in us-east-1: per-second vCPU and GB charges for the replicas
 * that actually ran (from the recorded replica, CPU-limit and memory-limit series), plus internet
 * egress for the edge service's transmitted bytes. Hourly line items, tagged `user:service`.
 *
 * Local demo apps have no cloud bill; this one is built only from what was *measured*, never from
 * the model, so the model's cost prediction can be checked against it.
 */
export const FARGATE = {
  x86: { vcpuHour: 0.04048, gbHour: 0.004445 },
  arm: { vcpuHour: 0.03238, gbHour: 0.00356 },
  egressGb: 0.09,
  source: 'https://aws.amazon.com/fargate/pricing/ (us-east-1, Linux) · https://aws.amazon.com/ec2/pricing/on-demand/ (data transfer out)',
};

type Matrix = { metric: Record<string, string>; values: [number, string][] }[];
const load = (dir: string, f: string): Matrix => JSON.parse(readFileSync(join(dir, f), 'utf8')).data.result;
const by = 'container_label_com_docker_compose_service';

function series(m: Matrix): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const s of m) out.set(s.metric[by], new Map(s.values.map(([t, v]) => [Number(t), parseFloat(v)])));
  return out;
}

export function synthesiseCur(metricsDir: string, o: { start: number; end: number; arch?: 'x86' | 'arm'; edge?: string; placement?: Record<string, unknown> }): string {
  const price = FARGATE[o.arch ?? 'x86'];
  const replicas = series(load(metricsDir, 'cadvisor-replicas.json'));
  const cpu = series(load(metricsDir, 'cadvisor-cpu-limit.json'));
  const mem = series(load(metricsDir, 'memory-limit.json'));
  const tx = series(load(metricsDir, 'cadvisor-net-tx.json'));
  const head = ['identity/LineItemId', 'lineItem/LineItemType', 'lineItem/UsageStartDate', 'lineItem/UsageEndDate', 'lineItem/ProductCode', 'lineItem/UsageType', 'lineItem/Operation', 'lineItem/ResourceId', 'lineItem/UsageAmount', 'lineItem/UnblendedRate', 'lineItem/UnblendedCost', 'lineItem/CurrencyCode', 'product/productFamily', 'resourceTags/user:service'];
  const rows = [head.join(',')];
  let id = 0;
  const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000', '');
  const line = (h0: number, h1: number, product: string, usageType: string, op: string, svc: string, amount: number, rate: number, family: string) =>
    rows.push([`ref-${++id}`, 'Usage', iso(h0), iso(h1), product, usageType, op, `arn:aws:ecs:us-east-1:000000000000:service/reference/${svc}`, amount.toFixed(8), rate, (amount * rate).toFixed(10), 'USD', family, svc].join(','));
  for (const [svc, reps] of replicas) {
    for (let h = Math.floor(o.start / 3600) * 3600; h < o.end; h += 3600) {
      let vcpuH = 0;
      let gbH = 0;
      let bytes = 0;
      const pts = [...reps].filter(([t]) => t >= Math.max(h, o.start) && t < Math.min(h + 3600, o.end)).sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < pts.length; i++) {
        const [t, n] = pts[i];
        const dt = (i + 1 < pts.length ? pts[i + 1][0] : Math.min(h + 3600, o.end)) - t;
        vcpuH += (n * (cpu.get(svc)?.get(t) ?? 0.25) * dt) / 3600;
        gbH += (n * ((mem.get(svc)?.get(t) ?? 512 * 2 ** 20) / 2 ** 30) * dt) / 3600;
        if (svc === o.edge) bytes += (tx.get(svc)?.get(t) ?? 0) * dt;
      }
      if (!pts.length) continue;
      // a real CUR line spans the clock hour; these are clipped to the recorded window so the bill
      // and the recording cover exactly the same time
      const a = Math.max(h, o.start);
      const b = Math.min(h + 3600, o.end);
      line(a, b, 'AmazonECS', `USE1-Fargate-vCPU-Hours:perCPU`, 'FargateTask', svc, vcpuH, price.vcpuHour, 'Compute');
      line(a, b, 'AmazonECS', `USE1-Fargate-GB-Hours`, 'FargateTask', svc, gbH, price.gbHour, 'Compute');
      if (bytes > 0) line(a, b, 'AWSDataTransfer', 'USE1-DataTransfer-Out-Bytes', 'RunInstances', svc, bytes / 2 ** 30, FARGATE.egressGb, 'Data Transfer');
    }
  }
  return rows.join('\n') + '\n';
}
