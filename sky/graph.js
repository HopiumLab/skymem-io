/**
 * Sky Memory Graph
 *
 * Core graph operations for the living activation network.
 * Nodes = atomic semantic units. Edges = weighted relationships.
 *
 * This is what replaces the flat file dump. Instead of loading all of LIFE-JOURNEY
 * into the prompt, we activate the right nodes and inject 3–5 precision units.
 *
 * Vision: MEMORY_ENGINE_VISION.md
 */

import prisma from './prisma-client.js';
import embeddings from './embeddings.js';
import chatTagging from './chat-tagging.js';
import temporalAxes from './temporal-axes.js';

const DECAY_FLOOR = 0.05;        // nodes never go below this
const LINKER_THRESHOLD = 0.4;    // minimum confidence to create an edge
const ACTIVATION_BOOST = 0.1;    // weight bump per activation
const WEIGHT_CAP = 1.0;
const SUPERSEDE_WEIGHT = 0.9;
const SUPERSEDED_NODE_WEIGHT = DECAY_FLOOR + 0.05;

// ============================================================
// CO-ACTIVATION TRACKING — Session-level co-fire scoring
// ============================================================
// Tracks which node pairs fire together within the same retrieve() call.
// Used by the linker to boost confidence for pairs that consistently co-activate.
// In-memory only — resets on restart, but rebuilds quickly.

const _coFireLog = new Map(); // key: "nodeA_nodeB" (sorted) → count

function _coFireKey(idA, idB) {
  return idA < idB ? `${idA}_${idB}` : `${idB}_${idA}`;
}

function recordCoActivation(nodeIds) {
  if (!nodeIds || nodeIds.length < 2) return;
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const key = _coFireKey(nodeIds[i], nodeIds[j]);
      _coFireLog.set(key, (_coFireLog.get(key) || 0) + 1);
    }
  }
}

function getCoFireCount(idA, idB) {
  return _coFireLog.get(_coFireKey(idA, idB)) || 0;
}

// ============================================================
// NODE OPERATIONS
// ============================================================

/**
 * Create a new atomic memory node.
 *
 * Phase 1: accepts an optional `scope` object with the chatJid/companyId/
 * tier/audience/subjects tuple. Persists it onto the node row and mirrors
 * chatJid/companyId/tier onto the Embedding row for pre-cosine filtering.
 * When scope is null/undefined, the columns are left null — the backfill
 * script (or a future re-run) will fill them in.
 */
async function createNode({ type, content, tags = [], sourceType = null, sourceId = null, initialWeight = 0.3, scope = null }) {
  const data = {
    type,
    content,
    weight: initialWeight,
    tags,
    sourceType,
    sourceId,
  };
  if (scope) {
    data.chatJid = scope.chatJid ?? null;
    data.companyId = scope.companyId ?? null;
    data.tier = scope.tier ?? null;
    data.audience = scope.audience ?? null;
    data.subjects = scope.subjects ?? [];
    if (scope.userId) data.userId = scope.userId;
  }

  // Phase 5 (chat-tagging, 2026-05-09): if the chat has tags pointing at
  // network personas, attribute this node to them. attributedPersonas is
  // a Json? field shaped `[{personaId, weight}]`. Cached lookup (60s TTL).
  // Failure here MUST NOT block node creation — best-effort enrichment.
  try {
    if (data.chatJid) {
      const attribution = await chatTagging.attributePersonasForNode({ chatJid: data.chatJid });
      if (attribution && attribution.length > 0) {
        data.attributedPersonas = attribution;
      }
    }
  } catch (e) {
    // Cached lookup failure shouldn't break ingest. Surface for monitoring.
    console.warn(`[Graph] chat-tag attribution skipped: ${e.message}`);
  }

  const node = await prisma.memoryNode.create({ data });

  // Embed for semantic retrieval (fire and forget). Pass scope so the
  // Embedding row gets the same chatJid/companyId/tier and the cache
  // can pre-filter before cosine.
  embeddings.embedAndStore('memory_node', node.id, content, scope)
    .catch(e => console.warn(`[Graph] Failed to embed node: ${e.message}`));

  // Tier 4 multi-axis temporal extraction (2026-05-10): fire-and-forget
  // Haiku extraction of (eventTime, mentionedAt, sequenceBefore/after,
  // timeConfidence). Costs ~$0.0004/node. Skipped for ephemera (very short
  // content) since the LLM has nothing to extract from.
  // Disable via SKY_TEMPORAL_AXES=off if API budget is tight.
  if (process.env.SKY_TEMPORAL_AXES !== 'off' && content && content.length >= 30) {
    temporalAxes.extractTemporalAxes(node)
      .then(axes => temporalAxes.applyTemporalAxes(node.id, axes))
      .catch(e => {
        // Best-effort enrichment — never block ingest. Surface for monitoring.
        if (process.env.SKY_TEMPORAL_AXES_VERBOSE) {
          console.warn(`[Graph] temporal-axes extract failed for ${node.id}: ${e.message}`);
        }
      });
  }

  return node;
}

