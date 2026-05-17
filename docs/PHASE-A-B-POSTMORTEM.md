# Phase A+B Postmortem — What Didn't Move the Needle (May 9-14, 2026)

**Public benchmark before this push:** v0.4 = 70.75% (LOCOMO, 1986 questions)
**Public benchmark after this push:** v0.4 = 70.75% (unchanged)
**Sprints attempted:** 7 (T5, T6, T7a, T7b, T7c, T8, T8b)
**Sprints reverted:** 4 (T5, T7b, T7c, T8b pending)
**Sprints kept but never full-benched:** 1 (T7a)
**Sprints kept as no-op:** 1 (T6)
**Net banked progress:** 0.0 pp

This document is a candid record of every mechanism we tried over the
last 5 days and why it didn't bank a public-number win. Ordered
chronologically. The goal is to make the meta-pattern legible enough that
the next idea can avoid the same traps.

---

## TL;DR — the meta-pattern

Every sprint followed the same shape:
1. **Hypothesis** from failure-data analysis or strategic theory
2. **Spot-test** on 1-3 specific LOCOMO conversations
3. **Either:** spot looked good → keep / full bench; **or:** spot regressed → revert
4. **Reality:** even "good" spots either didn't generalize to the full bench (T7a) or were below bench noise floor when summed (T7c)

The root issue we keep tripping over is **bench variance**. Each LOCOMO
conv shows ±2-3 pp swings per category per run from stochastic LLM
behaviour. A mechanism with +1 pp true effect is statistically
indistinguishable from a -1 pp mechanism inside any single 3-conv spot.
The discipline of spotting "caught" 4 regressions in the sense of
killing them before full bench — but it failed to validate any banking
mechanism, because the same noise that hides regressions also hides
real wins.

---

## Sprint log (chronological)

### T5 — Temporal-proximity boost in retrieval

| Field | Value |
|---|---|
| **Hypothesis** | cat=2 (temporal) failures correlated with retrieval missing the right session. Boost recency-of-mention in scoring would surface temporal-anchor turns. |
| **Mechanism** | Added temporal-proximity weight to retrieval scoring for cat=2 questions. |
| **Spot result** | conv-42 cat=2 +7-12 pp. Looked great. |
| **Full bench** | -0.93 pp aggregate. Reversed direction at scale. |
| **Disposition** | **REVERTED.** Full-benched without spot-test, lost ~5.5h compute. |
| **Lesson** | Single-conv spots don't generalize. Established the "locked 3-conv protocol" after this. |

### T6 — RERANK_TOPN 12 → 16

| Field | Value |
|---|---|
| **Hypothesis** | More rerank candidates → better top-K selection → fewer C-bucket retrieval misses. |
| **Mechanism** | Bumped `RERANK_TOPN` from 12 to 16 for the default profile. |
| **Spot result** | 2/3 PASS on conv-42/43/44 spot. conv-42 showed regression, others held. |
| **Full bench** | Not run (no clear lift signal). |
| **Disposition** | **KEPT as no-op.** Zero net effect; the protocol's first conv-dependency catch. |
| **Lesson** | Parameter tweaks under bench variance produce conv-dependent results. "No-op" is a real disposition. |

### T7a — MMR (Maximal Marginal Relevance) diversity in rerank

| Field | Value |
|---|---|
| **Hypothesis** | Cat=4 inference questions often have redundant top candidates. Diversity selection via token-Jaccard MMR (λ=0.5) would broaden coverage of distinct facts. |
| **Mechanism** | Added `selectWithMMR()` after rerank for cat=4 non-list questions. |
| **Spot result** | 2/3 PASS: conv-42 +0.90, conv-43 +0.07, conv-44 +0.00. Net **+1.45 pp/conv cat=4 avg**. |
| **Full bench** | **Never run.** |
| **Disposition** | **KEPT in code but unbanked.** |
| **Lesson** | "Partial win" + "stacks with later sprints" was the rationale. In the Phase B partial bench, **conv-26 cat=4 stayed -8.57 vs T4f baseline** even after T8 was fixed — strongly suggesting T7a's spot win on convs 42/43/44 **doesn't generalize** to other convs. T7a's status is now suspicious. |
| **Commit** | `4390d99` |

