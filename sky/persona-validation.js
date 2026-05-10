/**
 * Persona Self-Supervised Confidence Loop — Phase 3 (2026-05-10).
 *
 * Tracks the OUTCOME of every persona-fact-driven proposal Sky makes,
 * then adjusts the fact's confidence based on whether the user accepted /
 * rejected / edited / ignored the suggestion.
 *
 * The schema is already in place — `PersonaFactValidation` (see
 * prisma/schema.prisma):
 *   factId        — which fact was used
 *   proposalId    — the Sky outbound that used this fact
 *   outcome       — 'accepted' | 'rejected' | 'edited' | 'ignored'
 *   ...
 *
 * Pipeline:
 *   1. When Sky makes a proposal that uses one or more persona facts,
 *      record `factsUsed: [factId]` on the proposal.
 *   2. When the user responds (yes/no/edit/silence), classify the outcome.
 *   3. Write a PersonaFactValidation row.
 *   4. Nightly: aggregate validations per fact, adjust confidence:
 *      • accepted: small positive bump (+0.02)
 *      • rejected: large negative bump (-0.10)
 *      • edited:   small negative bump (-0.03), with the edited content
 *                  proposed as a revision
 *      • ignored:  decay (-0.01)
 *   5. Confidence floor 0.1 (don't drop facts below this — keep them
 *      visible for surfacing as "stale, was X").
 *
 * Cost: zero LLM. Pure DB aggregation. Runs nightly in <1s.
 *
 * Surface points (wiring TBD when Sky's chat path exposes proposalIds):
 *   • generateAnswer / proposal-builders pass `factsUsed: string[]`
 *   • An "outcome detector" classifies user's next message into the 4 outcomes
 *   • Manual flag: `!fact-correction <factId> <new-text>` for explicit edits
 */

import prisma from './prisma-client.js';

// ============================================================
// CONFIDENCE ADJUSTMENT WEIGHTS
// ============================================================

const OUTCOME_WEIGHTS = {
  accepted: +0.02,
  rejected: -0.10,
  edited:   -0.03,
  ignored:  -0.01,
};

const CONFIDENCE_FLOOR = 0.10;
const CONFIDENCE_CEIL  = 1.00;

// ============================================================
// RECORDING VALIDATIONS (called from chat path)
// ============================================================

/**
 * Record that a fact was used in a proposal. Called by the
 * generateAnswer / proposal-builder when persona facts hit the prompt.
 *
 * @param {object} args
 *   factId       — PersonaFact.id (required)
 *   proposalId   — Sky outbound id (required)
 *   outcome      — 'accepted' | 'rejected' | 'edited' | 'ignored' (default 'ignored')
 *   evidence     — optional context for debugging
 */
async function recordValidation(args) {
  const { factId, proposalId, outcome = 'ignored', evidence = null } = args;
  if (!factId || !proposalId) {
    throw new Error('[Validation] factId + proposalId required');
  }
  if (!OUTCOME_WEIGHTS.hasOwnProperty(outcome)) {
    throw new Error(`[Validation] invalid outcome: ${outcome}. Valid: ${Object.keys(OUTCOME_WEIGHTS).join(', ')}`);
  }
  return prisma.personaFactValidation.create({
    data: {
      factId,
      proposalId,
      outcome,
      evidence: evidence || null,
    },
  });
}

/**
 * Mark a recorded validation's outcome retroactively. Used when the
 * outcome is detected from a later message rather than synchronously.
 */
async function updateValidationOutcome(validationId, outcome, evidence = null) {
  if (!OUTCOME_WEIGHTS.hasOwnProperty(outcome)) {
    throw new Error(`[Validation] invalid outcome: ${outcome}`);
  }
  return prisma.personaFactValidation.update({
    where: { id: validationId },
    data: { outcome, evidence: evidence || undefined, updatedAt: new Date() },
  });
}

// ============================================================
// NIGHTLY CONFIDENCE ADJUSTMENT
// ============================================================

