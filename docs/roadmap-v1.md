# Bottleneck v1 — roadmap

v0.1 (tagged) = fluid + DES engines, Live/Lesson/Sandbox/Compare/Studio, CLI, MCP, Terraform import.

v1 promise: **the architecture simulator that tells you what breaks first, and what it costs** — good
enough to teach with, present with, and make real platform decisions with.

## Foundations — trust and daily use
- [x] Test suite (vitest): engine invariants, DES determinism, spec round-trip, documented validation tables
- [x] CI workflow (typecheck + tests + build)
- [x] Undo / redo on boards (⌘Z / ⇧⌘Z)
- [x] Autosave + named designs library (local), open/save `.yaml` files, drop a spec file on the canvas
- [x] Command palette (⌘K): add component, load template, run audit, kill/heal, switch mode
- [x] Top bar fits 1280–1440 px

## Engine — model what actually hurts in production (both engines)
- [x] Autoscaling: target-tracking with min/max, provisioning delay, cooldown; cost follows live instances
- [x] Cache warmth: a restarted/killed cache comes back cold and warms up → thundering herd on the origin
- [x] Network latency on connections (cross-AZ / cross-region links)
- [x] Gray failures: error-injection (`errors` share) and latency-injection (`slow` +ms) actions

## Flagship — "what breaks first, and what it costs"
- [x] Failure audit: headroom (breaking point), single-failure sweep over every component and zone,
      brownout sweep; ranked risk register with blast radius, time to recover, $ at risk
- [x] Fix suggestions verified by the engine, each with monthly cost delta
- [x] Risk overlay on the canvas; exportable report (Markdown / HTML)
- [x] `audit` in CLI and MCP

## Seeing and showing
- [x] Timeline recorder: every run is recorded; scrub back through the whole board; event markers
- [x] Cost lens: monthly cost per component, $ per 1M requests, error budget burn
- [x] Present mode: chrome-free, large type, event captions, keyboard driven
- [x] Spec editor: YAML side panel, two-way sync with the canvas

## Docs
- [x] README + docs updated for every feature above
