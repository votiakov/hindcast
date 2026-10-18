/**
 * The questions each Kubernetes reference system is scored on: one recorded run with a change really
 * applied, the as-built run it is compared with, and the forecast an engineer would make before the day.
 * Read by evaluate.ts (the published scores) and loo.ts (leave-one-run-out, in sample).
 */

export interface Case {
  run: string;
  /** the as-built run on the same day, for "did the change add minutes out of SLO?" */
  asBuilt: string;
  /** a second recording of that as-built day: from round 5 on, a change fails only when it is worse than both */
  asBuiltAlso?: string;
  /** manifests the change leaves (none: the as-built system itself) */
  head?: string;
  /** a stacked change: manifests with an approved change not yet deployed applied (verify_change's
   *  `baseline`, base → baseline), in place on both sides of the verdict before the day, so the case's
   *  head is judged against as built + baseline (the change itself is baseline → head). head is then
   *  the manifests with both, as the run had them, and asBuilt a run of the baseline's manifests: the
   *  model on the day's traffic and the naive rule read head as they always do, the system the run
   *  really had */
  baseline?: string;
  /** the forecast an engineer would make before the day: the ordinary day ×scale */
  scale: number;
  question: string;
  /** frontend cores per pod after the change (default: as built, half a core) */
  cpu?: number;
  /** out of sample: the round whose committed predictions it is scored on (made before it ran) */
  oos?: number;
  /** the service the change is about, whose replicas the series keep (default: the system's watch) */
  service?: string;
  /** the naive rule for this question (default: the system's): a change away from the shop's frontend is judged on every service */
  naive?: 'frontend' | 'all';
  /** the change's name as a strategy (default: from the shop's variant file names) */
  name?: string;
}

