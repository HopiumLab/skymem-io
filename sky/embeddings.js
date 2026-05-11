/**
 * Sky's Embedding Module
 *
 * Semantic vector search using local embeddings.
 * Model: all-MiniLM-L6-v2 (384 dimensions, ~90MB download on first use)
 *
 * Uses @xenova/transformers for local inference — no API calls, no cost.
 * Lazy loads the model so Sky's startup isn't blocked.
 */

import prisma from './prisma-client.js';
import { isScopeEnabled, passesScopeFilter } from './scope-helpers.js';

// ============================================================
// Model loading — lazy, cached, same pattern as Whisper in voice.js
// ============================================================

let pipeline = null;
let modelLoading = false;
let modelReady = false;

async function getEmbeddingPipeline() {
  if (pipeline) return pipeline;

  if (modelLoading) {
    // Another call is already loading — wait for it
    while (modelLoading && !pipeline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return pipeline;
  }

  modelLoading = true;
  console.log('[Embeddings] Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
  console.log('[Embeddings] First run will download ~90MB model. One-time only.');

  try {
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    modelReady = true;
    console.log('[Embeddings] Model loaded and ready.');
    return pipeline;
  } catch (err) {
    console.error('[Embeddings] Failed to load embedding model:', err.message);
    modelLoading = false;
    throw err;
  }
}

// ============================================================
// Embedding cache — avoid repeated DB reads for similarity search
// ============================================================

let embeddingCache = [];
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache load uses CURSOR PAGINATION (P1.6 — 2026-05-10).
//
// History: a single findMany() across all 53k+ embedding rows × 1024-dim
// vectors triggers a Prisma 6.19.2 NAPI string-marshaling bug
// ("Failed to convert rust `String` into napi `string`") — the entire
// load throws and the cache stays empty, so every retrieval falls back
// to a fresh Cohere embed call. Visible as exit=137 OOM on cold first
// chunks and as warnings every 5 min when the TTL forces a reload.
//
// Fix: chunked load. Each batch is well below the marshaling threshold
// AND tolerates individual batch failures — one bad batch doesn't
// blackout the whole cache. Total load time on 53k rows: ~5–10s.
const CACHE_BATCH_SIZE = 5000;

async function loadCache() {
  const t0 = Date.now();
  const next = [];
  let lastId = null;
  let batches = 0;
  let batchFails = 0;

  while (true) {
    let batch;
    try {
      batch = await prisma.embedding.findMany({
        where: lastId ? { id: { gt: lastId } } : undefined,
        orderBy: { id: 'asc' },
        take: CACHE_BATCH_SIZE,
        select: {
          // Phase 1: load scope columns so we can pre-cosine filter in JS.
          // chatJid/companyId/tier may be null on rows that haven't been
          // backfilled yet — the scope filter handles null gracefully.
          id: true, sourceType: true, sourceId: true, content: true, vector: true,
          chatJid: true, companyId: true, tier: true,
        },
      });
    } catch (err) {
      // One batch failed — log loud (we want to see these), skip past
      // it by advancing lastId to the next batch boundary, and keep
      // going. Better to have 95% of the cache than 0%.
      batchFails += 1;
      console.warn(`[Embeddings] Cache batch failed at cursor=${lastId ?? 'start'}: ${err.message.split('\n')[0]}`);
      if (!lastId) break; // first batch failed → can't advance, bail
      // Advance by querying just the IDs of the next CACHE_BATCH_SIZE rows
      // so we can skip past the bad zone without scanning every column.
      try {
        const ids = await prisma.embedding.findMany({
          where: { id: { gt: lastId } },
          orderBy: { id: 'asc' },
          take: CACHE_BATCH_SIZE,
          select: { id: true },
        });
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1].id;
      } catch (idErr) {
        console.warn(`[Embeddings] Cache cursor-skip also failed: ${idErr.message.split('\n')[0]}`);
        break;
      }
      continue;
    }

    if (batch.length === 0) break;
    next.push(...batch);
    lastId = batch[batch.length - 1].id;
    batches += 1;
    if (batch.length < CACHE_BATCH_SIZE) break;
  }

  if (next.length > 0) {
    embeddingCache = next;
    cacheLoadedAt = Date.now();
    const ms = Date.now() - t0;
    const tail = batchFails > 0 ? ` (${batchFails} batch failure${batchFails === 1 ? '' : 's'} skipped)` : '';
    console.log(`[Embeddings] Cache loaded: ${next.length} rows in ${batches} batches, ${ms}ms${tail}`);
  } else {
    console.warn(`[Embeddings] Cache load yielded 0 rows (${batchFails} batch failure(s))`);
  }
}

function isCacheStale() {
  return Date.now() - cacheLoadedAt > CACHE_TTL_MS;
}

async function getCache() {
  if (embeddingCache.length === 0 || isCacheStale()) {
    await loadCache();
  }
  return embeddingCache;
}

function invalidateCache() {
  cacheLoadedAt = 0; // force reload on next access
}

/**
 * Append a single embedding to the in-memory cache without forcing a
 * full reload from the database (Phase 1.5 — fix the cache-thrash that
 * was making every chat turn pay the 25–30 second reload cost).
 *
 * Pre-fix: embedAndStore called invalidateCache() after every insert,
 * so the next searchSimilar paid a 40k-row findMany including the
 * 384-float JSON vector blobs — visible as ~28s ctxSemantic in the
 * trace, on every request.
 *
 * Post-fix: append the new row to the cache directly. The 5-minute
 * TTL still triggers periodic full reloads for drift correction.
 *
 * Skipped when the cache hasn't been loaded yet — the next getCache()
 * will pull a fresh copy that already includes the new row from DB.
 */
function appendToCache(entry) {
  if (cacheLoadedAt === 0) return; // cache not loaded yet; let getCache() do it fresh
  embeddingCache.push(entry);
}

// ============================================================
// Core functions
// ============================================================

/**
 * Embed a text string. Provider-pluggable as of P1-6 (2026-05-08).
 *
 * Provider matrix:
 *   local   — Xenova/all-MiniLM-L6-v2 (384d, free, ~5ms warm). Default.
 *   cohere  — Cohere embed-english-v3.0 / embed-v4 (1024d, ~$0.10/Mtok,
 *             retrieval-tuned, ~150ms warm).
 *   voyage  — Voyage 3 (1024d, ~$0.06/Mtok, retrieval-tuned, ~150ms warm).
 *
 * Why the swap matters for retrieval quality:
 *   MiniLM-L6-v2 trained 2019 on generic web text. Top of the small/fast
 *   benchmark; bottom of the precision-grade retrieval benchmark. For
 *   $100M-IP-grade retrieval, 1024d retrieval-tuned embeddings consistently
 *   beat 384d generic embeddings by 5-15 absolute points on BEIR-style
 *   benchmarks. Especially important for nuanced queries where the answer
 *   is semantically adjacent but textually distinct (calendar-formatted
 *   meeting node vs natural-language meeting query — see M2 case in
 *   internal eval).
 *
 * Migration path:
 *   1. Set SKY_EMBED_PROVIDER=cohere (or voyage) in .env
 *   2. Run scripts/reembed.js — re-embeds all existing rows with new model
 *   3. Restart bridge — new ingestions use the new provider automatically
 *   4. Cosine search continues to work with mixed dimensions ONLY if you
 *      filter the cache to one provider at a time. The migration script
 *      tags each Embedding row with its provider; cache-load filters on it.
 *
 * input_type:
 *   Cohere distinguishes 'search_document' (for ingestion) vs 'search_query'
 *   (for retrieval). The retrieval-tuned models score better when this is
 *   set correctly. Pass {forQuery: true} for query-time embeds.
 */

const EMBED_PROVIDER = (process.env.SKY_EMBED_PROVIDER || 'local').toLowerCase();
const COHERE_KEY = process.env.COHERE_API_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

const COHERE_EMBED_MODEL = process.env.SKY_COHERE_EMBED_MODEL || 'embed-english-v3.0';
const VOYAGE_EMBED_MODEL = process.env.SKY_VOYAGE_EMBED_MODEL || 'voyage-3';

async function embed(text, options = {}) {
  const { forQuery = false } = options;
  const provider = options.provider || EMBED_PROVIDER;

  if (provider === 'cohere' && COHERE_KEY) {
    return embedCohere(text, { forQuery });
  }
  if (provider === 'voyage' && VOYAGE_KEY) {
    return embedVoyage(text, { forQuery });
  }
  // Default: local MiniLM
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function embedCohere(text, { forQuery }) {
  const res = await fetch('https://api.cohere.com/v2/embed', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COHERE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: COHERE_EMBED_MODEL,
      texts: [text],
      input_type: forQuery ? 'search_query' : 'search_document',
      embedding_types: ['float'],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Cohere embed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  // v2 returns { embeddings: { float: [[...]] } }
  return json.embeddings?.float?.[0] || [];
}

async function embedVoyage(text, { forQuery }) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: [text],
      input_type: forQuery ? 'query' : 'document',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Voyage embed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data?.[0]?.embedding || [];
}

/**
 * Embed text and store the embedding in the database.
 *
 * Phase 1: accepts an optional `scope` object — chatJid/companyId/tier are
 * mirrored onto the Embedding row so the in-memory cache can pre-filter
 * candidates by scope before computing cosine. Audience and subjects are
 * deliberately not mirrored — see plan §2.2.
 */
async function embedAndStore(sourceType, sourceId, text, scope = null) {
  try {
    const vector = await embed(text);

    const data = {
      sourceType,
      sourceId,
      content: text.slice(0, 5000), // cap stored text at 5k chars
      vector,
    };
    if (scope) {
      data.chatJid = scope.chatJid ?? null;
      data.companyId = scope.companyId ?? null;
      data.tier = scope.tier ?? null;
    }

    const record = await prisma.embedding.create({ data });

    // Phase 1.5: append the new embedding to the in-memory cache instead of
    // invalidating it. Avoids the ~28s reload-thrash that pre-fix happened
    // on every chat turn (each ingest creates ~5 atom embeddings, each
    // flushed the cache, next searchSimilar paid a full ~40k-row reload).
    // Build the cache-shaped entry directly so we don't carry extra fields
    // like `createdAt` around in memory.
    appendToCache({
      id: record.id,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      content: record.content,
      vector: record.vector,
      chatJid: record.chatJid ?? null,
      companyId: record.companyId ?? null,
      tier: record.tier ?? null,
    });

    return record;
  } catch (err) {
    console.warn(`[Embeddings] Failed to embed and store (${sourceType}/${sourceId}):`, err.message);
    return null;
  }
}

/**
 * Cosine similarity between two vectors (arrays of numbers).
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Search for semantically similar embeddings.
 *
 * @param {string} query - The text to search for
 * @param {number} limit - Max results to return
 * @param {string|null} sourceType - Filter by source type, or null for all
 * @param {object|null} scope - Phase 1 request scope (chatJid, companyId, ...).
 *                              When provided AND the SKY_PHASE1_SCOPE flag is on,
 *                              filters candidates by scope BEFORE computing
 *                              cosine. The cache rows already carry chatJid +
 *                              companyId + tier (loaded in loadCache), so this
 *                              is a pure JS predicate — no extra DB round trip.
 * @returns {Array<{id, sourceType, sourceId, content, similarity}>}
 */
async function searchSimilar(query, limit = 10, sourceType = null, scope = null) {
  // P1-6: Cohere/Voyage retrieval-tuned models score noticeably better
  // when query embeddings are tagged input_type='search_query' vs documents
  // tagged 'search_document'. Pass forQuery=true. No effect on local model.
  const queryVector = await embed(query, { forQuery: true });
  const cache = await getCache();

  // Filter by sourceType if specified
  let candidates = sourceType
    ? cache.filter(e => e.sourceType === sourceType)
    : cache;

  // Phase 1 scope pre-filter (Stage D). Skipped when flag is off OR when
  // no scope was passed — preserves pre-Phase-1 behaviour exactly.
  if (scope && isScopeEnabled()) {
    candidates = candidates.filter(e => passesScopeFilter(e, scope));
  }

  // Compute similarity for each candidate
  const scored = candidates.map(entry => ({
    id: entry.id,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    content: entry.content,
    similarity: cosineSimilarity(queryVector, entry.vector),
  }));

  // Sort by similarity descending, return top N
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Check if the embedding model is loaded and ready.
 */
function isReady() {
  return modelReady;
}

export default {
  embed,
  embedAndStore,
  searchSimilar,
  cosineSimilarity,
  isReady,
  invalidateCache,
};
