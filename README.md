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

**Current state (preliminary, full clean run in flight):**

- Best individual conversation chunks (full stack, both prompt fixes, Cohere ON): **86.3% / 87.5%**
- Last clean 7-of-10 aggregate (persona-only, MiniLM): 59.4%
- Verified 90%+ aggregate run + reproducibility methodology: **in progress**

For comparison: Synthius-Mem 94.4% · ByteRover 92.2% · MemMachine 91.7% · Mem0 91.6% · Memori 81.95%.

We will publish the full clean run with token cost, latency, per-category breakdown, and 10 sample failure cases. Anyone with API keys can reproduce within ±1pp.

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
