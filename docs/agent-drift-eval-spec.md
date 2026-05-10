# Agent Drift Eval — Specification (v0.1 draft)

**Status:** spec draft, 2026-05-10. Pre-implementation. Living doc until the first scored run.

**Repo target:** `github.com/HopiumLab/agent-drift-eval` (public, MIT-licensed for the eval; the systems under test keep their own licenses).

**Authoring entity:** HopiumLab — explicitly separated from `skymem-io` so the eval reads as an independent benchmark, not a marketing artefact for skyMem.

**Mission:** define and measure **agent drift** — the failure mode where a stateful AI agent contradicts itself, forgets prior decisions, repeats questions, or acts on superseded facts across sessions. The benchmark scores any memory layer (skyMem, mem0, zep/graphiti, memori, letta, langchain-memory, byterover, plain-rag, no-memory) against the same scenarios.

**Why this matters strategically:** _whoever names and measures the problem owns the category._ LOCOMO measures recall on a static dataset of human-actor conversations. It does not measure what production agents actually break on — multi-session decision continuity, contradiction resistance, stale-fact suppression, correction retention. Agent Drift Eval covers that gap.

---

## 1. The honesty contract

Three non-negotiable rules. They exist because this benchmark must survive Reddit/HN scrutiny.

1. **We publish our weakest scenario first.** The headline number on the README is whichever of the 5 scenarios skyMem performs worst on, not best.
2. **We run every public competitor on the same harness.** No "we tested ours, here's a graph." Every system gets the same dialogue, same prompts, same scoring. Adapter code is in-repo and reviewable.
3. **The eval is reproducible from a clean checkout.** `make eval SYSTEM=mem0` should produce the same scores ±1 metric point on any machine with a working API key. Costs, latencies, raw transcripts, and judge rationales are all logged.

If any of these slips, the benchmark loses credibility and the strategic asset evaporates.

---

## 2. What agent drift is (and isn't)

**Drift = the agent's behaviour across sessions degrades from what a perfectly-stateful version would do.**

Concretely, drift shows up as one or more of:

| Drift mode | Operational definition |
|---|---|
| **Contradiction** | The agent makes a claim or recommendation in session N that directly conflicts with a claim/decision/fact established in session 1..N-1, where the prior was never explicitly retracted. |
| **Repeated question** | The agent asks the user something the user has already answered in a prior session, when the answer is still applicable. |
| **Stale fact** | The agent acts on a fact that was explicitly superseded in a prior session (policy update, decision reversal, status change). |
| **Lost decision** | The agent fails to honour a binding decision made in a prior session (e.g., "we chose session cookies") and proposes a different path without acknowledgement. |
| **Unsupported claim** | The agent asserts a fact about the user/project/state that is not in any prior session (hallucination dressed as memory). |
| **Correction non-retention** | The user corrects the agent in session N. In session N+1, the agent reverts to the pre-correction behaviour. |

