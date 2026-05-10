/**
 * Persona Extractor — Phase 0 (2026-05-08).
 *
 * LLM-driven distillation of MemoryNode rows into structured PersonaFact
 * records. Used by:
 *   - scripts/bootstrap-persona.js — one-shot pass over the 44k existing
 *     nodes to seed the persona layer
 *   - sky/persona-orchestrator.js (Phase 0+) — incremental update on new
 *     ingest batches
 *
 * Pipeline:
 *   1. Pull a batch of MemoryNode rows (caller-supplied)
 *   2. Group by chatJid so context is preserved within a thread
 *   3. Per group, ask Haiku to extract { domain, slot, fact, confidence,
 *      evidence } facts. JSON-only response.
 *   4. Aggregate within the batch — same (domain, slot) collapses into a
 *      single record with merged evidence + averaged confidence
 *   5. Upsert via persona.upsertFact (which appends a PersonaFactRevision
 *      every write — Phase 1 trajectories already accumulating)
 *
 * Cost control:
 *   - Haiku for the extraction pass (cheap, fast)
 *   - Sonnet for slots flagged as "needs richer distillation" (e.g.
 *     identity/voice — voice tone benefits from a smarter pass)
 *   - Token budget per batch: ~4k input → ~1k output
 *   - We chunk content blocks to fit in budget; long nodes are truncated
 *     to 1200 chars (front + back if very long)
 *
 * Robustness:
 *   - JSON extraction is forgiving: extracts the first [...] in the
 *     response, ignores leading/trailing prose
 *   - Failed JSON parse logs the raw response and skips that batch
 *     (does NOT throw — bootstrap can be hours long; one bad batch
 *     shouldn't kill the whole run)
 *   - Slot names are normalised: kebab-case, lowercase, strip non-alnum
 */

import prisma from './prisma-client.js';
import persona from './persona.js';
import apiFallback from './api-fallback.js';

// ============================================================
// CONFIG
// ============================================================

const HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL || 'claude-haiku-4-5';
const SONNET_MODEL = process.env.SKY_API_FALLBACK_MODEL || 'claude-sonnet-4-5';

// Per-node truncation. Most messages are short. Long ones get head+tail
// with an elision marker so we don't blow the context budget on a single
// transcript dump.
const MAX_NODE_CHARS = 1200;
const NODE_HEAD_CHARS = 800;
const NODE_TAIL_CHARS = 300;

// Default batch size in nodes. The bootstrap script overrides this.
const DEFAULT_BATCH_SIZE = 25;

// Domains where Sonnet's nuance is worth the extra ~6x cost.
// Voice/values/preferences benefit from richer distillation; portfolio,
// active, decisions are more factual and Haiku handles them fine.
const SONNET_PROMOTION_DOMAINS = new Set(['identity', 'preferences']);

// Slots we never want to write — common LLM hallucinations or generic
// labels that add noise. Add to this set as patterns emerge.
const SLOT_BLOCKLIST = new Set([
  'unknown',
  'misc',
  'other',
  'general',
  '',
]);

// ============================================================
// EXTRACTION PROMPT
// ============================================================

const DEFAULT_SUBJECTS = ['the user'];

/**
 * Build the system prompt parameterised by subject list.
 *
 * Phase 0 (the user PA): subjects = ['the user']. The prompt's domain definitions
 * + slot conventions are written for the user's life context (project-a,
 * marie, etc.) — these stay regardless of subject because they're
 * categorical examples, not subject-bound.
 *
 * LOCOMO mode: subjects = ['Caroline', 'Melanie'] (or whichever pair the
 * sample has). Same 7 domains. Same JSON shape. Two-speaker mode emits
 * subject-tagged facts: each fact's "subject" field tells the retriever
 * which speaker the fact is about, used for filtering.
 */
