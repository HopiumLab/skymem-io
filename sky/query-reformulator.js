/**
 * Query Reformulator — Tier 3 (2026-05-09).
 *
 * When initial retrieval returns evidence that the answer-generator labels
 * "No information available", rephrase the question and retry. Catches
 * retrieval misses caused by vocabulary mismatch between the dataset's
 * question wording and the speaker's actual wording in the transcript.
 *
 * Example:
 *   Q: "What kind of pot did Mel and her kids make with clay?"
 *   Speaker said: "We made a cup with a dog face on it"
 *   Initial retrieval missed because "pot" / "clay" didn't surface the
 *   "cup with dog face" turn. Reformulation: "What clay item / object did
 *   Mel and her kids create together?" → matches more turns.
 *
 * Cost: one Haiku call per reformulation (~$0.0001). Only fires when
 * initial answer was abstention. Probably ~10-15% of questions.
 *
 * Expected lift: +2-4pp on cat=4 (open-domain) — half of cat=4's "No info"
 * failures are vocabulary mismatches.
 */

import apiFallback from './api-fallback.js';

const HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL || 'claude-haiku-4-5';

/**
 * Reformulate a question into 2-3 alternative phrasings that might match
 * different speaker vocabulary in the transcript. Returns array of strings.
 *
 * Uses generic vocabulary expansion — the LLM doesn't see the transcript
 * (we want it to think about generic synonyms / paraphrasings, not anchor
 * to the existing failed retrieval).
 */
async function reformulate(question, options = {}) {
  const { maxAlternatives = 3 } = options;
  if (!question) return [];

  const prompt = `The user asked a question that retrieval failed to answer. Rephrase the question into ${maxAlternatives} alternative wordings that might match different vocabulary the answer-source uses.

ORIGINAL QUESTION: ${JSON.stringify(question)}

Reply with JSON ONLY:
{
  "alternatives": [
    "<alternative 1>",
    "<alternative 2>",
    ...
  ]
}

Rules:
- Keep alternatives semantically equivalent (same answer should satisfy each).
- Vary vocabulary — use synonyms / paraphrases, not the same words.
- Vary structure — e.g. swap "What X" with "Which X" or "Tell me about the X".
- For specific nouns ("pot" / "speech" / "trip"), include broader synonyms ("item" / "talk" / "journey").
- Don't add details not in the original question.`;

  let raw;
  try {
    raw = await apiFallback.generateResponse(
      'You rewrite questions to vary vocabulary while preserving meaning. Reply with valid JSON only.',
      prompt,
      { model: HAIKU_MODEL, maxTokens: 200, cacheSystem: false },
    );
  } catch (e) {
    return [];
  }

  if (!raw) return [];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (Array.isArray(parsed.alternatives)) {
      return parsed.alternatives
        .filter(s => typeof s === 'string' && s.length > 5 && s.length < 300)
        .slice(0, maxAlternatives);
    }
  } catch (_) { /* fall through */ }
  return [];
}

/**
 * Detect whether an answer is an abstention (signals retrieval miss).
 */
function isAbstention(answer) {
  if (!answer) return true;
  const lower = String(answer).toLowerCase();
  const patterns = [
    'no information available',
    "don't know",
    "don't have",
    'not in context',
    'not available',
    'no evidence',
    'not mentioned',
    'unclear',
    'cannot determine',
    'no specific information',
  ];
  return patterns.some(p => lower.includes(p));
}

export default {
  reformulate,
  isAbstention,
  _internals: { HAIKU_MODEL },
};
