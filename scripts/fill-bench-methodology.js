#!/usr/bin/env node
/**
 * Fill the LOCOMO methodology doc from a completed bench run.
 *
 * Inputs:
 *   --run-tag=<tag>   the bench run to source data from (defaults to the
 *                     most-recent t3fs-*-summary.json in /app/bench/)
 *   --doc=<path>      path to docs/BENCH-METHODOLOGY.md (default:
 *                     /app/docs/BENCH-METHODOLOGY.md)
 *   --out=<path>      output path. Default: same as --doc (in-place fill)
 *   --dry-run         print the filled doc to stdout instead of writing
 *
 * What it fills:
 *   - TL;DR table: aggregate accuracy, questions graded, run tag
 *   - Per-category breakdown table
 *   - Versioning table (append new row for this run)
 *   - 10 sample failure cases (parsed from per-chunk logs)
 *
 * What it does NOT fill yet (instrumentation gaps):
 *   - Token cost per question (need per-request usage logged with TS)
 *   - Latency p50/p95 (need per-request timing logged with TS)
 *   Both will land when the bench runner emits a richer summary JSON.
 *
 * Idempotent: replaces previously-filled cells based on _pending_ markers
 * and tagged HTML comments. Run as many times as needed.
 *
 * Usage examples:
 *   node scripts/fill-bench-methodology.js                          # fill in place
 *   node scripts/fill-bench-methodology.js --dry-run                # preview only
 *   node scripts/fill-bench-methodology.js --run-tag=t3fs-20260510-202955
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const BENCH_DIR = process.env.BENCH_DIR || '/app/bench';
const DEFAULT_DOC = process.env.METHODOLOGY_DOC || '/app/docs/BENCH-METHODOLOGY.md';

// ----------------------------------------------------------------------------
// CLI parsing

const argv = process.argv.slice(2);
const args = Object.fromEntries(
  argv.map((a) => {
    if (a.startsWith('--') && a.includes('=')) {
      const [k, ...rest] = a.slice(2).split('=');
      return [k, rest.join('=')];
    }
    return [a.replace(/^--/, ''), true];
  })
);

const opts = {
  runTag: args['run-tag'] || null,
  doc: args.doc || DEFAULT_DOC,
  out: args.out || args.doc || DEFAULT_DOC,
  dryRun: args['dry-run'] === true,
};

// ----------------------------------------------------------------------------
// Source-data loading

function pickLatestRunTag() {
  const files = readdirSync(BENCH_DIR).filter((f) => /^t3fs-\d+-\d+-summary\.json$/.test(f));
  if (files.length === 0) throw new Error(`No t3fs-*-summary.json found in ${BENCH_DIR}`);
  files.sort();
  return files[files.length - 1].replace(/-summary\.json$/, '');
}

function loadSummary(runTag) {
  const p = join(BENCH_DIR, `${runTag}-summary.json`);
  if (!existsSync(p)) throw new Error(`Summary JSON not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadMasterLog(runTag) {
  const p = join(BENCH_DIR, `${runTag}-master.log`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function loadChunkLogs(runTag) {
  const re = new RegExp(`^${runTag}-conv-[\\w-]+-q\\d+\\.log$`);
  return readdirSync(BENCH_DIR)
    .filter((f) => re.test(f))
    .map((f) => ({ file: f, content: readFileSync(join(BENCH_DIR, f), 'utf8') }));
}

// ----------------------------------------------------------------------------
// Parsing helpers

/**
 * Extract failure cases from chunk logs.
 *   ✗ cat=2 "Question text"
 *      expected: "..."
 *      predicted: "..."
 *
 * Returns up to `n` random samples with chunk-file attribution.
 */
function extractFailures(chunkLogs, n = 10) {
  const failures = [];
  for (const { file, content } of chunkLogs) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\d+\.\s+✗\s+cat=(\d)\s+"([^"]+)"\s*$/);
      if (!m) continue;
      const [, cat, question] = m;
      // Look ahead for expected: and predicted:
      let expected = '';
      let predicted = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const eM = lines[j].match(/^\s*expected:\s*"?(.+?)"?\s*$/);
        const pM = lines[j].match(/^\s*predicted:\s*"?(.+?)"?\s*$/);
        if (eM) expected = eM[1];
        if (pM) predicted = pM[1];
        if (expected && predicted) break;
      }
      failures.push({ chunk: file, cat, question, expected, predicted });
    }
  }
  // Random sample of n
  if (failures.length <= n) return failures;
  const sampled = [];
  const seen = new Set();
  while (sampled.length < n) {
    const idx = Math.floor(Math.random() * failures.length);
    if (seen.has(idx)) continue;
    seen.add(idx);
    sampled.push(failures[idx]);
  }
  return sampled;
}

