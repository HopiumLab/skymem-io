# Failure Taxonomy — T4f (v0.4)

**Run:** `t3fs-20260512-064522` (T4f, 70.75% LOCOMO, current public best)
**Classifier:** Haiku 4.5 via `scripts/classify-failures.js` (Phase A.1)
**Date:** 2026-05-13

**This is the data that refines `EIGHTY-EIGHT-PLAN.md`.** The two strategist opinions were directionally right but assumed-rather-than-measured WHERE the leverage was. Now we know.

---

## Headline distribution (523 failures, all cats)

```
A. Extraction missing            12   (2.3%)
B. Extracted not indexed          0   (0.0%)   ← non-issue, our pipeline is solid
C. Indexed not retrieved        143  (27.3%)   ← retrieval-side
D. Retrieved not used           130  (24.9%)   ← answer-side
E. Used but wrong format        177  (33.8%)   ← answer-side, BIGGEST bucket
F. Temporal normalization        48   (9.2%)
G. Entity/alias mismatch          4   (0.8%)
H. Multi-hop intermediate         4   (0.8%)
I. Grader mismatch                5   (1.0%)
J. Actually impossible            0   (0.0%)

Retrieval-side (C):              143  (27.3%)
Answer-side (D + E):             307  (58.7%)  ← MAJORITY
Mechanical (A + B + F + G + H):   68  (13.0%)
Eval-side (I + J):                 5   (1.0%)
```

**The 30%-margin headline: answer-side (D + E) is +31.4 pp more failures than retrieval-side (C).** The strategist opinions assumed structural retrieval was the main gap. The data says **the LLM is making mistakes on data it already has** twice as often as it's missing data entirely.

---

## Per-cat breakdown (the real planning data)

| Cat | A | C | D | E | F | G | H | I | Total | Dominant |
|---|---|---|---|---|---|---|---|---|---|---|
| **cat=1** | 4 | 27 | 23 | **93** | 1 | — | — | — | 148 | **E = 63%** (format) |
| **cat=2** | — | **46** | 15 | 23 | **42** | — | — | — | 126 | **C + F = 70%** (retrieval + temporal) |
| **cat=3** | 1 | **18** | **12** | 5 | — | 1 | 4 | — | 41 | **C + D = 73%** (retrieval-side) |
| **cat=4** | 6 | **52** | **60** | **49** | 5 | 2 | — | 1 | 175 | **D + C + E split** (no dominant mode) |
| **cat=5** | 1 | — | **20** | 7 | — | 1 | — | 4 | 33 | **D = 61%** (LLM ignored evidence) |

---

## Per-cat strategic implications

### cat=1 (148 failures, the 2nd largest cat by failures)

**Data:** E = 63%, C = 18%, D = 16%. Format errors dwarf retrieval misses by 3.4×.

