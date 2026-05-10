/**
 * Nucleus Expansion — MemMachine pattern (2026-05-09).
 *
 * After top-K retrieval, for each retrieved conversation-derived node,
 * pull its ±N adjacent turns from the same session. The cluster of
 * nucleus + neighbours is what gets handed to the answer generator —
 * not the individual atomic node.
 *
 * Why: LOCOMO questions often rely on a turn's surrounding context —
 *   Q: "Did Melanie like the road trip?"
 *   The nucleus turn might be "Yeah, looking back, the trip was great"
 *   but the prior turn is "Mel, how was that road trip last weekend?"
 *   — without the prior turn, the response is ambiguous.
 *
 * MemMachine paper finding: this single change lifted LOCOMO accuracy
 * by +3-8pp across categories. It's why they hit 91.7%.
 *
 * Algorithm:
 *   1. For each input node where sourceType === 'conversation':
 *      - Look up the session window (chatJid + sourceId pattern)
 *      - Pull adjacent turns (±N by createdAt order within scope)
 *      - Tag those turns as 'expansion-of:<nucleusId>' so the renderer
 *        can group them
 *   2. Non-conversation nodes pass through unchanged.
 *   3. Optionally: dedupe expanded nodes that already appear in the
 *      input set (don't double-count).
 *   4. Optionally: cap total turns added per nucleus to N — prevents
 *      one verbose session blowing up the prompt.
 *
 * Cost: O(K) DB queries where K = retrieved nodes. Cheap (<100ms).
 *
 * Use:
 *   const nucleus = await graph.retrieve(query, 10, ctx, scope);
 *   const expanded = await nucleus.expand(nucleus, scope, { window: 2 });
 *   const reranked = await rerank(query, expanded, { topN: 12 });
 */

import prisma from './prisma-client.js';

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_WINDOW = 2;       // ±N adjacent turns per nucleus
const MAX_EXPANSIONS_PER = 4;   // cap total adjacent turns per nucleus (window=2 → ±2 = 4)
const MAX_TOTAL_EXPANSIONS = 30; // cap total expansions across all nuclei

// ============================================================
// CORE
// ============================================================

/**
 * Expand a list of retrieved nodes with their adjacent conversation
 * turns. Returns a NEW array containing both the original nodes and
 * any newly pulled neighbours.
 *
 * Each newly added node carries `_expansionOf: <nucleusId>` and
 * `_expansionOffset: <-2..+2>` for downstream rendering / dedup.
 *
 * @param {Array<MemoryNode>} nodes — top-K from graph retrieval
 * @param {object} scope — for chatJid filtering on the session window
 * @param {object} options
 *   window           — ±N adjacent turns (default 2)
 *   maxPerNucleus    — cap per nucleus (default 4)
 *   maxTotal         — cap across all nuclei (default 30)
 *   includeFiltered  — keep expansion turns filtered by scope.audience (default true)
 */
async function expand(nodes, scope = null, options = {}) {
  if (!nodes || nodes.length === 0) return nodes || [];
  const {
    window = DEFAULT_WINDOW,
    maxPerNucleus = MAX_EXPANSIONS_PER,
    maxTotal = MAX_TOTAL_EXPANSIONS,
  } = options;

  const seen = new Set(nodes.map(n => n.id));
  const out = [...nodes];
  let totalAdded = 0;

  for (const nucleus of nodes) {
    if (totalAdded >= maxTotal) break;
    if (nucleus.sourceType !== 'conversation' && nucleus.type !== 'conversation') {
      continue;
    }
    const adjacent = await fetchAdjacentTurns(nucleus, scope, window);
    let addedHere = 0;
    for (const turn of adjacent) {
      if (seen.has(turn.id)) continue;
      if (addedHere >= maxPerNucleus) break;
      if (totalAdded >= maxTotal) break;
      out.push({
        ...turn,
        _expansionOf: nucleus.id,
        _expansionOffset: turn._expansionOffset, // copied through from fetchAdjacentTurns
        // Mild score discount so the reranker treats them as supporting
        // context rather than competitors with the nucleus.
        score: ((nucleus.score || nucleus.weight || 0.3) * 0.7),
      });
      seen.add(turn.id);
      addedHere++;
      totalAdded++;
    }
  }

  return out;
}

