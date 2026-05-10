/**
 * Typed Relational Edges — Tier 4 (2026-05-10).
 *
 * Extends MemoryEdge with structured (subject, predicate, object) triples.
 * The MemoryEdge schema already has a `type` field and `linkerNote`; we
 * use those plus a new convention for typed-edge metadata.
 *
 * Why this exists:
 *   Sky's edges currently are loose-typed ("connected to", "linked",
 *   "co-fires"). For multi-hop reasoning ("how did the user meet Person A?")
 *   we need explicit relations:
 *
 *     the user --visited--> Hanoi --in--> Vietnam
 *     the user --met--> Person A --at--> CEC
 *     the user --owns--> <separate-project> --part-of--> <umbrella-company>
 *
 *   Typed edges turn the graph from co-occurrence into navigation.
 *
 * Predicate vocabulary (controlled — keep tight):
 *   met, knows, works-with, reports-to,        # social
 *   visited, lives-in, born-in, moved-to,      # spatial
 *   founded, owns, runs, partner-in, parked,   # business
 *   decided, chose, abandoned, committed-to,   # decisions
 *   feels-about, prefers, dislikes,            # affect
 *   happened-on, scheduled-for, completed-on,  # temporal
 *   caused, follows, before, after,            # sequence
 *   member-of, part-of, child-of, instance-of, # composition
 *
 * Storage:
 *   MemoryEdge.type      — predicate (e.g. "met")
 *   MemoryEdge.linkerNote — JSON-stringified metadata:
 *     {
 *       "predicate": "met",
 *       "qualifier": "in person" | "online" | null,
 *       "tense": "past" | "present" | "future",
 *       "confidence": 0.85,
 *       "extractedFrom": "<sourceNodeId>",
 *       "validFrom": "<ISO date or null>"
 *     }
 *
 * Extraction:
 *   Haiku reads a MemoryNode's content and extracts triples. Subject and
 *   object must be existing MemoryNode IDs (resolved by name match against
 *   the graph). When unresolved, the triple is dropped — we don't auto-
 *   create new entities (that'd flood the graph).
 *
 * Cost per node: ~$0.0008 (Haiku, ~600 in / ~150 out tokens).
 *
 * Usage:
 *   const triples = await extractTriples(node);
 *   await persistTriples(triples);
 *
 *   const path = await walkPath(['ross-id'], 'met', 3);
 */

import prisma from './prisma-client.js';
import apiFallback from './api-fallback.js';

const HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL || 'claude-haiku-4-5';

// Controlled predicate vocabulary. Anything else is silently dropped.
const PREDICATES = new Set([
  // social
  'met', 'knows', 'works-with', 'reports-to', 'married-to', 'parent-of', 'friend-of',
  // spatial
  'visited', 'lives-in', 'born-in', 'moved-to', 'travelled-to', 'located-in',
  // business
  'founded', 'owns', 'runs', 'partner-in', 'parked', 'sold', 'invested-in',
  // decisions
  'decided', 'chose', 'abandoned', 'committed-to', 'rejected',
  // affect
  'feels-about', 'prefers', 'dislikes', 'admires',
  // temporal
  'happened-on', 'scheduled-for', 'completed-on', 'started-at',
  // sequence
  'caused', 'follows', 'before', 'after',
  // composition
  'member-of', 'part-of', 'child-of', 'instance-of', 'category-of',
  // generic
  'mentioned-in', 'related-to',
]);

// ============================================================
// EXTRACTION (LLM-driven)
// ============================================================

