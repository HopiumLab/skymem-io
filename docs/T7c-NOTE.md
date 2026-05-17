# T7c Disposition Note — cat=4 Format Gates (E-bucket post-process)

**Status:** **REVERTED.** Failed the cat=4 ≥ 75% gate on conv-42 (73.0%), AND showed -2.80 pp regression on conv-43 — identical to T7b's downside on the same conv. Code rolled back via `git revert ea7b7e3` (revert commit `15e974b`).

**Original mechanism:** 5 deterministic post-processing transforms on cat=4 inference output (wrap-markdown strip, causal-tail strip, hedging-adverb strip, trailing-period strip, mid-sentence-preamble strip). Targeted the E-bucket (49 cat=4 "had right info, wrong shape" failures per `FAILURE-TAXONOMY-T4F.md`).

**Spot tag:** `t7c-formatgates-spot3-20260514-113420`

---

## Spot-test result (3-conv locked protocol — partial; conv-44 killed once verdict was clear)

```
            T7a       T7c       Δ vs T7a       vs 75% gate
conv-42   72.07%   73.00%      +0.93 pp        -2.00   FAIL
conv-43   78.50%   75.70%      -2.80 pp        +0.70   PASS  ⚠ regressed
conv-44   80.65%   (killed)
─────────────────────────────────────────────────────────────────
1+ FAIL on conv-42 → VERDICT: FAIL — REVERTED (commit 15e974b)
Wall: ~1.8h before kill
```

---

## What went wrong

I told you T7c was "lower risk by design than T7b" because post-processing operates on output, not generation. **That was wrong.** The grader is exact-match-sensitive enough that stripping a trailing period, a markdown wrap, or a hedging adverb is enough to flip a correct answer to wrong. The mechanism surface is different from T7b's mid-generation strictness, but the **downside surface is the same** — both can convert a correct answer into a graded-wrong one.

The conv-43 result is the clearest tell: **T7c regressed conv-43 by exactly the same -2.80 pp as T7b did.** Two completely different mechanisms (mid-gen strictness vs post-gen string strip) hitting the same regression amplitude on the same conv. That's not noise — that's a signal that **cat=4 inference shape on conv-43 has answers where any normalization is net-negative.**

Conv-42 came in at +0.93 pp (within bench noise floor). The format gates simply weren't doing enough on conv-42 to compensate for the conv-43 cost.

---

## Why T7c is different from T7a (kept) and T7b (reverted)

| Sprint | Spot result | Disposition | Why |
|---|---|---|---|
| T7a (MMR) | 2/3 PASS, +1.45 pp/conv avg | KEPT (real lift) | Retrieval-side change; stacks with later sprints |
| T7b (grounded) | 2/3 PASS but -4.6 pp net | REVERTED | Generation-side strictness; over-abstained |
| **T7c (format)** | 1/3 PASS, -1 pp net | **REVERTED** | Post-gen string strip; over-normalized |

T7a's lift came from BEFORE the model generates — better evidence selection → better answer. T7b/T7c both tried to fix the model's OUTPUT (mid-gen or post-gen) and **both regressed the same conv by the same amount**.

---

## What this teaches about cat=4 E-bucket

The original failure-taxonomy claim — "49 cat=4 failures = format/style" — looks accurate at the label level but **misleading as a fix-target indicator.** When I sampled the actual cat=4 E-bucket cases (post-T7c), the patterns I saw were:

1. Answer was structurally correct but used a synonym the grader didn't accept
2. Answer was longer than ideal but factually right
3. Answer included a hedge ("approximately X") that the grader rejected

Stripping characters can fix case 3 — but it CAN'T fix cases 1 or 2 (synonyms / length), and it CAN convert a case-1 correct answer (where the synonym happened to match because of the trailing period) into a wrong one.

**Conclusion: cat=4 E-bucket needs a smarter rewrite, not a regex strip.** That's a Haiku-call-per-answer approach (cost concern) or a learned ranker. Both bigger than a quick sprint. Deferred to Phase B-2.

---

## Disposition

| Action | Decision |
|---|---|
| **Kick full T7c bench** | ❌ FAIL gate + active regression |
| **Revert T7c code** | ✅ DONE (commit 15e974b) |
| **Tune T7c (drop the trailing-period rule)** | ❌ Each rule is small; the net regression is structural |
| **Public push** | ❌ v0.4.1 stays public |
| **T7c-RESULTS.md full doc** | ❌ Killed before full bench |
| **This note** | ✅ Disposition + lesson |

---

## What stays

- **T7a MMR diversity** (commit `4390d99`) stays in code

---

## The bigger lesson

After T5, T6, T7a (1/3 FAIL but kept for lift), T7b (REVERTED), and now T7c (REVERTED), the meta-pattern is clear:

```
Sprint        Mechanism                  Spot result    Public number moved
─────────────────────────────────────────────────────────────────────
T5 (revert)   temporal-prox boost         regression    no
T6 (kept)     RERANK 12→16                no-op         no
T7a (kept)    MMR diversity               partial win   no (unbanked)
T7b (revert)  grounded prompt (cat=4)     regression    no
T7c (revert)  format gates (cat=4)        regression    no
─────────────────────────────────────────────────────────────────────
Net 48h:      0 sprints publicly banked
```

**Three of five sprints were reverted. The two kept were never full-benched.** The "develop one mechanism, spot, decide" pattern produces noise-floor moves indistinguishable from variance. The path forward is the Phase B pivot: parallel development, stacked bench, paired diff to identify what helped.

This is documented in `docs/PHASE-B-PLAN.md`.

---

## Cross-references

- `docs/PHASE-B-PLAN.md` — strategic pivot to parallel-dev + stacked bench
- `docs/EIGHTY-EIGHT-PLAN.md` — strategic roadmap
- `docs/FAILURE-TAXONOMY-T4F.md` — the (now-questioned) failure data
- `docs/T7a-NOTE.md` — MMR partial win, stays in code
- `docs/T7b-NOTE.md` — grounded prompt, reverted
- Commit `ea7b7e3` — T7c code (reverted)
- Commit `15e974b` — the revert
- `t7c-formatgates-spot3-20260514-113420` — spot-test run tag

---

**Bottom line: T7c failed for the same structural reason as T7b — any cat=4 inference output modification (mid-gen OR post-gen) hits the same conv-43 regression. The path forward is the Phase B stacked bench. The discipline of spot-testing has served its purpose; further mechanism validation will happen via paired bench-diff, not per-mechanism spots.**
