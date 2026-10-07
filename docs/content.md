# Content: lessons, comparisons, episodes, themes, video

All content is data. Graphs are written with the compact `graph()` helper from
`src/scenarios/build.ts`:

```ts
graph(
  [ // nodes: [id, kind, x, y, extra data]
    ['users', 'client', X[0], 200, { retries: 3, timeoutMs: 1000 }],
    ['lb', 'lb', X[1], 200],
    ['api', 'server', X[2], 150, { instances: 4, runtime: 'go' }],
    ['db', 'db', X[3], 200, { tier: 'L' }],
  ],
  [['users', 'lb'], ['lb', 'api'], ['api', 'db']],            // edges
  [['az-a', 'us-east-1a', X[1] - 40, 90, 1000, 420]],          // optional zones: id, label, x, y, w, h
)
```

`X` are column positions (330 px apart). Any `SystemNodeData` field (see spec.md) can go in the
extra-data object.

## Lessons (`src/lessons/`)

A lesson is a starting graph plus steps. Register it in `src/lessons/index.ts` (`LESSONS`); the
Lesson panel shows a picker.

```ts
export const myLesson: Lesson = {
  id, title, subtitle,
  initial: graph(...),
  readRatio: 0.8,                        // optional
  stars: { three: 2.5, two: 3.2 },       // final cost thresholds ($/h); 3★ if cost model is off
  outro: 'Shown on the completion card.',
  steps: [{
    id, title, story, objective,
    traffic: { from: 400, to: 700, rampSeconds: 3 },           // or { keyframes: [{ at, rps }, …] }
    goal: { maxErrorRate: 0.01, maxP99: 500, maxCost?: 2.5, holdSeconds: 10, startAfter?: 12 },
    chaos: [{ at: 3, action: { type: 'degrade', id: 'db', factor: 0.05 }, message: '…' }],
    hint: '…', hintAfter: 6,            // hint appears after 6 s of failing the goal
  }],
};
```

The goal is checked from `startAfter` (default: end of the ramp) and must hold continuously for
`holdSeconds`. Lessons run on the fluid engine.

**Design rule — prove every step:** each step must *fail* without the intended fix and *pass* with
it (ideally with more than one valid fix). Verify headless: convert the lesson graph with
`graphToSpec`, apply the fix as a variant with `applyVariant`, run `simulate` with the step's
traffic/chaos, and check a `holdSeconds` window after `startAfter`.

Built-in lessons:

| lesson | teaches | verified fixes |
|---|---|---|
| Scale 101 | single server limits, load balancers, caches, N+1 | LB + instances; cache; spare instance |
| Retry Storms | metastable failures, retry budgets, bounded queues, breakers, brownouts | retry budget / short queue / client breaker; cache under brownout (breaker alone flaps) |
| Shipping an AI Feature | provider rate limits, failover, semantic cache, GPU vs API cost | raise limit or GPU pool with failover; ≥7 batched GPUs + API overflow under budget |
| Runtime Economics | runtime throughput vs cost, DB as the real wall | Go ×4 / Rust ×3 under budget; Go + cache at 3× traffic |

## Comparison scenarios (`src/scenarios/scenarios.ts`)

```ts
{
  id, title, tagline, watch,
  a: { title, graph: graph(...) },
  b: { title, graph: graph(...) },
  readRatio,
  timeline: [{ at, rps, caption? }],       // last point ends the run
  events: [{ at, message, a?: action, b?: action }],   // per-side actions
  takeaway: { a, b, lesson },
}
```

Scenarios appear in Compare mode and automatically become Studio episodes. Give them a hook in
`COMPARE_HOOKS` (`src/studio/episodes.ts`) — headline text, series, and which metrics to show.
Verify both engines tell the same story (run each side with `simulate` and `simulateDes`).

Built-in basics: Monolith vs Microservices · Single DB vs HA · Sync vs Event-driven · Servers vs
Serverless · Brute force vs CDN + Cache · Single-AZ vs Multi-AZ · Naive Retries vs Resilient Clients ·
LLM API vs Self-hosted GPUs · Node.js vs Go vs the Database.

Advanced (`src/scenarios/advanced.ts`, series "Failure modes at scale"): The Outage After the Fix ·
Retries at Every Layer · Cells vs One Big Fleet · Queue vs Shed · The Tail at Scale · When Your LLM
Provider Goes Down. Each has a story pack in `content/advanced/` (verified numbers, LinkedIn post,
carousel plan, article outline, anti-AI audit).

Ad-hoc comparisons can be opened from a link (`#compare=…`, see tools.md) — that is how the MCP
server hands an AI-built comparison to the user.

## Studio episodes (`src/studio/episodes.ts`)

Hand-written episodes give full control: a single board or A/B, captions, camera moves and live
graph swaps.

```ts
{
  id: 'ep1-localhost', series: 'System design for the AI era', number: 1,
  hook: 'Works on localhost.\nDies in production.',
  layout: 'single', main: graph(...),               // or layout: 'compare', a: {…}, b: {…}
  readRatio: 0.8,
  metrics: ['rps', 'errors', 'p99'],                // + 'cost'
  timeline: [{ at: 0, rps: 3 }, { at: 12, rps: 700 }, { at: 38, rps: 700 }],
  beats: [
    { at: 0, caption: 'AI wrote this app in 10 minutes.' },
    { at: 11, caption: '…', focus: { board: 'main', nodes: ['api-1'] } },          // camera zoom
    { at: 24, caption: 'The fix…', focus: { board: 'main', nodes: null },          // zoom out
      do: [{ board: 'main', action: { type: 'graph', graph: fixedGraph } }] },     // live swap
  ],
  outro: { title, lines: [...], cta? },
}
```

Graph swaps keep engine state for nodes whose ids survive, so a fix happens live.

## Rendering video and carousels

```
npm run dev
npm run record -- <episode-id> [--aspect 4:5|1:1|9:16|16:9] [--brand personal|reducecost] [--theme neon|reference|transit] [--fps 30] [--gif] [--no-stills]
```

Output in `exports/<episode>_<aspect>_<brand>_<theme>/`: MP4 (H.264), a PNG still ~2 s after every
caption beat plus the outro, a PDF carousel of those stills, optional GIF. The Studio tab shows the
exact command for the current selection. Rendering is deterministic (fake clock, animations pinned
to the frame clock) and takes about real time.

## Brands (`src/studio/brands.ts`)

Name, one-line tagline, link text, initials and accent colour per brand. Edit freely.

## Themes (`src/theme/`)

| theme | look | renderers |
|---|---|---|
| Neon (default) | dark control room, glowing particles | `canvas/SystemNode.tsx`, `canvas/FlowEdge.tsx`, `styles.css` + `neon-chrome.css` |
| Reference | engineering-reference figures, IBM Plex, "what is happening" callouts | `theme/reference/*`, `reference.css` |
| Transit | metro map (stations, lines, trains) | `theme/transit/*`, `transit.css` |

A theme = an entry in `THEMES`, CSS scoped to `[data-theme='id']`, and optionally its own node/edge
renderers (branch in `SystemNode`/`FlowEdge`). All renderers consume the shared `nodeView()` and
`explain()` from `canvas/nodeModel.ts`.