/**
 * Activate a node — bump its weight and update recency.
 * Called when a node is retrieved and used in context.
 */
async function activateNode(id) {
  const node = await prisma.memoryNode.findUnique({ where: { id } });
  if (!node) return null;

  const newWeight = Math.min(node.weight + ACTIVATION_BOOST, WEIGHT_CAP);

  return prisma.memoryNode.update({
    where: { id },
    data: {
      weight: newWeight,
      activationCount: { increment: 1 },
      lastActivated: new Date(),
    },
  });
}

/**
 * Get a node by ID, with its edges.
 */
async function getNode(id) {
  return prisma.memoryNode.findUnique({
    where: { id },
    include: {
      outEdges: { include: { target: true }, orderBy: { strength: 'desc' }, take: 10 },
      inEdges: { include: { source: true }, orderBy: { strength: 'desc' }, take: 10 },
    },
  });
}

// ============================================================
// EDGE OPERATIONS
// ============================================================

/**
 * Create or strengthen an edge between two nodes.
 * If the edge already exists, update its strength (average with new score).
 */
async function upsertEdge({ sourceId, targetId, type, strength, linkerNote = null }) {
  const existing = await prisma.memoryEdge.findUnique({
    where: { sourceId_targetId: { sourceId, targetId } },
  });

  if (existing) {
    // Update: average the strengths — prevents runaway amplification
    const newStrength = Math.min((existing.strength + strength) / 2 + 0.05, WEIGHT_CAP);
    return prisma.memoryEdge.update({
      where: { id: existing.id },
      data: { strength: newStrength, type, linkerNote: linkerNote || existing.linkerNote },
    });
  }

  return prisma.memoryEdge.create({
    data: { sourceId, targetId, type, strength, linkerNote },
  });
}

/**
 * Weaken or remove an edge (when contradicting info arrives).
 */
async function weakenEdge(sourceId, targetId, amount = 0.1) {
  const existing = await prisma.memoryEdge.findUnique({
    where: { sourceId_targetId: { sourceId, targetId } },
  });
  if (!existing) return null;

  const newStrength = existing.strength - amount;
  if (newStrength <= 0) {
    return prisma.memoryEdge.delete({ where: { id: existing.id } });
  }
  return prisma.memoryEdge.update({
    where: { id: existing.id },
    data: { strength: newStrength },
  });
}

// ============================================================
// TEMPORAL REASONING — Defeasible knowledge
// ============================================================

/**
 * Supersede an old node with a new one.
 * The old node stays in the graph but is marked as superseded —
 * it fades from retrieval while preserving the full revision chain.
 */
