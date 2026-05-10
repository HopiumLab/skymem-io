#!/usr/bin/env node
/**
 * Backfill multi-axis temporal metadata over existing MemoryNode rows.
 *
 * The temporal-axes module (sky/temporal-axes.js) extracts eventTime /
 * mentionedAt / timeConfidence from each node. New nodes get this
 * automatically via createNode (after Day 3 wiring); existing nodes
 * predate the extraction.
 *
 * Cost: ~$0.0004/node (Haiku, ~300 in / ~80 out tokens).
 *   At 44k nodes: ~$18 total.
 *   At 4k high-weight nodes: ~$1.60.
 *
 * Strategy: process in pages of 50 by weight desc + createdAt desc.
 * Resume state file means it's interruptible.
 *
 * Usage:
 *   docker exec sky-bridge sh -c '
 *     export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s|@localhost:|@host.docker.internal:|g")
 *     node /app/scripts/backfill-temporal-axes.js [--limit=N] [--min-weight=W]
 *   '
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import prisma from '../sky/prisma-client.js';
import temporalAxes from '../sky/temporal-axes.js';

const ARGS = process.argv.slice(2);
const flag = (name, def = null) => {
  const a = ARGS.find(x => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  if (ARGS.includes(`--${name}`)) return true;
  return def;
};
const LIMIT = parseInt(flag('limit', '0'), 10) || null;
const MIN_WEIGHT = parseFloat(flag('min-weight', '0.3'));
const DRY_RUN = !!flag('dry-run');
const STATE_FILE = '/app/logs/backfill-temporal-axes.state.json';

console.log('==============================================================');
console.log(' Backfill multi-axis temporal metadata');
console.log('==============================================================');
console.log(`  Min weight: ${MIN_WEIGHT}`);
console.log(`  Limit:      ${LIMIT || 'all'}`);
console.log(`  Dry run:    ${DRY_RUN}`);
console.log('');

let processed = new Set();
if (existsSync(STATE_FILE)) {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    processed = new Set(state.processed || []);
    console.log(`Resuming with ${processed.size} previously-processed nodes.`);
  } catch (_) {}
}

const where = {
  weight: { gte: MIN_WEIGHT },
  // Skip noise types
  type: { notIn: ['log', 'system', 'enrichment'] },
  // Skip benchmark fixtures
  NOT: {
    OR: [
      { chatJid: { startsWith: 'benchmark:' } },
      { tags: { array_contains: 'benchmark:locomo' } },
    ],
  },
  // Already-processed nodes have eventTime set; skip them
  eventTime: null,
};

const totalMatching = await prisma.memoryNode.count({ where });
const target = LIMIT ? Math.min(LIMIT, totalMatching) : totalMatching;
console.log(`Target: ${target} nodes (out of ${totalMatching} matching)\n`);

const PAGE_SIZE = 50;
let extracted = 0, written = 0;
let nodesProcessed = 0;
const startedAt = Date.now();
let cursor = null;

while (nodesProcessed < target) {
  const page = await prisma.memoryNode.findMany({
    where,
    orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    take: PAGE_SIZE,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: { id: true, type: true, content: true, createdAt: true },
  });
  if (page.length === 0) break;
  cursor = page[page.length - 1].id;

  const toProcess = page.filter(n => !processed.has(n.id)).slice(0, target - nodesProcessed);
  if (toProcess.length === 0) continue;

  const r = await temporalAxes.backfillBatch(toProcess, {
    dryRun: DRY_RUN,
    onNodeDone: (n) => processed.add(n.id),
  });
  extracted += r.extracted;
  written += r.written;
  nodesProcessed += toProcess.length;

  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      processed: Array.from(processed),
      stats: { extracted, written },
      lastUpdated: new Date().toISOString(),
    }));
  } catch (_) {}

  const elapsedMin = (Date.now() - startedAt) / 60000;
  const rate = nodesProcessed / Math.max(elapsedMin, 0.01);
  console.log(`Progress: ${nodesProcessed}/${target} (${(nodesProcessed / target * 100).toFixed(1)}%) | extracted ${extracted}, written ${written} | ${rate.toFixed(0)} nodes/min`);
}

console.log('\n==============================================================');
console.log(' BACKFILL COMPLETE');
console.log('==============================================================');
console.log(`  Nodes processed: ${nodesProcessed}`);
console.log(`  Axes extracted:  ${extracted}`);
console.log(`  Rows written:    ${written}`);
console.log(`  Wall time: ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
console.log('==============================================================');

await prisma.$disconnect();
