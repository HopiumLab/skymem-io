/**
 * Behavioural Patterns — Phase 2 (2026-05-10).
 *
 * Discovers META-rules from accumulated PersonaFact revisions, MemoryNode
 * sentiment, and decision-outcome pairs. Stores them in BehaviouralPattern
 * (schema already exists, see prisma/schema.prisma).
 *
 * Examples:
 *   "When stressed, decisions trend conservative." (sample size 12, conf 0.78)
 *   "Sharpest reasoning 06:00-09:00 BST." (sample size 22, conf 0.82)
 *   "Disengages from projects within ~3 weeks of <0.4 weight." (sample 8, conf 0.65)
 *
 * Design ref: docs/persona-layer-vNext.md (Patterns — Phase 2).
 *
 * Pipeline:
 *   1. Pull a candidate window from PersonaFactRevision (state changes)
 *      + MemoryNode (sentiment, decisions, outcomes) over a time window.
 *   2. Cluster by category (decision-style / energy / abandonment /
 *      communication / etc).
 *   3. Per cluster, ask Sonnet to mine candidate rules with conditions
 *      + predictions + supporting evidence ids.
 *   4. Each candidate rule gets a sample-size + confidence score.
 *      Stored as BehaviouralPattern row with `lastObserved`, `sources`,
 *      `validUntil`.
 *   5. Stale patterns decay; high-sample-size patterns persist.
 *
 * Cost: nightly Sonnet sweep across ~5 categories × ~2k input + ~500
 * output tokens each = ~$0.05-0.15 per nightly run.
 *
 * Surface points (not in this module — for future wiring):
 *   • Morning brief: "patterns observed last week" surfaces top 3.
 *   • At chat-time, when retrieved persona facts trigger a known pattern,
 *     surface the prediction inline ("based on your pattern, X tends to Y").
 */

import prisma from './prisma-client.js';
import apiFallback from './api-fallback.js';

const SONNET_MODEL = process.env.SKY_API_FALLBACK_MODEL || 'claude-sonnet-4-5';

// Category → seed keywords for evidence pulling.
const PATTERN_CATEGORIES = {
  'decision-style': {
    description: 'Decision-making patterns — risk-taking, analytical-vs-intuitive, time-of-day effects, mood effects.',
    seedTags: ['decision', 'choice', 'pivot', 'commit'],
  },
  'energy': {
    description: 'Energy / mood / focus patterns — when sharpest, what drains, what energises.',
    seedTags: ['energy', 'tired', 'sharp', 'focus', 'drained'],
  },
  'abandonment': {
    description: 'Project / commitment abandonment patterns — what makes the user drop a thing, what keeps it alive.',
    seedTags: ['parked', 'killed', 'shelved', 'abandoned'],
  },
  'communication': {
    description: 'Communication patterns with specific people / contexts — when curt, when expansive, when avoidant.',
    seedTags: ['voice', 'tone', 'communication', 'reply'],
  },
  'commitment': {
    description: 'Follow-through patterns — what predicts commitment vs slippage on commitments.',
    seedTags: ['commit', 'promise', 'followed-through', 'slipped'],
  },
};

// ============================================================
// CANDIDATE WINDOW
// ============================================================

/**
 * Pull supporting evidence for a category over a time window.
 * Returns a small structured set the LLM can reason over.
 */
async function pullEvidence(category, options = {}) {
  const { sinceDays = 30, perCategoryCap = 60 } = options;
  const since = new Date(Date.now() - sinceDays * 86400000);

  const cat = PATTERN_CATEGORIES[category];
  if (!cat) return { facts: [], revisions: [], nodes: [] };

  // Pull recent persona-fact revisions in matching domains.
  const factRows = await prisma.personaFact.findMany({
    where: {
      domain: { in: ['decisions', 'preferences', 'active', 'goals'] },
      updatedAt: { gte: since },
    },
    select: { id: true, domain: true, slot: true, facts: true, updatedAt: true, confidence: true },
    take: perCategoryCap,
    orderBy: { updatedAt: 'desc' },
  });

  // Pull a small slice of recent MemoryNode that matches the seed tags.
  // Use a JSON-array LIKE-style filter — MySQL's JSON_CONTAINS is the proper
  // path but a tag-startsWith filter also works for Sky's tag conventions.
  const seedNodes = await prisma.memoryNode.findMany({
    where: {
      createdAt: { gte: since },
      OR: cat.seedTags.map(t => ({ content: { contains: t } })),
    },
    select: { id: true, type: true, content: true, tags: true, createdAt: true, weight: true },
    take: perCategoryCap,
    orderBy: { weight: 'desc' },
  });

  // Pull revisions for facts in the matching domains.
  const factIds = factRows.map(f => f.id);
  const revisions = factIds.length > 0 ? await prisma.personaFactRevision.findMany({
    where: { factId: { in: factIds } },
    orderBy: { createdAt: 'asc' },
    take: perCategoryCap * 3,
    select: { factId: true, payload: true, confidence: true, source: true, createdAt: true, reason: true },
  }) : [];

  return { facts: factRows, revisions, nodes: seedNodes };
}

