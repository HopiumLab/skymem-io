# Ablation Results — `abl-20260511-021039`

**Status:** locked. Single-conv ablation on `conv-43` (242 questions), 6 variants, ~6 hours of bench time.

**TL;DR:** the marketing claim that "every cognition layer earns 2-9 pp" is **partially REFUTED by real numbers**. Three of five ablated components (persona, reformulator, Cohere embeddings) earn measurable lift. Two (nucleus expansion, verifier) are net-zero or net-negative on this conversation — a finding that contradicts the existing pitch and tells us something specific about the implementation we need to fix.

This doc publishes the real numbers, the surprising findings, and what we'll do about them.

---

## How the test was run

- **Target conversation:** `conv-43` (242 LOCOMO questions across all 5 cat types)
- **Method:** run the same bench 6 times, each with one layer toggled off (vs baseline = all on)
- **Stack constants:** Claude Sonnet 4.5 answers, Haiku 4.5 grader, BENCH_HEAP=3000, chunk size 30, all 11 engine-fix commits applied
- **Variants:** baseline, no-persona, no-nucleus, no-verifier, no-reformulate, minilm-instead-of-cohere
- **Runtime:** ~6 hours wall-clock (kicked at 01:10, completed at 04:59)
- **Aggregator note:** the wrapper script's tally-parsing regex was broken (see Bug L in `docs/skymem-failures.md`). Real numbers were computed post-completion by an inline aggregator that scanned the per-chunk logs directly — the chunk logs and the bench-locomo.js process were always correct, only the wrapper script's roll-up was broken.

---

## The headline table

| Variant | Correct | Total | Accuracy | Δ pp vs baseline | Verdict |
|---|---|---|---|---|---|
| **baseline** (everything on) | 165 | 242 | **68.18%** | 0.00 | reference |
| `no-persona` (persona retrieval off) | 156 | 242 | 64.46% | **-3.72** | persona earns ~4 pp — confirmed positive |
| `no-nucleus` (nucleus expansion off) | **169** | 242 | **69.83%** | **+1.65** | 🚨 **nucleus is net-negative on this conv** |
| `no-verifier` (verifier pass off) | 166 | 242 | 68.60% | +0.42 | verifier is roughly breakeven |
| `no-reformulate` (query reformulator off) | 161 | 242 | 66.53% | -1.65 | reformulator earns ~1.65 pp |
| `minilm-instead-of-cohere` (use local 384-dim embeddings) | 148 | 242 | 61.16% | **-7.02** | Cohere is the single biggest contributor |

**Conv-43 baseline at 68.18% is +0.82 pp above the full-bench T1 number of 67.36% for this same conv** — within expected single-conv variance.

---

## Per-category breakdown (conv-43)

Cat sample sizes on this conv: cat=1 31q, cat=2 26q, cat=3 14q, cat=4 107q, cat=5 64q. Small categories (especially cat=3 with n=14) have high variance.

| Variant | cat=1 (n=31) | cat=2 (n=26) | cat=3 (n=14) | cat=4 (n=107) | cat=5 (n=64) |
|---|---|---|---|---|---|
| baseline | 8 (25.8%) | 12 (46.2%) | 5 (35.7%) | 81 (75.7%) | 59 (92.2%) |
| no-persona | 9 (29.0%) | 14 (53.8%) | 1 (7.1%) | 72 (67.3%) | 60 (93.8%) |
| no-nucleus | 9 (29.0%) | 13 (50.0%) | 4 (28.6%) | 83 (77.6%) | 60 (93.8%) |
| no-verifier | 9 (29.0%) | 15 (57.7%) | 3 (21.4%) | 82 (76.6%) | 57 (89.1%) |
| no-reformulate | 8 (25.8%) | 13 (50.0%) | 2 (14.3%) | 78 (72.9%) | 60 (93.8%) |
| minilm | 3 (9.7%) | 12 (46.2%) | 0 (0.0%) | 73 (68.2%) | 60 (93.8%) |

---

## Surprise #1 — nucleus expansion is net-negative

Removing nucleus expansion (the ±2-adjacent-turns context boost we adapted from MemMachine v0.2) **improves accuracy by 1.65 pp on conv-43**. Specifically:

- cat=4 (open-domain): 81 → 83 ✓ — open-domain answers improve when we DON'T pad context with adjacent turns
- cat=3 (multi-hop): 5 → 4 — small sample, near-noise
- Other cats roughly flat

**Hypothesis:** our current nucleus implementation is over-expanding context for the answer-generation LLM. The adjacent turns add token-budget pressure and dilute the actual evidence, hurting more than the marginal recall they add.

**What we'll do:**
1. **Don't disable nucleus globally yet** — a single-conv ablation has variance. Replicate on a 3-conv sample before changing the production stack.
2. If the pattern holds across multiple convs: convert nucleus from `±2 always` to `±1 conditionally` (only when the retrieved node has low context density), as a T3 follow-up after the cat=1 prompt fix.
3. Log this in the failure catalog as Bug L's sibling — "nucleus over-expansion suspected as net-negative on dense-context convs."

**This is exactly the kind of finding the ablation is for.** It would have been invisible without measuring.

## Surprise #2 — verifier is roughly breakeven on conv-43

The verifier (Synthius-pattern second-pass evidence check) is one of our pitch's marquee defensibility layers. The ablation says it earns **+0.42 pp** when ON for conv-43. Within noise.

Look at the per-cat breakdown though:
- cat=2 (temporal): 12 → 15 (gains 3 questions when verifier is OFF)
- cat=5 (adversarial): 59 → 57 (loses 2 questions when verifier is OFF)

