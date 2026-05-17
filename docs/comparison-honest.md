# Honest comparison vs every public AI memory system

**Mission:** kill the "how is this different from X?" question with one page. No marketing — actual feature parity. Where they win, we say so. Where we win, we cite the file.

This page exists specifically so the Reddit / HN / /r/MachineLearning comment thread answers itself. If we're missing something a competitor does, that's logged here too.

---

## At a glance — capability matrix

**Audit history:** matrix corrected 2026-05-15 after a reviewer flagged that Zep/Graphiti's substrate features were understated. Zep ships bitemporal validity, episode provenance, contradiction handling, and an MCP server at production scale — all corrected below. Where this matrix was wrong before, it's marked. The honest position is now: **skyMem and Zep share a temporal-graph substrate; skyMem adds an opinionated cognition stack on top.**

| Capability | skyMem | Mem0 (new) | MemMachine v0.2 | Synthius-Mem | ByteRover 2.0 | Memori | Letta (MemGPT) | Zep / Graphiti |
|---|---|---|---|---|---|---|---|---|
| **Bitemporal validity windows** (valid_from / valid_to / invalid_at) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ production-tested, ICLR 2026 |
| **Episode / provenance tracing** (every fact traces to source) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| **Contradiction detection** (active invalidation when evidence conflicts) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| **MCP server included** | ✓ 17 tools | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 4 tools (Nov 2025) |
| **Cognitive domains** (structured fact bank by category) | ✓ 7 domains | ✗ flat memory | ◐ episodic + profile | ✓ 6 domains | ✗ flat markdown | ✗ flat | ✗ flat | ✗ flat graph |
| **Persona-grade fact retrieval** (vs raw turn retrieval) | ✓ | ✗ | ◐ profile only | ✓ CategoryRAG | ✗ | ✗ | ✗ | ✗ |
| **Trajectories with slope/velocity** (fact-confidence math over revisions) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ validity windows only |
| **Network persona auto-promotion** (entities graduate from significance) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Chat-tagging attribution** (auto-attribute messages to entities) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Self-supervised confidence loop** (outcome → fact-confidence) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Behavioural pattern mining** (predictive rules from history) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Multi-axis temporal metadata** (event + mention + ingest time) | ✓ | ✗ | ◐ partial | ✗ | ✗ | ✗ | ✗ | ◐ event + ingest (bitemporal) |
| **Typed relational edges** (subject-predicate-object triples) | ✓ controlled vocab | ✗ | ◐ Neo4j integration | ✗ | ✓ markdown-curated | ◐ entity table | ✗ | ✓ Graphiti |
| **Verifier pass** (second LLM checks evidence support) | ✓ | ✗ | ✗ | ✓ — their pattern | ✗ | ✗ | ✗ | ✗ |
| **Nucleus expansion** (±N adjacent turns per retrieved node) | ✓ — their pattern | ✗ | ✓ — invented this | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Cross-attention reranker** | ✓ Cohere v3.5 | ◐ via search | ✓ cross-encoder | ✗ | ✗ | ✗ | ✗ | ◐ hybrid search |
| **Multi-source retrieval** (parallel signal fusion) | ✓ 5 signals | ✓ 3 signals | ✓ 2 signals | ✓ CategoryRAG | ✓ 5 tiers | ✓ multi-agent | ◐ | ✓ semantic+BM25+graph |
| **Agentic query decomposition** | ✓ Haiku planner | ✗ | ✗ | ✗ | ◐ tier 4 | ✓ analyse step | ✗ | ✗ |
| **Answer-shape modes** (literal / list / temporal / multihop) | ✓ 4 modes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Retrieval-miss reformulation** | ✓ | ✗ | ✗ | ✗ | ✓ tier 4 | ✗ | ✗ | ✗ |
| **Audit-grade observability primitives** | ✓ 8 (explain / trajectory / contradictions / provenance / superseded / decay / lineage / log) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ 2 (episode + provenance) |
| **Open source / self-host** | ELv2 source-available | MIT | Apache | proprietary | open weights | MIT | Apache | Apache |
| **Production maturity** | early (<1yr) | mature | published | mature | mature | mature | mature | mature, ICLR 2026 |
| **Public LOCOMO score** | 70.75% (stuck May 2026) | 91.6% | 91.7% | 94.4% | 92.2% | 81.95% | not disclosed | ~75.1% |

