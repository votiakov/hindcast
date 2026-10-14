# Component catalog

Defaults from `src/sim/catalog.ts`. All numbers are illustrative — they make tradeoffs visible
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
| `storage` | Object Storage | 50,000 req/s | 40 ms | $0.03/h | | | |
| `queue` | Queue | 50,000 req/s ingest | 3 ms ack | $0.06/h | | | backlog ≤ 200,000; consumers pull |
| `llm` | GPU Inference | 6 req/s per GPU | 800 ms | $4.00/h per GPU | | ✓ | batching ×4 capacity, +400 ms; queue 3 s |
| `llmapi` | LLM Provider API | rate limit (default 100 req/s) | 1,500 ms | $0.002 / request | | | latency independent of your load |
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
a spec for the CLI/MCP). `illustrative` is the teaching default above; `aws-us-east-1` and
`gcp-us-central1` are cited real-cloud profiles. `aws-us-east-1` prices every
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

Under a real profile, size tiers are priced as the actual SKUs (cloud instance prices are linear, so
the illustrative vertical-scaling premium disappears), and nodes show their SKU next to the price.
Capacities stay workload-dependent: set `capacity` per component from your own load tests or
metrics. Free tiers, savings plans, reserved instances, data transfer between AZs and storage GB are
not included. A `costPerHour` override on a component always wins over the profile.

## Engine-wide defaults

| setting | default | where |
|---|---|---|
| bounded queue | 1 s of work | Settings → Request timeout; per node `queueS` |
| failover election | 3 s | Settings → Failover time |
| cold start | 400 ms (runtime-specific when set) | Settings → Serverless cold starts |
| breaker | trip > 50 % failures, open 5 s, close < 10 % | engine constants |
| retry budget | ≤ 10 % extra calls | engine constants |
