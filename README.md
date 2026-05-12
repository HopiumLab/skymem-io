# skyMem

**The trusted state layer for persistent AI agents.**

Memory that knows what changed, what's contradicted, what's superseded, and why — with full provenance.

Built for AI engineering teams first (Claude Code · Cursor · agentic frameworks). Same engine extends to teams, vertical SaaS, and audit-grade enterprise.

> _This repo (`HopiumLab/skymem-io`) is the source-available reference implementation. Bring your own LLM keys (Anthropic + Cohere), data stays on your machine. Elastic License v2 — self-host freely; commercial-hosted-service rights reserved._

---

## Why this exists

If you've used Claude Code / Cursor / Devin for anything serious, you've felt **agent drift**: the AI decides X in session 1, contradicts itself in session 3, and by session 5 your repo has both implementations. Bigger context windows don't fix this — the lost-in-the-middle effect compounds with size. Better embeddings don't fix this. The fix is **structured cognition**: a graph of nodes + persona-grade facts + trajectories + provenance that the agent queries every turn instead of being handed flat markdown.

That's skyMem.

---

## Why skyMem (vs alternatives)

**The honest position:** Mem0, MemMachine, Synthius, ByteRover all score higher on LOCOMO today (91-94%). skyMem is at 70.75% and climbing. So why pick this?

Because LOCOMO measures **recall on a static dataset**. Production AI breaks on things LOCOMO doesn't test: contradiction across sessions, stale beliefs not getting suppressed, no provenance when something goes wrong, no audit trail for compliance, fact retrieval that doesn't know who said what.

**What we have that they don't:**

| Feature | skyMem | Mem0 | MemMachine | Synthius | ByteRover | Letta | Zep |
|---|---|---|---|---|---|---|---|
| Cognitive domains (7 categories of facts) | ✓ | ✗ | ◐ | ✓ | ✗ | ✗ | ✗ |
| Fact trajectories (confidence slope over time) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ |
| Audit-grade observability (8 primitives) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Provenance + supersession + contradiction surfacing | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Verifier second-pass (catches hallucination) | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| 4 answer-shape modes (literal/list/temporal/multi-hop) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Per-category retrieval profiles (cognition router) | ✓ T4f | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| MCP server (17 tools, drop-in for Claude Code/Cursor) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Self-supervised confidence loop | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Behavioural pattern mining | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Open source + self-hosted (data stays local) | ✓ ELv2 | ✓ MIT | ✓ Apache | ✗ | ◐ | ✓ | ✓ |
| Bring-your-own LLM keys (no SaaS lock-in) | ✓ | ◐ hosted | ✓ | ✗ | ◐ | ✓ | ✓ |

Legend: ✓ shipped · ◐ partial · ✗ not present.

Full per-system breakdown with reproducible citations: [`docs/comparison-honest.md`](docs/comparison-honest.md). If we're missing something a competitor does, it's logged there.

**The question to ask:** is "flat memory + good retrieval" enough, or do you need **structured cognition + audit trail + observability**?

- **You're building production AI agents** → you need contradiction surfacing, provenance, supersession. The 91% systems don't have these.
- **You're shipping in regulated industries** (finance, health, legal) → audit-grade observability isn't optional. EU AI Act Articles 12 + 13 require it. We're the only system that ships it as a first-class primitive.
- **You want to know WHY the AI answered the way it did** → `explain_retrieval`, `fact_trajectory`, `provenance_tree`, `decision_lineage` are all one MCP call away.
- **You need pure recall on a benchmark** → today, Mem0 / MemMachine score higher. Honestly. We're working on it — see the progress section below.

---

## Design choices (the "why this, not something simpler?")

Quick rationale for the 4 architectural decisions that drove the rest:

### 1. Why a graph, not just vector embeddings?

Vector search retrieves "similar text." It cannot traverse "John works at Y → Y is in industry Z → so John is probably in Z."

Multi-hop reasoning (cat=3 on LOCOMO) needs the graph. Cat=3 was 44.79% in our T1 baseline. With graph traversal + typed edges + cognition router, it's now 50%. Flat-memory systems can't reach this — they don't have the substrate.

### 2. Why structured cognition (7 cognitive domains), not flat fact lists?

A flat "list of facts" treats `John lives in Brooklyn` and `John works at Pfizer` and `John's wife is named Kate` as equivalent strings. They're not.

skyMem separates them into **identity / people / preferences / portfolio / active / goals / decisions** — seven cognitive domains. When a question is about "what does John think about X?", the retrieval prioritises the `active` + `decisions` domains. When it's "who is John's family?", it prioritises `people`. The persona block at the top of the prompt comes from this structure — the model sees curated facts grouped by relevance, not paraphrased noise.

