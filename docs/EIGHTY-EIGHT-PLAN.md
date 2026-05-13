# The 88% Plan

**Status:** authored 2026-05-13 after the T6 spot-test caught a parameter-tweak regression before kicking a full bench. Locks in the path from v0.4 (70.75% LOCOMO) to ≥88% via **structural retrieval substrates**, not parameter tweaks.

**Origin:** Two external strategic reviews of the public repo + recent bench retrospectives. Both reviews independently arrived at the same conclusion: parameter-tweak sprints (T4f's profile bumps, T5's scoring boost, T6's rerank depth bump) have run their course. The next 15+ pp requires new retrieval objects, not new weights.

---

## The math (why 88% is structurally hard from where we are)

```
Current      v0.4 = 70.75% LOCOMO
Gap to 88%   +17.25 pp aggregate
```

Per-category volume contribution:

| Cat | Volume | Current | Required (88% path) | Δ needed | Aggregate lift |
|---|---|---|---|---|---|
| cat=1 single-hop | 14.2% | 44.33% | 90% | +45.67 | +6.49 |
| cat=2 temporal | 16.2% | 59.50% | 88% | +28.50 | +4.62 |
| cat=3 multi-hop | 4.8% | 50.00% | 85% | +35.00 | +1.68 |
| cat=4 open-domain | 42.3% | 74.91% | 88% | +13.09 | **+5.54** |
| cat=5 adversarial | 22.5% | 92.15% | 95% | +2.85 | +0.64 |
| | | | | | **+18.97 pp → ~89.7%** |

**cat=4 is the kingmaker.** 42.3% volume means cat=4 movement defines aggregate movement. Even cat=1 at 90% (a +46pp moonshot) only delivers +6.49pp to aggregate.

**Without cat=4 hitting at least 85%, 88% is mathematically unreachable.** Period.

---

## Why parameter tweaks won't get us there

### Empirical evidence from our own bench history

| Sprint | Mechanism type | Aggregate Δ | Disposition |
|---|---|---|---|
| T3 v2 | Verifier surgery + prompt rewrites | +2.41 | Shipped (v0.3) |
| T4e | Classifier broadening | +0.61 | Shipped (intermediate) |
| T4f | Cognition router (per-cat profiles) | +0.91 | **Shipped (v0.4)** |
| T5 | Temporal-proximity scoring boost | -0.26 | **REVERTED** |
| T6 | cat=4 RERANK_PROFILE 12→16 | (failed spot) | **HALTED by protocol** |

The lift is decaying. T3→T4f was the credible cognition router work (+2.4 / +0.6 / +0.9). T5 and T6 are parameter tweaks dressed as mechanisms — they fail. **The 3-conv spot-test caught T6 before wasting 5.5h of compute.** That's the new floor.

### The system-noise observation

At our scale of bench-to-bench delta (±1pp), **system noise dominates targeted interventions**:
- T5 conv-47 +1.58 (target conv recovered)
- T5 conv-48 −3.34 (T4f marquee conv lost)
- Same magnitude opposite directions, on convs the T5 code (cat=2-gated) literally cannot reach

This is upstream score perturbations re-distributing stochastically across convs. **Single-mechanism interventions need direct effect > variance floor**, which means ~+1.5pp aggregate from one mechanism. None of the parameter tweaks have delivered that since T4e.

---

## The 5 structural mechanisms (the converged plan)

Each mechanism is a NEW retrieval object — not a tweaked weight. Each unlocks a different category. Build in volume-priority order (biggest aggregate lift per unit work first).

### T7 — Cat=4 diversity retrieval (THE volume bet)

**Substrate:** MMR-style diversity sampling + per-source quotas before rerank.

**Current behaviour:** Cohere rerank returns top-N by relevance score. The top-N often clusters semantically (3-4 nearly-identical sentences), starving the LLM's context of bridging facts.

**New behaviour:** retrieve a wider candidate pool, then select top-N by **Maximal Marginal Relevance** — balances relevance vs. diversity. Optional per-source quotas (e.g. 4 semantic + 4 FTS + 4 persona + 4 raw turn) ensure information diversity.

```
Candidate pool (per cat=4 query):
  8 semantic (Cohere embed nearest neighbours)
  8 FTS keyword (lexical match)
  8 persona facts (structured cognitive domain)
  8 raw / nucleus (transcript chunks)
  8 graph neighbours (typed-edge walk from anchor)
                    ↓
  MMR rerank: balance relevance vs. distance from already-selected
                    ↓
  Top-16 to context (diverse sources, deduplicated semantically)
```

**Target:** cat=4 from 74.91% → 85% (+10pp on 42.3% volume = **+4.23 pp aggregate**)
**Work estimate:** 2-3 days
**Risk:** low (MMR is a 20-year-old technique with published implementations)
**Validation:** stratified mini-bench cat=4 slice + cached replay (no LLM noise)

### T8 — Cat=1 atomic fact index (the biggest lift per unit work)

**Substrate:** subject / predicate / object table with alias resolution, populated at ingest time. Cat=1 routing becomes direct lookup, not retrieval.

**Current behaviour:** "What instrument does Caroline play?" → semantic search "Caroline instrument play" → top-K turns → LLM extracts answer from context. Fails when persona has 5+ facts about Caroline; similarity collapse picks the wrong one.

**New behaviour:** parse question into `(subject, predicate, expected_type)`. Resolve subject aliases. Query atomic fact table directly. Return canonical value. Retrieve source turn only as evidence.

```sql
CREATE TABLE atomic_facts (
  fact_id            TEXT PRIMARY KEY,
  subject_id         TEXT NOT NULL,
  subject_aliases    JSON,        -- ["Caroline", "Caroline A.", "Caro"]
  predicate          TEXT NOT NULL,
  object_value       TEXT NOT NULL,
  object_aliases     JSON,
  fact_type          TEXT,        -- "scalar" | "list" | "count" | "relation"
  source_turn_id     TEXT,
  conversation_id    TEXT,
  session_id         TEXT,
  confidence         REAL,
  is_current         BOOLEAN DEFAULT 1,
  superseded_by      TEXT,
  created_at         TIMESTAMP
);
```

**Predicate inventory** (benchmark-driven, ~15-20 predicates):
```
likes_activity · owns_pet · works_at · studies_subject · lives_in
visited_place · bought_item · gave_item · family_relation · hobby
food_preference · book_read · movie_watched · sport_played · plays_instrument
```

**Plus cat=1 sub-classifier:**
```
cat=1_scalar    "Where does X live?"          → atomic fact lookup
cat=1_list      "What hobbies does X have?"   → merge facts by (subject, predicate)
cat=1_count     "How many dogs?"              → COUNT(*) on canonical objects
cat=1_relation  "Who is X's sister?"          → entity-edge lookup
```

**Target:** cat=1 from 44.33% → 75% (+31pp on 14.2% volume = **+4.40 pp aggregate**)
**Work estimate:** 3-4 days (extraction pipeline + table + routing + alias resolution)
**Risk:** medium — extraction quality is the gate. Persona-extractor already exists; we extend it.

### T9 — Cat=2 temporal event compiler + FTS5

**Substrate:** ingest-time relative-date normalization → event index → SQLite FTS5 + Reciprocal Rank Fusion (RRF). Replaces T5's failed score-boost approach.

**Current behaviour:** turn content has session prefix `[2023-10-22 09:55] Caroline: ...`. When Caroline says "yesterday", the LLM has to do arithmetic at answer-time. This fails for ~40% of cat=2 questions because the model doesn't see the session prefix as a date primitive.

**New behaviour:** ingest pipeline parses each turn for temporal expressions. Relative phrases are resolved against the session timestamp at INGEST time. An `events` table holds the normalized data.

```sql
CREATE TABLE events (
  event_id              TEXT PRIMARY KEY,
  entity_id             TEXT NOT NULL,
  event_type            TEXT,         -- "moved" | "adopted" | "started" | ...
  event_text            TEXT,
  event_time_start      TIMESTAMP,    -- normalized absolute date
  event_time_end        TIMESTAMP,
  mentioned_at          TIMESTAMP,    -- when the speaker said it
  conversation_session_date  TIMESTAMP,
  relative_expression   TEXT,         -- original ("yesterday", "last week")
  resolved_absolute_date TIMESTAMP,
  resolution_confidence REAL,
  before_event_id       TEXT,
  after_event_id        TEXT,
  is_current_state_change BOOLEAN,
  source_turn_id        TEXT
);

-- FTS5 virtual table over the lexical content
CREATE VIRTUAL TABLE events_fts USING fts5(
  event_text, entity_id, event_type,
  content='events'
);
```

**Retrieval becomes a hybrid SQL + vector pipeline:**
```
Question: "When did Audrey adopt her first three dogs?"

1. Parse question: type=when, entity=Audrey, action=adopt, qualifier=first_three_dogs
2. SQL: SELECT * FROM events WHERE entity_id='Audrey' AND event_type='adopted'
        ORDER BY event_time_start LIMIT 3
3. FTS5: SELECT * FROM events_fts WHERE event_text MATCH 'audrey adopt dogs'
4. Vector: top-K semantic match on turn content
5. RRF fusion: combine ranks across the three retrievals
6. Top-N to context with normalized event_time_start as the answer anchor
```

**Target:** cat=2 from 59.50% → 80% (+20pp on 16.2% volume = **+3.24 pp aggregate**)
**Work estimate:** 3-4 days (event extractor + date normalizer + FTS5 + RRF)
**Risk:** medium (ingest-time normalization is the hard part; RRF is well-published)

### T10 — Cat=3 graph-hop executor

**Substrate:** Analyzer / Selector / Adder pattern. Decompose complex query → execute hops sequentially → combine. The LLM PLANS; the system EXECUTES.

**Current behaviour:** Cat=3 questions get the multihop prompt + cross-turn rerank top-15. LLM is asked to reason across the retrieved evidence. Works ~50% of the time. Fails when the chain has 2-3 entities and the intermediate isn't in the top-15.

**New behaviour:** sub-query planner emits a machine-readable plan. Each hop executes against the appropriate substrate (atomic facts / events / graph edges / raw turns). Results from hop N feed context for hop N+1.

```json
Question: "What did the person who works with Sarah buy after moving to Boston?"

Plan:
{
  "type": "multi_hop",
  "hops": [
    {"op": "edge_lookup", "subject": "Sarah", "predicate": "works_with"},
    {"op": "event_lookup", "entity": "$hop1", "predicate": "moved_to", "object": "Boston"},
    {"op": "event_lookup", "entity": "$hop1", "predicate": "bought", "after": "$hop2.event_time"}
  ]
}

Execution:
  hop1 → returns {entity_id: "Jordan", confidence: 0.92}
  hop2 → returns {event: "Jordan moved to Boston", time: 2023-03-15}
  hop3 → returns {object: "trumpet", time: 2023-04-02}

Answer synthesis: "a trumpet"
```

**Crucial: log hop-level success, not just final answer.** Without per-hop tracking, you can't tell if the planner or the retriever failed.

**Target:** cat=3 from 50.00% → 70% (+20pp on 4.8% volume = **+0.96 pp aggregate**)
**Work estimate:** 2-3 days
**Risk:** medium-high (planner robustness across LOCOMO question shapes is unknown)

### T11 — Cat=5 dedicated adversarial verifier

**Substrate:** "absence of evidence" logic with explicit null-state detection. Replaces "inference shape uses generic prompt" with a dedicated route.

**Current behaviour:** Cat=5 is short-circuited to `'inference'` answer shape at line 505 of `classifyAnswerShape`. T4f's `RELEVANCE_PROFILE[5]=0.0` and `RERANK_PROFILE[5]=20` give it broad grounding. Score holds at 92%, slight drift in noise band.

**New behaviour:** dedicated cat=5 retrieval + verification pipeline:
1. Extract premise from question (the embedded factual claim)
2. Try to verify premise against atomic facts + events + persona
3. If NO contiguous evidence chain → tag context with "ABSENCE" flag
4. Generator prompt: "Answer the question. If the premise is unsupported, refuse and state why."

**Target:** cat=5 from 92.15% → 96% (+4pp on 22.5% volume = **+0.90 pp aggregate**)
**Work estimate:** 2 days
**Risk:** low (we're nudging a strong category, not building from scratch)

---

## Cumulative target

```
Mechanism    Aggregate Δ
─────────────────────────
T7 cat=4     +4.23
T8 cat=1     +4.40
T9 cat=2     +3.24
T10 cat=3    +0.96
T11 cat=5    +0.90
─────────────────────────
Total        +13.73 pp → ~84.5% LOCOMO

Stretch (each mechanism hits high end of range):
T7→88% / T8→90% / T9→88% / T10→85% / T11→96% = ~89-90%
```

**Realistic landing: 82-87%.** Stretch landing: 88-90%. Each mechanism is independent — if one underdelivers, the others still ship. No domino risk.

---

## Phase A — Pre-work (do FIRST, before T7)

Both strategists called this out: **without diagnostic infrastructure, every Phase B sprint is still guessing.**

### A.1 — Failure taxonomy classifier

For every failed question in the latest bench, classify into:

```
A. Extraction missing       → fact was never extracted from the source
B. Extracted but not indexed → fact extracted, lost in storage
C. Indexed but not retrieved → fact stored, retrieval didn't surface it
D. Retrieved but not used    → fact in context, LLM ignored it
E. Used but answer style wrong → right info, wrong format
F. Temporal normalization wrong → date arithmetic failed
G. Entity/alias mismatch     → "Caroline" vs "Caroline A." mismatch
H. Multi-hop intermediate failure → hop 1 or 2 missed
I. Grader mismatch           → answer correct, grader marked wrong
J. Actually impossible       → ambiguous/missing in the source
```

**Output:** dashboard panel + JSON file showing per-cat failure-mode distribution. If cat=1 is mostly **C**, the atomic fact index (T8) is the right move. If cat=1 is mostly **E**, prompt fixes might suffice.

**Without this, we keep building mechanisms for hypothetical problems.**

**Implementation:** `scripts/classify-failures.js` — reads chunk logs, sends each failure to Haiku for classification with the question/expected/predicted context. ~3h work.

### A.2 — Stratified mini-bench

Locked failure-set across cats:

```
30 cat=1 failures from T4f
30 cat=2 failures from T4f
20 cat=3 failures from T4f
40 cat=4 failures from T4f
20 cat=5 near-misses from T4f
────────────────────────────
140 questions, ~12-15 min runtime per spot
```

Every sprint runs against the same locked set. Mechanism only graduates to full bench if its target cat lifts on the mini-bench slice. **Replaces the 3-conv spot-test** (which is still 100x slower than this).

**Implementation:** `scripts/spot-mini-bench.js` — selects 140 failures from T4f chunk logs, builds a re-runnable subset, scores against the same grader. ~3h work.

### A.3 — Paired question-level diff

For two runs (T_prev, T_curr), output:

```
flipped_to_correct  (T_prev wrong, T_curr right)  ← THE actual lift
flipped_to_wrong    (T_prev right, T_curr wrong)  ← regression candidates
both_correct        (no change)
both_wrong          (still failing)
```

The aggregate number is less useful than "which specific questions flipped, and why."

**Implementation:** `scripts/bench-diff.js` — walks two sets of chunk logs by run tag, produces the diff tables. ~2h work.

### A.4 — Cached replay mode

Decouple bench pipeline:

```
retrieve.js   → cached snapshot to disk
generate.js   → reads snapshot, runs generator + verifier
grade.js      → grades against gold
```

Lets us test **retrieval changes** without LLM-side noise. A.4 cuts variance to ~zero for retrieval-side mechanisms (T7 / T8 / T9 / T10 all target retrieval).

**Implementation:** patch `bench-locomo.js` with `--cache-retrieval=<file>` (write) and `--replay-retrieval=<file>` (read) flags. Save retrieved candidate sets per question to disk. ~6h work.

### Phase A timeline

```
A.1 classifier      ~3h
A.2 mini-bench      ~3h
A.3 diff tool       ~2h
A.4 cached replay   ~6h
                ─────
                ~14h = 2 focused days
```

**Total Phase A: 2 days. ROI: every subsequent sprint runs 10-20x faster + the discipline cost drops to near-zero.**

---

## Strategic positioning — the moat is not LOCOMO score

LOCOMO measures **recall on static datasets**. Production AI breaks on things LOCOMO doesn't test:

- Multi-session contradiction surfacing
- Stale belief suppression
- Provenance + supersession
- Agent drift across long horizons
- "Who said this and when did they say it differently"

The 88% LOCOMO sprint matters for **credibility** (industry baseline). The real product moat is **Agent Drift Eval** — our independent benchmark, our framing, run against 3+ competitors on the same harness.

**Gate v1.0 on:**
- ≥88% LOCOMO aggregate
- Agent Drift Eval against Mem0, MemMachine, Zep on the same scenarios
- Honest results published (regressions and all)

---

## Operational discipline (locked)

| Protocol | Requirement | Enforcement |
|---|---|---|
| Commits | Conventional Commits format | `COMMIT-CONVENTIONS.md` |
| Spot-test | 3-conv minimum OR stratified mini-bench | `spot-test-3.sh` / `spot-mini-bench.js` |
| Sprint integrity | One mechanism per sprint | bench discipline (no multi-feature commits) |
| Public push | Wins only — regressions stay internal | T5 stayed off public repo |
| Results docs | Honest analysis including failures | T4f-RESULTS.md / T5-RESULTS.md style |
| Sprint cycle | A/B Phase A pre-work BEFORE B mechanism work | this doc |

---

## What this doc replaces

- The vague "T6 → T7 → ..." sequence in older docs
- The "tune until something works" implicit strategy
- The single-conv spot-test that fooled us in T4f (conv-49) and T5 (conv-42)

**This is now the canonical roadmap to 88%. Every future sprint references back to this doc.** Updates happen here, not in scattered T-RESULTS files.

---

## Cross-references

- `docs/COGNITION-ROUTER.md` — the T4f per-cat profile architecture (the spine we build on)
- `docs/T4f-RESULTS.md` — the current public best (70.75%, v0.4)
- `docs/T5-RESULTS.md` — the regression that locked the spot-test protocol
- `docs/T4-PROGRESS.md` — T4a/b/c Rule #4 receipts
- `docs/DASHBOARD-ROADMAP.md` — parallel-track operations console work
- `COMMIT-CONVENTIONS.md` — semantic commit format adopted at v0.4

---

**Bottom line: 88% is reachable in 2-3 weeks if we execute the 5 structural mechanisms after 2 days of Phase A pre-work. No more parameter tweaks. No more single-conv spot tests. Every sprint validated against the stratified mini-bench, every regression honestly published. The discipline IS the moat as much as the score is.**
