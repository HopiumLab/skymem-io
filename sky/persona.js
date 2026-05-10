/**
 * Persona retrieval — Phase 0 (2026-05-08).
 *
 * Query-time API over PersonaFact rows. Used by sky/index.js#buildContext
 * (augment pattern) to surface structured persona facts alongside graph
 * retrieval. Cheap (O(1) on slot lookup; small DB scan on domain query).
 *
 * Domain set (v1, 7 domains):
 *   identity     — biography, family, location, values, voice
 *   portfolio    — companies, projects, ownership, active vs parked
 *   active       — what's in flight THIS WEEK; blockers, deadlines
 *   people       — relationships (Person A, Person E, Person B, Person C, Nick, Person D, etc)
 *   decisions    — recent + standing decisions
 *   preferences  — voice, workflow, energy patterns, anti-patterns
 *   goals        — OKRs, multi-tier (life / year / quarter / week)
 *
 * Plus connector references (NOT stored in persona — FK only):
 *   financial    → <separate-project>
 *   calendar     → Google Calendar
 *   health       → Polar / wearable (Phase 4+)
 *
 * Design ref: docs/persona-layer-design.md + docs/persona-layer-vNext.md
 */

import prisma from './prisma-client.js';

export const DOMAINS = Object.freeze([
  'identity',
  'portfolio',
  'active',
  'people',
  'decisions',
  'preferences',
  'goals',
]);

const VALID_DOMAINS = new Set(DOMAINS);

/**
 * Lookup a single fact by exact (domain, slot). O(1) via the unique index.
 *
 * @param {string} domain — must be in DOMAINS
 * @param {string} slot   — sub-key within domain
 * @returns {Promise<PersonaFact|null>}
 */
async function getFact(domain, slot) {
  if (!VALID_DOMAINS.has(domain)) return null;
  if (!slot) return null;
  try {
    return await prisma.personaFact.findUnique({
      where: { domain_slot: { domain, slot } },
    });
  } catch (e) {
    console.warn(`[Persona] getFact(${domain}/${slot}) failed: ${e.message}`);
    return null;
  }
}

/**
 * List all facts in a domain, optionally filtered by scope. Used when the
 * intent classifier hints a domain but doesn't have a specific slot.
 *
 * Filters out superseded facts (validUntil < now) by default.
 *
 * @param {string} domain
 * @param {object} [options]
 *   limit       — max rows (default 12)
 *   minConfidence — drop facts below this confidence (default 0.3)
 *   scope       — request scope; persona is mostly ross-only/global so
 *                 most filters are no-ops, but companyId narrows portfolio
 *   includeSuperseded — default false
 * @returns {Promise<PersonaFact[]>}
 */
async function getDomainFacts(domain, options = {}) {
  if (!VALID_DOMAINS.has(domain)) return [];
  const {
    limit = 12,
    minConfidence = 0.3,
    scope = null,
    includeSuperseded = false,
  } = options;

  const where = {
    domain,
    confidence: { gte: minConfidence },
  };
  if (!includeSuperseded) {
    where.OR = [{ validUntil: null }, { validUntil: { gt: new Date() } }];
  }
  // Persona is mostly ross-only/global — scope filter rarely narrows.
  // The exception: portfolio sub-records that carry a companyId tighten
  // when the request scope has a companyId match.
  if (scope?.companyId && domain === 'portfolio') {
    where.OR = [
      ...(where.OR || []),
      { companyId: scope.companyId },
      { companyId: null }, // global portfolio facts always pass
    ];
  }

  try {
    return await prisma.personaFact.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
  } catch (e) {
    console.warn(`[Persona] getDomainFacts(${domain}) failed: ${e.message}`);
    return [];
  }
}

/**
 * Retrieve persona facts relevant to the current query.
 *
 * Strategy:
 *   1. If `domainHints` provided (from intent classifier), pull from each
 *   2. If `slotHints` provided (from keyword extraction — proper nouns
 *      that match known slots like 'marie' / 'project-a'), prioritise
 *      direct slot lookups
 *   3. Always include a small slice of identity + active (Sky's current-state
 *      grounding — present in every prompt)
 *
 * Returns ranked persona facts. Caller (buildContext) folds them into the
 * union before reranking.
 *
 * @param {string} message — the user's current message (for logging)
 * @param {object} options
 *   domainHints  — string[] from intent classifier (e.g. ['people', 'active'])
 *   slotHints    — string[] candidate slot names extracted from message
 *   scope        — request scope
 *   limit        — max facts returned (default 10)
 * @returns {Promise<Array<{id, domain, slot, facts, confidence, sourceNodes, updatedAt}>>}
 */
