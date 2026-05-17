#!/usr/bin/env node
/**
 * Fix bad Embedding rows that throw the napi rust-string error.
 *
 * Symptom (visible in bench logs throughout 2026-05-09/10):
 *   [Embeddings] Failed to load cache:
 *   Invalid `prisma.embedding.findMany()` invocation:
 *   Failed to convert rust `String` into napi `string`
 *
 * Root cause: 4 rows out of 53,788 from the Cohere migration ended up
 * with malformed UTF-8 in their content (likely from corrupted source
 * MemoryNode rows). Prisma's rust→napi binding can't decode them.
 *
 * Strategy:
 *   1. Page through Embedding rows in batches.
 *   2. For each batch that throws, halve to find the bad row.
 *   3. For each bad row: nullify content, re-fetch source MemoryNode,
 *      re-embed, write back.
 *   4. If source MemoryNode is also bad, delete the Embedding row
 *      (the node's been deleted already).
 *
 * Cost: ~4 Cohere embed calls × $0.0001 = negligible.
 *
 * Usage: docker exec skymem node /app/scripts/fix-bad-embeddings.js
 */

import prisma from '../sky/prisma-client.js';
import embeddings from '../sky/embeddings.js';

const PAGE_SIZE = 256;
const VERBOSE = process.argv.includes('--verbose');

console.log(`[fix-bad-embeddings] starting at ${new Date().toISOString()}`);

// Try to load all rows in pages. When a page throws, bisect.
async function loadPage(offset) {
  return prisma.embedding.findMany({
    skip: offset,
    take: PAGE_SIZE,
    select: { id: true, sourceType: true, sourceId: true },
  });
}

async function bisectBadRow(offsetStart, offsetEnd) {
  if (offsetEnd - offsetStart <= 1) {
    // Found it
    const row = await prisma.embedding.findFirst({
      skip: offsetStart, take: 1,
      select: { id: true, sourceType: true, sourceId: true },
    }).catch(() => null);
    return row;
  }
  const mid = Math.floor((offsetStart + offsetEnd) / 2);
  try {
    await prisma.embedding.findMany({
      skip: offsetStart, take: mid - offsetStart,
      select: { id: true },
    });
    // First half OK, search second half
    return bisectBadRow(mid, offsetEnd);
  } catch (e) {
    return bisectBadRow(offsetStart, mid);
  }
}

let total = 0;
try {
  total = await prisma.embedding.count();
  console.log(`[fix-bad-embeddings] total rows: ${total}`);
} catch (e) {
  console.error(`[fix-bad-embeddings] count failed: ${e.message}`);
  process.exit(1);
}

const badRows = [];
let offset = 0;
while (offset < total) {
  try {
    if (VERBOSE) console.log(`  page ${offset}-${offset + PAGE_SIZE}`);
    await loadPage(offset);
    offset += PAGE_SIZE;
  } catch (e) {
    if (e.message.includes('rust') || e.message.includes('napi')) {
      console.log(`  bad row in page ${offset}-${offset + PAGE_SIZE} — bisecting...`);
      const bad = await bisectBadRow(offset, Math.min(offset + PAGE_SIZE, total));
      if (bad) {
        badRows.push(bad);
        console.log(`  found bad row id=${bad.id} src=${bad.sourceType}:${bad.sourceId}`);
      }
      offset += PAGE_SIZE;
    } else {
      console.error(`  unexpected error at offset ${offset}: ${e.message}`);
      offset += PAGE_SIZE;
    }
  }
}

console.log(`[fix-bad-embeddings] found ${badRows.length} bad rows`);

if (badRows.length === 0) {
  console.log('[fix-bad-embeddings] nothing to fix.');
  await prisma.$disconnect();
  process.exit(0);
}

// Repair each bad row: re-embed from source MemoryNode content
let repaired = 0;
let deleted = 0;
for (const row of badRows) {
  if (row.sourceType !== 'memory_node') {
    console.log(`  skip ${row.id}: non-memory-node source ${row.sourceType}`);
    continue;
  }
  const node = await prisma.memoryNode.findUnique({
    where: { id: row.sourceId },
    select: { id: true, content: true, chatJid: true, companyId: true, tier: true, audience: true },
  }).catch(() => null);

  if (!node) {
    // Source node deleted — embedding is orphaned
    await prisma.embedding.delete({ where: { id: row.id } }).catch(() => {});
    deleted++;
    console.log(`  deleted orphan ${row.id}`);
    continue;
  }

  try {
    // Re-embed the content. embeddings.embedAndStore upserts on (sourceType, sourceId).
    await embeddings.embedAndStore('memory_node', node.id, node.content, {
      chatJid: node.chatJid,
      companyId: node.companyId,
      tier: node.tier,
      audience: node.audience,
    });
    repaired++;
    console.log(`  repaired ${row.id} (node ${node.id})`);
  } catch (e) {
    console.warn(`  repair failed for ${row.id}: ${e.message}`);
  }
}

console.log(`[fix-bad-embeddings] done — repaired=${repaired} deleted=${deleted}`);
await prisma.$disconnect();