async function supersede(oldNodeId, newNodeId, reason) {
  const [oldNode, newNode] = await Promise.all([
    prisma.memoryNode.findUnique({ where: { id: oldNodeId } }),
    prisma.memoryNode.findUnique({ where: { id: newNodeId } }),
  ]);

  if (!oldNode || !newNode) {
    console.warn(`[SUPERSEDE] Missing node: old=${oldNodeId} new=${newNodeId}`);
    return null;
  }

  // Mark old node as superseded
  await prisma.memoryNode.update({
    where: { id: oldNodeId },
    data: {
      validUntil: new Date(),
      supersededById: newNodeId,
      weight: SUPERSEDED_NODE_WEIGHT,
    },
  });

  // Create supersedes edge: old → new
  await upsertEdge({
    sourceId: oldNodeId,
    targetId: newNodeId,
    type: 'supersedes',
    strength: SUPERSEDE_WEIGHT,
    linkerNote: reason,
  });

  console.log(`[SUPERSEDE] ${oldNode.content.slice(0, 60)} → ${newNode.content.slice(0, 60)}: ${reason}`);
  return { oldNodeId, newNodeId, reason };
}

/**
 * Walk the full temporal chain for a node.
 * Returns [oldest → current] with timestamps.
 */
async function getTemporalChain(nodeId) {
  const chain = [];
  const visited = new Set();

  // Walk backward through supersededBy references to find the oldest ancestor
  let currentId = nodeId;
  const backwardIds = [];

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = await prisma.memoryNode.findUnique({ where: { id: currentId } });
    if (!node) break;

    // Find who this node superseded (look for inbound supersedes edges)
    const inbound = await prisma.memoryEdge.findFirst({
      where: { targetId: currentId, type: 'supersedes' },
      include: { source: true },
    });

    if (inbound) {
      backwardIds.unshift(currentId);
      currentId = inbound.sourceId;
    } else {
      backwardIds.unshift(currentId);
      break;
    }
  }

  // Build chain from oldest ancestor forward
  visited.clear();
  currentId = backwardIds[0];

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = await prisma.memoryNode.findUnique({ where: { id: currentId } });
    if (!node) break;

    chain.push({
      id: node.id,
      content: node.content,
      validFrom: node.createdAt,
      validUntil: node.validUntil || null,
      createdAt: node.createdAt,
    });

    // Walk forward through supersedes edges
    const outbound = await prisma.memoryEdge.findFirst({
      where: { sourceId: currentId, type: 'supersedes' },
    });

    currentId = outbound ? outbound.targetId : null;
  }

  return chain;
}

/**
 * Check if a node is currently valid (not superseded or superseded in the future).
 */
async function isCurrentlyValid(nodeId) {
  const node = await prisma.memoryNode.findUnique({ where: { id: nodeId } });
  if (!node) return false;
  return node.validUntil === null || node.validUntil > new Date();
}

/**
 * Sync version — takes a node object directly.
 */
function isCurrentlyValidSync(node) {
  if (!node) return false;
  return node.validUntil === null || node.validUntil > new Date();
}

// ============================================================
// RETRIEVAL — Precision, not dump
// ============================================================

/**
 * Retrieve the top N nodes most relevant to the current query.
 *
 * Process:
 *  1. Embed the query
 *  2. Find semantically similar nodes (via embedding search)
 *  3. Rank by: semantic similarity + node weight + edge proximity
 *  4. Activate the selected nodes (reinforce them)
 *  5. Return nodes + 1-sentence relationship summaries
 *
 * This replaces the LIFE-JOURNEY file dump. ~200–400 tokens vs ~2000+.
 */