### T7b — Cat=4 grounded-inference prompt (D-bucket targeted)

| Field | Value |
|---|---|
| **Hypothesis** | Failure-taxonomy D-bucket = 60 cat=4 "LLM ignored evidence" failures. A strict "ground every claim in transcript text" prompt would force anchoring. |
| **Mechanism** | Rewrote cat=4 inference prompt with anti-preamble rules + "ground every claim" + 3 YES + 1 NO few-shot example. |
| **Spot result** | conv-42 -1.80, conv-43 -2.80, conv-44 +0.00. **Net -4.60 pp/conv, 2 of 3 regressed.** |
| **Disposition** | **REVERTED.** |
| **Lesson** | "Strictness shifts failures from wrong-synthesis to no-answer/over-literal — both still grade wrong." D-bucket has at least two sub-modes (easy and hard); strictness only helps easy and actively hurts hard. |
| **Commits** | `2f89229` → `dafa59f` (revert) |

### T7c — Cat=4 format gates (E-bucket post-process)

| Field | Value |
|---|---|
| **Hypothesis** | Failure-taxonomy E-bucket = 49 cat=4 "had right info, wrong shape" failures. Deterministic post-gen string transforms (strip markdown wrap, causal tail, hedging adverbs, trailing periods, mid-sentence preambles) would conform answers to grader-accepted form. |
| **Mechanism** | `applyCat4FormatGates()` function with 5 transforms, gated to cat=4 inference shape. |
| **Spot result** | conv-42 +0.93, conv-43 **-2.80** (matched T7b's regression amplitude exactly), conv-44 killed. FAIL gate on conv-42 (73.0% < 75%). |
| **Disposition** | **REVERTED.** |
| **Lesson** | "Lower risk by design" was wrong. Post-gen stripping can convert a correct answer to wrong if the stripped character was incidentally part of the grader-match string. The fact that two structurally different mechanisms (T7b mid-gen vs T7c post-gen) hit the **same -2.80 pp on conv-43** suggests cat=4 inference output on conv-43 has many borderline-correct answers where any normalization is net-negative. |
| **Commits** | `ea7b7e3` → `15e974b` (revert) |

### T8 — Cat=1 list-shape expansion (initial)

| Field | Value |
|---|---|
| **Hypothesis** | Failure-taxonomy E-bucket cat=1 = 93 failures Haiku-labelled "format" but actually **list-aggregation under-enumeration**: the shape classifier missed adjective-intervening patterns ("what **outdoor** activities") and the noun whitelist was incomplete. |
| **Mechanism** | Expanded `listPatterns` regex to allow 0-2 intervening adjectives + 80-noun whitelist. Tightened list-shape system prompt with subject-noun identification + enumeration discipline. |
| **Spot result** | Skipped per Phase B "stack and full-bench" strategy. |
| **Phase B partial bench** | conv-26 total **63.82% (was 73.87%, -10.05 pp)**. cat=4 -11.43 pp. cat=3 -23.08 pp. cat=1 -21.87 pp. |
| **Disposition** | Patched in T8b (intent-scope gate), but the cat=1 lift never materialized even after the gate. |
| **Lesson** | The expanded regex was too greedy — pulled cat=3 and cat=4 questions into the list-aggregation prompt. Also: the new list-prompt rules didn't actually help cat=1 (see T8b). |
| **Commits** | `fe90ca7` |

### T8b — T8 gated to category===1 only

| Field | Value |
|---|---|
| **Hypothesis** | T8's intent was cat=1-specific. Gating the new regex to `category === 1` would fix the cat=3/4 collateral damage while preserving the cat=1 lift. |
| **Mechanism** | Split `listPatterns` into `baseListPatterns` (all categories, T4e/T3a unchanged) and `t8ListPatterns` (cat=1 only). |
| **Standalone test** | 24/24 routing tests pass — cat=1 list cases route to list, cat=4 T8-noun questions stay in inference. |
| **Verify spot (conv-26 + conv-30)** | conv-26 65.83% (still -8.04 vs T4f), conv-30 65.71% (-5.72 vs T4f). Combined **65.79% vs T4f 73.03% = -7.24 pp.** |
| **Disposition** | Pending — the gate fix recovered cat=4 and cat=3 partially, but **cat=1 did not lift at all** (31.25% / 27.27% — identical to pre-fix). |
| **Lesson** | The T8 mechanism was targeting the wrong layer. Cat=1 list-aggregation failures aren't fixed by a better prompt — the **retrieved context often doesn't contain all the list items**, so the model literally can't enumerate them no matter how good the prompt is. This is **retrieval-side (C-bucket)** wearing E-bucket clothing in the Haiku-classified taxonomy. |
| **Commits** | `4e6bc27` |

### T9 — Cat=2 temporal format conversion

| Field | Value |
|---|---|
| **Hypothesis** | Cat=2 E+F bucket failures dominated by **deterministic format mismatches**: "Last week before [date]" should be "The week before [date]"; "Last month (relative to [date])" should resolve to "September 2023". |
| **Mechanism** | `applyCat2TemporalFormat()` post-process on shape=temporal output: F1 rule "Last X before DATE" → "The X before DATE"; F2 rule resolves "(relative to DATE)" anchors. |
| **Standalone test** | 15/15 cases pass including 7 negatives (untouched). |
| **Phase B partial bench** | conv-26 cat=2: 62.16% → 56.76% (-5.40 pp). conv-30 cat=2: 69.23% → 69.23% (0.00). |
| **T8b verify spot** | conv-26 cat=2: 59.46% (+2.70 vs pre-fix). conv-30 cat=2: 65.38% (-3.85 vs pre-fix). |
| **Disposition** | **Net-zero or slightly negative.** The transforms target *specific* documented failure shapes but they fire on EVERY temporal output, and some originally-correct answers are getting modified into newly-wrong ones. |
| **Lesson** | "Conservative by design" wasn't enough. The mechanism would need to fire ONLY on outputs that look like the documented failure patterns AND not on outputs that were originally correct. Hard to gate without per-question knowledge. |
| **Commits** | `387ebe2` |

### T11 — Cat=5 dedicated shape branch (yes/no + premise tolerance)

| Field | Value |
|---|---|
| **Hypothesis** | Cat=5 (adversarial) failure samples showed: (a) yes/no answers padded with explanation get graded wrong, (b) "premise-correction" failures where the model says "No, X happened not Y" instead of answering the underlying ask. |
| **Mechanism** | New `cat5` shape branch in `classifyAnswerShape()`. Dedicated cat=5 prompt with three rules: (1) yes/no = ONE WORD, (2) don't correct slightly-wrong premises, (3) abstain when truly unanswerable. Post-gen `applyCat5YesNoTruncation()` to enforce one-word answers. |
| **Standalone test** | 11/11 pass — caught a critical "No information available → No" abstention-strip bug before commit. |
| **Phase B partial** | cat=5 unchanged on conv-26 (85.11%), unchanged on conv-30 (95.83%). Neutral. |
| **T8b verify spot** | conv-26 cat=5: 85.11% (unchanged). **conv-30 cat=5: 91.67% (-4.16 vs baseline).** |
| **Disposition** | Two-conv signal too small to be confident. Slightly net-negative on the second spot run. |
| **Lesson** | Even the "obvious" yes/no truncation has downsides we can't anticipate. cat=5 was at 92-93% baseline; the room to grow is tiny and the risk of regression is real. |
| **Commits** | `7e7c3e1` |

---

## Strategic pivots (and why they also didn't work)

### Pivot 1: Locked 3-conv spot protocol

**After T5 regression**, we required a mechanism to pass on 3 specific
convs (42/43/44) before full bench. The intent: catch regressions cheaply.

**Result:** Protocol successfully killed T7b and T7c before full bench
(saving ~7h compute). But also created a **false positive** for T7a —
the spot win on 42/43/44 didn't generalize to convs 26/30. The 3-conv
spot is too small a sample.

### Pivot 2: Stratified mini-bench (Phase A.2)

**Built scripts/spot-mini-bench.js** — selects 140 stratified failures
from a reference run, allows targeted re-evaluation.

**Result:** Built but never used. The discovery that the failure
taxonomy class labels were unreliable (see Pivot 4) made the stratified
sample harder to interpret.

### Pivot 3: Paired bench-diff (Phase A.3)

**Built scripts/bench-diff.js** — compares two run tags at question-level
to find flipped-to-correct vs flipped-to-wrong cases.

**Result:** Used once on T4f-vs-T5 to confirm the regression direction.
Otherwise unused because no two recent runs both completed full bench.

### Pivot 4: "Read the actual failures, not the taxonomy labels"

**Realized mid-Phase B** that the Haiku-classified buckets (E/F/D)
were misleading. Sampled actual cat=1 E-bucket cases → saw they were
list-aggregation failures, not format failures. This led to T8.

**Result:** Reading actual failures gave better intuition than the labels
— but as T8 → T8b → still no cat=1 lift demonstrated, the actual
mechanism was at a still-wrong layer. The real cat=1 problem is
retrieval-side (missing items in context), not shape-routing.

### Pivot 5: "Skip the spots, develop in parallel, ship the stack"

**The Phase B plan** — stop dribbling 2h spots, develop T8/T9/T11 in
parallel, run one full bench, use bench-diff to localize regressions
post-hoc.

**Result:** First full Phase B bench regressed -8.23 pp on the first
2 convs. Killed at conv-41. The "stack" approach failed because
**every individual mechanism had some downside** we hadn't anticipated.
Stacking 4 ±2-pp-uncertain mechanisms compounds the noise, not the wins.

---

## What we now know that we didn't on May 9

1. **Bench variance is huge.** A single LOCOMO conv shows ±2-3 pp per
   category swing run-to-run from stochastic LLM behaviour. A mechanism
   with +1 pp true effect can't be distinguished from -1 pp inside any
   3-conv spot.

2. **Spot wins don't generalize.** T7a's +1.45 pp/conv cat=4 lift on
   convs 42/43/44 became a -8.57 pp cat=4 *regression* on conv-26 when
   stacked with T8b. The conv set matters more than we modeled.

3. **The Haiku-classified failure taxonomy is unreliable.** "E-bucket"
   cat=1 failures were labelled "format" but were actually
   list-aggregation problems. We were targeting the wrong layer for two
   sprints (T7c, T8) because we trusted the labels.

4. **Post-gen strips fail predictably.** Both T7b (mid-gen strictness)
   and T7c (post-gen stripping) hit the same -2.80 pp regression on
   conv-43 — different mechanisms, same downside surface. Cat=4
   inference outputs have many borderline-correct answers where any
   normalization is net-negative.

5. **Retrieval-side dominates cat=1.** The cat=1 E-bucket failures we
   tried to fix with prompt rewrites are mostly missing-item-in-context
   problems — the model can't enumerate items it can't see. This requires
   multi-turn retrieval expansion, not better prompts. (Equivalent to
   T9-events temporal compiler concept, but for list-of-fact questions.)

6. **The discipline saved us from worse outcomes.** T5 wasted ~5.5h
   on a full bench. T6/T7b/T7c/T8 were caught by spots or partial bench.
   Without the protocol, we'd be at v0.5 = 68% public benchmark right
   now, not 70.75%.

---

## What we still don't know

1. **What's the actual bench variance?** We've never run the same code
   twice and measured the per-question disagreement rate. Phase A.4
   (cached replay mode) was designed to address this but was deferred.
   Without this number, we can't separate "mechanism" from "noise".

2. **Is T7a actually a win?** Spot says yes (+1.45 pp/conv on 3 convs),
   partial bench says possibly no (cat=4 still -8.57 on conv-26 with T8b).
   Need a clean T7a-alone full bench to know.

3. **Is the retrieval layer or the generation layer the bigger lever?**
   Failure taxonomy (now suspicious) suggested generation-side dominates,
   but the cat=1 retrieval observation suggests the opposite. We don't
   have evidence to choose.

4. **Why does cat=3 drop so hard on conv-26 under any change?** T4f =
   84.62%, every Phase B variant pulls it down 15-23 pp. This is the
   biggest single regression we keep hitting and we don't understand the
   mechanism.

5. **Are conv-42/43/44 spots representative of anything?** We chose them
   because they're medium-size and varied. But T7a, T7b, T7c, T8 all
   showed conv-42 doing better than conv-26 — maybe conv-42 has
   systematically easier questions for our retrieval profile.

---

## Possible directions forward (not prescriptive)

These are NOT recommendations — they're options to consider.

**Direction A: Revert everything to T4f, ship 70.75 as v0.5 stable.**
Stop the bench grind. Pivot effort to dashboard, docs, integrations, the
public surface area. Come back to the bench when there's a new idea.

**Direction B: T7a-alone validation.**
Revert T8/T8b/T9/T11. Run one clean full bench with just T7a (MMR) added
to T4f. Either bank T7a as v0.5 (~71-72%) or revert and ship T4f.

**Direction C: Diagnose the noise first.**
Build Phase A.4 (cached replay): re-run a single bench with seed control,
measure per-question disagreement rate over 3 seeds. Establish the
variance floor before any more mechanism work. ~6h infrastructure, then
mechanism work resumes with confidence intervals.

**Direction D: Retrieval-side push.**
The pattern across cat=1 and cat=2 failures keeps pointing at retrieval.
Build T9-events (temporal events table + FTS5 index) for cat=2, and a
similar multi-turn list-aggregation retrieval for cat=1. Bigger
infrastructure investment, longer dev cycle, but addresses the
*actual* root cause we keep observing.

**Direction E: Acknowledge bench non-determinism and pivot benchmark.**
LOCOMO has many subtleties (grader semantics, conv selection, question
phrasing) that make small mechanism gains hard to validate. Build or
adopt a different eval that gives more deterministic signal — narrow
question sets, exact-match grading, multiple seeds.

---

## Files of record

- `docs/EIGHTY-EIGHT-PLAN.md` — original strategic roadmap (now overtaken)
- `docs/FAILURE-TAXONOMY-T4F.md` — the 523-question Haiku-classified failure data (now suspicious)
- `docs/PHASE-B-PLAN.md` — the parallel-dev-+-stacked-bench strategy
- `docs/T6-NOTE.md`, `T7a-NOTE.md`, `T7b-NOTE.md`, `T7c-NOTE.md` — per-sprint disposition notes
- `scripts/bench-locomo.js` — the bench runner (with all sprints' code)
- `scripts/spot-test-3.sh` — locked 3-conv protocol runner
- `scripts/phase-b-full-bench.sh` — 10-conv stacked-bench runner
- `scripts/classify-failures.js`, `scripts/bench-diff.js`, `scripts/spot-mini-bench.js` — Phase A diagnostic tooling (mostly unused)

---

**Bottom line:** Seven sprints in five days, zero banked progress on the
public number. The discipline saved us from worse outcomes (would have
been 68-69% had we shipped any of T5/T7b/T7c/T8 to full bench without
guards). The mechanisms each had real ideas behind them but every one
hit the same bench-variance wall. The honest assessment is that we
don't yet understand the variance well enough to do mechanism work
productively. **The next decision is whether to stop, recalibrate, or
push through to a different layer.**

— recorded May 14, 2026
