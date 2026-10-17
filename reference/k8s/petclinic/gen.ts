/**
 * Writes reference/k8s/petclinic/petclinic.yaml: Spring PetClinic Microservices (3.4.1, the
 * project's multi-arch images) as plain Kubernetes manifests — the second Kubernetes reference
 * system, built differently from the Astronomy Shop on purpose:
 *
 *   - JVMs (Spring Boot 3, Java 17+), not nine languages; JIT warm-up, garbage collection, a heap
 *   - a reactive edge (Spring Cloud Gateway on Netty, with a Resilience4j circuit breaker and a
 *     retry on every route), in front of thread-per-request services (Tomcat, 200 threads, a
 *     10-connection Hikari pool to an embedded HSQLDB each), over HTTP/JSON, not gRPC
 *   - an aggregating endpoint: GET /api/gateway/owners/{id} calls customers-service, then
 *     visits-service, inside a circuit breaker
 *
 * Instrumented with the OpenTelemetry Java agent (zero code; copied in by an init container), which
 * sends spans to the shop namespace's collector: the same span metrics, Prometheus and Jaeger.
 *
 * As built, the project discovers services through Eureka and reads its settings from a Spring Cloud
 * Config server backed by a git repository. Here, as on many Kubernetes moves, Service DNS replaces
 * Eureka (Spring Cloud's simple discovery client, one URI per service; kube-proxy spreads the
 * connections over the replicas) and a ConfigMap replaces the config server: the settings below are
 * the config repository's (spring-petclinic-microservices-config, main), minus Eureka and Zipkin.
 *
 * Also writes the changes the questions test, as complete manifests (what a pull request would leave
 * in the repository), into variants/.
 *
 *   npx tsx reference/k8s/petclinic/gen.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const NS = 'petclinic';
// pinned by digest: the 3.4.1 tag's multi-arch index (amd64 + arm64)
const IMAGES: Record<string, string> = {
  'api-gateway': 'springcommunity/spring-petclinic-api-gateway:3.4.1@sha256:250c96946936d623d4ded3e1987fd76d61a66a3125913e5eee6556f2a80d5862',
  'customers-service': 'springcommunity/spring-petclinic-customers-service:3.4.1@sha256:ab1181fed9b1c23a74a442c1c1625f1ab34b4e0e928192cb5db77eef3f75b14a',
  'visits-service': 'springcommunity/spring-petclinic-visits-service:3.4.1@sha256:307ae223b722d13b7a0e35ef34e93352ab118687d9a0e189565392244031a1c7',
  'vets-service': 'springcommunity/spring-petclinic-vets-service:3.4.1@sha256:963f480587e365b7ef17fdbcce5267ac3aa3436f649852cc7eb4f85da86abab4',
};
const AGENT = 'ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.9.0';

interface Svc {
  name: string;
  port: number;
  cpu: string;
  mem: string;
  replicas: number;
}
/** as built: two gateways (the over-provisioned starting point, as the shop's three frontends), the
 *  services behind it at a quarter of a core. Chosen from the probe (variants/probe.yaml: one gateway
 *  at 1 core, the rest at half a core), which held 400 req/s at 54% of the gateway's limit */
const SERVICES: Svc[] = [
  { name: 'api-gateway', port: 8080, cpu: '500m', mem: '1Gi', replicas: 2 },
  { name: 'customers-service', port: 8081, cpu: '250m', mem: '1Gi', replicas: 1 },
  { name: 'visits-service', port: 8082, cpu: '250m', mem: '1Gi', replicas: 1 },
  { name: 'vets-service', port: 8083, cpu: '250m', mem: '1Gi', replicas: 1 },
];

// what the config server would serve (application.yml + each service's file), for Kubernetes
const SPRING = {
  server: { shutdown: 'graceful' },
  spring: {
    sql: { init: { 'schema-locations': 'classpath*:db/hsqldb/schema.sql', 'data-locations': 'classpath*:db/hsqldb/data.sql' } },
    cloud: {
      config: { 'allow-override': true, 'override-none': true },
      discovery: {
        client: {
          simple: {
            instances: Object.fromEntries(SERVICES.filter((s) => s.name !== 'api-gateway').map((s) => [s.name, [{ uri: `http://${s.name}:${s.port}` }]])),
          },
        },
      },
      refresh: { refreshable: false },
    },
    jpa: { 'open-in-view': false, hibernate: { 'ddl-auto': 'none' } },
    reactor: { 'context-propagation': 'auto' },
    messages: { basename: 'messages/messages' },
  },
  // Eureka is replaced by Service DNS; Micrometer's Zipkin tracing by the OpenTelemetry agent
  eureka: { client: { enabled: false } },
  management: { tracing: { enabled: false }, endpoints: { web: { exposure: { include: 'health,info,prometheus' } } } },
  vets: { cache: { ttl: 60, 'heap-size': 100 } },
  logging: { level: { 'org.springframework': 'INFO' } },
};

interface Options {
  /** per service: replicas, CPU limit (= request), memory */
  over?: Record<string, Partial<Pick<Svc, 'replicas' | 'cpu' | 'mem'>>>;
  hpa?: { service: string; min: number; max: number; cpu: number };
}