/**
 * Aggregate recent validations per fact and adjust confidence accordingly.
 * Run nightly. Cheap — pure SQL aggregation + Prisma updates.
 *
 * @param {object} options
 *   sinceDays — only consider validations newer than this (default 7)
 *   dryRun    — log what would change without writing
 */
async function adjustConfidences(options = {}) {
  const { sinceDays = 7, dryRun = false } = options;
  const since = new Date(Date.now() - sinceDays * 86400000);

  // Pull all validations in window grouped by factId
  const rows = await prisma.$queryRawUnsafe(`
    SELECT factId,
           SUM(CASE WHEN outcome='accepted' THEN 1 ELSE 0 END) as n_accepted,
           SUM(CASE WHEN outcome='rejected' THEN 1 ELSE 0 END) as n_rejected,
           SUM(CASE WHEN outcome='edited'   THEN 1 ELSE 0 END) as n_edited,
           SUM(CASE WHEN outcome='ignored'  THEN 1 ELSE 0 END) as n_ignored
    FROM PersonaFactValidation
    WHERE createdAt >= ?
    GROUP BY factId
  `, since);

  let updated = 0;
  let totalDelta = 0;
  const adjustments = [];
  for (const r of rows) {
    const factId = r.factId;
    const delta =
      Number(r.n_accepted) * OUTCOME_WEIGHTS.accepted +
      Number(r.n_rejected) * OUTCOME_WEIGHTS.rejected +
      Number(r.n_edited)   * OUTCOME_WEIGHTS.edited +
      Number(r.n_ignored)  * OUTCOME_WEIGHTS.ignored;

    if (Math.abs(delta) < 0.001) continue;

    const fact = await prisma.personaFact.findUnique({ where: { id: factId }, select: { confidence: true, domain: true, slot: true } });
    if (!fact) continue;
    const newConf = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEIL, fact.confidence + delta));

    adjustments.push({
      factId, domain: fact.domain, slot: fact.slot,
      oldConf: fact.confidence, newConf,
      counts: {
        a: Number(r.n_accepted), r: Number(r.n_rejected),
        e: Number(r.n_edited),   i: Number(r.n_ignored),
      },
      delta,
    });

    if (!dryRun) {
      await prisma.personaFact.update({
        where: { id: factId },
        data: { confidence: newConf, updatedAt: new Date() },
      });
      // Append a revision so the trajectory math sees the confidence shift.
      await prisma.personaFactRevision.create({
        data: {
          factId,
          payload: { confidenceAdjustment: delta, source: 'self-supervised' },
          confidence: newConf,
          source: 'self-supervised',
          reason: `validations: ${Number(r.n_accepted)}a/${Number(r.n_rejected)}r/${Number(r.n_edited)}e/${Number(r.n_ignored)}i`,
        },
      });
    }
    updated++;
    totalDelta += delta;
  }

  return { factsAdjusted: updated, totalDelta, adjustments, dryRun };
}

// ============================================================
// HEURISTIC OUTCOME CLASSIFIER (for the chat path)
// ============================================================

/**
 * Cheap heuristic to classify the user's response message as an outcome.
 * Used inline by the chat path when a proposal was made and the user replies
 * within a window. The 'edited' detection is the trickiest — relies on
 * the user repeating the proposal verbatim with edits OR explicitly saying
 * "no, it was X".
 *
 * Returns 'accepted' | 'rejected' | 'edited' | 'ignored' | null (no signal).
 *
 * Wire from sky/index.js when a chat turn references a proposalId with
 * factsUsed[].
 */