// ============================================================
// MINING (Sonnet sweep)
// ============================================================

const SYSTEM_PROMPT = `You are a behavioural-pattern miner. Given evidence (persona facts + memory nodes + revisions), extract specific predictive rules about the user's behaviour. Output ONLY valid JSON.

Each rule must follow this shape:
{
  "category": "decision-style" | "energy" | "abandonment" | "communication" | "commitment",
  "rule": "<one-sentence statement of the pattern, third-person about the user>",
  "conditions": {
    "<key>": "<value or pattern>",
    "...": "..."
  },
  "prediction": {
    "<key>": "<predicted tendency>",
    "...": "..."
  },
  "sampleSize": <int — how many supporting instances you saw in evidence>,
  "confidence": <0.0 to 1.0>,
  "sources": ["<MemoryNode or PersonaFact id>", ...]
}

RULES:
- A good rule is SPECIFIC and PREDICTIVE. Bad: "the user sometimes feels tired." Good: "the user's reasoning quality drops 30%+ after 22:00 BST on consecutive late nights."
- Only emit rules with sampleSize >= 3 in the supplied evidence.
- Confidence reflects strength + breadth of evidence:
    0.9+: 10+ supporting instances, no counter-evidence
    0.7-0.9: 5-10 instances, mostly consistent
    0.5-0.7: 3-5 instances, some counter-evidence
    <0.5: don't emit
- If no patterns clear the bar in the evidence, return empty array [].`;

function buildUserPrompt(category, evidence) {
  const cat = PATTERN_CATEGORIES[category];
  // Trim each evidence item to keep total prompt reasonable. Sonnet handles
  // large prompts but tokens cost.
  const trim = (s, n) => (s || '').slice(0, n).replace(/\s+/g, ' ');

  const factsBlock = evidence.facts.slice(0, 30).map(f => {
    const text = (f.facts && typeof f.facts === 'object' && f.facts.text) ? f.facts.text : JSON.stringify(f.facts);
    return `[${f.id}] (${f.domain}/${f.slot}, conf=${f.confidence?.toFixed(2)}, ${f.updatedAt?.toISOString().slice(0, 10)}) ${trim(text, 200)}`;
  }).join('\n');

  const revBlock = evidence.revisions.slice(0, 30).map(r => {
    const text = (r.payload && typeof r.payload === 'object' && r.payload.text) ? r.payload.text : JSON.stringify(r.payload);
    return `[rev:${r.factId}] (conf=${r.confidence?.toFixed(2)}, ${r.createdAt?.toISOString().slice(0, 10)}, src=${r.source}) ${trim(text, 200)}`;
  }).join('\n');

  const nodesBlock = evidence.nodes.slice(0, 20).map(n =>
    `[${n.id}] (${n.type}, w=${n.weight?.toFixed(2)}, ${n.createdAt?.toISOString().slice(0, 10)}) ${trim(n.content, 200)}`
  ).join('\n');

  return `CATEGORY: ${category}
DESCRIPTION: ${cat.description}

PERSONA FACTS:
${factsBlock || '(none)'}

REVISIONS:
${revBlock || '(none)'}

MEMORY NODES (sentiment / decisions / outcomes):
${nodesBlock || '(none)'}

Mine 0-5 specific predictive rules from this evidence. Reply with a JSON array of rule objects (empty array if no rules clear the bar).`;
}