function buildSystemPrompt(subjects = DEFAULT_SUBJECTS) {
  const subjectStr = subjects.length === 1
    ? subjects[0]
    : `${subjects.slice(0, -1).join(', ')} and ${subjects[subjects.length - 1]}`;
  const subjectFieldRequired = subjects.length > 1;

  return `You are extracting structured persona facts about ${subjectStr} from message/note history.

You output ONLY valid JSON — no prose, no markdown, no explanation. The response must start with [ and end with ].

Each fact you extract must fit one of these 7 domains:
- identity     — biography, family, location, values, voice patterns, life context
- portfolio    — companies, projects, ownership, active vs parked, business structure (or hobbies/projects in non-business contexts)
- active       — what's in flight RIGHT NOW; blockers, deadlines, this-week priorities
- people       — relationships and other people in the subject's life — who they are, role, trust level, communication patterns
- decisions    — recent + standing decisions
- preferences  — voice/workflow/energy patterns, anti-patterns, what energises vs drains
- goals        — life/year/quarter/week goals, aspirations, planned trips, milestones

For each fact, output a JSON object:
{${subjectFieldRequired ? `
  "subject": "<which person this fact is about — one of: ${subjects.join(', ')}>",` : ''}
  "domain": "<one of the 7>",
  "slot": "<stable-kebab-case-key>",
  "fact": "<one or two sentences capturing the fact in third person>",
  "confidence": <0.0 to 1.0>,
  "evidence": ["<nodeId>", ...]
}

SLOT RULES:
- Slot is a stable identifier — same fact from different message batches must produce the SAME slot
- Use kebab-case, lowercase, no spaces (e.g. "morning-routine", "guitar-playing", "adoption-process")
- For people: use the person's first name lowercase
- For projects/hobbies: use a stable slug
- For decisions/preferences: describe the rule

CONFIDENCE RULES:
- 0.9+ — directly stated, multiple times
- 0.7-0.9 — clearly inferable from one or two strong signals
- 0.5-0.7 — plausible inference but could be wrong
- <0.5   — DON'T emit. Skip the fact.

EVIDENCE RULES:
- "evidence" is the array of node IDs that support this fact
- Include up to 5 strongest IDs, freshest first

EXTRACTION RULES:
- Only emit facts about ${subjectStr}${subjectFieldRequired ? ' — ALWAYS include the "subject" field marking which speaker' : ''}
- Don't repeat: aggregate similar messages into one fact
- Skip ephemera ("hi", "thanks", "lol", emoji-only messages)
- If the batch has no extractable persona facts, return []`;
}

// Backward compat — module-level constant for the user's default prompt.
const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_SUBJECTS);

// ============================================================
// NODE PREP
// ============================================================

function truncateContent(text) {
  if (!text) return '';
  if (text.length <= MAX_NODE_CHARS) return text;
  const head = text.slice(0, NODE_HEAD_CHARS);
  const tail = text.slice(-NODE_TAIL_CHARS);
  return `${head}\n[...elided ${text.length - NODE_HEAD_CHARS - NODE_TAIL_CHARS} chars...]\n${tail}`;
}

/**
 * Render a batch of MemoryNode rows into a prompt-ready text block.
 * Each node gets its id + type + truncated content + tags. The LLM uses
 * the id as the evidence reference.
 */
function renderBatch(nodes) {
  return nodes
    .map((n) => {
      const date = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : '?';
      const subjects =
        Array.isArray(n.subjects) && n.subjects.length ? ` subjects=[${n.subjects.join(',')}]` : '';
      const audience = n.audience ? ` audience=${n.audience}` : '';
      const content = truncateContent(n.content || '');
      return `--- node ${n.id} type=${n.type || '?'} date=${date}${audience}${subjects}
${content}`;
    })
    .join('\n\n');
}

// ============================================================
// JSON EXTRACTION
// ============================================================

/**
 * Pull the first JSON array out of an LLM response, tolerating prose
 * before/after. Returns parsed array or null on failure.
 */
