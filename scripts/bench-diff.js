#!/usr/bin/env node
/**
 * bench-diff.js — Phase A.3 of EIGHTY-EIGHT-PLAN
 *
 * Paired question-level diff between two bench runs. Walks both runs'
 * chunk logs and produces four lists:
 *   - flipped_to_correct  (T_prev wrong, T_curr right) — THE actual lift
 *   - flipped_to_wrong    (T_prev right, T_curr wrong) — regression candidates
 *   - both_correct
 *   - both_wrong
 *
 * The aggregate number is less useful than which specific questions
 * flipped, and why. This makes sprint-to-sprint deltas concrete.
 *
 * Usage:
 *   node scripts/bench-diff.js --prev=t3fs-20260512-064522 --curr=t3fs-20260512-140201
 *   node scripts/bench-diff.js --prev=t3fs-... --curr=t3fs-... --cat=4
 *   node scripts/bench-diff.js --prev=t3fs-... --curr=t3fs-... --output=t5-vs-t4f-diff.md
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const args = process.argv.slice(2);
const flag = (name, defaultValue = null) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : defaultValue;
};

const PREV = flag('prev');
const CURR = flag('curr');
const CAT_FILTER = flag('cat');
const OUTPUT = flag('output');

if (!PREV || !CURR) {
  console.error('Usage: bench-diff.js --prev=<run-tag> --curr=<run-tag> [--cat=N] [--output=file.md]');
  process.exit(1);
}

const BENCH_DIR = process.env.BENCH_DIR || '/app/bench';

/**
 * Extract per-question results from a run's chunk logs.
 * Returns Map<key, {correct, cat, conv, question, expected, predicted}>
 * where key is `conv|cat|question` (question text serves as unique id within conv+cat).
 */
async function extractResults(runTag) {
  const allFiles = await readdir(BENCH_DIR);
  const chunkLogs = allFiles
    .filter(f => f.startsWith(`${runTag}-conv-`) && f.endsWith('.log'))
    .sort();

  if (chunkLogs.length === 0) {
    throw new Error(`No chunk logs found for run ${runTag}`);
  }

  const results = new Map();
  for (const filename of chunkLogs) {
    const content = await readFile(path.join(BENCH_DIR, filename), 'utf8');
    const convMatch = filename.match(/(conv-\d+)-q\d+\.log$/);
    const conv = convMatch ? convMatch[1] : 'unknown';

    // Two block shapes from bench-locomo:
    //   "  N. ✓ cat=C \"question\""          (correct, no expected/predicted lines)
    //   "  N. ✗ cat=C \"question\"\n     expected: \"E\"\n     predicted: \"P\""
    //
    // Walk line-by-line so we capture both.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\d+\.\s*(✓|✗)\s*cat=(\d+)\s*"([^"\n]+)"/);
      if (!m) continue;

      const mark = m[1];
      const cat = parseInt(m[2], 10);
      const question = m[3].trim();
      const correct = mark === '✓';

      let expected = '', predicted = '';
      if (!correct) {
        // Next two non-empty lines should be expected + predicted
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const ex = lines[j].match(/^\s*expected:\s*"([^"]*)"/);
          if (ex) expected = ex[1];
          const pr = lines[j].match(/^\s*predicted:\s*"([^"]*)"/);
          if (pr) predicted = pr[1];
        }
      }

      const key = `${conv}|${cat}|${question}`;
      results.set(key, { conv, cat, question, expected, predicted, correct });
    }
  }
  return results;
}

