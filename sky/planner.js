/**
 * Agentic retrieval planner — P2-1 (2026-05-08).
 *
 * Why we have this:
 *   Pure cosine + reranker excels at "find the document that answers this
 *   question". It struggles with QUERIES THAT REQUIRE AGGREGATION across
 *   multiple sub-facts, e.g.:
 *     "Where has Melanie camped?" → expects ["beach", "mountains", "forest"]
 *     "Who's on my sales pipeline this week?" → expects ["Person C", "Billy", "Person A", "Lisa"]
 *     "Walk me through <separate-project>, <separate-project>, <separate-project>, <separate-project>"
 *   The relevant facts live in different sessions / different turns. A
 *   single embedding query can't surface them all reliably.
 *
 * What it does:
 *   Takes the user query, asks Haiku 4.5: "decompose this into 1-4 self-
 *   contained sub-questions if needed; otherwise return the original".
 *   Each sub-question is a complete, retrievable query on its own.
 *   The caller runs each sub-query through the production retrieval
 *   pipeline (semantic dual-query + FTS + edge-walk + reranker), unions
 *   the results, and reranks with the ORIGINAL query.
 *
 * Cost: ~$0.0003 per planner call (Haiku, 200 input + 200 output tokens).
 * Latency: 300-500ms warm.
 *
 * Activation policy:
 *   Only fire on questions that LIKELY benefit from decomposition. Cheap
 *   regex-based gating saves the Haiku call for simple queries:
 *     - >2 proper nouns ("<separate-project> and <separate-project>")
 *     - "and / , / vs / between" patterns ("Person A and Lisa")
 *     - List-asking patterns ("what activities / where / who all / which")
 *     - Aggregation patterns ("everyone / everything / all my / overview")
 *   Otherwise return { shouldDecompose: false } and the caller skips planner.
 *
 * Reference benchmark: this is the architectural piece Memori's "multi-
 * agent" pattern provides. Their 81.95% on LoCoMo includes a
 * capture/analyze/select chain we don't yet have. P2-1 fills that gap.
 */

import apiFallback from './api-fallback.js';

const PLANNER_MODEL = process.env.SKY_PLANNER_MODEL || 'claude-haiku-4-5';

// In-memory plan cache. Same query → same plan. 10-min TTL to bound staleness.
const _planCache = new Map();
const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAN_CACHE_MAX = 200; // bound memory

function _cacheKey(query) { return query.trim().toLowerCase().slice(0, 200); }

function _cachePut(key, value) {
  if (_planCache.size >= PLAN_CACHE_MAX) {
    // Drop oldest by insertion order — Map preserves insertion order
    const first = _planCache.keys().next().value;
    _planCache.delete(first);
  }
  _planCache.set(key, { value, expires: Date.now() + PLAN_CACHE_TTL_MS });
}

function _cacheGet(key) {
  const e = _planCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { _planCache.delete(key); return null; }
  return e.value;
}

/**
 * Cheap gating: should this query trigger decomposition?
 * Returns true if any of the patterns match. Saves a Haiku call on simple
 * single-fact queries like "Who is Person A?".
 */
function _shouldPlan(query) {
  if (!query || query.length < 12) return false;
  const q = query.toLowerCase();

  // List/aggregation asks
  if (/\b(all|everyone|everything|every one|each|each of|all of|every|overview|summary|status|state of|walk me through|tell me about all|list)\b/.test(q)) return true;
  if (/\b(what activities|where (has|did|do|does)|who all|which (of |ones|do|did)|how many|all the (things|people|projects|deals|companies))\b/.test(q)) return true;
  if (/\b(this week|this month|today's|tonight's|recent (decisions|actions))\b.*\b(all|every|each|state|status|update|happening|going on)\b/.test(q)) return true;

  // Multi-entity patterns: 2+ proper nouns or comma-listed terms
  const properNouns = (query.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []);
  const distinctNouns = [...new Set(properNouns)];
  if (distinctNouns.length >= 2 && /\b(and|,|vs|between)\b/.test(q)) return true;

  // Comparison / relationship questions
  if (/\b(how does|how do).+(connect|relate|differ|compare)/.test(q)) return true;
  if (/\b(relationship|connection|difference) between\b/.test(q)) return true;

  return false;
}

/**
 * Plan retrieval for a query. Returns:
 *   {
 *     shouldDecompose: bool,
 *     subqueries: [string],        // includes the original as the first element if decomposed
 *     rationale?: string,          // optional Haiku reasoning
 *     fromCache: bool,
 *     ms: number,
 *   }
 *
 * If shouldDecompose=false, subqueries=[query] (single-element passthrough).
 *
 * Always returns a usable result — never throws. On planner failure (API
 * error, Haiku unavailable), falls back to single-query passthrough.
 */
