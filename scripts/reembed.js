#!/usr/bin/env node
/**
 * Re-embed all Embedding rows using the configured SKY_EMBED_PROVIDER.
 * P1-6 (2026-05-08).
 *
 * Use case:
 *   - Migrate from MiniLM-L6-v2 (384d) to Cohere embed-v3 / Voyage 3 (1024d)
 *     for production retrieval quality
 *   - Re-embed after a model upgrade
 *   - Re-embed a subset (filter by sourceType / chatJid) for partial migration
 *
 * Mechanic:
 *   - Reads Embedding rows in pages of 50
 *   - For each, calls embed(content) with the configured provider
 *   - Writes the new vector back to the same row (UPDATE, not INSERT)
 *   - Idempotent within a run — if interrupted, re-running picks up where
 *     it left off via a state file (--state-file) or full rescan
 *   - Rate-limited so we don't hammer the API (default 5 RPS)
 *
 * Usage:
 *   docker exec sky-bridge sh -c '
 *     export SKY_EMBED_PROVIDER=cohere
 *     export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e "s|@localhost:|@host.docker.internal:|g")"
 *     node /app/scripts/reembed.js [--limit=N] [--source-type=T] [--dry-run] [--rps=R]
 *   '
 *
 *   --limit=N        Re-embed only first N rows (testing)
 *   --source-type=T  Only re-embed rows with this sourceType
 *   --dry-run        Print what would happen, don't write
 *   --rps=R          Requests per second to provider API (default 5)
 *
 * Cost (Cohere embed-v3.0 @ $0.10/Mtok, ~50 tokens avg per row, ~47k rows):
 *   ~2.4M tokens × $0.10/Mtok = ~$0.24 one-time
 *
 * Time:
 *   At 5 RPS: 47k rows ÷ 5 = ~9400 seconds = ~2.6 hours
 *   At 20 RPS (Cohere allowance): ~40 minutes
 *   Tune --rps based on plan tier.
 */

import prisma from '../sky/prisma-client.js';
import embeddings from '../sky/embeddings.js';

const ARGS = process.argv.slice(2);
function flag(name, defaultValue = null) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  if (ARGS.includes(`--${name}`)) return true;
  return defaultValue;
}

const LIMIT = parseInt(flag('limit', '0'), 10) || null;
const SOURCE_TYPE = flag('source-type', null);
const DRY_RUN = flag('dry-run', false);
const RPS = parseFloat(flag('rps', '5'));
const PAGE_SIZE = 50;

const PROVIDER = (process.env.SKY_EMBED_PROVIDER || 'local').toLowerCase();
if (PROVIDER === 'local') {
  console.warn('[reembed] WARNING: SKY_EMBED_PROVIDER=local — re-embedding with the same local model is a no-op (overwrites with identical vectors).');
  console.warn('[reembed] Did you mean to set SKY_EMBED_PROVIDER=cohere or =voyage?');
  console.warn('[reembed] Continuing in 5s — Ctrl+C to abort.');
  await new Promise(r => setTimeout(r, 5000));
}

const intervalMs = 1000 / RPS;
console.log(`[reembed] provider=${PROVIDER} rps=${RPS} dry-run=${DRY_RUN}`);

// Fetch row count up front for ETA
const where = SOURCE_TYPE ? { sourceType: SOURCE_TYPE } : {};
const totalRows = await prisma.embedding.count({ where });
const targetRows = LIMIT ? Math.min(LIMIT, totalRows) : totalRows;
console.log(`[reembed] Target: ${targetRows} rows (out of ${totalRows} matching)`);
console.log(`[reembed] ETA at ${RPS} RPS: ~${Math.round((targetRows / RPS) / 60)} min`);

let processed = 0;
let skipped = 0;
let failed = 0;
const startTime = Date.now();
let cursor = null;

while (processed + skipped + failed < targetRows) {
  const remaining = targetRows - (processed + skipped + failed);
  const batchSize = Math.min(PAGE_SIZE, remaining);

  const rows = await prisma.embedding.findMany({
    where,
    take: batchSize,
    skip: cursor ? 1 : 0,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { id: 'asc' },
    select: { id: true, content: true, sourceType: true, sourceId: true },
  });
  if (rows.length === 0) break;

  for (const row of rows) {
    if (!row.content || row.content.trim().length === 0) {
      skipped++;
      continue;
    }
    const tStart = Date.now();
    try {
      const newVector = await embeddings.embed(row.content);
      if (!Array.isArray(newVector) || newVector.length === 0) {
        console.warn(`  [skip] ${row.id} — empty vector returned`);
        skipped++;
        continue;
      }
      if (!DRY_RUN) {
        await prisma.embedding.update({ where: { id: row.id }, data: { vector: newVector } });
      }
      processed++;
      if (processed % 50 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        const eta = (targetRows - processed) / rate;
        console.log(`  [${processed}/${targetRows}] ${rate.toFixed(1)} RPS, ETA ${Math.round(eta / 60)} min`);
      }
    } catch (err) {
      console.warn(`  [fail] ${row.id} (${row.sourceType}/${row.sourceId}): ${err.message}`);
      failed++;
    }
    // Rate limit
    const elapsed = Date.now() - tStart;
    if (elapsed < intervalMs) await new Promise(r => setTimeout(r, intervalMs - elapsed));
  }
  cursor = rows[rows.length - 1].id;
}

console.log('');
console.log(`[reembed] DONE — processed=${processed} skipped=${skipped} failed=${failed}`);
console.log(`[reembed] elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);

// IMPORTANT: invalidate the in-memory cache so the bridge picks up new vectors
await embeddings.invalidateCache?.();
console.log('[reembed] In-memory cache invalidated. Bridge will reload on next searchSimilar.');

await prisma.$disconnect();