(async () => {
  console.log(`Loading results from ${PREV} ...`);
  const prevResults = await extractResults(PREV);
  console.log(`  ${prevResults.size} questions`);

  console.log(`Loading results from ${CURR} ...`);
  const currResults = await extractResults(CURR);
  console.log(`  ${currResults.size} questions`);

  // Walk all keys present in both runs
  const allKeys = new Set([...prevResults.keys(), ...currResults.keys()]);

  const flippedToCorrect = [];
  const flippedToWrong = [];
  const bothCorrect = [];
  const bothWrong = [];
  const onlyInOne = [];

  for (const key of allKeys) {
    const p = prevResults.get(key);
    const c = currResults.get(key);

    if (!p || !c) {
      onlyInOne.push({ key, in: p ? 'prev' : 'curr', row: p || c });
      continue;
    }
    if (CAT_FILTER && c.cat !== parseInt(CAT_FILTER, 10)) continue;

    const entry = {
      conv: c.conv, cat: c.cat, question: c.question,
      expected: c.expected || p.expected,
      prevPredicted: p.predicted,
      currPredicted: c.predicted,
    };

    if (p.correct && c.correct) bothCorrect.push(entry);
    else if (!p.correct && !c.correct) bothWrong.push(entry);
    else if (!p.correct && c.correct) flippedToCorrect.push(entry);
    else flippedToWrong.push(entry);
  }

  // Per-cat tallies
  const perCat = {};
  for (const cat of [1, 2, 3, 4, 5]) {
    perCat[cat] = {
      flippedToCorrect: flippedToCorrect.filter(e => e.cat === cat).length,
      flippedToWrong:   flippedToWrong.filter(e => e.cat === cat).length,
      bothCorrect:      bothCorrect.filter(e => e.cat === cat).length,
      bothWrong:        bothWrong.filter(e => e.cat === cat).length,
    };
  }

  // ── Render markdown ───────────────────────────────────────────
  const lines = [];
  lines.push(`# Bench diff: \`${PREV}\` → \`${CURR}\``);
  if (CAT_FILTER) lines.push(`\n_Filtered to cat=${CAT_FILTER}_`);
  lines.push('');
  lines.push(`**Summary:**`);
  lines.push(`- Flipped to CORRECT (the lift): **${flippedToCorrect.length}**`);
  lines.push(`- Flipped to WRONG (regressions): **${flippedToWrong.length}**`);
  lines.push(`- Both correct: ${bothCorrect.length}`);
  lines.push(`- Both wrong: ${bothWrong.length}`);
  lines.push(`- Net change: **${flippedToCorrect.length - flippedToWrong.length > 0 ? '+' : ''}${flippedToCorrect.length - flippedToWrong.length}** questions`);
  lines.push(`- Only in one run: ${onlyInOne.length}`);
  lines.push('');

  lines.push('## Per-category breakdown');
  lines.push('');
  lines.push('| Cat | Flipped→correct | Flipped→wrong | Both correct | Both wrong | Net |');
  lines.push('|---|---|---|---|---|---|');
  for (const cat of [1, 2, 3, 4, 5]) {
    const p = perCat[cat];
    const net = p.flippedToCorrect - p.flippedToWrong;
    const netStr = (net > 0 ? '+' : '') + net;
    lines.push(`| cat=${cat} | ${p.flippedToCorrect} | ${p.flippedToWrong} | ${p.bothCorrect} | ${p.bothWrong} | ${netStr} |`);
  }
  lines.push('');

  // ── Flipped-to-correct (the lift) ─────────────────────────────
  lines.push(`## Flipped to CORRECT (${flippedToCorrect.length}) — the real lift`);
  lines.push('');
  if (flippedToCorrect.length === 0) {
    lines.push('_No questions flipped to correct._');
  } else {
    for (const e of flippedToCorrect.slice(0, 50)) {
      lines.push(`### ${e.conv} · cat=${e.cat}`);
      lines.push(`> ${e.question}`);
      lines.push(`- Expected: ${e.expected || '_(not captured)_'}`);
      lines.push(`- Prev predicted: \`${e.prevPredicted || '_(not captured)_'}\``);
      lines.push(`- Curr predicted: \`${e.currPredicted || '_(correct, not captured)_'}\``);
      lines.push('');
    }
    if (flippedToCorrect.length > 50) {
      lines.push(`_…and ${flippedToCorrect.length - 50} more (full list in JSON output)._`);
      lines.push('');
    }
  }

  // ── Flipped-to-wrong (regression candidates) ──────────────────
  lines.push(`## Flipped to WRONG (${flippedToWrong.length}) — regression candidates`);
  lines.push('');
  if (flippedToWrong.length === 0) {
    lines.push('_No questions flipped to wrong._');
  } else {
    for (const e of flippedToWrong.slice(0, 50)) {
      lines.push(`### ${e.conv} · cat=${e.cat}`);
      lines.push(`> ${e.question}`);
      lines.push(`- Expected: ${e.expected || '_(not captured)_'}`);
      lines.push(`- Prev predicted: \`${e.prevPredicted || '_(correct, not captured)_'}\``);
      lines.push(`- Curr predicted: \`${e.currPredicted || '_(not captured)_'}\``);
      lines.push('');
    }
    if (flippedToWrong.length > 50) {
      lines.push(`_…and ${flippedToWrong.length - 50} more._`);
      lines.push('');
    }
  }

  const md = lines.join('\n');
  const outPath = OUTPUT
    ? (path.isAbsolute(OUTPUT) ? OUTPUT : path.join(BENCH_DIR, OUTPUT))
    : path.join(BENCH_DIR, `bench-diff-${PREV}-vs-${CURR}.md`);
  await writeFile(outPath, md);

  // Also write JSON for downstream use
  const jsonOut = outPath.replace(/\.md$/, '.json');
  await writeFile(jsonOut, JSON.stringify({
    prev: PREV, curr: CURR, generatedAt: new Date().toISOString(),
    summary: {
      flippedToCorrect: flippedToCorrect.length,
      flippedToWrong: flippedToWrong.length,
      bothCorrect: bothCorrect.length,
      bothWrong: bothWrong.length,
      onlyInOne: onlyInOne.length,
      netChange: flippedToCorrect.length - flippedToWrong.length,
    },
    perCat,
    flippedToCorrect, flippedToWrong,
  }, null, 2));

  console.log(`\n✓ Markdown: ${outPath}`);
  console.log(`✓ JSON:     ${jsonOut}`);
  console.log(`\nNet: ${flippedToCorrect.length - flippedToWrong.length} (${flippedToCorrect.length} gained, ${flippedToWrong.length} lost)`);
})().catch(e => { console.error(e); process.exit(1); });