function extractJsonArray(text) {
  if (!text) return null;
  // Look for the first '[' and the last ']' — handles models that wrap
  // the array in ```json ... ``` or add prose after.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) return null;
  const slice = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    // One repair attempt: trailing commas are the most common LLM JSON sin.
    try {
      const repaired = slice.replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      /* fall through */
    }
    return null;
  }
}

// ============================================================
// SLOT NORMALISATION
// ============================================================

function normaliseSlot(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) return null;
  if (SLOT_BLOCKLIST.has(cleaned)) return null;
  if (cleaned.length > 80) return cleaned.slice(0, 80);
  return cleaned;
}

// ============================================================
// EXTRACTION (single batch, single LLM call)
// ============================================================

/**
 * Run extraction on one batch of nodes. Returns a list of raw fact
 * candidates (un-aggregated, un-validated against schema).
 *
 * @param {Array<MemoryNode>} nodes
 * @param {object} options
 *   model — override LLM model. Defaults to Haiku.
 *   verbose — log prompt sizes + raw responses
 */
async function extractBatch(nodes, options = {}) {
  if (!nodes || nodes.length === 0) return [];
  const {
    model = HAIKU_MODEL,
    verbose = false,
    subjects = DEFAULT_SUBJECTS,
  } = options;

  const subjectStr = subjects.length === 1
    ? subjects[0]
    : `${subjects.slice(0, -1).join(', ')} and ${subjects[subjects.length - 1]}`;

  const systemPrompt = subjects === DEFAULT_SUBJECTS
    ? SYSTEM_PROMPT
    : buildSystemPrompt(subjects);

  const userBlock = `Here are ${nodes.length} memory nodes. Extract persona facts about ${subjectStr}.

${renderBatch(nodes)}

Return a JSON array of fact objects. Empty array if nothing extractable.`;

  if (verbose) {
    console.log(
      `[Extractor] batch=${nodes.length} model=${model} subjects=[${subjects.join(',')}] promptChars=${userBlock.length}`
    );
  }

  let raw;
  try {
    raw = await apiFallback.generateResponse(systemPrompt, userBlock, {
      model,
      maxTokens: 2048,
      cacheSystem: true,
    });
  } catch (e) {
    console.warn(`[Extractor] LLM call failed: ${e.message}`);
    return [];
  }

  if (verbose) {
    console.log(`[Extractor] raw response (${raw?.length || 0} chars):`);
    console.log(raw?.slice(0, 500));
  }

  const parsed = extractJsonArray(raw);
  if (!parsed) {
    console.warn(`[Extractor] failed to parse JSON from response. First 200 chars: ${(raw || '').slice(0, 200)}`);
    return [];
  }

  return parsed;
}

// ============================================================
// AGGREGATION (collapse duplicate slots within a batch)
// ============================================================

/**
 * Given a list of raw fact candidates, fold same-(domain, slot) entries
 * into a single record. Confidence becomes the max; evidence is unioned;
 * the longest fact-text wins (most informative).
 *
 * @param {object} options
 *   slotPrefix — prepended to every slot at aggregation time. Used by
 *     bench mode (LOCOMO) to namespace per-sample facts and avoid collisions
 *     with the global PersonaFact (domain, slot) unique constraint. Format
 *     should end in "--" by convention so e.g. "conv-1--marie" is the slot.
 *   includeSubject — preserve the per-fact 'subject' field on the aggregated
 *     record. When true, each entry carries .subject so the renderer / DB
 *     write can store the per-speaker tag.
 */
