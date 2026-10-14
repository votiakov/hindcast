import { loadEngine } from '../src/backtest/native';

// every engine call runs in the WebAssembly build of engine-rs
await loadEngine();
