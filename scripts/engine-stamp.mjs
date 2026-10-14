// The hash of engine-rs's source, written next to the built WebAssembly (`--write`) or checked
// against it: the committed .wasm must be built from the committed Rust.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function engineSourceHash(root = 'engine-rs') {
  const h = createHash('sha256');
  const walk = (dir) => readdirSync(join(root, dir)).sort().flatMap((f) => (statSync(join(root, dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const files = ['Cargo.toml', 'Cargo.lock', ...walk('src')];
  for (const f of files) h.update(f).update('\0').update(readFileSync(join(root, f)));
  return h.digest('hex');
}

const STAMP = 'src/backtest/wasm/source.sha256';
if (process.argv.includes('--write')) {
  writeFileSync(STAMP, engineSourceHash() + '\n');
  console.log(`wrote ${STAMP}`);
}
