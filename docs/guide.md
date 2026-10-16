# The app — every view and what it does

`npm run dev` → http://localhost:5173. The tabs along the top are the views: **Backtest · Live ·
Lessons · Sandbox · Compare · Studio**. The app opens on Live; `#backtest` in the URL opens the
Backtest tab directly. ⌘K opens the command palette from anywhere, and `?` lists the shortcuts.

Everything runs in the browser. Designs are saved to local storage; nothing is uploaded.

---

## Backtest

Your production history as a chart, with infrastructure changes replayed over it as "what would
have happened". It is built from files you export (metrics, traces, the bill) and a model calibrated
from them. Full guide: [backtest.md](backtest.md). How the model is fitted:
[calibration.md](calibration.md).

**Opening data**
- Three **reference systems** are built in (HotROD, Astronomy Shop, PetClinic): real recordings
  with their models and accuracy. Pick one from the system menu.
- **Open files…** or drop files on the screen: a `hindcast.import.yaml` with its metric, trace and
  bill files, or a `dataset.json` + `model.json` from the CLI, plus any strategy `.yaml` files.

**The chart** — one time axis, panes stacked:
- **p99**: the latency users saw (measured, a line over a light area), the model's
  replay of the system *as built* (dashed), and every strategy as its own line with a 10–90% band.
  The SLO is the dashed red line; shaded columns are stretches out of SLO, labelled with their minutes.
- **Errors**: measured and replayed error rates.
- **Cost**: $/hour from the bill, as built and per strategy.
- **Show**: the whole run, 24 h, 6 h, 1 h or 15 min, and ⌘/ctrl + wheel to zoom around the cursor.
- **Replayed at**: the recorded traffic, or 0.5–3× it.
- **Click any moment** to open it on the board: the system as a live canvas, replaying that
  bucket's traffic through the model. Edit it there and press *Backtest these edits* to bring the
  change back as a new strategy, or *Back to the chart*.

**Changes tested** (right side): as built and each change (a strategy file), verdict first — what it
does to the time out of SLO — then its cost a month in words, never as a red/green number. Changes
that keep the SLO come first, then the cheapest. Click one to focus it, the swatch to hide it,
**+ test a change** to write a new one.

**Worst moment**: for the focused strategy, when and why — the component that limited the system, its
load against its capacity, its queue — with *open on board*.

**Model accuracy**: how well this model predicted runs it never saw, check by check, against the
targets (p99 within 20%, breaking point within 15%, cost within 10%).

