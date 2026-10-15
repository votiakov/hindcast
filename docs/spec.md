# Architecture spec v1

The spec is the contract between the engines and everything else (app, CLI, MCP, tests). YAML or
JSON. The zod schema in `src/spec/schema.ts` is the source of truth; `validate_architecture` /
`npm run sim -- validate` checks it and lints the design.

## Architecture

```yaml
version: 1                      # optional, defaults to 1
name: Checkout                  # optional
description: …                  # optional
pricing: aws-us-east-1          # optional: illustrative (default) | aws-us-east-1 — see catalog.md
components:                     # required, ≥ 1
  - id: users                   # unique; also the display name unless `name` is set
    kind: client
  - { id: lb, kind: lb }
  - { id: api, kind: server, instances: 6, runtime: go, tier: M }
  - { id: db, kind: db, tier: L }
connections:                    # caller → callee
  - users -> lb                 # the arrow form; the app writes this one
  - [lb, api]                   # a pair works too
  - { from: api, to: db, latencyMs: 70 }   # the object form: a link with network round-trip latency (cross-region)
zones:                          # optional failure domains
  - { id: az-a, label: us-east-1a, members: [api, db] }
```

### Component fields

| field | applies to | meaning |
|---|---|---|
| `id` | all | unique id |
| `kind` | all | `client cdn lb gateway server worker function cache db replica storage queue llm llmapi external kv dns stream` |
| `name` | all | display name |
| `tier` | sizable kinds | `S` (×1 capacity, ×1 cost), `M` (×2, ×2.2), `L` (×4, ×4.8) |
| `instances` | server, worker, llm | horizontal instances (1–500); reachable only behind lb/gateway/queue |
| `runtime` | server, worker, function | `node python java go rust` (see catalog.md) |
| `hitRate` | cache, cdn | 0–0.999 |
| `limit` | gateway, llmapi, external, kv, function | rate limit (req/s) or max concurrency |
| `batching` | llm | continuous batching: ×4 throughput, +400 ms |
| `retries` | any caller | retries per failed downstream call (0–10) |
| `retryPolicy` | any caller | `immediate` · `backoff` (exponential + jitter) · `budget` (≤ 10 % extra) |
| `timeoutMs` | any caller (typically client) | deadline per attempt; slower responses are failures |
| `breaker` | any caller | circuit breaker on downstream calls |
| `fallback` | with `breaker` | serve a degraded response while open |
| `threads` | server, worker | threads per instance: every request in flight holds one, waiting on its calls included (thread-per-request, e.g. Tomcat's 200); unset = asynchronous. A slow dependency then exhausts them, and requests that never touch it fail too |
| `bulkhead` | any caller | calls that may wait on any one dependency at once, per instance; past it a call fails at once instead of taking another thread |
| `provisioned` | function | provisioned concurrency: executions kept warm, so no cold start up to it; billed by the hour whether used or not ($0.0000041667 per GB-s, AWS) |
| `prefixes` | storage | key prefixes the objects are spread over (default 10): each takes 5,500 reads or 3,500 writes a second (S3), past it 503 SlowDown; `hotKeyShare` puts that share on one prefix |
| `hotRowShare` | db | share of the writes that update one row (a stock counter, a balance): its lock takes them one at a time, each for a write's time — at most 1,000 ÷ latency a second, however big the database |
| `burst` | gateway | the token bucket's size in requests (default one second of `limit`): a burst above the rate passes until the bucket is empty — API Gateway's rate 10,000 and burst 5,000 |
| `maxReceives`, `visibilityS` | queue | a redrive policy (SQS maxReceiveCount): a message a consumer fails comes back after `visibilityS` (default 30 s) until it has been received `maxReceives` times, then goes to the dead-letter queue; unset, a failed message is gone |
| `routing` | any caller | `split` (default) · `fanout` (call all, wait for all) · `failover` (in order) |
| `fanout` | any caller | scatter-gather: each call goes to N partitions of the callee in parallel and waits for the slowest (also makes the callee's instances reachable) |
| `stallRate`, `stallMs` | any | rare hiccups: share of requests that stall, and for how long (GC pause, compaction, noisy neighbor) |
| `queueS` | queued kinds | bounded queue length in seconds of work |
| `autoscale` | server, worker, llm | `{ min, max, targetUtil?, warmupS?, cooldownS? }` — target-tracking autoscaling; `instances` is the starting size. Defaults: target 0.6, warm-up 30 s, scale-in cooldown 60 s |
| `warmupS` | cache, cdn | re-warm time constant after a restart or flush (default 20 s) |
| `writePolicy` | cache, cdn | `through` (default): writes go on to the origin. `behind`: acknowledged at the cache and flushed ~5 s later — writes are fast and the origin sees them smoothed, but the buffered ones are lost if the cache dies (`lostWrites`) |
| `workingSetGb`, `skew` | cache | the data the cache fronts (GB) and how concentrated reads are on popular keys (Zipf exponent, default 1): with them the hit rate follows from the cache's memory (S 6.4, M 13, L 26 GB) instead of `hitRate` |
| `shards` | db, replica | horizontal partitions (1–256), each a full database holding part of the keys: capacity and cost × shards. Writes split with the data, which replicas and caches cannot do. Give a sharded database's replica the same count (a replica per shard) |
| `partitions` | stream | partitions (default 4): 1,000 messages/s in and $0.015/h each, and the most consumer instances any one subscriber can use |
| `ttlS`, `healthCheckS` | dns | how long clients cache an answer (default 60 s) and how long health checks take to notice a dead target (default 30 s): after a target dies, everyone sent there fails until the checks notice, then fewer as caches expire |
| `hotKeyShare` | db, kv | share of its traffic on one key (a celebrity, a hot counter): it all lands on one shard, which takes `hotKeyShare + (1 − hotKeyShare) / shards` of the load and saturates first |
| `capacity` | any | override: req/s per size-S instance |
| `latencyMs` | any | override: base service time |
| `costPerHour` | any | override: $/h per size-S instance |

### Connections and semantics

- Three ways to write one: `users -> lb`, `[users, lb]`, `{ from: users, to: lb }`. Only the object
  form carries link properties (`latencyMs`, `calls`, `carries`, `replication`).
- Order matters for `routing: failover` (first child first).
- `db → replica` connections define replicas (reads are shared, failover target).
- `queue → worker` connections define consumers (pull model).
- `cache → db` / `cdn → lb` define the origin for misses.
- `latencyMs` on a connection adds that round trip to every call over the link: same AZ ≈ 0,
  cross-AZ ≈ 1, nearby region ≈ 15, cross-continent ≈ 70, intercontinental ≈ 150.
- `calls: N` on a connection: every request that takes the link makes N calls over it, in parallel —
  the callee sees N× the load, the caller needs all N to succeed and waits for the slowest (a tweet
  written to 20 timelines, a page that looks up 20 items).
- `carries: reads | writes` on a connection: the link takes only that class (CQRS — reads to a cache
  or replica, writes to a queue). A component's reads and writes are spread over the links that
  carry them; a class with no link to take it fails there.
- `replication: sync | async` on a `db → replica` connection. `async` (default): the primary
  acknowledges a write at once and the replica receives it a link round-trip later; while it cannot
  reach the primary (partition) its lag grows, and a failover promotes it with what it never
  received missing (`lostWrites`), and its reads are stale (`staleReads`, `replicaLagS`).
  `sync`: every write waits for that replica — no data lost on failover, and writes fail while it is
  unreachable. CAP in one field: consistency or availability during a partition.

### Lint rules (warnings unless noted)

- no `client` component (error); duplicate ids, unknown/self connections, unknown zone members (errors)
- `lb`/`gateway`/`queue` with nothing behind it (error)
- cache/cdn without origin; `instances > 1` without lb/gateway/queue in front; replica not fed by a db;
  component nothing connects to; `fallback` without `breaker`

## Scenario

```yaml
name: Black Friday
duration: 90                    # simulated seconds (≤ 3600), default 60
rps: 800                        # constant traffic — or:
traffic:                        # keyframes, linear in between (wins over rps)
  - { at: 0, rps: 600 }
  - { at: 30, rps: 2400 }
readRatio: 0.85                 # default 0.8
events:
  - { at: 60, action: { type: kill, kind: server, pick: busiest }, note: "instance dies at peak" }
slo: { maxErrorRate: 0.01, maxP99Ms: 300 }      # defaults
```

### Actions

| action | effect |
|---|---|
| `{ type: kill-id, id }` | kill a component (scalable kinds lose one instance per kill) |
| `{ type: revive-id, id }` | bring it back (all instances) |
| `{ type: kill, kind, pick: busiest\|random }` | kill one live component/instance of a kind |
| `{ type: revive-all }` | heal everything, restore zones, clear degradation |
| `{ type: fail-zone, id }` / `{ type: restore-zone, id }` | take every member of a zone down / up |
| `{ type: degrade, id, factor }` | brownout: capacity × factor (0–1) |
| `{ type: inject-errors, id, rate }` | gray failure: the component fails `rate` (0–1) of its requests |
| `{ type: inject-latency, id, ms }` | gray failure: every request takes `ms` longer (and each worker is busy longer, so throughput drops too) |
| `{ type: flush-cache, id }` | a cache/cdn loses every key — hit rate restarts from zero and re-warms over `warmupS` |
| `{ type: restore, id }` | end a brownout and clear injected faults |
| `{ type: hot-key, id, share }` | a database or key-value store: `share` of its traffic goes to one key — one shard, or one partition (0 ends it) |
| `{ type: partition, a, b }` | cut the network between zones `a` and `b`: every link between their members fails (both sides keep running) |
| `{ type: heal-partition }` | restore the network between every zone |

## Variants (hypotheses)

A variant is a full replacement spec or a list of edits applied to a base:

```yaml
- name: Go + cache
  changes:
    - { op: set, id: api, fields: { runtime: go, instances: 6 } }
    - { op: add, component: { id: redis, kind: cache, hitRate: 0.85 } }
    - { op: remove, id: old-thing }
    - { op: disconnect, from: api, to: db }
    - { op: connect, from: api, to: redis }
    - { op: connect, from: redis, to: db }
- name: something completely different
  spec: { components: […], connections: […] }
```

A variants file is either a list of variants or `{ variants: [...], scenario: {...} }`.

## Board ↔ spec

- `specToGraph` lays components out left-to-right by longest path from a traffic source and draws
  zone frames around their members.
- `graphToSpec` exports a board (only non-default fields), deriving zone membership from geometry.
  Round-trips are exact.

## Importing from Terraform

`npm run sim -- import-terraform plan-or-state.json --out arch.yaml` (MCP: `import_terraform`) turns
`terraform show -json` output into a spec priced with `aws-us-east-1`.

| Terraform | component |
|---|---|
| `aws_cloudfront_distribution` | cdn (origins resolved to ALBs / S3 buckets → storage) |
| `aws_lb` / `aws_alb` (internet-facing = entry point) | lb |
| `aws_apigatewayv2_api`, `aws_api_gateway_rest_api` | gateway |
| `aws_autoscaling_group` (+ launch template/config) | server ×desired_capacity, tier from instance type; GPU types → llm; `min_size < max_size` → `autoscale` (warm-up from `default_instance_warmup` / health-check grace) |
| `aws_ecs_service` | server ×desired_count |
| `aws_instance` | server (tier from type) or llm for GPU types |
| `aws_lambda_function` | function (runtime, reserved concurrency) |
| `aws_db_instance` (`replicate_source_db` → replica), `aws_rds_cluster` (+ instances → replicas) | db / replica |
| `aws_elasticache_replication_group` / `_cluster` | cache |
| `aws_sqs_queue` | queue |

Wiring from real references: CloudFront origins; ALB listener → target group → ASG / ECS service /
target-group attachments; API Gateway integrations → Lambda; Lambda event-source mappings → queue
consumers; RDS `replicate_source_db`. Heuristics (always reported in `assumptions`): users → public
entry points; entry points without explicit targets → all front-line compute; every service reads
through a single cache into the database(s) (cache-aside), otherwise calls them directly; queues are
produced by the web tier; default hit rates (CDN 60 %, cache 85 %). Size tiers: ≤ large = S, xlarge = M,
≥ 2xlarge = L. Terraform has no traffic or SLOs — supply them in the scenario.

## Importing from Kubernetes

`npm run sim -- import-k8s manifests.yaml [more.yaml …] --out arch.yaml` (MCP: `import_kubernetes`; in the
app, drop the YAML on the board) reads `kubectl get … -o yaml`, Helm template or kustomize output.

| Kubernetes | component |
|---|---|
| Deployment / StatefulSet / DaemonSet (replicas; DaemonSet = 3) | server ×replicas; image decides otherwise: postgres/mysql/mongo… → db (extra replicas → read replicas), redis/memcached/valkey → cache, rabbitmq/kafka/nats → queue, minio → storage, nginx/envoy/haproxy → lb, vllm/tgi/triton → llm |
| container CPU request | tier: ≤ 1 core S, ≤ 2 M, more L; image name → runtime (node, python, java, go, rust) |
| HorizontalPodAutoscaler | `autoscale` (min/max replicas, CPU target; pod warm-up 20 s, scale-in 300 s) |
| Ingress / HTTPRoute | entry lb → backend services; else LoadBalancer/NodePort Services; else the first server |
| Service | resolves names to workloads via selector |

Call edges come from Service names that appear in a container's env vars, args or command (e.g.
`DATABASE_URL=postgres://…@postgres:5432`). Workloads not reachable from an entry point that talk to a
broker become its consumers (workers). With one cache and a database, the cache is placed in front of
the database (cache-aside). All of these guesses are reported as `assumptions`.
