/**
 * Memory Observability — Tier 5 (2026-05-10).
 *
 * "Why did the AI believe this?" infrastructure. When skyMem becomes
 * enterprise infra (healthcare / legal / finance / regulated AI),
 * auditability isn't a feature — it's the price of entry.
 *
 * Eight observability primitives:
 *
 *   1. explainRetrieval(query, retrievedNodes)
 *      For each retrieved node, why was it selected? Which signals
 *      contributed (semantic score / FTS hit / edge-walk / persona /
 *      typed-edge / nucleus expansion)? What was its rerank score?
 *
 *   2. factTrajectory(factId)
 *      Full revision history with slope/velocity already computed.
 *      Wraps trajectories.js into observability output.
 *
 *   3. findContradictions(scope, options)
 *      Returns pairs of facts that semantically disagree, scored by
 *      severity. Reads ContradictionPair (populated by nightly sweep).
 *
 *   4. provenanceTree(factId)
 *      Full source-node tree for a fact. Walks sourceNodes ids on the
 *      PersonaFact + recurses into the MemoryNodes' edges to show what
 *      raw evidence underwrote this belief.
 *
 *   5. supersededFacts(scope, options)
 *      List of facts marked validUntil with their replacements. Shows
 *      what the system used to believe vs what it believes now, with
 *      the transition date + the revision that flipped it.
 *
 *   6. decayReport(scope, options)
 *      Facts trending down in confidence — at-risk memories. Built on
 *      trajectories.getInterestingTrajectories({states: ['declining',
 *      'volatile']}) plus the validation-driven decay.
 *
 *   7. decisionLineage(decisionId)
 *      For an AI decision, the chain of facts + nodes + patterns +
 *      trajectory snapshots that produced it. Reads DecisionLineage table.
 *
 *   8. auditLog(filter)
 *      Time-windowed query over the audit log. Filter by actor / event
 *      type / scope. The compliance / SOC2 / ISO 27001 backbone.
 *
 * Plus a logging API:
 *   - logAuditEvent({ eventType, actor, query, factsUsed, ... })
 *   - logDecision({ decisionId, decisionType, factsUsed, ... })
 *
 * Cost: zero LLM. Pure DB queries + math. Observability calls add ~5-50ms
 * per chat turn.
 */

import prisma from './prisma-client.js';
import trajectories from './trajectories.js';

// ============================================================
// 1. AUDIT LOG WRITERS (called from chat path / cron / MCP)
// ============================================================

/**
 * Append an audit event. Fire-and-forget — never block the caller.
 */
async function logAuditEvent(event) {
  if (!event || !event.eventType) return null;
  try {
    return await prisma.auditLog.create({
      data: {
        eventType: event.eventType,
        actor: event.actor ?? null,
        query: event.query ?? null,
        factsUsed: event.factsUsed ?? null,
        factsWritten: event.factsWritten ?? null,
        nodesUsed: event.nodesUsed ?? null,
        scope: event.scope ?? null,
        outcome: event.outcome ?? null,
        metadata: event.metadata ?? null,
      },
    });
  } catch (e) {
    console.warn(`[Observability] audit log write failed: ${e.message}`);
    return null;
  }
}

/**
 * Log a decision with full lineage. Called when generateAnswer produces
 * output tied to a downstream effect.
 *
 * @param {object} args
 *   decisionId      — external id (Sky message id, proposal id, commit hash)
 *   decisionType    — 'chat-response' | 'proposal' | 'code-suggestion' | etc
 *   decisionContent — the actual output text
 *   factsUsed       — [factId, ...]
 *   nodesUsed       — [nodeId, ...]
 *   patternsUsed    — [patternId, ...]
 *   scope           — chatJid / projectId
 *   actor           — 'sky' | 'mcp:<client>'
 */
async function logDecision(args) {
  if (!args || !args.decisionId) return null;

  // Snapshot trajectories for every fact used at decision time
  let trajectoriesSnapshot = null;
  if (Array.isArray(args.factsUsed) && args.factsUsed.length > 0) {
    try {
      const snapshot = {};
      for (const factId of args.factsUsed.slice(0, 20)) {
        const traj = await trajectories.computeTrajectory(factId);
        if (traj) snapshot[factId] = { state: traj.state, summary: traj.summary, slope: traj.confidenceSlope };
      }
      trajectoriesSnapshot = snapshot;
    } catch (_) { /* best-effort */ }
  }

  try {
    return await prisma.decisionLineage.create({
      data: {
        decisionId: args.decisionId,
        decisionType: args.decisionType ?? 'chat-response',
        decisionContent: args.decisionContent ?? null,
        factsUsed: args.factsUsed ?? [],
        nodesUsed: args.nodesUsed ?? null,
        patternsUsed: args.patternsUsed ?? null,
        trajectoriesSnapshot,
        scope: args.scope ?? null,
        actor: args.actor ?? null,
      },
    });
  } catch (e) {
    console.warn(`[Observability] decision lineage write failed: ${e.message}`);
    return null;
  }
}

