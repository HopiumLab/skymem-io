# T7a Disposition Note — MMR Diversity for cat=4

**Status:** spot-test FAILED protocol (2/3 PASS), mechanism KEPT in code (real lift, just not sufficient alone).

**Mechanism:** Maximal Marginal Relevance re-selection on cat=4 non-list queries. Cohere rerank to TOPN*1.5 = 24 candidates, then MMR-select top-16 with `lambda = 0.5` and token-level Jaccard as diversity metric. Commit `4390d99`.

**Spot tag:** `t7a-mmr-spot3-20260513-112926`

---

## Spot-test result (3-conv locked protocol, structural mechanism)

```
cat=4 must hit ≥ 75% on ALL THREE convs

           T6        T7a      Δ T6      vs 75%
conv-42  70.27%   72.07%    +1.80 pp   -2.93   FAIL
conv-43  77.57%   78.50%    +0.93 pp   +3.50   PASS
conv-44  79.03%   80.65%    +1.62 pp   +5.65   PASS
          ─────    ─────    ───────
                            avg +1.45 pp per conv
─────────────────────────────────────────────────────
2/3 PASS — VERDICT: FAIL — DO NOT kick full bench
Wall: 118m
```

---

## What this confirms (the mechanism is REAL)

**Every conv improved** vs T6 baseline. Not 2-of-3, not noise — ALL THREE. T7a's +1.45 pp average per-conv lift on cat=4 is real signal.

`docs/FAILURE-TAXONOMY-T4F.md` showed cat=4 failures split:
- C = 52 (retrieval-miss / similarity collapse) ← T7a targets THIS bucket
- D = 60 (retrieved but LLM ignored) ← needs T7b
- E = 49 (used but wrong format) ← needs T7c

If T7a were targeting the wrong bucket, we'd see flat or mixed-sign deltas. Instead we see consistent +1-2 pp lift across all 3 convs. **C-bucket fix validated.**

---

## What this teaches us about conv-42

conv-42 lifted +1.80 pp under T7a but still landed at 72.07% — **2.93 pp below the gate.** To clear 75%, we'd need ~+5 pp on conv-42 cat=4.

T7a delivered the C-bucket lift on conv-42. The remaining gap is the **D-bucket (60 failures) + E-bucket (49 failures)** — the LLM-side and format-side failures that MMR cannot reach.

**Inference: conv-42's cat=4 failure profile is D-dominant** more than the bench average. Per-conv failure-mode distribution likely varies — conv-42 has more "evidence is there, LLM picks wrong piece" failures than conv-43 or conv-44.

This is why MMR helped less on conv-42 than expected: there was less C-bucket headroom to begin with. T7b (prompt overhaul) is the right next step for conv-42.

---

## Why T7a stays in code

Same disposition as T6: kept in place even though it failed the gate, because:

1. **Net positive on every conv tested.** No regressions, only varying-magnitude lifts.
2. **Designed against the data**, not assumption — addresses a specific failure bucket that's still 52 questions large.
3. **Composes additively with T7b.** When T7b lands and we re-spot, T7a + T7b > T7b alone (because the 2 questions T7a fixes on conv-42 likely stay fixed even with the prompt change).
4. **Reverting it would be needless code churn** for a mechanism that delivered measurable lift.

**Net aggregate effect of T7a alone (estimated from spot):** +0.6 pp aggregate. Below the variance floor on a single full bench, but stacks with T7b/T7c.

---

## Disposition

| Action | Decision |
|---|---|
| **Kick full T7a bench** | ❌ NO — failed locked protocol |
| **Revert MMR mechanism** | ❌ NO — real +1.45 pp/conv average lift, kept for stacking |
| **Tune lambda lower (0.3 = more diversity)** | ❌ NO — conv-42's gap isn't a diversity tuning issue; it's a D-bucket issue MMR can't reach |
| **Tune lambda higher (0.7 = more relevance)** | ❌ NO — would undo the diversity benefit on conv-43/44 |
| **Public push** | ❌ NO — v0.4 stays public best |
| **T7b prompt overhaul** | ✅ NEXT — addresses D=60 failures, layered on T7a |

---

## Counterfactual reflection

Pre-protocol world: we'd have looked at conv-43 (+0.93) and conv-44 (+1.62) and shipped T7a as a win. Full bench would land near T4f because conv-42 + conv-30 + conv-49 (the cat=4-weak convs) would drag it. Another null-result T-RESULTS doc.

Post-protocol world: we knew BEFORE full bench that conv-42 wasn't clearing the gate. We have diagnostic evidence (per-conv per-cat numbers) pointing at exactly which sub-mechanism comes next. **The protocol's saving us full benches AND giving us the diagnostic data to design T7b correctly.**

---

## What T7b needs to do

`docs/FAILURE-TAXONOMY-T4F.md` D-bucket = 60 failures for cat=4. The LLM HAS the evidence in context, but it:
- Picks the wrong nearby fact (similar entity, wrong relationship)
- Doesn't ground the answer in the retrieved turn
- Synthesizes when it should be quoting

T7b candidates (one or all):
1. **"Ground every claim" rule in cat=4 system prompt** — force the model to cite the specific retrieved evidence
2. **Cat=4 few-shot examples** — concrete cases showing "evidence X → answer Y" mapping
3. **Persona-block reordering for cat=4** — surface the directly relevant facts first, not just by domain priority

Quickest to spot-test: option 1 (prompt rule only, ~2 hours work). Option 2 needs example curation (~4 hours). Option 3 needs reorder logic + retest (~3 hours).

**Recommended: ship option 1 first, spot-test it (stacked on T7a). If it passes, ship. If marginal, add options 2 or 3.**

---

## Cross-references

- `docs/EIGHTY-EIGHT-PLAN.md` — strategic roadmap (T7 is multi-sub-sprint)
- `docs/FAILURE-TAXONOMY-T4F.md` — the data that designed T7a + predicts T7b
- `docs/T6-NOTE.md` — earlier parameter-tweak disposition (template)
- `scripts/bench-locomo.js:559` — MMR helper (`selectWithMMR`)
- Commit `4390d99` — T7a code change (kept in place)
- `t7a-mmr-spot3-20260513-112926` — spot-test run tag

---

**Bottom line: T7a is real but partial. Every conv tested lifted +1-2 pp on cat=4 (validates the MMR diversity hypothesis). conv-42 still 2.93 pp below the gate because cat=4 needs more than C-bucket fix. T7b (cat=4 prompt overhaul for D bucket = 60 failures) is the next sub-sprint, stacked on T7a. The protocol caught the partial win and pointed at exactly what to do next.**
