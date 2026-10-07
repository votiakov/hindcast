import type { Kind } from '../catalog';
import type { Behavior } from './types';
import { cache, client, compute, db, fn, gateway, lb, llm, llmapi, queue } from './behaviors';

/** kind → behaviour. Adding a component = a catalog entry + (optionally) a behaviour here. */
export const BEHAVIORS: Record<Kind, Behavior> = {
  client,
  cdn: cache,
  lb,
  gateway,
  server: compute,
  worker: compute,
  function: fn,
  cache,
  db,
  replica: compute,
  storage: compute,
  queue,
  llm,
  llmapi,
};

export type { Behavior, Route, ProcessCtx, ProcessResult, FoldCtx } from './types';
