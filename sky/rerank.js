/**
 * Cross-attention reranker — P1-2 (2026-05-08).
 *
 * Why we have this:
 *   Pure cosine similarity (Sky's `sky/embeddings.js#searchSimilar` and the
 *   composite scorer in `sky/graph.js#retrieve`) compares query and document
 *   embeddings INDEPENDENTLY. The model never reads them together. That's
 *   the bottleneck remaining after P0/P1 — calendar-formatted text fails to
 *   match natural-language queries because the surface forms are too different
 *   even when the meaning is identical (M2-marie-meeting eval failure).
 *
 * What a reranker does:
 *   Cross-attention scoring. The reranker model reads (query, document) AS A
 *   PAIR and outputs a relevance score. Drastically better at "is this document
 *   actually about the query" than vector cosine. Public benchmarks show
 *   Cohere rerank-3.5 lifting top-1 accuracy by 20-40 points on hard datasets.
 *
 * Provider strategy:
 *   Cohere first (currently SOTA on English retrieval benchmarks). Voyage
 *   rerank-2 is a drop-in alternative; provider abstraction below makes
 *   swapping trivial. Set SKY_RERANK_PROVIDER=voyage to use Voyage instead.
 *
 * Pipeline placement:
 *   Pre-rerank: semantic + FTS + edge-walk produce ~30-50 candidates.
 *   Rerank:     Cohere reorders by cross-attention, returns top-N.
 *   Post-rerank: privacy filter, then ## YOUR KNOWLEDGE block.
 *
 * Cost model (Cohere rerank-3.5, 2026 pricing):
 *   ~$2 per 1k searches × candidates (up to 100 per call). Sky sends ≤50
 *   candidates/turn. At 100 chats/day → ~$0.20/day reranking cost. Trivial
 *   relative to the accuracy lift.
 *
 * Fallback behaviour:
 *   If the API call fails (network, rate limit, key invalid), return the
 *   candidates unchanged so retrieval degrades gracefully to the pre-rerank
 *   composite score order. The whole reranker is a quality lift, never a
 *   correctness dependency.
 */

const COHERE_KEY = process.env.COHERE_API_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const PROVIDER = (process.env.SKY_RERANK_PROVIDER || (COHERE_KEY ? 'cohere' : VOYAGE_KEY ? 'voyage' : null)) || null;

const COHERE_MODEL = process.env.SKY_COHERE_RERANK_MODEL || 'rerank-v3.5';
const VOYAGE_MODEL = process.env.SKY_VOYAGE_RERANK_MODEL || 'rerank-2';

/**
 * Is reranking available right now? Used by callers to decide whether to
 * skip the rerank stage entirely vs include it in the pipeline.
 */
function isAvailable() {
  if (process.env.SKY_RERANK_DISABLED === 'true') return false;
  if (PROVIDER === 'cohere') return !!COHERE_KEY;
  if (PROVIDER === 'voyage') return !!VOYAGE_KEY;
  return false;
}

/**
 * Rerank candidates. Returns the SAME candidate objects, reordered + with
 * a `rerankScore` field added (0..1, higher is more relevant). If rerank
 * fails or is unavailable, returns the input unchanged.
 *
 * @param {string} query — the user message (or the bare current message)
 * @param {Array<{id, content, ...}>} candidates — candidate nodes from semantic+FTS+edgeWalk
 * @param {object} options
 *   topN:    default 10 — how many to return
 *   timeout: default 4000ms
 *   model:   override default model
 * @returns {Promise<Array<{id, content, rerankScore, ...}>>}
 */
async function rerank(query, candidates, options = {}) {
  const { topN = 10, timeout = 4000, model = null } = options;

  if (!isAvailable()) return candidates.slice(0, topN);
  if (!candidates || candidates.length === 0) return [];
  if (!query || query.trim().length === 0) return candidates.slice(0, topN);

  // Cohere accepts up to 1000 docs per call, Voyage ~1000 too — we're sending
  // ≤50 always. No batching needed at our scale.
  //
  // Prepend a date prefix so the reranker can resolve "latest" / "recent" /
  // "this week" queries correctly. Without this, the reranker reads only
  // the content text and has no signal that "Person A sorted the follow-ups"
  // on May 5 is more recent than "Spoke to Person A on Saturday" from April 21.
  // Empirically (eval p1-2-rerank): M3-marie-latest regressed from passing
  // → failing because the reranker picked semantically-stronger old content
  // over weaker recent content. Date prefix fixes this without extra
  // signal-engineering — modern rerankers are date-aware.
  const docs = candidates.map(c => {
    const datePrefix = c.createdAt
      ? `[${new Date(c.createdAt).toISOString().slice(0, 10)}] `
      : '';
    const typePrefix = c.type ? `[${c.type}] ` : '';
    return (datePrefix + typePrefix + (c.content || '')).slice(0, 4000);
  });

  const start = Date.now();
  try {
    let order;
    if (PROVIDER === 'cohere') {
      order = await rerankCohere(query, docs, { topN, timeout, model: model || COHERE_MODEL });
    } else if (PROVIDER === 'voyage') {
      order = await rerankVoyage(query, docs, { topN, timeout, model: model || VOYAGE_MODEL });
    } else {
      return candidates.slice(0, topN);
    }

    const ms = Date.now() - start;
    console.log(`[Rerank] ${PROVIDER}/${model || (PROVIDER === 'cohere' ? COHERE_MODEL : VOYAGE_MODEL)} — ${candidates.length} → ${order.length} in ${ms}ms`);

    // Map order back to original candidate objects with rerankScore attached.
    return order.map(({ index, score }) => ({
      ...candidates[index],
      rerankScore: score,
    }));
  } catch (err) {
    const ms = Date.now() - start;
    console.warn(`[Rerank] failed in ${ms}ms (${err.message}). Falling back to pre-rerank order.`);
    return candidates.slice(0, topN);
  }
}

// ── Cohere implementation ──────────────────────────────────────────────────

async function rerankCohere(query, documents, { topN, timeout, model }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COHERE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: topN,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Cohere rerank ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  // Response shape: { results: [{ index: <int>, relevance_score: <float> }, ...] }
  return (json.results || []).map(r => ({
    index: r.index,
    score: r.relevance_score,
  }));
}

// ── Voyage implementation (drop-in alternative) ────────────────────────────

async function rerankVoyage(query, documents, { topN, timeout, model }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_k: topN,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Voyage rerank ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  // Response shape: { data: [{ index: <int>, relevance_score: <float> }, ...] }
  return (json.data || []).map(r => ({
    index: r.index,
    score: r.relevance_score,
  }));
}

export default {
  isAvailable,
  rerank,
  PROVIDER,
};