**Re-priority:**
- **Strongest lever:** answer-shape post-filter + better cat=1 prompt that enforces exact-format output (literal mode is too loose). Cheap, high-impact.
- Atomic fact index (strategists' T8) addresses only 18% of cat=1 failures (the C bucket). It's a valid mechanism but **not the cat=1 priority.**
- Persona-fact list aggregation addresses some of E (list-shaped questions giving partial lists) — has more leverage than atomic facts.

**Revised T8:** answer-shape rewrite for cat=1 + list-aggregation for list-shaped questions. Atomic fact index becomes a follow-on (T8b).

### cat=2 (126 failures, the cleanest mechanism map)

**Data:** C = 37%, F = 33%, E = 18%, D = 12%. Retrieval-miss + temporal-normalization dominate.

**Re-priority:**
- **T9 temporal event compiler + FTS5 is BANG ON.** Addresses C (retrieval miss with date filter) + F (ingest-time date normalization) + likely some E (canonical date output format). Together: 88% of cat=2 failures.
- This is the highest-confidence Phase B sprint. Don't overthink it.

**Revised T9:** unchanged from EIGHTY-EIGHT-PLAN. Highest priority structural mechanism.

### cat=3 (41 failures, the smallest cat)

**Data:** C = 44%, D = 29%, only **H = 4 (10%)**.

**The data contradicts the strategist assumption.** Both opinions called for "T10 graph-hop sub-query executor" because cat=3 is multi-hop. But multi-hop intermediate failures (H) are only 10% of cat=3 failures. **Cat=3 failures are mostly the same retrieval issues as cat=4 — not multi-hop chain failures.**

**Re-priority:**
- T10 graph-hop executor: still valid, but addresses ~10% of cat=3 failures (~4 questions). At 4.8% cat=3 volume, that's ~0.1 pp aggregate. Way overestimated.
- The real cat=3 win was already shipped in T4f: `RERANK_PROFILE[3] = 15` (broader cross-turn context for the C+D failures). **Extending that profile (top-18, top-20) would deliver more than building a graph-hop executor.**

**Revised T10:** demote. Cat=3 RERANK_PROFILE tuning + persona-block-for-multihop is the right work. Graph-hop executor becomes a research item if T10-tuning fails.

### cat=4 (175 failures, the kingmaker by volume)

**Data:** D = 34%, C = 30%, E = 28%. **No dominant mode.** Roughly equal split across three different failure surfaces.

**The strategist assumption (MMR diversity) addresses only the C bucket — 30% of cat=4 failures.** That caps T7's ceiling at ~+1.6 pp aggregate (52 × 30% × volume), not the +4-5 pp both opinions projected.

**Re-priority:** cat=4 needs **three coordinated mechanisms**:
- **T7a: MMR diversity** (for C=52) — addresses 30%, the strategists' play
- **T7b: cat=4 answer prompt overhaul** (for D=60) — the LLM IS seeing the evidence and ignoring it. Better prompt with "ground every claim in the context" gates. Could deliver as much as MMR.
- **T7c: cat=4 answer-shape post-filter** (for E=49) — format-strict gates. Cheapest piece.

**Revised T7:** three sub-sprints (a/b/c) within cat=4. The kingmaker doesn't have ONE answer — it needs three.

### cat=5 (33 failures, the smallest fail count)

**Data:** D = 61%, ZERO C. **Retrieval is finding everything for cat=5.** The LLM is ignoring the evidence.

**Re-priority:**
- T11 adversarial verifier (strategists' play) is valid — better post-generation check that the answer is grounded.
- But more impactful for cat=5: **better prompt that biases toward "abstain unless the question premise is clearly supported."** Cat=5 is adversarial questions; we already lean toward abstention; lean harder.

**Revised T11:** prompt-first (cheap, fast). Adversarial verifier as T11b if T11a doesn't lift.

---

## Revised Phase B priority (data-driven)

Reordered by where the data says the leverage is:

| Order | Sprint | Mechanism | Addresses | Failures | Proj agg lift |
|---|---|---|---|---|---|
| 1 | **T7** | cat=4 multi-mechanism (a: MMR + b: prompt overhaul + c: format gates) | C+D+E in cat=4 | 161 | **+2.5 to +4.5 pp** |
| 2 | **T8** | cat=1 answer-shape rewrite + list-aggregation | E + some C/D in cat=1 | 116 | **+1.5 to +2.5 pp** |
| 3 | **T9** | cat=2 temporal event compiler + FTS5 | C + F + E in cat=2 | 111 | **+1.5 to +2.5 pp** |
| 4 | **T11** | cat=5 strict abstention prompt + verifier | D in cat=5 | 20 | **+0.4 to +0.6 pp** |
| 5 | **T10** | cat=3 RERANK_PROFILE extension (top-18/20) | C+D in cat=3 | 30 | **+0.5 to +1.0 pp** |

**Cumulative projected lift: +6.4 to +11.1 pp → landing 77-82% LOCOMO.**

Honest call: the stretch case for 88% is still in play but requires **execution on all 5 sprints + each one hitting the high end of its projection**. More realistic landing is **80-83%** unless one of the sprints unlocks a step-change.

---

## What this CHANGES vs the strategist plan

| Topic | Strategist plan | What the data says |
|---|---|---|
| **Cat=4 mechanism** | MMR diversity | MMR + prompt overhaul + format gates (3 mechanisms, ~equal weight) |
| **Cat=1 priority** | Atomic fact index (T8) for retrieval | Answer-shape rewrite first; atomic facts as follow-on |
| **Cat=3 mechanism** | Graph-hop sub-query executor (T10) | RERANK_PROFILE extension; graph-hop is over-engineered for cat=3's actual failures |
| **Cat=5 priority** | Dedicated adversarial verifier | Strict abstention prompt first (cheaper); verifier as backup |
| **Overall lift estimate** | +13.7 to +19 pp (84-90%) | +6.4 to +11.1 pp (77-82%) — more realistic |

---

## What this CONFIRMS

| Topic | Strategist plan | Data confirms |
|---|---|---|
| **Cat=2 mechanism** | Temporal event compiler + FTS5 | ✓ 88% of cat=2 failures = C + F + E (all addressable by the compiler) |
| **Cat=4 is kingmaker** | Volume-weighted argument | ✓ 175 failures = largest cat fail bucket |
| **Answer-side gap is real** | Implicit ("E. used but answer style wrong") | ✓ 33.8% of all failures = E. Bigger than C. |
| **Cat=5 needs preservation** | "don't let other cats leak in" | ✓ Already at 92%, only 33 failures, mostly D (LLM-side) |

---

## What this RULES OUT

| Direction | Reason |
|---|---|
| **More extraction work** | A = 2.3%. Our extraction pipeline is solid. |
| **B (indexing) fixes** | B = 0%. Non-issue. |
| **Entity resolution sprints** | G = 0.8%. Not where the leverage is. |
| **Multi-hop chain work for cat=3** | H = 0.8%. Cat=3's failures are simpler than assumed. |
| **Grader review as a priority** | I = 1%. Real but small; revisit only if T7-T11 land. |

---

## Bench plan: how this gets validated

Per the EIGHTY-EIGHT-PLAN protocol, every Phase B sprint runs against `mini-bench-v1.json` (140 questions from these 523 failures + 28 preservation checks) before any full bench. The mini-bench was BUILT from this same T4f run, so it samples the failure distribution we just measured.

**Sprint pass criterion:** target cat's flipped-to-correct must exceed flipped-to-wrong on the mini-bench, with the target-cat slice lifting by ≥ 2 questions (the realistic minimum to clear cat=4's known ±13-question noise floor seen in T4f→T5).

---

## Cost of this analysis

523 Haiku 4.5 calls @ ~$0.0001 each = **$0.05 total.** ~12-minute runtime.

The information delivered would have taken **2-3 sprints of full-bench compute (~16 hours)** to surface via aggregate-watching alone. **Phase A pre-work is paying for itself in real-time.**

---

## Cross-references

- `docs/EIGHTY-EIGHT-PLAN.md` — the strategic synthesis this doc refines
- `docs/T4f-RESULTS.md` — the run this taxonomy is from
- `docs/T5-RESULTS.md` — the regression that locked the multi-conv protocol
- `scripts/classify-failures.js` — the classifier that generated this
- `/app/bench/t3fs-20260512-064522-failures.json` — full per-question classifications

---

**Bottom line: the strategists pointed in the right general direction (structural fixes, not parameter tweaks), but the data says half the structural fixes they prescribed were targeting minority failure modes. Phase B re-priority puts cat=4 multi-mechanism FIRST (the kingmaker with no dominant failure mode), then cat=1 answer-shape (the biggest single-mode bucket), then cat=2 temporal (the cleanest mechanism map). Realistic landing: 80-83% LOCOMO. Stretch to 88%: still possible but requires execution on all sprints + lucky compounding.**
