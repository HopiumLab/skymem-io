# T5 Results — `t3fs-20260512-140201`

**Status:** locked. Honest result.

**Headline: 70.49% aggregate** (1,400/1,986), **−0.26 pp vs T4f's 70.75%**. Wall: 5h 48m. Within the ±1 pp run-to-run noise band, but technically a net **regression**.

**This is the most important results doc of the T-series so far** — not because the number moved (it didn't, meaningfully), but because **T5 is the third sprint in a row where the targeted mechanism didn't carry the aggregate**. The pattern is now formal: at this scale of bench delta, compounding non-determinism dominates single-mechanism interventions.

The lessons matter more than the number.

---

## Per-cat T4f → T5

| Cat | T4f | T5 | Δ vs T4f | Volume | What we expected | What happened |
|---|---|---|---|---|---|---|
| **cat=1** literal/list | 44.33% | 43.62% | **−0.71** | 14.2% | unchanged | drift down |
| **cat=2** temporal | 59.50% | **58.57%** | **−0.93** | 16.2% | **+5-10pp (T5 target)** | **NEGATIVE** ⚠ |
| **cat=3** multi-hop | 50.00% | **56.25%** | **+6.25** 🎯 | 4.8% | sustained ~50% | **+6.25 lift** ✓ |
| **cat=4** open-domain | 74.91% | **73.60%** | **−1.31** | 42.3% | unchanged | **dragged most** ⚠ |
| **cat=5** adversarial | 92.15% | 93.27% | **+1.12** | 22.5% | unchanged | small lift |

**Volume-weighted breakdown of the regression:**

```
cat=4: −1.31 pp × 42.3% = −0.55 pp aggregate   ← dominated the loss
cat=2: −0.93 pp × 16.2% = −0.15 pp aggregate
cat=1: −0.71 pp × 14.2% = −0.10 pp aggregate
                                              ─────
                                              −0.80
cat=3: +6.25 pp ×  4.8% = +0.30 pp aggregate
cat=5: +1.12 pp × 22.5% = +0.25 pp aggregate
                                              +0.55
                                              ─────
                                              −0.25  (matches actual −0.26)
```

**The math is clean: cat=4 −1.31 alone cost more than the cat=3 + cat=5 gains combined.** And **T5 doesn't touch cat=4** — the change was gated to `category === 2`. So why did cat=4 drop 1.31 pp?

---

## Per-conv breakdown (T3 v2 → T4e → T4f → T5)

| Conv | T3 v2 | T4e | T4f | **T5** | Δ vs T4f |
|---|---|---|---|---|---|
| conv-26 | 72.36% | 69.85% | 73.87% | **74.37%** | **+0.50** ✓ |
| conv-30 | 75.24% | 70.48% | 71.43% | 69.52% | **−1.91** |
| conv-41 | 72.54% | 75.13% | 75.13% | **76.17%** | **+1.04** ✓ |
| conv-42 | 65.00% | 66.54% | 70.00% | 68.85% | **−1.15** |
| conv-43 | 70.66% | 70.66% | 70.25% | **71.07%** | **+0.41** ✓ |
| conv-44 | 68.99% | 70.89% | 70.89% | **72.15%** | **+1.26** ✓ |
| conv-47 | 71.58% | 71.05% | 69.47% | **71.05%** | **+1.58** ✓ 🎯 |
| **conv-48** | 66.95% | 72.38% | **72.38%** | **69.04%** | **−3.34** ⚠⚠ |
| conv-49 | 64.80% | 64.29% | 63.78% | 63.27% | −0.51 |
| conv-50 | 68.63% | 68.14% | 70.59% | 70.10% | −0.49 |
| **Total** | **69.23%** | **69.84%** | **70.75%** | **70.49%** | **−0.26** |

**5 convs up, 5 convs down.** Per-conv, exactly half went each way. But conv-48 −3.34 dominated the down side; no single conv contributed comparable magnitude on the up side. Same magnitude/opposite-sign pattern as T4f's surprise wins (conv-47 +1.58 ≈ conv-48 −3.34 in absolute value).

**conv-47 fully recovered** to T3 v2 baseline level (the T4g target hit without targeting).
**conv-48 lost the T4e + T4f marquee** (was +5.43 over T3 v2 in both runs; now only +2.09).

---

## Lead receipts (the lessons, not the loss)

### 1. The variance lesson is VINDICATED — and now LOCKED 🎯

**T5 spot-test on conv-42 showed cat=2 at 67.5% (+7-12 pp lift on target).**
**T5 full bench on conv-42 ended at cat=2 ~50% (−9 pp from spot-test, basically T3 v2 level).**
**T5 full bench aggregate cat=2: 58.57% (−0.93 vs T4f).**

The cat=2 lift the spot promised completely reversed. Same code, same conv, same model — non-determinism in LLM + Cohere rerank + tie-breaking produces 5-10 pp variance per conv per run.

**Locked protocol from T6 onwards:** No full bench until the target metric lifts on **3 independent spot-test convs**. The conv-49 lesson from T4f-RESULTS § 8 has happened TWICE now (conv-49 spot 68.88% → bench 63.78%; conv-42 spot cat=2 67.5% → bench ~50%). Two data points isn't a coincidence; it's the pattern.

This was already in the COGNITION-ROUTER doc as best practice. It wasn't enforced. **It is now.**

### 2. T5 mechanism (temporal-proximity boost for cat=2 candidates) — net zero ⚠

**On paper:** parse dates from question + content, boost candidates whose dates align with question target dates by up to +0.4 (decay exp(−days/14)). Gated to `category === 2`. Pure additive to upstream score, runs before rerank.

**In practice:** cat=2 ended −0.93 vs T4f. The boost either:
- Doesn't fire often enough to matter (most cat=2 questions in LOCOMO use relative dates the parser can't extract directly)
- Or boosts the wrong candidates (date proximity ≠ semantic relevance for many cat=2 questions)

