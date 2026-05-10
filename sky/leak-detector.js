/**
 * Cross-chat leak detector — Phase 0 best-effort.
 *
 * Pure helpers used by sky/index.js#_detectCrossChatLeaks. Kept separate so
 * the comparison logic can be unit-tested without spinning up Prisma.
 *
 * Phase 0 background: MemoryNode had no chatJid/tier. We approximate by
 * joining conversation-derived nodes back to Conversation.source.
 *
 * Phase 1: classifyLeaksStructural uses node-level chatJid/tier (no join
 * required) for nodes that have been backfilled. Legacy un-backfilled
 * rows fall through to the Phase 0 path.
 */

import { passesScopeFilter } from './scope-helpers.js';

/** Node source types that originate from a single chat and therefore should
 * not appear in a different chat's retrieved context. */
export const CONVERSATION_DERIVED_TYPES = new Set([
  'conversation',
  'conversation-raw',
  'message',
  'sentiment',
]);

/**
 * Filter `nodes` down to those that can actually be checked: have a
 * sourceId AND a sourceType that ties them back to a single conversation.
 */
export function filterCheckable(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(n => n && n.sourceId && CONVERSATION_DERIVED_TYPES.has(n.sourceType));
}

/**
 * Pure leak classification (Phase 0 — Conversation-join based).
 *
 * Inputs:
 *   nodes          — retrieved nodes (already filtered to checkable, ideally)
 *   sourceById     — Map<conversationId, conversation.source>
 *   requestSource  — current request's source string
 *
 * Returns: leak[] — one entry per node whose originating conversation
 * source differs from requestSource. Nodes where the conversation row was
 * not found are skipped (we'd be guessing).
 *
 * Phase 1 nodes prefer classifyLeaksStructural (chatJid is on the node
 * itself, no join required). Kept for backwards compat with un-backfilled
 * legacy rows.
 */
export function classifyLeaks({ nodes, sourceById, requestSource }) {
  const leaks = [];
  if (!nodes || !sourceById || !requestSource) return leaks;
  for (const n of nodes) {
    if (!n || !n.sourceId) continue;
    const nodeSource = sourceById.get(n.sourceId);
    if (!nodeSource) continue; // unknown — skip
    if (nodeSource !== requestSource) {
      leaks.push({
        nodeId: (n.id || '').substring(0, 12),
        sourceType: n.sourceType,
        nodeSource,
        requestSource,
        contentPreview: (n.content || '').substring(0, 60),
      });
    }
  }
  return leaks;
}

/**
 * Phase 1 — structural leak classification using node-level scope.
 *
 * No Conversation join required: the scope tuple is directly on the node.
 * Flags any node that passesScopeFilter would block, EXCEPT legacy nodes
 * lacking both tier and chatJid — those go to classifyLeaks (Phase 0
 * Conversation-join path) since structural data is unavailable.
 *
 * Tier semantics match passesScopeFilter exactly.
 *
 * Returns the same leak[] shape as classifyLeaks so the renderer can stay
 * shared.
 */
export function classifyLeaksStructural({ nodes, requestScope }) {
  const leaks = [];
  if (!nodes || !requestScope) return leaks;
  for (const n of nodes) {
    if (!n) continue;
    // Skip nodes lacking ALL structural data — defer to legacy path.
    if (!n.tier && !n.chatJid && !n.companyId) continue;
    if (passesScopeFilter(n, requestScope)) continue;
    leaks.push(_leakEntry(n, requestScope.chatJid || null));
  }
  return leaks;
}

function _leakEntry(n, requestChatJid) {
  return {
    nodeId: (n.id || '').substring(0, 12),
    sourceType: n.sourceType,
    nodeSource: n.chatJid || `entity:${n.companyId || '?'}`,
    requestSource: requestChatJid || '(none)',
    contentPreview: (n.content || '').substring(0, 60),
    tier: n.tier,
  };
}

// ============================================================
// Privacy filter (Stage E)
// ============================================================

/**
 * Audience hierarchy — lower index = more restrictive.
 * Used to decide whether a node's audience is permissive enough for the
 * current conversation's audience.
 *
 * Rules:
 *   - A node with audience=ross-only can surface ONLY in a ross-only
 *     conversation (DM with the user).
 *   - A node with audience=entity-members can surface in ross-only or
 *     entity-members conversations (the user-private DM, group with the entity).
 *   - cross-entity / public nodes can surface anywhere.
 *
 * Conservative defaults: missing audience treated as ross-only.
 */
const AUDIENCE_RANK = { 'ross-only': 0, 'entity-members': 1, 'cross-entity': 2, 'public': 3 };
const DEFAULT_AUDIENCE_RANK = 0; // ross-only

export function isAudienceSafe(nodeAudience, requestAudience) {
  const nodeRank = AUDIENCE_RANK[nodeAudience] ?? DEFAULT_AUDIENCE_RANK;
  const reqRank = AUDIENCE_RANK[requestAudience] ?? DEFAULT_AUDIENCE_RANK;
  // Node passes when its audience is AT LEAST AS PERMISSIVE as the request's.
  // i.e. ross-only node (rank 0) only ever passes into ross-only requests (rank 0).
  // entity-members node (rank 1) passes into ross-only AND entity-members.
  // public node (rank 3) passes anywhere.
  return nodeRank >= reqRank;
}

/**
 * Apply audience-based privacy filtering to a candidate set.
 *
 * @param {Array} nodes
 * @param {object} opts
 * @param {string} opts.requestAudience — audience of the current conversation
 *                                         (e.g. 'ross-only' for a DM with the user,
 *                                         'entity-members' for a group chat)
 * @returns {{ kept, dropped }} — both arrays. dropped[] entries include the
 *                                 reason ('audience' | 'subjects') so the
 *                                 caller can log diagnostically.
 */
export function applyPrivacyFilter(nodes, { requestAudience } = {}) {
  const kept = [];
  const dropped = [];
  if (!Array.isArray(nodes)) return { kept, dropped };
  for (const n of nodes) {
    if (!n) continue;
    if (!isAudienceSafe(n.audience, requestAudience)) {
      dropped.push({
        nodeId: (n.id || '').substring(0, 12),
        nodeAudience: n.audience || '(null=ross-only)',
        requestAudience,
        reason: 'audience',
        contentPreview: (n.content || '').substring(0, 60),
      });
      continue;
    }
    // subjects[] check: Phase 1 only flags when subjects is populated AND a
    // subject doesn't appear in the conversation's audience set. Without
    // explicit roster data (Phase 2), we can't reliably enforce this; the
    // hook is here for the next iteration. For now we only log when a
    // subjects[] entry literally equals 'ross-only' as a sentinel — i.e. we
    // never drop on subjects in Phase 1. Kept as a no-op pass-through to
    // exercise the wiring.
    kept.push(n);
  }
  return { kept, dropped };
}

export default {
  CONVERSATION_DERIVED_TYPES,
  filterCheckable,
  classifyLeaks,
  classifyLeaksStructural,
  isAudienceSafe,
  applyPrivacyFilter,
};