const SYSTEM_PROMPT = `You extract relational triples from text. Output ONLY valid JSON.

Each triple is a (subject, predicate, object) where:
- subject and object are concrete entities mentioned in the text (people / places / projects / dates / events).
- predicate is from this controlled vocabulary:
  social: met, knows, works-with, reports-to, married-to, parent-of, friend-of
  spatial: visited, lives-in, born-in, moved-to, travelled-to, located-in
  business: founded, owns, runs, partner-in, parked, sold, invested-in
  decisions: decided, chose, abandoned, committed-to, rejected
  affect: feels-about, prefers, dislikes, admires
  temporal: happened-on, scheduled-for, completed-on, started-at
  sequence: caused, follows, before, after
  composition: member-of, part-of, child-of, instance-of, category-of
  generic: mentioned-in, related-to

Output schema:
{
  "triples": [
    {
      "subject": "<entity name as in text>",
      "predicate": "<one from vocabulary>",
      "object": "<entity name as in text>",
      "qualifier": "<extra context, optional>" | null,
      "tense": "past" | "present" | "future",
      "confidence": <0.0-1.0>
    }
  ]
}

RULES:
- Only emit triples where BOTH subject and object are explicit entities (not pronouns).
- Predicate MUST be from vocabulary. Reject the triple otherwise.
- Skip generic / weak relations (e.g. "the user thinks about something") — too soft to be predictive.
- Confidence < 0.6: don't emit.
- Return at most 8 triples per text — pick the strongest.
- If the text has no extractable triples (small talk, ephemera), return {"triples": []}.`;

function buildExtractionPrompt(node) {
  return `Extract relational triples from this memory node.

NODE ID: ${node.id}
TYPE: ${node.type}
CONTENT: ${node.content?.slice(0, 1500) || ''}

Return JSON.`;
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
 * Extract triples from a single MemoryNode. Returns array of triple
 * candidates with subject/object as text strings (not yet resolved to IDs).
 */
async function extractTriples(node, options = {}) {
  const { model = HAIKU_MODEL } = options;
  if (!node || !node.content || node.content.length < 20) return [];

  let raw;
  try {
    raw = await apiFallback.generateResponse(SYSTEM_PROMPT, buildExtractionPrompt(node), {
      model, maxTokens: 800, cacheSystem: false,
    });
  } catch (e) {
    return [];
  }

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.triples)) return [];

  return parsed.triples
    .filter(t => t.subject && t.predicate && t.object)
    .filter(t => PREDICATES.has(t.predicate))
    .filter(t => typeof t.confidence === 'number' && t.confidence >= 0.6)
    .map(t => ({ ...t, sourceNodeId: node.id }));
}

// ============================================================
// RESOLUTION (text → MemoryNode IDs)
// ============================================================

/**
 * Resolve subject/object names to existing MemoryNode IDs by name match.
 * Returns { subjectId, objectId } if both resolve, or null.
 *
 * Resolution strategy:
 *   1. Exact-match against MemoryNode.tags `name:` / `person:` markers.
 *   2. Substring match in content (first 80 chars only — name should be
 *      in the title/lead, not buried).
 *   3. Lowercase, trim, strip punctuation for fuzzy match.
 *
 * If the entity isn't already in the graph, we DON'T auto-create — that
 * would flood with synthetic nodes. The triple is dropped instead.
 */
async function resolveTripleEntities(triple) {
  if (!triple || !triple.subject || !triple.object) return null;
  const norm = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9\s\-]/g, '').slice(0, 60);
  const subj = norm(triple.subject);
  const obj = norm(triple.object);
  if (!subj || !obj) return null;

  // Pull candidate nodes — we look at high-weight person/project nodes
  // first since most triples involve those.
  const candidates = await prisma.memoryNode.findMany({
    where: {
      OR: [
        { content: { contains: triple.subject } },
        { content: { contains: triple.object } },
      ],
      type: { in: ['person', 'project', 'company', 'place', 'event', 'concept', 'note'] },
    },
    select: { id: true, type: true, content: true, tags: true, weight: true },
    take: 20,
    orderBy: { weight: 'desc' },
  });

  const nameOf = (node) => {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('name:')) return norm(t.slice(5));
      if (t.startsWith('person:')) return norm(t.slice(7));
    }
    const firstLine = (node.content || '').split('\n')[0];
    const beforeDash = firstLine.split(/[—–]|\s-\s/)[0];
    return norm(beforeDash);
  };

  let subjectId = null, objectId = null;
  for (const c of candidates) {
    const nm = nameOf(c);
    if (!subjectId && (nm === subj || nm.startsWith(subj) || subj.startsWith(nm))) subjectId = c.id;
    if (!objectId  && (nm === obj  || nm.startsWith(obj)  || obj.startsWith(nm)))  objectId = c.id;
    if (subjectId && objectId) break;
  }

  if (!subjectId || !objectId || subjectId === objectId) return null;
  return { subjectId, objectId };
}

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Persist a list of resolved triples as MemoryEdge rows. Idempotent —
 * existing edges (same source + target) get their note merged but type
 * is updated to the new predicate (most recent wins).
 */
