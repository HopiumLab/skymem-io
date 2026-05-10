/**
 * Scope helpers — Phase 1.
 *
 * Pure functions that derive and validate the scope tuple
 * (chatJid, companyId, tier, audience, subjects) for a memory node.
 *
 * Used at three places:
 *   1. Backfill script (Stage B) — derive scope for existing rows.
 *   2. Ingestion (Stage C) — derive scope for new rows when no explicit
 *      scope is passed.
 *   3. Retrieval pipeline (Stage D) — derive the request's scope for
 *      filtering retrieved candidates.
 *
 * NO Prisma here — these helpers are pure. Database access lives in the
 * callers.
 */

// ============================================================
// Canonical sets — extend leak-detector's CONVERSATION_DERIVED_TYPES
// ============================================================

/** Tier values legal at the storage layer. */
export const VALID_TIERS = new Set([
  'private',       // hardest scope — never leaves originating chat
  'chat',          // chat-scoped, shared with chat members
  'entity',        // company-scoped
  'cross-entity',  // shared across entities (e.g. the user-only insights about portfolio)
  'global',        // available everywhere (knowledge, life-architecture, documents)
]);

/** Audience values legal at the storage layer. */
export const VALID_AUDIENCES = new Set([
  'ross-only',
  'entity-members',
  'cross-entity',
  'public',
]);

/** Source types that come from a single chat — Phase 0 leak-detector calls these conversation-derived. */
export const CHAT_SCOPED_SOURCE_TYPES = new Set([
  'conversation',
  'conversation-raw',
  'message',
  'sentiment',
  'group-chat',
]);

/** Source types that are intrinsically cross-chat by design. */
export const GLOBAL_SOURCE_TYPES = new Set([
  'knowledge',
  'decision',
  'life-architecture',
  'document',
  'life-journey',
  'dna',
]);

// ============================================================
// Derivation
// ============================================================

/**
 * Conservative defaults applied when we have no provenance at all.
 * `tier='global'` (not chat — we don't know the chat) and
 * `audience='ross-only'` (don't expose to anyone we can't identify).
 */
export const NO_PROVENANCE_FALLBACK = Object.freeze({
  chatJid: null,
  companyId: null,
  tier: 'global',
  audience: 'ross-only',
  subjects: [],
});

/**
 * Derive scope for a single node given whatever context the caller
 * could look up. Pure function — no DB.
 *
 * @param {object} node — must have at least sourceType + sourceId
 * @param {object} [ctx] — optional context the caller resolved via DB
 * @param {object|null} [ctx.conversation] — Conversation row if sourceType is chat-scoped
 *                                            (shape: { source, companyId } — both can be null)
 * @param {object|null} [ctx.parentScope]   — parent node's scope, for enrichment nodes
 *                                            (shape: { chatJid, companyId, tier, audience })
 * @returns {{ chatJid, companyId, tier, audience, subjects }}
 */
export function deriveScopeForNode(node, ctx = {}) {
  const conversation = ctx.conversation || null;
  const parentScope = ctx.parentScope || null;

  const sourceType = node?.sourceType || null;

  // 1. enrichment — inherit from the node it enriched.
  if (sourceType === 'enrichment') {
    if (parentScope) {
      return {
        chatJid: parentScope.chatJid || null,
        companyId: parentScope.companyId || null,
        tier: parentScope.tier || 'global',
        audience: parentScope.audience || 'ross-only',
        subjects: [],
      };
    }
    // Parent not found — fall back conservative.
    return { ...NO_PROVENANCE_FALLBACK };
  }

  // 2. conversation-derived — use Conversation.source for chat scope.
  if (CHAT_SCOPED_SOURCE_TYPES.has(sourceType)) {
    if (!conversation || !conversation.source) {
      // Conversation row not found — orphan. Conservative fallback.
      return { ...NO_PROVENANCE_FALLBACK };
    }
    const isGroup = sourceType === 'group-chat' || (conversation.source || '').startsWith('whatsapp:group:');
    const companyId = conversation.companyId || null;
    return {
      chatJid: conversation.source,
      companyId,
      tier: companyId ? 'entity' : 'chat',
      audience: isGroup ? 'entity-members' : 'ross-only',
      subjects: [],
    };
  }

  // 3. global-by-design source types.
  if (GLOBAL_SOURCE_TYPES.has(sourceType)) {
    return {
      chatJid: null,
      companyId: null,
      tier: 'global',
      audience: 'ross-only', // Phase 1 stays conservative — Phase 2 may promote individual nodes.
      subjects: [],
    };
  }

  // 4. anything else — unknown sourceType. Conservative fallback.
  return { ...NO_PROVENANCE_FALLBACK };
}

