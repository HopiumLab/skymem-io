#!/usr/bin/env node
/**
 * Backfill typed-edge extraction over existing MemoryNode rows.
 *
 * The typed-edge module (sky/typed-edges.js) extracts (subject, predicate,
 * object) triples from each node. createNode() doesn't trigger this on
 * the hot ingest path (too costly per-node) — instead we run extraction
 * as a one-shot batch over the existing graph.
 *
 * Cost: ~$0.0008/node (Haiku, ~600 in / ~150 out tokens).
 *   At 44k nodes: ~$35 total.
 *   At 4k high-weight nodes (where most triples live): ~$3.20.
 *
 * Strategy: only run on nodes with weight ≥ MIN_WEIGHT (default 0.4) and
 * type in PERSON/PROJECT/COMPANY/EVENT/CONCEPT (where triples are most
 * likely). Skip noise types (log, system, raw chat-buffer).
 *
 * Usage:
 *   docker exec skymem sh -c '
 *     export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s|@localhost:|@host.docker.internal:|g")
 *     node /app/scripts/backfill-typed-edges.js [--limit=N] [--min-weight=W] [--dry-run]
 *   '
 *
 *   --limit=N        Process at most N nodes (default: all matching)
 *   --min-weight=W   Skip nodes below this weight (default 0.4)
 *   --dry-run        Extract but don't write edges
 *   --types=t1,t2    Restrict to these types (default: person,project,company,event,concept,note)
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import prisma from '../sky/prisma-client.js';
import typedEdges from '../sky/typed-edges.js';

const ARGS = process.argv.slice(2);
const flag = (name, def = null) => {
  const a = ARGS.find(x => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  if (ARGS.includes(`--${name}`)) return true;
  return def;
};

const LIMIT = parseInt(flag('limit', '0'), 10) || null;
const MIN_WEIGHT = parseFloat(flag('min-weight', '0.4'));
const DRY_RUN = !!flag('dry-run');
const TYPES = (flag('types', 'person,project,company,event,concept,note') || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = '/app/logs/backfill-typed-edges.state.json';

console.log('==============================================================');
console.log(' Backfill typed edges');
console.log('==============================================================');
console.log(`  Min weight: ${MIN_WEIGHT}`);
console.log(`  Types:      ${TYPES.join(', ')}`);
console.log(`  Limit:      ${LIMIT || 'all'}`);
console.log(`  Dry run:    ${DRY_RUN}`);
console.log('');

// Resume state
let processed = new Set();
if (existsSync(STATE_FILE)) {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    processed = new Set(state.processed || []);
    console.log(`Resuming with ${processed.size} previously-processed node IDs.`);
  } catch (_) {}
}

const where = {
  weight: { gte: MIN_WEIGHT },
  type: { in: TYPES },
  // Exclude benchmark fixtures + bench data — same filter as bootstrap-persona
  NOT: {
    OR: [
      { chatJid: { startsWith: 'benchmark:' } },
      { tags: { array_contains: 'benchmark:locomo' } },
    ],
  },
};

const totalMatching = await prisma.memoryNode.count({ where });
const target = LIMIT ? Math.min(LIMIT, totalMatching) : totalMatching;
console.log(`Target: ${target} nodes (out of ${totalMatching} matching)\n`);

const PAGE_SIZE = 50;
let totalExtracted = 0, totalCreated = 0, totalUpdated = 0, totalSkipped = 0;
let nodesProcessedThisRun = 0;
const startedAt = Date.now();
let cursor = null;

while (nodesProcessedThisRun < target) {
  const page = await prisma.memoryNode.findMany({
    where,
    orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    take: PAGE_SIZE,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: { id: true, type: true, content: true, tags: true, weight: true },
  });
  if (page.length === 0) break;
  cursor = page[page.length - 1].id;

  const toProcess = page.filter(n => !processed.has(n.id)).slice(0, target - nodesProcessedThisRun);
  if (toProcess.length === 0) continue;

  const result = await typedEdges.extractBatch(toProcess, {
    dryRun: DRY_RUN,
    onNodeDone: (node, triples) => {
      processed.add(node.id);
    },
  });
  totalExtracted += result.totalTriples;
  totalCreated += result.totalCreated;
  totalUpdated += result.totalUpdated;
  totalSkipped += result.totalSkipped;
  nodesProcessedThisRun += toProcess.length;

  // Persist resume state
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      processed: Array.from(processed),
      stats: { totalExtracted, totalCreated, totalUpdated, totalSkipped },
      lastUpdated: new Date().toISOString(),
    }));
  } catch (_) {}

  const elapsedMin = (Date.now() - startedAt) / 60000;
  const rate = nodesProcessedThisRun / Math.max(elapsedMin, 0.01);
  console.log(`Progress: ${nodesProcessedThisRun}/${target} (${(nodesProcessedThisRun / target * 100).toFixed(1)}%) | triples ${totalExtracted} extracted, ${totalCreated} created, ${totalUpdated} updated, ${totalSkipped} skipped | ${rate.toFixed(0)} nodes/min`);
}

console.log('\n==============================================================');
console.log(' BACKFILL COMPLETE');
console.log('==============================================================');
console.log(`  Nodes processed: ${nodesProcessedThisRun}`);
console.log(`  Triples extracted: ${totalExtracted}`);
console.log(`  Edges created: ${totalCreated}`);
console.log(`  Edges updated: ${totalUpdated}`);
console.log(`  Skipped (unresolved entities): ${totalSkipped}`);
console.log(`  Wall time: ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
console.log('==============================================================');

await prisma.$disconnect();
