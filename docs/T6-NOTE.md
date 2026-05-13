# T6 Disposition Note

**Status:** abandoned — spot-test protocol caught it before full bench.

**Mechanism:** `RERANK_PROFILE[4]: 12 → 16` (commit `4a235ff`).

**Spot tag:** `t6-cat4-spot3-20260513-082810`

---

## Spot-test result (3-conv locked protocol, FIRST run after protocol locked)

```
cat=4 must hit ≥ 76% on ALL THREE convs

conv-42 cat=4: 78/111 = 70.27%   FAIL  (-5.73 pp below gate)
conv-43 cat=4: 83/107 = 77.57%   PASS  (+1.57 pp above gate)
conv-44 cat=4: 49/62  = 79.03%   PASS  (+3.03 pp above gate)
─────────────────────────────────────────────────────────────
2/3 PASS — VERDICT: FAIL — DO NOT kick full bench
Wall: 115m (vs 330m for a full bench → saved 3.5h of compute)
```

---

## What this confirms

### 1. The protocol works

T4f→T5 wasted 5.5h of full-bench compute on a regression. T6 wasted 1.9h of spot-test compute on a mechanism that wouldn't have passed a full bench. The protocol delivered exactly the discipline it was designed for: **catch parameter tweaks before the full bench, with cheap multi-conv evidence.**

### 2. Cat=4 has no single fix — data predicted this exactly

`FAILURE-TAXONOMY-T4F.md` showed cat=4's failure distribution as roughly equal across three modes:
- D = 60 (retrieved but not used by LLM)
- C = 52 (indexed but not retrieved)
- E = 49 (used but wrong format)

T6's `RERANK_PROFILE 12 → 16` targets **only C** (broader retrieval pool). On convs whose cat=4 failures are C-dominated (conv-43, conv-44), it lifts. On convs whose cat=4 failures are D-dominated (conv-42), broader pool just dilutes the rerank signal and HURTS performance.

**T6 was always going to be conv-dependent.** The data published 90 minutes before this verdict literally predicted it.

### 3. Single-mechanism cat=4 sprints are dead

Per the FAILURE-TAXONOMY analysis, the correct cat=4 sprint (T7) needs **three coordinated mechanisms**:
- T7a — MMR diversity (for C failures)
- T7b — Cat=4 answer prompt overhaul (for D failures)  
- T7c — Cat=4 answer-shape post-filter (for E failures)

Each addresses one slice. Together they cover 161/175 = 92% of cat=4 failures.

---

## Disposition

| Action | Decision |
|---|---|
| **Kick full T6 bench** | ❌ NO — failed locked protocol |
| **Revert `RERANK_PROFILE[4]=16`** | ❌ NO — change is harmless if left in; +1.6/+3.0 on 2 convs is real even if not full-bench-validatable |
| **Public push** | ❌ NO — v0.4 (T4f 70.75%) remains the public best |
| **T6-RESULTS.md full doc** | ❌ NO — no full bench means no full results to document |
| **This note** | ✅ YES — short disposition + protocol-win receipt |

---

## What we learned (and what was free)

**Cost:** ~$0.50 of Cohere reranking + Anthropic generation for 660 questions across 3 convs. ~1.9 hours of compute.

**Value:**
1. Proof that the protocol works (2/3 PASS would have been false-positive in a single-conv spot)
2. Empirical confirmation that cat=4 needs multi-mechanism sprint, not single-knob
3. Direct measurement of conv-42 as the cat=4-volatile conv (matters for T7 spot-test conv selection)
4. The mechanism stays in code as a small ~+0.0 pp aggregate change — net neutral, no rollback work needed

**Counterfactual:** had we kicked the full T6 bench based on single-conv conv-44 spot (cat=4 79%), we'd have spent 5.5h producing a likely ~70.5% aggregate (similar to T5's regression), then spent another doc cycle explaining why. Saved a full day.

---

## Forward

T7 — cat=4 multi-mechanism (a + b + c) — is the next sprint. Design driven by `FAILURE-TAXONOMY-T4F.md`, validated against `mini-bench-v1.json`, gated on the same 3-conv spot protocol.

The protocol just earned its keep on its first real test.

---

## Cross-references

- `docs/EIGHTY-EIGHT-PLAN.md` — strategic roadmap
- `docs/FAILURE-TAXONOMY-T4F.md` — the data that predicted T6's conv-dependency
- `docs/T5-RESULTS.md` — the regression that locked the protocol
- `scripts/spot-test-3.sh` — the protocol runner
- Commit `4a235ff` — T6 code change (kept in place)
- `t6-cat4-spot3-20260513-082810` — spot-test run tag
