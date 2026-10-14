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

A lesson is a starting graph plus steps. Register it in a track in `src/lessons/index.ts` (`TRACKS`,
the study path; `LESSONS` is the tracks in order); the Lesson panel's picker groups lessons by track,
and "Next" on the completion card follows the path.

```ts
export const myLesson: Lesson = {
  id, title, subtitle,
  initial: graph(...),
  readRatio: 0.8,                        // optional
  stars: { three: 2.5, two: 3.2 },       // final cost thresholds ($/h); 3★ if cost model is off
  outro: 'Shown on the completion card.',
  credit: PRIMER_CREDIT,                 // optional: attribution shown under the lesson (CC BY sources)
  steps: [{
    id, title, story, objective,
    traffic: { from: 400, to: 700, rampSeconds: 3 },           // or { keyframes: [{ at, rps }, …] }
    goal: {
      maxErrorRate: 0.01, maxP99: 500, holdSeconds: 10,
      startAfter?: 12,     // checked from here (default: end of the ramp)
      deadline?: 30.5,     // the hold must be complete by then: ride it out, don't recover later
      maxCost?: 2.5,       // $/h at every moment of the hold
      maxAvgCost?: 1.85,   // $/h averaged over the level (a bill), checked when the hold completes
      maxLagS?: 5,         // seconds of backlog any queue may hold
      maxJobErrorRate?: 0.01, // share of the jobs queue consumers take that fail (downstream included) — lost work the producers never see
      maxLostWrites?: 0,   // acknowledged writes a failover or a write-behind cache may lose over the level
      maxTotalErrorRate?: 0.035, // failed share of every request since startAfter (the whole incident, not the hold)
    },
    chaos: [{ at: 3, action: { type: 'degrade', id: 'db', factor: 0.05 }, message: '…' }],
    hint: '…', hintAfter: 6,            // hint appears after 6 s of failing the goal
    solution: { note: 'Cache in front of the database', changes: [ /* ChangeSpec edits, e.g. { op: 'add', component, zone? } */ ] },
    takeaway: 'Shown after the level is passed: what it taught.',
  }],
};
```

The goal must hold continuously for `holdSeconds`. Lessons run on the fluid engine.

**Design rule: prove every level.** `solution` is a set of edits to the board the previous level
leaves (the reference design; **Show me** loads it). `test/lessons.test.ts` plays every level
headlessly (`src/lessons/verify.ts`: the same ramp, chaos and goal as the app) and requires that
- a level with a solution **fails** with the previous level's design, at 5% less traffic;
- its solution **passes**, at 7% more traffic (the app's jitter);
- only a lesson's first level may be a warm-up without a solution;
- every level has a `takeaway`.

`npx tsx -e "import('./src/lessons/verify.ts').then(m => …)"` or the test itself shows the worst
moment of a failing level.

Built-in lessons:

| lesson | teaches | reference fixes |
|---|---|---|
| Scale 101 | single server limits, load balancers, caches, N+1 | LB + 4 instances; cache + 11 instances; 14 instances at 2,400 req/s |
| Queues | synchronous vs async work, backlogs | a queue between the API and the worker; 3 workers for the sustained rate |
| Retry Storms | metastable failures, retry budgets, bounded queues, breakers, brownouts | retry budget + short queue; cache under brownout (breaker alone flaps) |
| Elastic | right-sizing, autoscaling warm-up, cold-cache stampede | 2 instances; autoscale 2–12 with a 10 s warm-up; database M |
| Zones | failure domains, zone failure, replica failover, standby cost | API pool + replica in the second zone; smaller autoscaling pools in both zones |
| Shipping an AI Feature | provider rate limits, failover, GPU vs API cost | a higher rate limit; 8 batched GPUs with the provider as failover |
| Runtime Economics | runtime throughput vs cost, DB as the real wall | Go on 5 instances; cache + 14 instances at 3× traffic |

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
Provider Goes Down · Peak-sized Fleet vs Autoscaling · One Region vs Two · Read Replicas vs One Bigger
Database · a 10 s Pod vs a 2-minute VM. The first six have a story pack in `content/advanced/` (verified numbers, LinkedIn post,
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

**In the browser:** Studio → *Render video, GIF and carousel*. The episode plays frame by frame on a
virtual clock (simulation, camera moves and animations all follow it) and is encoded on the page:
MP4 (H.264 through WebCodecs; Chrome, Edge, Safari 16.4+, Firefox 130+), a GIF (480 px wide, 10 fps),
a PNG still ~2 s after every caption beat plus the outro, and those stills as a PDF carousel. Nothing
is uploaded. It takes about three times the clip's length (`src/studio/exportClip.ts`).

**From the command line** (frame-perfect, needs this repository and the dev server):

```
npm run dev
npm run record -- <episode-id> [--aspect 4:5|1:1|9:16|16:9] [--brand personal|reducecost] [--theme terminal|neon|reference|transit] [--fps 30] [--gif] [--no-stills]
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
| Terminal (default) | the backtest screen's look: dark panes, hairlines, IBM Plex Sans Condensed + Mono, amber accent | Reference renderers and rules (scoped to both themes) + `terminal.css` palette and chrome |
| Neon | dark control room, glowing particles | `canvas/SystemNode.tsx`, `canvas/FlowEdge.tsx`, `styles.css` + `neon-chrome.css` |
| Reference | engineering-reference figures, IBM Plex, "what is happening" callouts | `theme/reference/*`, `reference.css` |
| Transit | metro map (stations, lines, trains) | `theme/transit/*`, `transit.css` |

A theme = an entry in `THEMES`, CSS scoped to `[data-theme='id']`, and optionally its own node/edge
renderers (branch in `SystemNode`/`FlowEdge`). All renderers consume the shared `nodeView()` and
`explain()` from `canvas/nodeModel.ts`.