export const LAUNCH = 2.22; // 13 July's busiest 10 minutes over 12 July's, from the log itself
export const SHOP_CASES: Case[] = [
  { run: 'launch', asBuilt: 'launch', scale: LAUNCH, question: 'As built (3 frontend replicas), on launch day?' },
  { run: 'normal-2', asBuilt: 'history', head: 'variants/frontend-2.yaml', scale: 1, question: '2 frontend replicas instead of 3, on an ordinary day?' },
  { run: 'launch-2', asBuilt: 'launch', head: 'variants/frontend-2.yaml', scale: LAUNCH, question: '2 frontend replicas instead of 3, on launch day?' },
  { run: 'normal-1', asBuilt: 'history', head: 'variants/frontend-1.yaml', scale: 1, question: '1 frontend replica, on an ordinary day?' },
  { run: 'launch-hpa', asBuilt: 'launch', head: 'variants/frontend-hpa.yaml', scale: LAUNCH, question: 'An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day?' },
  { run: 'launch-2c', asBuilt: 'launch', head: 'variants/frontend-2-1cpu.yaml', scale: LAUNCH, cpu: 1, oos: 1, question: '2 frontend replicas at 1 core instead of 3 at half a core, on launch day?' },
  { run: 'normal-1c', asBuilt: 'history', head: 'variants/frontend-1-1cpu.yaml', scale: 1, cpu: 1, oos: 1, question: '1 frontend replica at 1 core, on an ordinary day?' },
  { run: 'normal-1-750', asBuilt: 'history', head: 'variants/frontend-1-750m.yaml', scale: 1, cpu: 0.75, oos: 1, question: '1 frontend replica at 750m, on an ordinary day?' },
  { run: 'launch-x1.3', asBuilt: 'launch-x1.3', scale: LAUNCH * 1.3, oos: 1, question: 'As built, on a launch day with 30% more traffic?' },
  { run: 'launch-x1.3-4', asBuilt: 'launch-x1.3', head: 'variants/frontend-4.yaml', scale: LAUNCH * 1.3, oos: 2, question: '4 frontend replicas, on a launch day with 30% more traffic?' },
  { run: 'launch-x1.3-hpa', asBuilt: 'launch-x1.3', head: 'variants/frontend-hpa-2-5.yaml', scale: LAUNCH * 1.3, oos: 2, question: 'An HPA (2–5 replicas at 50% CPU), on a launch day with 30% more traffic?' },
  { run: 'launch-2-750', asBuilt: 'launch', head: 'variants/frontend-2-750m.yaml', scale: LAUNCH, cpu: 0.75, oos: 2, question: '2 frontend replicas at 750m instead of 3 at half a core, on launch day?' },
  { run: 'normal-x1.5', asBuilt: 'normal-x1.5', scale: 1.5, oos: 3, question: 'As built, on an ordinary day with 50% more traffic?' },
  { run: 'launch-email300', asBuilt: 'launch', head: 'variants/email-300mi.yaml', scale: LAUNCH, oos: 3, question: 'email with 300 MiB instead of 150, on launch day?' },
  { run: 'launch-cart250', naive: 'all', asBuilt: 'launch', head: 'variants/cart-250m.yaml', scale: LAUNCH, oos: 4, service: 'cart', name: 'cart at 250m', question: 'cart at 250m instead of 500m, on launch day?' },
  { run: 'launch-rec2', naive: 'all', asBuilt: 'launch', head: 'variants/recommendation-2.yaml', scale: LAUNCH, oos: 4, service: 'recommendation', name: 'recommendation ×2', question: '2 recommendation replicas instead of 1, on launch day?' },
  { run: 'normal-catalog125', naive: 'all', asBuilt: 'history', head: 'variants/product-catalog-125m.yaml', scale: 1, oos: 4, service: 'product-catalog', name: 'product-catalog at 125m', question: 'product-catalog at 125m instead of 250m, on an ordinary day?' },
  { run: 'launch-catalog125', naive: 'all', asBuilt: 'launch', asBuiltAlso: 'launch-b', head: 'variants/product-catalog-125m.yaml', scale: LAUNCH, oos: 5, service: 'product-catalog', name: 'product-catalog at 125m', question: 'product-catalog at 125m instead of 250m, on launch day?' },
  { run: 'launch-checkout125', naive: 'all', asBuilt: 'launch', asBuiltAlso: 'launch-b', head: 'variants/checkout-125m.yaml', scale: LAUNCH, oos: 5, service: 'checkout', name: 'checkout at 125m', question: 'checkout at 125m instead of 250m, on launch day?' },
  { run: 'launch-3-400', asBuilt: 'launch', asBuiltAlso: 'launch-b', head: 'variants/frontend-3-400m.yaml', scale: LAUNCH, cpu: 0.4, oos: 5, question: '3 frontend replicas at 400m instead of 500m, on launch day?' },
  { run: 'launch-e300-2', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-frontend-2.yaml', scale: LAUNCH, oos: 6, question: '2 frontend replicas instead of 3, on launch day, with email at 300 MiB?' },
  { run: 'launch-e300-3-400', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-frontend-3-400m.yaml', scale: LAUNCH, cpu: 0.4, oos: 6, question: '3 frontend replicas at 400m instead of 500m, on launch day, with email at 300 MiB?' },
  { run: 'launch-e300-catalog125', naive: 'all', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-catalog-125m.yaml', scale: LAUNCH, oos: 6, service: 'product-catalog', name: 'product-catalog at 125m', question: 'product-catalog at 125m instead of 250m, on launch day, with email at 300 MiB?' },
  // round 7: the same three changes, judged by the model recalibrated on history-b (the headline for this round)
  { run: 'launch-r7-2', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-frontend-2.yaml', scale: LAUNCH, oos: 7, question: '2 frontend replicas instead of 3, on launch day, with email at 300 MiB (recalibrated)?' },
  { run: 'launch-r7-3-400', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-frontend-3-400m.yaml', scale: LAUNCH, cpu: 0.4, oos: 7, question: '3 frontend replicas at 400m instead of 500m, on launch day, with email at 300 MiB (recalibrated)?' },
  { run: 'launch-r7-catalog125', naive: 'all', asBuilt: 'launch-email300', asBuiltAlso: 'launch-e300-b', baseline: 'variants/email-300mi.yaml', head: 'variants/e300-catalog-125m.yaml', scale: LAUNCH, oos: 7, service: 'product-catalog', name: 'product-catalog at 125m', question: 'product-catalog at 125m instead of 250m, on launch day, with email at 300 MiB (recalibrated)?' },
];