// ============================================================
// 2. EXPLAIN RETRIEVAL (the "why was this retrieved" primitive)
// ============================================================

/**
 * Annotate retrieved nodes with WHY each was selected. Reads the score
 * components attached to each node by sky/index.js#buildContext (semantic
 * score, edge-walk score boost, persona match, etc.) and produces a clean
 * explanation per node.
 *
 * Input shape: nodes returned by graph.retrieve / FTS / edge-walk with
 * various _score / _matchType / score fields.
 *
 * Output: array of { nodeId, content, signals, finalScore, reason }.
 */
function explainRetrieval(query, retrievedNodes) {
  if (!Array.isArray(retrievedNodes)) return [];
  return retrievedNodes.map(n => {
    const signals = [];
    // Composite score sources we look for:
    if (n.score != null) signals.push({ type: 'composite', value: n.score });
    if (n.weight != null) signals.push({ type: 'weight', value: n.weight });
    if (n.rerankScore != null) signals.push({ type: 'cohere-rerank', value: n.rerankScore });
    if (n._matchType) signals.push({ type: `persona-${n._matchType}`, value: n.confidence ?? null });
    if (n._expansionOf) signals.push({ type: 'nucleus-expansion', value: n._expansionOffset });
    // Best-fit reason
    let reason;
    if (n.rerankScore != null && n.rerankScore > 0.7) reason = 'high cross-attention rerank score';
    else if (n._matchType === 'slot') reason = 'direct persona-slot match (highest precision)';
    else if (n._matchType === 'domain') reason = 'persona-domain hint match';
    else if (n._expansionOf) reason = `nucleus expansion (±${n._expansionOffset} from anchor)`;
    else if ((n.score || 0) > 0.6) reason = 'strong composite score (semantic + FTS + edge-walk union)';
    else if ((n.weight || 0) >= 0.6) reason = 'high node weight (frequently activated)';
    else reason = 'reranker top-N inclusion';

    return {
      nodeId: n.id,
      content: (n.content || '').slice(0, 200),
      signals,
      finalScore: n.rerankScore ?? n.score ?? n.weight ?? 0,
      reason,
    };
  });
}

// ============================================================
// 3. FACT TRAJECTORY (wraps trajectories.js into obs output)
// ============================================================

async function factTrajectory(factId) {
  const traj = await trajectories.computeTrajectory(factId);
  if (!traj) return null;
  const fact = await prisma.personaFact.findUnique({
    where: { id: factId },
    select: { domain: true, slot: true, facts: true, confidence: true, chatJid: true, sourceNodes: true, validUntil: true },
  });
  return {
    factId,
    domain: fact?.domain,
    slot: fact?.slot,
    currentConfidence: fact?.confidence,
    text: fact?.facts?.text || (fact?.facts ? JSON.stringify(fact.facts).slice(0, 200) : null),
    superseded: !!fact?.validUntil,
    ...traj,
  };
}

// ============================================================
// 4. CONTRADICTIONS
// ============================================================

/**
 * List detected contradiction pairs. Optionally filter by scope and
 * resolution state.
 */
async function findContradictions(options = {}) {
  const {
    scope = null,
    resolution = 'unresolved',
    minSeverity = 0.5,
    limit = 50,
  } = options;
  const where = {
    severity: { gte: minSeverity },
  };
  if (resolution) where.resolution = resolution;

  const pairs = await prisma.contradictionPair.findMany({
    where,
    orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
    take: limit,
  });

  // Hydrate fact details for both sides
  const factIds = [...new Set(pairs.flatMap(p => [p.factAId, p.factBId]))];
  const facts = await prisma.personaFact.findMany({
    where: { id: { in: factIds } },
    select: { id: true, domain: true, slot: true, facts: true, chatJid: true, confidence: true },
  });
  const byId = new Map(facts.map(f => [f.id, f]));
  const filtered = scope ? pairs.filter(p => byId.get(p.factAId)?.chatJid === scope || byId.get(p.factBId)?.chatJid === scope) : pairs;

  return filtered.map(p => ({
    id: p.id,
    severity: p.severity,
    rationale: p.rationale,
    resolution: p.resolution,
    detectedAt: p.detectedAt,
    factA: byId.get(p.factAId) ?? { id: p.factAId },
    factB: byId.get(p.factBId) ?? { id: p.factBId },
  }));
}

