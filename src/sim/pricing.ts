import type { Kind, Tier } from './catalog';

/**
 * Pricing profiles. "illustrative" is the teaching default (round numbers, a premium for vertical
 * scaling). Real profiles map every component to a concrete SKU or usage price with a source,
 * so a cost claim can be traced and challenged.
 */

export type PricingId = 'illustrative' | 'aws-us-east-1' | 'gcp-us-central1' | 'azure-eastus';

export interface SkuPrice {
  sku: string;
  /** $ per hour per instance */
  hourly: number;
}

export interface KindPricing {
  /** instance price per tier (S/M/L) */
  tiers?: Record<Tier, SkuPrice>;
  /** a single SKU regardless of tier */
  fixed?: SkuPrice;
  /** $ per request, with the assumption that turns the provider's unit into requests */
  perRequest?: { price: number; basis: string };
  source: string;
  note?: string;
}

export interface PricingProfile {
  id: PricingId;
  label: string;
  /** for compact pickers */
  short: string;
  region?: string;
  asOf?: string;
  kinds: Partial<Record<Kind, KindPricing>>;
}

const VANTAGE = (path: string) => `https://instances.vantage.sh/aws/${path}`;
/** every Azure price below is read from Microsoft's public Retail Prices API for East US */
const AZURE = 'https://prices.azure.com/api/retail/prices';

