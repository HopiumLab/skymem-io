/**
 * skyMem MCP Server — Tier 4 Distribution (2026-05-10).
 *
 * Exposes Sky's cognition stack as an MCP (Model Context Protocol) server
 * so AI engineering tools (Claude Code, Cursor, Devin, agentic frameworks)
 * can query the graph at session start + during long-running work to
 * eliminate context drift.
 *
 * The thesis (from docs/skymem-distribution.md):
 *   Most AI engineering drift comes from flat-file context dumps. A
 *   200KB markdown blob loses thread by mid-session. Inject the project
 *   as a graph + persona facts + trajectories and the AI sees STRUCTURED
 *   COGNITION instead of paraphrased prose.
 *
 * Tools exposed via MCP:
 *   • get_persona_block       — retrieve top-N persona facts for a query
 *   • get_relevant_memories   — graph + FTS + edge-walk retrieval
 *   • get_decisions           — recent decisions in the project
 *   • get_trajectories        — what's rising/declining/volatile
 *   • get_typed_path          — multi-hop relational walk
 *   • write_decision          — record a new decision (with edges)
 *   • write_observation       — record an observation/insight
 *   • get_temporal_window     — events in a date range
 *
 * The MCP spec (https://modelcontextprotocol.io) defines the JSON-RPC 2.0
 * envelope. This implementation is HTTP+JSON for simplicity; an stdio
 * transport variant is left as a follow-up.
 *
 * Boot:
 *   node sky/mcp-server.js [--port=3003] [--scope=<projectId>]
 *
 * Wire from Claude Code / Cursor (example):
 *   {
 *     "mcpServers": {
 *       "skymem": {
 *         "url": "http://localhost:3003/mcp"
 *       }
 *     }
 *   }
 */

import http from 'http';
import prisma from './prisma-client.js';
import persona from './persona.js';
import graph from './graph.js';
import trajectories from './trajectories.js';
import typedEdges from './typed-edges.js';
import temporalAxes from './temporal-axes.js';
import observability from './observability.js';
import { ftsHotSearch } from './keyword-search.js';