// ============================================================
// Request-time scope derivation (Stage C ingest call sites + Stage D retrieval)
// ============================================================

/**
 * Derive scope for the current request — the scope nodes ingested from this
 * conversation should carry, AND the scope retrieval should filter against.
 *
 * Inputs are the same shape sky/index.js#chat / chatWithActions already receive:
 *   - source       — `whatsapp:dm:<jid>` | `whatsapp:group:<jid>` | `terminal` | `api`
 *   - companyId    — null for personal context
 *   - groupContext — present implies group chat (audience = entity-members)
 *   - senderName   — used as the only `subjects[]` entry in Phase 1
 *
 * Phase 1 keeps subjects coarse — just the sender's name. Phase 2 will run
 * proper subject extraction on the message body.
 */
export function deriveScopeForRequest({ source, companyId = null, groupContext = null, senderName = null } = {}) {
  // No source means terminal/test — global-by-default.
  if (!source) {
    return { ...NO_PROVENANCE_FALLBACK };
  }
  const isGroup = !!groupContext || (typeof source === 'string' && source.startsWith('whatsapp:group:'));
  return {
    chatJid: source,
    companyId,
    tier: companyId ? 'entity' : 'chat',
    audience: isGroup ? 'entity-members' : 'ross-only',
    subjects: senderName ? [senderName] : [],
  };
}

// ============================================================
// Feature flag (Stage D)
// ============================================================

/**
 * Is the Phase 1 scope-filtering read path enabled?
 *
 * Stage H (4 May 2026): default flipped to ON. The env var is now an
 * explicit OPT-OUT — `SKY_PHASE1_SCOPE=false` (or `0` / `off` / `no`)
 * reverts to the pre-Phase-1 retrieval pipeline. Anything else (unset
 * or any other value) keeps Phase 1 active.
 *
 * Rollback recipe: set the var to `false` and restart. No redeploy or
 * code change required.
 *
 * Retrieval call sites call this per-request rather than caching the
 * result, so a runtime env flip on the next SIGHUP-style reload would
 * land immediately if we wire one in later.
 */
