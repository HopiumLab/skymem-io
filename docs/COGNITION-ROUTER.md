# Cognition Router — Per-Category Retrieval Profiles

**Status:** design doc, authored 2026-05-11 during the T4 sprint as the architectural direction for T4f → ≥82% aggregate.

**Origin:** named during the T4e full-bench mid-run when every lift started creating a tradeoff. The conv-26/30 cat=5 dip (-3.8 pp aggregate) confirmed that "more focused relevance" — a globally positive intervention — actively *hurts* adversarial questions because they need broad grounding, not narrow precision.

---

## The thesis

> "You are now clearly in the phase where every lift creates a tradeoff. That's good. It means the system is mature enough that the remaining gains are routing-specific, not architecture-wide."

A single retrieval+answer pipeline cannot be globally optimal across LOCOMO's five question categories. Each category has a *different cognitive profile* and needs a *different retrieval profile*. The next architectural lift is not another global mechanic — it's **per-category routing** of retrieval strategy, context shape, and verifier policy.

---

## The five cognitive profiles

| Cat | Cognitive shape | Retrieval profile | Verifier policy |
|---|---|---|---|
| **1 — Literal** | Single-fact precision | Narrow, exact-evidence. Top-12. Persona-fact relevance scoring ON (T4b). | Conservative: trust prediction if exact evidence present |
| **2 — Temporal** | Timeline reconstruction | Date-indexed retrieval. Session-date prefix decisive. Maybe a temporal-FTS pass that filters to turns with absolute-date mentions. | Allow date arithmetic; reject "Yesterday from X" |
| **3 — Multi-hop** | Chain decomposition + inference | Graph/decomposition. Sub-query planner + edge-walk + nucleus expansion (T4c). Top-15-20 for cross-turn synthesis. Persona facts as inference fodder, not raw evidence. | Never auto-abstain (T3 verifier surgery); allow inferential leaps |
| **4 — Open-domain** | Broad semantic recall | Broad context pack. Top-12 or 15. Persona facts surface naturally. List fan-out top-25 for list-shape (T4b). | Soft abstention only on truly evidence-thin Qs |
| **5 — Adversarial** | Absence detection + grounding | **Broad context + diversity**. Top-18-22. **Skip persona-fact relevance scoring** (it focuses too tightly and misses the contradiction surface). Pull raw/nucleus evidence. Include contradicting turns. | **Strict bias toward abstention** when no concrete evidence. The verifier surgery (T3) is correct for cat=5; double down here. |

**Key principle:** "focused relevance" is correct for cat=1/2/3 (precision matters). It's **wrong for cat=4/5** (recall/grounding matters). T4b's persona-fact relevance scoring is currently global, which is the proximate cause of the cat=5 dip in the T4e bench.

---

## T4f — concrete implementation (the immediate move)

The minimum surgical change to T4f is **make persona-fact relevance scoring conditional**:

```js
// In buildBenchPersonaBlock — currently applies overlap-boost globally.
// T4f: per-category profile.
//   cat=1/2/3 → keep T4b relevance scoring (precision wins)
//   cat=4    → keep but with smaller boost (broad recall, but persona still helps)
//   cat=5    → SKIP relevance scoring (broad grounding wins)

const RELEVANCE_PROFILE = {
  1: 0.15,   // T4b baseline — strong relevance boost per shared word
  2: 0.15,   // T4b baseline
  3: 0.15,   // T4b baseline (inference fodder benefits from focus)
  4: 0.08,   // half-strength — broad recall preferred but persona still scored
  5: 0.0,    // OFF — adversarial wants broad context, not narrow focus
};
const boost = (RELEVANCE_PROFILE[category] ?? 0.15) * overlap;
```

Plus a cat=5 retrieval profile in `retrieveContext`:

```js
// T4f: per-category RERANK_TOPN
const RERANK_PROFILE = {
  1: 12,      // narrow, exact
  2: 12,      // temporal — focus is fine
  3: 15,      // multi-hop wants more cross-turn context (was 12)
  4: (shape === 'list') ? 25 : 12,   // T4b list fan-out preserved
  5: 20,      // BROAD — adversarial needs the contradiction surface
};
const RERANK_TOPN = RERANK_PROFILE[category] ?? 12;
```

**Expected effect on T4e bench's regressions:**
- cat=5: recover from 88.7% → 92-93% (T3 v2 baseline)
- cat=3: small additional lift from top-15 (was 12)
- cat=1/2/4: unchanged

Volume-weighted projection: **+1.0 pp aggregate over T4e** (recovering the cat=5 loss).

---

## The bigger arc — toward 82+%

Per-cat profiles is the unlock for getting past the ~70% ceiling. Future sprints layer on top of the router:

### T5 — temporal-FTS pass for cat=2 (after T4f)
Pre-index every turn with explicit absolute dates parsed from the speaker's text *and* the session-prefix timestamp. Cat=2 retrieval queries an inverted date index first, then falls back to semantic. Target: cat=2 from ~60% → 75%+.

### T6 — sub-query graph for cat=3 (after T5)
Current planner does sub-query decomposition cheaply but uses the same top-k retrieval per sub-query. Cat=3 needs **graph hopping** — anchor on sub-query 1's top-3 entities, edge-walk to find sub-query 2's evidence, combine. Target: cat=3 from ~50% → 70%+.

### T7 — cat=1 persona-fact list-aggregation (after T6)
The remaining cat=1 list-failures are about *aggregating items across persona facts*. e.g. "What types of pottery has Melanie made?" — persona may have 5 facts each mentioning one type. Pre-aggregate list facts per subject; expose them as one consolidated answer-candidate. Target: cat=1 from ~45% → 70%+.

### T8 — adversarial-specific verifier (cat=5)
Beyond per-cat retrieval, cat=5 needs a *dedicated adversarial verifier* that explicitly checks "does the question's premise hold in the evidence?" before allowing a positive answer. Target: cat=5 from ~92% → 96%+.

**Volume-weighted target after T4f + T5 + T6 + T7 + T8: 82-85% aggregate.**

---

## Implementation discipline (R4 applied)

Every per-cat profile must be **ablation-validated** before going default:
- Run with profile ON vs profile OFF on the same conv
- Measure per-cat lift AND per-cat regression
- Only promote if net positive AND no category regresses more than 2 pp

This prevents the "tune for strong, regress weak" trap that hit T3 v2 cat=2 (Rule #4 receipt #1) and T4a cat=2 (Rule #4 receipt #2).

---

## Cross-references

- `docs/T4-PROGRESS.md` — T4 sprint receipts (T4a/b/c/e)
- `SKY-REBUILD.md` § Discipline Rule #4 — architectural-fit review for borrowed mechanics
- `scripts/bench-locomo.js` — `buildBenchPersonaBlock`, `retrieveContext`, `classifyAnswerShape` (the routing surface)

---

**Bottom line:** the system is past the era of "one architecture fits all categories." From here forward, every lift is **per-category routing** — retrieval profile, context shape, verifier policy. T4f starts at cat=5 (the immediate dip), then the per-cat profile table fills in for cat=2/3 over T5-T8. End-state: 82-85% aggregate.
