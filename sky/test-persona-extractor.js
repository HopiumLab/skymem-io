/**
 * Smoke test for sky/persona-extractor.js
 *
 * Pulls a tiny slice of high-weight, recent MemoryNodes and runs the
 * extractor against them in dryRun mode. Confirms:
 *   - LLM call reaches Haiku
 *   - JSON parses cleanly
 *   - Aggregation collapses duplicate slots
 *   - Slot normalisation works
 *   - No DB writes happen (dryRun=true)
 *
 * Run via:
 *   docker exec -it sky-bridge node /app/sky/test-persona-extractor.js
 */

import prisma from './prisma-client.js';
import extractor from './persona-extractor.js';

async function main() {
  // Pick a small high-quality slice — recent + decent weight, skip system/log
  const nodes = await prisma.memoryNode.findMany({
    where: {
      weight: { gte: 0.4 },
      type: { notIn: ['log', 'system', 'enrichment'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: {
      id: true,
      type: true,
      content: true,
      tags: true,
      subjects: true,
      audience: true,
      createdAt: true,
      chatJid: true,
    },
  });

  if (nodes.length === 0) {
    console.error('[Test] No nodes found — DB empty or query mismatch.');
    process.exit(1);
  }

  console.log(`[Test] Pulled ${nodes.length} nodes. Sample IDs: ${nodes.slice(0, 3).map(n => n.id).join(', ')}`);
  console.log(`[Test] Sample contents (first 100 chars):`);
  for (const n of nodes.slice(0, 3)) {
    console.log(`  - ${n.id} [${n.type}]: ${(n.content || '').slice(0, 100).replace(/\s+/g, ' ')}`);
  }

  // Phase 1: extract a single batch (no DB writes)
  console.log('\n[Test] Running single-batch extraction (verbose, dryRun)...');
  const t0 = Date.now();
  const raw = await extractor.extractBatch(nodes, { verbose: true });
  const elapsed = Date.now() - t0;
  console.log(`\n[Test] Got ${raw.length} raw facts in ${elapsed}ms`);

  if (raw.length > 0) {
    console.log('[Test] Sample raw facts:');
    for (const f of raw.slice(0, 5)) {
      console.log(`  - [${f.domain}/${f.slot}] (${f.confidence}) ${f.fact?.slice(0, 120)}`);
    }
  }

  // Phase 2: aggregate
  const agg = extractor.aggregate(raw);
  console.log(`\n[Test] Aggregated to ${agg.length} unique (domain, slot) facts`);
  for (const f of agg) {
    console.log(`  - [${f.domain}/${f.slot}] (${f.confidence.toFixed(2)}) ev=${f.evidence.length} → ${f.fact.slice(0, 100)}`);
  }

  // Phase 3: dry-run write counts
  const counts = await extractor.writeFacts(agg, { dryRun: true });
  console.log('\n[Test] Dry-run write counts by domain:');
  for (const [dom, n] of Object.entries(counts)) {
    if (n > 0) console.log(`  - ${dom}: ${n}`);
  }

  // Phase 4: confirm the higher-level extractNodes flow runs
  console.log('\n[Test] Running extractNodes (dryRun) over the same 12 nodes with batchSize=6...');
  const summary = await extractor.extractNodes(nodes, { batchSize: 6, dryRun: true });
  console.log('[Test] Summary:', summary);

  console.log('\n[Test] Smoke test complete.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[Test] FAILED:', e);
  process.exit(1);
});
