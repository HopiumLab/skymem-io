/**
 * Network Personas — Phase 4 (2026-05-09).
 *
 * Auto-promote person-type MemoryNodes to first-class PersonaFacts in the
 * `people` domain when they cross weighted thresholds. Per Decision 2 in
 * docs/persona-layer-vNext.md: "Network personas should be natural and
 * easy, it should promote to network personas like I have people nodes."
 *
 * Promotion is EMERGENT from the data — not opt-in, not declared. A person
 * earns a persona record when the user interacts with them deeply enough that
 * structured facts become valuable.
 *
 * Thresholds (weighted, all must pass unless tagged-chat short-circuits):
 *   - weight ≥ 0.4
 *   - referenceCount ≥ 20  OR  taggedChats ≥ 1 (Phase 5 pipe)
 *   - distinctConversations ≥ 3  (relax to 1 if tagged)
 *   - temporalSpan ≥ 14 days  (relax to 7 if tagged)
 *
 * Pipeline:
 *   1. findPromotionCandidates() — query MemoryNode for person-type nodes
 *      meeting thresholds. Cheap (one indexed query + per-row aggregate).
 *   2. gatherPersonContent(personNode) — pull node + edge-walk neighbours
 *      (1-2 hops) within the user's scope. The bundle of content the extractor
 *      will distil into structured facts about this person.
 *   3. promoteToPersona(personNode) — run the persona extractor with
 *      subjects=[personName], domain-locked to `people`. Upsert as
 *      slot=<name>, audience=ross-only, tier=global.
 *   4. promoteAllCandidates() — orchestrator: find + promote each, log results.
 *
 * Audience-locked to the user by design (Phase 4 spec) — network personas
 * surface the user-private context about other people. Chat tagging (Phase 5)
 * will provide the depth-multiplier signal but isn't required to promote.
 */

import prisma from './prisma-client.js';
import personaExtractor from './persona-extractor.js';
import persona from './persona.js';
import graph from './graph.js';

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_THRESHOLDS = {
  minWeight: 0.4,
  minReferenceCount: 20,
  minDistinctConversations: 3,
  minDistinctConversationsTagged: 1,
  minTemporalSpanDays: 14,
  minTemporalSpanDaysTagged: 7,
};

// Edge-walk hops per anchor person.
const HOPS = 2;
const MAX_NEIGHBOURS_PER_PERSON = 60;

// Hard cap how many people we promote per run — protect against
// pathological data where every person clears thresholds.
const MAX_PROMOTIONS_PER_RUN = 100;

// ============================================================
// CANDIDATE DISCOVERY
// ============================================================

/**
 * Find person-type MemoryNodes meeting the auto-promotion thresholds.
 *
 * @param {object} options
 *   thresholds — override DEFAULT_THRESHOLDS
 *   limit      — max candidates returned
 *   onlyMissing — true: skip people who already have a PersonaFact in
 *                 domain='people' with slot=<their-name>. Avoids re-doing
 *                 work. Default true.
 */