The 91% systems use flat memory. Per-category retrieval profiles (the T4f cognition router) require structured cognition to operate on. Same code on flat memory would have nothing to route.

### 3. Why audit-grade observability as a first-class primitive?

If your AI gives a customer the wrong refund amount, "the model hallucinated" is not a legally adequate answer. You need:

- **Provenance**: which exact memory nodes informed this answer? (`provenance_tree`)
- **Supersession**: was a contradicting belief overridden? When? Why? (`superseded_facts`)
- **Trajectory**: was this belief getting more or less confident over time? (`fact_trajectory`)
- **Audit log**: append-only, read-only event stream for compliance auditors. (`audit_log`)

These aren't extras bolted on after — they're part of the data model. Every belief carries its provenance. Every supersession is logged. Every contradiction is detected and retained.

EU AI Act Articles 12 + 13 will require this for "high-risk" AI systems by 2026. Most current memory systems would need a full rebuild to comply. skyMem is built for it from the ground up.

### 4. Why bring-your-own-keys + self-hosted, not SaaS?

Your conversations / decisions / personal facts are the most sensitive data you produce. They should not pass through someone else's servers.

skyMem runs as a Docker compose stack on your machine. You bring your own Anthropic + Cohere keys. The graph, the embeddings, the audit log — all stays local. If you switch off the internet, the cognition stack still works (everything except the LLM calls).

Mem0 / MemMachine / Letta / Zep are all open-source-able, so this isn't unique. But many "memory" startups are hosted-only with proprietary cores. We're explicit: source-available, Elastic License v2, self-host freely, no vendor lock-in.

---

## What's in the box

### 13-layer cognition stack

```
┌─────────────────────────────────────────────────────┐
│  L13  Chat-tagging (per-conversation attribution)   │
│  L12  Network personas (auto-promotion thresholds)  │
│  L11  Self-supervised confidence loop               │
│  L10  Counterfactual sim (design only)              │
│  L9   Behavioural patterns (nightly cron)           │
│  L8   Trajectories — slope/velocity per fact        │
│  L7   Persona — 7 cognitive domains                 │
│  L6   Agentic planner — query decomposition         │
│  L5   Multi-source retrieval (semantic+FTS+edge)    │
│  L4   Cohere cross-attention reranker               │
│  L3   Scope/audience/tier filter                    │
│  L2   Multi-hop graph traversal (typed edges)       │
│  L1   Synaptic-strength graph                       │
└─────────────────────────────────────────────────────┘
```

### Audit-grade observability (Tier 5)

The compliance backbone for regulated AI. Every belief has provenance, every fact has a confidence trajectory, every contradiction surfaces, every decision has a lineage. EU AI Act Articles 12 + 13 ready.

Eight observability primitives, exposed both as functions and as MCP tools:

| Primitive | What it answers |
|---|---|
| `explain_retrieval` | Why these 12 nodes — and not the others |
| `fact_trajectory` | Confidence over time, slope, state class |
| `find_contradictions` | Conflicting beliefs, both sources retained |
| `provenance_tree` | Source nodes for any belief, auditable to the line |
| `superseded_facts` | Old beliefs replaced — kept for audit, not retrieval |
| `decay_report` | Beliefs aging out, reference counts thinning |
| `decision_lineage` | Where a decision was used, by whom, when |
| `audit_log` | Append-only, read-only, court-grade event stream |

See `sky/observability.js`.

### MCP server — 17 tools

Drop-in for any MCP-compatible client (Claude Code, Cursor, Windsurf, Devin, Zed). 8 cognition tools + 9 observability tools. See `sky/mcp-server.js`.

### Plus

- 4 answer-shape modes (literal · list · temporal arithmetic · multi-hop chain-of-thought)
- Synthius-pattern verifier pass (catches hallucinations)
- Retrieval-miss reformulation (vocabulary-mismatch recovery)
- Lenient semantic-first grader

---

## Benchmarks

### LOCOMO (long-conversation memory)

We ship to LOCOMO — the public benchmark from snap-research. 1,986 graded questions across 10 multi-turn conversations, 5 task categories (single-hop, multi-hop, temporal, open-domain, adversarial).

**Recent progress** — 4 full LOCOMO runs over 48 hours, each with its mechanism documented:

```
May 10  T1 baseline                           66.82%
May 11  T3 v2 (verifier surgery, prompt fix)  69.23%   +2.41 pp ─┐
May 11  T4e (classifier coverage gaps)        69.84%   +0.61 pp  │  +3.93 pp
May 12  T4f (cognition router per-cat)        70.75%   +0.91 pp ─┘  in 48 hours
```

