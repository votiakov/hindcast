#!/usr/bin/env node
// A stand-in kubectl for read_cluster: prints the example manifests' workloads as `get -o json` would.
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
const args = process.argv.slice(2);
if (args.includes('--context') && args[args.indexOf('--context') + 1] === 'nope') {
  process.stderr.write('error: context "nope" does not exist\n');
  process.exit(1);
}
const docs = parseAllDocuments(readFileSync(new URL('../../examples/kubernetes/shop.yaml', import.meta.url), 'utf8')).map((d) => d.toJS()).filter((d) => d && ['Deployment', 'StatefulSet', 'HorizontalPodAutoscaler'].includes(d.kind));
process.stdout.write(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: docs }, null, 4));
