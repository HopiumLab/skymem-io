/**
 * Multi-Axis Temporal Metadata — Tier 4 (2026-05-10).
 *
 * Most memory systems collapse time into one axis (createdAt). Real
 * temporal reasoning needs multiple axes:
 *
 *   createdAt       — when ingested into Sky (already on every row)
 *   mentionedAt     — when the speaker referenced the event in chat
 *                     (= the session timestamp / nearby ingest time)
 *   eventTime       — when the event ITSELF actually happened (may
 *                     differ from mentionedAt by years: "I went to
 *                     Tokyo in 2019" mentioned in a 2026 chat)
 *   sequenceBefore  — Json array of MemoryNode ids that this event
 *                     happened before (causal / temporal chain)
 *   sequenceAfter   — Json array of MemoryNode ids this happened after
 *   timeConfidence  — how certain are we about eventTime (0.0-1.0)
 *
 * The cat=2 TEMPORAL prompt fix gets ~80% of the LOCOMO lift without
 * these fields. With them, the answer-generator can do precise causal
 * reasoning ("what happened BEFORE X?") AND retrieval can boost candidates
 * by event-time proximity to the query.
 *
 * This module provides:
 *   • extractTemporalAxes(node, sessionDate) — Haiku call returning
 *     event_time guess + confidence + relative-time tokens detected
 *   • applyTemporalAxes(nodeId, axes) — write-back to MemoryNode
 *   • temporalProximityBoost(nodes, queryTime) — retrieval-time score
 *     boost for nodes whose eventTime is near queryTime
 *   • backfillBatch(nodes) — one-shot extraction over existing graph
 *
 * Cost per node: ~$0.0004 (Haiku, ~300 in / ~80 out tokens).
 */

import prisma from './prisma-client.js';
import apiFallback from './api-fallback.js';

const HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL || 'claude-haiku-4-5';

// ============================================================
// EXTRACTION
// ============================================================

const SYSTEM_PROMPT = `You extract temporal metadata from a memory node. Output ONLY valid JSON.

Given a node's content + the session timestamp (when the speaker said this), determine:
1. eventTime — when did the event ITSELF actually happen?
   Examples:
   - "I went to Tokyo in 2019" mentioned in 2026-05 → eventTime = 2019-01 (year-precision)
   - "Yesterday I had coffee with Person A" mentioned 2026-05-09 → eventTime = 2026-05-08 (day-precision)
   - "She said yes" (no time reference) → eventTime = same as mentionedAt
   - "Next month I'll fly to Berlin" mentioned 2026-05 → eventTime = 2026-06 (estimated future)

2. timeConfidence — how certain is the event time?
   - explicit date in text                     → 0.95
   - relative to session ("yesterday")         → 0.9
   - implied from context ("last summer")      → 0.7
   - none / can't determine                    → 0.4 (fallback to mentionedAt)

3. relativeTimeTokens — list of relative-time phrases found in text
   ["yesterday", "last week", "in March", "back in 2019", "tomorrow"]

Output schema:
{
  "eventTime": "<ISO date or null>",
  "timeConfidence": <0.0-1.0>,
  "relativeTimeTokens": ["<phrase>", ...],
  "reason": "<one short phrase>"
}

RULES:
- ALWAYS output valid ISO format dates ("2019-01-01" or "2024-03-15") or null.
- Default to year-precision (e.g., "2019-01-01") when only year is mentioned.
- If event is ongoing/permanent (e.g., "Person A lives in Geneva"), set eventTime = null.
- If text is small talk / ephemera (no temporal content), set eventTime = mentionedAt and confidence = 0.4.`;

function buildPrompt(node, mentionedAt) {
  return `NODE TYPE: ${node.type || 'unknown'}
SESSION/MENTIONED AT: ${mentionedAt ? new Date(mentionedAt).toISOString() : 'unknown'}

CONTENT:
${(node.content || '').slice(0, 1000)}

Extract temporal metadata as JSON.`;
}

function extractJson(raw) {
  if (!raw) return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {
    try { return JSON.parse(raw.slice(first, last + 1).replace(/,(\s*[}\]])/g, '$1')); } catch (_) { return null; }
  }
}

/**
 * Extract temporal axes for one node.
 * mentionedAt defaults to node.createdAt if not provided.
 *
 * @returns { eventTime: Date|null, timeConfidence: number, relativeTimeTokens: string[], mentionedAt: Date }
 */
