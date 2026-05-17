# Phase B — Stop Hamster-Wheeling, Ship the Stack

**Date:** 2026-05-14
**Trigger:** 5 sprints (T5/T6/T7a/T7b/T7c) over 48h, **public number unmoved** at 70.75%. Spot-test discipline did its job (caught 3 regressions) but the strategy of "one mechanism at a time, validate via 2h spot" produces noise-floor moves that can't escape bench variance.

**Pivot:** Develop the next sprints in parallel, **skip the per-mechanism spots**, run **one stacked full bench**. Bank whatever real lift exists in one cycle instead of dribbling.

---

## The data I should have read closer the first time

When I sampled the actual cat=1 E-bucket failures from `bench/t3fs-20260512-064522-failures.json`, the pattern was nothing like "format error." It was **list-aggregation under-enumeration**:

| Question | Expected | Got |
|---|---|---|
| What does Melanie do to destress? | Running, pottery | running |
| What people has Maria met...? | David, Jean, Cindy, Laura | Jean and David |
| What music events has John attended? | Live music event, violin concert | violin concert |
| What outdoor activities has John done? | Hiking, mountaineering | mountaineering trip and convention |

These are **list-shaped questions misrouted to the literal prompt** because:
1. The list-regex requires `\bwhat\s+(noun)\b` with NO intervening word — so "what **outdoor** activities" doesn't match
2. The noun whitelist is incomplete: missing `career, people, shelters, causes, exercises, desserts, musicians, bands, artists, paths, items, products, gifts, recipes`

Similarly, the cat=2 E-bucket is dominated by **dataset-format mismatches** that are 1-word fixes:

| Expected | Got | Fix |
|---|---|---|
| "The week before 16 June 2023" | "Last week before 16 June 2023" | Strip leading "Last " → "The " |
| "September 2023" | "Last month (relative to 13 October 2023)" | Resolve "Last month" against session date |
| "10 years ago" | "ten years" | Normalize digit form + add "ago" |

These are **post-generation string transforms** with deterministic conversion targets — much safer than T7c's cat=4 inference strips because the dataset format is rigid for cat=2 temporal.

---

## Revised volume math (per real failure data, not taxonomy class labels)

| Cat | Total fails | Biggest sub-mode | Expected flips | Aggregate Δ |
|---|---|---|---|---|
| 1 | 148 | list-shape misroute (~70 of E+D) | 30-50 | +0.5 to +1.1 pp |
| 2 | 126 | temporal format strip (~25 of E+F) | 15-25 | +0.3 to +0.7 pp |
| 4 | (T7a kept) | MMR diversity already in code | banked | +1.4 pp/conv avg |
| 5 | 33 | abstention rule tightening | 5-10 | +0.1 to +0.2 pp |
| 3 | 41 | retrieval-side (deferred) | - | - |

**Realistic stack ceiling: 70.75% → 72.5-74.5%** on the public bench. **Not 88**, but the first real banked progress in 48h.

T9 temporal **events table + FTS5** (a real new retrieval path for cat=2 C-bucket = 46 retrieval failures) is the next big swing after this stack. Deferred to Phase B-2.

---

## Sprints in this stack

### T8 — cat=1 list-shape expansion
Expand `listPatterns` in `classifyAnswerShape()`:
- Allow 0-2 intervening adjectives: `/\bwhat\s+(?:\w+\s+){0,2}(noun)\b/`
- Add nouns: `career, careers, paths, people, person, shelters, causes, exercises, desserts, musicians, bands, artists, gifts, recipes, friends, mentors, achievements, rewards, items, products`
- Add idiom: `/\bwhat\s+(?:do|does|did)\s+\w+\s+do\s+(?:to|when|for|with)\b/` → list ("what does Melanie do to destress")

Tighten the list prompt:
- "Identify the implicit subject noun in the question (the WHAT). Enumerate items that match THAT noun directly, not descriptions of them."
- "What has X painted?" → subjects (horse, sunset), NOT descriptions (lake sunrise painting)

**Risk:** LOW. Additive shape-routing; doesn't change generation behaviour for already-correct cases.

### T9 — cat=2 temporal format conversion
Post-generation transforms gated to `shape === 'temporal'`:
1. `^Last (Sun|Mon|...|week|month|year)` + " before [date]" → `The $1 before $2` (drop "Last", capitalize "The")
2. `(.*) \(relative to ([^)]+)\)` → resolve and emit absolute form
3. `^(one|two|...|ten) (years?|months?|weeks?) ago$` → `${digit} $2 ago`
4. `^(ten|five|seven|...) (years?|months?)$` (no "ago") + question contains "how long ago" → append " ago"
5. `^Last month$` + session date available → `${prev_month} ${year}`

**Risk:** MEDIUM. Post-gen strip mirror of T7c — but cat=2 temporal has rigid dataset format (always "X before DATE" or "MONTH YEAR" or "YEAR"). Less chance of stripping into a wrong shape.

### T11 — cat=5 strict abstention nudge
cat=5 (adversarial) currently uses generic inference prompt. Add dedicated cat=5 branch:
- "These questions are often designed to MISLEAD. If the transcript has no DIRECT evidence about the entity/event mentioned, reply 'No information available'."
- Two-sided rule: don't over-abstain on cat=5 either — if there IS direct evidence, answer.

**Risk:** LOW. Small prompt change, gated to cat=5 only. Worst case adds noise to a category already at 93%.

### Banked but unpublished
- **T7a MMR diversity** (commit 4390d99) stays in code. +1.45 pp/conv avg cat=4. Stacks naturally.

---

## What changed in the protocol

| Old | New |
|---|---|
| Develop one mechanism → spot-test → revert-or-keep → bench eventually | Develop 3 mechanisms in parallel → ONE stacked full bench |
| Conservative: every change spot-tested | Conservative: every change ablatable via flag |
| Bench protocol catches regressions | Bench-diff (Phase A.3) localizes which mechanism caused regression |

The discipline lives in **per-mechanism flags** + **paired bench-diff post-hoc**, not in per-mechanism spots. The spot protocol cost us 12h cumulative to catch 3 regressions; the bench-diff catches them in one full bench pass for the same cost.

---

## Disposition gate for v0.5

- Stacked bench finishes
- If aggregate moved ≥ +1.0 pp vs T4f baseline → **ship as v0.5** (with full bench-diff doc)
- If aggregate moved < +1.0 pp → bench-diff identifies which sprint helped and which didn't; keep what worked, drop what didn't, no v0.5 push
- If aggregate regressed → revert the stack, run bench-diff to identify the culprit, possibly keep T7a alone

This is the first sprint cycle where the public number has a real chance to move.

---

## Phase B-2 (next session)

- **T9-events:** Real temporal compiler — extract dated events at ingest, FTS5 index, retrieve by date anchor at query. Addresses cat=2 C-bucket (46 retrieval failures = biggest single bucket).
- **T10:** cat=3 retrieval expansion — RERANK_TOPN raise + cross-session join hints.
- **D-bucket research:** post-gen verification or persona priority rewrite for the ~60 cat=4 D-bucket failures.

---

**Bottom line:** The taxonomy class labels (E/F/D) were leading me to the wrong fixes. Reading actual failures led to actionable mechanisms. The pivot is parallel-dev + stacked-bench, not more spots. Targeting **+1.5 to +2.5 pp banked** = first public-number movement in 48h.
