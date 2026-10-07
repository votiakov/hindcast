# Anti-AI audit: six LinkedIn posts (advanced comparisons)

Rules: ~/knowledge-base/writing/dont-sound-like-ai.md (checklist items 1–15). Scope: the
"LinkedIn post" section of each file. Carousel and article outlines are working notes, not
publishable copy; run the checklist again when they become full drafts.

| # | Check | Verdict | Notes |
|---|---|---|---|
| 1 | Burstiness | pass | every post has a ≤6-word sentence ("No difference." / "It isn't." / "Then a poison request crashes…" / "Same shards, same stall rate.") and 25+-word sentences; paragraph lengths vary |
| 2 | Tier 1 / Tier 2 words | pass | grep: 0 Tier 1 hits in all six; Tier 2: one "key" in 05, kept (literal "1,000-key read", not the adjective) |
| 3 | "not just X, it's Y" escalation | fixed | 02: "The fix is a rule, not a library:" → "The fix is a policy:" (introduced in my own edit, caught on re-read) |
| 4 | Em dashes ≤1 | pass | 0 in every post |
| 5 | Stacked triads | fixed | 03: "router…, deploys…, and a way to move a noisy customer" → four items with a concrete fourth (per-cell alerting). 05: "partitions, tail-aware timeouts, and hedged requests" → two items |
| 6 | Copula dodge, participial tails, hedge stacks, false suspense, vague authority, grandiosity, anaphora | pass | authorities are named (AWS, Dean & Barroso, Google SRE book, FailureAtlas); no "experts say" |
| 7 | Previews/recaps, signposted conclusion, pep-talk endings | pass | no "in this post"; endings are a stance (01, 03, 04), a source (02, 06) or a limitation (05) |
| 8 | Delete first/last sentence test | kept | first sentences carry the incident/number in every post; last sentences carry the admitted limitation or stance, so removing them loses content |
| 9 | Concrete detail in the first three sentences | pass | DNS name + 2.5 h/15 h (01), "place order" (02), 1,200 req/s (03), 4 servers/1,000 req/s (04), 8 ms / 1 in 125 (05), 90 req/s (06) |
| 10 | Opinion or REAL limitation; no fabrication | pass, with flags | limitations are real (model vs production, illustrative pricing, hedging not implemented, answer quality not simulated). No first-person incident stories: "I" only claims building the simulator and running these experiments. FLAG for Andrii: stated opinions written in your voice ("I'd take the 25% outage…", "I'd rather tell a user 'busy, try again'…", "What I'd reach for first…", "very few teams design it") are proposals; keep only the ones you hold |
| 11 | Assistant residue, emoji, bold-first bullets, Title Case, markdown in post body | pass | posts are plain paragraphs; no emoji, no bullets |
| 12 | Contractions, register, American spelling | pass | contractions throughout; "behavior" spelling; LinkedIn register |
| 13 | Platform fit | pass | 230–270 words each, no hashtag wall; add your own link to the live comparison |
| 14 | Cadence (punchline endings) | kept | ≤2 landed beats per post (e.g. 02 "It feels less safe. It isn't." + no other); other paragraphs end on data |
| 15 | Metaphor inventory | pass | none extended; "on fire" (03) single use |

Borderline calls kept:
- 04 "A queue adds latency, never capacity": contrast shape, kept because both halves are concrete and it's the thesis.
- 01 "This is a model, not AWS.": short "not" clause, kept as the honest limitation.
- 06 "An outage is cheap if the invoice is the only thing you look at.": aphoristic, the single landed beat in that post.