Three of those lifts shipped on the same calendar day (May 11 morning → evening → May 12 morning). The pattern: each run earns its lift by isolating ONE mechanism, ablation-validating it on a target conversation, then committing only if the per-cat metric the mechanism targets actually moves. Speed comes from discipline — no global "throw mechanisms at it" sprints.

**Current state — full clean 10-of-10 aggregate, reproducible from this repo:**

| Run | Aggregate | Δ baseline | Run tag |
|---|---|---|---|
| T1 (baseline) | 66.82% | — | `t3fs-20260510-202955` |
| T3 v2 (verifier surgery + classifier broadening) | 69.23% | +2.41 | `t3fs-20260511-093306` |
| T4e (classifier coverage gaps) | 69.84% | +0.61 | `t3fs-20260511-202406` |
| **T4f (cognition router per-cat profiles)** | **70.75%** | **+0.91** | `t3fs-20260512-064522` |

**T4f per-category breakdown:**

| Cat | Volume | Score | vs T3 v2 |
|---|---|---|---|
| cat=1 single-hop | 14.2% | 44.33% | +3.55 |
| cat=2 temporal | 16.2% | 59.50% | +1.87 |
| cat=3 multi-hop | 4.8% | **50.00%** | +5.21 |
| cat=4 open-domain | 42.3% | 74.91% | +1.07 |
| cat=5 adversarial | 22.5% | 92.15% | -0.42 |

**T5 (in progress)** — temporal-proximity scoring for cat=2 (the biggest remaining headroom). cat=2 spot-test shows +7-12 pp lift on the target conv. Full bench data pending.

For competitor comparison context: Synthius-Mem 94.4% · ByteRover 92.2% · MemMachine 91.7% · Mem0 91.6% · Memori 81.95%. **We're explicit that we're below them today** — the path from 70.75% to 82-85% is in [`docs/COGNITION-ROUTER.md`](docs/COGNITION-ROUTER.md), and the methodology behind each lift is in the receipts at [`docs/T3-RESULTS.md`](docs/T3-RESULTS.md), [`docs/T4e-RESULTS.md`](docs/T4e-RESULTS.md), and [`docs/T4f-RESULTS.md`](docs/T4f-RESULTS.md).

**Reproduce locally:**

```bash
git clone https://github.com/HopiumLab/skymem-io.git
cd skymem-io && cp .env.example .env  # add ANTHROPIC_API_KEY + COHERE_API_KEY
./install.sh
docker exec -d sky-bridge bash /app/scripts/run-t3-fullstack.sh
# After ~5.5h, summary lands in /app/bench/t3fs-<timestamp>-summary.json
# Expected variance ±1pp.
```

### Agent Drift Eval (our benchmark)

LOCOMO measures recall on a static dataset. **Agent Drift Eval measures what production breaks** — multi-session decision continuity, contradiction resistance, stale-fact suppression, correction retention.

Five scenarios (coding, support, sales, product, ops), six metrics + composite Drift Score, dual-judge harness (Claude Opus + GPT-4 Turbo), runner contract for skyMem and every public competitor on the same scoring.

**Spec status:** v0.1 drafted at [`docs/agent-drift-eval-spec.md`](docs/agent-drift-eval-spec.md). The eval lives in its own public repo — `github.com/HopiumLab/agent-drift-eval` — to keep the benchmark independent of the system under test.

The honesty contract:

1. We publish our **weakest scenario first**.
2. We run **every public competitor** on the same harness.
3. The eval is **reproducible from a clean checkout**.

---

## Quick start (BYOK Docker)

skyMem runs as a Docker compose stack. You bring your own LLM keys, data stays on your machine.

**Prerequisites:**