**Not drift:**
- Agent legitimately not knowing something it was never told. (That's a different gap — coverage, not drift.)
- Agent declining to answer because the prior context was ambiguous and it asks for clarification. (That's good behaviour.)
- Agent revising a prior recommendation when the user has supplied new contradicting information in the current session. (That's responsiveness.)

The eval measures drift specifically — failure modes that come from absent or wrong state, not from absent capability.

---

## 3. The 5 scenarios

Each scenario is a multi-session dialogue script. Sessions are sequential — session 2 starts with a fresh context window, the memory system between sessions is the only carrier of state.

Sessions are role-played — the eval harness drives both the user-side and judges the agent-side responses. The user-side script is fully deterministic (same prompts every run); the agent-side is whatever the system-under-test produces.

### 3.1 Scenario A — Coding agent (the wedge scenario)

**Setting:** an AI coding assistant supporting a developer building a backend service over 5 sessions across ~2 weeks of simulated time.

**Sessions:**
1. **Architecture decision.** User picks auth strategy (session cookies, redis-backed, with revocation control). Agent acknowledges. Decision is binding.
2. **Schema design.** User picks Postgres + Prisma. Specific naming convention chosen.
3. **Performance issue.** User reports auth slow on cold cache. Asks for fix.
4. **Refactor request.** Three weeks later (simulated). User asks how to add SSO without breaking session model.
5. **Bug debugging.** User describes auth bug. Asks agent to diagnose using the schema and decisions in record.

**What gets scored:**
- Session 3: does agent suggest fix that preserves session-cookie decision? Or does it revert to JWT?  *(lost-decision check)*
- Session 4: does agent reference the prior session-cookie commitment? Or design SSO assuming JWT?  *(decision-continuity check)*
- Session 5: does agent use the schema names from session 2? Or invent new ones?  *(stale-fact / consistency check)*
- Across sessions: does the agent re-ask "what auth do you use?" / "what DB?"  *(repeated-question check)*

**Why this scenario:** matches our Stage 1 ICP (Claude Code / Cursor users) and the 90s drift demo. Strongest narrative pull for the wedge.

### 3.2 Scenario B — Customer support agent

**Setting:** a support agent for a SaaS product over 4 sessions with the same customer.

**Sessions:**
1. **Setup question.** Customer asks about plan feature X. Agent answers per current policy.
2. **Policy update injected.** Between sessions, the eval harness pushes a "policy update" doc — feature X's behaviour changed in v3.2.
3. **Same question, asked differently.** Customer asks about feature X again, slightly different phrasing.
4. **Escalation.** Customer asks why they got contradictory answers across sessions.

**What gets scored:**
- Session 3: does agent answer per the new policy? Or per the old session-1 answer?  *(stale-fact suppression check)*
- Session 3: does agent acknowledge the policy changed, ideally citing the update doc?  *(provenance check)*
- Session 4: does agent admit/explain the change cleanly, or hallucinate consistency?  *(correction-retention + honesty check)*

**Why this scenario:** policy/version updates are the canonical "stale fact" problem and probably the most common production drift mode in support deployments.

### 3.3 Scenario C — Sales SDR agent across a multi-call deal

**Setting:** a B2B SDR agent qualifying and progressing a single deal across 5 calls over 6 weeks.

**Sessions:**
1. **Discovery.** Lead size, budget tier, decision-maker name, current stack captured.
2. **Demo follow-up.** Demo happened (off-stage). Lead has 2 specific objections recorded.
3. **Pricing discussion.** Lead pushes back on pricing. Agent negotiates within authority.
4. **Stakeholder expansion.** Lead introduces a second decision-maker. Their concerns differ.
5. **Close attempt.** Final call. Agent should reference everything: original budget, both objections, pricing landed, both stakeholders.

**What gets scored:**
- Sessions 2-5: does agent re-qualify (re-ask budget, decision-maker, stack)?  *(repeated-question check)*
- Session 3: does agent honour the discovery-call budget tier when negotiating?  *(decision-continuity check)*
- Session 5: does agent reference both objections and both stakeholders correctly, by name?  *(fact-retention check)*
- Any session: does the agent invent stakeholder names, prior commitments, or quote numbers?  *(unsupported-claim check)*

**Why this scenario:** sales has the highest cost per drift incident (a re-qualified prospect churns) and is a clear non-coding domain that proves the architecture generalises.

### 3.4 Scenario D — Product agent across sprints

**Setting:** a product-management AI assistant supporting a PM over 4 sprint cycles (~8 weeks simulated).

**Sessions:**
1. **Sprint planning.** Roadmap items prioritised. Two features explicitly killed with rationale.
2. **Mid-sprint check-in.** Status update on in-flight items.
3. **Sprint retro + replan.** New ideas pitched. One of them is a re-pitch of a killed feature.
4. **Stakeholder review.** PM asks the agent to summarise the quarter for an exec.

**What gets scored:**
- Session 3: when the killed feature is re-pitched, does the agent surface that it was killed and why?  *(superseded-fact check, decision-continuity)*
- Session 4: does the summary correctly reflect what shipped, what was killed, what's in-flight?  *(state-aggregation check)*
- Across sessions: does the agent invent priorities or commitments that weren't made?  *(unsupported-claim check)*

**Why this scenario:** captures the "killed features stay killed" pattern that breaks every flat-memory system. Decision lineage is the hard part.

### 3.5 Scenario E — Ops/runbook agent

**Setting:** an internal ops AI helping an SRE team over 5 incidents/runbook updates.

**Sessions:**
1. **Initial runbook.** Procedure for a specific incident type captured. Specific commands recorded.
2. **Runbook update.** A step is changed (e.g., "always restart redis-replica before primary"). Recorded as a correction.
3. **New similar incident.** Agent asked to walk through the procedure.
4. **Corrective feedback.** User corrects agent on a specific step. Records the correction.
5. **Same incident type later.** Asks the agent to walk through the procedure again.

**What gets scored:**
- Session 3: does agent use the updated procedure or the v1 one?  *(stale-fact / supersession check)*
- Session 5: does agent honour the user correction from session 4?  *(correction-retention check)*
- Across sessions: does agent fabricate runbook steps not in record?  *(unsupported-claim check)*

**Why this scenario:** highest-stakes drift domain (operational mistakes have direct cost). Also the cleanest test of correction retention specifically.

---

## 4. Metrics

Each scenario emits a set of **judgements** (binary or scaled). Metrics are aggregated per scenario, then a final composite is computed.

### 4.1 Per-judgement scoring

Every judgement is one of:
- **Binary**: pass/fail. Used for unambiguous events ("did the agent ask a repeated question, yes/no").
- **Scaled (0-3)**: used for nuance. 0 = clear failure, 1 = partial, 2 = mostly correct, 3 = exemplary.

Judgements are produced by an **LLM judge** (default: Claude Opus, fallback: GPT-4 Turbo) given:
- the full transcript of the sessions in scope
- the specific judgement question with a 1-5 sentence rubric
- the prior context the agent should have had access to
- explicit anchors: what the user actually said in the prior session

The judge is forced to output structured JSON: `{ judgement: "pass"|"fail"|score, rationale: string, evidence_quote: string|null }`. Rationales and quotes are logged for human spot-check.

**To prevent judge bias**, every run produces a **dual-judge score**: judgement 1 from Opus, judgement 2 from GPT-4 Turbo. We report:
- agreement rate (inter-judge κ)
- when judges disagree, the human-reviewed call (if performed) takes precedence

### 4.2 Headline metrics

Six metrics per scenario, aggregated to a composite.

| Metric | Formula | Range | What it captures |
|---|---|---|---|
| **CR** — Contradiction Rate | (# contradictions) / (# decision-binding moments) | 0..1, lower = better | Direct conflict with prior commitments |
| **RQR** — Repeated-Question Rate | (# repeated questions) / (# total questions asked by agent) | 0..1, lower = better | Asking what was already answered |
| **SFR** — Stale-Fact Rate | (# stale-fact uses) / (# opportunities to use the superseded fact) | 0..1, lower = better | Acting on superseded info |
| **LDR** — Lost-Decision Rate | (# lost-decision events) / (# decisions in record) | 0..1, lower = better | Failing to honour binding decisions |
| **UCR** — Unsupported-Claim Rate | (# unsupported claims) / (# total agent factual claims) | 0..1, lower = better | Hallucinated state (worst-case drift) |
| **CRR** — Correction-Retention Rate | (# corrections honoured later) / (# corrections issued) | 0..1, higher = better | Does correction stick across sessions |

**Composite Drift Score (DS):**

```
DS = 1 - mean(CR, RQR, SFR, LDR, UCR, 1 - CRR)
```

Range 0..1 where **higher = less drift = better**. A perfectly stateful agent scores 1.0.

### 4.3 Operational metrics

Logged alongside drift metrics, not part of DS but published in the table:

| Metric | Unit | Why |
|---|---|---|
| **Tokens per session** | tokens | Cost story |
| **End-to-end latency** | ms p50 / p95 | UX story |
| **Cost per scenario run** | USD | Reproducibility / TCO |
| **Memory-system API calls per turn** | count | Architectural overhead |
| **Storage footprint per scenario** | bytes | Persistence cost |

A system with 0.95 DS but 30s latency and $5/scenario cost is unusable. Operational metrics keep the table honest.

---

## 5. The harness

### 5.1 Components

```
agent-drift-eval/
├── README.md                       # weakest-first results, methodology summary
├── LICENSE                         # MIT for the eval itself
├── METHODOLOGY.md                  # full rubric, scoring rules, judge prompts
├── scenarios/
│   ├── A-coding-agent/
│   │   ├── sessions.json           # deterministic user-side script
│   │   ├── judgements.json         # what to score, with rubrics
│   │   └── README.md               # scenario rationale
│   ├── B-support-agent/...
│   ├── C-sales-sdr/...
│   ├── D-product-agent/...
│   └── E-ops-runbook/...
├── runners/
│   ├── base.py                     # abstract runner: run_session(memory, transcript)
│   ├── skymem.py                   # skyMem MCP adapter
│   ├── mem0.py                     # mem0 SDK adapter
│   ├── zep.py                      # zep/graphiti adapter
│   ├── memori.py                   # memori adapter
│   ├── letta.py                    # letta/memgpt adapter
│   ├── langchain.py                # langchain memory adapter
│   ├── byterover.py                # byterover adapter
│   ├── rag-baseline.py             # plain RAG over conversation log
│   └── no-memory.py                # control: no memory at all
├── judges/
│   ├── opus.py                     # Claude Opus judge
│   ├── gpt4.py                     # GPT-4 Turbo judge
│   └── consensus.py                # dual-judge merge
├── harness/
│   ├── eval.py                     # main entry: orchestrate session runs + scoring
│   ├── scoring.py                  # metrics math (CR, RQR, SFR, LDR, UCR, CRR, DS)
│   ├── reporting.py                # markdown table, JSON results, charts
│   └── replay.py                   # re-judge a saved transcript with a new judge
├── results/
│   ├── 2026-05-12-skymem-A.json    # all raw runs go here
│   ├── 2026-05-12-mem0-A.json
│   └── ... (one file per system × scenario × run)
├── adapters/
│   └── ...                         # any code each runner needs (vendored where licensing permits)
├── Makefile                        # `make eval SYSTEM=mem0`, `make all`, `make report`
├── pyproject.toml                  # python deps
└── docker-compose.yml              # optional: each runner gets a clean container
```

### 5.2 The runner contract

Every `runners/<system>.py` implements:

```python
class Runner:
    name: str                                # "skymem" | "mem0" | ...
    version: str                             # exact version of the system under test

    def setup(self, scenario_id: str) -> None:
        """Fresh memory state. Called before session 1."""

    def run_turn(self, user_message: str, session_idx: int) -> str:
        """One turn: user_message in, agent response out.
        The runner is responsible for whatever memory writes/reads happen."""

    def teardown(self) -> None:
        """Clean up persistent state at end of scenario."""
```

The harness drives `setup → run_turn × N → teardown` per scenario. The user-side messages are read from `sessions.json` deterministically. The agent-side responses are whatever the runner produces (typically: memory.read → LLM call → memory.write).

**Crucially, the LLM driving the agent is the same across all runners** (default: Claude Sonnet 3.7). Only the memory layer varies. This isolates memory-system performance from LLM-quality differences.

### 5.3 The judge contract

`judges/<judge>.py` implements:

```python
class Judge:
    def judge(
        self,
        transcript: list[Turn],
        judgement_spec: JudgementSpec,
    ) -> Judgement:
        """Return {pass|fail|score, rationale, evidence_quote}."""
```

`consensus.py` calls both Opus and GPT-4 Turbo, merges, flags disagreements for human review.

### 5.4 Reproducibility primitives

Every run produces a `results/<date>-<system>-<scenario>.json` file with:

- run timestamp + git SHA of agent-drift-eval
- system-under-test version + adapter version
- LLM model + temperature for the agent
- LLM model + temperature for each judge
- full transcript: every user message, every agent response, every memory call/result
- per-judgement: judge output (both judges) + final verdict
- per-scenario aggregated metrics
- token counts + latency per turn
- total cost in USD

Anyone with API keys can re-run any system and get the same scores ±1 point. Disagreements get logged as issues against the eval, not silently buried.

---

## 6. Reporting format

The README.md headline table (auto-generated from `results/`):

```
## Agent Drift Eval — leaderboard (2026-05-XX)

Scenario showing skyMem's WORST result first.
(Per the honesty contract, we lead with our weakest.)

### Scenario E — Ops/runbook (skyMem worst)

| System | DS ↑ | CR ↓ | RQR ↓ | SFR ↓ | LDR ↓ | UCR ↓ | CRR ↑ | tok/sess | $/run |
|---|---|---|---|---|---|---|---|---|---|
| skyMem v0.7   | 0.78 | 0.10 | 0.05 | 0.18 | 0.12 | 0.04 | 0.85 | 4,200 | $0.18 |
| mem0          | ... |
| zep           | ... |
| memori        | ... |
| letta         | ... |
| langchain-mem | ... |
| byterover     | ... |
| rag-baseline  | ... |
| no-memory     | 0.18 | ... |

### Scenario A — Coding agent

(table)

### Scenario B — Support agent

(table)

### Scenario C — Sales SDR

(table)

### Scenario D — Product agent

(table)

### Composite (mean DS across all 5)

| System | Composite DS ↑ |
|---|---|
| ... |
```

Plus per-scenario charts (matplotlib → PNG, committed to the repo).

Plus a `RESULTS.md` with full per-judgement breakdown for spot-check.

---

## 7. Failure-mode catalogue (published with results)

For every system tested, we publish a short "where it broke" section:

```
### Where skyMem broke

- Scenario E, session 5: when asked to walk through procedure for incident type X,
  the agent recalled the v1 step ordering and missed that the redis-replica-first
  rule from session 2 had been further amended in session 4. The hierarchical
  supersession case was flagged as a known weakness.
- Scenario C, session 4: when the second decision-maker was introduced, agent
  did not proactively diff their concerns vs the original DM's. (Surfaceable on
  request — not surfaced unprompted.)

### Where mem0 broke

- ...

### Where zep broke

- ...
```

This is a defensibility move. **Every system has weaknesses; only one system in this eval is willing to enumerate them publicly.**

---

## 8. The judge-prompt rubric (excerpt)

Judges receive structured prompts. Example for the **lost-decision check** in Scenario A session 4:

```
You are evaluating whether an AI coding assistant honoured a binding decision
made in a prior session.

PRIOR DECISION (session 1):
User: "I want to use session cookies, Redis-backed, with revocation."
Agent: "Acknowledged. Auth = session cookies + Redis revocation."

CURRENT TURN (session 4):
User: "How would I add SSO without breaking the session model?"
Agent: <agent's response>

YOUR JUDGEMENT:
Score 0-3:
0: Agent proposes JWT or otherwise contradicts the session-cookie decision
   without acknowledging it.
1: Agent proposes a compatible path but does not reference the prior decision.
2: Agent references the prior session-cookie decision and proposes a
   compatible SSO design.
3: Agent references the decision, names the rationale (Redis revocation),
   and proposes an SSO design that explicitly preserves both.

Output JSON:
{
  "score": <0|1|2|3>,
  "rationale": "<1-3 sentences>",
  "evidence_quote": "<exact substring of agent response>"
}
```

Every judgement has a similar rubric in `scenarios/<id>/judgements.json`. Rubrics are open in the repo — anyone can audit them.

---

## 9. Versioning

The benchmark itself is versioned. v0.1 = first public release. Every scenario / metric / judge change bumps the version. Old results are retained but tagged with the version they were scored under.

This prevents "they changed the test to make their numbers look good" attacks. Diff between v0.1 and v0.2 is in `CHANGELOG.md`.

---

## 10. What this is NOT

To avoid scope creep:

- ❌ Not a recall benchmark. LOCOMO does that.
- ❌ Not a reasoning benchmark. MMLU/GSM8K/etc do that.
- ❌ Not a token-efficiency benchmark. Cost is logged but isn't the headline.
- ❌ Not a single-turn benchmark. The whole point is across-session continuity.
- ❌ Not a synthetic-conversation benchmark. Scenarios are written by humans, reviewed for plausibility, and refined as we learn.
- ❌ Not a closed eval. Every scenario, every rubric, every adapter is in the public repo for community PRs.

---

## 11. Implementation plan (post-Docker-recovery)

| Day | Deliverable | Depends on |
|---|---|---|
| 1 | Repo scaffolded, README + METHODOLOGY committed | nothing (this spec) |
| 1 | Scenario A — sessions.json + judgements.json | this spec |
| 2 | Scenario A — skymem runner working end-to-end | runner contract + skyMem MCP |
| 2 | Scenario A — judge prompts + Opus judge implementation | this spec § 8 |
| 3 | Scenario A — first scored skymem run on the table | day 1+2 |
| 3 | Scenarios B-E sessions.json drafts | this spec |
| 4 | mem0 + zep + memori adapters | their SDKs |
| 4 | Scenarios B-E judgements.json | day 3 patterns |
| 5 | Full first run: all 5 scenarios × all systems | days 1-4 |
| 5 | README leaderboard auto-generated | day 5 |
| 6 | Public flip — push to `github.com/HopiumLab/agent-drift-eval` | weakest-first table looks honest |
| 6 | HN post + tweet thread + LinkedIn announce | repo public |

Total: ~6 days of focused work after Docker is back. Most of the eval itself is doc + adapter glue — the heavy IP is the scenario design and judge rubrics, both of which are spec-only and can be drafted now.

---

## 12. Why this is a strategic asset, not a vanity project

Three reasons it matters beyond "we have a number":

1. **It defines a category.** As of 2026-05, no one has a public benchmark for "agent drift." Whoever publishes the canonical version owns the term. Engineers will Google "agent drift" and find this repo. Investors will hear "agent drift eval" and associate it with us.

2. **It de-risks the LOCOMO trap.** Right now skyMem is at ~82% LOCOMO vs Mem0/ByteRover at 91-92%. Even if we push to 90%+, the LOCOMO race is crowded. Drift eval is a race we start in the lead.

3. **It surfaces real product wedges.** Building this eval will tell us exactly where skyMem under-performs vs flat-memory systems on cross-session continuity. That's the input to the next 6 months of product work.

If we ship 90%+ LOCOMO **and** the drift eval published with skyMem leading on at least 3 of 5 scenarios, the investor's "leaning yes" threshold gets cleared on the bench front. The remaining gates are then just the install path, the demo, and the 10 weekly devs.

---

## 13. Open questions (to resolve before v1)

- **Judge model drift** — when Opus or GPT-4 Turbo get superseded by new models, do scores from old runs need re-judging? (Likely yes for headline numbers; the `replay.py` tool exists for this.)
- **Adapter parity** — some systems have semantic-search APIs, some have full retrieval pipelines. Is the adapter "best-effort idiomatic" or "minimum viable"? (Lean idiomatic — we want each system at its best.)
- **Scenario inflation** — should we add a 6th and 7th scenario over time? (Yes, but only after v0.1 is published. Discipline first.)
- **Human-judged subset** — should N% of every run go through human review? (Yes for v0.1; goal is calibrating the LLM judge.)
- **Pricing/sponsorship pressure** — when systems-under-test push back on results, how do we handle it? (Public, in-repo, with their PR welcomed against the rubric.)

---

## 14. Cross-references

- `docs/FOCUS.md` — deliverable 4 of the 5-deliverable critical path
- `docs/strategic-pivot-investor-feedback.md` — § "Benchmark strategy — own the category"
- `docs/comparison-honest.md` — competitor capability matrix
- `docs/skymem-pitch.md` — agent drift framing
- `sky/observability.js` — the runtime introspection that the eval will exercise
- `SKY-REBUILD.md` — overall project state

---

**Spec status:** ready to scaffold the repo from. No further design needed before code starts. Implementation gated only on Docker recovery (skyMem runner needs the local stack live).