async function extractTemporalAxes(node, mentionedAt = null) {
  if (!node || !node.content) {
    return { eventTime: null, timeConfidence: 0.4, relativeTimeTokens: [], mentionedAt: mentionedAt || node?.createdAt };
  }
  const ma = mentionedAt || node.createdAt || new Date();

  let raw;
  try {
    raw = await apiFallback.generateResponse(SYSTEM_PROMPT, buildPrompt(node, ma), {
      model: HAIKU_MODEL, maxTokens: 250, cacheSystem: false,
    });
  } catch (e) {
    return { eventTime: null, timeConfidence: 0.4, relativeTimeTokens: [], mentionedAt: ma };
  }

  const parsed = extractJson(raw);
  if (!parsed) return { eventTime: null, timeConfidence: 0.4, relativeTimeTokens: [], mentionedAt: ma };

  let eventTime = null;
  if (parsed.eventTime) {
    const d = new Date(parsed.eventTime);
    if (!isNaN(d.getTime())) eventTime = d;
  }
  const timeConfidence = typeof parsed.timeConfidence === 'number'
    ? Math.max(0, Math.min(1, parsed.timeConfidence))
    : 0.4;
  const relativeTimeTokens = Array.isArray(parsed.relativeTimeTokens)
    ? parsed.relativeTimeTokens.filter(t => typeof t === 'string').slice(0, 8)
    : [];

  return { eventTime, timeConfidence, relativeTimeTokens, mentionedAt: ma };
}

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Apply extracted axes to a node's row.
 */
async function applyTemporalAxes(nodeId, axes, options = {}) {
  if (!nodeId) return null;
  const data = {};
  if (axes.eventTime instanceof Date) data.eventTime = axes.eventTime;
  if (axes.mentionedAt instanceof Date) data.mentionedAt = axes.mentionedAt;
  if (typeof axes.timeConfidence === 'number') data.timeConfidence = axes.timeConfidence;
  if (Object.keys(data).length === 0) return null;
  return prisma.memoryNode.update({ where: { id: nodeId }, data });
}

// ============================================================
// SEQUENCE WIRING
// ============================================================

/**
 * Wire causal sequence — link node A as happening before node B.
 * Stores symmetrically: B.sequenceAfter += [A.id], A.sequenceBefore += [B.id].
 *
 * The sequence arrays are Json so we read-modify-write. Idempotent.
 */
async function wireSequence(beforeId, afterId) {
  if (!beforeId || !afterId || beforeId === afterId) return null;
  const [before, after] = await Promise.all([
    prisma.memoryNode.findUnique({ where: { id: beforeId }, select: { sequenceBefore: true } }),
    prisma.memoryNode.findUnique({ where: { id: afterId }, select: { sequenceAfter: true } }),
  ]);
  if (!before || !after) return null;

  const beforeArr = Array.isArray(before.sequenceBefore) ? before.sequenceBefore : [];
  const afterArr  = Array.isArray(after.sequenceAfter)  ? after.sequenceAfter  : [];
  if (!beforeArr.includes(afterId)) beforeArr.push(afterId);
  if (!afterArr.includes(beforeId)) afterArr.push(beforeId);

  await Promise.all([
    prisma.memoryNode.update({ where: { id: beforeId }, data: { sequenceBefore: beforeArr } }),
    prisma.memoryNode.update({ where: { id: afterId }, data: { sequenceAfter: afterArr } }),
  ]);
  return { beforeId, afterId };
}

// ============================================================
// RETRIEVAL BOOSTS
// ============================================================

/**
 * Score boost for nodes whose eventTime is near a query-relative time.
 * Used at retrieval time when the question has a temporal reference.
 *
 * Decay: full boost (+0.1) for nodes within 7 days of queryTime,
 * scaling down linearly to 0 at 365 days.
 */
function temporalProximityBoost(node, queryTime) {
  if (!node || !node.eventTime || !queryTime) return 0;
  const diffMs = Math.abs(new Date(node.eventTime).getTime() - new Date(queryTime).getTime());
  const days = diffMs / 86400000;
  if (days <= 7) return 0.1;
  if (days >= 365) return 0;
  return 0.1 * (1 - (days - 7) / 358);
}

/**
 * Find nodes that happened in a given time window. Used for retrieval
 * when the query has explicit dates.
 */
async function getNodesInWindow(start, end, options = {}) {
  const { limit = 50, scope = null } = options;
  const where = {
    eventTime: { gte: start, lte: end },
  };
  if (scope?.chatJid) where.chatJid = scope.chatJid;
  return prisma.memoryNode.findMany({
    where,
    orderBy: [{ eventTime: 'asc' }, { weight: 'desc' }],
    take: limit,
  });
}

// ============================================================
// BACKFILL RUNNER
// ============================================================

/**
 * One-shot backfill: extract temporal axes for nodes that don't have
 * mentionedAt set yet. Run as a script over existing data.
 */
async function backfillBatch(nodes, options = {}) {
  const { dryRun = false, onNodeDone = null } = options;
  let extracted = 0;
  let written = 0;
  for (const n of nodes) {
    const axes = await extractTemporalAxes(n);
    extracted++;
    if (!dryRun) {
      await applyTemporalAxes(n.id, axes);
      written++;
    }
    if (onNodeDone) onNodeDone(n, axes);
  }
  return { extracted, written };
}

export default {
  extractTemporalAxes,
  applyTemporalAxes,
  wireSequence,
  temporalProximityBoost,
  getNodesInWindow,
  backfillBatch,
  _internals: { SYSTEM_PROMPT, buildPrompt, extractJson, HAIKU_MODEL },
};
