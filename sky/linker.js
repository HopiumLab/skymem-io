/**
 * Sky Memory Linker — Background Intelligence Engine
 *
 * Continuously traverses the graph looking for relationships that don't yet exist.
 * This is the core intelligence loop — the thing that makes the system smarter over time.
 *
 * What it does:
 * - Selects node pairs (prioritises recently activated, under-connected nodes)
 * - Scores semantic similarity (embedding distance)
 * - Scores co-activation frequency (how often have they fired together?)
 * - Combined confidence score
 * - If score > threshold: create edge at score weight
 * - If existing edge: update weight (up or down)
 * - Logs reasoning for every connection it creates
 *
 * What it does NOT do:
 * - Create links based on keyword overlap alone
 * - Create links just because two nodes appeared in the same conversation
 * - Create links without clearing the threshold (overthinking guard rail)
 *
 * Vision: MEMORY_ENGINE_VISION.md § The Linker
 */

import prisma from './prisma-client.js';
import embeddings from './embeddings.js';
import graph from './graph.js';
import ingestion from './ingestion.js';

const LINKER_THRESHOLD = 0.4;   // minimum confidence to create an edge
const ANOMALY_THRESHOLD = 0.78; // unexpectedly strong cross-type connection = flag it
const BATCH_SIZE = 20;          // nodes to evaluate per run
const MAX_PAIRS_PER_RUN = 50;   // cap pairs per linker pass (cost control)

// In-memory anomaly log (last 50 anomalies)
const _anomalyLog = [];
const MAX_ANOMALY_LOG = 50;

// ============================================================
// LINKER CORE
// ============================================================

/**
 * Score the relationship between two nodes.
 *
 * Returns a confidence score 0–1 and a suggested edge type.
 * Only considers semantic similarity + shared tags (Phase 1).
 * Co-activation history added in Phase 2.
 */
async function scoreRelationship(nodeA, nodeB) {
  // 1. Semantic similarity via embeddings
  let semanticScore = 0;
  try {
    const [vecA, vecB] = await Promise.all([
      embeddings.embed(nodeA.content),
      embeddings.embed(nodeB.content),
    ]);
    semanticScore = embeddings.cosineSimilarity(vecA, vecB);
  } catch {
    semanticScore = 0;
  }

  // 2. Shared tag overlap
  const tagsA = Array.isArray(nodeA.tags) ? nodeA.tags : [];
  const tagsB = Array.isArray(nodeB.tags) ? nodeB.tags : [];
  const sharedTags = tagsA.filter(t => tagsB.includes(t));
  const tagScore = sharedTags.length > 0
    ? Math.min(sharedTags.length / Math.max(tagsA.length, tagsB.length, 1), 1)
    : 0;

  // 3. Same type bonus (two decisions, two projects — more likely to relate)
  const typeBonus = nodeA.type === nodeB.type ? 0.05 : 0;

  // 4. Co-activation score — how often did these nodes fire together in retrieval?
  //    Capped at 0.15 to prevent co-activation alone from forcing a link.
  //    10+ co-fires = full 0.15 bonus. Formula: min(count/10, 1) * 0.15
  const coFireCount = graph.getCoFireCount(nodeA.id, nodeB.id);
  const coActivationScore = Math.min(coFireCount / 10, 1) * 0.15;

  // Combined: semantic leads, tags reinforce, co-activation adds real-world signal
  const confidence = (semanticScore * 0.6) + (tagScore * 0.2) + coActivationScore + typeBonus;

  // Determine edge type from content patterns
  let edgeType = 'relates_to';
  const aLow = nodeA.content.toLowerCase();
  const bLow = nodeB.content.toLowerCase();

  if (aLow.includes('decided') || aLow.includes('decision') || bLow.includes('decided')) {
    edgeType = 'caused_by';
  } else if (aLow.includes('supports') || aLow.includes('validates')) {
    edgeType = 'supports';
  } else if (aLow.includes('contradict') || aLow.includes('against') || aLow.includes('but')) {
    edgeType = 'contradicts';
  } else if (tagsA.some(t => tagsB.includes(t))) {
    edgeType = 'relates_to';
  }

  return {
    confidence,
    edgeType,
    reasoning: `semantic=${semanticScore.toFixed(2)}, tags=${tagScore.toFixed(2)}, coFire=${coFireCount}, sharedTags=[${sharedTags.join(',')}]`,
  };
}

