import type { Bill, BillComponent, CostCategory, Num } from '../dataset';
import { csvObjects, parseTimestamp } from './csv';

/**
 * Cloud bills → cost per component.
 *
 *  - AWS Cost and Usage Report, legacy (`lineItem/UnblendedCost`) and CUR 2.0 / Data Exports
 *    (`line_item_unblended_cost`) column names, CSV
 *  - Google Cloud billing export (BigQuery standard usage cost), CSV or JSON lines
 *
 * Lines are attributed to components by a cost-allocation tag / label (e.g. `user:service`,
 * `app`), or by an explicit resource-id map. Everything else is reported as unattributed.
 */

export interface BillMapping {
  /** tag / label key that names the component, e.g. "user:service" (AWS) or "app" (GCP) */
  tag?: string;
  /** resource id (or substring of it) → component */
  resources?: Record<string, string>;
  /** tag value → component id */
  rename?: Record<string, string>;
}

export interface BillLine {
  start: number;
  end: number;
  component: string | null;
  category: CostCategory;
  cost: number;
  usage: number;
  sku: string;
}

export function categoryOf(usageType: string, productFamily = ''): CostCategory {
  const u = `${usageType} ${productFamily}`.toLowerCase();
  if (/data ?transfer|bytes|egress|ingress|network|inter-?zone|inter-?region|-out-|-in-/.test(u)) return 'transfer';
  if (/boxusage|instanceusage|nodeusage|fargate|vcpu|core|ram|memory|instance|spotusage|dedicatedusage|cpu|compute|gb-second|lambda-gb/.test(u)) return 'compute';
  if (/request|invocation|api ?call|operation|lcu|query/.test(u)) return 'requests';
  if (/storage|volume|snapshot|timedstorage|pd |backup|ebs:/.test(u)) return 'storage';
  return 'other';
}

function attribute(tags: Record<string, string>, resourceId: string, map: BillMapping): string | null {
  if (map.tag) {
    const v = tags[map.tag] ?? tags[map.tag.replace(':', '_')] ?? tags[`user_${map.tag.replace(/^user:/, '')}`];
    if (v) return map.rename?.[v] ?? v;
  }
  if (map.resources && resourceId) for (const [k, comp] of Object.entries(map.resources)) if (resourceId.includes(k)) return comp;
  return null;
}

/** AWS CUR (legacy or 2.0) CSV text → lines */
export function parseCur(text: string, map: BillMapping): BillLine[] {
  const rows = csvObjects(text);
  const out: BillLine[] = [];
  for (const r of rows) {
    const get = (legacy: string, v2: string) => r[legacy] ?? r[v2] ?? '';
    const type = get('lineItem/LineItemType', 'line_item_line_item_type');
    if (/tax|credit|refund|rifee|savingsplanrecurringfee|fee/i.test(type) && !/usage/i.test(type)) continue;
    const start = parseTimestamp(get('lineItem/UsageStartDate', 'line_item_usage_start_date'));
    const end = parseTimestamp(get('lineItem/UsageEndDate', 'line_item_usage_end_date'));
    const cost = parseFloat(get('lineItem/UnblendedCost', 'line_item_unblended_cost'));
    if (start === null || !isFinite(cost)) continue;
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (k.startsWith('resourceTags/') && v) tags[k.slice('resourceTags/'.length)] = v;
    const rt = r['resource_tags'];
    if (rt) {
      try {
        Object.assign(tags, JSON.parse(rt));
      } catch {
        /* not JSON — ignore */
      }
    }
    const usageType = get('lineItem/UsageType', 'line_item_usage_type');
    const family = get('product/productFamily', 'product_product_family');
    const instance = get('product/instanceType', 'product_instance_type');
    out.push({
      start,
      end: end ?? start + 3600,
      component: attribute(tags, get('lineItem/ResourceId', 'line_item_resource_id'), map),
      category: categoryOf(usageType, family),
      cost,
      usage: parseFloat(get('lineItem/UsageAmount', 'line_item_usage_amount')) || 0,
      sku: instance || usageType,
    });
  }
  return out;
}

/** Google Cloud billing export (CSV with dotted headers, or BigQuery JSON lines) → lines */
export function parseGcpBilling(text: string, map: BillMapping): BillLine[] {
  const trimmed = text.trimStart();
  const records: Record<string, unknown>[] = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : csvObjects(text);
  const pick = (r: Record<string, unknown>, path: string): unknown => {
    if (path in r) return r[path];
    return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), r);
  };
  const out: BillLine[] = [];
  for (const r of records) {
    const start = parseTimestamp(pick(r, 'usage_start_time'));
    const end = parseTimestamp(pick(r, 'usage_end_time'));
    const cost = Number(pick(r, 'cost'));
    if (start === null || !isFinite(cost)) continue;
    const tags: Record<string, string> = {};
    const labels = pick(r, 'labels');
    const list = typeof labels === 'string' ? (() => { try { return JSON.parse(labels); } catch { return []; } })() : labels;
    if (Array.isArray(list)) for (const l of list as { key: string; value: string }[]) tags[l.key] = l.value;
    for (const [k, v] of Object.entries(r)) if (k.startsWith('labels.') && v) tags[k.slice(7)] = String(v);
    const sku = String(pick(r, 'sku.description') ?? '');
    const svc = String(pick(r, 'service.description') ?? '');
    out.push({
      start,
      end: end ?? start + 3600,
      component: attribute(tags, String(pick(r, 'resource.name') ?? pick(r, 'resource.global_name') ?? ''), map),
      category: categoryOf(sku, svc),
      cost,
      usage: Number(pick(r, 'usage.amount_in_pricing_units') ?? pick(r, 'usage.amount') ?? 0) || 0,
      sku,
    });
  }
  return out;
}

/** aggregate bill lines; if a grid is given, spread each line's cost over the buckets it covers */
export function summariseBill(lines: BillLine[], source: Bill['source'], grid?: { start: number; stepS: number; n: number }, currency = 'USD'): Bill {
  const comps: Record<string, BillComponent> = {};
  let unattributed = 0;
  let total = 0;
  let start = Infinity;
  let end = -Infinity;
  for (const l of lines) {
    total += l.cost;
    start = Math.min(start, l.start);
    end = Math.max(end, l.end);
    if (!l.component) {
      unattributed += l.cost;
      continue;
    }
    const c = (comps[l.component] ??= { total: 0, byCategory: {}, usage: {}, skus: [], ...(grid ? { series: new Array<Num>(grid.n).fill(null) } : {}) });
    c.total += l.cost;
    c.byCategory[l.category] = (c.byCategory[l.category] ?? 0) + l.cost;
    c.usage[l.category] = (c.usage[l.category] ?? 0) + l.usage;
    if (l.sku && !c.skus.includes(l.sku)) c.skus.push(l.sku);
    if (grid && c.series) {
      const dur = Math.max(1, l.end - l.start);
      for (let i = Math.max(0, Math.floor((l.start - grid.start) / grid.stepS)); i < grid.n; i++) {
        const bs = grid.start + i * grid.stepS;
        const be = bs + grid.stepS;
        if (bs >= l.end) break;
        const overlap = Math.min(be, l.end) - Math.max(bs, l.start);
        if (overlap > 0) c.series[i] = (c.series[i] ?? 0) + (l.cost * overlap) / dur;
      }
    }
  }
  return { source, currency, start: isFinite(start) ? start : 0, end: isFinite(end) ? end : 0, total, components: comps, unattributed };
}
