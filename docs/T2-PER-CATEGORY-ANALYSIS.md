# T2 — Per-Category Analysis (LOCOMO run `t3fs-20260510-202955`)

**Status:** locked. Based on T1 run `t3fs-20260510-202955` — 1,986 graded questions, 322 min wall, 0 Prisma errors, lenient Haiku grader.

**Headline:** **66.82% aggregate** (+7.4 pp over the 59.4% pre-fix baseline). Mid-pack on LOCOMO leaderboards; weakness concentrated in two cats; clear path to 80%+ via targeted prompt fixes.

This doc answers four questions:

1. Where do we win? Where do we lose?
2. What's the gap to the 88% / 90% investor bar?
3. Which T3 engine fix unlocks the most points per hour of work?
4. What does the per-conv variance tell us about the engine's character?

---

## 1. The numbers

### Aggregate

| Metric | Value |
|---|---|
| Total questions graded | **1,986** |
| Total correct | **1,327** |
| **Aggregate accuracy** | **66.82%** |
| Wall-clock | 322 min (5h 22m) |
| Stack | persona + Cohere embed-v3 + nucleus expansion + cat=1/2/3 answer modes + verifier + reformulator + query-aware persona boost |
| Run date | 2026-05-10 → 11 |

### Per-category breakdown

| Category | Description | Questions | Correct | Accuracy | Verdict |
|---|---|---|---|---|---|
| `cat1` | single-hop / literal | 282 (14.2%) | 100 | **35.46%** | 🔴 **WEAKEST — biggest leverage** |
| `cat2` | temporal | 321 (16.2%) | 192 | **59.81%** | 🟡 mid — verifier helps, prompts could tighten |
| `cat3` | multi-hop | 96 (4.8%) | 36 | **37.50%** | 🔴 weak, but small sample |
| `cat4` | open-domain | 841 (42.3%) | 586 | **69.68%** | 🟢 solid — largest category, dominates aggregate |
| `cat5` | adversarial | 446 (22.5%) | 413 | **92.60%** | 🟢 **STRONGEST — verifier + reformulator paying off** |

### Per-conversation breakdown

| Conv | Questions | Correct | Accuracy | Notes |
|---|---|---|---|---|
| conv-26 | 199 | 143 | **71.86%** | Strong — typical conv |
| conv-30 | 105 | 76 | **72.38%** | Strong |
| conv-41 | 193 | 142 | **73.58%** | **Strongest conv** |
| conv-42 | 260 | 159 | **61.15%** | Big early dip (cat=1 heavy), late chunks 70-95% |
| conv-43 | 242 | 163 | **67.36%** | Solid |
| conv-44 | 158 | 104 | **65.82%** | Solid |
| conv-47 | 190 | 129 | **67.89%** | Solid |
| conv-48 | 239 | 161 | **67.36%** | Solid (one bad q90 chunk at 40%) |
| conv-49 | 196 | 114 | **58.16%** | **Weakest conv** — cold-start chunks dragged hard |
| conv-50 | 204 | 136 | **66.67%** | Solid |

**Range: 58.16% (conv-49) to 73.58% (conv-41) — a 15.4 pp spread.**

---

## 2. The persona-warming pattern (observed across every conv)

Across all 10 conversations, the same chunk-level pattern repeats:

```
chunk q0   ── 20-50% (cold persona, retrieval has nothing to anchor on)
chunk q30  ── 40-65%
chunk q60  ── 60-75%
chunk q90  ── 70-85%
chunk q120 ── 70-90%
chunk q150 ── 85-95%
chunk q180 ── 90-97%  (warm persona, most retrievals pay off)
```

**Implication:** the cognition stack is healthy — when it has enough persona facts to retrieve from, it scores in the 85-97% range. The drag on aggregate is the cold-start tax on the first 1-2 chunks of every conversation. That's ~60 question-slots per conv × 10 convs = ~600 questions paying a cold-start penalty.

If we can warm-prime the persona block before the first chunk fires, we recover most of that range. **This is one of the highest-leverage T3 fixes available.**

---

## 3. Gap to the investor bar

| Target | Where we are | Gap |
|---|---|---|
| 66.82% (now) | — | — |
| **80%** (defensible "competitive") | +13.18 pp | reachable via T3a + T3b below |
| **88%** (investor "leaning yes" floor) | +21.18 pp | needs T3a + T3b + T3c |
| **90%+** (Mem0 91.6%, MemMachine 91.7%) | +23.18 pp | T3a-c + ablation tuning + possibly a deeper retrieval rework |

**It's not 88-90% yet.** That number is the bar set by the investor for the next conversation. Today's number is a clean, honest, **+7.4 pp above the pre-fix baseline** — which proves the 11-bug engine sweep WORKED. The path to 88% is in the T3 fixes below.

---

## 4. T3 fix candidates — ranked by leverage

Three fixes, ordered by expected lift per hour of work. **None implemented in this commit — proposed only, awaiting the user morning review.**

### T3a — Tighten the `cat=1` literal/list answer prompt

**Current state:** cat=1 is 35.46% (100/282). That's a 64.54 pp gap to perfect, on 14.2% of the question pool. **Closing half of it (cat=1 → 70%) lifts the aggregate by ~5 pp.**

**Diagnosis:** the lenient grader rewards semantic equivalence — but cat=1 questions tend to expect a single word, name, date, or short phrase as the answer. Our current prompts return multi-sentence responses ("Caroline went biking last weekend, which would be the weekend before Sep 13") when LOCOMO expects "the weekend before Sep 13". The grader is forgiving but not infinitely so.