async function persistTriples(triples) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const t of triples) {
    const resolved = await resolveTripleEntities(t);
    if (!resolved) { skipped++; continue; }

    const note = JSON.stringify({
      predicate: t.predicate,
      qualifier: t.qualifier || null,
      tense: t.tense || 'past',
      confidence: t.confidence,
      extractedFrom: t.sourceNodeId,
    });

    try {
      const existing = await prisma.memoryEdge.findUnique({
        where: { sourceId_targetId: { sourceId: resolved.subjectId, targetId: resolved.objectId } },
        select: { id: true },
      });
      if (existing) {
        await prisma.memoryEdge.update({
          where: { id: existing.id },
          data: { type: t.predicate, linkerNote: note, updatedAt: new Date() },
        });
        updated++;
      } else {
        await prisma.memoryEdge.create({
          data: {
            sourceId: resolved.subjectId,
            targetId: resolved.objectId,
            type: t.predicate,
            linkerNote: note,
            strength: t.confidence,
          },
        });
        created++;
      }
    } catch (e) {
      // Likely FK violation if a node was deleted mid-op
      skipped++;
    }
  }

  return { created, updated, skipped };
}

// ============================================================
// PATH WALK
// ============================================================

/**
 * Walk paths from anchor nodes following typed predicates. Returns paths
 * as arrays of { fromId, toId, type, note } edges.
 *
 * Used by retrieval for multi-hop relational queries:
 *   "Who did the user meet in Hanoi?"
 *   → walkPath([ross.id], ['met'], 2) → returns ross → met → person → in → place
 *
 * @param {string[]} anchorIds — starting MemoryNode IDs
 * @param {string[]|null} predicateFilter — only follow edges with these types; null = any
 * @param {number} maxHops — depth limit (default 2)
 */
async function walkPath(anchorIds, predicateFilter = null, maxHops = 2) {
  if (!Array.isArray(anchorIds) || anchorIds.length === 0) return [];
  const allPaths = [];
  const visited = new Set();
  const frontier = anchorIds.map(id => ({ nodeId: id, path: [], depth: 0 }));

  while (frontier.length > 0) {
    const { nodeId, path, depth } = frontier.shift();
    if (depth >= maxHops) continue;
    if (visited.has(nodeId + '|' + depth)) continue;
    visited.add(nodeId + '|' + depth);

    const where = { sourceId: nodeId };
    if (predicateFilter && Array.isArray(predicateFilter)) where.type = { in: predicateFilter };

    const edges = await prisma.memoryEdge.findMany({
      where,
      take: 6,
      orderBy: { strength: 'desc' },
      select: { sourceId: true, targetId: true, type: true, linkerNote: true, strength: true },
    });

    for (const e of edges) {
      const newPath = [...path, e];
      allPaths.push(newPath);
      if (depth + 1 < maxHops) {
        frontier.push({ nodeId: e.targetId, path: newPath, depth: depth + 1 });
      }
    }
  }

  return allPaths;
}

// ============================================================
// BATCH RUNNER (for backfill + nightly sweep)
// ============================================================

/**
 * Run extraction over a batch of nodes. Used by:
 *   • One-shot backfill script (extract triples from all existing nodes)
 *   • Nightly sweep (extract from new nodes since last run)
 */
async function extractBatch(nodes, options = {}) {
  const { dryRun = false, model = HAIKU_MODEL, onNodeDone = null } = options;
  let totalTriples = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const node of nodes) {
    const triples = await extractTriples(node, { model });
    totalTriples += triples.length;

    if (!dryRun && triples.length > 0) {
      const result = await persistTriples(triples);
      totalCreated += result.created;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
    }
    if (onNodeDone) onNodeDone(node, triples);
  }

  return { totalTriples, totalCreated, totalUpdated, totalSkipped };
}

export default {
  PREDICATES,
  extractTriples,
  resolveTripleEntities,
  persistTriples,
  walkPath,
  extractBatch,
  _internals: { SYSTEM_PROMPT, buildExtractionPrompt, extractJson, HAIKU_MODEL },
};