export function isScopeEnabled() {
  const v = (process.env.SKY_PHASE1_SCOPE ?? 'true').toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

// ============================================================
// Scope-based retrieval filter (Stage D)
// ============================================================

/**
 * Predicate: does a single retrieved candidate (memory node OR embedding row)
 * pass the scope filter for the current request?
 *
 * Rules:
 *   - tier='global' or tier='cross-entity'  → always passes (cross-chat by design)
 *   - tier='entity'  → passes iff candidate.companyId === request.companyId
 *   - tier='chat' or 'private' or null → passes iff candidate.chatJid === request.chatJid
 *   - candidate.chatJid null AND candidate.tier null → conservative: pass only
 *     when the request is also un-scoped (terminal/test). Old un-backfilled
 *     rows drop out of strict-mode retrieval. The leak detector will still
 *     warn on them.
 *
 * The candidate shape only needs `chatJid`, `companyId`, `tier`. Audience
 * and subjects are checked later in the privacy filter (Stage E).
 */
export function passesScopeFilter(candidate, requestScope) {
  if (!candidate || !requestScope) return false;
  const tier = candidate.tier || null;

  // Cross-everything tiers ignore chatJid + companyId.
  if (tier === 'global' || tier === 'cross-entity') return true;

  // Entity tier: require companyId match.
  if (tier === 'entity') {
    if (!requestScope.companyId) return false;
    return candidate.companyId === requestScope.companyId;
  }

  // Chat / private tiers: require chatJid match.
  if (tier === 'chat' || tier === 'private') {
    if (!candidate.chatJid || !requestScope.chatJid) return false;
    return candidate.chatJid === requestScope.chatJid;
  }

  // Legacy nodes (null tier) — pass if chatJid matches (same chat, tier
  // unknown), OR if both sides are un-scoped (terminal/test). Otherwise
  // drop. Backfill cleans up; the leak detector still warn-logs nulls.
  if (candidate.chatJid && requestScope.chatJid && candidate.chatJid === requestScope.chatJid) return true;
  if (!candidate.chatJid && !requestScope.chatJid) return true;
  return false;
}

/**
 * Build a Prisma `where` fragment that expresses passesScopeFilter as SQL.
 * Use this on the database side when you want the filter applied before
 * rows leave the DB (graph.retrieve, keyword findMany).
 */
export function buildScopeWhere(requestScope) {
  if (!requestScope) return {};
  // Always-pass tiers
  const orClauses = [
    { tier: 'global' },
    { tier: 'cross-entity' },
  ];
  if (requestScope.companyId) {
    orClauses.push({ AND: [{ tier: 'entity' }, { companyId: requestScope.companyId }] });
  }
  if (requestScope.chatJid) {
    orClauses.push({ AND: [{ tier: { in: ['chat', 'private'] } }, { chatJid: requestScope.chatJid }] });
    // Legacy null-tier rows that share chatJid (rare after backfill) — include
    // them so we don't lose data on partial-backfill prod rollouts.
    orClauses.push({ AND: [{ tier: null }, { chatJid: requestScope.chatJid }] });
  }
  return { OR: orClauses };
}

// ============================================================
// Validation (write-time guard for Stage C)
// ============================================================

/**
 * Returns null if the scope is well-formed; otherwise returns a string
 * describing the problem. Use at write time to bail loudly rather than
 * persist a corrupted scope.
 */
export function validateScope(scope) {
  if (!scope || typeof scope !== 'object') return 'scope must be an object';
  if (scope.tier && !VALID_TIERS.has(scope.tier)) return `unknown tier: ${scope.tier}`;
  if (scope.audience && !VALID_AUDIENCES.has(scope.audience)) return `unknown audience: ${scope.audience}`;
  if (scope.subjects != null && !Array.isArray(scope.subjects)) return 'subjects must be an array or null';
  return null;
}

// ============================================================
// Backfill batch helper
// ============================================================

/**
 * Apply scope derivation to a batch of nodes, given pre-fetched lookup
 * tables. Pure function — caller is responsible for the lookups.
 *
 * @param {Array<object>} nodes
 * @param {object} lookups
 * @param {Map<string, {source, companyId}>} lookups.conversationsBySrcId
 *        — Conversation rows keyed by their id, looked up by node.sourceId
 *           for chat-scoped types
 * @param {Map<string, {chatJid, companyId, tier, audience}>} lookups.parentScopeByNodeId
 *        — already-derived scope of parent nodes, looked up by enrichment
 *           node's parent id
 * @returns {Array<{ id, scope }>} — one entry per node, scope tuple to write
 */
export function deriveScopesForBatch(nodes, { conversationsBySrcId, parentScopeByNodeId } = {}) {
  const out = [];
  for (const node of nodes) {
    let ctx = {};
    if (CHAT_SCOPED_SOURCE_TYPES.has(node.sourceType) && node.sourceId && conversationsBySrcId) {
      ctx.conversation = conversationsBySrcId.get(node.sourceId) || null;
    }
    if (node.sourceType === 'enrichment' && parentScopeByNodeId) {
      // Enrichment nodes typically have sourceId pointing to the parent,
      // though some legacy paths used EnrichmentLog instead. The caller
      // resolves whichever path it can and supplies the result here.
      ctx.parentScope = parentScopeByNodeId.get(node.id) || null;
    }
    out.push({ id: node.id, scope: deriveScopeForNode(node, ctx) });
  }
  return out;
}

export default {
  VALID_TIERS,
  VALID_AUDIENCES,
  CHAT_SCOPED_SOURCE_TYPES,
  GLOBAL_SOURCE_TYPES,
  NO_PROVENANCE_FALLBACK,
  deriveScopeForNode,
  deriveScopeForRequest,
  isScopeEnabled,
  passesScopeFilter,
  buildScopeWhere,
  validateScope,
  deriveScopesForBatch,
};