function aggregate(rawFacts, options = {}) {
  const { slotPrefix = '', includeSubject = false } = options;
  const buckets = new Map(); // key = `${domain}|${slot}` → merged record

  for (const f of rawFacts) {
    if (!f || typeof f !== 'object') continue;
    if (!f.domain || !f.slot || !f.fact) continue;
    if (!persona.DOMAINS.includes(f.domain)) continue;

    const baseSlot = normaliseSlot(f.slot);
    if (!baseSlot) continue;
    const subject = (typeof f.subject === 'string' && f.subject.trim()) ? f.subject.trim() : null;
    // Compose slot: prefix + (subject + '-')? + baseSlot. The subject token
    // makes the slot stable across speakers when both have a "hobby" slot.
    const subjectToken = (includeSubject && subject) ? `${normaliseSlot(subject)}-` : '';
    const slot = `${slotPrefix}${subjectToken}${baseSlot}`;

    const conf = typeof f.confidence === 'number' ? f.confidence : 0.6;
    if (conf < 0.5) continue;

    const key = `${f.domain}|${slot}`;
    const evidence = Array.isArray(f.evidence) ? f.evidence.filter((e) => typeof e === 'string') : [];

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        domain: f.domain,
        slot,
        fact: String(f.fact).trim(),
        confidence: conf,
        evidence: [...new Set(evidence)],
        ...(includeSubject && subject ? { subject } : {}),
      });
    } else {
      const ev = new Set([...existing.evidence, ...evidence]);
      existing.evidence = [...ev].slice(0, 12);
      if (conf > existing.confidence) existing.confidence = conf;
      const incoming = String(f.fact).trim();
      if (incoming.length > existing.fact.length && incoming.length <= 600) {
        existing.fact = incoming;
      }
    }
  }

  return [...buckets.values()];
}

// ============================================================
// WRITE — persist via persona.upsertFact
// ============================================================

/**
 * Write the aggregated facts to PersonaFact. Returns counts by domain.
 *
 * On conflict (domain+slot already exists), upsertFact merges by
 * overwriting facts/confidence/sourceNodes — Phase 1 trajectory tracking
 * via PersonaFactRevision captures the prior state automatically.
 *
 * Future improvement (Phase 1 wired): blend new fact with existing rather
 * than overwrite — preserves earlier evidence. For Phase 0 bootstrap,
 * overwrite is the simpler path: bootstrap reads ALL nodes at once so the
 * "winner" already represents the union of evidence.
 */
async function writeFacts(aggregated, options = {}) {
  const {
    source = 'extraction',
    dryRun = false,
    chatJid = null,
    companyId = null,
    audience = 'ross-only',
    tier = 'global',
  } = options;
  const counts = {};
  for (const dom of persona.DOMAINS) counts[dom] = 0;

  for (const f of aggregated) {
    if (dryRun) {
      counts[f.domain] = (counts[f.domain] || 0) + 1;
      continue;
    }
    try {
      // Pack subject into the JSON payload so the retrieval-time renderer
      // can show "Caroline:" / "Melanie:" prefixes on multi-speaker scopes.
      const payload = {
        text: f.fact,
        evidence: f.evidence,
        ...(f.subject ? { subject: f.subject } : {}),
      };
      await persona.upsertFact({
        domain: f.domain,
        slot: f.slot,
        facts: payload,
        confidence: f.confidence,
        sourceNodes: f.evidence,
        chatJid,
        companyId,
        audience,
        tier,
        source,
        reason: `extractor batch (${aggregated.length} facts)`,
      });
      counts[f.domain] = (counts[f.domain] || 0) + 1;
    } catch (e) {
      console.warn(`[Extractor] upsert failed for ${f.domain}/${f.slot}: ${e.message}`);
    }
  }
  return counts;
}

// ============================================================
// HIGH-LEVEL API
// ============================================================

/**
 * Run extraction over a list of nodes, in batches. Returns a summary
 * { batches, factsExtracted, factsWritten, byDomain }.
 *
 * @param {Array<MemoryNode>} nodes
 * @param {object} options
 *   batchSize     — default 25
 *   model         — default Haiku
 *   useSonnetFor  — set of domains where the second-pass refines via Sonnet
 *                   (currently unused — second pass arrives in Phase 0.1)
 *   dryRun        — extract but don't write
 *   verbose       — log per-batch
 *   onBatchDone   — callback({ index, totalBatches, facts, written })
 */