// ----------------------------------------------------------------------------
// Rendering

function renderTLDR(summary, runTag) {
  const acc = summary.accuracy?.toFixed(2) ?? 'n/a';
  return `| **Aggregate accuracy** | **${acc}%** | run tag \`${runTag}\` |
| **Questions graded** | ${summary.totalQuestions ?? 'n/a'} (target 1,986) | LOCOMO public dataset v1 |
| **Conversations covered** | derived from summary.byConv when present | conv-26, 30, 41, 42, 43, 44, 47, 48, 49, 50 |
| **Total elapsed** | ${summary.elapsedSec ? `${Math.floor(summary.elapsedSec / 60)}m ${summary.elapsedSec % 60}s` : 'n/a'} | wall-clock |
| **Token cost per question (avg)** | _instrumentation pending — see § Cost + latency_ | bridge logs |
| **Latency p50 / p95 per question** | _instrumentation pending — see § Cost + latency_ | bridge logs |
| **Hardware** | Docker Desktop on Windows 11, Node 22, Postgres 16 + pgvector | reproducible via \`docker-compose up\` |
| **LLMs used** | Claude Sonnet 4.5 (answers + cat=3 multihop CoT), Claude Haiku 4.5 (planner + grader + verifier), Cohere embed-v3 (1024d retrieval) + Cohere rerank-v3.5 | configured in \`.env\` |`;
}

const CAT_LABEL = {
  cat1: 'single-hop / literal',
  cat2: 'temporal',
  cat3: 'multi-hop',
  cat4: 'open-domain',
  cat5: 'adversarial',
};

function renderCategoryRows(summary) {
  const byCat = summary.byCategory || {};
  const keys = Object.keys(byCat).sort();
  if (keys.length === 0) {
    return `| _no per-category data emitted by the run_ | | | | |`;
  }
  return keys
    .map((k) => {
      const row = byCat[k];
      const label = CAT_LABEL[k] || k;
      const pct = row.pct?.toFixed(2) ?? '?';
      return `| \`${k}\` | ${label} | ${row.total} | ${row.correct} | **${pct}%** |`;
    })
    .join('\n');
}

function renderFailureRows(failures) {
  if (failures.length === 0) {
    return `| _bench in flight or no failures recorded_ | | | | | |`;
  }
  return failures
    .map((f, i) => {
      // markdown-escape the quote chars
      const q = f.question.replace(/\|/g, '\\|');
      const e = (f.expected || '_(unparsed)_').replace(/\|/g, '\\|').slice(0, 80);
      const p = (f.predicted || '_(unparsed)_').replace(/\|/g, '\\|').slice(0, 80);
      const chunk = f.chunk.replace(/\.log$/, '');
      return `| ${i + 1} | \`cat=${f.cat}\` | ${q} | ${e} | ${p} | ${chunk} |`;
    })
    .join('\n');
}

function renderVersionRow(summary, runTag) {
  const acc = summary.accuracy?.toFixed(2) ?? 'n/a';
  const today = new Date().toISOString().slice(0, 10);
  return `| v0.1 | ${today} | \`${runTag}\` | **${acc}%** | First post-Tier-5 full-stack run after 11-bug sweep |`;
}

// ----------------------------------------------------------------------------
// Doc-mutation helpers — replace specific tagged blocks idempotently

function replaceBetween(doc, beginMarker, endMarker, replacement) {
  const begin = doc.indexOf(beginMarker);
  const end = doc.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) {
    console.warn(`[fill] missing markers ${beginMarker} ... ${endMarker} — skipping section`);
    return doc;
  }
  return (
    doc.slice(0, begin + beginMarker.length) +
    '\n' +
    replacement +
    '\n' +
    doc.slice(end)
  );
}

// ----------------------------------------------------------------------------
// Main

