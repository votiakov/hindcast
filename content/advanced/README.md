# Advanced comparisons: stories

Six principal-level comparisons, each with verified numbers, a LinkedIn post, a carousel plan
(matching the Studio stills) and an article outline. Numbers come from the discrete-event engine
(6 seeded runs) and are reproducible: open the scenario in Compare, or run the facts script in
`docs/content.md`.

| file | scenario | hook |
|---|---|---|
| 01-outage-after-the-fix.md | outage-after-the-fix | AWS fixed the bug in 2.5 hours. The outage lasted 15. |
| 02-retries-every-layer.md | retries-every-layer | Every layer retries 3 times. |
| 03-cells-vs-fleet.md | cells-vs-fleet | One poison request. How many customers go down? |
| 04-queue-vs-shed.md | queue-vs-shed | "Never drop a request" is how you drop all of them. |
| 05-tail-at-scale.md | tail-at-scale | Every shard is fast. Your users still wait. |
| 06-llm-provider-outage.md | llm-provider-outage | Your AI feature has a single point of failure you don't even run. |

Render any of them: `npm run record -- cmp-<scenario-id> --theme reference --aspect 4:5`
(add `--gif` for a GIF; stills and a PDF carousel are written alongside the MP4).

All posts went through the anti-AI checklist; see AUDIT.md.