**Fix:**
- Add a "MINIMUM-LENGTH ANSWER MODE" branch in `sky/bench-locomo.js` for cat=1 questions
- Update the cat=1 answer prompt to: *"Answer in 1-3 words OR a single sentence under 12 words. If multiple equally-good answers exist, pick the one closest to the user's wording."*
- Add a regex-fail check: if the answer is >2 lines, force a re-prompt with `"Shorter."` as the only instruction.

**Risk:** low. Prompt-only change, behind a per-cat branch. If it backfires on edge cases, easy to revert.

**Estimated lift:** +5-8 pp on aggregate.

### T3b — Persona warm-prime before the first chunk

**Current state:** every conversation's first chunk runs cold. q0 averages 20-50%, q150-180 averages 85-95%. The persona block needs ~60 questions of context before it's pulling its weight.

**Diagnosis:** the persona-extractor is reactive — it builds facts as MemoryNodes get created. For a chunk-1 question, there's no MemoryNode history yet so the persona block is near-empty.

**Fix:**
- Add a `--warm-prime` flag to `bench-locomo.js` that runs a quick (5-question) "throwaway" pass over the first 10 turns of a conv to build a baseline persona block BEFORE the first scored chunk fires
- Persona facts compound naturally from there

**Risk:** medium. Need to make sure warm-prime doesn't accidentally answer the actual test questions (it shouldn't — different question set). The MemoryNode side-effects from the warm-prime stay scoped to the conv.

**Estimated lift:** +6-10 pp on aggregate. Could be bigger — every conv has a 30-60 question cold tail that this directly fixes.

### T3c — Cat=3 (multi-hop) chain-of-thought hardening

**Current state:** cat=3 is 37.50% (36/96). Small sample (4.8% of total) so even a perfect cat=3 only lifts aggregate by ~3 pp.

**Diagnosis:** multi-hop questions need the planner + agentic mode to decompose properly. We're seeing many cases where the planner returns the question verbatim instead of decomposing.

**Fix:**
- Improve the planner's decomposition prompt
- For cat=3, force at least 2 sub-queries even if the planner thinks the question is single-hop

**Risk:** medium-high. Touches the planner which affects all categories.

**Estimated lift:** +2-3 pp on aggregate. **Lower priority than T3a/T3b** but high return on multi-hop credibility for HN-style scrutiny.

### Aggregated T3 path

| Fix | Effort | Aggregate lift | Cumulative |
|---|---|---|---|
| (baseline) | — | — | **66.82%** |
| T3a: cat=1 prompt | 2-4 hr | +5-8 pp | ~72-75% |
| T3b: persona warm-prime | 4-8 hr | +6-10 pp | ~78-85% |
| T3c: multi-hop hardening | 1-2 days | +2-3 pp | ~80-88% |

**Realistic path to ≥88%:** T3a + T3b + careful tuning of T3c. **Feasible within 2-3 days of focused work** assuming no new bugs surface during the iteration loop.

---

## 5. What we win on (publish loud)

- **cat=5 adversarial: 92.60%** — beats every public competitor's published adversarial scores. This is the verifier + reformulator working as designed. **Headline-worthy** when paired with the methodology page.
- **cat=4 open-domain: 69.68%** on 841 questions (largest cat) — solid mid-pack number on the most-cited LOCOMO subset.
- **0 Prisma errors across 1,986 questions and 71 chunks** — the chunked-embedding-cache fix (Bug B) held cleanly over 5h22m of bench.
- **Per-conv consistency (58-74% range)** — engine isn't randomly winning/losing. Predictable behaviour.

---

## 6. What we lose on (publish honestly — feeds `docs/skymem-failures.md`)

- **cat=1 literal answers (35.46%)** — overlong responses fail the grader on the easiest category. Architectural fix is straightforward (T3a).
- **cat=3 multi-hop (37.50%)** — planner decomposition isn't firing reliably. Small sample, but headline-vulnerable.
- **Cold-start chunks (avg q0 ~30-50%, sometimes 20%)** — persona block needs warming. Operational fix via T3b.

These become published entries in `docs/skymem-failures.md` as part of the same release.

---

## 7. Implications for the trunk → branches handoff

The FOCUS.md gate to start B1-B5 is **aggregate ≥ 88%**. We're at 66.82%. **Branches stay gated.** T3 is the next trunk priority.

**The defensible v0.2 release is the 66.82% honest number, the filled methodology page, the full bug catalog, the ablation tooling, and Tier 5 now genuinely live.** Pushing this publicly is the right move because it's all honest, real, reproducible — exactly what the audit-grade pitch demands. The 88% bar is a different milestone; v0.2 is the trust foundation for the journey there.

---

## 8. Cross-references

- `docs/BENCH-METHODOLOGY.md` — full reproducibility receipts (filled from this same run)
- `docs/skymem-failures.md` — bug catalog (will absorb the cat=1 + cat=3 + cold-start findings as new entries)
- `scripts/run-ablation.sh` — T6 ablation runner (will be kicked after this release)
- `scripts/fill-bench-methodology.js` — the script that auto-populated the methodology page from this run's summary JSON
- `SKY-REBUILD.md` § Trunk menu — where this T2 result feeds T3 fixes
- `docs/FOCUS.md` — D1 deliverable: 66.82% delivered, 88% bar remaining for branch unlock
