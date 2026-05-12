# T4 Sprint Progress

Living doc tracking the T4 sprint after T3 v2 (`t3fs-20260511-093306`, 69.23% LOCOMO). Each sub-sprint targets ONE category with ONE focused intervention, ablation-validated before going default.

---

## T4a — cat=2 temporal prompt rewrite (LANDED, NO LIFT)

**Status:** code committed (`e5412a2`), spot-tested on conv-44, **no measurable lift**. Kept in trunk as neutral — not reverted because the prompt itself is sound (anti-abstention, dataset-aligned format examples) and it didn't actively regress the spot-test conv.

**The intent (from T3 v2's Rule #4 receipt):**
Sample 30+ failed cat=2 from conv-42/43/44 (the weakest cat=2 convs, missed by T3 v1's conv-26/30 over-fit). Three failure shapes identified:
1. Over-abstention (~30%): "No information available" when transcript has clear evidence
2. Format mismatch (~40%): "Last week before X" vs expected "The week before X"
3. Wrong content (~30%): retrieval delivering wrong fact

Fix targets #1 + #2 via prompt rewrite (#3 deferred to T4b).

### The spot-test (conv-44, 158 Qs, ~30 min)

| Cat | T3 v2 conv-44 (est) | T4a conv-44 | Δ |
|---|---|---|---|
| cat=1 | ? | 46.7% (14/30) | — |
| cat=2 | ~46% | **45.8% (11/24)** | **flat** |
| cat=3 | ? | 14.3% (1/7) | small N |
| cat=4 | ? | 80.6% (50/62) | strong |
| cat=5 | ? | 94.3% (33/35) | preserved |
| **Total** | **68.99%** | **68.99% (109/158)** | **0.00** |

**conv-44 overall landed identical to T3 v2 to two decimals.** The T4a temporal prompt rewrite did not move conv-44's cat=2.

### The diagnosis — Rule #4 receipt #2

This is the **second consecutive cat=2 fix that didn't generalize the way the sample predicted.** T3 v1's cat=2 work over-fit conv-26/30; T4a's cat=2 work targeted conv-42/43/44 specifically and *still* didn't lift conv-44.

The honest read: **#1 (over-abstention) and #2 (format mismatch) were symptoms, not causes.** The actual root cause is **#3 (retrieval delivering wrong fact)** — and no prompt rewrite, however carefully phrased, can rescue a question where the answer-bearing turn isn't in the retrieved context.

Concrete example from the sample:
- Q: "How long has Nate had his turtles?" (expected: "three years")
- The transcript turn "I've had these turtles for three years now" is somewhere in conv-44's 700+ turns
- If retrieval delivers the wrong 12 turns (e.g., other Nate-mentions that don't contain the duration), the LLM correctly outputs "No information available" — because the *retrieved* context truly doesn't have it
- T4a told the model "the answer is here, find it" — but if the answer isn't actually in the retrieved context, the prompt either makes it hallucinate or it correctly continues to abstain

**Rule #4 lesson (formalised after T3 v2, validated by T4a):** Before tuning a prompt on category X, *verify that retrieval is delivering the answer-bearing turn for the failures you sampled.* If the retrieval is wrong, the prompt is treating the wrong layer.

### Why T4a stays in trunk

- The prompt rewrite is *correct in principle* — anti-abstention + dataset-aligned format are evidence-based fixes
- conv-44 spot-test was a no-op, not a regression
- Removing it would lose the format improvements on cases where retrieval IS correct
- The full T4 bench (after T4b lands) will give us the aggregate cat=2 truth

---

## T4c — nucleus=cat3only conditional mode (LANDED, NEUTRAL ON SPOT-TEST)

**Status:** code committed (`e5412a2`), spot-tested on conv-44. cat=4 stayed strong at 80.6% (architectural fit confirmed — nucleus didn't dilute cat=4 because it's gated off for non-cat=3). cat=3 sample too small (1/7) on conv-44 to read signal.

Kept in trunk pending full bench measurement. Rule #4 in action: borrowed mechanic (MemMachine nucleus pattern) kept where the T6 ablation says it earns lift (cat=3), disabled where our architecture (persona block) already does the work (cat=1/2/4/5).

---

## T4b — cat=1 retrieval-side (NEXT, ACTIVE)

**The pivot:** instead of more prompt tuning, fix the layer below it. cat=1 is at 40.78% aggregate (T3 v2) and has the *same retrieval-gap symptom* as conv-42/43/44 cat=2 — the answer-bearing fact exists in the conversation but doesn't reach the LLM's context window.

### Planned interventions
1. **Persona-fact disambiguation:** when persona block has multiple facts about a topic (e.g. 3 facts about "Nate's pets"), score them by question-relevance instead of generic match. Top-3 most-question-relevant facts win the persona slot.
2. **List-shape fan-out:** for list questions ("what kinds of X / what types of N"), retrieve top-25 instead of top-12 and aggregate items across all retrieved nodes (don't just take the single best-ranked turn).
3. **Watch cat=2 for incidental lift:** if persona disambiguation pulls the answer-bearing temporal fact into context more reliably, cat=2 on the weak convs may lift too — that would close the Rule #4 loop.

### Spot-test plan
- conv-44 (cat=1 has ~30 Qs, cat=2 has ~24 Qs, both volume-meaningful on this conv)
- Target: cat=1 from 46.7% (current) → ≥60% on conv-44
- Bonus check: cat=2 conv-44 ≥ 50% (would validate the retrieval-not-prompt hypothesis)
- If both targets hit: full T4 bench
- If only cat=1 hits: full bench anyway (cat=1 lift alone is worth ~+1.5 pp aggregate)
- If neither hits: deeper retrieval debug before bench

---

## T4 sprint scoreboard

| Sub | Target | Status | Note |
|---|---|---|---|
| T4a | cat=2 prompt | **LANDED — no lift** | Rule #4 receipt #2; kept in trunk |
| T4b | cat=1 retrieval | **ACTIVE** | persona disambiguation + list fan-out |
| T4c | cat=3 conditional nucleus | **LANDED — neutral on spot-test** | Architectural fit preserved cat=4 |
| T4d | cat=4 light tuning | **DEFERRED** | Fold into full bench after T4b |

**Aggregate target:** 72-78% (was 78-82% in T3 v2 plan; revised down after T4a flat result). T4b is the lever now.

---

## Cross-references

- `docs/T3-RESULTS.md` — T3 v2 sprint receipt (where the Rule #4 lesson was first formalised)
- `SKY-REBUILD.md` § "Discipline Rule #4" — the architectural-fit canon
- `scripts/bench-locomo.js` — T4a (line ~661) + T4c (line ~95) code
- Run tag of T4a spot-test: `t4spot-conv44-20260511-171604`