async function plan(query, options = {}) {
  const { force = false, model = PLANNER_MODEL, maxSubqueries = 4 } = options;
  const start = Date.now();

  if (!query || typeof query !== 'string') {
    return { shouldDecompose: false, subqueries: [query || ''], fromCache: false, ms: 0 };
  }

  // Gating
  if (!force && !_shouldPlan(query)) {
    return { shouldDecompose: false, subqueries: [query], fromCache: false, ms: Date.now() - start };
  }

  // Cache check
  const cacheKey = _cacheKey(query);
  const cached = _cacheGet(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true, ms: Date.now() - start };
  }

  // No planner available → passthrough
  if (!apiFallback.isAvailable()) {
    return { shouldDecompose: false, subqueries: [query], fromCache: false, ms: Date.now() - start };
  }

  const systemPrompt = `You decompose user questions into self-contained sub-questions for a memory retrieval system.

Rules:
- If the question can be answered by retrieving ONE fact, output the original question as a single sub-query.
- If the question requires AGGREGATING multiple facts (list questions, multi-entity status, "all my X", "where has Y been"), break it into 1–${maxSubqueries} sub-questions. Each sub-question must be self-contained — do not assume the reader has seen the original.
- Sub-questions should be SPECIFIC and RETRIEVABLE — concrete entities, concrete attributes.
- Output ONLY valid JSON: {"subqueries": ["...", "..."]}. No prose, no explanation.

Examples:
Q: "Who is Person A?"
A: {"subqueries": ["Who is Person A?"]}

Q: "Where has Melanie camped?"
A: {"subqueries": ["Locations Melanie has been camping at", "Beach trips Melanie mentioned", "Mountain trips Melanie mentioned", "Forest trips Melanie mentioned"]}

Q: "Who's on my sales pipeline this week?"
A: {"subqueries": ["Active sales leads this week", "Open client proposals this week", "Recent prospects mentioned this week"]}

Q: "Walk me through <separate-project>, <separate-project>, <separate-project>, <separate-project>"
A: {"subqueries": ["What is <separate-project> and current status", "What is <separate-project> and current status", "What is <separate-project> and current status", "What is <separate-project> and current status"]}

Q: "What did I do on <separate-project> today?"
A: {"subqueries": ["<separate-project> actions today", "<separate-project> deliverables today", "<separate-project> communications today"]}`;

  let raw;
  try {
    raw = await apiFallback.generateResponse(systemPrompt, query, {
      model,
      maxTokens: 400,
      cacheSystem: false, // cheap call, system is short
    });
  } catch (err) {
    console.warn(`[Planner] failed: ${err.message} — passing through original query`);
    return { shouldDecompose: false, subqueries: [query], fromCache: false, ms: Date.now() - start };
  }

  // Parse JSON. Be tolerant of mild noise.
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.warn(`[Planner] invalid JSON: ${(raw || '').slice(0, 120)} — passing through`);
    return { shouldDecompose: false, subqueries: [query], fromCache: false, ms: Date.now() - start };
  }

  let subqueries = Array.isArray(parsed.subqueries)
    ? parsed.subqueries.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, maxSubqueries)
    : [];
  if (subqueries.length === 0) subqueries = [query];

  // If the planner returned a single sub-query that's basically the original,
  // record shouldDecompose=false (saves caller a redundant retrieval pass).
  const decomposed = subqueries.length > 1 || subqueries[0].trim().toLowerCase() !== query.trim().toLowerCase();

  // Always include the original query first when decomposing — caller can
  // dedupe; this guarantees the bare-query semantic still fires.
  if (decomposed && !subqueries.some(s => s.trim().toLowerCase() === query.trim().toLowerCase())) {
    subqueries = [query, ...subqueries].slice(0, maxSubqueries);
  }

  const result = {
    shouldDecompose: decomposed,
    subqueries,
    fromCache: false,
    ms: Date.now() - start,
  };
  _cachePut(cacheKey, { shouldDecompose: result.shouldDecompose, subqueries: result.subqueries });

  if (decomposed) {
    console.log(`[Planner] "${query.slice(0, 60)}..." → ${subqueries.length} sub-queries (${result.ms}ms)`);
    for (const [i, sq] of subqueries.entries()) {
      console.log(`  ${i + 1}. ${sq.slice(0, 100)}`);
    }
  }
  return result;
}

export default {
  plan,
  _shouldPlan, // exported for tests / inspection
};