- Docker Desktop / Docker engine
- An [Anthropic API key](https://console.anthropic.com/) (Claude Sonnet/Haiku)
- A [Cohere API key](https://dashboard.cohere.com/) (free tier is enough for demo mode)
- ~16 GB RAM available to Docker

**One-command install:**

```bash
git clone https://github.com/HopiumLab/skymem-io.git
cd skymem-io
./install.sh
```

**Demo mode (no real data):**

```bash
./install.sh --demo
```

Spins up with sample MemoryNodes + sample persona facts. Lets you try the chat path without any pairing.

> _An `npx skymem-mcp init` install path that wires directly into Claude Code's `~/.claude.json` and Cursor's MCP config is on the immediate roadmap. For now, install the Docker stack and the MCP server is live at `http://localhost:7411/mcp`._

---

## Modes

### `--mode=builder` (AI engineering — recommended starting point)

No WhatsApp pairing. Reads from a project root (markdown, code, git history). Ingests as MemoryNodes scoped to a `projectId`. Acts as an MCP server so Claude Code / Cursor / agentic frameworks can query the graph at session-start.

```bash
./install.sh --mode=builder --project-root=/path/to/your/project
```

### `--mode=org` (team/company memory)

Multi-source ingest: Slack, Notion, GitHub, calendar. Persona domains map to departments / functions. Designed for org-wide context.

(Stage 2 — partial.)

### `--mode=pa` (personal AI assistant)

Pairs with WhatsApp via Baileys. Personal-PA dogfood mode — proves the cognition works on a single user's life over months. Used to stress-test trajectories, network promotion, and chat-tagging at real-life cadence.

---

## Architecture summary

| Component | What it does | File |
|---|---|---|
| **Persona retrieval** | Structured fact bank in 7 cognitive domains | `sky/persona.js` |
| **Persona extractor** | LLM-driven distillation of memory nodes into persona facts | `sky/persona-extractor.js` |
| **Trajectories** | Slope/velocity/state on persona-fact revisions | `sky/trajectories.js` |
| **Network personas** | Auto-promote high-signal entities to first-class records | `sky/network-personas.js` |
| **Chat-tagging** | Map chat scopes to personas; auto-attribute every node | `sky/chat-tagging.js` |
| **Behavioural patterns** | Nightly Sonnet sweep mining predictive rules | `sky/behavioural-patterns.js` |
| **Self-supervised confidence** | Outcome-driven persona-fact confidence adjustment | `sky/persona-validation.js` |
| **Typed edges** | Subject-predicate-object triples for multi-hop reasoning | `sky/typed-edges.js` |
| **Multi-axis time** | event_time / mentioned_time / sequence on every node | `sky/temporal-axes.js` |
| **Nucleus expansion** | ±N adjacent turns per retrieved node | `sky/nucleus-expansion.js` |
| **Verifier pass** | Second-pass evidence check against persona facts | `sky/answer-verifier.js` |
| **Query reformulator** | Retry retrieve+answer with rephrased query when abstaining | `sky/query-reformulator.js` |
| **Memory observability** | Tier 5 introspection + audit-grade primitives | `sky/observability.js` |
| **MCP server** | 17 tools exposed for Claude Code / Cursor / etc. | `sky/mcp-server.js` |

---

## Bench it yourself

The LOCOMO public benchmark runner is included so you can verify the numbers on your install:

```bash
docker exec sky-bridge bash /app/scripts/run-locomo-sequential.sh
```

Writes per-conv result JSONs + an aggregate summary to `/app/bench/`.

---

## Roadmap (post-pivot, sequenced)

| Stage | When | What |
|---|---|---|
| **Stage 1 — Builders** | now → month 6 | MCP for Claude Code / Cursor / Devin. Narrow ICP: AI-heavy dev teams on multi-week projects. |
| **Stage 2 — Teams** | months 6-12 | Same teams + Slack / Notion / GitHub ingest. Team memory tier. |
| **Stage 3 — Vertical SaaS embeds** | months 12-18 | API/MCP commercial. Embed the cognition stack in your own product. |
| **Stage 4 — Audit-grade enterprise** | months 18-24 | Healthcare / legal / finance. EU AI Act compliance backbone. |
| **PA mode** | always available | Founder dogfood + emotional brand — never the lead product. |

---

## License

[**Elastic License v2**](LICENSE) — source-available. Self-host freely; commercial-hosted-service rights reserved.

The cognition stack (persona / trajectories / network promotion / chat-tagging / observability) is the IP. The packaging is straightforward Docker. We want self-hosting to be free; commercial hosting is reserved.

---

## Contributing

skyMem is in active development. PRs welcome on:

- New ingest adapters (Slack, Notion, GitHub, etc.)
- LOCOMO benchmark improvements
- Additional language support beyond English
- Agent Drift Eval scenarios + competitor adapters
- MCP client adapters for new IDEs / agent frameworks

---

## Credits

- LOCOMO benchmark: [snap-research/locomo](https://github.com/snap-research/locomo)
- Persona pattern inspiration: Synthius-Mem (cognitive domains + CategoryRAG)
- Nucleus expansion: MemMachine v0.2 paper
- Multi-source retrieval: Mem0-new
- Verifier mechanic: Synthius adversarial robustness paper

---

## Links

- **Site:** [skymem.io](https://skymem.io)
- **Engine repo (this):** [`HopiumLab/skymem-io`](https://github.com/HopiumLab/skymem-io)
- **Benchmark repo:** [`HopiumLab/agent-drift-eval`](https://github.com/HopiumLab/agent-drift-eval) _(coming soon)_
- **Pitch:** [`docs/skymem-pitch.md`](docs/skymem-pitch.md)
- **Honest competitor comparison:** [`docs/comparison-honest.md`](docs/comparison-honest.md)
- **Agent Drift Eval spec:** [`docs/agent-drift-eval-spec.md`](docs/agent-drift-eval-spec.md)