export const PRICING: Record<PricingId, PricingProfile> = {
  illustrative: { id: 'illustrative', label: 'Illustrative (teaching defaults)', short: 'Illustrative', kinds: {} },
  'aws-us-east-1': {
    id: 'aws-us-east-1',
    label: 'AWS us-east-1, on-demand',
    short: 'AWS us-east-1',
    region: 'us-east-1',
    asOf: '2026-10-02',
    kinds: {
      server: {
        tiers: { S: { sku: 'm7g.large', hourly: 0.0816 }, M: { sku: 'm7g.xlarge', hourly: 0.1632 }, L: { sku: 'm7g.2xlarge', hourly: 0.3264 } },
        source: VANTAGE('ec2/m7g.large'),
        note: 'EC2 Graviton3, Linux on-demand',
      },
      worker: {
        tiers: { S: { sku: 'm7g.large', hourly: 0.0816 }, M: { sku: 'm7g.xlarge', hourly: 0.1632 }, L: { sku: 'm7g.2xlarge', hourly: 0.3264 } },
        source: VANTAGE('ec2/m7g.large'),
      },
      db: {
        tiers: { S: { sku: 'db.r7g.large', hourly: 0.239 }, M: { sku: 'db.r7g.xlarge', hourly: 0.478 }, L: { sku: 'db.r7g.2xlarge', hourly: 0.956 } },
        source: VANTAGE('rds/db.r7g.large'),
        note: 'RDS PostgreSQL, single-AZ (Multi-AZ doubles it)',
      },
      replica: {
        tiers: { S: { sku: 'db.r7g.large', hourly: 0.239 }, M: { sku: 'db.r7g.xlarge', hourly: 0.478 }, L: { sku: 'db.r7g.2xlarge', hourly: 0.956 } },
        source: VANTAGE('rds/db.r7g.large'),
        note: 'RDS PostgreSQL read replica',
      },
      cache: {
        tiers: { S: { sku: 'cache.r7g.large', hourly: 0.219 }, M: { sku: 'cache.r7g.xlarge', hourly: 0.438 }, L: { sku: 'cache.r7g.2xlarge', hourly: 0.876 } },
        source: VANTAGE('elasticache/cache.r7g.large'),
        note: 'ElastiCache (Valkey/Redis), one node',
      },
      llm: {
        fixed: { sku: 'g6.xlarge (1× NVIDIA L4)', hourly: 0.8048 },
        source: VANTAGE('ec2/g6.xlarge'),
        note: 'one GPU instance; capacity assumes a small (7–8B) model',
      },
      lb: {
        fixed: { sku: 'ALB', hourly: 0.0225 },
        perRequest: { price: 0.008 / 100_000, basis: '$0.008 per LCU-hour; 1 LCU ≈ 1 GB/h processed ≈ 100k requests of ~10 KB' },
        source: 'https://cloudburn.io/blog/aws-elastic-load-balancing-pricing',
      },
      gateway: {
        perRequest: { price: 1.0 / 1_000_000, basis: 'API Gateway HTTP API, $1.00 per million (first 300M/month)' },
        source: 'https://cloudburn.io/blog/amazon-api-gateway-pricing',
      },
      cdn: {
        perRequest: { price: 1.0 / 1_000_000 + 0.085 * (10 / 1_048_576), basis: 'CloudFront: $0.01 per 10k HTTPS requests + $0.085/GB out, assuming ~10 KB per response' },
        source: 'https://aws.amazon.com/cloudfront/pricing/',
      },
      storage: {
        perRequest: { price: 0.4 / 1_000_000, basis: 'S3 Standard GET, $0.0004 per 1,000' },
        source: 'https://aws.amazon.com/s3/pricing/',
      },
      queue: {
        perRequest: { price: 1.2 / 1_000_000, basis: 'SQS standard $0.40 per million API calls × 3 (send, receive, delete) per message' },
        source: 'https://cloudburn.io/blog/amazon-sqs-pricing',
      },
      function: {
        perRequest: { price: 0.2 / 1_000_000, basis: 'Lambda $0.20 per million requests + $0.0000166667 per GB-second (memory × duration)' },
        source: 'https://aws.amazon.com/lambda/pricing/',
      },
      llmapi: {
        perRequest: { price: 0.15 / 1_000_000 * 1000 + 0.6 / 1_000_000 * 300, basis: 'GPT-4o-mini: $0.15 / $0.60 per million input / output tokens, ~1,000 in + 300 out per request' },
        source: 'https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini',
      },
      kv: {
        perRequest: { price: 0.45 / 1_000_000, basis: 'DynamoDB on demand: $0.25 per million reads, $1.25 per million writes, at 80% reads' },
        source: 'https://aws.amazon.com/dynamodb/pricing/on-demand/',
      },
      stream: {
        fixed: { sku: 'Kinesis Data Streams shard', hourly: 0.015 },
        perRequest: { price: 0.014 / 1_000_000, basis: '$0.014 per million PUT payload units (25 KB each)' },
        source: 'https://aws.amazon.com/kinesis/data-streams/pricing/',
        note: 'provisioned mode: one shard per partition (1,000 records/s in)',
      },
      search: {
        tiers: { S: { sku: 'r7g.large.search', hourly: 0.178 }, M: { sku: 'r7g.xlarge.search', hourly: 0.356 }, L: { sku: 'r7g.2xlarge.search', hourly: 0.712 } },
        source: VANTAGE('opensearch/r7g.large.search'),
        note: 'OpenSearch Service data node, per node; storage (EBS) and dedicated masters not included',
      },
      vector: {
        tiers: { S: { sku: 'r7g.large.search', hourly: 0.178 }, M: { sku: 'r7g.xlarge.search', hourly: 0.356 }, L: { sku: 'r7g.2xlarge.search', hourly: 0.712 } },
        source: VANTAGE('opensearch/r7g.large.search'),
        note: 'OpenSearch Service k-NN on a memory-optimised data node, per node',
      },
      dns: {
        fixed: { sku: 'Route 53 hosted zone', hourly: 0.5 / 730 },
        source: 'https://aws.amazon.com/route53/pricing/',
        note: 'queries ($0.40 per million) are not priced: resolvers cache answers for the TTL, so they scale with clients, not requests',
      },
    },
  },
  'gcp-us-central1': {
    id: 'gcp-us-central1',
    label: 'Google Cloud us-central1, on-demand',
    short: 'GCP us-central1',
    region: 'us-central1',
    asOf: '2026-10-07',
    kinds: {
      server: {
        tiers: { S: { sku: 'c4a-standard-2', hourly: 0.0898 }, M: { sku: 'c4a-standard-4', hourly: 0.1796 }, L: { sku: 'c4a-standard-8', hourly: 0.3592 } },
        source: 'https://gcloud-compute.com/c4a-standard-2.html',
        note: 'Compute Engine Axion (Arm), on-demand; priced per vCPU + GB, so sizes scale linearly',
      },
      worker: {
        tiers: { S: { sku: 'c4a-standard-2', hourly: 0.0898 }, M: { sku: 'c4a-standard-4', hourly: 0.1796 }, L: { sku: 'c4a-standard-8', hourly: 0.3592 } },
        source: 'https://gcloud-compute.com/c4a-standard-2.html',
      },
      db: {
        tiers: { S: { sku: 'Cloud SQL 2 vCPU / 16 GB', hourly: 0.1946 }, M: { sku: 'Cloud SQL 4 vCPU / 32 GB', hourly: 0.3892 }, L: { sku: 'Cloud SQL 8 vCPU / 64 GB', hourly: 0.7784 } },
        source: 'https://cloud.google.com/sql/pricing',
        note: 'Cloud SQL for PostgreSQL Enterprise: $0.0413 per vCPU-hour + $0.007 per GB-hour; HA doubles it',
      },
      replica: {
        tiers: { S: { sku: 'Cloud SQL replica 2 vCPU / 16 GB', hourly: 0.1946 }, M: { sku: 'Cloud SQL replica 4 vCPU / 32 GB', hourly: 0.3892 }, L: { sku: 'Cloud SQL replica 8 vCPU / 64 GB', hourly: 0.7784 } },
        source: 'https://cloud.google.com/sql/pricing',
      },
      cache: {
        tiers: { S: { sku: 'Memorystore Standard 5 GB', hourly: 0.27 }, M: { sku: 'Memorystore Standard 10 GB', hourly: 0.54 }, L: { sku: 'Memorystore Standard 26 GB', hourly: 1.196 } },
        source: 'https://cloud.google.com/memorystore/docs/redis/pricing',
        note: 'Memorystore for Redis, Standard (HA) tier: $0.054/GB-h (5–10 GB), $0.046/GB-h (11–35 GB)',
      },
      llm: {
        fixed: { sku: 'g2-standard-4 (1× NVIDIA L4)', hourly: 0.7068 },
        source: 'https://cloud.google.com/products/compute/pricing/accelerator-optimized',
        note: 'one GPU instance; capacity assumes a small (7–8B) model',
      },
      lb: {
        fixed: { sku: 'Application Load Balancer forwarding rule', hourly: 0.025 },
        perRequest: { price: 0.008 * (10 / 1_048_576), basis: '$0.008 per GB processed, assuming ~10 KB per request' },
        source: 'https://cloud.google.com/load-balancing/pricing',
      },
      gateway: {
        perRequest: { price: 3.0 / 1_000_000, basis: 'API Gateway $3.00 per million calls (2M–1B per month)' },
        source: 'https://cloud.google.com/api-gateway/pricing',
      },
      cdn: {
        perRequest: { price: 0.75 / 1_000_000 + 0.08 * (10 / 1_048_576), basis: 'Cloud CDN: $0.0075 per 10k cache lookups + ~$0.08/GB egress, assuming ~10 KB per response' },
        source: 'https://cloud.google.com/cdn/pricing',
      },
      storage: {
        perRequest: { price: 0.4 / 1_000_000, basis: 'Cloud Storage Standard class B operations, $0.0004 per 1,000' },
        source: 'https://cloud.google.com/storage/pricing',
      },
      queue: {
        perRequest: { price: 0.11 / 1_000_000, basis: 'Pub/Sub $40 per TiB, 1 KB minimum per publish / pull / ack (~3 KB per message)' },
        source: 'https://cloud.google.com/pubsub/pricing',
      },
      function: {
        perRequest: { price: 0.4 / 1_000_000, basis: 'Cloud Run $0.40 per million requests + $0.000024 per vCPU-second + $0.0000025 per GiB-second' },
        source: 'https://cloud.google.com/run/pricing',
      },
      llmapi: {
        perRequest: { price: 0.15 / 1_000_000 * 1000 + 0.6 / 1_000_000 * 300, basis: 'same hosted model as the AWS profile (GPT-4o-mini, ~1,000 in + 300 out tokens)' },
        source: 'https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini',
      },
      kv: {
        perRequest: { price: 0.84 / 1_000_000, basis: 'Firestore: $0.06 per 100k reads, $0.18 per 100k writes, at 80% reads' },
        source: 'https://cloud.google.com/firestore/pricing',
      },
      stream: {
        perRequest: { price: 0.11 / 1_000_000, basis: 'Pub/Sub topic + subscriptions, $40 per TiB (1 KB minimum per operation)' },
        source: 'https://cloud.google.com/pubsub/pricing',
        note: 'billed by throughput, not partitions',
      },
      search: {
        tiers: { S: { sku: 'n2-highmem-2', hourly: 0.131 }, M: { sku: 'n2-highmem-4', hourly: 0.262 }, L: { sku: 'n2-highmem-8', hourly: 0.524 } },
        source: 'https://gcloud-compute.com/n2-highmem-2.html',
        note: 'no managed OpenSearch on Google Cloud: OpenSearch/Elasticsearch run on Compute Engine, per node',
      },
      vector: {
        tiers: { S: { sku: 'n2-highmem-2', hourly: 0.131 }, M: { sku: 'n2-highmem-4', hourly: 0.262 }, L: { sku: 'n2-highmem-8', hourly: 0.524 } },
        source: 'https://gcloud-compute.com/n2-highmem-2.html',
        note: 'a vector database (OpenSearch k-NN, pgvector) self-run on Compute Engine, per node',
      },
      dns: {
        fixed: { sku: 'Cloud DNS managed zone', hourly: 0.2 / 730 },
        source: 'https://cloud.google.com/dns/pricing',
        note: 'queries are not priced: resolvers cache answers for the TTL',
      },
    },
  },
  'azure-eastus': {
    id: 'azure-eastus',
    label: 'Azure East US, pay as you go',
    short: 'Azure East US',
    region: 'eastus',
    asOf: '2026-10-15',
    kinds: {
      server: {
        tiers: { S: { sku: 'D2ps v6', hourly: 0.0702 }, M: { sku: 'D4ps v6', hourly: 0.14 }, L: { sku: 'D8ps v6', hourly: 0.281 } },
        source: AZURE,
        note: 'Cobalt 100 (Arm), Linux pay as you go',
      },
      worker: {
        tiers: { S: { sku: 'D2ps v6', hourly: 0.0702 }, M: { sku: 'D4ps v6', hourly: 0.14 }, L: { sku: 'D8ps v6', hourly: 0.281 } },
        source: AZURE,
      },
      db: {
        tiers: { S: { sku: 'PostgreSQL Flexible E2ds v5', hourly: 0.25 }, M: { sku: 'PostgreSQL Flexible E4ds v5', hourly: 0.5 }, L: { sku: 'PostgreSQL Flexible E8ds v5', hourly: 1.0 } },
        source: AZURE,
        note: 'Memory Optimized, 16 / 32 / 64 GB; zone-redundant HA doubles it',
      },
      replica: {
        tiers: { S: { sku: 'PostgreSQL read replica E2ds v5', hourly: 0.25 }, M: { sku: 'PostgreSQL read replica E4ds v5', hourly: 0.5 }, L: { sku: 'PostgreSQL read replica E8ds v5', hourly: 1.0 } },
        source: AZURE,
      },
      cache: {
        tiers: { S: { sku: 'Azure Cache for Redis Standard C3 (6 GB)', hourly: 0.45 }, M: { sku: 'Standard C4 (13 GB)', hourly: 0.525 }, L: { sku: 'Standard C5 (26 GB)', hourly: 1.05 } },
        source: AZURE,
        note: 'Standard tier: a primary and a replica',
      },
      llm: {
        fixed: { sku: 'NC4as T4 v3 (1× NVIDIA T4)', hourly: 0.526 },
        source: AZURE,
        note: 'one GPU instance; a T4, slower than the L4 the AWS and GCP profiles price',
      },
      lb: {
        fixed: { sku: 'Application Gateway Standard_v2', hourly: 0.2 },
        perRequest: { price: 0.008 / 100_000, basis: '$0.008 per capacity unit-hour, 1 CU ≈ 1 GB/h ≈ 100k × 10 KB requests' },
        source: AZURE,
      },
      gateway: {
        perRequest: { price: 3.5 / 1_000_000, basis: 'API Management Consumption, $0.035 per 10k calls after the first million' },
        source: AZURE,
      },
      cdn: {
        perRequest: { price: 0.9 / 1_000_000 + 0.0825 * (10 / 1_048_576), basis: 'Front Door Standard: $0.009 per 10k requests + $0.0825/GB, ~10 KB per response ($35/month base not included)' },
        source: 'https://egresscost.com/azure/front-door-pricing',
      },
      storage: {
        perRequest: { price: 0.4 / 1_000_000, basis: 'Blob Storage Hot LRS read operations, $0.004 per 10k' },
        source: AZURE,
      },
      queue: {
        perRequest: { price: 2.4 / 1_000_000, basis: 'Service Bus Standard, $0.80 per million operations × send + receive + complete' },
        source: AZURE,
      },
      function: {
        perRequest: { price: 0.2 / 1_000_000, basis: 'Functions Consumption $0.20 per million executions + $0.000016 per GB-s' },
        source: AZURE,
      },
      llmapi: {
        perRequest: { price: 0.15 / 1_000_000 * 1000 + 0.6 / 1_000_000 * 300, basis: 'same hosted model as the AWS profile (GPT-4o-mini, ~1,000 in + 300 out tokens)' },
        source: 'https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini',
      },
      kv: {
        perRequest: { price: 0.45 / 1_000_000, basis: 'Cosmos DB serverless, $0.25 per million RUs: 1 RU per 1 KB read, ~5 per write, at 80% reads' },
        source: AZURE,
      },
      stream: {
        fixed: { sku: 'Event Hubs Standard throughput unit', hourly: 0.03 },
        perRequest: { price: 0.028 / 1_000_000, basis: '$0.028 per million ingress events' },
        source: AZURE,
        note: 'one throughput unit per partition (1,000 events/s in)',
      },
      search: {
        tiers: { S: { sku: 'AI Search Basic', hourly: 0.101 }, M: { sku: 'AI Search Standard S1', hourly: 0.336 }, L: { sku: 'AI Search Standard S2', hourly: 1.344 } },
        source: AZURE,
        note: 'Azure AI Search, per search unit (replica × partition); S2 is about four S1s, so calibrate capacity',
      },
      vector: {
        tiers: { S: { sku: 'AI Search Basic', hourly: 0.101 }, M: { sku: 'AI Search Standard S1', hourly: 0.336 }, L: { sku: 'AI Search Standard S2', hourly: 1.344 } },
        source: AZURE,
        note: 'Azure AI Search vector indexes, per search unit; its vector quota per unit is not the memory model here, so calibrate',
      },
      dns: {
        fixed: { sku: 'Azure DNS zone', hourly: 0.5 / 730 },
        source: AZURE,
        note: 'queries are not priced: resolvers cache answers for the TTL',
      },
    },
  },
};