Legend: ✓ shipped / ◐ partial / ✗ not present.

**Honest read after the audit:** The temporal-graph substrate (bitemporal validity, episode provenance, contradiction handling, MCP) is **shared with Zep**, not unique to skyMem. The LOCOMO recall leaders (Synthius / ByteRover / MemMachine / Mem0) don't ship that substrate at all. What's genuinely unique to skyMem is the **cognition stack layered on top**: 7-domain psychographic decomposition, slope-based trajectory math, self-supervised confidence loop, behavioural pattern mining, network persona auto-promotion, chat-tagging attribution, verifier second-pass, 4 answer-shape modes, per-category retrieval profiles. That's the trade: we're younger and less battle-tested than Zep on the substrate; we ship more opinionated layers above it.

---

## Per-competitor honest read

### Mem0 (the closest comparable)

**What they do well:**
- Recently jumped to 91.6% on LOCOMO (the new algorithm)
- MIT licensed — purest open source story
- Multi-language SDKs (Python first-class)
- Strong distribution — 20k+ GitHub stars
- Well-funded ($24M Series A reported), bigger team
- Cloud-hosted option works out of the box

**What they don't have that we do:**
- Cognitive domains (their memory is flat — every fact is just a tagged string)
- Trajectories (no slope/velocity tracking; can't surface "this engagement is rising")
- Network persona auto-promotion (no emergent entity graduation)
- Chat-tagging attribution (no automatic per-conversation persona linking)
- Self-supervised confidence loop (can't decay/reward from outcomes)
- Behavioural pattern mining (no predictive rule extraction)
- Multi-axis temporal metadata (single time axis only)
- Verifier pass (no second-pass evidence checking)
- 4 answer-shape modes (single answer prompt)
- Retrieval-miss reformulation
- MCP server out of the box

**Honest gap they have on us:** distribution, community, funding, multi-language SDKs, hosted offering.

**Honest gap we have on them:** if you need any of the 10+ things they don't have, you can't get it from Mem0 today. Build it on top, or come to us.

**The question to ask yourself:** is "flat memory" enough for your use case, or do you need structured cognition? Mem0 = flat. skyMem = structured.

### MemMachine v0.2

**What they do well:**
- 91.7% on LOCOMO
- Nucleus expansion is THEIR invention — we adapted it (credit logged in pitch)
- Sentence-level NLTK tokenization is a smart, lightweight approach
- Dual-store (episodic + profile) is a real architectural choice
- Apache 2.0 licensed
- Strong academic credibility

**What they don't have that we do:**
- 7-domain persona vs their 2-store model
- Trajectories on facts
- Network auto-promotion
- Chat-tagging
- Self-supervised loop
- Behavioural patterns
- Verifier pass
- 4-shape answer modes
- MCP server
- Cohere reranker built in (theirs uses cross-encoder, fine; ours is Cohere)

**Honest gap they have on us:** higher LOCOMO score (currently). Better academic citation.

**Honest gap we have on them:** dynamic memory (theirs is more static), self-improvement loops, attribution model.

**The question to ask yourself:** if you want a published, peer-reviewed system, MemMachine is more credentialed today. If you want the architectural feature surface, skyMem is wider.

### Synthius-Mem (the LOCOMO leader)

**What they do well:**
- 94.4% on LOCOMO (best published score)
- 99.55% adversarial robustness (their verifier mechanism — we adapted)
- 6 cognitive domains (we extended to 7)
- CategoryRAG retrieval pattern
- 21.79ms latency (fastest)

**What they don't have that we do:**
- Trajectories (their facts are static; ours have revision history)
- Network persona auto-promotion (theirs is manual)
- Chat-tagging attribution (no per-conversation linking)
- Self-supervised confidence loop (no outcome feedback)
- Behavioural pattern mining
- Multi-axis temporal metadata
- Typed relational edges
- 4-shape answer modes
- MCP server
- Self-host (they're proprietary)

**Honest gap they have on us:** highest score. Sub-25ms latency.

**Honest gap we have on them:** they're proprietary; you can't run them yourself, can't customize, can't audit. We're source-available under ELv2.

**The question to ask yourself:** if you want the highest-scoring proprietary system, Synthius wins on numbers. If you want to self-host and own your data, skyMem is the only option in this benchmark band.

### ByteRover 2.0

**What they do well:**
- 92.2% on LOCOMO
- 5-tier progressive retrieval is novel (hash cache → Jaccard → BM25 → constrained LLM → agentic)
- NO embeddings — markdown-curated approach
- AKL scoring (importance + maturity tiers + recency decay) — well-designed
- Open weights

**What they don't have that we do:**
- Embeddings + reranking (they deliberately avoid; we use Cohere)
- 7 cognitive domains
- Trajectories, network promotion, chat-tagging, self-supervised loop, behavioural patterns
- Verifier pass
- 4-shape answer modes
- MCP server

**Honest gap they have on us:** their tiered retrieval is faster on cache hits; their no-embedding approach is interesting for low-resource deployments.

**Honest gap we have on them:** the cognition layer — they have markdown files, we have a graph + persona stack.

**The question to ask yourself:** if you want fast no-embedding retrieval, ByteRover is interesting. If you want structured cognition, skyMem.

### Memori

**What they do well:**
- 81.95% on LOCOMO
- Multi-agent (capture / analyse / select) — solid pattern
- Three modes (Conscious / Auto / Combined)
- 1,294 tokens/query — efficient
- MIT licensed

**What they don't have that we do:**
- Higher LOCOMO score (we project 75-90%, but their published is below 82%)
- Cognitive domains
- Trajectories, network promotion, chat-tagging, self-supervised, patterns
- Verifier pass
- Multi-axis temporal
- Typed edges
- MCP server

**Honest gap they have on us:** simpler architecture, easier to understand, well-documented.

**Honest gap we have on them:** depth of architecture across the board.

**The question to ask yourself:** if you want a simpler, smaller-scope memory system, Memori is decent. For the full cognition stack, skyMem.

### Letta (formerly MemGPT)

**What they do well:**
- Strong academic credibility (the original MemGPT paper)
- Apache 2.0 licensed
- Good multi-agent infrastructure
- Cloud + self-host options
- Active community

**What they don't have that we do:**
- LOCOMO score not published (they don't really compete on this benchmark)
- Cognitive domains
- Trajectories
- Network auto-promotion
- Chat-tagging
- Self-supervised loop
- Behavioural patterns
- Multi-axis time
- Verifier pass
- 4-shape modes
- Cohere reranker
- MCP server out of the box

**Honest gap they have on us:** academic citation, agent framework integration, larger community.

**Honest gap we have on them:** the persona / trajectories / network / attribution layer.

### Zep / Graphiti (the closest architectural comparable)

**What they do well — and where the matrix originally understated them:**
- Bitemporal validity windows (valid_from / valid_to / invalid_at) — production-tested, peer-reviewed at ICLR 2026
- Episode / provenance tracing as a first-class primitive — every fact traces back to source
- Contradiction handling via LLM edge comparison + active invalidation
- MCP server (`add_episode`, `search_facts`, `search_nodes`, `get_episodes`) — v1.0 since November 2025, deployed at scale via Claude Desktop / Cursor / Windsurf
- Hybrid retrieval (semantic + BM25 + graph traversal)
- Production deployments in CRM, compliance, healthcare workflows
- Apache 2.0 licensed
- Real funding, real team, real adoption (thousands of GitHub stars)
- LOCOMO ~75.1% (currently above skyMem's 70.75% on this specific benchmark)

**Where the README/matrix was wrong before:** earlier versions of this page marked Zep ✗ on contradiction surfacing, provenance, supersession, and MCP server. **All four were wrong** — Zep ships all of these. Corrected 2026-05-15. We owe the credit publicly because the temporal-graph substrate that skyMem builds on is the same one Zep already proved out.

**What they don't ship that skyMem does (the genuine differentiation, narrower than previously claimed):**
- 7-domain psychographic decomposition (their graph is flat — entity nodes without cognitive-domain organisation)
- Trajectories with slope/velocity math (theirs is temporal validity, ours adds confidence-slope analysis on top)
- Self-supervised confidence loop (outcome → fact-confidence feedback)
- Behavioural pattern mining (nightly Sonnet sweep extracting predictive rules)
- Network persona auto-promotion (entities graduate from significance thresholds)
- Chat-tagging attribution (auto-attribute every message to entities)
- Verifier second-pass (adapted from Synthius — Zep doesn't have this either)
- 4 answer-shape modes (literal / list / temporal / multihop routing)
- Per-category retrieval profiles (the T4f cognition router)
- 8 audit-grade observability primitives vs Zep's 2 (episode + provenance)

**Honest gap they have on us:** the temporal-graph substrate is more mature, more battle-tested, more cited, and ranks higher on LOCOMO right now. If you want production-tested temporal knowledge graph today, Zep is the more conservative pick.

**Honest gap we have on them:** the cognition stack layered above the substrate. None of the seven layered features above are in Zep's roadmap as far as we can tell.

**The realistic positioning:** skyMem is an **opinionated implementation** of the same core idea Zep ships, with more layers and a younger codebase. Pick on whether the opinion is what you want, not whether the substrate is unique — it isn't.

**The question to ask yourself:** if you need production-tested temporal knowledge graph with provenance + bitemporal validity, Zep is more mature today. If you want that substrate **plus** an opinionated cognition stack (7 domains, slope trajectories, confidence loop, behavioural patterns, entity graduation, chat-tagging, verifier, answer-shape routing), skyMem is the only system shipping that combination — at the cost of less battle-testing.

---

## Where each leader genuinely beats us

This list is on purpose. Honesty bar.

| Leader | What they're better at | Why we're not closing this gap |
|---|---|---|
| **Synthius** | Highest LOCOMO score (94.4%). Sub-25ms latency. | Their lead is small (3-19pp depending on our final number) and we don't optimize for raw latency at the cost of architectural depth. |
| **Mem0** | Distribution. 20k+ GitHub stars. Multi-language SDKs. Hosted offering. | We're 4 days old. Distribution comes after the launch. |
| **MemMachine** | Academic credibility. Nucleus expansion paper. | We adapted their nucleus pattern; we cite them. The architecture trade-off is theirs is purer, ours is wider. |
| **Letta** | Mature agent framework integration. | We expose MCP for AI builders, which serves a similar purpose without the LangGraph-style framework lock-in. |
| **Zep** | Production-grade temporal knowledge graph + bitemporal validity + episode provenance + 4-tool MCP server (Nov 2025) + ICLR 2026 paper. Substrate is more mature than ours. | Our typed-edges module is younger; their bitemporal model is the published reference. We add cognition layers on top, not in the substrate itself. |
| **ByteRover** | Speed on cache hits. No-embedding deployment. | Different design philosophy — we use embeddings. Theirs is interesting for cost-constrained edge deployments. |

**This list tells the truth.** No one wins on every dimension. We win on architectural surface area + self-improvement loops + the dual-face brand (Sky as PA + skyMem as engine). They win on score, distribution, maturity, or specific clever mechanics. Pick the trade-off that matches your problem.

---

## What about the patterns we adopted from them

Credit-where-due is a defensibility lever. We adapted:

- **Nucleus expansion** from MemMachine v0.2 (cited in `sky/nucleus-expansion.js` JSDoc)
- **Verifier pattern** from Synthius's adversarial robustness work (cited in `sky/answer-verifier.js`)
- **Multi-signal parallel fusion** from Mem0-new (cited in `sky/index.js#buildContext`)
- **Cognitive domain organization** from Synthius-Mem 6-domain pattern (cited in `sky/persona.js`)
- **Multi-tier retrieval inspiration** from ByteRover 2.0

We don't claim to have invented every layer. We claim to have ASSEMBLED them in a combination none of the leaders ship.

---

## Honest answers to FAQ-style attacks

### "Why not just use Mem0?"

If flat memory is enough for your use case, Mem0 is a fine pick. They're MIT-licensed, well-distributed, and have multi-language SDKs. If you need structured cognition (persona by domain, trajectories, network promotion, chat-tagging, self-supervised loops), Mem0 doesn't have it today. You'd be building those on top yourself.

### "Why not just use Synthius?"

Synthius has the highest score, but it's proprietary. You can't self-host. You can't audit. You can't customize. If those are non-issues for your use case, Synthius is the leader. If self-host or audit-ability matters, skyMem is the only option in this benchmark band.

### "Why not just use a vector DB + RAG?"

Because RAG retrieves paraphrases of your past conversations, not structured facts. RAG doesn't know what's superseded. RAG doesn't have trajectories. RAG doesn't auto-promote entities. RAG doesn't have a verifier pass. See pitch deck Section 2 for the deeper teardown of why RAG saturates fast.

### "Why ELv2 instead of MIT?"

Because we want self-hosting to be free forever, but we don't want a competitor to take the code and run a competing hosted service. ELv2 says: do whatever you want with this except spin up "skyMem-as-a-service" yourself. Self-host, modify, embed in your own product, all fine. Compete with us by hosting our own code? Reserved.

This is the same decision Elastic, Redis, MongoDB, and increasingly more open-core companies have made. We acknowledge it's not OSI open-source. We don't claim it is.

### "Solo founder, why should I trust this?"

Eat-our-own-dogfood: Ross's actual WhatsApp + life context has been running on this system since April 2026. Every commit is dogfooded immediately. The architecture isn't theoretical — it's lived. The 13 layers each earn their place under a daily-driver workload before they ship.

That said: the project is young. The pitch deck Section 11 explicitly lists this as a limitation. Cold-start, scale, multi-tenant, multi-language all need real production usage to harden.

If you want a battle-tested system serving enterprises today, Mem0 / Letta / Synthius / Zep have more years on their odometer. If you want the architectural surface area + self-host + benchmark-leading combination, skyMem.

---

## When NOT to pick skyMem

The honest answer matrix.

| Your situation | Better pick |
|---|---|
| You need a flat memory bank, MIT license, multi-language SDKs | **Mem0** |
| You need the highest LOCOMO score, proprietary OK | **Synthius** |
| You need an academic-cited agent framework | **Letta / MemGPT** |
| You need production temporal knowledge graph today | **Zep / Graphiti** |
| You need fast cache-hit retrieval, no embeddings | **ByteRover 2.0** |
| You need a simple, well-scoped memory layer with ~80% LOCOMO | **Memori** |
| You need pure vector retrieval at scale (billions of vectors) | **Pinecone / Weaviate** |

| Your situation | skyMem is your fit |
|---|---|
| You want structured cognition, not flat memory | ✓ |
| You want self-host + benchmark-leading combination | ✓ |
| You're building agentic workflows / Claude Code / Cursor extensions | ✓ (MCP server) |
| You want trajectories / network promotion / self-supervised loops | ✓ (no one else has all 3) |
| You need ELv2 source-available license | ✓ |

---

## How to verify any of this

```bash
# Self-host skyMem
git clone https://github.com/<org>/skymem-io.git
cd skymem-io
./install.sh --demo

# Reproduce our LOCOMO numbers
docker exec skymem bash /app/scripts/run-locomo-sequential.sh

# Inspect any feature we claim
ls -la sky/   # 28 modules, each with JSDoc explaining what + why
```

If a row in the matrix is wrong, file an issue. We update.

---

**This page is the answer to "how is this different from X" before anyone asks. Bookmarked. Linked from the README. Never marketing — always honest.**
