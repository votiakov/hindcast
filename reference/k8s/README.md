# Kubernetes reference — would the backtest have told you the truth?

The other reference systems run on Docker Compose with synthetic traffic. This one is the
production setup most teams have, with real traffic, and asks the question that matters: **before a
change ships, does the backtest's verdict match what really happens when it ships?**

## The setup

- **Cluster**: [kind](https://kind.sigs.k8s.io) with a control plane and two workers
  ([kind.yaml](kind.yaml)).
- **Observability**, the common production stack:
  - kube-prometheus-stack: kubelet/cAdvisor, kube-state-metrics, Prometheus scraping every 15 s
    ([monitoring.values.yaml](monitoring.values.yaml)).
  - ingress-nginx with its request metrics.
  - An OpenTelemetry Collector turning every span into RED metrics.
  - Jaeger keeping a 10% sample of traces.
- **The system**: the OpenTelemetry Astronomy Shop (2.0.2), 11 services in 9 languages, as plain
  manifests ([shop/gen.ts](shop/gen.ts) → [shop/shop.yaml](shop/shop.yaml)), with CPU requests
  equal to limits. The frontend runs 3 replicas: the over-provisioned starting point the questions
  try to trim.
- **Traffic**: real. The NASA Kennedy Space Center web server log for July 1995 (Internet Traffic
  Archive), replayed with k6 at 83× its rate. Each day is compressed into 40 minutes; arrivals are
  Poisson within each 20-second slice, so the curve and the spikes are the log's own
  ([../load/fromLog.mjs](../load/fromLog.mjs)).
  - **12 July** is an ordinary day: it peaks at 180 req/s.
  - **13 July** is the launch of Space Shuttle STS-70: a real flash crowd, 2.2× the ordinary
    day's peak.
- **The agent's path**: each run's telemetry is collected the way an agent collects it.
  `connect_telemetry` and `collect_telemetry` run against the live Prometheus and Jaeger, and k6
  keeps every request it made as the ground truth.

## The questions

The model is calibrated on one ordinary day (`history`) and never sees any other run. Each change
is a manifest variant, as a pull request would leave it ([shop/variants](shop/variants)):

| run | the question | the change, applied for real |
|---|---|---|
| `launch` | Does the system as built survive launch day? | — |
| `normal-2` | Can the frontend go from 3 replicas to 2 on an ordinary day? | `frontend-2.yaml` |
| `launch-2` | …and on launch day? | `frontend-2.yaml` |
| `normal-1` | Can it go to 1 replica on an ordinary day? | `frontend-1.yaml` |
| `launch-hpa` | Does an HPA (1–3 replicas at 60% CPU) handle launch day? | `frontend-hpa.yaml` |

For each run, three answers are compared with what k6 measured:

1. **The verdict before the change shipped**: `verify_change` on the calibration day. For launch
   day it is replayed at 2.2× (`traffic: { scale: 2.2 }`), the forecast an engineer would make.
2. **The model's prediction over the traffic that actually came**: model error alone, without
   forecast error. This gives p99 over every request, the error rate, and minutes out of SLO
   (SLO: p99 ≤ 1 s, errors ≤ 1%).
3. **The naive answer**: the frontend's busiest CPU utilisation in the history, scaled by the change
   (3/2, 3/1) and by the forecast. "Under 100% is fine."

Reality's verdict uses the same gate as `verify_change`. A change fails if it adds more than
half a minute out of SLO over the as-built system on the same day; the as-built system fails if it
spends any minute out of SLO.

## Results

<!-- RESULTS -->
**Calibrated on the ordinary day:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | pass ✅, 0 min | p99 132 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | pass ✅ (medium confidence), 0 min | p99 83 ms, errors 0.00%, 0 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 19.3 min | p99 5000 ms, errors 61.1%, 15.5 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | fail ✅ (low confidence), 10.5 min | p99 100 ms, errors 0.00%, 0 min | fail ✅ at 113% CPU |
| `launch-hpa` | An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day? | **fail**: p99 159 ms, errors 0.08%, 1.5 min out of SLO | fail ✅ (low confidence), 1.5 min | p99 3969 ms, errors 1.2%, 2 min | pass ❌ at 84% CPU |

Backtest verdicts: **5 right**, 0 inconclusive (it said to load-test), 0 wrong, of 5. Naive CPU ratio: 4 right.

**Calibrated on the ordinary day and a 12-minute load test:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | pass ✅, 0 min | p99 279 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | inconclusive ⚠️ (low confidence), 0 min | p99 258 ms, errors 0.00%, 0 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 4.5 min | p99 5000 ms, errors 22.4%, 9.5 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | fail ✅ (low confidence), 1 min | p99 284 ms, errors 0.00%, 0.5 min | fail ✅ at 113% CPU |
| `launch-hpa` | An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day? | **fail**: p99 159 ms, errors 0.08%, 1.5 min out of SLO | inconclusive ⚠️ (low confidence), 0.5 min | p99 311 ms, errors 0.00%, 0 min | pass ❌ at 84% CPU |

Backtest verdicts: **3 right**, 2 inconclusive (it said to load-test), 0 wrong, of 5. Naive CPU ratio: 4 right.

The first 2 minutes of every run are left out of the scoring, measured and predicted alike (pods restarted minutes earlier). Generated by `npx tsx reference/k8s/evaluate.ts`, 2026-10-14.
<!-- /RESULTS -->

## What it says

- **The first version overestimated a single-threaded service under a CPU limit.** In the load
  test, the frontend (Node.js, half a core per pod) collapsed at about 195 requests/s per pod. At
  that point its CPU was at 79% of the limit and throttled in 44% of CFS periods. Under hours of real
  traffic it broke 15–20% below that (normal-1, launch-2). The model read capacity from CPU per
  request extrapolated to 100% of the limit, 214–246 req/s. It called one replica safe on an
  ordinary day (27% errors) and the autoscaler safe on launch day. From the ordinary day alone it
  got 2 of 5 right; a plain CPU-ratio rule got 4.
- **Calibration now reads CFS throttling** (`container_cpu_cfs_throttled_periods_total`, in the
  kubernetes preset). On the ordinary day the frontend was throttled in 2.6% of periods at 12% of
  its limit and 8.8% at 37%. Fitted as an exponential, that reaches 25%, the threshold of
  kube-prometheus's `CPUThrottlingHigh` alert, at 66% of the limit. That is the CPU the model now
  lets it use: 134 req/s per pod, where it used to assume 214–246.
  Two guards keep this from penalising services that run throttled without harm. `recommendation`
  (Python) spends a quarter of its periods throttled and handled launch day fine:
  - the throttle cap overrides a capacity read from latency only where the history shows the
    service failing while throttled (the load test's last step, for the frontend);
  - a service seen throttled past the threshold while keeping its latency is left alone.
- **With it, the ordinary day alone gets all 5 right**, the autoscaler included, which the
  CPU-ratio rule calls safe. With the load test as well: 3 right and 2 inconclusive (it asked for a
  load test), none wrong. The load test reads a higher limit (72% of the limit, 169 req/s per pod),
  because 60-second steps hold briefly what hours of traffic can't. Its latency fit for the frontend
  is poor, which is why it hedges.
- **Caveat: the throttle rules were designed while looking at these five runs.** The 25%
  threshold comes from the alert rather than from these results. The two guards came from what
  went wrong here, so the score above is in-sample until new runs confirm it.
- **It still underestimates the tail before the limit.** On launch day the frontend's p99 climbed to
  500–700 ms at 60% CPU, as quota stalls and a few slow requests on one thread compound. Every p99
  check misses by 47–98%. The queueing model has no term for the time a request waits out a
  throttled period. That is the next gap.
- **It knew when it didn't know.** Where a change pushed the frontend past anything the history had
  shown, `verify_change` said *inconclusive*, never pass. The recorded agent demo
  ([demos/agent.tape](../../demos/agent.tape)) predates the throttle model: it said to load-test
  before cutting to 2 replicas for launch day, and that run failed 45% of its requests.

The calibration's foundation, CPU from traffic, holds up on real production telemetry: see
[../alibaba](../alibaba). When traffic moved, its forecasts were off 5.9% on 44 of Alibaba's busiest
services, against 11–13% for naive forecasts.

## Running it

```sh
kind create cluster --config reference/k8s/kind.yaml --kubeconfig ~/.kube/bnk8s   # never your own context
export KUBECONFIG=~/.kube/bnk8s
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace -f reference/k8s/monitoring.values.yaml
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.hostPort.enabled=true --set controller.service.type=ClusterIP \
  --set-string controller.nodeSelector.ingress-ready=true --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true --set-string controller.extraArgs.metrics-per-undefined-host=true \
  --set 'controller.tolerations[0].key=node-role.kubernetes.io/control-plane' --set 'controller.tolerations[0].operator=Exists' --set 'controller.tolerations[0].effect=NoSchedule'
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --set 'args={--kubelet-insecure-tls}'
sh reference/k8s/nasa/fetch.sh
kubectl apply -f reference/k8s/shop/shop.yaml
BNK8S_KUBECONFIG=~/.kube/bnk8s sh reference/k8s/record-all.sh shop history launch normal-2 launch-2 normal-1 launch-hpa
npx tsx reference/k8s/evaluate.ts shop
```

Each run takes about 47 minutes: a restart, a 3-minute warm-up, the 40-minute day, and collection.

## What a real cluster taught the product

Each of these broke a recording or a prediction, and is now handled in the product for every
user's cluster, not just this one.

- **Containers aren't services.** Real clusters name containers `app` or `server`, and run sidecars
  (`istio-proxy`) in every pod. Kubernetes metrics are grouped by the workload that owns each pod
  (Deployment, StatefulSet, DaemonSet, from the pod name). Many clusters set CPU requests and no
  limits; the request then stands in.
- **A cluster's Prometheus sees everything.** coredns, the monitoring stack and other teams' pods
  are all there. Collection keeps the Kubernetes metrics to the namespaces the traced services run in.
- **Span metrics undercount.** Span names carrying raw URLs (`GET /api/cart?sessionId=…`) make
  thousands of sparse series, and Prometheus' `rate()` loses each new series' first increment. At
  150 req/s the frontend's span metrics counted 62% of the requests. The **ingress-nginx** preset
  counts every request at the edge, and its rate, errors and latency take precedence for the entry
  service.
- **Frameworks count twice.** Next.js wraps every request in two server spans, the outer one named
  only `GET` or `POST`. A third of the endpoint traffic had no route and no downstream path. Those
  series are dropped where the traces show two server spans per visit.
- **Traces lose spans.** The checkout service's outgoing calls didn't arrive in Jaeger, so cart,
  currency and shipping looked like entry services and their calls like requests of their own.
  Orphan spans now hang under the innermost span whose time contains them.
- **Short windows mis-sliced traces.** The trace sampler cut every window into 96 slices of at
  least a minute, so a 40-minute window's weights came from 96 minutes of Prometheus. Slices now
  match the window.

The cluster itself needed what a production cluster needs. Each of these caused an outage during
a recording:
- `enableServiceLinks: false`: Kubernetes injected `FLAGD_PORT=tcp://…` into every pod, and the
  feature-flag service listened on a random port.
- A TCP readiness probe instead of `GET /`: the page calls product-catalog, and an HTTP check that
  depends on a downstream service took every replica out of rotation when that service slowed down.
- `GOMEMLIMIT` and memory headroom for the Go services, which were OOM-killed at 64–128Mi.
- A collector that accepts OTLP logs and metrics: refused, the C++ SDK retried on new threads
  (1,194 of them) until its CPU limit was spent.
- Jaeger on disk (Badger): in memory it was OOM-killed on a busy day.
- `--metrics-per-undefined-host=true`: ingress-nginx records nothing for an Ingress without a host.
