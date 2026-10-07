# Bottleneck v1 — roadmap

v0.1 (tagged) = fluid + DES engines, Live/Lesson/Sandbox/Compare/Studio, CLI, MCP, Terraform import.

v1 promise: **the architecture simulator that tells you what breaks first, and what it costs** — good
enough to teach with, present with, and make real platform decisions with.

## Foundations — trust and daily use
- [ ] Test suite (vitest): engine invariants, DES determinism, spec round-trip, documented validation tables
- [ ] CI workflow (typecheck + tests + build)
- [ ] Undo / redo on boards (⌘Z / ⇧⌘Z)
- [ ] Autosave + named designs library (local), open/save `.yaml` files, drop a spec file on the canvas
- [ ] Command palette (⌘K): add component, load template, run audit, kill/heal, switch mode
- [ ] Top bar fits 1280–1440 px

## Engine — model what actually hurts in production (both engines)
- [ ] Autoscaling: target-tracking with min/max, provisioning delay, cooldown; cost follows live instances
- [ ] Cache warmth: a restarted/killed cache comes back cold and warms up → thundering herd on the origin
- [ ] Network latency on connections (cross-AZ / cross-region links)
- [ ] Gray failures: error-injection (`errors` share) and latency-injection (`slow` +ms) actions

## Flagship — "what breaks first, and what it costs"
- [ ] Failure audit: headroom (breaking point), single-failure sweep over every component and zone,
      brownout sweep; ranked risk register with blast radius, time to recover, $ at risk
- [ ] Fix suggestions verified by the engine, each with monthly cost delta
- [ ] Risk overlay on the canvas; exportable report (Markdown / HTML)
- [ ] `audit` in CLI and MCP

## Seeing and showing
- [ ] Timeline recorder: every run is recorded; scrub back through the whole board; event markers
- [ ] Cost lens: monthly cost per component, $ per 1M requests, error budget burn
- [ ] Present mode: chrome-free, large type, event captions, keyboard driven
- [ ] Spec editor: YAML side panel, two-way sync with the canvas

## Docs
- [ ] README + docs updated for every feature above