// ============================================================
// 5. PROVENANCE TREE
// ============================================================

/**
 * For a fact, walk the source nodes that underwrite it. Returns a tree:
 *   - root: the fact itself
 *   - children: the MemoryNodes listed in fact.sourceNodes
 *   - grandchildren: MemoryEdges that connect those nodes to other context
 *
 * Lets a compliance reviewer see "this belief was grounded in these 7
 * raw conversation turns / decisions / events."
 */
async function provenanceTree(factId, options = {}) {
  const { maxDepth = 2, edgesPerNode = 4 } = options;
  const fact = await prisma.personaFact.findUnique({
    where: { id: factId },
    select: { id: true, domain: true, slot: true, facts: true, sourceNodes: true, confidence: true, chatJid: true, createdAt: true, updatedAt: true },
  });
  if (!fact) return null;

  const sourceNodeIds = Array.isArray(fact.sourceNodes) ? fact.sourceNodes : [];
  if (sourceNodeIds.length === 0) {
    return { fact, sources: [] };
  }

  const sourceNodes = await prisma.memoryNode.findMany({
    where: { id: { in: sourceNodeIds } },
    select: { id: true, type: true, content: true, weight: true, createdAt: true, eventTime: true, mentionedAt: true, chatJid: true },
  });

  // For each source node, pull a small ring of edges for context
  const sources = [];
  for (const n of sourceNodes) {
    let neighbours = [];
    if (maxDepth >= 2) {
      const edges = await prisma.memoryEdge.findMany({
        where: { OR: [{ sourceId: n.id }, { targetId: n.id }] },
        take: edgesPerNode,
        orderBy: { strength: 'desc' },
        select: { id: true, sourceId: true, targetId: true, type: true, linkerNote: true, strength: true },
      });
      neighbours = edges;
    }
    sources.push({
      node: {
        ...n,
        contentPreview: (n.content || '').slice(0, 200),
      },
      neighbours,
    });
  }

  return { fact, sources };
}

// ============================================================
// 6. SUPERSEDED FACTS
// ============================================================

/**
 * List facts that have been superseded (validUntil set). For each,
 * show what they used to say + what replaced them.
 */
async function supersededFacts(options = {}) {
  const { scope = null, limit = 50, sinceDays = 30 } = options;
  const since = new Date(Date.now() - sinceDays * 86400000);
  const where = {
    validUntil: { gte: since },
  };
  if (scope) where.chatJid = scope;

  const superseded = await prisma.personaFact.findMany({
    where,
    orderBy: { validUntil: 'desc' },
    take: limit,
    select: { id: true, domain: true, slot: true, facts: true, confidence: true, validUntil: true, chatJid: true },
  });

  // For each, find the replacement (same domain+slot, validUntil null)
  const result = [];
  for (const old of superseded) {
    const replacement = await prisma.personaFact.findFirst({
      where: {
        domain: old.domain,
        slot: old.slot,
        chatJid: old.chatJid,
        validUntil: null,
        id: { not: old.id },
      },
      select: { id: true, facts: true, confidence: true, updatedAt: true },
    });
    result.push({
      old: { ...old, text: old.facts?.text || JSON.stringify(old.facts) },
      replacement: replacement ? { ...replacement, text: replacement.facts?.text || JSON.stringify(replacement.facts) } : null,
      transitionAt: old.validUntil,
    });
  }

  return result;
}

// ============================================================
// 7. DECAY REPORT
// ============================================================

/**
 * Report on facts trending down in confidence — at-risk memories.
 * Combines trajectory state + low confidence + low recent activation.
 */
