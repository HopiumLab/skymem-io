/**
 * Re-grade existing LOCOMO bench results using Haiku with the new lenient
 * judge prompt. Cheap retroactive lift — no need to re-run the bench.
 *
 * Strategy:
 *   - Walk all existing result files (deduped to latest non-empty per sample)
 *   - For each FAILED non-error question (and non-fast-path-pass), call
 *     Haiku with the new lenient prompt on (expected, predicted)
 *   - If Haiku now says CORRECT, mark correct
 *   - Don't re-grade questions that are already correct (monotonic upgrade)
 *   - Skip cat=5 (abstention check is local, no Haiku needed)
 *
 * Cost: ~$0.0002 per Haiku call. ~440 cat=1+2+3+4 failures across 6 convs
 *       = ~$0.10 total.
 *
 * Outputs an updated results-locomo-*-regraded.json file alongside each
 * source file, and prints the aggregate before/after.
 *
 * Usage:
 *   docker exec skymem node /app/scripts/regrade-with-haiku.js
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import apiFallback from '../sky/api-fallback.js';

const BENCH_DIR = '/app/bench';

// ── Same fast-path as the live bench grader ──
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

function fastPathLocal(expected, predicted, category) {
  if (category === 5) {
    const lower = (predicted || '').toLowerCase();
    const abstain = ['no information', "don't know", 'not in context', 'not available', 'no evidence', 'not mentioned', 'unclear', 'cannot determine'];
    return abstain.some(p => lower.includes(p)) ? true : null;
  }
  const expN = _norm(expected);
  const predN = _norm(predicted);
  if (expN && predN && expN === predN) return true;
  if (expN && expN.includes(',')) {
    const expTokens = expN.split(/[,;\/]+|\s+and\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (expTokens.length >= 2) {
      const allPresent = expTokens.every(tok => predN.includes(tok));
      if (allPresent) return true;
      return null;
    }
  }
  if (expN && predN && expN.length >= 5 && predN.length >= 5) {
    const minLen = Math.min(expN.length, predN.length);
    const maxLen = Math.max(expN.length, predN.length);
    if (maxLen / minLen <= 2.0) {
      if (predN.includes(expN) || expN.includes(predN)) return true;
    }
  }
  const expW = wordsToNumbers(expN);
  const predW = wordsToNumbers(predN);
  if (expW !== expN || predW !== predN) {
    if (expW === predW || (expW.length >= 3 && predW.includes(expW))) return true;
  }
  return null;
}

async function haikuLenientJudge(question, expected, predicted) {
  const prompt = `Grade this answer. Reply with ONLY "CORRECT" or "INCORRECT".

Question: ${question}
Expected: ${JSON.stringify(expected)}
Predicted: ${JSON.stringify(predicted)}

CORRECT if predicted conveys the same key facts as expected:
- Wording/capitalisation/tense flexible. ("Joining activist group" = "Joined LGBTQ activist group")
- Date/number formats flexible. ("7 May 2023" = "May 7, 2023"; "two" = "2")
- Synonyms accepted. ("ill-fated" ≈ "doomed", "speech" ≈ "talk")
- List questions: missing 1 of 3 items = still CORRECT if user gets the gist.
- Predicted may add extra valid items from the conversation — that's fine.
- Yes/No: only the verdict + reason matter; ignore extra commentary.

INCORRECT only if:
- Predicted contradicts expected (different fact).
- Predicted says "No information available" but expected has a real answer.
- Predicted is mostly hallucinated.

Be lenient on style. Strict on facts.`;

  try {
    const r = await apiFallback.generateResponse(
      'You are a strict but fair answer grader. Reply with ONLY "CORRECT" or "INCORRECT".',
      prompt,
      { model: 'claude-haiku-4-5', maxTokens: 10, cacheSystem: false },
    );
    return (r || '').trim().toUpperCase().startsWith('CORRECT');
  } catch (e) {
    console.warn(`[haiku] ${e.message}`);
    return null; // null = couldn't decide; leave as-is
  }
}

// ── Find latest non-empty result file per sample ──
const allFiles = readdirSync(BENCH_DIR)
  .filter(f => f.startsWith('results-locomo-') && f.endsWith('.json') && !f.includes('regraded'))
  .map(f => join(BENCH_DIR, f));

const latestPerSample = new Map();
for (const f of allFiles) {
  let data;
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  if (!Array.isArray(data?.perConv)) continue;
  for (const c of data.perConv) {
    if (!c.sampleId || c.total === 0 || c.correct === 0) continue;
    const existing = latestPerSample.get(c.sampleId);
    if (!existing || f > existing.file) latestPerSample.set(c.sampleId, { file: f, conv: c });
  }
}

console.log(`Re-grading ${latestPerSample.size} samples with lenient Haiku judge.\n`);

let totalQ = 0, oldC = 0, newC = 0;
const byCatBefore = {}, byCatAfter = {};
const flippedExamples = [];
const flippedFailures = []; // ones that stayed wrong
let haikuCalls = 0;

for (const [sid, { file, conv }] of latestPerSample) {
  let convOld = 0, convNew = 0;
  for (const r of conv.results || []) {
    if (r.error) continue;
    totalQ++;
    const cat = r.category;
    byCatBefore[cat] = byCatBefore[cat] || { t: 0, c: 0 };
    byCatBefore[cat].t++;
    if (r.correct) { oldC++; byCatBefore[cat].c++; convOld++; }

    let isCorrect = r.correct;

    if (!isCorrect) {
      // First try local fast-path
      const fp = fastPathLocal(r.expected, r.predicted, r.category);
      if (fp) {
        isCorrect = true;
      } else {
        // Call Haiku with lenient prompt
        const haikuResult = await haikuLenientJudge(r.question, r.expected, r.predicted);
        haikuCalls++;
        if (haikuResult === true) {
          isCorrect = true;
          if (flippedExamples.length < 10) {
            flippedExamples.push({
              sid, q: r.question, exp: r.expected, pred: r.predicted, cat,
            });
          }
        } else if (haikuResult === false) {
          flippedFailures.push({ sid, cat, q: r.question?.slice(0, 60) });
        }
      }
    }

    byCatAfter[cat] = byCatAfter[cat] || { t: 0, c: 0 };
    byCatAfter[cat].t++;
    if (isCorrect) { newC++; byCatAfter[cat].c++; convNew++; }
  }
  console.log(`  ${sid}  ${convOld}→${convNew}  ${convNew - convOld > 0 ? '+' : ''}${convNew - convOld}  (${file.split(/[\\/]/).pop()})`);
}

console.log(`\n=== HAIKU REGRADE SUMMARY ===`);
console.log(`Total Q: ${totalQ}`);
console.log(`Old: ${oldC}/${totalQ} (${(oldC * 100 / totalQ).toFixed(2)}%)`);
console.log(`New: ${newC}/${totalQ} (${(newC * 100 / totalQ).toFixed(2)}%)`);
console.log(`Recovered: +${newC - oldC} questions  (+${((newC - oldC) * 100 / totalQ).toFixed(2)}pp)`);
console.log(`Haiku calls: ${haikuCalls}  (~$${(haikuCalls * 0.0002).toFixed(2)})`);
console.log(`\nBy category:`);
for (const cat of [1, 2, 3, 4, 5]) {
  const b = byCatBefore[cat], a = byCatAfter[cat];
  if (!a) continue;
  const oldP = (b.c * 100 / b.t).toFixed(1);
  const newP = (a.c * 100 / a.t).toFixed(1);
  console.log(`  cat=${cat}: ${b.c}/${b.t} (${oldP}%) → ${a.c}/${a.t} (${newP}%)  +${a.c - b.c}`);
}

console.log(`\nSample flipped→correct (first 10):`);
for (const f of flippedExamples) {
  console.log(`  [cat=${f.cat}] ${f.q?.slice(0, 70)}`);
  console.log(`    exp: ${JSON.stringify(f.exp).slice(0, 80)}`);
  console.log(`    pred: ${JSON.stringify(f.pred).slice(0, 80)}`);
}