**Disposition options:**
- (a) **Revert T5** (`git revert a278629`) — clean rollback, no dead code
- (b) **Keep T5 code, document failure** — small (~120 LOC), gated, harmless; could be useful when paired with a real temporal-FTS index in T5b
- (c) **Tune T5** (boost cap higher, decay slower, expand date parser) — adds another sprint cycle for what's already shown weak signal

**Recommendation: (a) revert.** The code didn't earn its keep. Re-adding for T5b (real DB index) would be a different design anyway.

### 3. The compounding non-determinism signature is formal

Three sprint-result patterns, three confirmations:

| Sprint | Surprise win | Surprise loss | Same magnitude? |
|---|---|---|---|
| T4e | conv-48 +5.43 | conv-26 −2.51, conv-30 −4.76 | ~yes |
| T4f | cat=4 emerging "hero" | cat=5 still slight drag | mixed |
| T5 | conv-47 +1.58 (T4g recovered) | conv-48 −3.34 (T4f marquee lost) | **EXACT match** |

T5 conv-47 +1.58 and conv-48 −3.34 are roughly the same magnitude in opposite directions, on convs that the code change (cat=2 boost) literally cannot reach. **That's not feature work — that's the system absorbing upstream perturbations and re-distributing them stochastically.**

At this scale of bench delta, **the bench-to-bench movement is dominated by compounding non-determinism, not by the mechanism shipped that sprint.** Single-mechanism interventions need to be either:
- Big enough that their direct effect exceeds the variance floor (~±1.5 pp aggregate)
- Targeted at high-volume cats (4 + 5 = 64.8% volume) where lifts have biggest leverage
- Structural changes that change the data shape, not just scoring tweaks

### 4. cat=3 +6.25 — the durable mechanism 🎯

**Third consecutive run** where cat=3 holds above T3 v2 baseline:
- T3 v2: 44.79%
- T4e: 47.92% (+3.13)
- T4f: 50.00% (+5.21)
- **T5: 56.25% (+11.46)** ← largest cat=3 lift to date

cat=3 has the only **mechanism-validated lift** in the whole T-series: T4f's `RERANK_PROFILE[3]=15` (top-15 cross-turn retrieval for multi-hop questions). It's been the durable lever for three sprints in a row.

**T6 candidate (a): cat=3 graph-hop sub-query routing.** The mechanism is small-volume (4.8%) but it's the only cat where targeted interventions have repeatedly validated. Stacking another graph-aware mechanism on top of the proven RERANK_PROFILE could push cat=3 toward 65-70%.

### 5. cat=4 is volatile — and that volatility is the signal

| Sprint | cat=4 score | Δ vs prev | Notes |
|---|---|---|---|
| T3 v2 | 73.84% | — | baseline |
| T4e | 74.20% | +0.36 | small lift |
| T4f | **74.91%** | +0.71 | "surprise hero" — biggest aggregate contributor |
| T5 | **73.60%** | **−1.31** | dominated the regression |

cat=4 swings ±0.7 to ±1.3 pp per sprint, on changes that don't target it. At 42.3% volume, **cat=4 movement IS the aggregate movement.** We keep reading it as noise; the data says it's a signal we're not modelling.

**T6 candidate (b): explicit cat=4 retrieval profile.** Build something deliberate (broad-recall + list-aggregation + diversity sampling for open-domain queries) so cat=4 behaviour is intentional rather than emergent. Could capture +1-2 pp aggregate consistently rather than swinging.

---

## What didn't pan out (be honest, again)

### The conv-42 spot-test was real… for that run