const PORT = parseInt(process.env.MCP_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3003', 10);
const DEFAULT_SCOPE = process.argv.find(a => a.startsWith('--scope='))?.split('=')[1] || null;

// ============================================================
// MCP TOOLS
// ============================================================

const tools = {
  /**
   * Get top-N persona facts relevant to a query. Use this at session start
   * or when starting a new sub-task to ground the AI in structured facts
   * instead of re-reading the whole project.
   */
  get_persona_block: {
    description: 'Retrieve persona facts (identity / portfolio / active / people / decisions / preferences / goals) relevant to a query. Returns a curated, deduplicated text block ready to inject into the AI session context.',
    parameters: {
      query: { type: 'string', description: 'The current question or task' },
      scope: { type: 'string', description: 'Optional projectId / chatJid scope', optional: true },
      domain_hints: { type: 'array', items: { type: 'string' }, optional: true },
      limit: { type: 'integer', default: 12, optional: true },
    },
    async handler({ query, scope = null, domain_hints = [], limit = 12 }) {
      const facts = await persona.retrieveForQuery(query || '', {
        domainHints: domain_hints,
        scope: scope ? { chatJid: scope } : null,
        limit,
      });
      return {
        block: persona.buildPersonaBlock(facts),
        facts: facts.map(f => ({
          domain: f.domain,
          slot: f.slot,
          confidence: f.confidence,
          text: f.facts?.text || JSON.stringify(f.facts),
        })),
      };
    },
  },

  /**
   * Multi-source retrieval — semantic + FTS + edge-walk + reranker. Returns
   * the same evidence Sky uses for chat answers.
   */
  get_relevant_memories: {
    description: 'Retrieve memory nodes most relevant to a query (semantic + keyword + graph traversal + Cohere rerank).',
    parameters: {
      query: { type: 'string' },
      scope: { type: 'string', optional: true },
      limit: { type: 'integer', default: 10, optional: true },
    },
    async handler({ query, scope = null, limit = 10 }) {
      const requestScope = scope ? { chatJid: scope } : null;
      const nodes = await graph.retrieve(query, limit, {}, requestScope);
      return {
        nodes: nodes.map(n => ({
          id: n.id,
          type: n.type,
          content: (n.content || '').slice(0, 500),
          weight: n.weight,
          score: n.score,
          createdAt: n.createdAt,
          eventTime: n.eventTime,
        })),
      };
    },
  },

  /**
   * Recent decisions — useful for "what did we decide about X" queries that
   * are common in long-running agentic work.
   */
  get_decisions: {
    description: 'Recent decisions recorded in the project graph. Returns ordered by date + confidence.',
    parameters: {
      since_days: { type: 'integer', default: 30, optional: true },
      scope: { type: 'string', optional: true },
      limit: { type: 'integer', default: 20, optional: true },
    },
    async handler({ since_days = 30, scope = null, limit = 20 }) {
      const since = new Date(Date.now() - since_days * 86400000);
      const where = {
        domain: 'decisions',
        updatedAt: { gte: since },
      };
      if (scope) where.chatJid = scope;
      const facts = await prisma.personaFact.findMany({
        where,
        orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
        take: limit,
      });
      return {
        decisions: facts.map(f => ({
          slot: f.slot,
          text: f.facts?.text || JSON.stringify(f.facts),
          confidence: f.confidence,
          updatedAt: f.updatedAt,
        })),
      };
    },
  },

  /**
   * Trajectory state — what's rising / declining / stable / volatile across
   * the project's persona facts. Surfaces drift before it becomes a crisis.
   */
  get_trajectories: {
    description: 'Get trajectory state (rising / declining / stable / volatile) for project persona facts. Returns directional change signals.',
    parameters: {
      states: { type: 'array', items: { type: 'string' }, default: ['rising', 'declining', 'volatile'], optional: true },
      scope: { type: 'string', optional: true },
      limit: { type: 'integer', default: 8, optional: true },
    },
    async handler({ states = ['rising', 'declining', 'volatile'], scope = null, limit = 8 }) {
      const items = await trajectories.getInterestingTrajectories({
        states, limit, chatJid: scope,
      });
      return { trajectories: items };
    },
  },

  /**
   * Multi-hop typed edge walk. "Who did the user meet in Hanoi?" →
   * walkPath([ross.id], ['met'], 2).
   */
  get_typed_path: {
    description: 'Walk typed relational edges from anchor nodes. Use for multi-hop questions like "who did X meet" or "what was caused by Y".',
    parameters: {
      anchor_ids: { type: 'array', items: { type: 'string' } },
      predicates: { type: 'array', items: { type: 'string' }, optional: true },
      max_hops: { type: 'integer', default: 2, optional: true },
    },
    async handler({ anchor_ids, predicates = null, max_hops = 2 }) {
      const paths = await typedEdges.walkPath(anchor_ids, predicates, max_hops);
      return { paths };
    },
  },

  /**
   * Record a new decision. Used by the AI when it makes a substantive
   * choice during a session — gets stored as a PersonaFact in the
   * decisions domain and surfaced in future sessions.
   */
  write_decision: {
    description: 'Record a decision made during this session. The decision is stored in the persona graph as a fact in the decisions domain so future sessions can retrieve it.',
    parameters: {
      slot: { type: 'string', description: 'A stable kebab-case key for this decision' },
      text: { type: 'string', description: 'One-sentence statement of the decision' },
      confidence: { type: 'number', default: 0.85, optional: true },
      sources: { type: 'array', items: { type: 'string' }, optional: true },
      scope: { type: 'string', optional: true },
    },
    async handler({ slot, text, confidence = 0.85, sources = [], scope = null }) {
      const upserted = await persona.upsertFact({
        domain: 'decisions',
        slot,
        facts: { text, evidence: sources },
        confidence,
        sourceNodes: sources,
        chatJid: scope,
        source: 'mcp-write',
      });
      return { ok: true, factId: upserted.id, domain: upserted.domain, slot: upserted.slot };
    },
  },

  /**
   * Record an observation — anything worth remembering from this session
   * that isn't strictly a decision. Useful for "the user noticed X" or
   * "the codebase has Y pattern".
   */
  write_observation: {
    description: 'Record an observation or insight from this session. Stored as a MemoryNode + extracted into persona over time.',
    parameters: {
      content: { type: 'string' },
      type: { type: 'string', default: 'observation', optional: true },
      tags: { type: 'array', items: { type: 'string' }, optional: true },
      scope: { type: 'string', optional: true },
    },
    async handler({ content, type = 'observation', tags = [], scope = null }) {
      const node = await graph.createNode({
        type,
        content,
        tags: ['source:mcp', ...(Array.isArray(tags) ? tags : [])],
        sourceType: 'mcp',
        scope: scope ? { chatJid: scope } : null,
      });
      return { ok: true, nodeId: node.id };
    },
  },

  /**
   * Events in a temporal window — useful for "what happened last week" or
   * "what was decided in March".
   */
  get_temporal_window: {
    description: 'Get memory nodes whose event_time falls in a given date window.',
    parameters: {
      start: { type: 'string', description: 'ISO date' },
      end: { type: 'string', description: 'ISO date' },
      scope: { type: 'string', optional: true },
      limit: { type: 'integer', default: 30, optional: true },
    },
    async handler({ start, end, scope = null, limit = 30 }) {
      const nodes = await temporalAxes.getNodesInWindow(
        new Date(start), new Date(end),
        { limit, scope: scope ? { chatJid: scope } : null }
      );
      return {
        nodes: nodes.map(n => ({
          id: n.id, type: n.type,
          content: (n.content || '').slice(0, 300),
          eventTime: n.eventTime, mentionedAt: n.mentionedAt,
          timeConfidence: n.timeConfidence,
        })),
      };
    },
  },

  // ============================================================
  // OBSERVABILITY TOOLS (Tier 5, 2026-05-10)
  // ============================================================
  // "Why did the AI believe this?" — every primitive that turns skyMem
  // into auditable enterprise infrastructure.

  explain_retrieval: {
    description: 'For a query and the nodes it retrieved, return a per-node explanation of WHY each node was selected (which signals contributed, what the rerank score was, what the persona match type was). Used for debugging retrieval quality and for compliance audits.',
    parameters: {
      query: { type: 'string' },
      retrieved_nodes: { type: 'array', items: { type: 'object' } },
    },
    async handler({ query, retrieved_nodes }) {
      return { explanations: observability.explainRetrieval(query, retrieved_nodes || []) };
    },
  },

  fact_trajectory: {
    description: 'Get the full trajectory (slope/velocity/state/revision history) of a single PersonaFact. Use to answer "is this fact rising or fading in confidence?" and "when did it change?".',
    parameters: {
      fact_id: { type: 'string' },
    },
    async handler({ fact_id }) {
      return await observability.factTrajectory(fact_id);
    },
  },

  find_contradictions: {
    description: 'List detected pairs of facts that semantically disagree, scored by severity. Output includes the rationale + the resolution state. Critical for compliance reviews of an AI agent\'s belief set.',
    parameters: {
      scope: { type: 'string', optional: true },
      resolution: { type: 'string', default: 'unresolved', optional: true },
      min_severity: { type: 'number', default: 0.5, optional: true },
      limit: { type: 'integer', default: 50, optional: true },
    },
    async handler({ scope, resolution, min_severity, limit }) {
      return { contradictions: await observability.findContradictions({ scope, resolution, minSeverity: min_severity, limit }) };
    },
  },

  provenance_tree: {
    description: 'For a PersonaFact, return the full source-node tree: which raw memory nodes underwrote this belief, plus their connecting edges. The "show me the receipts" call for any single fact.',
    parameters: {
      fact_id: { type: 'string' },
      max_depth: { type: 'integer', default: 2, optional: true },
    },
    async handler({ fact_id, max_depth }) {
      return await observability.provenanceTree(fact_id, { maxDepth: max_depth });
    },
  },

  superseded_facts: {
    description: 'List facts marked as superseded — what the system used to believe vs what it believes now, with transition dates. Surfaces the AI\'s belief evolution.',
    parameters: {
      scope: { type: 'string', optional: true },
      since_days: { type: 'integer', default: 30, optional: true },
      limit: { type: 'integer', default: 50, optional: true },
    },
    async handler({ scope, since_days, limit }) {
      return { superseded: await observability.supersededFacts({ scope, sinceDays: since_days, limit }) };
    },
  },

  decay_report: {
    description: 'Memory decay report — facts trending down in confidence (declining or volatile). At-risk memories that may be wrong or stale. Surfaces what the AI is unsure about.',
    parameters: {
      scope: { type: 'string', optional: true },
      limit: { type: 'integer', default: 20, optional: true },
    },
    async handler({ scope, limit }) {
      return { decaying: await observability.decayReport({ scope, limit }) };
    },
  },

  decision_lineage: {
    description: 'For a decision id (chat-response / proposal / code-suggestion), return the chain of facts + nodes + patterns + trajectory snapshots that produced it. The end-to-end "why did the AI do X" answer.',
    parameters: {
      decision_id: { type: 'string' },
    },
    async handler({ decision_id }) {
      return await observability.decisionLineage(decision_id);
    },
  },

  audit_log: {
    description: 'Time-windowed query over the audit log. Filter by event type / actor / scope. The compliance / SOC2 / ISO 27001 backbone.',
    parameters: {
      event_type: { type: 'string', optional: true },
      actor: { type: 'string', optional: true },
      scope: { type: 'string', optional: true },
      since_days: { type: 'integer', default: 7, optional: true },
      limit: { type: 'integer', default: 100, optional: true },
    },
    async handler({ event_type, actor, scope, since_days, limit }) {
      return { events: await observability.auditLog({ eventType: event_type, actor, scope, sinceDays: since_days, limit }) };
    },
  },

  health_snapshot: {
    description: 'High-level memory health snapshot for a scope. Returns counts of active vs superseded facts, total revisions, open contradictions, decisions in last 24h, and a 0-100 health score. Single-call dashboard widget.',
    parameters: {
      scope: { type: 'string', optional: true },
    },
    async handler({ scope }) {
      return await observability.healthSnapshot({ scope });
    },
  },
};

// ============================================================
// HTTP / MCP HANDLER
// ============================================================

function jsonResponse(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleRequest(req, res) {
  if (req.method === 'GET' && req.url === '/mcp/tools') {
    // List tools — MCP discovery
    const list = Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      parameters: t.parameters,
    }));
    return jsonResponse(res, 200, { tools: list });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true, service: 'skymem-mcp', tools: Object.keys(tools).length });
  }

  if (req.method === 'POST' && req.url.startsWith('/mcp/call/')) {
    const toolName = req.url.slice('/mcp/call/'.length).split('?')[0];
    const tool = tools[toolName];
    if (!tool) return jsonResponse(res, 404, { error: 'unknown tool', available: Object.keys(tools) });

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let args = {};
      try { args = body ? JSON.parse(body) : {}; }
      catch (e) { return jsonResponse(res, 400, { error: 'invalid JSON body' }); }

      // Apply default scope if set at boot
      if (DEFAULT_SCOPE && !args.scope) args.scope = DEFAULT_SCOPE;

      try {
        const result = await tool.handler(args);
        return jsonResponse(res, 200, { ok: true, result });
      } catch (e) {
        console.error(`[mcp] tool ${toolName} failed:`, e);
        return jsonResponse(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  return jsonResponse(res, 404, { error: 'not found', endpoints: ['GET /health', 'GET /mcp/tools', 'POST /mcp/call/<tool>'] });
}

// ============================================================
// BOOT
// ============================================================

function start() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`[skymem-mcp] listening on http://localhost:${PORT}`);
    console.log(`[skymem-mcp] tools: ${Object.keys(tools).join(', ')}`);
    if (DEFAULT_SCOPE) console.log(`[skymem-mcp] default scope: ${DEFAULT_SCOPE}`);
    console.log(`[skymem-mcp] discovery: GET http://localhost:${PORT}/mcp/tools`);
  });
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mcp-server.js')) {
  start();
}

export default { tools, start };