async function extractNodes(nodes, options = {}) {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    model = HAIKU_MODEL,
    dryRun = false,
    verbose = false,
    onBatchDone = null,
    subjects = DEFAULT_SUBJECTS,
    slotPrefix = '',
    extraScope = null,
    source = 'extraction',
  } = options;

  // Multi-subject mode requires the subject field on every emitted fact so
  // we can disambiguate which speaker each fact is about. The aggregator
  // composes `${slotPrefix}${subject}-${baseSlot}` to keep slots unique.
  const includeSubject = Array.isArray(subjects) && subjects.length > 1;

  const batches = [];
  for (let i = 0; i < nodes.length; i += batchSize) {
    batches.push(nodes.slice(i, i + batchSize));
  }

  let totalRaw = 0;
  let totalWritten = 0;
  const byDomainTotal = {};
  for (const dom of persona.DOMAINS) byDomainTotal[dom] = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const t0 = Date.now();
    const rawFacts = await extractBatch(batch, { model, verbose, subjects });
    const aggregated = aggregate(rawFacts, { slotPrefix, includeSubject });
    const counts = await writeFacts(aggregated, {
      dryRun,
      source,
      ...(extraScope || {}),
    });
    const elapsed = Date.now() - t0;

    for (const dom of persona.DOMAINS) byDomainTotal[dom] += counts[dom];
    totalRaw += rawFacts.length;
    const writtenInBatch = Object.values(counts).reduce((a, b) => a + b, 0);
    totalWritten += writtenInBatch;

    console.log(
      `[Extractor] batch ${i + 1}/${batches.length}: nodes=${batch.length} raw=${rawFacts.length} agg=${aggregated.length} written=${writtenInBatch} in ${elapsed}ms`
    );
    if (onBatchDone) {
      try {
        onBatchDone({
          index: i,
          totalBatches: batches.length,
          facts: rawFacts.length,
          written: writtenInBatch,
        });
      } catch (cbErr) {
        console.warn(`[Extractor] onBatchDone threw: ${cbErr.message}`);
      }
    }
  }

  return {
    batches: batches.length,
    factsExtractedRaw: totalRaw,
    factsWritten: totalWritten,
    byDomain: byDomainTotal,
  };
}

/**
 * Convenience: pull N most recent nodes and extract from them. Useful for
 * incremental updates (Phase 0+) — caller passes `since` cutoff.
 *
 * @param {object} options
 *   since         — Date; pull nodes with createdAt >= this
 *   limit         — max nodes (default 200)
 *   types         — node types to include (default all except 'log' and 'system')
 *   minWeight     — drop low-weight noise (default 0.2)
 *   ...passes through extractNodes options
 */
async function extractRecent(options = {}) {
  const {
    since = null,
    limit = 200,
    types = null,
    minWeight = 0.2,
    ...rest
  } = options;

  const where = {
    weight: { gte: minWeight },
  };
  if (since) where.createdAt = { gte: since };
  if (types && types.length) where.type = { in: types };

  const nodes = await prisma.memoryNode.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      content: true,
      tags: true,
      subjects: true,
      audience: true,
      createdAt: true,
      chatJid: true,
    },
  });

  if (nodes.length === 0) {
    return { batches: 0, factsExtractedRaw: 0, factsWritten: 0, byDomain: {} };
  }

  console.log(`[Extractor] extractRecent: pulled ${nodes.length} nodes (since=${since?.toISOString() || 'beginning'})`);
  return extractNodes(nodes, rest);
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  extractBatch,
  aggregate,
  writeFacts,
  extractNodes,
  extractRecent,
  // exposed for tests / scripts
  _internals: {
    extractJsonArray,
    normaliseSlot,
    truncateContent,
    renderBatch,
    SYSTEM_PROMPT,
    HAIKU_MODEL,
    SONNET_MODEL,
    SONNET_PROMOTION_DOMAINS,
  },
};
