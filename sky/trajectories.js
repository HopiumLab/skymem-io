/**
 * Trajectories — Phase 1 (2026-05-09).
 *
 * Compute slope/velocity/inflection over PersonaFactRevision histories so
 * Sky can say "the user's energy on <separate-project> is rising" / "Person A engagement is
 * cooling" instead of just "current state is X".
 *
 * Design ref: docs/persona-layer-vNext.md (Trajectories — Phase 1).
 *
 * Phase 0 plumbing already wires the revision log: every persona.upsertFact
 * appends a PersonaFactRevision row. So by the time Phase 1 runs, history
 * is already accumulated. This module reads, doesn't write.
 *
 * What we compute per fact:
 *   - confidenceSlope    — Δconfidence per day (linear fit over revisions)
 *   - confidenceVelocity — most-recent Δconfidence (last 2 revisions)
 *   - changeCount        — distinct text changes (semantic shifts in payload.text)
 *   - state              — 'rising' | 'declining' | 'stable' | 'volatile' | 'new'
 *   - firstSeen / lastSeen
 *
 * Surfaceable as annotations on the persona block, e.g.
 *   - [marie] Person A has 28 airlines under her... (↑ rising, +0.15 over 14d)
 *
 * Cheap: O(R) per fact where R = revisions count. For the user's bootstrap,
 * facts have 1-2 revisions each so it's effectively O(1).
 */

import prisma from './prisma-client.js';

// ============================================================
// CONFIG
// ============================================================

// Minimum revisions to be eligible for trajectory analysis. Below this,
// we just say 'new' (no history to slope over).
const MIN_REVISIONS_FOR_SLOPE = 2;

// Slope thresholds (Δconfidence per day).
// Below |0.005/day| → noise; range 0.005-0.02 → drift; >0.02 → directional.
const STABLE_SLOPE_THRESHOLD = 0.005;
const STRONG_SLOPE_THRESHOLD = 0.02;

// Volatility: if changeCount/revisions > this ratio, the fact is volatile
// (text keeps changing) regardless of slope.
const VOLATILITY_RATIO = 0.5;

// ============================================================
// CORE
// ============================================================

/**
 * Compute trajectory metrics for a single PersonaFact id.
 *
 * Returns:
 *   {
 *     factId,
 *     revisions: [{createdAt, confidence, textHash}],
 *     confidenceSlope,        // per-day linear fit
 *     confidenceVelocity,     // last delta (most recent change)
 *     changeCount,            // distinct payload-text shifts
 *     volatility,             // changeCount / revisions
 *     state,                  // see thresholds above
 *     daysSpan,               // calendar days between first and last revision
 *     firstSeen, lastSeen,
 *     summary,                // human string ("rising +0.04/day over 14d")
 *   }
 *
 * Returns null if the fact doesn't exist or has zero revisions.
 *
 * @param {string} factId
 */
async function computeTrajectory(factId) {
  if (!factId) return null;

  const revisions = await prisma.personaFactRevision.findMany({
    where: { factId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, confidence: true, payload: true, source: true, reason: true },
  });

  if (revisions.length === 0) return null;

  const points = revisions.map(r => ({
    t: new Date(r.createdAt).getTime(),
    confidence: r.confidence,
    textHash: hashText(extractText(r.payload)),
    raw: r,
  }));

  const firstSeen = new Date(points[0].t);
  const lastSeen = new Date(points[points.length - 1].t);
  const daysSpan = Math.max(1, (lastSeen - firstSeen) / 86400000);

  // Distinct text shifts — count adjacent pairs whose text hash differs.
  let changeCount = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].textHash !== points[i - 1].textHash) changeCount++;
  }
  const volatility = changeCount / Math.max(1, points.length - 1);

  // Velocity = last revision delta in confidence
  const confidenceVelocity = points.length >= 2
    ? points[points.length - 1].confidence - points[points.length - 2].confidence
    : 0;

  // Slope (per-day) via linear regression on (t_days, confidence).
  // Days normalised so coefficients are interpretable.
  let confidenceSlope = 0;
  if (points.length >= MIN_REVISIONS_FOR_SLOPE) {
    const xs = points.map(p => (p.t - points[0].t) / 86400000); // days from first
    const ys = points.map(p => p.confidence);
    confidenceSlope = linearSlope(xs, ys);
  }

  // State classification
  let state;
  if (points.length < MIN_REVISIONS_FOR_SLOPE) {
    state = 'new';
  } else if (volatility >= VOLATILITY_RATIO) {
    state = 'volatile';
  } else if (Math.abs(confidenceSlope) < STABLE_SLOPE_THRESHOLD) {
    state = 'stable';
  } else if (confidenceSlope > 0) {
    state = 'rising';
  } else {
    state = 'declining';
  }

  const summary = buildSummary(state, confidenceSlope, daysSpan, points.length, changeCount);

  return {
    factId,
    revisions: points.map(p => ({
      createdAt: new Date(p.t).toISOString(),
      confidence: p.confidence,
      textHash: p.textHash,
      source: p.raw.source,
    })),
    revisionCount: points.length,
    confidenceSlope,
    confidenceVelocity,
    changeCount,
    volatility,
    state,
    daysSpan,
    firstSeen: firstSeen.toISOString(),
    lastSeen: lastSeen.toISOString(),
    summary,
  };
}

