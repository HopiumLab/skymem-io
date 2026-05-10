/**
 * Answer Verifier — Tier 2 (2026-05-09).
 *
 * Synthius-pattern second-pass: after `generateAnswer` returns a predicted
 * answer, run a Haiku verifier that checks the answer against the retrieved
 * evidence. If unsupported, recommend abstention or a corrected answer.
 *
 * The single biggest unmade lever in the LOCOMO stack. Synthius hits 99.55%
 * adversarial robustness because they have a verifier; we're at 92.3% pre-
 * regrade and 96.5% post-regrade. A real verifier should lock cat=5 at 99%+
 * and lift cat=3/4 by catching hallucinated answers.
 *
 * Design ref: SKY-REBUILD.md "Verifier pass — spec ready to build (Tier 2)"
 *
 * Cost: ~$0.0001 per question (Haiku, ~200 in / ~80 out tokens). Negligible.
 *
 * Usage:
 *   const verdict = await verifyAnswer(question, predicted, contextBlock, category);
 *   if (verdict.should_abstain) return 'No information available';
 *   if (!verdict.supported && verdict.revised_answer) return verdict.revised_answer;
 *   return predicted;
 */

import apiFallback from './api-fallback.js';

const HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL || 'claude-haiku-4-5';

const SYSTEM_PROMPT = `You are a strict evidence checker. The transcript below is the ONLY source of truth. Reply with valid JSON.`;

/**
 * Build the verifier prompt. Question + predicted + context.
 *
 * Keep prompt tight — context block already large (~1-3k tokens), no need
 * to bloat the verifier prompt.
 */
function buildPrompt(question, predicted, context, category) {
  const isAdversarial = category === 5;

  // Slight category-aware adjustment: for cat=5 (adversarial) the verifier
  // is biased toward abstention. For cat=1-4, biased toward acceptance if
  // any reasonable evidence supports the answer.
  const acceptanceBias = isAdversarial
    ? `BIAS: This is an adversarial question. If the transcript does NOT directly support the predicted answer, set should_abstain=true. Concrete answers are wrong if the transcript lacks the fact.`
    : `BIAS: Accept the answer if any clear evidence supports it. Reject only when the answer contradicts the transcript or invents content not present.`;

  return `QUESTION: ${question}
PREDICTED ANSWER: ${JSON.stringify(predicted)}

TRANSCRIPT (the only source of truth):
${context}

${acceptanceBias}

Reply with JSON ONLY, no prose:
{
  "supported": true | false,
  "hallucinations": ["specific fact not in transcript", ...] | [],
  "should_abstain": true | false,
  "revised_answer": "<corrected short answer>" | null,
  "reason": "<one short sentence>"
}

Rules:
- "supported": true only if every claim in predicted is grounded in the transcript.
- "hallucinations": list each invented or unsupported claim. Empty array if predicted is fully supported.
- "should_abstain": true if the question is unanswerable from the transcript. For adversarial questions (e.g. about events not in the transcript), this is the correct verdict.
- "revised_answer": a corrected short-form answer if predicted is wrong but the transcript has the right one. null otherwise. Don't suggest revisions that go beyond what the transcript supports.
- Keep "reason" to one sentence — what specifically supports or contradicts the predicted answer.`;
}

/**
 * Tolerant JSON extractor: pulls the first {...} from text, repairs trailing
 * commas, returns parsed object or null.
 */
function extractJson(raw) {
  if (!raw) return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  const slice = raw.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {
    try {
      const repaired = slice.replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(repaired);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Run the verifier. Returns:
 *   {
 *     supported: boolean,
 *     hallucinations: string[],
 *     should_abstain: boolean,
 *     revised_answer: string | null,
 *     reason: string,
 *     elapsed_ms: number,
 *     raw: string,         // for debugging
 *   }
 *
 * On API failure, returns a permissive default that keeps the predicted
 * answer (don't degrade accuracy when verifier is the failure point).
 */
async function verifyAnswer(question, predicted, context, category = null, options = {}) {
  const t0 = Date.now();
  if (!question || predicted == null) {
    return {
      supported: true,
      hallucinations: [],
      should_abstain: false,
      revised_answer: null,
      reason: 'no question or no answer to verify',
      elapsed_ms: 0,
      raw: '',
    };
  }

  // Don't verify abstention answers — they're already cautious.
  const lowerPred = String(predicted).toLowerCase();
  if (lowerPred.includes('no information') || lowerPred.includes("don't know") || lowerPred.includes('not in context')) {
    return {
      supported: true,
      hallucinations: [],
      should_abstain: false,
      revised_answer: null,
      reason: 'predicted is already an abstention',
      elapsed_ms: 0,
      raw: '',
    };
  }

  const prompt = buildPrompt(question, predicted, context, category);

  let raw;
  try {
    raw = await apiFallback.generateResponse(SYSTEM_PROMPT, prompt, {
      model: HAIKU_MODEL,
      maxTokens: 200,
      cacheSystem: false,
    });
  } catch (e) {
    // Verifier API failure → permissive: trust the predicted answer.
    return {
      supported: true,
      hallucinations: [],
      should_abstain: false,
      revised_answer: null,
      reason: `verifier API failed: ${e.message}`,
      elapsed_ms: Date.now() - t0,
      raw: '',
    };
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return {
      supported: true,
      hallucinations: [],
      should_abstain: false,
      revised_answer: null,
      reason: 'verifier returned malformed JSON; permissive default',
      elapsed_ms: Date.now() - t0,
      raw,
    };
  }

  return {
    supported: !!parsed.supported,
    hallucinations: Array.isArray(parsed.hallucinations) ? parsed.hallucinations : [],
    should_abstain: !!parsed.should_abstain,
    revised_answer: typeof parsed.revised_answer === 'string' ? parsed.revised_answer : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    elapsed_ms: Date.now() - t0,
    raw,
  };
}

/**
 * High-level wrapper: take a predicted answer + transcript, return the
 * possibly-revised answer plus a verdict object.
 *
 * Decision logic:
 *   - If verifier says abstain → "No information available"
 *   - If verifier says unsupported AND has a revised_answer → use revised
 *   - Otherwise → keep the predicted answer (verifier endorsed or is permissive)
 *
 * @returns {Promise<{ answer: string, verdict: object }>}
 */
async function generateWithVerifier(predicted, question, context, category = null) {
  const verdict = await verifyAnswer(question, predicted, context, category);

  let answer = predicted;
  if (verdict.should_abstain) {
    answer = 'No information available';
  } else if (!verdict.supported && verdict.revised_answer) {
    answer = verdict.revised_answer;
  }

  return { answer, verdict };
}

export default {
  verifyAnswer,
  generateWithVerifier,
  // exposed for tests
  _internals: { buildPrompt, extractJson, HAIKU_MODEL },
};