function manifests(o: Options = {}): string {
  const docs: object[] = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } }];
  docs.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'spring-config', namespace: NS }, data: { 'application.yml': stringify(SPRING) } });
  for (const base of SERVICES) {
    const s = { ...base, ...(o.over?.[base.name] ?? {}) };
    const labels = { app: s.name };
    docs.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: s.name, namespace: NS, labels },
      spec: {
        replicas: s.replicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false,
            // one node: the laptop's Docker disk holds one copy of the JVM images, not two
            nodeSelector: { 'kubernetes.io/hostname': 'bnk8s-worker2' },
            // the OpenTelemetry Java agent, copied from its image (as the OpenTelemetry Operator does)
            initContainers: [
              {
                name: 'otel-agent',
                image: AGENT,
                command: ['cp', '/javaagent.jar', '/otel/opentelemetry-javaagent.jar'],
                volumeMounts: [{ name: 'otel', mountPath: '/otel' }],
                resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
              },
            ],
            containers: [
              {
                name: s.name,
                image: IMAGES[s.name],
                ports: [{ containerPort: s.port }],
                env: Object.entries({
                  SERVER_PORT: String(s.port),
                  // the images default to the "docker" profile (config server and Eureka by name);
                  // vets-service's own profile turns its cache on
                  SPRING_PROFILES_ACTIVE: s.name === 'vets-service' ? 'production' : 'default',
                  SPRING_CONFIG_ADDITIONAL_LOCATION: 'optional:file:/config/',
                  // no config server: the optional import finds nothing there and the ConfigMap stands in
                  CONFIG_SERVER_URL: 'http://localhost:1/',
                  JAVA_TOOL_OPTIONS: '-javaagent:/otel/opentelemetry-javaagent.jar',
                  OTEL_SERVICE_NAME: s.name,
                  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector.shop.svc.cluster.local:4318',
                  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
                  OTEL_METRICS_EXPORTER: 'none',
                  OTEL_LOGS_EXPORTER: 'none',
                  // the database is embedded (HSQLDB, in the service's own JVM, named by a random
                  // UUID at every start): its time is the service's, not a call to another service
                  OTEL_INSTRUMENTATION_JDBC_ENABLED: 'false',
                  OTEL_INSTRUMENTATION_HIBERNATE_ENABLED: 'false',
                  OTEL_INSTRUMENTATION_SPRING_DATA_ENABLED: 'false',
                  OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=petclinic,service.version=3.4.1',
                }).map(([name, value]) => ({ name, value })),
                resources: { requests: { cpu: s.cpu, memory: s.mem }, limits: { cpu: s.cpu, memory: s.mem } },
                // a TCP check: an HTTP health check that touches the database takes every replica out
                // of rotation when the database is merely slow (reference/k8s/README.md)
                readinessProbe: { tcpSocket: { port: s.port }, periodSeconds: 2, failureThreshold: 2 },
                volumeMounts: [
                  { name: 'otel', mountPath: '/otel' },
                  { name: 'config', mountPath: '/config' },
                ],
              },
            ],
            volumes: [
              { name: 'otel', emptyDir: {} },
              { name: 'config', configMap: { name: 'spring-config' } },
            ],
          },
        },
      },
    });
    docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: s.name, namespace: NS, labels }, spec: { selector: labels, ports: [{ name: 'http', port: s.port, targetPort: s.port }] } });
  }
  // the gateway's routes, through ingress-nginx; the shop's Ingress keeps "/"
  docs.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: 'api-gateway', namespace: NS, annotations: { 'nginx.ingress.kubernetes.io/proxy-read-timeout': '120' } },
    spec: {
      ingressClassName: 'nginx',
      rules: [{ http: { paths: ['/api/customer', '/api/visit', '/api/vet', '/api/gateway'].map((path) => ({ path, pathType: 'Prefix', backend: { service: { name: 'api-gateway', port: { number: 8080 } } } })) } }],
    },
  });
  if (o.hpa)
    docs.push({
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: o.hpa.service, namespace: NS },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: o.hpa.service },
        minReplicas: o.hpa.min,
        maxReplicas: o.hpa.max,
        metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: o.hpa.cpu } } }],
      },
    });
  return `# generated by gen.ts — edit that, not this\n${docs.map((d) => stringify(d)).join('---\n')}`;
}

writeFileSync(join(HERE, 'petclinic.yaml'), manifests());
mkdirSync(join(HERE, 'variants'), { recursive: true });
const variants: Record<string, Options> = {
  // the capacity probe's configuration, before the limits above were chosen
  'probe.yaml': { over: { 'api-gateway': { cpu: '1', replicas: 1 }, 'customers-service': { cpu: '500m' }, 'visits-service': { cpu: '500m' }, 'vets-service': { cpu: '500m' } } },
  // the questions, chosen after the ordinary day was recorded and predicted before any of them ran
  'gateway-1.yaml': { over: { 'api-gateway': { replicas: 1 } } },
  'customers-125m.yaml': { over: { 'customers-service': { cpu: '125m' } } },
  'gateway-hpa-1-3.yaml': { over: { 'api-gateway': { replicas: 1 } }, hpa: { service: 'api-gateway', min: 1, max: 3, cpu: 60 } },
  // round 2, chosen after round 1 was scored and the model learned JIT warm-up from its miss: a
  // different JVM at the same cut, an in-between limit, and pods an autoscaler adds cold under load
  'visits-125m.yaml': { over: { 'visits-service': { cpu: '125m' } } },
  'customers-175m.yaml': { over: { 'customers-service': { cpu: '175m' } } },
  'customers-hpa-1-3.yaml': { hpa: { service: 'customers-service', min: 1, max: 3, cpu: 60 } },
};
for (const [file, o] of Object.entries(variants)) writeFileSync(join(HERE, 'variants', file), manifests(o));
console.log(`wrote petclinic.yaml and ${Object.keys(variants).length} variants`);
