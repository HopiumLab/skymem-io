/**
 * MySQL FULLTEXT keyword search — replaces the `LIKE '%kw%'` full-table
 * scan in the buildContext keyword block (hot path) AND backs the cold-tier
 * surface (Phase 1, §6 of the implementation plan).
 *
 * Uses `MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)` via $queryRaw.
 * Words shorter than `innodb_ft_min_token_size` (default 3) are dropped
 * by MySQL — same behaviour as the existing keyword extractor which
 * already rejects 1-2 char keywords. No regression.
 *
 * Two entry points:
 *   - ftsHotSearch(...)  — small set, weight-sorted (matches the LIKE
 *                          path's existing semantics; replaces it on the
 *                          hot path when the flag is on).
 *   - ftsColdSearch(...) — wider set, FTS-relevance-sorted (cold tier;
 *                          surfaces older nodes intent regex / !find
 *                          asks for).
 *
 * Both accept a Phase 1 scope and combine FULLTEXT + scope filtering
 * in a single query. `scope` is null-safe — when no scope or flag-off,
 * scope conditions are omitted.
 *
 * Not a hard fail mode: callers should keep the LIKE path in their
 * fallback branch (e.g. when FTS errors with a stopword-only query),
 * but in practice Stage H makes FTS the live path.
 */

import prisma from './prisma-client.js';
import { Prisma } from '@prisma/client';
import { isScopeEnabled } from './scope-helpers.js';

const NON_RETRIEVED_SOURCE_TYPES = ['conversation-raw', 'sentiment'];

/**
 * Build the MySQL FULLTEXT WHERE-fragment for combined keyword + scope
 * filtering. Returns a `Prisma.sql` template that the caller composes
 * into a wider statement.
 *
 * Why hand-rolled rather than passing scope through Prisma's `where`?
 * `MATCH ... AGAINST` doesn't have a Prisma representation in 6.19, so
 * the whole query has to be raw — and we want one query, not two.
 */
function buildScopeSqlFragment(scope) {
  if (!scope || !isScopeEnabled()) {
    return Prisma.empty;
  }
  // Mirrors buildScopeWhere in scope-helpers.js, expressed as raw SQL.
  const orParts = [
    Prisma.sql`(\`tier\` = 'global')`,
    Prisma.sql`(\`tier\` = 'cross-entity')`,
  ];
  if (scope.companyId) {
    orParts.push(Prisma.sql`(\`tier\` = 'entity' AND \`companyId\` = ${scope.companyId})`);
  }
  if (scope.chatJid) {
    orParts.push(Prisma.sql`(\`tier\` IN ('chat', 'private') AND \`chatJid\` = ${scope.chatJid})`);
    orParts.push(Prisma.sql`(\`tier\` IS NULL AND \`chatJid\` = ${scope.chatJid})`);
  }
  return Prisma.sql` AND (${Prisma.join(orParts, ' OR ')})`;
}

function buildExclusionSqlFragment(excludedSourceTypes = NON_RETRIEVED_SOURCE_TYPES) {
  if (!excludedSourceTypes?.length) return Prisma.empty;
  return Prisma.sql` AND \`sourceType\` NOT IN (${Prisma.join(excludedSourceTypes)})`;
}

/**
 * Hot-path keyword search. Returns a small, weight-sorted set — same
 * shape the LIKE-based code in buildContext expects.
 *
 * @param {object} args
 * @param {string} args.query — keyword string
 * @param {number} args.limit — default 5 (matches the LIKE path's `take: 5`)
 * @param {object|null} args.scope — Phase 1 request scope; combined with FTS
 * @returns {Array<{id, type, content, weight, tags, sourceType, sourceId, chatJid, companyId, tier, audience, relevance}>}
 */
export async function ftsHotSearch({ query, limit = 5, scope = null }) {
  if (!query || query.trim().length < 2) return [];
  const scopeSql = buildScopeSqlFragment(scope);
  const exclusionSql = buildExclusionSqlFragment();
  try {
    return await prisma.$queryRaw`
      SELECT
        id, type, content, weight, tags, sourceType, sourceId,
        chatJid, companyId, tier, audience,
        MATCH(content) AGAINST(${query} IN NATURAL LANGUAGE MODE) AS relevance
      FROM \`MemoryNode\`
      WHERE MATCH(content) AGAINST(${query} IN NATURAL LANGUAGE MODE)
        ${exclusionSql}
        ${scopeSql}
      ORDER BY weight DESC, relevance DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.warn(`[KeywordSearch] FTS hot search failed for "${query}": ${err.message}`);
    return [];
  }
}

/**
 * Cold-tier keyword search. Wider net, FTS-relevance-sorted, returns up
 * to 20 by default. Triggered by intent regex (e.g. "remember when…",
 * "back when…") or by explicit !find/?find commands.
 */
export async function ftsColdSearch({ query, limit = 20, scope = null }) {
  if (!query || query.trim().length < 2) return [];
  const scopeSql = buildScopeSqlFragment(scope);
  const exclusionSql = buildExclusionSqlFragment();
  try {
    return await prisma.$queryRaw`
      SELECT
        id, type, content, weight, tags, sourceType, sourceId,
        chatJid, companyId, tier, audience,
        MATCH(content) AGAINST(${query} IN NATURAL LANGUAGE MODE) AS relevance
      FROM \`MemoryNode\`
      WHERE MATCH(content) AGAINST(${query} IN NATURAL LANGUAGE MODE)
        ${exclusionSql}
        ${scopeSql}
      ORDER BY relevance DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.warn(`[KeywordSearch] FTS cold search failed for "${query}": ${err.message}`);
    return [];
  }
}

// Patterns that hint at "look in older history" — drives cold-tier
// search invocation. Intentionally narrow; we don't want to fire on
// every casual "remember" mention.
const COLD_INTENT_PATTERN = /\b(remember when|that time|back when|years? ago|months? ago|last (week|month|year|spring|summer|autumn|winter)|do you (still )?have|find me)\b/i;

/**
 * Detect whether the message is asking about old history — i.e. should
 * we surface the cold tier in addition to the hot retrieval pass.
 */
export function isColdIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return COLD_INTENT_PATTERN.test(message);
}

export default { ftsHotSearch, ftsColdSearch, isColdIntent };
