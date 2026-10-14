// The hash of engine-rs's source, written next to the built WebAssembly (`--write`) or checked
// against it: the committed .wasm must be built from the committed Rust.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function engineSourceHash(root = 'engine-rs') {
  const h = createHash('sha256');
  const files = ['Cargo.toml', 'Cargo.lock', ...readdirSync(join(root, 'src')).sort().map((f) => join('src', f))];
  for (const f of files) h.update(f).update('\0').update(readFileSync(join(root, f)));
  return h.digest('hex');
}

const STAMP = 'src/backtest/wasm/source.sha256';
if (process.argv.includes('--write')) {
  writeFileSync(STAMP, engineSourceHash() + '\n');
  console.log(`wrote ${STAMP}`);
}
