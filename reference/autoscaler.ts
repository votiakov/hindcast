import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * A target-tracking autoscaler for a Docker Compose service (what an ECS service / HPA does):
 * every `intervalS`, read mean CPU utilisation per replica from Prometheus, aim for `targetCpu`,
 * scale out at once, scale in only after `cooldownS`. Every decision is logged with its timestamp.
 */
export function autoscaleLoop(o: { prom: string; compose: string; project: string; env: Record<string, string>; service: string; min: number; max: number; targetCpu: number; cooldownS?: number; intervalS?: number; log: string }) {
  let running = true;
  let replicas = Number(o.env[`${o.service.toUpperCase().replace(/-/g, '_')}_REPLICAS`] ?? o.min);
  let lastChange = 0;
  const q = async (query: string) => {
    const r = await fetch(`${o.prom}/api/v1/query?${new URLSearchParams({ query })}`);
    const j = (await r.json()) as { data: { result: { value: [number, string] }[] } };
    return j.data.result.length ? parseFloat(j.data.result[0].value[1]) : NaN;
  };
  const sel = `container_label_com_docker_compose_project="${o.project}",container_label_com_docker_compose_service="${o.service}"`;
  const loop = (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, (o.intervalS ?? 15) * 1000));
      if (!running) break;
      const used = await q(`sum(rate(container_cpu_usage_seconds_total{${sel}}[30s]))`);
      const limit = await q(`max(container_spec_cpu_quota{${sel}} / container_spec_cpu_period{${sel}})`);
      if (!isFinite(used) || !isFinite(limit)) continue;
      const util = used / (replicas * limit);
      const desired = Math.min(o.max, Math.max(o.min, Math.ceil((replicas * util) / o.targetCpu - 1e-9)));
      const now = Date.now() / 1000;
      if (desired > replicas || (desired < replicas && now - lastChange >= (o.cooldownS ?? 120))) {
        appendFileSync(o.log, `${Math.floor(now)} ${o.service} ${replicas} -> ${desired} (cpu ${(util * 100).toFixed(0)}% of ${replicas}×${limit})\n`);
        execSync(`docker compose -f ${o.compose} up -d --no-recreate --scale ${o.service}=${desired}`, { stdio: 'ignore', env: { ...process.env, ...o.env } });
        replicas = desired;
        lastChange = now;
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
