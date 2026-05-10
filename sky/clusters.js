/**
 * Sky Memory Clusters — Phase 4 Intelligence Layer
 *
 * Detects communities of highly-connected nodes in the memory graph.
 * Cluster-level retrieval surfaces whole neighbourhoods of meaning,
 * not just isolated nodes — better for complex multi-part questions.
 *
 * Algorithm: Union-Find over edges above a strength threshold.
 * Clusters are computed on demand and cached briefly (5min TTL).
 *
 * Vision: MEMORY_ENGINE_VISION.md § Phase 4 — Intelligence Layer
 */

import prisma from './prisma-client.js';
import embeddings from './embeddings.js';
import graph from './graph.js';
import { isScopeEnabled, passesScopeFilter } from './scope-helpers.js';

const CLUSTER_EDGE_THRESHOLD = 0.45;   // minimum edge strength to count as a cluster bond
const MIN_CLUSTER_SIZE = 3;            // ignore tiny isolated pairs
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes

// ============================================================
// UNION-FIND — standard connected components with path compression
// ============================================================

class UnionFind {
  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }

  find(id) {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
    if (this.parent.get(id) !== id) {
      this.parent.set(id, this.find(this.parent.get(id))); // path compression
    }
    return this.parent.get(id);
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;

    const rankA = this.rank.get(ra) || 0;
    const rankB = this.rank.get(rb) || 0;

    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  getClusters() {
    const clusters = new Map();
    for (const [id] of this.parent) {
      const root = this.find(id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(id);
    }
    return clusters;
  }
}

// ============================================================
// CLUSTER DETECTION — main detection function
// ============================================================

let _clusterCache = null;
let _clusterCacheTime = 0;

/**
 * Detect clusters in the current graph state.
 * Returns an array of clusters, each with member nodes and stats.
 *
 * @param {boolean} forceRefresh - Bypass the cache
 */
async function detectClusters(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && _clusterCache && (now - _clusterCacheTime) < CACHE_TTL_MS) {
    return _clusterCache;
  }

  // Load all edges above threshold
  const strongEdges = await prisma.memoryEdge.findMany({
    where: { strength: { gte: CLUSTER_EDGE_THRESHOLD } },
    select: { sourceId: true, targetId: true, strength: true, type: true },
  });

  if (!strongEdges.length) return [];

  // Get validity status of all involved nodes
  const allNodeIds = [...new Set(strongEdges.flatMap(e => [e.sourceId, e.targetId]))];
  const nodeValidity = await prisma.memoryNode.findMany({
    where: { id: { in: allNodeIds } },
    select: { id: true, validUntil: true },
  });
  const supersededSet = new Set(nodeValidity.filter(n => n.validUntil !== null).map(n => n.id));

  // Exclude edges where BOTH endpoints are superseded
  const activeEdges = strongEdges.filter(e =>
    !(supersededSet.has(e.sourceId) && supersededSet.has(e.targetId))
  );

  if (!activeEdges.length) return [];

  // Build clusters via union-find
  const uf = new UnionFind();
  for (const edge of activeEdges) {
    uf.union(edge.sourceId, edge.targetId);
  }

  const rawClusters = uf.getClusters();

  // Filter to meaningful clusters + enrich with node data
  const meaningfulClusters = [];

  for (const [rootId, memberIds] of rawClusters) {
    if (memberIds.length < MIN_CLUSTER_SIZE) continue;

    // Fetch node details. Phase 1: include scope fields so the cluster
    // retrieval path can filter by scope without an extra round trip.
    const nodes = await prisma.memoryNode.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        type: true,
        content: true,
        weight: true,
        activationCount: true,
        lastActivated: true,
        tags: true,
        validUntil: true,
        chatJid: true,
        companyId: true,
        tier: true,
        audience: true,
      },
      orderBy: { weight: 'desc' },
    });

    if (!nodes.length) continue;

    // Compute cluster stats — valid nodes at full weight, superseded at half
    const avgWeight = nodes.reduce((sum, n) => {
      const mult = supersededSet.has(n.id) ? 0.5 : 1.0;
      return sum + (n.weight * mult);
    }, 0) / nodes.length;
    const topNode = nodes[0];
    const allTags = [...new Set(nodes.flatMap(n => (Array.isArray(n.tags) ? n.tags : [])))];
    const typeBreakdown = nodes.reduce((acc, n) => {
      acc[n.type] = (acc[n.type] || 0) + 1;
      return acc;
    }, {});

    // Cluster label: top node content (truncated) + dominant type
    const dominantType = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1])[0][0];
    const label = `[${dominantType.toUpperCase()}] ${topNode.content.slice(0, 60)}${topNode.content.length > 60 ? '…' : ''}`;

    meaningfulClusters.push({
      id: rootId,
      label,
      size: nodes.length,
      avgWeight,
      dominantType,
      tags: allTags.slice(0, 8),
      typeBreakdown,
      topNode,
      nodes,
    });
  }

  // Sort by combined signal: size + avg weight
  meaningfulClusters.sort((a, b) => (b.size * b.avgWeight) - (a.size * a.avgWeight));

  _clusterCache = meaningfulClusters;
  _clusterCacheTime = now;

  return meaningfulClusters;
}

