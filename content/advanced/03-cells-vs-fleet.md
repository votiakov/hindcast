# Cells vs one big fleet

Scenario: `cells-vs-fleet` · Episode: `cmp-cells-vs-fleet`
Render: `npm run record -- cmp-cells-vs-fleet --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: one shared fleet | B: 4 independent cells |
|---|---|---|
| errors while one database is down (10–26 s) | 100% | 25.2% |
| p99 for the customers still served | n/a | 98 ms |
| errors after restore | 0% | 0% |
| cost (illustrative pricing) | $2.80/h | $2.48/h |

Source: [cell-based architecture and shuffle sharding](https://hidekazu-konishi.com/entry/cell_based_architecture_and_shuffle_sharding_on_aws.html), AWS Builders' Library material.

## LinkedIn post

There's a question AWS uses for blast radius: is it better for 100% of customers to see 5% errors, or for 5% of customers to see 100%? Cell-based architecture is what you build once you pick the second answer.

I built both in Bottleneck at the same traffic, 1,200 req/s, and about the same capacity. A is one shared fleet of 8 API servers on one database. B is four cells, each with 2 API servers and its own database, and a router that pins every customer to one cell.

Then a poison request crashes the database it lands on.

A: every request fails for the 16 seconds the database is down.

B: 25% fail, the cell that took the hit. The other three cells never notice, and their p99 stays at 98 ms.

In my model the cells version was also cheaper, $2.48/h against $2.80/h, because four small databases cost less than one large one there. Real cloud instance pricing is close to linear, so don't count on that part; the blast radius is the reason to do it.

Cells aren't free. You need a router you trust more than anything behind it, deploys that go to one cell before the rest, a way to move a noisy customer between cells, and alerting per cell, because a fleet-wide error rate of 25% doesn't tell you which cell is on fire. Shuffle sharding, giving each customer a different combination of cells, pushes the chance that two customers share the same failure down much further.

I'd take the 25% outage over the 100% one every time.

## Carousel

1. Hook: "One poison request. How many customers go down?"
2. A: shared fleet + shared DB. B: four cells.
3. The crash: A at 100% errors.
4. B: one cell red, three green, 25%.
5. The question: 100% of customers at 5%, or 5% at 100%?
6. What cells cost you: routing, cell-by-cell deploys, rebalancing.

## Article outline

- The blast-radius question and why it's a product decision as much as an architecture one.
- The experiment: same traffic and capacity, one poison request.
- Results and what the 75% who never noticed means for support load, SLAs and incident severity.
- Cost: illustrative model says cheaper; real pricing roughly linear; the real cost is operational (router, deploy pipeline, tooling).
- Shuffle sharding as the next step, with the 1/1680 example from the source.
- Limitation: the model routes customers evenly and has no hot-tenant behavior yet.
