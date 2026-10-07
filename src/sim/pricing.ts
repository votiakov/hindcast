import type { Kind, Tier } from './catalog';

/**
 * Pricing profiles. "illustrative" is the teaching default (round numbers, a premium for vertical
 * scaling). Real profiles map every component to a concrete SKU or usage price with a source,
 * so a cost claim can be traced and challenged.
 */

export type PricingId = 'illustrative' | 'aws-us-east-1';

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
  region?: string;
  asOf?: string;
  kinds: Partial<Record<Kind, KindPricing>>;
}

const VANTAGE = (path: string) => `https://instances.vantage.sh/aws/${path}`;

export const PRICING: Record<PricingId, PricingProfile> = {
  illustrative: { id: 'illustrative', label: 'Illustrative (teaching defaults)', kinds: {} },
  'aws-us-east-1': {
    id: 'aws-us-east-1',
    label: 'AWS us-east-1, on-demand',
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
    },
  },
};

let active: PricingId = 'illustrative';

export const getPricing = (): PricingId => active;
export const setPricing = (id: PricingId) => {
  active = id;
};

/** run `fn` with a pricing profile active (headless runs carry their own) */
export function withPricing<T>(id: PricingId | undefined, fn: () => T): T {
  if (!id || id === active) return fn();
  const prev = active;
  active = id;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

export const kindPricing = (kind: Kind): KindPricing | undefined => PRICING[active].kinds[kind];