function classifyOutcome(userMessage, proposal = null) {
  if (!userMessage) return 'ignored';
  const m = userMessage.toLowerCase().trim();

  // Acceptance signals
  if (/^(yes|yep|yeah|yup|do it|go for it|sounds good|perfect|nice|sure|ok|okay|cheers|nailed it|spot on|exactly|👍|✅)\b/i.test(m)) return 'accepted';
  if (/^(thanks|thank you|cheers)\b/i.test(m) && m.length < 30) return 'accepted';

  // Rejection signals
  if (/^(no|nah|nope|don'?t|wrong|incorrect|not right|that'?s wrong|👎|❌)\b/i.test(m)) return 'rejected';
  if (/\bthat'?s (not right|wrong|incorrect)\b/i.test(m)) return 'rejected';

  // Edit signals — user gives a corrected version
  if (/\b(actually|it'?s actually|it should be|correction|let me correct|to be precise)\b/i.test(m)) return 'edited';
  if (/^(no,?\s+(it'?s|was|is)|actually,?\s+)/i.test(m)) return 'edited';

  // Default: ignored if they didn't engage with the proposal at all
  return 'ignored';
}

// ============================================================
// IN-MEMORY PENDING-VALIDATION QUEUE (chat-path wiring, 2026-05-10)
// ============================================================
//
// When Sky responds in chat using persona facts, we want to record the
// validation when the user replies. Production design would persist this
// in a Proposal table; v1 wiring is in-memory keyed by chatJid for
// simplicity. Lossy on restart but proves the architecture.
//
// Window: keep pending entries for 30 minutes. After that, classify as
// 'ignored' and flush.

const _pending = new Map(); // chatJid → { proposalId, factsUsed, expectedAt }
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Record that Sky just made a chat response that used persona facts.
 * Called from the chat path right after generateAnswer succeeds.
 *
 * @param {object} args
 *   chatJid     — origin chat
 *   proposalId  — unique id for the response (e.g. Sky message id)
 *   factsUsed   — array of PersonaFact ids whose content went into the prompt
 */
function recordPendingProposal({ chatJid, proposalId, factsUsed }) {
  if (!chatJid || !proposalId || !Array.isArray(factsUsed) || factsUsed.length === 0) return;
  _pending.set(chatJid, {
    proposalId,
    factsUsed,
    expectedAt: Date.now() + PENDING_TTL_MS,
  });
}

/**
 * Resolve the pending proposal for a chatJid based on the user's next
 * message. Called from the chat path when the user replies. Records
 * one PersonaFactValidation per fact in the proposal.
 *
 * @param {string} chatJid
 * @param {string} userMessage  — the user's next message
 * @returns {Promise<{outcome: string, factsResolved: number} | null>}
 */
async function resolvePendingFromUserMessage(chatJid, userMessage) {
  const pending = _pending.get(chatJid);
  if (!pending) return null;

  // TTL check — stale entries get flushed as 'ignored'
  if (Date.now() > pending.expectedAt) {
    _pending.delete(chatJid);
    for (const factId of pending.factsUsed) {
      await recordValidation({
        factId, proposalId: pending.proposalId, outcome: 'ignored',
      }).catch(() => {});
    }
    return { outcome: 'ignored', factsResolved: pending.factsUsed.length, stale: true };
  }

  const outcome = classifyOutcome(userMessage);
  _pending.delete(chatJid);
  let resolved = 0;
  for (const factId of pending.factsUsed) {
    try {
      await recordValidation({ factId, proposalId: pending.proposalId, outcome });
      resolved++;
    } catch (_) { /* skip */ }
  }
  return { outcome, factsResolved: resolved };
}

/**
 * Flush stale pending entries. Run periodically (e.g. nightly cron, but
 * the TTL check on resolve already handles inline).
 */
async function flushStalePending() {
  const now = Date.now();
  let flushed = 0;
  for (const [chatJid, pending] of _pending.entries()) {
    if (now > pending.expectedAt) {
      for (const factId of pending.factsUsed) {
        await recordValidation({
          factId, proposalId: pending.proposalId, outcome: 'ignored',
        }).catch(() => {});
      }
      _pending.delete(chatJid);
      flushed++;
    }
  }
  return { flushed };
}

export default {
  recordValidation,
  updateValidationOutcome,
  adjustConfidences,
  classifyOutcome,
  recordPendingProposal,
  resolvePendingFromUserMessage,
  flushStalePending,
  OUTCOME_WEIGHTS,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CEIL,
};
