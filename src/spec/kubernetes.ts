import type { ImportResult } from './terraform';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

/**
 * Kubernetes manifests → architecture spec.
 *
 * Input: the parsed documents of one or more manifests (`kubectl get … -o yaml`, Helm output,
 * kustomize build). Workloads become components (Deployments, StatefulSets, DaemonSets); a
 * HorizontalPodAutoscaler becomes `autoscale`; images tell databases, caches and brokers apart;
 * Ingresses and LoadBalancer Services become entry points. Manifests do not record who calls whom,
 * so call edges come from references in container env vars / args / config to other Services'
 * names — every such guess is listed in `assumptions`.
 */

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

export function importKubernetes(docsIn: unknown[], name?: string): ImportResult {
  return wasm.importKubernetes(docsIn, name) as ImportResult;
}

/** a parsed document (or list of documents) that looks like Kubernetes */
export const looksLikeKubernetes = (docs: unknown[]) => docs.some((d) => !!o(d).apiVersion && !!o(d).kind);