function extractJsonArray(text) {
  if (!text) return null;
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) return null;
  const slice = text.slice(first, last + 1);
  try { return JSON.parse(slice); } catch (_) {
    try { return JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1')); } catch (_) { return null; }
  }
}

async function mineCategory(category, options = {}) {
  const { dryRun = false, model = SONNET_MODEL, sinceDays = 30 } = options;
  const evidence = await pullEvidence(category, { sinceDays });
  if (evidence.facts.length + evidence.revisions.length + evidence.nodes.length < 5) {
    return { category, mined: 0, skipped: 'insufficient evidence' };
  }

  const userPrompt = buildUserPrompt(category, evidence);
  let raw;
  try {
    raw = await apiFallback.generateResponse(SYSTEM_PROMPT, userPrompt, {
      model, maxTokens: 1500, cacheSystem: false,
    });
  } catch (e) {
    return { category, mined: 0, error: e.message };
  }

  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    return { category, mined: 0, error: 'malformed JSON' };
  }

  let written = 0;
  for (const rule of parsed) {
    if (!rule.rule || typeof rule.rule !== 'string') continue;
    if (typeof rule.confidence !== 'number' || rule.confidence < 0.5) continue;
    if (typeof rule.sampleSize !== 'number' || rule.sampleSize < 3) continue;
    if (dryRun) { written++; continue; }
    try {
      await prisma.behaviouralPattern.create({
        data: {
          category: rule.category || category,
          rule: rule.rule,
          conditions: rule.conditions || {},
          prediction: rule.prediction || {},
          sampleSize: rule.sampleSize,
          confidence: rule.confidence,
          sources: Array.isArray(rule.sources) ? rule.sources : [],
          lastObserved: new Date(),
        },
      });
      written++;
    } catch (e) {
      console.warn(`[Patterns] write failed: ${e.message}`);
    }
  }
  return { category, mined: parsed.length, written };
}

/**
 * Run the nightly sweep across all categories.
 *
 * @param {object} options
 *   dryRun       — don't write to DB
 *   sinceDays    — evidence window (default 30)
 *   onCategoryDone — callback per category for progress
 */
async function runNightlySweep(options = {}) {
  const { dryRun = false, sinceDays = 30, onCategoryDone = null } = options;
  const summary = { categories: {}, totalWritten: 0 };
  for (const cat of Object.keys(PATTERN_CATEGORIES)) {
    const result = await mineCategory(cat, { dryRun, sinceDays });
    summary.categories[cat] = result;
    if (typeof result.written === 'number') summary.totalWritten += result.written;
    if (onCategoryDone) onCategoryDone(cat, result);
  }
  return summary;
}

/**
 * Decay stale patterns. Run after sweep — anything that hasn't been
 * re-observed in 90 days gets validUntil set so retrieval skips it.
 */
async function decayStalePatterns(options = {}) {
  const { staleDays = 90 } = options;
  const cutoff = new Date(Date.now() - staleDays * 86400000);
  const result = await prisma.behaviouralPattern.updateMany({
    where: {
      lastObserved: { lt: cutoff },
      validUntil: null,
    },
    data: { validUntil: new Date() },
  });
  return { decayed: result.count };
}

// ============================================================
// RETRIEVAL HELPER (for chat-time surfacing)
// ============================================================

/**
 * Get the top-N most relevant patterns for a context. Used by the
 * morning-brief and chat-path to surface predictions inline.
 */
async function getTopPatterns(options = {}) {
  const { limit = 8, minConfidence = 0.6, category = null, includeSuperseded = false } = options;
  const where = { confidence: { gte: minConfidence } };
  if (category) where.category = category;
  if (!includeSuperseded) {
    where.OR = [{ validUntil: null }, { validUntil: { gt: new Date() } }];
  }
  return prisma.behaviouralPattern.findMany({
    where,
    orderBy: [{ confidence: 'desc' }, { sampleSize: 'desc' }, { lastObserved: 'desc' }],
    take: limit,
  });
}

export default {
  PATTERN_CATEGORIES,
  pullEvidence,
  mineCategory,
  runNightlySweep,
  decayStalePatterns,
  getTopPatterns,
  _internals: { SYSTEM_PROMPT, buildUserPrompt, extractJsonArray, SONNET_MODEL },
};
