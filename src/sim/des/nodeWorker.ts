import { parentPort, workerData } from 'node:worker_threads';
import { simulateDes } from './des';
import { slim } from './analyze';
import { loadNativeEngine } from '../../backtest/native';

await loadNativeEngine();

const { spec, scenario, seeds, des } = workerData as { spec: unknown; scenario: unknown; seeds: number[]; des: object };
parentPort!.postMessage(seeds.map((seed) => slim(simulateDes(spec, scenario, { ...des, seed }))));
