# Component catalog

Defaults from `engine-rs/src/sim/catalog.rs` (the engine; `src/sim/catalog.ts` mirrors it for the UI). All numbers are illustrative — they make tradeoffs visible
in the right direction and magnitude; override `capacity`, `latencyMs` and `costPerHour` per
component to calibrate to a real system. `npm run sim -- catalog` prints the live values.

| kind | label | capacity (size S, per instance) | base latency | price | sizable | instances | notes |
|---|---|---|---|---|---|---|---|
| `client` | Users | — | — | — | | | traffic source; can retry, time out, break |
| `cdn` | CDN | 100,000 req/s | 5 ms | $0.08/h | | | default hit rate 60 %; misses go to origin |
| `lb` | Load Balancer | 20,000 req/s | 1 ms | $0.05/h | ✓ | | routes to healthy children; makes instances reachable |
| `gateway` | API Gateway | rate limit (default 1,500 req/s) | 3 ms | $0.08/h | | | 429s above the limit; makes instances reachable |
| `server` | API Server | 250 req/s | 25 ms | $0.10/h | ✓ | ✓ | runtime-aware |
| `worker` | Worker | 100 req/s | 80 ms | $0.08/h | ✓ | ✓ | background jobs; runtime-aware |
| `function` | Serverless Fn | concurrency limit (default 3,000) | 35 ms | $0.60 / 1M req | | | cold starts; runtime-aware pricing |
| `cache` | Cache | 20,000 req/s | 1 ms | $0.15/h | ✓ | | default hit rate 85 % |
| `db` | Database | 1,000 req/s | 10 ms | $0.40/h | ✓ | | writes stay here; reads shared with replicas; failover; `shards` × capacity and cost |
| `replica` | Read Replica | 1,000 req/s | 10 ms | $0.35/h | ✓ | | connect from a db |
| `storage` | Object Storage | 55,000 req/s | 40 ms | $0.03/h | | | |
| `queue` | Queue | 50,000 req/s ingest | 3 ms ack | $0.06/h | | | backlog ≤ 200,000; consumers pull |
| `llm` | GPU Inference | 6 req/s per GPU | 800 ms | $4.00/h per GPU | | ✓ | batching ×4 capacity, +400 ms; queue 3 s |
| `llmapi` | LLM Provider API | rate limit (default 100 req/s) | 1,500 ms | $0.002 / request | | | latency independent of your load |
| `stream` | Stream | 1,000 msg/s per partition (default 4) | 5 ms ack | $0.015/h per partition | | | pub/sub log: every subscriber reads every message with its own backlog; a subscriber runs at most one consumer per partition; past retention (200,000 behind) the oldest expire unread |
| `dns` | DNS | — (cached everywhere) | 1 ms | ~$0 | | | health-checked answers (`routing: failover` or an even split); a dead target keeps getting traffic for `healthCheckS` (30 s), then less as cached answers expire over `ttlS` (60 s) |
| `kv` | Key-Value Store | table limit (default 40,000 req/s) | 5 ms | $0.45 / 1M req | | | managed NoSQL on demand; one partition takes 3,000 reads or 1,000 writes a second — a hot key throttles (reads take the partition first) |
| `edge` | Edge Function | 100,000 req/s | 2 ms + `cpuMs` | $0.30 / 1M req + $0.02 / 1M CPU-ms | | | CloudFront Functions, Cloudflare Workers: runs on every request before the origin and answers `edgeShare` (default 0.5) of them itself, reads and writes alike; CPU time per request is exponential around `cpuMs` (default 1), and the share past `cpuLimitMs` (default 10, as Workers Free; ~1 for CloudFront Functions, 30,000 for Workers paid) is killed. Priced as [Workers Standard](https://developers.cloudflare.com/workers/platform/pricing/) unless the profile has an edge price; `aws-us-east-1`: [CloudFront Functions](https://aws.amazon.com/cloudfront/pricing/) $0.10 per million invocations; GCP and Azure have no first-party edge functions |
| `archive` | Archive Storage | 5,500 reads/s (instant) or 1,000 restores/s | 40 ms · 1–5 min · 3–5 h | $0.004/GB-month + per read | | | S3 Glacier: `retrieval: instant` (Instant Retrieval, answers like S3), `expedited` or `standard` (a Flexible Retrieval restore). Limits: S3's 5,500 GETs/s per prefix, [1,000 restore requests/s per account](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html). Priced as S3 Glacier us-east-1 under every profile ([S3 pricing](https://aws.amazon.com/s3/pricing/)): per read of a 1 MB object $0.01/1,000 + $0.03/GB (instant), $10/1,000 + $0.03/GB (expedited), $0.05/1,000 + $0.01/GB (standard), billed when requested; holding `workingSetGb` (default 1,000 GB) at $0.004 (instant) or $0.0036 per GB-month |
| `search` | Search Index | 200 queries/s per data node | 20 ms | $0.20/h per node | ✓ | ✓ | OpenSearch/Elasticsearch: the nodes share the queries themselves (no lb needed); a write is searchable after the indexing backlog ahead of it and the next refresh (`refreshS`, default 1 s) — searches in that window miss it (counted as stale reads when more than a second behind). 200/s: a 2-vCPU node's search pool of vCPU × 1.5 + 1 = 4 threads at ~20 ms a query |
| `vector` | Vector Database | 300 queries/s per data node at recall 0.95 | 10 ms | $0.20/h per node | ✓ | ✓ | OpenSearch k-NN, pgvector: an HNSW graph over its nodes (no lb needed). Work per query × 0.05 ÷ (1 − `recall`): 0.99 costs 5× 0.95, close to the curve measured for pgvector HNSW ([Alibaba Cloud's test](https://help.aliyun.com/en/rds/apsaradb-rds-for-postgresql/pgvector-performance-test-based-on-hnsw-indexes): 1,635 q/s at 97% recall, 435 at 99.3% — 3.8×, the rule says 4.3×). The graph takes 3.52 GB per million 768-dimension vectors (`vectorsM`; 1.1 × (4·d + 8·M) bytes, the OpenSearch k-NN sizing formula); nodes keep a quarter of RAM for it (4 / 8 / 16 GB by size); the share that does not fit is read from disk at 10× the cost (illustrative) |
| `external` | External API | rate limit (default 1,000 req/s) | 200 ms | — | | | someone else's service (payments, partners, the web a crawler fetches): only its limit, latency and errors are yours to live with |

## Tiers

| tier | capacity | cost |
|---|---|---|
| S | ×1 | ×1 |
| M | ×2 | ×2.2 |
| L | ×4 | ×4.8 |

Vertical scaling gets more expensive per unit of capacity on purpose — it is the classic tradeoff.

## Language runtimes

Relative to Node.js, for a typical JSON-over-HTTP service (CPU-heavier code gains more, I/O-bound
code far less):

| runtime | throughput | latency | cold start | serverless memory |
|---|---|---|---|---|
| Node.js | ×1 | ×1 | 250 ms | 256 MB |
| Python | ×0.45 | ×1.6 | 350 ms | 256 MB |
| Java | ×1.5 | ×0.8 | 1,800 ms | 512 MB |
| Go | ×2.5 | ×0.5 | 80 ms | 128 MB |
| Rust | ×3.5 | ×0.35 | 40 ms | 128 MB |

With a runtime set, serverless price = $0.20 / 1M requests + $0.0000166667 per GB-second
(memory × duration), i.e. Lambda-like.

## Pricing profiles

Costs follow the active **pricing profile** (Settings → Pricing in the app, `pricing:` at the root of
a spec for the CLI/MCP). `illustrative` is the teaching default above; `aws-us-east-1`,
`gcp-us-central1` and `azure-eastus` are cited real-cloud profiles. `aws-us-east-1` prices every
component as a concrete SKU or usage line, on-demand, checked 2026-10-02:

| component | S / M / L (or unit) | price | source / assumption |
|---|---|---|---|
| server, worker | m7g.large / .xlarge / .2xlarge | $0.0816 / $0.1632 / $0.3264 per hour | [Vantage: m7g](https://instances.vantage.sh/aws/ec2/m7g.large), EC2 Graviton3 Linux |
| db, replica | db.r7g.large / .xlarge / .2xlarge | $0.239 / $0.478 / $0.956 per hour | [Vantage: db.r7g](https://instances.vantage.sh/aws/rds/db.r7g.large), RDS PostgreSQL single-AZ (Multi-AZ ×2) |
| cache | cache.r7g.large / .xlarge / .2xlarge | $0.219 / $0.438 / $0.876 per hour | [Vantage: cache.r7g](https://instances.vantage.sh/aws/elasticache/cache.r7g.large), one node |
| llm | g6.xlarge (1× NVIDIA L4) | $0.8048 per GPU-hour | [Vantage: g6](https://instances.vantage.sh/aws/ec2/g6.xlarge); capacity assumes a 7–8B model |
| lb | ALB | $0.0225/h + $0.08 per million requests | [ALB pricing](https://cloudburn.io/blog/aws-elastic-load-balancing-pricing): $0.008/LCU-h, 1 LCU ≈ 1 GB/h ≈ 100k × 10 KB requests |
| gateway | API Gateway HTTP API | $1.00 per million | [API Gateway pricing](https://cloudburn.io/blog/amazon-api-gateway-pricing), first 300M/month |
| cdn | CloudFront | ≈ $1.81 per million | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/): $0.01/10k HTTPS requests + $0.085/GB, ~10 KB/response |
| storage | S3 Standard GET | $0.40 per million | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| queue | SQS standard | $1.20 per million messages | [SQS pricing](https://cloudburn.io/blog/amazon-sqs-pricing): $0.40/M calls × send+receive+delete |
| function | Lambda | $0.20/M + $0.0000166667 per GB-s | [Lambda pricing](https://aws.amazon.com/lambda/pricing/); memory from the runtime profile |
| llmapi | GPT-4o-mini-class API | ≈ $0.00033 per request | [token prices](https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini): $0.15/$0.60 per M tokens, ~1,000 in + 300 out |
| edge | CloudFront Functions | $0.10 per million invocations | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/); CPU is capped, not billed |
| search, vector | r7g.large / .xlarge / .2xlarge.search | $0.178 / $0.356 / $0.712 per node-hour | [Vantage: r7g.large.search](https://instances.vantage.sh/aws/opensearch/r7g.large.search), OpenSearch Service data node; EBS and dedicated masters not included |

`gcp-us-central1` (checked 2026-10-07):

| component | S / M / L (or unit) | price | source / assumption |
|---|---|---|---|
| server, worker | c4a-standard-2 / -4 / -8 | $0.0898 / $0.1796 / $0.3592 per hour | [gcloud-compute.com: c4a](https://gcloud-compute.com/c4a-standard-2.html), Axion (Arm), linear per vCPU + GB |
| db, replica | Cloud SQL 2/4/8 vCPU, 16/32/64 GB | $0.1946 / $0.3892 / $0.7784 per hour | [Cloud SQL pricing](https://cloud.google.com/sql/pricing): Enterprise, $0.0413/vCPU-h + $0.007/GB-h; HA ×2 |
| cache | Memorystore Standard 5 / 10 / 26 GB | $0.27 / $0.54 / $1.196 per hour | [Memorystore pricing](https://cloud.google.com/memorystore/docs/redis/pricing): $0.054/GB-h (M2), $0.046/GB-h (M3) |
| llm | g2-standard-4 (1× NVIDIA L4) | $0.7068 per GPU-hour | [accelerator pricing](https://cloud.google.com/products/compute/pricing/accelerator-optimized) |
| lb | Application Load Balancer | $0.025/h + $0.008/GB processed | [Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing), ~10 KB per request |
| gateway | API Gateway | $3.00 per million | [API Gateway pricing](https://cloud.google.com/api-gateway/pricing) |
| cdn | Cloud CDN | ≈ $1.51 per million | [Cloud CDN pricing](https://cloud.google.com/cdn/pricing): $0.0075/10k lookups + ~$0.08/GB, ~10 KB/response |
| storage | Cloud Storage class B ops | $0.40 per million | [Cloud Storage pricing](https://cloud.google.com/storage/pricing) |
| queue | Pub/Sub | ≈ $0.11 per million messages | [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing): $40/TiB, 1 KB minimum × publish/pull/ack |
| function | Cloud Run | $0.40/M requests (+ compute, approximated Lambda-like) | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| llmapi | same hosted model as AWS | ≈ $0.00033 per request | provider prices don't depend on your cloud |
| search, vector | n2-highmem-2 / -4 / -8 | $0.131 / $0.262 / $0.524 per node-hour | [gcloud-compute.com: n2-highmem-2](https://gcloud-compute.com/n2-highmem-2.html); no managed OpenSearch on Google Cloud, so self-run on Compute Engine |

`azure-eastus` (checked 2026-10-15; every line read from Microsoft's
[Retail Prices API](https://prices.azure.com/api/retail/prices) for East US, pay as you go, unless noted):

| component | S / M / L (or unit) | price | source / assumption |
|---|---|---|---|
| server, worker | D2ps v6 / D4ps v6 / D8ps v6 | $0.0702 / $0.14 / $0.281 per hour | Cobalt 100 (Arm), Linux |
| db, replica | PostgreSQL Flexible E2ds / E4ds / E8ds v5 | $0.25 / $0.50 / $1.00 per hour | Memory Optimized, 16 / 32 / 64 GB; zone-redundant HA ×2 |
| cache | Redis Standard C3 / C4 / C5 (6 / 13 / 26 GB) | $0.45 / $0.525 / $1.05 per hour | Standard tier: a primary and a replica |
| llm | NC4as T4 v3 (1× NVIDIA T4) | $0.526 per GPU-hour | a T4, slower than the L4 the other profiles price |
| lb | Application Gateway Standard_v2 | $0.20/h + $0.008 per capacity unit-hour | 1 CU ≈ 1 GB/h ≈ 100k × 10 KB requests |
| gateway | API Management Consumption | $3.50 per million | after the first million a month |
| cdn | Front Door Standard | ≈ $1.69 per million | $0.009/10k requests + $0.0825/GB, ~10 KB/response ([egresscost](https://egresscost.com/azure/front-door-pricing)); $35/month base not included |
| storage | Blob Hot LRS reads | $0.40 per million | $0.004 per 10k |
| queue | Service Bus Standard | $2.40 per million messages | $0.80/M operations × send + receive + complete |
| function | Functions Consumption | $0.20/M + $0.000016 per GB-s | |
| kv | Cosmos DB serverless | $0.45 per million | $0.25/M RUs; 1 RU a 1 KB read, ~5 a write, 80% reads |
| stream | Event Hubs Standard | $0.03 per throughput unit-hour + $0.028/M events | one TU (1,000 events/s in) per partition |
| dns | Azure DNS zone | $0.50 per month | queries not priced: resolvers cache answers for the TTL |
| search, vector | AI Search Basic / Standard S1 / Standard S2 | $0.101 / $0.336 / $1.344 per search unit-hour | S2 is about four S1s, not two: calibrate `capacity` |

Streams and DNS in the other clouds: Kinesis at $0.015 per shard-hour + $0.014 per million records
(AWS), Pub/Sub by throughput (GCP); a hosted zone at $0.50 (Route 53) or $0.20 (Cloud DNS) a month.

**Commitments** (Settings → Pricing, or `commitment: 1y | 3y` next to `pricing:` in a spec) take
the published rate off what can be reserved, no upfront where there is a choice; usage prices are
not discounted, and a component without a published rate stays on-demand:

| profile | servers, workers | databases, replicas | cache |
|---|---|---|---|
| `aws-us-east-1` | EC2 reserved (m7g): −34% / −55% ([Vantage](https://instances.vantage.sh/aws/ec2/m7g.large)) | RDS reserved 1 year: −23%; 3 years needs upfront, so the 1-year rate is kept ([Vantage](https://instances.vantage.sh/aws/rds/db.r7g.large)) | ElastiCache reserved: −32% / −48% ([Vantage](https://instances.vantage.sh/aws/elasticache/cache.r7g.large)) |
| `gcp-us-central1` | committed use: −37% / −55% | Cloud SQL committed use: −20% / −40% | not discounted |
| `azure-eastus` | reserved VM (D2ps v6, Retail Prices API): −41% / −62% | PostgreSQL reserved capacity: up to −40% / −60% | Redis Standard has no reservations |

Under a real profile, size tiers are priced as the actual SKUs (cloud instance prices are linear, so
the illustrative vertical-scaling premium disappears), and nodes show their SKU next to the price.
Capacities stay workload-dependent: set `capacity` per component from your own load tests or
metrics. Free tiers, data transfer between AZs (the backtest prices it; the simulator doesn't) and storage
GB (except `archive`) are not included; 1- and 3-year commitments are a setting (above). A `costPerHour` override on a component always wins over the profile.

## Engine-wide defaults

| setting | default | where |
|---|---|---|
| bounded queue | 1 s of work | Settings → Request timeout; per node `queueS` |
| database failover | 60 s | per database `failoverS`; Settings → Automatic DB failover turns it off |
| cold start | 400 ms (runtime-specific when set) | Settings → Serverless cold starts |
| breaker | trip > 50 % failures, open 5 s, close < 10 % | engine constants |
| retry budget | ≤ 10 % extra calls | engine constants |
| bulkhead wait | 0: a call past the bulkhead fails at once, as [Resilience4j's `maxWaitDuration`](https://resilience4j.readme.io/docs/bulkhead) defaults to 0. A connection pool waits instead: [HikariCP's `connectionTimeout`](https://github.com/brettwooldridge/HikariCP) defaults to 30,000 ms | per caller `bulkheadWaitMs` |
| priority | none: every request critical, nothing reserved. A reserve is the share of capacity kept for critical work, as in Google's SRE book ([Handling Overload: criticality](https://sre.google/sre-book/handling-overload/)) | per client `lowPriorityShare`, per component `priorityReserve` |
| outlier ejection | off. With `ejectAfter`: [Envoy's outlier detection](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/outlier_detection.proto) defaults — `consecutive_5xx` 5, `base_ejection_time` 30 s, `max_ejection_percent` 10%. Envoy ejects only while (ejected + 1) ÷ hosts ≤ that percent ([its check](https://github.com/envoyproxy/envoy/blob/main/source/common/upstream/outlier_detection_impl.cc)), so at 10% nothing is ejected below 10 instances unless `always_eject_one_host` is set; raise `maxEjectedPercent` for small fleets (25 lets one of 4 go). Envoy also multiplies the ejection time by the times a host was ejected (up to 300 s); Hindcast keeps it at `ejectForS` | per component `ejectAfter`, `ejectForS`, `maxEjectedPercent` |

## Where the audit's numbers come from

The failure audit's answers rest on these constants. **Cited** values come from the source named;
**guess** marks a teaching default that no measurement backs: override it in the spec when you know
better.

| constant | value | source |
|---|---|---|
| database failover (`failoverS`) | 60 s | cited, the managed-HA middle: [RDS Multi-AZ instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html) "typically 60–120 seconds"; [Cloud SQL HA](https://docs.cloud.google.com/sql/docs/postgres/high-availability) "about sixty seconds"; [Azure Database for PostgreSQL, zone-redundant HA](https://learn.microsoft.com/en-us/azure/reliability/reliability-postgresql-flexible-server) "typically within 60-120 seconds". Faster: [Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html) "less than 60 seconds, and often less than 30", an [RDS Multi-AZ DB cluster](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html) "typically under 35 seconds" — set `failoverS: 30` for those |
| failover with no automatic election | 1,800 s | guess: someone is paged and promotes a replica by hand. The Kubernetes import sets it for a Postgres or MySQL StatefulSet with more than one pod and no CloudNativePG, Patroni, Zalando or Crunchy operator |
| circuit breaker | trips past 50 % failures held for 1 s, open 5 s, closes under 10 % | 50 % and 5 s are [Hystrix's defaults](https://github.com/Netflix/Hystrix/wiki/Configuration) (`errorThresholdPercentage`, `sleepWindowInMilliseconds`); the 1 s window (Hystrix: a 10 s rolling window) and the 10 % to close are guesses |
| retry budget (`retryPolicy: budget`) | ≤ 10 % extra calls | cited: [Google SRE book, Handling Overload](https://sre.google/sre-book/handling-overload/) (a per-client retry budget of 10 %) |
| retry backoff | 50 ms × 2ᵏ before retry k + 1, at most 2 s, jittered ×0.5–1.5; every failed attempt is still retried | guess |
| cold start | 400 ms generic; by runtime 40 ms (Rust) to 1,800 ms (Java) | guess, in the order public Lambda cold-start measurements put them; not fitted |
| service-time spread (DES `serviceCv`) | 0.6, lognormal | guess, between deterministic (0) and exponential (1); the fluid engine's p99 factor (3.11) and queueing scale (0.68) follow from it analytically |
| cache hit rate on import | 85 % (cache), 60 % (CDN) | guess; the importers list it among their assumptions. Set `hitRate` from CacheHits / (CacheHits + CacheMisses) |
| HPA pod warm-up on import | 20 s (+60–120 s if a node must be added) | guess. The 300 s scale-in delay is cited: the [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#stabilization-window) default stabilization window |
| autoscaling defaults | target 60 %, warm-up 30 s, scale-in cooldown 60 s; the audit's autoscale fix uses a 15 s warm-up | guess |
| runtime multipliers | throughput ×0.45 (Python) to ×3.5 (Rust), latency ×1.6 to ×0.35 | guess: rough orders for JSON over HTTP from public framework benchmarks, not fitted. I/O-bound services differ far less |
| DNS health checks | `healthCheckS` 30 s, `ttlS` 60 s | guess. Route 53's default checks (30 s interval × 3 failures) take about 90 s to notice; 30 s needs fast (10 s) checks |
| per-unit availability | one VM or single-AZ database 99.5 %, load balancer 99.99 %, DNS 100 % … | cited: each managed service's published SLA (EC2, ELB, Route 53 …). An SLA is a refund promise, not a measured uptime, and the audit labels it "SLA (published), not measured" |
| a provider-wide DNS outage | offered as an incident, with no fix | the audit replays it ([Dyn, October 2016](https://en.wikipedia.org/wiki/2016_Dyn_cyberattack), hours) and names the remedy, a second DNS provider, without pricing it; a "standby DNS" component is not offered |
| audit timeline | fault at 10 s, cleared at 40 s; "turns slow" adds 250 ms | guess. On a server or worker "turns slow" is time spent waiting: it holds no worker, so one without `threads` (async: Node, Go, Envoy) keeps serving, 250 ms slower; with `threads` each request holds its thread 250 ms longer, and the pool finishes at most threads ÷ time held a second (Little's law). On any other kind (a database, a cache, a search cluster…) it is work: each worker is busy 250 ms longer, so a component with 10–25 ms of work loses over 90 % of its throughput. A caller with `threads` holds a thread through its calls either way. The audit says which applies |
| fluid smoothing | τ 0.3 s per component | an engine time constant. The users see the chain of them, so a cleared fault fades over 3–4 s even when nothing lingers (the discrete-event engine recovers at once). The audit measures that fade on a bare chain of the same depth and reports recovery and self-healing net of it |
