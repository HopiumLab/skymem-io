#!/usr/bin/env node
/**
 * Bootstrap Persona — Phase 0 (2026-05-08).
 *
 * One-shot script that runs the LLM-driven extractor over the existing
 * MemoryNode corpus (~44k rows) to seed PersonaFact records.
 *
 * Strategy:
 *   1. Pull nodes in pages, filtered to "interesting" types + non-trivial
 *      weight (skip log/system/raw chat nodes that don't carry persona
 *      signal)
 *   2. Sort by weight desc + createdAt desc — the strongest, freshest
 *      signals get processed first. If we run out of budget mid-flight,
 *      we already have the highest-quality facts.
 *   3. Batch into groups of 25 (configurable) and call the extractor.
 *      Each batch = one Haiku call. At ~$0.0015/batch and ~25 nodes/batch,
 *      44k nodes → ~1760 batches → ~$2.65 + ~30 minutes.
 *   4. Persist progress to a state file so re-running picks up where it
 *      stopped (idempotent — same node won't be re-extracted in the same
 *      run, but PersonaFact.upsert handles re-extraction safely anyway).
 *   5. Print live progress + final stats.
 *
 * Run via:
 *   docker exec skymem sh -c '
 *     export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e "s|@localhost:|@host.docker.internal:|g")"
 *     node /app/scripts/bootstrap-persona.js [--limit=N] [--dry-run] [--batch-size=25] [--min-weight=0.25]
 *   '
 *
 *   --limit=N         Process at most N nodes (default: all)
 *   --batch-size=N    Nodes per LLM call (default 25)
 *   --min-weight=W    Skip nodes below this weight (default 0.25)
 *   --dry-run         Extract but don't write to PersonaFact
 *   --types=t1,t2     Restrict to specific node types
 *   --skip-types=...  Skip these types (default: log,system,enrichment)
 *   --resume          Resume from state file
 *   --state-file=PATH Path to state JSON (default ./logs/bootstrap-persona.state.json)
 *   --verbose         Log raw LLM responses
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import prisma from '../sky/prisma-client.js';
import extractor from '../sky/persona-extractor.js';
import persona from '../sky/persona.js';

// ============================================================
// ARGS
// ============================================================
const ARGS = process.argv.slice(2);
function flag(name, defaultValue = null) {
  const a = ARGS.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  if (ARGS.includes(`--${name}`)) return true;
  return defaultValue;
}

const LIMIT = parseInt(flag('limit', '0'), 10) || null;
const BATCH_SIZE = parseInt(flag('batch-size', '25'), 10);
const MIN_WEIGHT = parseFloat(flag('min-weight', '0.25'));
const DRY_RUN = !!flag('dry-run', false);
const VERBOSE = !!flag('verbose', false);
const RESUME = !!flag('resume', false);
const STATE_FILE = resolve(flag('state-file', 'logs/bootstrap-persona.state.json'));
const TYPES = flag('types', null);
const SKIP_TYPES = flag('skip-types', 'log,system,enrichment');

const PAGE_SIZE = 200; // DB page size; smaller than total but multiple LLM batches per page

// ============================================================
// STATE
// ============================================================

function loadState() {
  if (!RESUME) return { processedNodeIds: [], stats: null };
  if (!existsSync(STATE_FILE)) {
    console.log(`[bootstrap] --resume but no state at ${STATE_FILE} — starting fresh.`);
    return { processedNodeIds: [], stats: null };
  }
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      processedNodeIds: parsed.processedNodeIds || [],
      stats: parsed.stats || null,
    };
  } catch (e) {
    console.warn(`[bootstrap] failed to read state ${STATE_FILE}: ${e.message}`);
    return { processedNodeIds: [], stats: null };
  }
}

function saveState(state) {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`[bootstrap] failed to save state: ${e.message}`);
  }
}

// ============================================================
// QUERY BUILDER
// ============================================================

function buildWhere() {
  const where = {
    weight: { gte: MIN_WEIGHT },
    // CRITICAL: exclude benchmark fixture data. The LOCOMO bench seeds the
    // graph with synthetic Caroline/Melanie conversations at weight 1.0 —
    // they outrank everything in a "weight desc" pull. Without this filter
    // the extractor wastes batches asking Haiku to pull persona facts about
    // the user from chats he isn't in.
    NOT: {
      OR: [
        { chatJid: { startsWith: 'benchmark:' } },
        { tags: { array_contains: 'benchmark:locomo' } },
      ],
    },
  };

  if (TYPES) {
    where.type = { in: TYPES.split(',').map((s) => s.trim()).filter(Boolean) };
  } else if (SKIP_TYPES) {
    const skip = SKIP_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
    if (skip.length) where.type = { notIn: skip };
  }
  return where;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('================================================================');
  console.log('  BOOTSTRAP PERSONA — Phase 0');
  console.log('================================================================');
  console.log(`  Batch size: ${BATCH_SIZE} nodes/LLM call`);
  console.log(`  Min weight: ${MIN_WEIGHT}`);
  console.log(`  Limit:      ${LIMIT ?? 'unlimited'}`);
  console.log(`  Skip types: ${SKIP_TYPES}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  Resume:     ${RESUME} (state: ${STATE_FILE})`);
  console.log('================================================================\n');

  const state = loadState();
  const seen = new Set(state.processedNodeIds);
  if (seen.size > 0) {
    console.log(`[bootstrap] Resuming with ${seen.size} previously-processed nodes.`);
  }

  const where = buildWhere();
  const totalMatching = await prisma.memoryNode.count({ where });
  const target = LIMIT ? Math.min(LIMIT, totalMatching) : totalMatching;
  console.log(`[bootstrap] ${totalMatching} nodes match filter; targeting ${target}.`);

  if (target === 0) {
    console.log('[bootstrap] Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  // Cost estimate
  const estBatches = Math.ceil(target / BATCH_SIZE);
  const estCost = estBatches * 0.0015;
  console.log(`[bootstrap] Est. ${estBatches} batches → ~$${estCost.toFixed(2)} (Haiku)\n`);

  let processedNodes = 0;
  let totalRawFacts = 0;
  let totalWritten = 0;
  const byDomainTotal = Object.fromEntries(persona.DOMAINS.map((d) => [d, 0]));
  const startedAt = Date.now();

  // Cursor pagination over nodes, ordered by weight desc + createdAt desc
  // so highest-signal facts land first.
  let cursor = null;

  while (processedNodes < target) {
    const remaining = target - processedNodes;
    const take = Math.min(PAGE_SIZE, remaining + (seen.size % PAGE_SIZE));

    const page = await prisma.memoryNode.findMany({
      where,
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
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

    if (page.length === 0) {
      console.log('[bootstrap] No more nodes returned — done.');
      break;
    }

    cursor = page[page.length - 1].id;

    // Filter out anything already-seen on resume
    const fresh = page.filter((n) => !seen.has(n.id));
    if (fresh.length === 0) continue;

    // Cap to remaining
    const toProcess = fresh.slice(0, target - processedNodes);

    // Run extractor over this page
    const summary = await extractor.extractNodes(toProcess, {
      batchSize: BATCH_SIZE,
      dryRun: DRY_RUN,
      verbose: VERBOSE,
      onBatchDone: ({ index, totalBatches }) => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const ratePerNode = elapsed / Math.max(processedNodes + (index + 1) * BATCH_SIZE, 1);
        const remainingNodes = target - (processedNodes + (index + 1) * BATCH_SIZE);
        const etaSec = Math.max(remainingNodes * ratePerNode, 0);
        process.stdout.write(
          `   page-batch ${index + 1}/${totalBatches} | total-eta ${(etaSec / 60).toFixed(1)} min\n`
        );
      },
    });

    processedNodes += toProcess.length;
    totalRawFacts += summary.factsExtractedRaw;
    totalWritten += summary.factsWritten;
    for (const dom of persona.DOMAINS) byDomainTotal[dom] += summary.byDomain[dom] || 0;

    // Persist progress
    for (const n of toProcess) seen.add(n.id);
    saveState({
      processedNodeIds: Array.from(seen),
      stats: {
        processedNodes,
        totalRawFacts,
        totalWritten,
        byDomain: byDomainTotal,
        lastUpdated: new Date().toISOString(),
      },
    });

    const elapsedMin = (Date.now() - startedAt) / 60000;
    const ratePerMin = processedNodes / Math.max(elapsedMin, 0.01);
    console.log(
      `[bootstrap] progress: ${processedNodes}/${target} nodes (${((processedNodes / target) * 100).toFixed(1)}%) | ` +
        `${totalRawFacts} raw / ${totalWritten} written | ${ratePerMin.toFixed(0)} nodes/min`
    );
  }

  // Final stats — pull live persona counts from DB so we see the actual end state
  let liveStats = null;
  if (!DRY_RUN) {
    try {
      liveStats = await persona.stats();
    } catch (e) {
      console.warn(`[bootstrap] persona.stats() failed: ${e.message}`);
    }
  }

  console.log('\n================================================================');
  console.log('  BOOTSTRAP COMPLETE');
  console.log('================================================================');
  console.log(`  Processed nodes:     ${processedNodes}`);
  console.log(`  Raw facts (LLM out): ${totalRawFacts}`);
  console.log(`  Facts written:       ${totalWritten}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  By domain:`);
  for (const [dom, n] of Object.entries(byDomainTotal)) {
    console.log(`    - ${dom.padEnd(12)} ${n}`);
  }
  if (liveStats) {
    console.log(`\n  Live PersonaFact count:  ${liveStats.totalFacts}`);
    console.log(`  Avg confidence:          ${(Number(liveStats.avgConfidence) || 0).toFixed(2)}`);
    console.log(`  Total revisions logged:  ${liveStats.totalRevisions}`);
  }
  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`\n  Wall time: ${(totalSec / 60).toFixed(1)} min`);
  console.log('================================================================\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[bootstrap] FAILED:', e);
  process.exit(1);
});