function main() {
  const runTag = opts.runTag || pickLatestRunTag();
  console.log(`[fill] run tag: ${runTag}`);

  const summary = loadSummary(runTag);
  const chunkLogs = loadChunkLogs(runTag);
  console.log(`[fill] loaded summary (acc=${summary.accuracy}, n=${summary.totalQuestions}) + ${chunkLogs.length} chunk logs`);

  const failures = extractFailures(chunkLogs, 10);
  console.log(`[fill] extracted ${failures.length} failure cases (10 sampled)`);

  let doc = readFileSync(opts.doc, 'utf8');

  // The methodology doc uses HTML-comment markers for fillable regions. If
  // they're not present yet, we inject them around the relevant blocks on
  // first run.
  doc = ensureMarkers(doc);

  doc = replaceBetween(
    doc,
    '<!-- FILL:TLDR:BEGIN -->',
    '<!-- FILL:TLDR:END -->',
    renderTLDR(summary, runTag)
  );

  doc = replaceBetween(
    doc,
    '<!-- FILL:CATEGORY:BEGIN -->',
    '<!-- FILL:CATEGORY:END -->',
    renderCategoryRows(summary)
  );

  doc = replaceBetween(
    doc,
    '<!-- FILL:FAILURES:BEGIN -->',
    '<!-- FILL:FAILURES:END -->',
    renderFailureRows(failures)
  );

  doc = replaceBetween(
    doc,
    '<!-- FILL:VERSION:BEGIN -->',
    '<!-- FILL:VERSION:END -->',
    renderVersionRow(summary, runTag)
  );

  // Replace the "skyMem (this run) | _pending_" row in the cross-system
  // comparison table with the real accuracy number. Idempotent — runs
  // every time the script does, so subsequent fills update the cell.
  const acc = summary.accuracy?.toFixed(2) ?? 'n/a';
  doc = doc.replace(
    /\| \*\*skyMem \(this run\)\*\* \| [^|]+\| this doc \|/,
    `| **skyMem (this run)** | **${acc}%** | this doc |`
  );

  if (opts.dryRun) {
    process.stdout.write(doc);
    console.error('[fill] dry-run: NOT writing');
  } else {
    writeFileSync(opts.out, doc, 'utf8');
    console.log(`[fill] wrote ${opts.out}`);
  }
}

/**
 * Ensure the methodology doc has the FILL markers around the fillable
 * regions. On first run, we inject them around the existing _pending_
 * blocks. Subsequent runs see the markers and just substitute.
 */
function ensureMarkers(doc) {
  // TLDR table — wrap the rows between the header row and the blank line
  if (!doc.includes('<!-- FILL:TLDR:BEGIN -->')) {
    doc = doc.replace(
      /(\| Metric \| Value \| Provenance \|\n\|---\|---\|---\|\n)([\s\S]+?)(\n\nFor comparison:)/,
      '$1<!-- FILL:TLDR:BEGIN -->\n$2\n<!-- FILL:TLDR:END -->$3'
    );
  }
  // Per-category table
  if (!doc.includes('<!-- FILL:CATEGORY:BEGIN -->')) {
    doc = doc.replace(
      /(\| Category \| Description \| Questions \| Correct \| Accuracy \|\n\|---\|---\|---\|---\|---\|\n)([\s\S]+?)(\n\n\*\*Honesty note)/,
      '$1<!-- FILL:CATEGORY:BEGIN -->\n$2\n<!-- FILL:CATEGORY:END -->$3'
    );
  }
  // Failures table
  if (!doc.includes('<!-- FILL:FAILURES:BEGIN -->')) {
    doc = doc.replace(
      /(\| # \| Conv \/ Q \| Question \| Expected \| Got \| Why we got it wrong \| Layer at fault \|\n\|---\|---\|---\|---\|---\|---\|---\|\n)([\s\S]+?)(\nFor each failure)/,
      '$1<!-- FILL:FAILURES:BEGIN -->\n$2\n<!-- FILL:FAILURES:END -->$3'
    );
  }
  // Versioning table
  if (!doc.includes('<!-- FILL:VERSION:BEGIN -->')) {
    doc = doc.replace(
      /(\| Version \| Date \| Run tag \| Aggregate \| Notes \|\n\|---\|---\|---\|---\|---\|\n)([\s\S]+?)(\n\n\(Each new run)/,
      '$1<!-- FILL:VERSION:BEGIN -->\n$2\n<!-- FILL:VERSION:END -->$3'
    );
  }
  return doc;
}

try {
  main();
} catch (e) {
  console.error('[fill] ERR:', e.message);
  process.exit(1);
}
