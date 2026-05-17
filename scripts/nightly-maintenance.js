#!/usr/bin/env node
/**
 * Sky Nightly Maintenance — runs Phase 2/3/4/5 jobs on a schedule.
 *
 * Schedule (cron): 0 3 * * *  (3am local)
 *
 * Jobs run in dependency order:
 *   1. Phase 4 — auto-promote network personas (creates new people facts)
 *   2. Phase 5 — auto-tag 1:1 chats (now possible because Phase 4 ran)
 *   3. Phase 2 — mine behavioural patterns over the last 7d
 *   4. Phase 3 — adjust persona-fact confidence based on validations
 *   5. Phase 2 — decay stale patterns
 *   6. Phase 1 — log trajectory state for top-N facts (for morning brief)
 *
 * Each job is wrapped in try/catch — one failure doesn't kill the chain.
 *
 * Usage:
 *   docker exec skymem node /app/scripts/nightly-maintenance.js
 *
 * Wire to host crontab:
 *   0 3 * * * docker exec skymem node /app/scripts/nightly-maintenance.js >> /var/log/sky-nightly.log 2>&1
 */

import prisma from '../sky/prisma-client.js';
import networkPersonas from '../sky/network-personas.js';
import chatTagging from '../sky/chat-tagging.js';
import behaviouralPatterns from '../sky/behavioural-patterns.js';
import personaValidation from '../sky/persona-validation.js';
import trajectories from '../sky/trajectories.js';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

const startedAt = new Date();
console.log(`[nightly] starting at ${startedAt.toISOString()} dry-run=${DRY_RUN}`);

const summary = { jobs: {}, errors: [] };

async function runJob(name, fn) {
  const t0 = Date.now();
  try {
    if (VERBOSE) console.log(`[nightly] ▶ ${name}`);
    const result = await fn();
    const elapsed = Date.now() - t0;
    summary.jobs[name] = { ok: true, elapsedMs: elapsed, result };
    console.log(`[nightly] ✓ ${name} (${elapsed}ms): ${JSON.stringify(result).slice(0, 200)}`);
  } catch (e) {
    const elapsed = Date.now() - t0;
    summary.jobs[name] = { ok: false, elapsedMs: elapsed, error: e.message };
    summary.errors.push({ job: name, error: e.message });
    console.error(`[nightly] ✗ ${name} (${elapsed}ms): ${e.message}`);
  }
}

// ── 1. Phase 4 promotion ─────────────────────────────────────────
await runJob('phase4-promote', async () => {
  const r = await networkPersonas.promoteAllCandidates({ dryRun: DRY_RUN, limit: 20 });
  return { promoted: r.promoted, evaluated: r.candidatesEvaluated };
});

// ── 2. Phase 5 chat-tag auto ────────────────────────────────────
await runJob('phase5-autotag', async () => {
  const r = await chatTagging.autoTagOneToOneChats({ dryRun: DRY_RUN });
  return r;
});

// ── 3. Phase 2 mine patterns ────────────────────────────────────
await runJob('phase2-patterns', async () => {
  const r = await behaviouralPatterns.runNightlySweep({ dryRun: DRY_RUN, sinceDays: 7 });
  return { totalWritten: r.totalWritten, categories: Object.keys(r.categories).length };
});

// ── 4. Phase 3 confidence adjustments ──────────────────────────
await runJob('phase3-confidence', async () => {
  const r = await personaValidation.adjustConfidences({ sinceDays: 7, dryRun: DRY_RUN });
  return { factsAdjusted: r.factsAdjusted, totalDelta: r.totalDelta };
});

// ── 5. Phase 2 decay stale ──────────────────────────────────────
await runJob('phase2-decay-stale', async () => {
  const r = await behaviouralPatterns.decayStalePatterns({ staleDays: 90 });
  return r;
});

// ── 6. Phase 1 trajectory snapshot for morning brief ────────────
await runJob('phase1-trajectory-snapshot', async () => {
  const interesting = await trajectories.getInterestingTrajectories({
    states: ['rising', 'declining', 'volatile'],
    minSlopeMag: 0.005,
    limit: 12,
  });
  return { count: interesting.length };
});

// ── Summary ─────────────────────────────────────────────────────
const elapsed = Date.now() - startedAt.getTime();
const okCount = Object.values(summary.jobs).filter(j => j.ok).length;
const failCount = summary.errors.length;
console.log('');
console.log(`[nightly] DONE ${elapsed}ms — ${okCount} ok, ${failCount} failed`);
if (failCount > 0) {
  console.log('[nightly] errors:');
  for (const e of summary.errors) console.log(`  - ${e.job}: ${e.error}`);
}

await prisma.$disconnect();
process.exit(failCount > 0 ? 1 : 0);