async function retrieve(query, topN = 5, queryContext = {}, scope = null) {
  try {
    // Step 1: Semantic search — split query into chunks if it has multiple parts
    // "learner numbers AND pilot scope" should search for both, not just the combined embedding
    // Scope (Phase 1, Stage D) is forwarded to searchSimilar; the embedding cache
    // pre-filters by scope before computing cosine when the flag is on.
    const queryParts = query.split(/\band\b|\?|,/i).map(p => p.trim()).filter(p => p.length > 10);
    let similar;

    if (queryParts.length > 1) {
      // Multi-part query: search each part separately and merge results
      const allResults = [];
      const seenIds = new Set();
      for (const part of queryParts.slice(0, 3)) { // max 3 sub-queries
        const partResults = await embeddings.searchSimilar(part, topN * 2, 'memory_node', scope);
        for (const r of partResults) {
          if (!seenIds.has(r.sourceId)) {
            seenIds.add(r.sourceId);
            allResults.push(r);
          }
        }
      }
      similar = allResults.sort((a, b) => b.similarity - a.similarity).slice(0, topN * 3);
    } else {
      similar = await embeddings.searchSimilar(query, topN * 3, 'memory_node', scope);
    }
    if (!similar.length) return [];

    // Step 2: Fetch full node data + compute composite score
    const candidates = await Promise.all(
      similar.map(async (hit) => {
        const node = await prisma.memoryNode.findUnique({
          where: { id: hit.sourceId },
          include: {
            outEdges: { orderBy: { strength: 'desc' }, take: 5 },
            inEdges: { orderBy: { strength: 'desc' }, take: 5 },
          },
        });
        // Ensure validUntil is available (included by default in findUnique)
        if (!node) return null;

        // Composite score: semantic relevance dominates, weight is a mild boost
        // Source priority: actual source data (group-chat, life-architecture, dna, document)
        // beats conversation echoes (where the user talks ABOUT something)
        const sourceBoost = ['group-chat', 'life-architecture', 'dna', 'document', 'life-journey', 'enrichment']
          .includes(node.sourceType) ? 0.05 : 0;
        // Conversation echo penalty: penalise nodes that are just echoes of what the user said
        // These should never outrank actual source data (group-chat, life-architecture, documents, enrichment)
        let echoPenalty = 0;
        if (node.sourceType === 'conversation-raw') echoPenalty = -0.15;
        else if (node.content && (node.content.startsWith('User:') || node.content.startsWith('User '))) echoPenalty = -0.12;
        else if (node.sourceType === 'conversation' && node.content && /^(User |the user |Sky )/.test(node.content)) echoPenalty = -0.10;

        // P0-6 (2026-05-08): RECENCY BOOST. Global mix only.
        //
        // P1-4 attempt (per-intent adaptive weights) regressed the eval —
        // any non-trivial weight swing per intent moved the hard-fought
        // 87% pass rate downward. Conclusion: this mix is already close to
        // the per-query optimum across our 30-case set. Per-intent tuning
        // belongs in P2-1 (agentic retrieval planner) which can dispatch
        // multiple sub-queries with different ranking strategies and rerank
        // the union — not as a single-knob global per-intent adjustment.
        //
        // The intent classifier (P1-3) stays wired into queryContext for:
        //   - request log telemetry (which intents get classified how)
        //   - feeding P2-1's planner
        //   - feeding P1-2's reranker (some rerankers take intent hints)
        //
        // recencyBoost = max(0, 1 - daysOld/14)
        let recencyBoost = 0;
        if (node.createdAt) {
          const daysOld = (Date.now() - new Date(node.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          recencyBoost = Math.max(0, 1 - daysOld / 14);
        }

        const score = (hit.similarity * 0.65)
                    + (node.weight * 0.10)
                    + (recencyBoost * 0.15)
                    + sourceBoost
                    + echoPenalty
                    + 0.05;
        return { node, score, similarity: hit.similarity };
      })
    );

    let valid = candidates
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    // Filter out superseded nodes unless query is explicitly historical
    if (!queryContext.historical) {
      valid = valid.filter(({ node }) => !node.validUntil || node.validUntil > new Date());
    }

    // DIVERSITY FILTER — aggressive dedup
    // Skip nodes that are semantically too similar to ones we've already picked
    const diverse = [];
    for (const candidate of valid) {
      const content = candidate.node.content.toLowerCase();
      // Check against all already-selected nodes
      let isDuplicate = false;
      for (const selected of diverse) {
        const selContent = selected.node.content.toLowerCase();
        // Check first 35 chars (catches "UNITAR serves tens of" duplicates)
        const keyA = content.substring(0, 35).replace(/[^a-z0-9]/g, '');
        const keyB = selContent.substring(0, 35).replace(/[^a-z0-9]/g, '');
        if (keyA === keyB) { isDuplicate = true; break; }
        // Also check if one content fully contains the other (within first 80 chars)
        const shortA = content.substring(0, 80);
        const shortB = selContent.substring(0, 80);
        if (shortA.includes(shortB.substring(0, 40)) || shortB.includes(shortA.substring(0, 40))) {
          isDuplicate = true; break;
        }
      }
      if (!isDuplicate) {
        diverse.push(candidate);
        if (diverse.length >= topN) break;
      }
    }
    valid = diverse;

    // Step 3: Activate the returned nodes (reinforce) + record co-activation
    await Promise.all(valid.map(({ node }) => activateNode(node.id)));
    recordCoActivation(valid.map(({ node }) => node.id));

    return valid.map(({ node, score }) => ({
      id: node.id,
      type: node.type,
      content: node.content,
      weight: node.weight,
      score,
      tags: node.tags,
      sourceType: node.sourceType,
      sourceId: node.sourceId, // exposed for the cross-chat leak detector
      validUntil: node.validUntil,
      connections: node.outEdges.length + node.inEdges.length,
    }));
  } catch (err) {
    console.warn(`[Graph] Retrieval failed: ${err.message}`);
    return [];
  }
}

/**
 * Edge-walk retrieval — given a set of "anchor" node IDs, walk N hops along
 * strongest outgoing edges and return discovered nodes.
 *
 * P1-1 (2026-05-08): introduced 1-hop edgeWalk to make the 62k previously-
 * decorative edges load-bearing. From an anchor (e.g. "Person A" person-node),
 * follow her strongest connections to surface what's currently happening
 * WITH her — meetings, decisions, action items. Cosine on the bare query
 * often misses these because the connected content doesn't textually
 * overlap with the question.
 *
 * P2-2 (2026-05-08): extended to multi-hop. With hops=2 the walk goes
 * Person A → Lisa (1st hop, 'mentions' edge) → Budapest CEC conference
 * (2nd hop, Lisa→event edge). Multi-hop is critical for cat=3 multi-hop
 * questions on LoCoMo ("how does X connect to Y") and questions like
 * "who's on my pipeline" where the answer is connected via projects /
 * companies / proposals (not directly to "pipeline" as a term).
 *
 * Cost: each hop is one DB query. perAnchor × hops total nodes touched.
 * Latency: ~30-80ms per hop on a warm cache. Worth it for the topology
 * coverage.
 *
 * @param {string[]} anchorIds — node ids to walk from
 * @param {object} scope — request scope; targets must pass scope filter
 * @param {object} options
 *   perAnchor:    edges per source per hop (default 3)
 *   limit:        max nodes returned (default 8)
 *   hops:         number of hops (default 1; 2 enables multi-hop traversal)
 *   scoreFactor:  edge-strength weight in composite score (default 0.55)
 *   hopDecay:     score discount per additional hop (default 0.5 — 2nd
 *                 hop nodes get half the score of 1st hop)
 * @returns {Promise<Array<{id, type, content, weight, score, ..., depth}>>}
 */
async function edgeWalk(anchorIds, scope, options = {}) {
  const { perAnchor = 3, limit = 8, hops = 1, scoreFactor = 0.55, hopDecay = 0.5 } = options;
  if (!anchorIds || anchorIds.length === 0) return [];

  // Helper: target → scope-pass decision
  const passesScope = (t) => {
    if (!scope) return true;
    const tier = t.tier || null;
    if (tier === 'global' || tier === 'cross-entity') return true;
    if (tier === 'entity') return scope.companyId && t.companyId === scope.companyId;
    if (tier === 'chat' || tier === 'private') return t.chatJid && scope.chatJid && t.chatJid === scope.chatJid;
    if (t.chatJid && scope.chatJid && t.chatJid === scope.chatJid) return true;
    if (!t.chatJid && !scope.chatJid) return true;
    return false;
  };

  try {
    const seen = new Set(anchorIds); // don't re-discover anchors as targets
    const out = [];
    let frontier = [...anchorIds];

    for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
      const edges = await prisma.memoryEdge.findMany({
        where: { sourceId: { in: frontier } },
        include: {
          target: {
            select: {
              id: true, type: true, content: true, weight: true, sourceType: true,
              chatJid: true, companyId: true, tier: true, audience: true,
              createdAt: true, lastActivated: true, validUntil: true,
            },
          },
        },
        orderBy: { strength: 'desc' },
      });

      // Group by source + take top-perAnchor per source
      const byAnchor = new Map();
      for (const e of edges) {
        if (!byAnchor.has(e.sourceId)) byAnchor.set(e.sourceId, []);
        const list = byAnchor.get(e.sourceId);
        if (list.length < perAnchor) list.push(e);
      }

      const newFrontier = [];
      for (const [, list] of byAnchor) {
        for (const e of list) {
          const t = e.target;
          if (!t) continue;
          if (seen.has(t.id)) continue;
          seen.add(t.id);

          if (!passesScope(t)) continue;
          if (t.validUntil && t.validUntil < new Date()) continue;

          // Score: edge strength × scoreFactor × hopDecay^depth + recency + weight
          let recencyBoost = 0;
          if (t.createdAt) {
            const daysOld = (Date.now() - new Date(t.createdAt).getTime()) / (1000 * 60 * 60 * 24);
            recencyBoost = Math.max(0, 1 - daysOld / 14) * 0.10;
          }
          const depthDiscount = Math.pow(hopDecay, depth);
          const score = (e.strength * scoreFactor + t.weight * 0.08 + recencyBoost) * depthDiscount;

          out.push({
            id: t.id,
            type: t.type,
            content: t.content,
            weight: t.weight,
            score,
            sourceType: t.sourceType,
            chatJid: t.chatJid,
            companyId: t.companyId,
            tier: t.tier,
            audience: t.audience,
            viaAnchor: e.sourceId,
            edgeType: e.type,
            edgeStrength: e.strength,
            depth: depth + 1, // 1-indexed: 1st hop = depth 1
          });

          newFrontier.push(t.id);
        }
      }

      frontier = newFrontier;
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  } catch (err) {
    console.warn(`[Graph] edgeWalk failed: ${err.message}`);
    return [];
  }
}

/**
 * Build a compact context block from retrieved nodes.
 * This is what gets injected into Sky's system prompt.
 * Target: ~200–400 tokens.
 */
function buildContextBlock(nodes) {
  if (!nodes.length) return '';

  const lines = nodes.map(n => {
    let prefix;
    if (n.sourceType === 'enrichment') {
      prefix = '[ENRICHED]';
    } else if (n.validUntil) {
      const supersededDate = new Date(n.validUntil).toISOString().split('T')[0];
      prefix = `[SUPERSEDED ${supersededDate}]`;
    } else {
      prefix = `[${n.type.toUpperCase()}]`;
    }
    return `${prefix} ${n.content}${n.tags?.length ? ` (${n.tags.join(', ')})` : ''}`;
  });

  return lines.join('\n');
}

// ============================================================
// WEIGHT PROPAGATION — Neighbours reinforce each other
// ============================================================

/**
 * Propagate weights through the graph.
 * A node's weight = (own_activation_score * 0.5) + (mean_neighbour_weight * mean_edge_strength * 0.5)
 *
 * Run periodically — not on every query.
 */
async function propagateWeights() {
  const nodes = await prisma.memoryNode.findMany({
    include: {
      inEdges: { include: { source: true } },
    },
  });

  let updated = 0;

  for (const node of nodes) {
    if (!node.inEdges.length) continue;

    const neighbourContributions = node.inEdges.map(edge => ({
      neighbourWeight: edge.source.weight,
      edgeStrength: edge.strength,
    }));

    const meanNeighbourWeight = neighbourContributions.reduce((s, n) => s + n.neighbourWeight, 0) / neighbourContributions.length;
    const meanEdgeStrength = neighbourContributions.reduce((s, n) => s + n.edgeStrength, 0) / neighbourContributions.length;

    // Own activation score: recency + count (normalised to 0–1)
    const daysSinceActivation = node.lastActivated
      ? (Date.now() - new Date(node.lastActivated).getTime()) / (1000 * 60 * 60 * 24)
      : 365;
    const recencyScore = Math.max(0, 1 - daysSinceActivation / 90); // decays over 90 days
    const countScore = Math.min(node.activationCount / 100, 1);
    const ownScore = (recencyScore * 0.6) + (countScore * 0.4);

    const newWeight = Math.max(
      DECAY_FLOOR,
      Math.min(WEIGHT_CAP, (ownScore * 0.5) + (meanNeighbourWeight * meanEdgeStrength * 0.5))
    );

    if (Math.abs(newWeight - node.weight) > 0.01) {
      await prisma.memoryNode.update({ where: { id: node.id }, data: { weight: newWeight } });
      updated++;
    }
  }

  console.log(`[Graph] Weight propagation complete: ${updated}/${nodes.length} nodes updated`);
  return updated;
}

// ============================================================
// DECAY — Fading, not deletion
// ============================================================

/**
 * Apply decay to inactive nodes.
 * Nodes that haven't been activated in a long time slowly drift toward DECAY_FLOOR.
 * Nothing is deleted — just de-prioritised.
 */
async function decayNodes(daysInactive = 30) {
  const cutoff = new Date(Date.now() - daysInactive * 24 * 60 * 60 * 1000);

  // Find nodes that haven't been activated recently and have weight above floor
  const stale = await prisma.memoryNode.findMany({
    where: {
      OR: [
        { lastActivated: { lt: cutoff } },
        { lastActivated: null },
      ],
      weight: { gt: DECAY_FLOOR + 0.01 },
    },
  });

  let decayed = 0;
  for (const node of stale) {
    const newWeight = Math.max(DECAY_FLOOR, node.weight - 0.02);
    await prisma.memoryNode.update({ where: { id: node.id }, data: { weight: newWeight } });
    decayed++;
  }

  if (decayed > 0) console.log(`[Graph] Decay: ${decayed} nodes faded`);
  return decayed;
}

// ============================================================
// STATS
// ============================================================

async function getGraphStats() {
  const [nodeCount, edgeCount, avgWeight, topNodes] = await Promise.all([
    prisma.memoryNode.count(),
    prisma.memoryEdge.count(),
    prisma.memoryNode.aggregate({ _avg: { weight: true } }),
    prisma.memoryNode.findMany({
      orderBy: { weight: 'desc' },
      take: 5,
      select: { type: true, content: true, weight: true, activationCount: true },
    }),
  ]);

  return {
    nodes: nodeCount,
    edges: edgeCount,
    avgWeight: avgWeight._avg.weight || 0,
    topNodes,
  };
}

// ============================================================
// HEALTH REPORT — Full graph intelligence summary
// ============================================================

/**
 * Full memory health report.
 * Used by the dashboard and Sky's self-awareness layer.
 *
 * Returns:
 * - Graph overview (nodes, edges, avg weight)
 * - Weight distribution (how many nodes are thriving vs fading)
 * - Rising nodes (recently activated, weight growing)
 * - Fading nodes (inactive, weight declining toward floor)
 * - Type breakdown
 */
async function getHealthReport() {
  const [
    nodeCount,
    edgeCount,
    weightAgg,
    typeBreakdown,
    risingNodes,
    fadingNodes,
    orphanCount,
  ] = await Promise.all([
    prisma.memoryNode.count(),
    prisma.memoryEdge.count(),
    prisma.memoryNode.aggregate({ _avg: { weight: true }, _max: { weight: true }, _min: { weight: true } }),

    // Type distribution
    prisma.memoryNode.groupBy({ by: ['type'], _count: { id: true } }),

    // Rising: activated in last 7 days, weight above 0.5
    prisma.memoryNode.findMany({
      where: {
        lastActivated: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        weight: { gte: 0.5 },
      },
      orderBy: [{ weight: 'desc' }, { activationCount: 'desc' }],
      take: 5,
      select: { type: true, content: true, weight: true, activationCount: true, lastActivated: true },
    }),

    // Fading: not activated in 14+ days, weight between floor and 0.4
    prisma.memoryNode.findMany({
      where: {
        OR: [
          { lastActivated: { lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
          { lastActivated: null },
        ],
        weight: { lte: 0.4, gt: DECAY_FLOOR },
      },
      orderBy: { weight: 'asc' },
      take: 5,
      select: { type: true, content: true, weight: true, lastActivated: true },
    }),

    // Orphans: nodes with no edges at all
    prisma.memoryNode.count({
      where: {
        outEdges: { none: {} },
        inEdges: { none: {} },
      },
    }),
  ]);

  // Weight distribution buckets
  const [thriving, healthy, fading, floor] = await Promise.all([
    prisma.memoryNode.count({ where: { weight: { gte: 0.7 } } }),
    prisma.memoryNode.count({ where: { weight: { gte: 0.4, lt: 0.7 } } }),
    prisma.memoryNode.count({ where: { weight: { gte: DECAY_FLOOR + 0.01, lt: 0.4 } } }),
    prisma.memoryNode.count({ where: { weight: { lte: DECAY_FLOOR + 0.01 } } }),
  ]);

  // Temporal stats
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    supersededCount,
    recentlySuperseded,
    chainEnds,
    activeContradictions,
  ] = await Promise.all([
    prisma.memoryNode.count({ where: { validUntil: { not: null } } }),
    prisma.memoryNode.count({ where: { validUntil: { not: null, gte: thirtyDaysAgo } } }),
    prisma.memoryNode.count({ where: { supersededById: null, supersedes: { some: {} } } }),
    prisma.memoryEdge.count({
      where: {
        type: 'contradicts',
        source: { validUntil: null },
        target: { validUntil: null },
      },
    }),
  ]);

  // Enrichment stats
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [enrichmentNodes, pendingEnrichment, enrichmentLogs] = await Promise.all([
    prisma.memoryNode.count({ where: { sourceType: 'enrichment' } }),
    prisma.memoryNode.count({ where: { enrichedAt: null, createdAt: { gte: thirtyMinsAgo } } }),
    prisma.enrichmentLog.groupBy({
      by: ['adapter'],
      _count: true,
      _avg: { confidence: true },
    }),
  ]);

  return {
    overview: {
      nodes: nodeCount,
      edges: edgeCount,
      avgWeight: weightAgg._avg.weight ? Number(weightAgg._avg.weight.toFixed(3)) : 0,
      maxWeight: weightAgg._max.weight ? Number(weightAgg._max.weight.toFixed(3)) : 0,
      orphanNodes: orphanCount,
    },
    weightDistribution: { thriving, healthy, fading, floor },
    typeBreakdown: Object.fromEntries(typeBreakdown.map(t => [t.type, t._count.id])),
    risingNodes: risingNodes.map(n => ({
      type: n.type,
      content: n.content.slice(0, 80),
      weight: Number(n.weight.toFixed(3)),
      activations: n.activationCount,
    })),
    fadingNodes: fadingNodes.map(n => ({
      type: n.type,
      content: n.content.slice(0, 80),
      weight: Number(n.weight.toFixed(3)),
      lastSeen: n.lastActivated,
    })),
    temporal: {
      supersededCount,
      recentlySuperseded,
      chainEnds,
      activeContradictions,
    },
    enrichment: {
      totalNodes: enrichmentNodes,
      pendingEnrichment,
      byAdapter: enrichmentLogs.map(l => ({
        adapter: l.adapter,
        count: l._count,
        avgConfidence: l._avg.confidence,
      })),
    },
    generatedAt: new Date().toISOString(),
  };
}

export default {
  createNode,
  activateNode,
  getNode,
  upsertEdge,
  weakenEdge,
  retrieve,
  edgeWalk,
  buildContextBlock,
  propagateWeights,
  decayNodes,
  getGraphStats,
  getHealthReport,
  recordCoActivation,
  getCoFireCount,
  supersede,
  getTemporalChain,
  isCurrentlyValid,
  isCurrentlyValidSync,
  LINKER_THRESHOLD,
};
