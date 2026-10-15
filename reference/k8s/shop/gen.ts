/**
 * Writes reference/k8s/shop/shop.yaml: the OpenTelemetry Astronomy Shop (2.0.2) as plain Kubernetes
 * manifests, the way a team would run it — Deployments with CPU requests and limits, Services, an
 * Ingress through ingress-nginx, an OpenTelemetry Collector turning spans into RED metrics, and
 * Jaeger holding a 10% sample of traces. Same services, images and CPU limits as reference/shop
 * (Docker; memory limits are higher — Kubernetes counts page cache), except the frontend, which runs as 3 replicas: the over-provisioned starting point the
 * Kubernetes scenarios try to trim.
 *
 * Also writes the changes the scenarios test, as complete manifests (what a pull request would
 * leave in the repository): variants/frontend-2.yaml, frontend-1.yaml (fewer replicas) and
 * frontend-hpa.yaml (a HorizontalPodAutoscaler, 1–3 replicas at 60% CPU).
 *
 *   npx tsx reference/k8s/shop/gen.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const NS = 'shop';
const OTEL = {
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4317',
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
  OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_LOGS_EXPORTER: 'none',
  FLAGD_HOST: 'flagd',
  FLAGD_PORT: '8013',
};
const img = (s: string) => `ghcr.io/open-telemetry/demo:2.0.2-${s}`;

interface Svc {
  name: string;
  image: string;
  port: number;
  cpu: string;
  mem: string;
  replicas?: number;
  env?: Record<string, string>;
  args?: string[];
  mounts?: { name: string; path: string; configMap: string }[];
}

const services: Svc[] = [
  {
    name: 'frontend',
    image: img('frontend'),
    port: 8080,
    cpu: '500m',
    mem: '512Mi',
    replicas: 3,
    env: {
      ...OTEL,
      PORT: '8080',
      FRONTEND_ADDR: 'frontend:8080',
      AD_ADDR: 'ad:9555',
      CART_ADDR: 'cart:7070',
      CHECKOUT_ADDR: 'checkout:5050',
      CURRENCY_ADDR: 'currency:7001',
      PRODUCT_CATALOG_ADDR: 'product-catalog:3550',
      RECOMMENDATION_ADDR: 'recommendation:9001',
      SHIPPING_ADDR: 'shipping:50050',
      OTEL_SERVICE_NAME: 'frontend',
      ENV_PLATFORM: 'local',
      OTEL_COLLECTOR_HOST: 'otel-collector',
      PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:8080/otlp-http/v1/traces',
      WEB_OTEL_SERVICE_NAME: 'frontend-web',
    },
  },
  {
    name: 'ad',
    image: img('ad'),
    port: 9555,
    cpu: '500m',
    mem: '400Mi',
    env: {
      ...OTEL,
      AD_PORT: '9555',
      OTEL_SERVICE_NAME: 'ad',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      _JAVA_OPTIONS: '-XX:MaxRAMPercentage=70',
    },
  },
  {
    name: 'cart',
    image: img('cart'),
    port: 7070,
    cpu: '500m',
    mem: '200Mi',
    env: {
      ...OTEL,
      CART_PORT: '7070',
      VALKEY_ADDR: 'valkey-cart:6379',
      OTEL_SERVICE_NAME: 'cart',
      ASPNETCORE_URLS: 'http://*:7070',
    },
  },
  {
    name: 'checkout',
    image: img('checkout'),
    port: 5050,
    cpu: '250m',
    mem: '128Mi',
    env: {
      // Go's GC grows the heap to the limit and gets OOM-killed without a soft limit below it
      GOMEMLIMIT: '100MiB',
      ...OTEL,
      CHECKOUT_PORT: '5050',
      CART_ADDR: 'cart:7070',
      CURRENCY_ADDR: 'currency:7001',
      EMAIL_ADDR: 'http://email:6060',
      PAYMENT_ADDR: 'payment:50051',
      PRODUCT_CATALOG_ADDR: 'product-catalog:3550',
      SHIPPING_ADDR: 'shipping:50050',
      OTEL_SERVICE_NAME: 'checkout',
    },
  },
  {
    name: 'currency',
    image: img('currency'),
    port: 7001,
    cpu: '250m',
    mem: '128Mi',
    env: {
      CURRENCY_PORT: '7001',
      VERSION: '2.0.2',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4317',
      OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.name=currency',
    },
  },
  {
    name: 'email',
    image: img('email'),
    port: 6060,
    cpu: '250m',
    mem: '150Mi',
    env: {
      APP_ENV: 'production',
      EMAIL_PORT: '6060',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector:4318/v1/traces',
      OTEL_SERVICE_NAME: 'email',
    },
  },
  {
    name: 'payment',
    image: img('payment'),
    port: 50051,
    cpu: '250m',
    mem: '150Mi',
    env: { ...OTEL, PAYMENT_PORT: '50051', OTEL_SERVICE_NAME: 'payment' },
  },
  {
    name: 'product-catalog',
    image: img('product-catalog'),
    port: 3550,
    cpu: '250m',
    mem: '256Mi',
    env: {
      // Go's GC grows the heap to the limit and gets OOM-killed without a soft limit below it
      GOMEMLIMIT: '200MiB',
      ...OTEL,
      PRODUCT_CATALOG_PORT: '3550',
      PRODUCT_CATALOG_RELOAD_INTERVAL: '10',
      OTEL_SERVICE_NAME: 'product-catalog',
    },
    mounts: [
      {
        name: 'products',
        path: '/usr/src/app/products',
        configMap: 'products',
      },
    ],
  },
  {
    name: 'quote',
    image: img('quote'),
    port: 8090,
    cpu: '250m',
    mem: '128Mi',
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      OTEL_PHP_AUTOLOAD_ENABLED: 'true',
      QUOTE_PORT: '8090',
      OTEL_SERVICE_NAME: 'quote',
      OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo',
    },
  },
  {
    name: 'recommendation',
    image: img('recommendation'),
    port: 9001,
    cpu: '250m',
    mem: '128Mi',
    env: {
      ...OTEL,
      RECOMMENDATION_PORT: '9001',
      PRODUCT_CATALOG_ADDR: 'product-catalog:3550',
      OTEL_SERVICE_NAME: 'recommendation',
      PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python',
    },
  },
  {
    name: 'shipping',
    image: img('shipping'),
    port: 50050,
    cpu: '250m',
    mem: '128Mi',
    env: {
      SHIPPING_PORT: '50050',
      QUOTE_ADDR: 'http://quote:8090',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4317',
      OTEL_SERVICE_NAME: 'shipping',
      OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo',
    },
  },
  {
    name: 'flagd',
    image: 'ghcr.io/open-feature/flagd:v0.12.1',
    port: 8013,
    cpu: '250m',
    mem: '96Mi',
    args: ['start', '--uri', 'file:./etc/flagd/demo.flagd.json'],
    mounts: [{ name: 'flagd', path: '/etc/flagd', configMap: 'flagd' }],
  },
  {
    name: 'valkey-cart',
    image: 'valkey/valkey:8.1-alpine',
    port: 6379,
    cpu: '250m',
    mem: '128Mi',
  },
];

function manifests(o: { frontendReplicas: number; frontendCpu?: string; hpa?: { min: number; max: number; cpu: number }; emailMem?: string }): string {
  const docs: object[] = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } }];

  for (const s of services) {
    const labels = { app: s.name };
    docs.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: s.name, namespace: NS, labels },
      spec: {
        replicas: s.name === 'frontend' ? o.frontendReplicas : (s.replicas ?? 1),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            // Kubernetes would otherwise inject FLAGD_PORT=tcp://… (and the like) for every Service,
            // which the services read as their own settings
            enableServiceLinks: false,
            containers: [
              {
                name: s.name,
                image: s.image,
                ...(s.args ? { args: s.args } : {}),
                ports: [{ containerPort: s.port }],
                ...(s.env
                  ? {
                      env: Object.entries(s.env).map(([name, value]) => ({
                        name,
                        value,
                      })),
                    }
                  : {}),
                resources: {
                  requests: { cpu: (s.name === 'frontend' && o.frontendCpu) || s.cpu, memory: (s.name === 'email' && o.emailMem) || s.mem },
                  limits: { cpu: (s.name === 'frontend' && o.frontendCpu) || s.cpu, memory: (s.name === 'email' && o.emailMem) || s.mem },
                },
                ...(s.mounts
                  ? {
                      volumeMounts: s.mounts.map((m) => ({
                        name: m.name,
                        mountPath: m.path,
                        readOnly: true,
                      })),
                    }
                  : {}),
                // a new frontend replica joins the Service once Next.js listens. A TCP check, not
                // GET /: the page calls product-catalog, and a readiness check that depends on a
                // downstream service takes every replica out of rotation the moment it slows down
                ...(s.name === 'frontend' ? { readinessProbe: { tcpSocket: { port: s.port }, periodSeconds: 2, failureThreshold: 2 } } : {}),
              },
            ],
            ...(s.mounts
              ? {
                  volumes: s.mounts.map((m) => ({
                    name: m.name,
                    configMap: { name: m.configMap },
                  })),
                }
              : {}),
          },
        },
      },
    });
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: s.name, namespace: NS },
      spec: {
        selector: labels,
        ports: [
          {
            port: s.port,
            targetPort: s.port,
            name: s.name === 'frontend' ? 'http' : 'tcp',
          },
        ],
      },
    });
  }

  docs.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'frontend',
      namespace: NS,
      annotations: { 'nginx.ingress.kubernetes.io/proxy-read-timeout': '120' },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'frontend', port: { number: 8080 } },
                },
              },
            ],
          },
        },
      ],
    },
  });

  docs.push({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'products', namespace: NS },
    data: {
      'products.json': readFileSync(join(HERE, '../../shop/products/products.json'), 'utf8'),
    },
  });
  docs.push({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'flagd', namespace: NS },
    data: {
      'demo.flagd.json': readFileSync(join(HERE, '../../shop/flagd/demo.flagd.json'), 'utf8'),
    },
  });

  // the collector: every span → RED metrics (scraped by Prometheus); 10% of traces → Jaeger
  const collector = {
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: '0.0.0.0:4317' },
          http: { endpoint: '0.0.0.0:4318' },
        },
      },
    },
    processors: {
      batch: { timeout: '2s' },
      probabilistic_sampler: { sampling_percentage: 10 },
    },
    connectors: {
      spanmetrics: {
        histogram: {
          explicit: {
            buckets: ['2ms', '5ms', '10ms', '20ms', '30ms', '50ms', '75ms', '100ms', '150ms', '200ms', '300ms', '400ms', '500ms', '750ms', '1s', '1500ms', '2s', '3s', '5s', '10s', '30s'],
          },
        },
        dimensions: [{ name: 'http.route' }, { name: 'http.method' }],
        metrics_flush_interval: '5s',
      },
    },
    exporters: {
      'otlp/jaeger': { endpoint: 'jaeger:4317', tls: { insecure: true } },
      prometheus: { endpoint: '0.0.0.0:8889' },
      // the services' own OTLP metrics and logs are accepted and dropped: refused, their SDKs retry and buffer
      nop: {},
    },
    service: {
      pipelines: {
        traces: {
          receivers: ['otlp'],
          processors: ['batch'],
          exporters: ['spanmetrics'],
        },
        'traces/sampled': {
          receivers: ['otlp'],
          processors: ['probabilistic_sampler', 'batch'],
          exporters: ['otlp/jaeger'],
        },
        metrics: { receivers: ['spanmetrics'], exporters: ['prometheus'] },
        'metrics/apps': { receivers: ['otlp'], exporters: ['nop'] },
        // the C++ SDK (currency) retries refused log exports on new threads until its CPU limit is spent
        logs: { receivers: ['otlp'], exporters: ['nop'] },
      },
    },
  };
  docs.push({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'otel-collector', namespace: NS },
    data: { 'config.yaml': stringify(collector) },
  });
  const infra = (name: string, image: string, ports: { name: string; port: number }[], extra: object, res: object) => {
    docs.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: NS, labels: { app: name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name,
                image,
                ports: ports.map((p) => ({
                  name: p.name,
                  containerPort: p.port,
                })),
                resources: res,
                ...extra,
              },
            ],
            ...('volumes' in extra ? {} : {}),
          },
        },
      },
    });
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: NS, labels: { app: name } },
      spec: {
        selector: { app: name },
        ports: ports.map((p) => ({
          name: p.name,
          port: p.port,
          targetPort: p.port,
        })),
      },
    });
  };
  infra(
    'otel-collector',
    'otel/opentelemetry-collector-contrib:0.111.0',
    [
      { name: 'otlp-grpc', port: 4317 },
      { name: 'otlp-http', port: 4318 },
      { name: 'metrics', port: 8889 },
    ],
    {
      args: ['--config=/conf/config.yaml'],
      volumeMounts: [{ name: 'conf', mountPath: '/conf' }],
    },
    { requests: { cpu: '500m', memory: '256Mi' }, limits: { memory: '1Gi' } },
  );
  // the collector's pod needs its config volume
  const col = docs[docs.length - 2] as {
    spec: { template: { spec: { volumes?: object[] } } };
  };
  col.spec.template.spec.volumes = [{ name: 'conf', configMap: { name: 'otel-collector' } }];
  infra(
    'jaeger',
    'jaegertracing/all-in-one:1.62.0',
    [
      { name: 'otlp-grpc', port: 4317 },
      { name: 'query', port: 16686 },
    ],
    {
      // spans on disk (Badger), as a real Jaeger keeps them: an in-memory store runs out of memory on a busy day
      env: [
        { name: 'SPAN_STORAGE_TYPE', value: 'badger' },
        { name: 'BADGER_EPHEMERAL', value: 'false' },
        { name: 'BADGER_DIRECTORY_KEY', value: '/badger/key' },
        { name: 'BADGER_DIRECTORY_VALUE', value: '/badger/data' },
        { name: 'BADGER_SPAN_STORE_TTL', value: '168h' },
        { name: 'QUERY_BASE_PATH', value: '/jaeger' },
      ],
      volumeMounts: [{ name: 'badger', mountPath: '/badger' }],
    },
    { requests: { cpu: '200m', memory: '512Mi' }, limits: { memory: '2Gi' } },
  );
  const jg = docs[docs.length - 2] as { spec: { template: { spec: { volumes?: object[] } } } };
  jg.spec.template.spec.volumes = [{ name: 'badger', emptyDir: {} }];
  docs.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: 'jaeger', namespace: NS },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          http: {
            paths: [
              {
                path: '/jaeger',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'jaeger', port: { number: 16686 } },
                },
              },
            ],
          },
        },
      ],
    },
  });
  // Prometheus (kube-prometheus-stack) scrapes the collector's span metrics
  docs.push({
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'ServiceMonitor',
    metadata: { name: 'otel-collector', namespace: NS },
    spec: {
      selector: { matchLabels: { app: 'otel-collector' } },
      endpoints: [{ port: 'metrics', interval: '15s' }],
    },
  });

  if (o.hpa)
    docs.push({
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'frontend', namespace: NS },
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'frontend',
        },
        minReplicas: o.hpa.min,
        maxReplicas: o.hpa.max,
        metrics: [
          {
            type: 'Resource',
            resource: {
              name: 'cpu',
              target: { type: 'Utilization', averageUtilization: o.hpa.cpu },
            },
          },
        ],
      },
    });
  return `# generated by gen.ts — edit that, not this\n${docs.map((d) => stringify(d)).join('---\n')}`;
}

const as = services.find((s) => s.name === 'frontend')!.replicas!;
writeFileSync(join(HERE, 'shop.yaml'), manifests({ frontendReplicas: as }));
mkdirSync(join(HERE, 'variants'), { recursive: true });
writeFileSync(join(HERE, 'variants', 'frontend-2.yaml'), manifests({ frontendReplicas: 2 }));
writeFileSync(join(HERE, 'variants', 'frontend-1.yaml'), manifests({ frontendReplicas: 1 }));
writeFileSync(join(HERE, 'variants', 'frontend-hpa.yaml'), manifests({ frontendReplicas: 1, hpa: { min: 1, max: 3, cpu: 60 } }));
// out of sample: added after the throttle model was designed on the runs above, predicted before they ran
writeFileSync(join(HERE, 'variants', 'frontend-2-1cpu.yaml'), manifests({ frontendReplicas: 2, frontendCpu: '1' }));
writeFileSync(join(HERE, 'variants', 'frontend-1-1cpu.yaml'), manifests({ frontendReplicas: 1, frontendCpu: '1' }));
writeFileSync(join(HERE, 'variants', 'frontend-1-750m.yaml'), manifests({ frontendReplicas: 1, frontendCpu: '750m' }));
// out of sample, second round: scale out, an autoscaler with headroom, a limit between the two seen
writeFileSync(join(HERE, 'variants', 'frontend-4.yaml'), manifests({ frontendReplicas: 4 }));
writeFileSync(join(HERE, 'variants', 'frontend-hpa-2-5.yaml'), manifests({ frontendReplicas: 2, hpa: { min: 2, max: 5, cpu: 50 } }));
writeFileSync(join(HERE, 'variants', 'frontend-2-750m.yaml'), manifests({ frontendReplicas: 2, frontendCpu: '750m' }));
// out of sample, third round: the memory leak — email with twice the memory
writeFileSync(join(HERE, 'variants', 'email-300mi.yaml'), manifests({ frontendReplicas: 3, emailMem: '300Mi' }));
console.log('wrote shop.yaml and 10 variants');