/**
 * Select candidate nodes for a linker pass.
 * Priority: recently activated + under-connected nodes.
 */
async function selectCandidates() {
  const recentlyActivated = await prisma.memoryNode.findMany({
    where: {
      lastActivated: { not: null },
    },
    orderBy: { lastActivated: 'desc' },
    take: Math.floor(BATCH_SIZE * 0.6),
    select: { id: true, type: true, content: true, tags: true, activationCount: true, lastActivated: true, validUntil: true, createdAt: true },
  });

  // Under-connected nodes (less than 3 edges)
  const allNodes = await prisma.memoryNode.findMany({
    include: { _count: { select: { outEdges: true, inEdges: true } } },
    take: 200,
    orderBy: { createdAt: 'desc' },
  });

  const underConnected = allNodes
    .filter(n => (n._count.outEdges + n._count.inEdges) < 3)
    .slice(0, Math.floor(BATCH_SIZE * 0.4))
    .map(({ id, type, content, tags, activationCount, lastActivated, validUntil, createdAt }) =>
      ({ id, type, content, tags, activationCount, lastActivated, validUntil, createdAt })
    );

  // Merge, deduplicate
  const seen = new Set();
  const candidates = [];
  for (const n of [...recentlyActivated, ...underConnected]) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      candidates.push(n);
    }
  }

  return candidates.slice(0, BATCH_SIZE);
}

/**
 * Run one pass of the linker.
 * Evaluates pairs from the candidate set and creates edges above threshold.
 */
async function runLinkerPass() {
  const candidates = await selectCandidates();

  if (candidates.length < 2) {
    console.log('[Linker] Not enough nodes to link yet');
    return { evaluated: 0, created: 0, updated: 0 };
  }

  let evaluated = 0;
  let created = 0;
  let updated = 0;

  // Generate pairs (avoid evaluating the same pair twice)
  const pairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      pairs.push([candidates[i], candidates[j]]);
      if (pairs.length >= MAX_PAIRS_PER_RUN) break;
    }
    if (pairs.length >= MAX_PAIRS_PER_RUN) break;
  }

  for (const [nodeA, nodeB] of pairs) {
    evaluated++;

    // Skip if they're the same node
    if (nodeA.id === nodeB.id) continue;

    // Check if edge already exists at good strength
    const existingEdge = await prisma.memoryEdge.findUnique({
      where: { sourceId_targetId: { sourceId: nodeA.id, targetId: nodeB.id } },
    });

    if (existingEdge && existingEdge.strength > 0.7) continue; // already strong

    const { confidence, edgeType, reasoning } = await scoreRelationship(nodeA, nodeB);

    if (confidence >= LINKER_THRESHOLD) {
      // Don't create supports edges to/from superseded nodes
      // Exception: supersedes and contradicts edges are still valid
      if (edgeType !== 'supersedes' && edgeType !== 'contradicts') {
        if (nodeA.validUntil || nodeB.validUntil) {
          continue; // Skip — one or both nodes are superseded
        }
      }

      // For high-confidence pairs that would be "supports", check for hidden contradictions
      if (edgeType === 'supports' && confidence > 0.7) {
        try {
          const contradictionCheck = await ingestion.classifyContradiction(nodeA, nodeB);
          if (contradictionCheck.relationship === 'contradicts') {
            // The newer node supersedes the older one
            const older = nodeA.createdAt < nodeB.createdAt ? nodeA : nodeB;
            const newer = older === nodeA ? nodeB : nodeA;
            await graph.supersede(older.id, newer.id, contradictionCheck.reason);
            continue; // Don't create supports edge
          }
        } catch (err) {
          // LLM call failed — proceed with the supports edge
          console.warn('[Linker] Contradiction check failed:', err.message);
        }
      }

      const note = `Linker: ${reasoning}`;

      // Anomaly detection: strong cross-type connection — flag for review
      if (confidence >= ANOMALY_THRESHOLD && nodeA.type !== nodeB.type) {
        _flagAnomaly({
          nodeAId: nodeA.id,
          nodeAContent: nodeA.content.slice(0, 80),
          nodeAType: nodeA.type,
          nodeBId: nodeB.id,
          nodeBContent: nodeB.content.slice(0, 80),
          nodeBType: nodeB.type,
          confidence,
          edgeType,
          reasoning,
        });
      }

      if (existingEdge) {
        await graph.upsertEdge({
          sourceId: nodeA.id,
          targetId: nodeB.id,
          type: edgeType,
          strength: confidence,
          linkerNote: note,
        });
        updated++;
      } else {
        await graph.upsertEdge({
          sourceId: nodeA.id,
          targetId: nodeB.id,
          type: edgeType,
          strength: confidence,
          linkerNote: note,
        });
        created++;
      }

      // Trigger enrichment for person/project nodes with strong new connections
      if (confidence >= 0.7 && (nodeA.type === 'person' || nodeA.type === 'project' || nodeB.type === 'person' || nodeB.type === 'project')) {
        try {
          const enricher = await import('./enricher.js');
          enricher.default.queue(nodeA.id, ['calendar', 'email']);
        } catch (e) { /* enricher not loaded yet */ }
      }
    }
  }

  console.log(`[Linker] Pass complete: ${evaluated} pairs evaluated, ${created} edges created, ${updated} updated`);
  return { evaluated, created, updated };
}