/**
 * Pull turns adjacent to a nucleus turn in the same conversation. We
 * use createdAt ordering within the same chatJid as the proxy for
 * session sequence — LOCOMO ingest writes turns in order so this is
 * tight; production ingest may have out-of-order writes for which the
 * sourceId pattern (e.g. dia_id) is more reliable when available.
 *
 * Returns array shape:
 *   [{ ...node, _expansionOffset: -2 | -1 | +1 | +2 }]
 */
async function fetchAdjacentTurns(nucleus, scope, window) {
  if (!nucleus || !nucleus.id) return [];
  const chatJid = scope?.chatJid || nucleus.chatJid || null;
  if (!chatJid) {
    // No chatJid → can't reliably define a session window. Skip.
    return [];
  }

  const nucleusCreatedAt = nucleus.createdAt
    ? new Date(nucleus.createdAt)
    : null;
  if (!nucleusCreatedAt) return [];

  // Pull window-before + window-after as two separate ordered queries.
  // Two queries (vs one ORDER BY ABS(diff)) keeps the indexed
  // (chatJid, createdAt) plan and lets us tag offsets cleanly.

  // BEFORE — most-recent N before the nucleus
  const before = await prisma.memoryNode.findMany({
    where: {
      chatJid,
      createdAt: { lt: nucleusCreatedAt },
      OR: [
        { sourceType: 'conversation' },
        { type: 'conversation' },
      ],
      NOT: { id: nucleus.id },
    },
    orderBy: { createdAt: 'desc' },
    take: window,
    select: {
      id: true, type: true, content: true, weight: true, tags: true,
      sourceType: true, sourceId: true, chatJid: true, companyId: true,
      tier: true, audience: true, createdAt: true,
    },
  });
  // AFTER — first N after the nucleus
  const after = await prisma.memoryNode.findMany({
    where: {
      chatJid,
      createdAt: { gt: nucleusCreatedAt },
      OR: [
        { sourceType: 'conversation' },
        { type: 'conversation' },
      ],
      NOT: { id: nucleus.id },
    },
    orderBy: { createdAt: 'asc' },
    take: window,
    select: {
      id: true, type: true, content: true, weight: true, tags: true,
      sourceType: true, sourceId: true, chatJid: true, companyId: true,
      tier: true, audience: true, createdAt: true,
    },
  });

  // Tag offsets: before[0] = -1 (most recent prior), before[1] = -2, etc.
  // after[0]  = +1 (first after), after[1] = +2.
  const adjacent = [];
  before.forEach((n, i) => adjacent.push({ ...n, _expansionOffset: -(i + 1) }));
  after.forEach((n, i) => adjacent.push({ ...n, _expansionOffset: +(i + 1) }));
  return adjacent;
}

/**
 * Group expanded nodes by nucleus for prompt rendering. Returns a map
 * `nucleusId → [..nucleus + sorted neighbours by offset]`.
 *
 * Useful when you want to render expanded clusters as
 *   "[turn -1]
 *    [NUCLEUS — top-K hit]
 *    [turn +1]"
 * rather than flattening everything.
 */
function groupByNucleus(expanded) {
  const groups = new Map();
  // First pass: nuclei become group anchors
  for (const n of expanded) {
    if (!n._expansionOf) {
      groups.set(n.id, [{ ...n, _isNucleus: true, _expansionOffset: 0 }]);
    }
  }
  // Second pass: expansions hang off their nucleus
  for (const n of expanded) {
    if (n._expansionOf && groups.has(n._expansionOf)) {
      groups.get(n._expansionOf).push(n);
    }
  }
  // Sort each group by offset
  for (const [k, v] of groups) {
    v.sort((a, b) => (a._expansionOffset || 0) - (b._expansionOffset || 0));
  }
  return groups;
}

/**
 * Render expanded clusters as text. Uses the offset tags from groupByNucleus.
 */
function renderClusters(expanded) {
  const groups = groupByNucleus(expanded);
  const blocks = [];
  for (const [nucleusId, items] of groups) {
    const lines = [];
    for (const it of items) {
      const tag = it._isNucleus
        ? '[★]'
        : (it._expansionOffset > 0 ? `[+${it._expansionOffset}]` : `[${it._expansionOffset}]`);
      lines.push(`${tag} ${(it.content || '').slice(0, 240)}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n---\n');
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  expand,
  fetchAdjacentTurns,
  groupByNucleus,
  renderClusters,
  DEFAULT_WINDOW,
};
