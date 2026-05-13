#!/usr/bin/env node
/**
 * spot-mini-bench.js — Phase A.2 of EIGHTY-EIGHT-PLAN
 *
 * Builds and runs a STRATIFIED mini-bench from a reference run's failures.
 *
 * Two phases:
 *
 *   1. BUILD (one-time per reference run):
 *      Select N questions across cats from the reference run's failures,
 *      forming a locked test set that every future sprint runs against.
 *      Writes <out>.json with the question IDs + expected + per-conv metadata.
 *
 *   2. SCORE (per-sprint):
 *      Reads the locked set + a current run's chunk logs (or a freshly-run
 *      narrow bench), computes per-cat lift on the locked questions only.
 *      Replaces the 3-conv spot-test as the kick-full-bench gate.
 *
 * The strength: variance reduction. 140 stratified failure-bearing
 * questions deliver a tighter signal than running 600+ questions across
 * 3 random convs, in 10-15 min instead of 30-45 min.
 *
 * Usage:
 *   # Build the mini-bench from T4f's failures (run once):
 *   node scripts/spot-mini-bench.js build \
 *     --reference=t3fs-20260512-064522 \
 *     --counts=30,30,20,40,20 \
 *     --out=/app/bench/mini-bench-v1.json
 *
 *   # Score a new run against the locked set:
 *   node scripts/spot-mini-bench.js score \
 *     --mini=/app/bench/mini-bench-v1.json \
 *     --run=t7-cat4-diversity-spot
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const command = args[0]; // 'build' or 'score'
const flag = (name, defaultValue = null) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : defaultValue;
};

const BENCH_DIR = process.env.BENCH_DIR || '/app/bench';

// ────────────────────────────────────────────────────────────────
//  Shared: extract per-question results from chunk logs
// ────────────────────────────────────────────────────────────────
async function extractResults(runTag) {
  const allFiles = await readdir(BENCH_DIR);
  const chunkLogs = allFiles
    .filter(f => f.startsWith(`${runTag}-conv-`) && f.endsWith('.log'))
    .sort();

  if (chunkLogs.length === 0) {
    throw new Error(`No chunk logs for run ${runTag} in ${BENCH_DIR}`);
  }

  const results = [];
  for (const filename of chunkLogs) {
    const content = await readFile(path.join(BENCH_DIR, filename), 'utf8');
    const convMatch = filename.match(/(conv-\d+)-q\d+\.log$/);
    const conv = convMatch ? convMatch[1] : 'unknown';

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\d+\.\s*(✓|✗)\s*cat=(\d+)\s*"([^"\n]+)"/);
      if (!m) continue;
      const correct = m[1] === '✓';
      const cat = parseInt(m[2], 10);
      const question = m[3].trim();

      let expected = '', predicted = '';
      if (!correct) {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const ex = lines[j].match(/^\s*expected:\s*"([^"]*)"/);
          if (ex) expected = ex[1];
          const pr = lines[j].match(/^\s*predicted:\s*"([^"]*)"/);
          if (pr) predicted = pr[1];
        }
      }
      results.push({ conv, cat, question, expected, predicted, correct });
    }
  }
  return results;
}

// ────────────────────────────────────────────────────────────────
//  BUILD: select stratified failures from reference run
// ────────────────────────────────────────────────────────────────
async function buildMini() {
  const reference = flag('reference');
  const countsStr = flag('counts', '30,30,20,40,20');
  const outPath = flag('out') || path.join(BENCH_DIR, 'mini-bench-v1.json');

  if (!reference) {
    console.error('Usage: spot-mini-bench.js build --reference=<run-tag> [--counts=30,30,20,40,20] [--out=path]');
    process.exit(1);
  }

  const counts = countsStr.split(',').map(n => parseInt(n, 10));
  if (counts.length !== 5) {
    console.error('--counts must be 5 comma-separated numbers (cat=1,2,3,4,5)');
    process.exit(1);
  }

  console.log(`Building mini-bench from ${reference}...`);
  const results = await extractResults(reference);
  const failures = results.filter(r => !r.correct);
  const corrects = results.filter(r => r.correct);

  console.log(`  ${results.length} total questions, ${failures.length} failures`);

  // For each cat, prefer FAILURES first (the meaty signal), then NEAR-MISSES
  // (predicted answer non-empty, not "No information available"), then a
  // small fraction of CORRECT ones (preservation check).
  const picked = [];
  for (let i = 0; i < 5; i++) {
    const cat = i + 1;
    const target = counts[i];
    if (target <= 0) continue;

    const catFailures = failures.filter(f => f.cat === cat);
    const catCorrects = corrects.filter(c => c.cat === cat);

    // Sort failures: near-misses first (those with predicted ≠ abstention),
    // then abstentions, then anything else.
    const isAbstention = (s) => /no information available|don.t know|cannot determine/i.test(s);
    catFailures.sort((a, b) => {
      const aMiss = !isAbstention(a.predicted);
      const bMiss = !isAbstention(b.predicted);
      if (aMiss !== bMiss) return aMiss ? -1 : 1;
      return 0;
    });

    // Take 80% failures, 20% corrects (preservation check)
    const failTake = Math.min(catFailures.length, Math.floor(target * 0.8));
    const correctTake = Math.min(catCorrects.length, target - failTake);

    // Deterministic sample: take first N (sorted by conv,question for stability)
    const failSorted = [...catFailures].sort((a, b) => a.conv.localeCompare(b.conv) || a.question.localeCompare(b.question));
    const correctSorted = [...catCorrects].sort((a, b) => a.conv.localeCompare(b.conv) || a.question.localeCompare(b.question));

    picked.push(...failSorted.slice(0, failTake).map(r => ({ ...r, source: 'failure' })));
    picked.push(...correctSorted.slice(0, correctTake).map(r => ({ ...r, source: 'preservation' })));

    console.log(`  cat=${cat}: picked ${failTake} failures + ${correctTake} preservation = ${failTake + correctTake} (target ${target})`);
  }

  const mini = {
    name: 'mini-bench-v1',
    reference,
    builtAt: new Date().toISOString(),
    counts,
    totalQuestions: picked.length,
    questions: picked,
  };

  await writeFile(outPath, JSON.stringify(mini, null, 2));
  console.log(`\n✓ Mini-bench written: ${outPath}`);
  console.log(`  ${picked.length} questions total`);
  console.log(`  per-cat: ${[1,2,3,4,5].map(c => `cat=${c}:${picked.filter(p => p.cat === c).length}`).join(' · ')}`);
}

// ────────────────────────────────────────────────────────────────
//  SCORE: evaluate a current run against the locked mini-bench
// ────────────────────────────────────────────────────────────────
async function scoreMini() {
  const miniPath = flag('mini') || path.join(BENCH_DIR, 'mini-bench-v1.json');
  const runTag = flag('run');

  if (!runTag) {
    console.error('Usage: spot-mini-bench.js score --mini=<mini-file> --run=<run-tag>');
    process.exit(1);
  }
  if (!existsSync(miniPath)) {
    console.error(`Mini-bench not found: ${miniPath}. Build first with 'build' command.`);
    process.exit(1);
  }

  const mini = JSON.parse(await readFile(miniPath, 'utf8'));
  console.log(`Loaded mini-bench: ${mini.name} (${mini.totalQuestions} questions)`);

  console.log(`Loading current run: ${runTag}...`);
  const currResults = await extractResults(runTag);
  const currMap = new Map();
  for (const r of currResults) {
    const key = `${r.conv}|${r.cat}|${r.question}`;
    currMap.set(key, r);
  }
  console.log(`  ${currResults.length} questions in current run`);

  // Score the mini-bench questions against the current run
  const perCat = {};
  const missing = [];
  for (const q of mini.questions) {
    const key = `${q.conv}|${q.cat}|${q.question}`;
    const curr = currMap.get(key);

    if (!perCat[q.cat]) perCat[q.cat] = { total: 0, correct: 0, flippedToCorrect: 0, flippedToWrong: 0 };
    perCat[q.cat].total++;

    if (!curr) {
      missing.push(q);
      continue;
    }

    if (curr.correct) {
      perCat[q.cat].correct++;
      if (q.source === 'failure') perCat[q.cat].flippedToCorrect++;
    } else {
      if (q.source === 'preservation') perCat[q.cat].flippedToWrong++;
    }
  }

  // Render summary
  console.log(`\n========================================`);
  console.log(`  Mini-bench score for ${runTag}`);
  console.log(`========================================`);
  console.log(`Reference: ${mini.reference}`);
  console.log(`Missing from current run: ${missing.length}`);
  console.log('');
  console.log(`Cat | Score | Failures→correct | Correct→wrong`);
  console.log(`----|-------|------------------|---------------`);
  let totalScore = 0, totalQ = 0;
  for (const cat of [1, 2, 3, 4, 5]) {
    if (!perCat[cat]) continue;
    const p = perCat[cat];
    const pct = p.total ? (p.correct * 100 / p.total).toFixed(1) : 0;
    totalScore += p.correct;
    totalQ += p.total;
    console.log(`  ${cat} | ${p.correct}/${p.total} (${pct}%) | ${p.flippedToCorrect} | ${p.flippedToWrong}`);
  }
  const totalPct = totalQ ? (totalScore * 100 / totalQ).toFixed(2) : 0;
  console.log(`----|-------|------------------|---------------`);
  console.log(`ALL | ${totalScore}/${totalQ} (${totalPct}%) |`);
  console.log('');
  console.log(`Verdict criterion: target-cat flippedToCorrect > flippedToWrong AND total ≥ baseline.`);
  console.log(`Use the JSON output for programmatic PASS/FAIL gating per sprint.`);

  // Write JSON
  const outJson = path.join(BENCH_DIR, `${runTag}-mini-score.json`);
  await writeFile(outJson, JSON.stringify({
    runTag, miniBench: mini.name, reference: mini.reference,
    scoredAt: new Date().toISOString(),
    perCat,
    totals: { correct: totalScore, total: totalQ, pct: parseFloat(totalPct) },
    missing: missing.length,
  }, null, 2));
  console.log(`\n✓ JSON written: ${outJson}`);
}

// ────────────────────────────────────────────────────────────────
//  Main
// ────────────────────────────────────────────────────────────────
(async () => {
  if (command === 'build') {
    await buildMini();
  } else if (command === 'score') {
    await scoreMini();
  } else {
    console.error('Usage:');
    console.error('  spot-mini-bench.js build --reference=<run-tag> [--counts=30,30,20,40,20] [--out=path]');
    console.error('  spot-mini-bench.js score --mini=<mini-file> --run=<run-tag>');
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