let active: PricingId = 'illustrative';
let commitment: Commitment = 'none';

export type Commitment = 'none' | '1y' | '3y';

export const getPricing = (): PricingId => active;
export const setPricing = (id: PricingId) => {
  active = id;
};
export const getCommitment = (): Commitment => commitment;
export const setCommitment = (c: Commitment) => {
  commitment = c;
};
/** the profile as the engine takes it: the id, and the commitment after an @ */
export const pricingProfile = (): string => (commitment === 'none' ? active : `${active}@${commitment}`);

/**
 * What a commitment takes off a fixed hourly price (usage prices are not discounted): published rates
 * for the profile's SKUs, no upfront where there is a choice; none where none is published. Mirrors
 * the engine's commitment_factor.
 */
export function commitmentFactor(kind: Kind, id: PricingId = active, c: Commitment = commitment): number {
  if (c === 'none') return 1;
  const three = c === '3y';
  const compute = kind === 'server' || kind === 'worker';
  const database = kind === 'db' || kind === 'replica';
  if (id === 'aws-us-east-1') return compute ? (three ? 0.45 : 0.66) : database ? 0.77 : kind === 'cache' ? (three ? 0.52 : 0.68) : 1;
  if (id === 'gcp-us-central1') return compute ? (three ? 0.45 : 0.63) : database ? (three ? 0.6 : 0.8) : 1;
  if (id === 'azure-eastus') return compute ? (three ? 0.38 : 0.59) : database ? (three ? 0.4 : 0.6) : 1;
  return 1;
}

/** where each commitment rate comes from, for the settings and the docs */
export const COMMITMENT_NOTE: Record<Exclude<PricingId, 'illustrative'>, string> = {
  'aws-us-east-1': 'EC2 reserved (m7g, no upfront) 34% / 55% off; RDS reserved 1 year 23% off (3 years needs upfront: 1-year rate kept); ElastiCache reserved 32% / 48% off',
  'gcp-us-central1': 'Compute Engine committed use 37% / 55% off; Cloud SQL committed use 20% / 40% off; Memorystore not discounted here',
  'azure-eastus': 'Reserved VM (D2ps v6) 41% / 62% off; PostgreSQL reserved capacity up to 40% / 60% off; Azure Cache for Redis Standard has no reservations',
};

export const kindPricing = (kind: Kind): KindPricing | undefined => PRICING[active].kinds[kind];