**The tester panel** (bottom):
- **Overview**: the verdict sentence ("saves $410/month; on Sep 14 at 12:03 it would have caused
  9 minutes of errors"), $/month, minutes out of SLO, failed requests, error budget used, peak p99,
  replica-hours — each with its range.
- **Incidents**: every stretch out of SLO with its cause; click to jump there.
- **Endpoints**: per endpoint — requests, failures, minutes out of *its own* SLO, $ per million
  requests.
- **Changes**: the strategy's YAML, editable live; the backtest reruns as you type; the
  plain-English list of what changed and the assumptions made.
- **Model**: every component — kind, replicas, capacity and its band, what limits it, latency, cost,
  fit status (good / fair / poor / unexplained / cost only) and notes.

**Replay an outage…**: replays a famous public outage against this system — Cloudflare 2019,
GitHub 2018, Slack 2021, AWS us-east-1 2025 — as built and with each strategy, with the published
timeline marked on the chart and the assumptions stated. "Would your design have survived it?"

**Card ↗**: a Studio card / clip of the focused strategy at post size (the chart drawing itself,
then the verdict), with the model's accuracy line.

---

## Live

The app opens on a system failing in front of you, and the story plays by itself (a **cold
open**), each move made after a countdown shown in the callout:

1. **overload**: traffic climbs to 700 req/s against one API server that serves 250. The callout
   says what users get (errors, p99) and why ("Overloaded: 473 req/s offered vs 250 req/s
   capacity. The excess queues, then gets dropped.").
2. **scale out**: a load balancer and four instances; healthy.
3. **3× traffic**: autoscaling grows the API to ten instances, and the database becomes the
   bottleneck.
4. **a cache**: healthy again; the exits: learn it (Lessons: 18 lessons, 54 levels), design your own (Sandbox), check a
   change on your real system's history (Backtest), let your AI agent do it, render it as a video.

The chapter strip at the top shows the beat and jumps to any of them. The first click, key or
scroll on the board hands control to you ("you're driving"); **replay** starts the story over.
Every callout also offers the other moves: compare the fix side by side, learn it step by step,
the cheapest config for the load, kill an instance, audit it, take over the board (opens it in
Sandbox). On a phone the system reads top to bottom and the callout docks at the bottom.

---

## Lessons

Eighteen lessons, 54 guided levels with objectives the engine checks ("Serve 120 req/s with < 1%
errors and p99 < 300 ms for 5 s"). Each level sets up traffic (and sometimes a failure); you
change the design until the objective holds. Some levels have a window: the system must ride out
what happens in it, not recover afterwards.

| lesson | levels |
|---|---|
| **Scale 101: From One Box to Web Scale** | Launch day · Front page of Hacker News · Going viral · Chaos Monday |
| **Queues: Turn a Spike into a Backlog** | Thumbnails, while you wait · The launch email · The backlog that never drains |
| **Follow One Request: Timeouts and Retries** | A request that times out · Retries make it worse · Timeouts that do not line up |
| **Retry Storms: When the Fix Becomes the Outage** | A normal Tuesday · The six-second blip · Database brownout |
| **Elastic: Paying for Peak vs Surviving It** | Paying for peak, all day · The lunch rush · The cache restarts |
| **Zones: When a Whole Data Center Goes Dark** | Six instances, one zone · us-east-1a goes dark · Paying for two of everything |
| **Shipping an AI Feature to Real Traffic** | Launch the assistant · It went viral · Finance saw the bill |
| **Does the Language Matter? Runtime Economics** | Twelve Node.js instances · Cut the compute bill · Black Friday: 3× traffic |

- **Hint** after a few seconds out of SLO; **Show me** next to it puts the level's reference design
  on the board (undoable). **Replay level** replays it with the design on the board.
- **Why it worked** after every pass: what the level taught, and what the system held.
- The finish card recaps every level, gives up to three stars for the bill and leads to the next
  lesson. Progress (the level reached, the best stars) is kept in the browser and shown in the
  picker.
- Every level is proven by `test/lessons.test.ts`: the design the previous level left fails it,
  its reference design passes it, both with the app's traffic jitter.

Authoring your own: [content.md](content.md#lessons-srclessons).

---

## Sandbox

Build anything and push traffic and failures through it.

**Building**
- The **component palette** (left): Users, CDN, Load Balancer, API Gateway, API Server, Worker,
  Serverless Fn, Cache, Database, Read Replica, Object Storage, Queue, GPU Inference, LLM Provider
  API. Drag onto the board or click; connect right handle → left handle. Every component's
  numbers: [catalog.md](catalog.md).
- **Zones**: group components into availability zones or regions; set the latency of any link.
- **Templates**: start from a ready design (Design menu).
- **Drop a file** on the board: an architecture spec (YAML/JSON), Kubernetes manifests, or
  `terraform show -json` output opens as a design (with the assumptions it made); a traffic CSV
  (time, req/s) replays real traffic.

**Per component** (select it): instances (+/−), language runtime (Node.js, Python, Java, Go, Rust —
changes throughput, latency, cold starts and cost), autoscaling (min/max, target, warm-up — "k8s pod
5–20 s, Fargate 30–60 s, EC2 ASG 90–180 s"), retries (immediate / backoff / budget), client timeout,
circuit breaker with fallback, bounded queue (seconds of work it holds before shedding), routing
(split / fan-out / failover), scatter-gather fan-out, continuous batching for GPUs, tier, cache hit
rate. **Calibrate** sets a component from production numbers: req/s at a CPU %, p50, $/hour.

**Chaos** (per component): kill / revive; *fault…* — 10% or 50% errors, +100/500/2000 ms, 50%
capacity, flush a cache, restore; fail a zone (its frame takes down everything inside). ⌘K → *Heal everything*.

**Traffic** (control bar): req/s, read share, pattern — steady, day/night, spiky, ramp; ⌘K →
*Traffic spike ×3*; type a number in ⌘K to set traffic.

**While it runs**: throughput, error rate, p99 and cost at the top; per component load, queue, CPU,
drops; request particles along connections; explanations on stressed components; alert toasts.

**Timeline**: every run is recorded — drag the timeline to rewind the whole board to any moment,
←/→ to step. *Copy* gives the run as an incident timeline in Markdown.

**Design menu**: save (⌘S), open, save a copy, download `.yaml`, templates, new blank design.
Undo/redo with ⌘Z / ⇧⌘Z.

**Architecture as code** (the YAML button): a spec editor that stays in sync with the board in both
directions. Reference: [spec.md](spec.md).

**Failure audit**: replays a minute at your expected load once per thing that goes wrong in
production — every component dying, every dependency turning slow, caches restarting cold, a hot key
on a sharded database, zones going dark, a traffic surge — and grades each by what users would have seen. The result is a risk
register with blast radius, recovery time and $ at risk; replay any incident on the board; each fix
is verified by re-running the same incident and priced in $/month; apply it with one click
(undoable); **Backtest** a fix against real history when the board came from a backtest; copy the
report as Markdown or HTML. Details: [tools.md](tools.md#failure-audit).

**Analysis** panel: discrete-event Monte Carlo with confidence intervals, breaking-point search, the
cost optimizer (cheapest sizing that meets the SLO). Details: [analysis.md](analysis.md).

**Present** (P): no chrome, large numbers, captions; ←/→ walks through the audit's incidents live;
F fullscreen, Esc exits.

---

## Compare

Two designs side by side under the same traffic and failures, with a **takeaway** computed by the
engine. Built-in comparisons:

Monolith vs Microservices · Single DB vs HA Cluster · Sync vs Event-driven · Servers vs Serverless ·
Brute Force vs CDN + Cache · Single-AZ vs Multi-AZ · Naive Retries vs Resilient Clients · LLM API vs
Self-hosted GPUs · Node.js vs Go vs the Database · The Outage After the Fix · Retries at Every Layer ·
Cells vs One Big Fleet · Never Drop a Request? Queue vs Shed · The Tail at Scale · When Your LLM
Provider Goes Down · Peak-sized Fleet vs Autoscaling · One Region vs Two · Read Replicas vs One Bigger
Database · Autoscaling: a 10 s Pod vs a 2-minute VM.

Every built-in comparison is played headlessly in the tests (`test/scenarios.test.ts`) and must
show a visible difference in failed requests, time out of SLO, worst p99 or cost.

Each side has its own failure audit; swap the architectures; take manual control of traffic and
chaos on whatever is on the boards. Edits on either board are undoable.

---

## Studio

Scripted episodes rendered to video and carousels for posts: a single board or A/B, captions,
camera moves and live graph swaps, then an outro. Pick the episode (including ones generated from
a comparison or an audit), the format (Feed 4:5, Square 1:1, Story 9:16, Slide 16:9), the brand and
the theme, then **Render video, GIF and carousel**: it renders in the browser, frame by frame, and
offers the MP4, the GIF, a PNG still after every caption and the PDF carousel for download. The same
output from the command line: the `npm run record` command under *Or from the command line*. Backtest results become cards and clips too (Backtest → Card ↗,
or `hindcast backtest … --card card.json`). Details: [content.md](content.md).

---

## Settings (gear icon)

- **Replicas** (the board's toggle, top right): grouped — a pip per instance; each — a row per instance
  with the traffic fanned out, a dead one routed around, a booting one waiting.
- **Pricing**: illustrative catalogue prices, AWS us-east-1 or GCP us-central1.
- **Toggles**: cost model, automatic DB failover (and failover time), serverless cold starts, traffic
  jitter, request particles, explanations, alert toasts.
- **Tuning**: request timeout, maximum error rate for the SLO.

## Shortcuts

| keys | |
|---|---|
| ⌘K | command palette — anything by name; a number sets traffic |
| Space | play / pause |
| ⌘Z, ⇧⌘Z | undo / redo |
| ⌘S | save the design |
| P | present mode |
| ← → | step through the recording while rewinding |
| Del | delete the selected component or connection |
| ? | the shortcut sheet |

## Outside the app

The same engines run headless: the **CLI** (`npm run sim -- …`) and an **MCP server** for AI
assistants, with a live canvas in hosts that support MCP Apps. See [tools.md](tools.md).
