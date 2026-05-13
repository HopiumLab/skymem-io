#!/usr/bin/env node
/**
 * classify-failures.js — Phase A.1 of EIGHTY-EIGHT-PLAN
 *
 * Reads a bench run's chunk logs, extracts every FAILED question (with its
 * expected + predicted answer), classifies each into the A-J taxonomy via
 * Haiku 4.5, writes:
 *   - <run-tag>-failures.json  full classification data
 *   - <run-tag>-failures.md    summary table by cat × bucket
 *
 * Usage:
 *   node scripts/classify-failures.js --run=t3fs-20260512-064522
 *   node scripts/classify-failures.js --run=t3fs-20260512-064522 --limit=50
 *   node scripts/classify-failures.js --run=t3fs-20260512-064522 --dry-run
 *
 * Taxonomy:
 *   A. Extraction missing       — fact never extracted from source
 *   B. Extracted not indexed    — fact extracted, lost in storage
 *   C. Indexed not retrieved    — fact stored, retrieval didn't surface it
 *   D. Retrieved not used       — fact in context, LLM ignored it
 *   E. Used but answer wrong    — right info, wrong format
 *   F. Temporal normalization   — date arithmetic failed
 *   G. Entity/alias mismatch    — name resolution failed
 *   H. Multi-hop intermediate   — hop 1 or 2 missed
 *   I. Grader mismatch          — answer correct, grader marked wrong
 *   J. Actually impossible      — ambiguous/missing in source
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── Args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, defaultValue = null) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : defaultValue;
};
const hasFlag = (name) => args.some(a => a === `--${name}`);

const RUN_TAG = flag('run');
const LIMIT = parseInt(flag('limit', '0'), 10);
const DRY_RUN = hasFlag('dry-run');

if (!RUN_TAG) {
  console.error('Usage: classify-failures.js --run=<run-tag> [--limit=N] [--dry-run]');
  process.exit(1);
}

const BENCH_DIR = process.env.BENCH_DIR || '/app/bench';
const OUT_JSON = path.join(BENCH_DIR, `${RUN_TAG}-failures.json`);
const OUT_MD = path.join(BENCH_DIR, `${RUN_TAG}-failures.md`);

// ── Extract failures from chunk logs ─────────────────────────────
//
// Chunk log format (from bench-locomo.js):
//   1. ✗ cat=2 "Which year did Audrey adopt the first three of her dogs?"
//      expected: "2020"
//      predicted: "No information available"
//   2. ✓ cat=2 "When did Andrew start his new job as a financial analyst?"
//
// We capture ✗ entries with their expected + predicted.
async function extractFailures(runTag) {
  const allFiles = await readdir(BENCH_DIR);
  const chunkLogs = allFiles
    .filter(f => f.startsWith(`${runTag}-conv-`) && f.endsWith('.log'))
    .sort();

  if (chunkLogs.length === 0) {
    throw new Error(`No chunk logs found for run ${runTag} in ${BENCH_DIR}`);
  }

  console.log(`Reading ${chunkLogs.length} chunk logs for ${runTag}...`);

  const failures = [];
  for (const filename of chunkLogs) {
    const filepath = path.join(BENCH_DIR, filename);
    const content = await readFile(filepath, 'utf8');

    // Extract conv-id from filename: t3fs-...-conv-26-q0.log → conv-26
    const convMatch = filename.match(/(conv-\d+)-q\d+\.log$/);
    const convId = convMatch ? convMatch[1] : 'unknown';

    // Block format:
    //       N. ✗ cat=C "question text"
    //          expected: "..."
    //          predicted: "..."
    const failureRe = /^\s*\d+\.\s*✗\s*cat=(\d+)\s*"([^"\n]+)"\s*\n\s*expected:\s*"([^"]*)"\s*\n\s*predicted:\s*"([^"\n]*)"/gm;

    let m;
    while ((m = failureRe.exec(content)) !== null) {
      failures.push({
        runTag,
        conv: convId,
        cat: parseInt(m[1], 10),
        question: m[2].trim(),
        expected: m[3].trim(),
        predicted: m[4].trim(),
      });
    }
  }

  console.log(`Extracted ${failures.length} failures across ${chunkLogs.length} chunks.`);
  return failures;
}

// ── Classify via Haiku ──────────────────────────────────────────
const TAXONOMY_PROMPT = `You are classifying a failure from a memory-retrieval benchmark.

The benchmark (LOCOMO) tests a system that:
1. Ingests long multi-session conversations and extracts facts/persona
2. Indexes the extracted facts + raw turns
3. Retrieves candidates per query (semantic search + keyword search + graph walk + persona block)
4. Generates an answer via Claude Sonnet 4.5 from the retrieved context
5. Grades the answer against an expected gold answer

Given a SINGLE failure (the predicted answer didn't match expected), classify it into ONE letter:

A. EXTRACTION MISSING — The fact was never extracted from the source conversation. Predicted is generic / "No information available" / shows zero recall. The source DOES contain the answer but it wasn't pulled.

B. EXTRACTED NOT INDEXED — The fact was extracted but lost between extraction and retrieval. Rare; usually shows up as "extraction was right but retrieval finds nothing."

C. INDEXED NOT RETRIEVED — Fact is stored, but the retrieval signal didn't surface it. Predicted is "No information available" or a wrong related fact. Most common cause of "No information available" answers.

D. RETRIEVED NOT USED — The fact IS in the retrieved context (you can usually tell because the predicted answer references nearby information), but the LLM ignored it or pulled the wrong piece.

E. USED BUT ANSWER WRONG — Right info, wrong format. Examples:
   - Predicted "Last week before 15 April 2022" when expected "The week before 15 April, 2022" (same week, different phrasing)
   - Predicted "Chicken Pot Pie and sushi" when expected list was "chicken pot pie, chicken roast, blueberry muffins, sushi" (partial list)
   - Predicted has preamble like "Based on the transcript, X" when expected is just "X"

F. TEMPORAL NORMALIZATION WRONG — Date arithmetic / temporal expression failed. Examples:
   - Question asks "when" and predicted is "yesterday from 2023-08-28" instead of "27 August 2023"
   - Predicted year is off by 1
   - Relative-to-absolute date resolution failed

G. ENTITY/ALIAS MISMATCH — Subject name resolution failed. Example:
   - Question references "Caroline" but the fact is stored under "Caroline A."
   - The persona has the right info under a different alias

H. MULTI-HOP INTERMEDIATE FAILURE — For cat=3 questions, one of the intermediate hops failed.
   - First hop got wrong entity (e.g. "person who works with Sarah" resolved to wrong person)
   - Or the second hop succeeded on the wrong entity from hop 1

I. GRADER MISMATCH — The predicted answer is correct but the grader marked it wrong due to phrasing/format strictness. Rare. Only mark this if the predicted answer is OBVIOUSLY equivalent to expected.

J. ACTUALLY IMPOSSIBLE — The source ambiguously or doesn't actually contain the answer. The question itself is under-specified or the gold answer is wrong.

Respond with EXACTLY this JSON format (no extra text):
{"class": "C", "reason": "Predicted is 'No information available' for a single-hop factual question, suggesting retrieval didn't surface the indexed fact"}

The reason should be one short sentence pointing at the specific evidence for your classification.`;

async function classifyOne(client, failure) {
  const userPrompt = `Failure to classify:

Question (cat=${failure.cat}): "${failure.question}"
Expected answer: "${failure.expected}"
Predicted answer: "${failure.predicted}"

Classify into A-J and return JSON only.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: TAXONOMY_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.text || '';
  try {
    // Extract JSON (in case the model added stray text)
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.class || !/^[A-J]$/.test(parsed.class)) {
      throw new Error(`invalid class: ${parsed.class}`);
    }
    return parsed;
  } catch (e) {
    console.warn(`  parse error on "${failure.question.slice(0, 60)}...": ${e.message}`);
    return { class: 'X', reason: `parse error: ${text.slice(0, 80)}` };
  }
}

// ── Render markdown summary ─────────────────────────────────────
function renderSummary(classifications) {
  // Per-cat × per-bucket count
  const counts = {}; // cat → bucket → count
  const buckets = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'X'];

  for (const f of classifications) {
    if (!counts[f.cat]) counts[f.cat] = {};
    counts[f.cat][f.class] = (counts[f.cat][f.class] || 0) + 1;
  }

  const lines = [];
  lines.push(`# Failure taxonomy — ${RUN_TAG}`);
  lines.push('');
  lines.push(`**Total failures classified:** ${classifications.length}`);
  lines.push('');
  lines.push('## Distribution by category × failure mode');
  lines.push('');
  lines.push(`| Cat | ${buckets.join(' | ')} | Total |`);
  lines.push(`|---|${buckets.map(() => '---').join('|')}|---|`);

  for (const cat of [1, 2, 3, 4, 5]) {
    if (!counts[cat]) continue;
    const row = [cat];
    let total = 0;
    for (const b of buckets) {
      const n = counts[cat][b] || 0;
      row.push(n || '');
      total += n;
    }
    row.push(total);
    lines.push(`| ${row.join(' | ')} |`);
  }

  lines.push('');
  lines.push('## Bucket legend');
  lines.push('');
  lines.push('- **A** Extraction missing — fact never extracted from source');
  lines.push('- **B** Extracted but not indexed — fact extracted, lost in storage');
  lines.push('- **C** Indexed not retrieved — fact stored, retrieval missed');
  lines.push('- **D** Retrieved not used — fact in context, LLM ignored');
  lines.push('- **E** Used but wrong answer style — right info, wrong format');
  lines.push('- **F** Temporal normalization — date arithmetic failed');
  lines.push('- **G** Entity/alias mismatch — name resolution failed');
  lines.push('- **H** Multi-hop intermediate — hop 1 or 2 missed');
  lines.push('- **I** Grader mismatch — answer correct, grader marked wrong');
  lines.push('- **J** Actually impossible — ambiguous in source');
  lines.push('- **X** Classifier error — JSON parse or invalid class');
  lines.push('');
  lines.push('## Action priorities per cat');
  lines.push('');
  lines.push('Reading the table:');
  lines.push('');
  lines.push('- If a cat is mostly **C** → retrieval-side fix needed (T7 diversity / T8 atomic facts / T9 temporal compiler depending on cat)');
  lines.push('- If a cat is mostly **A** → extraction pipeline needs work');
  lines.push('- If a cat is mostly **E** → prompt-side / answer-shape fix sufficient');
  lines.push('- If a cat is mostly **F** → temporal compiler (T9) is the right move');
  lines.push('- If a cat is mostly **H** → graph-hop executor (T10) is the right move');
  lines.push('- High **I** count → grader review needed');
  lines.push('');
  lines.push(`**Raw JSON:** [${path.basename(OUT_JSON)}](${path.basename(OUT_JSON)})`);

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────
(async () => {
  const failures = await extractFailures(RUN_TAG);

  if (DRY_RUN) {
    console.log(`\nDRY RUN — first 5 failures extracted:`);
    for (const f of failures.slice(0, 5)) {
      console.log(`  ${f.conv} cat=${f.cat}: ${f.question.slice(0, 60)}...`);
      console.log(`    expected: ${f.expected.slice(0, 60)}`);
      console.log(`    predicted: ${f.predicted.slice(0, 60)}`);
    }
    console.log(`\n${failures.length} total. Re-run without --dry-run to classify via Haiku.`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set; cannot classify. Use --dry-run to extract only.');
    process.exit(1);
  }

  const client = new Anthropic();
  const subset = LIMIT > 0 ? failures.slice(0, LIMIT) : failures;
  console.log(`Classifying ${subset.length} failures via Haiku 4.5...`);

  const classifications = [];
  for (let i = 0; i < subset.length; i++) {
    const f = subset[i];
    process.stdout.write(`  [${i + 1}/${subset.length}] ${f.conv} cat=${f.cat}: ${f.question.slice(0, 50)}... `);
    try {
      const result = await classifyOne(client, f);
      classifications.push({ ...f, ...result });
      console.log(`→ ${result.class}`);
    } catch (e) {
      console.log(`→ ERROR ${e.message.slice(0, 80)}`);
      classifications.push({ ...f, class: 'X', reason: `api error: ${e.message}` });
    }
  }

  await writeFile(OUT_JSON, JSON.stringify({
    runTag: RUN_TAG,
    classifiedAt: new Date().toISOString(),
    totalFailures: subset.length,
    classifications,
  }, null, 2));
  console.log(`\n✓ JSON written: ${OUT_JSON}`);

  const summary = renderSummary(classifications);
  await writeFile(OUT_MD, summary);
  console.log(`✓ Summary written: ${OUT_MD}`);

  console.log('\nDistribution:');
  const dist = {};
  for (const c of classifications) {
    dist[c.class] = (dist[c.class] || 0) + 1;
  }
  for (const k of Object.keys(dist).sort()) {
    console.log(`  ${k}: ${dist[k]}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