// ============================================================
// CLUSTER RETRIEVAL — activate the best-matching cluster
// ============================================================

/**
 * Find the cluster most relevant to a query, and return its top N nodes.
 * Better than node-level retrieval for broad conceptual questions.
 *
 * @param {string} query - The current message / query
 * @param {number} topNodesPerCluster - How many nodes to return from the winning cluster
 * @param {object|null} scope - Phase 1 request scope. When provided AND the
 *                              flag is on, the returned topNodes are filtered
 *                              by scope so out-of-chat cluster nodes don't
 *                              leak through the cluster surface. Cluster-level
 *                              detection itself stays scope-agnostic — the
 *                              cluster IS the cross-context concept; only its
 *                              individual nodes get filtered.
 */
async function retrieveCluster(query, topNodesPerCluster = 4, scope = null) {
  const clusters = await detectClusters();
  if (!clusters.length) return null;

  // Embed the query
  let queryVec;
  try {
    queryVec = await embeddings.embed(query);
  } catch {
    return null;
  }

  // Score each cluster: embed its top node and compute similarity
  let bestCluster = null;
  let bestScore = -1;

  for (const cluster of clusters) {
    try {
      const clusterVec = await embeddings.embed(cluster.topNode.content);
      const similarity = embeddings.cosineSimilarity(queryVec, clusterVec);

      // Composite: similarity + cluster avg weight
      const score = (similarity * 0.6) + (cluster.avgWeight * 0.4);

      if (score > bestScore) {
        bestScore = score;
        bestCluster = { ...cluster, score };
      }
    } catch {
      // Skip clusters we can't embed
    }
  }

  if (!bestCluster || bestScore < 0.35) return null; // not relevant enough

  // Phase 1 scope filter — when the flag is on and a request scope is
  // provided, drop cluster nodes that fail the scope check before returning.
  // Cluster nodes already have chatJid/companyId/tier loaded if they came
  // through detectClusters (which selects from MemoryNode).
  let candidateNodes = bestCluster.nodes;
  if (scope && isScopeEnabled()) {
    const beforeCount = candidateNodes.length;
    candidateNodes = candidateNodes.filter(n => passesScopeFilter(n, scope));
    if (candidateNodes.length === 0) return null; // whole cluster out of scope
    if (candidateNodes.length < beforeCount) {
      console.log(`[Clusters] Scope filter dropped ${beforeCount - candidateNodes.length}/${beforeCount} from cluster "${bestCluster.label}"`);
    }
  }

  // Activate the top nodes in the cluster (reinforce the whole cluster)
  const topNodes = candidateNodes.slice(0, topNodesPerCluster);
  await Promise.all(topNodes.map(n => graph.activateNode(n.id).catch(() => {})));

  return {
    clusterId: bestCluster.id,
    label: bestCluster.label,
    score: bestScore,
    size: bestCluster.size,
    tags: bestCluster.tags,
    nodes: topNodes,
  };
}

/**
 * Build a cluster context block for injection into Sky's prompt.
 * More compact than dumping individual nodes — surfaces the cluster concept.
 */
function buildClusterContextBlock(clusterResult) {
  if (!clusterResult) return '';

  const nodeLines = clusterResult.nodes
    .map(n => {
      const tag = n.validUntil ? ' [SUPERSEDED]' : '';
      return `  - [${n.type.toUpperCase()}]${tag} ${n.content}`;
    })
    .join('\n');

  return `## Active Cluster: ${clusterResult.label} (${clusterResult.size} nodes, ${clusterResult.tags.slice(0, 4).join(', ')})\n${nodeLines}`;
}

// ============================================================
// CLUSTER STATS — for health dashboard
// ============================================================

async function getClusterStats() {
  const clusters = await detectClusters();

  if (!clusters.length) {
    return { count: 0, largest: null, avgSize: 0, topClusters: [] };
  }

  const totalNodes = clusters.reduce((s, c) => s + c.size, 0);

  return {
    count: clusters.length,
    largest: clusters[0],
    avgSize: Math.round(totalNodes / clusters.length),
    totalClustered: totalNodes,
    topClusters: clusters.slice(0, 5).map(c => ({
      label: c.label,
      size: c.size,
      avgWeight: c.avgWeight.toFixed(2),
      tags: c.tags.slice(0, 4),
    })),
  };
}

/**
 * Invalidate the cluster cache (call after ingestion or linker runs).
 */
function invalidateCache() {
  _clusterCache = null;
  _clusterCacheTime = 0;
}

export default {
  detectClusters,
  retrieveCluster,
  buildClusterContextBlock,
  getClusterStats,
  invalidateCache,
  CLUSTER_EDGE_THRESHOLD,
};