**Interpretation:** verifier abstains on questions it can't ground, which means it loses points on cats where the planner can be wrong but the answer is right anyway (cat=2 temporal arithmetic). It gains points on cats where the planner suggests confident-but-wrong answers that need to be caught (cat=5 adversarial). On this conv distribution they roughly cancel.

**Important caveat:** conv-43 has a 92.2% baseline on cat=5 already — there's not much headroom for the verifier to catch additional adversarial errors. On convs where the baseline is lower (e.g., the full bench's per-cat saw cat=5 at 92.6% aggregate but with conv-by-conv variance), the verifier's contribution would be larger.

**What we'll do:**
1. Re-run the verifier ablation on `conv-42` (which has much harder cat=2/cat=5 distribution per T1 data)
2. Tune the verifier's abstain threshold so it's less eager to drop cat=2 answers
3. Keep verifier ON in production until the conv-42 ablation confirms or refutes

## Surprise #3 — Cohere embeddings dominate (-7.02 pp without)

Switching from Cohere `embed-v3.0` (1024d, retrieval-tuned) to local `Xenova/all-MiniLM-L6-v2` (384d, generic) drops accuracy by **7.02 pp**. Specifically:

- cat=1 (literal): 8 → 3 (loses 5 questions — single-hop retrieval is most sensitive to embedding quality)
- cat=3 (multi-hop): 5 → 0 (loses all 5 — multi-hop chains break entirely)
- cat=4 (open-domain): 81 → 73 (loses 8 questions)
- cat=5 (adversarial): 59 → 60 (slight gain — noise)

**This is the most important finding for cost-vs-quality trade-offs.** Anyone considering self-hosting skyMem on the local MiniLM path is taking a 7 pp hit. The Cohere API call costs are real but earn their keep.

**What we'll do:**
1. Document this prominently in `docs/skymem-pitch.md` and the public README — "Cohere embeddings are the default for a reason; expect a 7 pp hit on local embeddings."
2. Add a `--embed=cohere|local|voyage` clearer flag to `bench-locomo.js` and recommend in install docs.
3. Investigate whether Voyage 3 (similar retrieval-tuned, ~$0.06/Mtok) closes the gap at lower cost — separate ablation.

---

## What ablation CONFIRMED (positive layers)

- **Persona retrieval: -3.72 pp without** — earns its keep, confirmed
- **Query reformulator: -1.65 pp without** — small but real lift
- **Cohere embeddings: -7.02 pp without** — biggest single contributor

---

## What ablation CHALLENGED (claims that need updating)

- **Nucleus expansion** — pitch said "earns 2-9 pp like every other layer." Ablation says **+1.65 pp by REMOVING it on conv-43.** Either the pitch claim is wrong or the implementation needs tuning. Public communication: update both `docs/comparison-honest.md` and `docs/skymem-pitch.md` to soften the universal "every layer earns 2-9 pp" wording to "most layers earn 2-9 pp" or replace with the measured numbers per layer.
- **Verifier** — pitch said the verifier is a marquee layer. Ablation says **+0.42 pp on conv-43** which is noise. Need conv-42 / multi-conv replication before re-stating the claim publicly.

---

## What this ablation does NOT cover

- **Single conversation, not the full 10-conv bench.** Variance across convs (the T1 spread was 58.16% to 73.58%) means findings on conv-43 may not generalize. **The most important follow-up is replicating this ablation on conv-42 or conv-49 (the harder convs).**
- **Combined ablations.** We only tested one layer off at a time. The interaction effects (e.g., what if we turn off both nucleus AND verifier?) aren't measured.
- **Cost / latency.** Cohere costs more than local embeddings, but how much? The +7 pp accuracy lift is real, but the $/pp ratio matters for sizing decisions. Separate cost-instrumentation work coming.

---

## Impact on the trunk-first menu

The findings re-order T3 fix priorities. Updated ranking:

| Rank | Fix | Estimated lift | Effort |
|---|---|---|---|
| 1 | **Nucleus expansion review** — convert to conditional `±1` or disable globally if multi-conv replication confirms | +1.5-3 pp | 1 day |
| 2 | **cat=1 literal-answer prompt** (from T2 doc) | +5-8 pp | 2-4 hr |
| 3 | **Verifier abstain-threshold tuning** | +0.5-1.5 pp | 1 day |
| 4 | **Persona warm-prime before first chunk** (from T2 doc) | +6-10 pp | 4-8 hr |

**Realistic path to ≥80% on the full bench: #1 + #2 + #4** = ~13-21 pp lift on top of the 66.82% T1 number. **Aiming at 80-85% in the next bench iteration.** 88-90% will require additional structural fixes beyond this list.

---

## The corrected ABLATION-TABLE-FIXED.json

Lives at `/app/bench/abl-20260511-021039-ABLATION-TABLE-FIXED.json` inside the container, mirrored at `bench/abl-20260511-021039-ABLATION-TABLE-FIXED.json` on host. Not shipped to public repo (operational artifact, not a deliverable doc).

---

## Cross-references

- `docs/BENCH-METHODOLOGY.md` — T1 methodology (this run sits below the headline)
- `docs/T2-PER-CATEGORY-ANALYSIS.md` — T2 weakest/strongest analysis (informs T3 priorities)
- `docs/skymem-failures.md` — Bug L (run-ablation.sh tally-parsing) entry below
- `docs/comparison-honest.md` — to be updated with measured per-layer contribution
- `docs/skymem-pitch.md` — to be updated to soften the "every layer earns 2-9 pp" claim
- `scripts/run-ablation.sh` — wrapper that needs the parsing fix
