# Competitor reproduction plan

**Goal:** run every public memory system we cite in `docs/comparison-honest.md` on the SAME LOCOMO harness, on the SAME hardware, with the SAME grader, and publish the cross-system table honestly.

**Why this matters:** the `docs/skymem-pitch.md` and `docs/agent-drift-eval-spec.md` cite numbers from each competitor's own paper / blog post. Those numbers were generated under different conditions — different LLMs, different graders, different rerankers, sometimes different LOCOMO splits. Citing them is fine for reference, but **the honest comparison number is one we measure ourselves**.

If a competitor scores higher than us when measured this way, we say so. If they score lower, that's the receipt. Either way, no cherry-picking.

This plan is the scaffolding. Implementation lands progressively (one competitor at a time) after T1 establishes skyMem's headline number.

---

## Systems to reproduce

| System | Source | Published LOCOMO | License | Install path |
|---|---|---|---|---|
| **Mem0 (new algorithm)** | [mem0ai/mem0](https://github.com/mem0ai/mem0) | 91.6% (announcement 2025) | MIT | `pip install mem0ai`, BYO OpenAI key |
| **MemMachine v0.2** | MemMachine paper | 91.7% | Apache 2.0 | follow paper repo |
| **Memori** | [GibsonAI/memori](https://github.com/GibsonAI/memori) | 81.95% | MIT | `pip install memori` |
| **Zep / Graphiti** | [getzep/graphiti](https://github.com/getzep/graphiti) | ~75.1% | Apache 2.0 | `pip install graphiti-core`, BYO Neo4j |
| **Letta (MemGPT)** | [letta-ai/letta](https://github.com/letta-ai/letta) | not disclosed | Apache 2.0 | Docker compose |
| **Synthius-Mem** | technical paper, no public repo | 94.4% | proprietary | **NOT reproducible** — leaders-only ref |
| **ByteRover 2.0** | blog post | 92.2% | open weights | follow blog repo |
| **Long context (no memory)** | (baseline) | ~47% | n/a | direct Claude/GPT call with the full conv in context |
| **Naive RAG** | (baseline) | ~53% | n/a | embed turns, top-k cosine, no special memory |

**Reproducibility caveat:** Synthius-Mem has no public reference implementation as of 2026-05. We cite their 94.4% number with a note that it's their self-reported figure, not one we've verified. Same for ByteRover's 92.2% until their code drops.

---

## The honest harness

Every system answers the SAME 1,986 LOCOMO questions, with the SAME judging logic.

```
┌──────────────────────────────────────────────────────────────────┐
│  LOCOMO dataset (snap-research v1)                               │
│    • 10 conversations, 1,986 questions, 5 categories             │
│    • Same load function for every adapter                        │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Adapter contract — every system implements:                     │
│                                                                  │
│    setup()         → fresh state per conv                        │
│    ingest(turn)    → add a conversation turn to the memory       │
│    answer(q)       → return the agent's answer string            │
│    teardown()      → clean up between convs                      │
│                                                                  │
│  See: scripts/competitors/adapter-contract.md (forthcoming)      │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Same grader for every system (Lenient Haiku-based)              │
│    • Reuses sky/test-grader.js logic                             │
│    • Same prompts, same model, same fairness rules               │
│    • Per-cat breakdown + aggregate                               │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Output: per-system summary JSON                                 │
│    • Same shape as skyMem's t3fs-*-summary.json                  │
│    • Joined into a single COMPARISON-TABLE.md by aggregator      │
└──────────────────────────────────────────────────────────────────┘
```

---

## What "same harness" means in practice

Five fairness rules. These are the published methodology so any external reviewer can verify our table isn't rigged.

1. **Same conversational turns ingested.** Every adapter sees the same per-conv turn ordering, same content. No system gets a pre-summarised version that another doesn't.

2. **Same LLM for the agent's final answer.** Claude Sonnet 4.5 for everyone. The memory system is the variable; the language model isn't. Some systems bundle their own LLM call — those get re-routed through Anthropic so the apples-to-apples holds.

3. **Same retrieval budget.** Each system is given the same token budget for its retrieved context block (~4000 tokens). Systems that natively return more get truncated; systems that natively return less are NOT given a free retrieval bonus.

4. **Same grader.** The Haiku-based lenient grader from `sky/test-grader.js` judges every answer. Strict-match scores are also recorded for cross-validation.

5. **Same hardware envelope.** Run on the same Docker Desktop instance. Same Postgres. Same MySQL. Same network. If a system needs Neo4j or its own datastore, run it as a sibling container.

---

## What we ARE allowed to vary

- **Memory storage choice.** Each system uses its native store (Postgres / Neo4j / SQLite / in-memory).
- **Retrieval implementation.** Each system uses its native algorithm — that's the point of the eval.
- **Cost and latency.** These get **reported**, not normalised. If Mem0 is 3× cheaper but 5pp lower, that's a real trade-off the reader should see.

---

## Implementation plan

| Stage | Deliverable | Effort | Gates |
|---|---|---|---|
| **Stage 0** | Adapter contract doc — `scripts/competitors/adapter-contract.md` | 1h | Plan only, no code |
| **Stage 1** | Naive-RAG adapter (baseline floor) — `scripts/competitors/rag-baseline.js` | 4h | Stage 0 |
| **Stage 2** | Long-context adapter (no-memory baseline) — `scripts/competitors/no-memory.js` | 2h | Stage 0 |
| **Stage 3** | Mem0 adapter — `scripts/competitors/mem0/` | 1-2 days | Stage 0, mem0 install + API key |
| **Stage 4** | Memori adapter — `scripts/competitors/memori/` | 1-2 days | Stage 0 |
| **Stage 5** | Zep/Graphiti adapter — `scripts/competitors/zep/` | 2-3 days | Stage 0, sibling Neo4j container |
| **Stage 6** | MemMachine adapter (if public code available) | 2-3 days | Their repo state |
| **Stage 7** | ByteRover adapter (if/when public) | 2-3 days | Their repo state |
| **Stage 8** | Letta adapter | 1-2 days | Stage 0 |
| **Stage 9** | Aggregator — pulls all per-system summaries into `docs/COMPARISON-TABLE.md` | 4h | All stages it's ranging over |

**Effort estimate:** ~3 weeks of focused work for full coverage. Most of the cost is reading each competitor's docs and writing the adapter that fits its API. The harness itself (loader, grader, aggregator) is the shared code skyMem already has.

**Bench cost:** each competitor run is ~2 hours of LLM compute (same as our T3 fullstack). At Sonnet rates, ~$5-15 per system × 7 systems = ~$50-100 in API spend to produce the full comparison table. Sane investment.

---

## What we publish

After Stages 0-5 (the most-cited competitors), we publish:

- `docs/COMPARISON-TABLE.md` — public, in the `HopiumLab/skymem-io` repo
- Updated `docs/comparison-honest.md` with the measured numbers in addition to the cited ones
- The adapter code itself — anyone can rerun

The publication includes:
- Per-system aggregate accuracy
- Per-category breakdown (single-hop / multi-hop / temporal / open-domain / adversarial)
- Cost per question per system
- Latency p50/p95 per system
- Per-conv breakdown (so single-conv outliers are visible)
- A "what we changed in each adapter and why" appendix (for full transparency)

---

## Where this fits in the trunk-first menu

T5 in `SKY-REBUILD.md`. Sequence:

```
T1 ──────────────────────────────────────────► skyMem headline number
T2 ──────────────────────────────────────────► per-cat analysis
T3 ──────────────────────────────────────────► engine fixes on weakest cat
T4 ──────────────────────────────────────────► methodology doc
T5 (this plan) ──────────────────────────────► competitor reproduction
T6 ──────────────────────────────────────────► our own ablation
T7 ──────────────────────────────────────────► failure catalog ✓ done
```

T5 starts AFTER T1-T4 give us a stable headline. Doing T5 before we've stabilised our own number would just produce noise (every engine fix during T3 would re-rank the comparison table).

---

## Honesty contract — mirrored from agent-drift-eval-spec.md

The two same principles that govern the Agent Drift Eval apply here:

1. **We publish our weakest scenario / configuration first.** If skyMem trails Mem0 on single-hop but leads on multi-hop, the multi-hop result is NOT the headline. The aggregate is.
2. **The eval is reproducible from a clean checkout.** Anyone with the API keys + the install scripts can rerun every adapter and verify the table.

If a system we tested wants to contest a result, we accept PRs against the adapter and re-run. Public, no gatekeeping.

---

## Cross-references

- `docs/comparison-honest.md` — current capability matrix + cited competitor numbers
- `docs/agent-drift-eval-spec.md` — same-harness ethos for our own benchmark
- `docs/BENCH-METHODOLOGY.md` — skyMem's own LOCOMO methodology (T1/T4 output)
- `docs/skymem-failures.md` — the "where do WE break" catalog (T7, published)
- `scripts/bench-locomo.js` — the shared harness all adapters slot into
- `scripts/run-ablation.sh` — T6 ablation runner (sibling discipline)