// ============================================================
// ANOMALY DETECTION — Unexpected strong connections
// ============================================================

/**
 * Flag an unexpected strong cross-type connection.
 * Stored in memory (not DB) — these are signals to review, not hard facts.
 * The anomalies surface in the memory health dashboard.
 */
function _flagAnomaly({ nodeAId, nodeAContent, nodeAType, nodeBId, nodeBContent, nodeBType, confidence, edgeType, reasoning }) {
  const anomaly = {
    id: `${nodeAId}_${nodeBId}`,
    detectedAt: new Date().toISOString(),
    nodeA: { id: nodeAId, content: nodeAContent, type: nodeAType },
    nodeB: { id: nodeBId, content: nodeBContent, type: nodeBType },
    confidence,
    edgeType,
    reasoning,
    note: `Unexpected strong link (${nodeAType} → ${nodeBType}, confidence ${confidence.toFixed(2)})`,
  };

  // Deduplicate by pair ID
  const existingIdx = _anomalyLog.findIndex(a => a.id === anomaly.id);
  if (existingIdx >= 0) {
    _anomalyLog[existingIdx] = anomaly; // update existing
  } else {
    _anomalyLog.unshift(anomaly);
    if (_anomalyLog.length > MAX_ANOMALY_LOG) _anomalyLog.pop();
  }

  console.log(`[Linker] Anomaly flagged: ${nodeAType}("${nodeAContent.slice(0, 30)}") → ${nodeBType}("${nodeBContent.slice(0, 30)}") confidence=${confidence.toFixed(2)}`);
}

/**
 * Get the current anomaly log.
 * @param {number} limit - Max anomalies to return
 */
function getAnomalies(limit = 20) {
  return _anomalyLog.slice(0, limit);
}

// ============================================================
// SCHEDULED RUNNER
// ============================================================

let _linkerInterval = null;

/**
 * Start the background linker.
 * Runs every interval (default: 30 minutes).
 * Also runs weight propagation and decay weekly.
 */
function startLinker(intervalMs = 30 * 60 * 1000) {
  if (_linkerInterval) return;

  let runCount = 0;

  const run = async () => {
    try {
      await runLinkerPass();
      runCount++;

      // Weekly maintenance: propagate weights + decay
      if (runCount % (7 * 24 * 2) === 0) { // ~weekly at 30min intervals
        console.log('[Linker] Running weekly graph maintenance...');
        await graph.propagateWeights();
        await graph.decayNodes();
      }
    } catch (err) {
      console.warn(`[Linker] Run failed: ${err.message}`);
    }
  };

  // First pass after 60s (let DB settle)
  setTimeout(run, 60 * 1000);

  _linkerInterval = setInterval(run, intervalMs);
  console.log(`[Linker] Background linker started (interval: ${intervalMs / 60000}min)`);
}

function stopLinker() {
  if (_linkerInterval) {
    clearInterval(_linkerInterval);
    _linkerInterval = null;
    console.log('[Linker] Stopped');
  }
}

export default {
  runLinkerPass,
  startLinker,
  stopLinker,
  scoreRelationship,
  getAnomalies,
};