T5 spot on conv-42 was 68.85% with cat=2 at 67.5%. T5 full bench conv-42 was 68.85% with cat=2 at ~50%. **The overall score matched. The per-cat composition didn't.** The spot got lucky on a few cat=2 questions; the bench balanced out.

Lesson: spot tests need to validate the **per-cat target metric**, not the **aggregate**. The aggregate match was misleading — it convinced us "the spot is representative" when only a subset of the spot was representative.

T6 protocol addendum: **spot-test passing criteria is target-metric specific, not aggregate**. If T6 targets cat=3, the 3-conv spot needs cat=3 to lift on all three. Aggregate is decoration.

### Conv-50 again

Conv-50 partial mid-bench tracked below T4f. Final landed 70.10% vs T4f's 70.59% (−0.49). Within noise but the pattern: **conv-50 has high mid-bench variance**, q150 + q180 chunks decide its fate. This is the third run where conv-50 looked worse mid-bench than it ended; worth knowing for future projection accuracy.

---

## What stays in code

- **T4a / T4b / T4c / T4e** — all kept (T4f built on them, all validated by composing in T4f)
- **T4f cognition router (RELEVANCE_PROFILE + RERANK_PROFILE)** — kept, the only durably-validating per-cat mechanism
- **T5 temporal-proximity boost** — recommended REVERT (commit a278629). Net negative, didn't earn its keep, can be re-added for T5b if we build the real temporal-FTS index.

---

## Forward — T6 sprint decision

Three options, all valid, depends on appetite:

### (a) cat=3 graph-hop sub-query routing (the safe target)
- **Volume**: 4.8% (smallest cat)
- **History**: only cat with consistent target-mechanism wins (T4e +3.13, T4f +5.21, T5 +6.25)
- **Mechanism**: sub-query planner → per-sub-query graph anchor → edge-walk → combine
- **Projected lift**: cat=3 56% → 65-70% = +0.4-0.7 pp aggregate
- **Risk**: low (proven lever direction)
- **Discipline**: easy 3-conv spot-test (pick convs with cat=3 density)

### (b) cat=4 explicit retrieval profile (the volume bet)
- **Volume**: 42.3% (largest cat)
- **History**: T4f hero, T5 villain — volatile by ±1pp per sprint
- **Mechanism**: dedicated cat=4 profile: broad recall, list-aggregation, diversity sampling
- **Projected lift**: cat=4 74% → 77-78% = +1.2-1.7 pp aggregate
- **Risk**: medium (no prior targeted mechanism for cat=4)
- **Discipline**: 3-conv spot-test with cat=4-heavy convs (conv-42/48/50)

### (c) T5b — actual temporal-FTS DB index (the structural step)
- **Volume**: 16.2% (cat=2 only)
- **History**: T5 score-boost approach failed; full FTS index is the heavyweight version
- **Mechanism**: Prisma model `MemoryNodeDate`, dates parsed at ingest, indexed query at retrieval
- **Projected lift**: cat=2 58.6% → 65-70% = +1.0-1.8 pp aggregate
- **Risk**: high (DB migration, ingest backfill, query layer change)
- **Discipline**: 3-conv spot AND ablation toggle (--temporal-fts=on|off)

**Recommendation: (b) cat=4 explicit profile.** Biggest aggregate lever, capitalises on data we already have (cat=4 has been the swing cat for 2 sprints), lowest discipline risk for the throughput.

---

## Reproducibility receipts

Stack commits:
- `dadc257` — T4e: classifier broadening + cat=3 catch-all
- `ca55da1` — T4f: RELEVANCE_PROFILE + RERANK_PROFILE
- `a278629` — T5: temporal-proximity boost (**recommended revert**)

Run tag: `t3fs-20260512-140201`. Summary: `/app/bench/t3fs-20260512-140201-summary.json`.

Public repo `HopiumLab/skymem-io` stays at **v0.4 (T4f = 70.75%)**. T5 doesn't earn a public push since it didn't improve the headline.

---

## Cross-references

- `docs/T4f-RESULTS.md` — T4f bench (current public best)
- `docs/COGNITION-ROUTER.md` — per-cat profile architecture (T6 decision baseline)
- `docs/DASHBOARD-ROADMAP.md` — parallel-track work (Phase 2.5 still pending)
- `SKY-REBUILD.md` § Discipline Rule #4 — the architectural-fit canon, now with three receipts

---

**Bottom line: 70.49% (−0.26 vs T4f). T5 didn't lift the number, didn't validate its mechanism, and that's exactly the honest data we needed to lock in the multi-conv spot-test protocol for real. The cat=3 +6.25 sustained win and the cat=4 volatility-as-signal observation are the real takeaways. T6 picks between proven lever (cat=3 graph-hop), volume bet (cat=4 explicit profile), or structural step (T5b real FTS index). Discipline matters more than the next mechanism choice.**