async function retrieveForQuery(message, options = {}) {
  const { domainHints = [], slotHints = [], scope = null, limit = 10 } = options;
  const out = new Map(); // id → fact (dedupe)

  // Step 1: direct slot hits (highest precision)
  if (slotHints.length > 0) {
    for (const domain of (domainHints.length ? domainHints : DOMAINS)) {
      for (const slot of slotHints) {
        const f = await getFact(domain, slot.toLowerCase());
        if (f) out.set(f.id, { ...f, _matchType: 'slot' });
      }
    }
  }

  // Step 2: domain-wide pulls for hinted domains
  for (const domain of domainHints) {
    if (!VALID_DOMAINS.has(domain)) continue;
    const facts = await getDomainFacts(domain, {
      limit: 4,
      scope,
    });
    for (const f of facts) {
      if (!out.has(f.id)) out.set(f.id, { ...f, _matchType: 'domain' });
    }
  }

  // Step 3: always include identity + active for grounding (Sky's
  // ambient awareness of who the user is + what's happening right now).
  // Cheap — these domains have at most a handful of facts each.
  if (!out.size || domainHints.length === 0) {
    const grounding = await Promise.all([
      getDomainFacts('identity', { limit: 2, scope }),
      getDomainFacts('active', { limit: 3, scope }),
    ]);
    for (const facts of grounding) {
      for (const f of facts) {
        if (!out.has(f.id)) out.set(f.id, { ...f, _matchType: 'grounding' });
      }
    }
  }

  // Rank: slot hits first, then domain hits, then grounding.
  // Within each tier: confidence × recency.
  const ranked = Array.from(out.values()).sort((a, b) => {
    const tierOrder = { slot: 0, domain: 1, grounding: 2 };
    if (tierOrder[a._matchType] !== tierOrder[b._matchType]) {
      return tierOrder[a._matchType] - tierOrder[b._matchType];
    }
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return ranked.slice(0, limit);
}

/**
 * Retrieve every persona fact for a specific chat scope. Used by the LOCOMO
 * bench (and any future multi-tenant scope) to grab the full persona block
 * for that scope without intent classification.
 *
 * Returns rows ordered by domain then confidence desc then updatedAt desc.
 *
 * @param {string} chatJid — exact match
 * @param {object} [options]
 *   minConfidence — drop low-conf facts (default 0.5)
 *   limit         — max rows (default 50)
 *   includeSuperseded — default false
 */
async function getFactsByChatJid(chatJid, options = {}) {
  if (!chatJid) return [];
  const {
    minConfidence = 0.5,
    limit = 50,
    includeSuperseded = false,
  } = options;
  const where = {
    chatJid,
    confidence: { gte: minConfidence },
  };
  if (!includeSuperseded) {
    where.OR = [{ validUntil: null }, { validUntil: { gt: new Date() } }];
  }
  try {
    return await prisma.personaFact.findMany({
      where,
      orderBy: [{ domain: 'asc' }, { confidence: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
  } catch (e) {
    console.warn(`[Persona] getFactsByChatJid(${chatJid}) failed: ${e.message}`);
    return [];
  }
}

/**
 * Render persona facts into a prompt-ready text block.
 * Caller injects this into the prompt under a `## YOUR PERSONA` heading.
 */
function buildPersonaBlock(facts) {
  if (!facts || facts.length === 0) return '';
  // Group by domain so the LLM sees structure
  const byDomain = {};
  for (const f of facts) {
    if (!byDomain[f.domain]) byDomain[f.domain] = [];
    byDomain[f.domain].push(f);
  }
  const lines = [];
  for (const domain of DOMAINS) {
    const facts = byDomain[domain];
    if (!facts || facts.length === 0) continue;
    lines.push(`### ${domain}`);
    for (const f of facts) {
      // Prefer the .text field of the JSON payload (extractor-shaped:
      // { text, evidence }) — falls back to JSON.stringify for arbitrary
      // shapes (manual upserts, future schema variants).
      let payload;
      if (f.facts && typeof f.facts === 'object' && typeof f.facts.text === 'string') {
        payload = f.facts.text;
      } else if (typeof f.facts === 'object') {
        payload = JSON.stringify(f.facts);
      } else {
        payload = String(f.facts);
      }
      lines.push(`- [${f.slot}] ${payload.slice(0, 320)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Upsert a persona fact. Used by the extractor + bootstrap script.
 *
 * Phase-1-ready: every write also produces a PersonaFactRevision record
 * for trajectory tracking. When Phase 1 ships its slope-computation
 * helpers, the revision history is already accumulating.
 */
async function upsertFact({
  domain,
  slot,
  facts,
  confidence = 0.7,
  sourceNodes = [],
  chatJid = null,
  companyId = null,
  audience = 'ross-only',
  tier = 'global',
  source = 'extraction', // for revision log
  reason = null,
}) {
  if (!VALID_DOMAINS.has(domain)) {
    throw new Error(`[Persona] invalid domain: ${domain}. Valid: ${DOMAINS.join(', ')}`);
  }
  if (!slot || typeof slot !== 'string') {
    throw new Error('[Persona] slot is required');
  }

  const data = {
    domain,
    slot,
    facts,
    confidence,
    sourceNodes,
    chatJid,
    companyId,
    audience,
    tier,
  };

  const upserted = await prisma.personaFact.upsert({
    where: { domain_slot: { domain, slot } },
    create: data,
    update: { facts, confidence, sourceNodes, updatedAt: new Date() },
  });

  // Append revision record (Phase 1 — trajectories)
  await prisma.personaFactRevision.create({
    data: {
      factId: upserted.id,
      payload: facts,
      confidence,
      source,
      reason,
    },
  });

  return upserted;
}

/**
 * Stats for the health dashboard.
 */
async function stats() {
  const total = await prisma.personaFact.count();
  const byDomain = await prisma.$queryRawUnsafe(
    `SELECT domain, COUNT(*) as n FROM PersonaFact GROUP BY domain ORDER BY n DESC`
  );
  const avgConfidence = await prisma.$queryRawUnsafe(
    `SELECT AVG(confidence) as avg FROM PersonaFact WHERE validUntil IS NULL OR validUntil > NOW()`
  );
  const revisions = await prisma.personaFactRevision.count();
  return {
    totalFacts: total,
    byDomain: byDomain.map(r => ({ domain: r.domain, count: Number(r.n) })),
    avgConfidence: avgConfidence[0]?.avg || 0,
    totalRevisions: revisions,
  };
}

export default {
  DOMAINS,
  getFact,
  getDomainFacts,
  getFactsByChatJid,
  retrieveForQuery,
  buildPersonaBlock,
  upsertFact,
  stats,
};