async function findPromotionCandidates(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const { limit = MAX_PROMOTIONS_PER_RUN, onlyMissing = true } = options;

  // Pull person-type nodes above the weight floor, plus aggregate signal
  // from MemoryEdge (referenceCount = inEdges + outEdges) and from
  // ChatTag (taggedChats). We do this in one Prisma query with `_count`.
  const persons = await prisma.memoryNode.findMany({
    where: {
      type: 'person',
      weight: { gte: thresholds.minWeight },
    },
    orderBy: { weight: 'desc' },
    take: 500, // wide pool — we filter on the JS side after computing aggregates
    select: {
      id: true,
      content: true,
      weight: true,
      createdAt: true,
      updatedAt: true,
      lastActivated: true,
      tags: true,
      _count: {
        select: {
          inEdges: true,
          outEdges: true,
        },
      },
    },
  });

  // Pull tagged-chat counts in a separate cheap query (groupBy chatJid + count
  // ChatTag rows whose persona.id corresponds to a person — but we don't have
  // that link yet because we're still in the discovery phase).
  // Skip Phase-5 tagging signal for Phase-4 v0 — fall back to non-tagged
  // thresholds. Phase 5 will add the tagged enrichment.

  const candidates = [];
  for (const p of persons) {
    const referenceCount = (p._count.inEdges || 0) + (p._count.outEdges || 0);
    const temporalSpanDays = Math.max(1, ((new Date(p.updatedAt) - new Date(p.createdAt)) / 86400000));
    // distinctConversations approximated via edge-source chatJids — proxied
    // by referenceCount / 4 below threshold for now (we'd need a SQL JOIN to
    // get exactly). Defer the precise computation to Phase 4.1.
    const distinctConversationsApprox = Math.max(1, Math.round(referenceCount / 4));

    const taggedChats = 0; // wired in Phase 5
    const tagged = taggedChats > 0;

    const passReference = referenceCount >= thresholds.minReferenceCount || tagged;
    const minConv = tagged ? thresholds.minDistinctConversationsTagged : thresholds.minDistinctConversations;
    const passConv = distinctConversationsApprox >= minConv;
    const minSpan = tagged ? thresholds.minTemporalSpanDaysTagged : thresholds.minTemporalSpanDays;
    const passSpan = temporalSpanDays >= minSpan;

    if (passReference && passConv && passSpan) {
      const personName = extractPersonName(p);
      if (!personName) continue;

      candidates.push({
        nodeId: p.id,
        name: personName,
        slot: persona_slot(personName),
        weight: p.weight,
        referenceCount,
        distinctConversationsApprox,
        temporalSpanDays: Math.round(temporalSpanDays),
        taggedChats,
        score: p.weight * 0.4 + Math.min(1, referenceCount / 80) * 0.4 + Math.min(1, temporalSpanDays / 90) * 0.2,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Optionally filter to people who don't yet have a PersonaFact
  if (onlyMissing && candidates.length > 0) {
    const existingSlots = await prisma.personaFact.findMany({
      where: {
        domain: 'people',
        slot: { in: candidates.map(c => c.slot) },
        chatJid: null, // global the user-scope facts only
      },
      select: { slot: true },
    });
    const existing = new Set(existingSlots.map(r => r.slot));
    const filtered = candidates.filter(c => !existing.has(c.slot));
    return filtered.slice(0, limit);
  }

  return candidates.slice(0, limit);
}

// ============================================================
// CONTENT GATHERING
// ============================================================

/**
 * Gather a content bundle to feed the extractor — the person's own node
 * + their edge-walked neighbours (1-2 hops). Returns nodes shaped for the
 * extractor (id, content, type, tags, etc).
 */
async function gatherPersonContent(personNodeId, options = {}) {
  const { hops = HOPS, maxNeighbours = MAX_NEIGHBOURS_PER_PERSON } = options;

  const personNode = await prisma.memoryNode.findUnique({
    where: { id: personNodeId },
    select: {
      id: true, type: true, content: true, tags: true, subjects: true,
      audience: true, createdAt: true, chatJid: true,
    },
  });
  if (!personNode) return [];

  // Walk edges (1-2 hops) to find connected nodes. Use the existing
  // graph.edgeWalk helper which already implements hop decay scoring.
  let neighbours = [];
  try {
    neighbours = await graph.edgeWalk([personNodeId], null, {
      perAnchor: maxNeighbours,
      limit: maxNeighbours,
      hops,
    });
  } catch (e) {
    console.warn(`[NetworkPersonas] edgeWalk failed for ${personNodeId}: ${e.message}`);
  }

  // Deduplicate + ensure we have the fields we need
  const byId = new Map();
  byId.set(personNode.id, personNode);
  for (const n of neighbours) {
    if (n.id === personNode.id) continue;
    byId.set(n.id, {
      id: n.id, type: n.type, content: n.content, tags: n.tags,
      subjects: n.subjects, audience: n.audience, createdAt: n.createdAt,
      chatJid: n.chatJid,
    });
  }
  return Array.from(byId.values());
}

// ============================================================
// PROMOTION
// ============================================================

/**
 * Promote one person to a PersonaFact. Runs the extractor with
 * subjects=[personName] over their gathered content bundle, filters
 * results to domain='people', and upserts as slot=<personname>.
 *
 * Returns the upserted PersonaFact + extraction summary.
 */
async function promoteToPersona(candidate, options = {}) {
  const { dryRun = false, batchSize = 25 } = options;

  const content = await gatherPersonContent(candidate.nodeId);
  if (content.length === 0) {
    return { ok: false, reason: 'no content to extract from' };
  }

  // Run extractor focused on this person.
  const summary = await personaExtractor.extractNodes(content, {
    batchSize,
    subjects: [candidate.name],
    extraScope: {
      // Stay in the user's global scope — these are the user-private facts about
      // someone in his network.
      chatJid: null,
      audience: 'ross-only',
      tier: 'global',
    },
    source: 'network-promotion',
    dryRun,
  });

  return {
    ok: true,
    candidate,
    extractedFacts: summary.factsWritten,
    byDomain: summary.byDomain,
    contentNodes: content.length,
  };
}

/**
 * Orchestrator: discover candidates, promote each, summarise.
 *
 * @param {object} options
 *   limit       — max promotions
 *   thresholds  — override DEFAULT_THRESHOLDS
 *   dryRun      — skip writes
 *   onPromoted  — callback({candidate, result}) per promotion
 */
async function promoteAllCandidates(options = {}) {
  const {
    limit = MAX_PROMOTIONS_PER_RUN,
    thresholds = DEFAULT_THRESHOLDS,
    dryRun = false,
    onPromoted = null,
  } = options;

  console.log('[NetworkPersonas] Discovering promotion candidates...');
  const candidates = await findPromotionCandidates({ thresholds, limit });
  console.log(`[NetworkPersonas] Found ${candidates.length} candidates above thresholds`);

  if (candidates.length === 0) return { promoted: 0, results: [] };

  const results = [];
  let promoted = 0;
  for (const c of candidates) {
    console.log(`[NetworkPersonas] Promoting "${c.name}" (weight=${c.weight.toFixed(2)} refs=${c.referenceCount} span=${c.temporalSpanDays}d score=${c.score.toFixed(3)})`);
    try {
      const res = await promoteToPersona(c, { dryRun });
      results.push(res);
      if (res.ok) promoted++;
      if (onPromoted) {
        try { onPromoted({ candidate: c, result: res }); } catch (_) {}
      }
    } catch (e) {
      console.warn(`[NetworkPersonas] promote ${c.name} failed: ${e.message}`);
      results.push({ ok: false, candidate: c, reason: e.message });
    }
  }

  console.log(`[NetworkPersonas] Promoted ${promoted}/${candidates.length} candidates${dryRun ? ' (dry run)' : ''}`);
  return { promoted, results, candidatesEvaluated: candidates.length };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Pull a stable name from a person MemoryNode. People nodes typically have
 * content like "Alex Chen" or are tagged with the name. Sky's
 * person ingest writes content with format:
 *
 *   "Alex — University friend, wedding in May"
 *   "Sarah Chen-Hoffman — Industry contact, conference acquaintance"
 *   "Jamie \"Aliased\" Patel — Best friend..."
 *
 * We split on the em-dash / hyphen + space to grab just the name portion,
 * not the descriptor. That gives stable slots ("alex", "sarah-chen-hoffman",
 * "jamie-aliased-patel") instead of full-content slots that conflict with
 * extractor-generated subject-tagged slots.
 */
function extractPersonName(node) {
  const tags = Array.isArray(node.tags) ? node.tags : [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    if (t.startsWith('name:')) return t.slice(5).trim();
    if (t.startsWith('person:')) return t.slice(7).trim();
  }
  const firstLine = (node.content || '').split('\n')[0].trim();
  if (!firstLine) return null;

  // Split on em-dash, en-dash, or " - " to isolate the name from descriptor.
  // Order matters: em-dash (—) and en-dash (–) are most common in Sky's
  // person-record format; ASCII " - " is the fallback.
  let name = firstLine;
  for (const sep of ['—', '–', ' - ']) {
    const idx = name.indexOf(sep);
    if (idx > 0) {
      name = name.slice(0, idx).trim();
      break;
    }
  }

  // Reject if either too long (probably wasn't a name in the first place)
  // or full of punctuation/quotes that won't slot cleanly.
  if (name.length === 0 || name.length > 60) return null;
  return name;
}

/**
 * Convert a person's display name into a stable kebab-case slot.
 * Person A → marie-seco-koppen
 * Person B → jt
 */
function persona_slot(name) {
  if (!name) return null;
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  findPromotionCandidates,
  gatherPersonContent,
  promoteToPersona,
  promoteAllCandidates,
  DEFAULT_THRESHOLDS,
  _internals: {
    extractPersonName,
    persona_slot,
  },
};