async function decayReport(options = {}) {
  const { scope = null, limit = 20, minSlopeMag = 0.005 } = options;

  // Get declining + volatile trajectories
  const trends = await trajectories.getInterestingTrajectories({
    states: ['declining', 'volatile'],
    minSlopeMag,
    limit: limit * 2,
    chatJid: scope,
  });

  // Hydrate fact details + filter by remaining confidence
  const result = [];
  for (const t of trends) {
    const fact = await prisma.personaFact.findUnique({
      where: { id: t.factId },
      select: { id: true, domain: true, slot: true, facts: true, confidence: true, chatJid: true, validUntil: true, updatedAt: true },
    });
    if (!fact) continue;
    if (fact.validUntil) continue; // skip already-superseded
    result.push({
      factId: t.factId,
      domain: fact.domain,
      slot: fact.slot,
      text: fact.facts?.text || JSON.stringify(fact.facts).slice(0, 120),
      currentConfidence: fact.confidence,
      state: t.state,
      slope: t.confidenceSlope,
      summary: t.summary,
      revisionCount: t.revisionCount,
      lastSeen: t.lastSeen,
    });
    if (result.length >= limit) break;
  }
  return result;
}

// ============================================================
// 8. DECISION LINEAGE LOOKUP
// ============================================================

/**
 * For a decision id, return the full lineage record + hydrated facts.
 */
async function decisionLineage(decisionId) {
  const lineage = await prisma.decisionLineage.findUnique({
    where: { decisionId },
  });
  if (!lineage) return null;

  const factIds = Array.isArray(lineage.factsUsed) ? lineage.factsUsed : [];
  const facts = factIds.length > 0
    ? await prisma.personaFact.findMany({
        where: { id: { in: factIds } },
        select: { id: true, domain: true, slot: true, facts: true, confidence: true },
      })
    : [];

  const nodeIds = Array.isArray(lineage.nodesUsed) ? lineage.nodesUsed : [];
  const nodes = nodeIds.length > 0
    ? await prisma.memoryNode.findMany({
        where: { id: { in: nodeIds } },
        select: { id: true, type: true, content: true, weight: true, createdAt: true },
      })
    : [];

  return {
    ...lineage,
    facts: facts.map(f => ({ ...f, text: f.facts?.text || JSON.stringify(f.facts).slice(0, 200) })),
    nodes: nodes.map(n => ({ ...n, contentPreview: (n.content || '').slice(0, 200) })),
  };
}

// ============================================================
// 9. AUDIT LOG QUERY
// ============================================================

/**
 * Time-windowed query over the audit log. The compliance backbone.
 *
 * @param {object} filter
 *   eventType — exact match or array
 *   actor     — exact match or array
 *   scope     — chatJid / projectId
 *   sinceDays — default 7
 *   untilDate — defaults to now
 *   limit     — default 100
 */
async function auditLog(filter = {}) {
  const {
    eventType = null,
    actor = null,
    scope = null,
    sinceDays = 7,
    untilDate = null,
    limit = 100,
  } = filter;

  const since = new Date(Date.now() - sinceDays * 86400000);
  const where = {
    createdAt: untilDate ? { gte: since, lte: untilDate } : { gte: since },
  };
  if (eventType) where.eventType = Array.isArray(eventType) ? { in: eventType } : eventType;
  if (actor) where.actor = Array.isArray(actor) ? { in: actor } : actor;
  if (scope) where.scope = scope;

  return prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ============================================================
// AGGREGATES (for dashboard widgets)
// ============================================================

/**
 * Snapshot of memory health metrics — for the observability dashboard
 * widget that shows "your memory at a glance."
 */
async function healthSnapshot(options = {}) {
  const { scope = null } = options;
  const where = scope ? { chatJid: scope } : {};

  const [
    totalFacts,
    activeFacts,
    supersededCount,
    revisionsCount,
    contradictionsOpen,
    decisionsLast24h,
  ] = await Promise.all([
    prisma.personaFact.count({ where }),
    prisma.personaFact.count({ where: { ...where, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } }),
    prisma.personaFact.count({ where: { ...where, validUntil: { not: null } } }),
    prisma.personaFactRevision.count(),
    prisma.contradictionPair.count({ where: { resolution: 'unresolved' } }),
    prisma.decisionLineage.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000) } } }),
  ]);

  return {
    totalFacts,
    activeFacts,
    supersededCount,
    revisionsCount,
    contradictionsOpen,
    decisionsLast24h,
    healthScore: activeFacts > 0
      ? Math.round((1 - (supersededCount + contradictionsOpen) / Math.max(activeFacts, 1)) * 100)
      : 100,
  };
}

export default {
  // Audit + lineage writers
  logAuditEvent,
  logDecision,

  // 8 observability primitives
  explainRetrieval,
  factTrajectory,
  findContradictions,
  provenanceTree,
  supersededFacts,
  decayReport,
  decisionLineage,
  auditLog,

  // Dashboard aggregate
  healthSnapshot,
};