/**
 * Linear least-squares slope of (xs, ys). Returns 0 if degenerate.
 */
function linearSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return 0;
  return num / den;
}

/**
 * Hash a string to a short stable key — used to detect text changes
 * between revisions without storing full text twice. djb2 variant.
 */
function hashText(s) {
  if (!s) return '0';
  let h = 5381;
  const max = Math.min(s.length, 1024); // 1024-char prefix is plenty for fact text
  for (let i = 0; i < max; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Pull text from a PersonaFactRevision payload — payload is JSON
 * { text, evidence } per the extractor; older or manual writes may have
 * arbitrary shape.
 */
function extractText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && typeof payload.text === 'string') return payload.text;
  try { return JSON.stringify(payload); } catch (_) { return ''; }
}

/**
 * Build a one-line human description of the trajectory.
 */
function buildSummary(state, slope, daysSpan, revCount, changeCount) {
  const days = Math.round(daysSpan);
  switch (state) {
    case 'new':
      return 'first observation';
    case 'stable':
      return `stable over ${days}d (${revCount} revisions)`;
    case 'rising':
      return `↑ rising +${(slope * days).toFixed(2)} over ${days}d`;
    case 'declining':
      return `↓ declining ${(slope * days).toFixed(2)} over ${days}d`;
    case 'volatile':
      return `volatile (${changeCount} text shifts in ${revCount} revisions)`;
    default:
      return state;
  }
}

// ============================================================
// HIGH-LEVEL HELPERS
// ============================================================

/**
 * Get the trajectory for a (domain, slot). Convenience wrapper.
 */
async function getTrajectoryFor(domain, slot) {
  const fact = await prisma.personaFact.findUnique({
    where: { domain_slot: { domain, slot } },
    select: { id: true },
  });
  if (!fact) return null;
  return computeTrajectory(fact.id);
}

/**
 * Find facts whose trajectory state matches a filter. Used by the
 * proactivity layer (Sky surfacing "X is changing"). Cheap on small
 * fact counts; for large catalogs we'd cache state at write time.
 *
 * @param {object} options
 *   states     — string[] of states to include (default: ['rising', 'declining'])
 *   minSlopeMag — drop slopes weaker than this (default 0.01/day)
 *   limit      — max results (default 20)
 *   chatJid    — narrow to a scope (default null = all)
 */
async function getInterestingTrajectories(options = {}) {
  const {
    states = ['rising', 'declining'],
    minSlopeMag = 0.01,
    limit = 20,
    chatJid = null,
  } = options;

  // Pull only facts that actually have ≥2 revisions — saves O(N)
  // computeTrajectory calls. We do this via a count subquery; rather
  // than write raw SQL (Prisma's groupBy on a relation count is awkward),
  // grab fact ids that appear in ≥2 PersonaFactRevision rows.
  const candidates = await prisma.$queryRawUnsafe(
    `SELECT factId FROM PersonaFactRevision GROUP BY factId HAVING COUNT(*) >= 2 LIMIT ${Math.min(limit * 5, 200)}`
  );
  const factIds = candidates.map(r => r.factId);
  if (factIds.length === 0) return [];

  // Optional scope filter
  let allowedIds = new Set(factIds);
  if (chatJid) {
    const scoped = await prisma.personaFact.findMany({
      where: { id: { in: factIds }, chatJid },
      select: { id: true },
    });
    allowedIds = new Set(scoped.map(f => f.id));
  }

  const results = [];
  for (const fid of factIds) {
    if (!allowedIds.has(fid)) continue;
    const traj = await computeTrajectory(fid);
    if (!traj) continue;
    if (!states.includes(traj.state)) continue;
    if (Math.abs(traj.confidenceSlope) < minSlopeMag && traj.state !== 'volatile') continue;
    results.push(traj);
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Annotate a list of PersonaFact rows with their trajectory state. Used
 * to enrich the prompt block — add `(↑ rising)` after the slot label.
 *
 * @param {Array<PersonaFact>} facts
 * @returns {Array<PersonaFact & { trajectory: object }>}
 */
async function annotateFacts(facts) {
  if (!facts || facts.length === 0) return [];
  const annotated = [];
  for (const f of facts) {
    const traj = await computeTrajectory(f.id);
    annotated.push({ ...f, trajectory: traj });
  }
  return annotated;
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  computeTrajectory,
  getTrajectoryFor,
  getInterestingTrajectories,
  annotateFacts,
  // for tests
  _internals: {
    linearSlope,
    hashText,
    extractText,
    buildSummary,
    STABLE_SLOPE_THRESHOLD,
    STRONG_SLOPE_THRESHOLD,
    VOLATILITY_RATIO,
  },
};
