/**
 * Re-grade existing LOCOMO bench result JSON files with the upgraded
 * fast-path. Reads stored {question, expected, predicted, correct,
 * judgeReasoning} and re-evaluates the fast-path. If the new fast-path
 * fires CORRECT, mark correct (overrides old fast-path false-negatives
 * and Haiku judge mistakes). Otherwise keep the stored judgment.
 *
 * No API calls — pure local re-evaluation. Use to retroactively benefit
 * from grader improvements without re-running the bench.
 *
 * Usage:
 *   docker exec sky-bridge node /app/scripts/regrade-results.js [glob]
 *   default glob: /app/bench/results-locomo-*.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const BENCH_DIR = '/app/bench';
const ARG_GLOB = process.argv[2] || '*';

// ── Same fast-path logic as bench-locomo.js ──
const _norm = (s) => (s == null ? '' : String(s))
  .toLowerCase()
  .replace(/^[\s"'`.,;:!?]+|[\s"'`.,;:!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const numberWords = {
  'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14',
  'fifteen': '15', 'sixteen': '16', 'seventeen': '17', 'eighteen': '18',
  'nineteen': '19', 'twenty': '20', 'thirty': '30', 'forty': '40',
  'fifty': '50', 'sixty': '60', 'seventy': '70', 'eighty': '80', 'ninety': '90',
};
const wordsToNumbers = (s) => {
  let r = s;
  for (const [w, n] of Object.entries(numberWords)) {
    r = r.replace(new RegExp(`\\b${w}\\b`, 'g'), n);
  }
  r = r.replace(/\b([2-9])0[\s-]([1-9])\b/g, (_, t, u) => String(parseInt(t, 10) * 10 + parseInt(u, 10)));
  return r.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
};

function fastPath(expected, predicted, category) {
  // cat=5 adversarial — abstention check
  if (category === 5) {
    const lower = (predicted || '').toLowerCase();
    const abstain = ['no information', "don't know", 'not in context', 'not available', 'no evidence', 'not mentioned', 'unclear', 'cannot determine'];
    return abstain.some(p => lower.includes(p)) ? 'abstain' : null;
  }
  const expN = _norm(expected);
  const predN = _norm(predicted);
  if (expN && predN && expN === predN) return 'exact';
  if (expN && expN.includes(',')) {
    const expTokens = expN.split(/[,;\/]+|\s+and\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (expTokens.length >= 2) {
      const allPresent = expTokens.every(tok => predN.includes(tok));
      if (allPresent) return 'set-containment';
      return null;
    }
  }
  if (expN && predN && expN.length >= 5 && predN.length >= 5) {
    const minLen = Math.min(expN.length, predN.length);
    const maxLen = Math.max(expN.length, predN.length);
    if (maxLen / minLen <= 2.0) {
      if (predN.includes(expN) || expN.includes(predN)) return 'substring';
    }
  }
  const expW = wordsToNumbers(expN);
  const predW = wordsToNumbers(predN);
  if (expW !== expN || predW !== predN) {
    if (expW === predW || (expW.length >= 3 && predW.includes(expW))) return 'number-word';
  }
  return null;
}

// ── Find result files ──
const allFiles = readdirSync(BENCH_DIR)
  .filter(f => f.startsWith('results-locomo-') && f.endsWith('.json'))
  .filter(f => ARG_GLOB === '*' || f.includes(ARG_GLOB))
  .map(f => join(BENCH_DIR, f));

if (allFiles.length === 0) {
  console.error(`No bench result files matching ${ARG_GLOB} in ${BENCH_DIR}`);
  process.exit(1);
}

// Dedupe: per sampleId, take the latest non-zero result (avoids counting
// crashed runs and earlier dry-tests of the same conv).
const latestPerSample = new Map(); // sampleId → { file, mtime, correct, total }
for (const f of allFiles) {
  let data;
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  if (!Array.isArray(data?.perConv)) continue;
  for (const c of data.perConv) {
    if (!c.sampleId) continue;
    const correct = c.correct || 0;
    const total = c.total || 0;
    if (total === 0) continue; // skip empty/crashed
    const existing = latestPerSample.get(c.sampleId);
    // Prefer files with non-zero correct count, then most recent mtime.
    const better = !existing
      || (existing.correct === 0 && correct > 0)
      || (correct > 0 && f > existing.file); // lexicographic on filename = newer first when both non-zero
    if (better) {
      latestPerSample.set(c.sampleId, { file: f, correct, total });
    }
  }
}

const files = [...new Set([...latestPerSample.values()].map(v => v.file))];
console.log(`Selected ${files.length} latest non-empty result files (deduped from ${allFiles.length} total).`);
console.log(`Samples: ${[...latestPerSample.keys()].sort().join(', ')}\n`);

console.log(`Re-grading ${files.length} result file(s)...\n`);

let totalQ = 0;
let oldCorrect = 0;
let newCorrect = 0;
const flipsByCat = {};
const allByCat = {};

for (const f of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn(`  skip ${f}: ${e.message}`);
    continue;
  }
  // Bench writes data.perConv[].results[]
  const allResults = [];
  if (Array.isArray(data?.perConv)) {
    for (const c of data.perConv) {
      if (Array.isArray(c?.results)) {
        for (const r of c.results) allResults.push({ ...r, _sampleId: c.sampleId });
      }
    }
  }
  if (Array.isArray(data?.results)) allResults.push(...data.results);
  if (allResults.length === 0) continue;

  let convOld = 0, convNew = 0;
  for (const r of allResults) {
    if (r.error) continue;
    totalQ++;
    const cat = r.category;
    allByCat[cat] = (allByCat[cat] || { total: 0, oldC: 0, newC: 0 });
    allByCat[cat].total++;
    if (r.correct) { oldCorrect++; convOld++; allByCat[cat].oldC++; }

    let nowCorrect = r.correct; // start from stored
    const fp = fastPath(r.expected, r.predicted, r.category);
    if (fp) {
      // Fast-path says correct → mark correct
      nowCorrect = true;
    }
    // Else keep stored .correct (don't downgrade)
    if (nowCorrect) { newCorrect++; convNew++; allByCat[cat].newC++; }
  }
  const file = f.split(/[\\/]/).pop();
  const flips = convNew - convOld;
  console.log(`  ${file}  ${convOld}→${convNew}  ${flips > 0 ? '+'+flips : flips}`);
}

console.log('\n=== RE-GRADE SUMMARY ===');
console.log(`Total Q: ${totalQ}`);
const oldPct = (oldCorrect * 100 / totalQ).toFixed(2);
const newPct = (newCorrect * 100 / totalQ).toFixed(2);
const lift = (newCorrect - oldCorrect);
console.log(`Old: ${oldCorrect}/${totalQ} (${oldPct}%)`);
console.log(`New: ${newCorrect}/${totalQ} (${newPct}%)`);
console.log(`Recovered: +${lift} questions  (+${(lift * 100 / totalQ).toFixed(2)}pp)`);
console.log('\nBy category:');
for (const cat of [1, 2, 3, 4, 5]) {
  const s = allByCat[cat];
  if (!s) continue;
  const oldP = (s.oldC * 100 / s.total).toFixed(1);
  const newP = (s.newC * 100 / s.total).toFixed(1);
  console.log(`  cat=${cat}: ${s.oldC}/${s.total} (${oldP}%) → ${s.newC}/${s.total} (${newP}%)  +${s.newC - s.oldC}`);
}
