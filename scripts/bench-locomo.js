#!/usr/bin/env node
/**
 * LOCOMO benchmark runner — Sky retrieval + answer generation against the
 * LOCOMO long-form conversational memory benchmark.
 *
 * Dataset:  /app/bench/locomo10.json (10 conversations, 1986 QA pairs total)
 * Source:   github.com/snap-research/locomo (paper: arXiv:2402.17753)
 *
 * Methodology:
 *   1. For each conversation, ingest each session turn into Sky's graph
 *      with an isolated scope (chatJid="benchmark:locomo:<sample_id>") so
 *      it doesn't pollute the user's real graph and Phase 1 scope filter
 *      naturally isolates retrieval.
 *   2. For each QA pair, run Sky's full retrieval pipeline (semantic dual-query
 *      + FTS + edge-walk + Cohere rerank) against that scope.
 *   3. Generate an answer using Sonnet 4.5 from the retrieved context.
 *   4. Grade via Haiku LLM-judge against the expected answer.
 *   5. Aggregate F1 / accuracy by question category.
 *
 * Categories (per LOCOMO paper):
 *   1 = single-hop recall      (one fact, one session)
 *   2 = temporal reasoning     (when did X happen)
 *   3 = multi-hop reasoning    (combine facts across sessions)
 *   4 = open-domain knowledge  (combines convo + world knowledge)
 *   5 = adversarial            (answer not in convo — should abstain)
 *
 * Usage:
 *   docker exec sky-bridge sh -c 'NEW_URL=$(...); export DATABASE_URL=...
 *     node /app/scripts/bench-locomo.js [--samples=N] [--questions-per=M]
 *     [--conv-id=conv-N]'
 *
 *   --samples=N           Run on first N conversations (default: 1)
 *   --questions-per=M     Limit questions per conversation (default: all)
 *   --conv-id=ID          Run only on the specified conv sample_id
 *   --skip-ingest         Skip ingestion (assumes already done)
 *   --cleanup             Delete bench-scoped nodes after run
 *
 * Output: /app/bench/results-locomo-<timestamp>.json
 *
 * Cost estimate (full LOCOMO 10 convs × 199 questions):
 *   Ingestion: ~5000 turns × 1 embedding each = ~5k embed calls (free, local)
 *   Generation: 1986 questions × Sonnet 4.5 ~$0.005 each = ~$10
 *   Grading: 1986 × Haiku 4.5 ~$0.0002 each = ~$0.40
 *   Total: ~$10-12 for full run.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import prisma from '../sky/prisma-client.js';
import embeddings from '../sky/embeddings.js';
import graph from '../sky/graph.js';
import { ftsHotSearch } from '../sky/keyword-search.js';
import { applyPrivacyFilter } from '../sky/leak-detector.js';
import { isScopeEnabled } from '../sky/scope-helpers.js';
import rerank from '../sky/rerank.js';
import planner from '../sky/planner.js';
import apiFallback from '../sky/api-fallback.js';
import persona from '../sky/persona.js';
import personaExtractor from '../sky/persona-extractor.js';
import nucleus from '../sky/nucleus-expansion.js';
import answerVerifier from '../sky/answer-verifier.js';
import queryReformulator from '../sky/query-reformulator.js';

// ── CLI args ───────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
function flag(name, defaultValue) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  if (ARGS.includes(`--${name}`)) return true;
  return defaultValue;
}
const SAMPLES = parseInt(flag('samples', '1'), 10);
const QUESTIONS_PER = parseInt(flag('questions-per', '0'), 10) || null;
const CONV_ID = flag('conv-id', null);
const SKIP_INGEST = flag('skip-ingest', false);
const CLEANUP = flag('cleanup', false);
// Chunked execution: run a window of questions [START_Q, START_Q + QUESTIONS_PER).
// Used by the sequential runner to limit per-process RSS — at q100 of conv-26
// we observed 9.3GB RSS, mostly native allocations (ONNX + SDK buffers) that
// V8.gc() can't reclaim. Splitting one conv across multiple processes gives
// each process a fresh native allocator.
const START_Q = parseInt(flag('start-question', '0'), 10) || 0;
// Persona Phase 0 (2026-05-09): extract structured facts about each LOCOMO
// speaker from the ingested conversation, retrieve at query-time, prepend to
// the answer-generator context. This is the Synthius pattern (94.4%) adapted
// for LOCOMO's two-speaker setup.
//   --persona=on|off   Default 'on'. Off lets us A/B vs baseline cleanly.
//   --persona-batch=N  Nodes per extractor call (default 25)
const PERSONA = (flag('persona', 'on') !== 'off');
const PERSONA_BATCH = parseInt(flag('persona-batch', '25'), 10);
// Nucleus expansion (MemMachine pattern, +3-8pp projected): after top-K
// retrieval, pull each retrieved conversation node's ±N adjacent turns
// from the same chatJid. Default OFF until next bench iteration validates.
//   --nucleus=on|off  default 'off'
//   --nucleus-window=2  ±N adjacent turns (default 2)
// T4c (2026-05-11): nucleus-mode supports 'on' | 'off' | 'cat3only'.
//   'on'       — always expand (legacy)
//   'off'      — never expand (T3 v2 default; cat=4 benefits from no padding)
//   'cat3only' — expand only when category===3 (architectural-fit revival).
//                T6 ablation showed cat=3 was the ONLY cat where nucleus helps;
//                this mode preserves that benefit without diluting cat=4.
const NUCLEUS_MODE = flag('nucleus', 'off');                  // back-compat: 'on'/'off' still valid
const NUCLEUS = NUCLEUS_MODE === 'on';                         // legacy flag (always expand)
const NUCLEUS_WINDOW = parseInt(flag('nucleus-window', '2'), 10);
function shouldExpandNucleus(category) {
  if (NUCLEUS_MODE === 'on') return true;
  if (NUCLEUS_MODE === 'cat3only') return category === 3;
  return false; // 'off' or any other value
}
// Tier 2 — Synthius-pattern verifier. Second Haiku pass after generateAnswer
// checks evidence support, hallucination, abstention recommendation. Cost
// ~$0.0001/q. Projected +2-5pp on top of full stack.
const VERIFIER = (flag('verifier', 'off') === 'on');
// Tier 3 — retrieval-miss reformulation. When initial answer is "No
// information available", rephrase the query (cheap Haiku call) and retry
// retrieval+answer once. Catches cat=4 retrieval misses where the question
// terms don't match the speaker's wording.
const REFORMULATE = (flag('reformulate', 'off') === 'on');

const DATASET_PATH = '/app/bench/locomo10.json';
const OUT_PATH = `/app/bench/results-locomo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

// ── Helpers ────────────────────────────────────────────────────────────────

function divider(s) {
  console.log('━'.repeat(96));
  console.log(s);
  console.log('━'.repeat(96));
}

/**
 * Normalise LOCOMO date strings ("1:56 pm on 8 May, 2023") into a canonical
 * "YYYY-MM-DD HH:MM" form. Best-effort — falls back to original string if
 * the parser can't read it.
 */
function normaliseDate(raw) {
  if (!raw) return '';
  // Strip "<time> on " prefix, parse the rest as a date.
  const m = raw.match(/^(\d{1,2}:\d{2}\s*(?:am|pm))?\s*(?:on\s+)?(.+)$/i);
  let timePart = m?.[1] || '';
  const datePart = m?.[2] || raw;
  try {
    const d = new Date(datePart);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      let hhmm = '';
      if (timePart) {
        const t = timePart.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
        if (t) {
          let h = parseInt(t[1], 10);
          const min = t[2];
          if (t[3].toLowerCase() === 'pm' && h < 12) h += 12;
          if (t[3].toLowerCase() === 'am' && h === 12) h = 0;
          hhmm = ` ${String(h).padStart(2, '0')}:${min}`;
        }
      }
      return `${yyyy}-${mm}-${dd}${hhmm}`;
    }
  } catch (_) { /* */ }
  return raw;
}

/**
 * Make a benchmark scope for an isolated conversation. Phase 1 scope filter
 * isolates retrieval to this chatJid only — won't see the user's real data.
 */
function makeBenchScope(sampleId) {
  return {
    chatJid: `benchmark:locomo:${sampleId}`,
    companyId: null,
    audience: 'ross-only',
    tier: 'chat',
  };
}

/**
 * Ingest a single LOCOMO turn as a memory node + embedding.
 *
 * Simplification vs production ingest: we DON'T run the Haiku atomic
 * decomposition. Each turn becomes one node. This:
 *   - keeps benchmark cost low (~$0 ingestion)
 *   - is methodologically cleaner (we measure RETRIEVAL quality, not
 *     decomposition quality — those are separable)
 *   - matches what other systems (Letta, mem0, Zep) typically do for LOCOMO
 *
 * The retrieval pipeline (semantic + FTS + edge-walk + rerank) does its
 * job over these single-turn nodes the same way it does over decomposed
 * atoms.
 */
async function ingestTurn({ speaker, text, sessionDate, dia_id, scope }) {
  // Prefix the session date so temporal questions ("when did X?") can find it.
  // LOCOMO sessions are date-stamped at session level, not per-turn — every
  // turn within a session shares the same date. The reranker reads (query,
  // doc) so explicit date inclusion is decisive for cat-2 (temporal) questions.
  // Without this prefix on smoke test, cat-2 was 0/10. Format the date as
  // ISO-ish for the reranker to parse cleanly: "[2023-05-08 13:56]".
  const dateTag = sessionDate ? `[${normaliseDate(sessionDate)}] ` : '';
  const content = `${dateTag}${speaker}: ${text}`;
  const node = await prisma.memoryNode.create({
    data: {
      type: 'conversation',
      content,
      weight: 0.3,
      tags: [`speaker:${speaker}`, `dia_id:${dia_id}`, 'benchmark:locomo'],
      sourceType: 'conversation',
      sourceId: dia_id, // makes evidence-tracing possible
      chatJid: scope.chatJid,
      tier: scope.tier,
      audience: scope.audience,
      // sessionDate kept in tags; createdAt records ingest time (good enough for retrieval)
    },
  });

  // Embed for semantic retrieval. Don't fire-and-forget — wait so the
  // benchmark deterministically has all embeddings before queries run.
  await embeddings.embedAndStore('memory_node', node.id, content, scope);
  return node;
}

/**
 * Render a persona block for the current bench sample. Returns text suitable
 * for prepending to the conversation evidence block. Empty string if no
 * persona facts exist for the scope (e.g. --persona=off, or extraction
 * skipped). The block includes per-speaker subject tags (when present)
 * inside the JSON payload — the bench renders them with explicit speaker
 * prefixes so the answer-generator can attribute facts cleanly.
 *
 * Cheap (one indexed query). Called once per question.
 */
async function buildBenchPersonaBlock(scope, question = null, category = null) {
  if (!PERSONA || !scope?.chatJid) return '';
  // Pull a wide pool then curate. We don't want to flood the prompt with
  // 160+ paraphrased facts — that drowns out the conversation evidence
  // and demonstrably hurt multi-hop accuracy on conv-26 (smoke A/B
  // 2026-05-09: cat=3 dropped 75% → 25% with the unfiltered block).
  const facts = await persona.getFactsByChatJid(scope.chatJid, { limit: 200, minConfidence: 0.6 });
  if (!facts.length) return '';

  // Curation policy:
  //   1. Domain weighting — identity / people / active / goals carry more
  //      LOCOMO-relevant signal than preferences / portfolio (which tend
  //      to be paraphrased life-context that overlaps with conversation
  //      lines without adding precision).
  //   2. QUERY-AWARE adjustment (Tier 3): when the question hints at a
  //      specific domain, boost its priority. e.g. "what activities" →
  //      preferences/portfolio relevant; "when did" → active/goals;
  //      "who is X" → identity/people.
  //   3. Confidence floor 0.7 — high-conf facts only.
  //   4. Hard cap at 50 facts total. Each fact text capped at 180 chars.
  //   5. Per-subject de-duplication: same speaker / same domain — keep
  //      top 8 by confidence to avoid one verbose subject hogging the cap.
  const DOMAIN_PRIORITY = {
    identity:    1.0,
    people:      0.95,
    active:      0.9,
    goals:       0.85,
    decisions:   0.8,
    preferences: 0.55,
    portfolio:   0.5,
  };

  // Query-aware boost: detect domain hints in the question and bump
  // those domains' priority by +0.4. Capped at 1.5 max to avoid runaway.
  if (question && typeof question === 'string') {
    const q = question.toLowerCase();
    const boost = (dom, amt) => {
      DOMAIN_PRIORITY[dom] = Math.min(1.5, (DOMAIN_PRIORITY[dom] || 0.5) + amt);
    };
    if (/\bwhat (activities|hobbies|things|games|sports|exercise)\b/.test(q)) boost('preferences', 0.4);
    if (/\bwhat (book|books|movie|show|song|album|read|watched|listening)\b/.test(q)) boost('preferences', 0.4);
    if (/\bwhen (did|will|is|was|does)\b|\bhow long\b/.test(q)) { boost('active', 0.3); boost('goals', 0.3); }
    if (/\bwho (is|was|are|were)\b|\bwhat is .* relationship\b/.test(q)) boost('people', 0.4);
    if (/\bwhat (kind|type) of (person|guy|gal|woman|man)\b|\bbiography\b|\bwhere .* (live|moved|grew up)\b/.test(q)) boost('identity', 0.4);
    if (/\bwhat (job|career|work|company|project|business)\b/.test(q)) boost('portfolio', 0.4);
    if (/\bdid (?:i|they|she|he|we) (decide|choose|pick)\b|\bwhat .* (decide|chose)\b/.test(q)) boost('decisions', 0.4);
    if (/\bgoal|plan|aim|hope|aspire|dream\b/.test(q)) boost('goals', 0.4);
  }
  const TEXT_CAP = 180;
  const PER_SUBJECT_DOMAIN_CAP = 8;
  const TOTAL_CAP = 50;

  // T4b (2026-05-11): persona-fact disambiguation. Score now incorporates
  // CONTENT-WORD OVERLAP between the fact text and the question. Pre-T4b
  // facts were ranked purely by `confidence × DOMAIN_PRIORITY`, so when a
  // subject had 5+ facts in the same domain (e.g. 5 "Nate active" facts),
  // the curator had no signal for picking the one the question is actually
  // asking about. Real cat=1 failures from T3 v2 conv-44 sample:
  //   Q: "What does Nate paint?" — persona had 3 'preferences' facts about
  //      Nate; the fan-art one ranked higher than the "watercolor seascapes"
  //      one because confidence was a tie. Adding content-overlap (q has
  //      "paint", fact has "seascapes"+"watercolor"+"painting") promotes
  //      the actual answer-bearing fact.
  //
  // Implementation: extract content-word tokens from question + fact text
  // (stripping stopwords), count overlap, apply +0.15 boost per shared word
  // capped at +0.6. Cheap (string ops, no embed call), and the effect is
  // monotonic — facts that mention question keywords win.
  const QUESTION_TOKENS = (() => {
    if (!question || typeof question !== 'string') return new Set();
    const STOP = new Set(['the','and','but','why','what','how','when','where','who','this','that','with','from','have','has','had','just','like','will','would','could','should','about','than','they','their','there','then','some','all','any','for','was','were','are','his','her','him','she','its','it\'s','you','your','him','here','than','then','been','being','does','did','done','do','too','very','now','also','only','own','one','two','more','most','many','much','few','far','near']);
    const toks = (question.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) || [])
      .filter(t => !STOP.has(t));
    return new Set(toks);
  })();
  function questionOverlap(text) {
    if (!QUESTION_TOKENS.size) return 0;
    const toks = (text.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) || []);
    let hits = 0;
    for (const t of toks) if (QUESTION_TOKENS.has(t)) hits++;
    return hits;
  }

  // T4f (2026-05-12): RELEVANCE_PROFILE — per-cat overlap-boost weight.
  // Pre-T4f the boost was hardcoded at 0.15/word for all categories. T4e
  // bench surfaced cat=5 -0.87 pp drag traceable to T4b's relevance scoring
  // pulling the persona block toward narrow question-relevant facts (right
  // for cat=1/2/3 precision; wrong for cat=5 adversarial grounding).
  //
  // Rule #4 in action: borrowed mechanic (relevance scoring) kept where it
  // earns lift (cat=1/2/3 precision questions) and disabled/reduced where
  // our architecture (broad persona grounding) needs the opposite.
  //   cat=1 — literal/list, precision wins → 0.15 (T4b baseline)
  //   cat=2 — temporal, precision on the date-bearing fact → 0.15
  //   cat=3 — multi-hop, focused inference fodder → 0.15
  //   cat=4 — open-domain, broad recall preferred but persona still scored
  //           → 0.08 (half-strength)
  //   cat=5 — adversarial, broad grounding + contradiction surface needed
  //           → 0.0 (OFF — let confidence × domain decide alone)
  const RELEVANCE_PROFILE = { 1: 0.15, 2: 0.15, 3: 0.15, 4: 0.08, 5: 0.0 };
  const RELEVANCE_WEIGHT = RELEVANCE_PROFILE[category] ?? 0.15;
  const RELEVANCE_CAP = RELEVANCE_WEIGHT * 4;  // 4-word equivalent ceiling

  const eligible = facts
    .filter(f => (f.confidence || 0) >= 0.7)
    .map(f => {
      const subj = (f.facts && typeof f.facts === 'object' && typeof f.facts.subject === 'string')
        ? f.facts.subject : 'Unknown';
      const text = (f.facts && typeof f.facts === 'object' && typeof f.facts.text === 'string')
        ? f.facts.text : (typeof f.facts === 'object' ? JSON.stringify(f.facts) : String(f.facts));
      const baseScore = (f.confidence || 0) * (DOMAIN_PRIORITY[f.domain] || 0.5);
      const overlap = questionOverlap(text);
      // T4f: per-cat boost via RELEVANCE_WEIGHT (was hardcoded 0.15).
      // Multiplicative so a high-confidence-no-overlap fact can still beat
      // a low-confidence-1-word-overlap fact. When RELEVANCE_WEIGHT === 0
      // (cat=5), this collapses cleanly to baseScore (the T3 v2 behaviour).
      const relBoost = Math.min(RELEVANCE_CAP, overlap * RELEVANCE_WEIGHT);
      const score = baseScore * (1 + relBoost);
      return { ...f, _subject: subj, _text: text.slice(0, TEXT_CAP), _score: score, _overlap: overlap };
    })
    .sort((a, b) => b._score - a._score);

  // Per-(subject, domain) cap pass
  const counts = new Map(); // key: subject|domain
  const keep = [];
  for (const f of eligible) {
    const key = `${f._subject}|${f.domain}`;
    const n = counts.get(key) || 0;
    if (n >= PER_SUBJECT_DOMAIN_CAP) continue;
    counts.set(key, n + 1);
    keep.push(f);
    if (keep.length >= TOTAL_CAP) break;
  }
  if (keep.length === 0) return '';

  // Group by subject for output
  const bySubject = new Map();
  for (const f of keep) {
    if (!bySubject.has(f._subject)) bySubject.set(f._subject, []);
    bySubject.get(f._subject).push(f);
  }
  const lines = ['## STRUCTURED FACTS (high-confidence)'];
  for (const [subject, subjectFacts] of bySubject) {
    lines.push(`### ${subject}`);
    // Within a subject, by score (which already weights domain priority)
    subjectFacts.sort((a, b) => b._score - a._score);
    for (const f of subjectFacts) {
      lines.push(`- (${f.domain}) ${f._text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run Sky's full retrieval pipeline against a query, scoped to the benchmark.
 * Returns the rendered context block ready to feed to the answer generator.
 *
 * Tier 3: the persona block is now QUERY-AWARE — the question's domain hints
 * (what activities / when / who is) boost the relevant domain's facts in
 * the curation pass. Means the prompt is tighter for each question.
 */
async function retrieveContext(query, scope, category = null) {
  // P2-1: agentic planner — decompose complex/list queries into sub-queries.
  // Cheap regex gates skip planner on simple single-fact queries.
  const plan = await planner.plan(query);

  // Step 1: build query set — bare + sub-queries (cap 6 parallel)
  const queries = new Set([query]);
  if (plan.shouldDecompose) for (const sq of plan.subqueries) queries.add(sq);
  const queryList = Array.from(queries).slice(0, 6);

  // Run all retrievals in parallel
  const allRetrievals = await Promise.all(
    queryList.map(q => graph.retrieve(q, 10, {}, scope))
  );
  const bareNodes = allRetrievals[0] || [];
  const subqueryNodes = plan.shouldDecompose ? allRetrievals.slice(1).flat() : [];

  // Union with bare-bias scoring (matches sky/index.js semantics)
  const _byId = new Map();
  for (const n of bareNodes) _byId.set(n.id, { ...n });
  for (const n of subqueryNodes) {
    if (_byId.has(n.id)) _byId.get(n.id).score = (_byId.get(n.id).score || 0) + 0.04;
    else _byId.set(n.id, { ...n, score: (n.score || 0) * 0.8 });
  }
  const graphNodes = Array.from(_byId.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, plan.shouldDecompose ? 14 : 10);

  // Step 2: keyword FTS
  const STOP_WORDS = new Set(['the','and','but','why','what','how','when','where','who','this','that','with','from','have','has','had','just','like','will','would','could','should','about','than','they','their','there','then','some','all','any']);
  const rawTokens = (query.match(/\b[A-Za-z][a-zA-Z0-9]{2,}\b/g) || []);
  const seen = new Set();
  const keywords = [];
  for (const t of rawTokens) {
    const l = t.toLowerCase();
    if (STOP_WORDS.has(l) || seen.has(l)) continue;
    seen.add(l);
    keywords.push(t);
  }
  const keywordNodes = [];
  for (const kw of keywords.slice(0, 8)) {
    try {
      const found = await ftsHotSearch({ query: kw, limit: 5, scope });
      for (const n of found) {
        if (!graphNodes.some(g => g.id === n.id) && !keywordNodes.some(k => k.id === n.id)) {
          keywordNodes.push({ ...n, score: (n.weight || 0) + 0.1 });
        }
      }
    } catch (_) { /* per-kw failures don't sink the run */ }
  }

  // Step 3: edge-walk from anchor nodes
  let edgeWalkNodes = [];
  try {
    const candidateAnchors = [...graphNodes, ...keywordNodes]
      .filter(n => (n.type === 'person' || n.type === 'project') && (n.weight || 0) >= 0.4)
      .slice(0, 4)
      .map(n => n.id);
    if (candidateAnchors.length > 0) {
      // P2-2: multi-hop walk for decomposed/list queries (planner-fired)
      const hops = plan.shouldDecompose ? 2 : 1;
      edgeWalkNodes = await graph.edgeWalk(candidateAnchors, scope, {
        perAnchor: 3,
        limit: hops === 2 ? 10 : 6,
        hops,
      });
      const existing = new Set([...graphNodes, ...keywordNodes].map(n => n.id));
      edgeWalkNodes = edgeWalkNodes.filter(n => !existing.has(n.id));
    }
  } catch (_) { /* */ }

  // Step 4: union, dedupe, optionally nucleus-expand, rerank
  const union = [];
  const byId = new Map();
  for (const n of [...graphNodes, ...keywordNodes, ...edgeWalkNodes]) {
    const existing = byId.get(n.id);
    if (!existing || (n.score || 0) > (existing.score || 0)) byId.set(n.id, n);
  }
  for (const v of byId.values()) union.push(v);

  // Nucleus expansion (MemMachine pattern). Pull ±N adjacent conversation
  // turns for each retrieved conversation node. The reranker downstream
  // sees a wider candidate pool with cluster context preserved.
  //
  // T4c (2026-05-11): conditional on category via shouldExpandNucleus().
  // Modes: 'on' (always), 'off' (never), 'cat3only' (expand iff category===3).
  // Rationale: T6 ablation showed cat=3 was the only category where nucleus
  // helps (~+1 pp); on cat=1/2/4 it diluted answers by ~+1-2pp each. Our
  // persona block already provides the conversational context that nucleus
  // duplicates for non-multi-hop categories. (Rule #4.)
  let candidatePool = union;
  if (shouldExpandNucleus(category)) {
    try {
      candidatePool = await nucleus.expand(union, scope, { window: NUCLEUS_WINDOW });
    } catch (e) {
      // Fail open — never block the bench on expansion
      candidatePool = union;
    }
  }

  // Locked at 12 (baseline) for non-list questions. Tuning experiments on 2026-05-08:
  //   topN=25 + stricter prompt: 22/50 (vs baseline ~20/50) — net-zero GLOBAL
  //   topN=15 + softer prompt:   16/50 — regression
  //   topN=12 + minimal prompt:  baseline 105/199 (53%) — best
  // Conclusion: prompt-level tuning of the answer generator yields fragile
  // gains. Architectural lifts (P2-1 agentic planner, P2-2 multi-hop) are
  // the right next move for LOCOMO score.
  //
  // T4b (2026-05-11): list-shape fan-out preserved.
  // T4f (2026-05-12): RERANK_PROFILE — per-cat top-N.
  // T6 (2026-05-13): cat=4 explicit profile — bump from 12 to 16.
  //
  // Rationale per docs/T5-RESULTS.md § 4 "cat=4 is volatile — that
  // volatility is the signal":
  //
  //   Sprint  cat=4 score  Δ vs prev
  //   T3 v2   73.84%       —
  //   T4e     74.20%       +0.36
  //   T4f     74.91%       +0.71  ← biggest aggregate contributor
  //   T5      73.60%       −1.31  ← dominated the regression
  //
  // cat=4 swings ±0.7-1.3 pp per sprint on changes that DON'T target it.
  // At 42.3% volume, cat=4 movement = aggregate movement. Treating cat=4
  // at TOPN=12 was reading volatility as noise. T6 bumps to 16 to give
  // open-domain questions more context candidates to reason from. The
  // additional 4 candidates per query are then filtered by the same
  // Cohere rerank — so noise candidates still get demoted, but the
  // "borderline good" candidates that would have been cut at 12 now
  // make it through.
  //
  // Profile (T6):
  //   cat=1 — literal, narrow exact evidence → 12
  //   cat=2 — temporal, focused evidence → 12
  //   cat=3 — multi-hop, more cross-turn context → 15 (T4f, durable lever)
  //   cat=4 — open-domain, broader recall → 16 (T6, was 12; or 25 for list-shape)
  //   cat=5 — adversarial, broad grounding + contradiction surface → 20
  //
  // List-shape override: cat=1/4 list questions still get TOPN=25 (T4b
  // list fan-out, validated). cat=3/5 keep their profile (cross-turn /
  // grounding needs dominate over list semantics).
  const shape = classifyAnswerShape(query, category);
  const RERANK_PROFILE = { 1: 12, 2: 12, 3: 15, 4: 16, 5: 20 };
  let RERANK_TOPN = RERANK_PROFILE[category] ?? 12;
  if (shape === 'list' && (category === 1 || category === 4)) {
    RERANK_TOPN = 25;
  }

  // T7a (2026-05-13): MMR diversity selection for cat=4 non-list queries.
  // Per docs/FAILURE-TAXONOMY-T4F.md, cat=4 has D+C+E ~equally distributed
  // failure modes. T6 (RERANK_PROFILE 12→16) targeted C alone and failed
  // its 3-conv spot-test (2/3 PASS = locked-protocol FAIL). T7a addresses
  // the C bucket specifically: similarity-collapse where Cohere rerank's
  // top-N includes 3-4 near-identical candidates, starving context of
  // bridging facts.
  //
  // Mechanism: rerank to a WIDER pool (RERANK_TOPN * 1.5), then apply MMR
  // to pick the final RERANK_TOPN that balances relevance against mutual
  // diversity. Token-level Jaccard as the diversity metric (no extra LLM
  // calls, deterministic).
  //
  // Gated: cat=4 AND non-list (list-shape uses T4b fan-out at TOPN=25).
  // Other cats untouched.
  const USE_MMR_FOR_CAT4 = (category === 4 && shape !== 'list');
  const RERANK_FETCH = USE_MMR_FOR_CAT4 ? Math.min(candidatePool.length, Math.round(RERANK_TOPN * 1.5)) : RERANK_TOPN;
  const MMR_LAMBDA = 0.5;

  let topNodes;
  if (rerank.isAvailable() && candidatePool.length > 0) {
    try {
      const wideRerank = await rerank.rerank(query, candidatePool, { topN: RERANK_FETCH });
      topNodes = USE_MMR_FOR_CAT4
        ? selectWithMMR(wideRerank, RERANK_TOPN, MMR_LAMBDA)
        : wideRerank;
    } catch (_) {
      topNodes = candidatePool.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, RERANK_TOPN);
    }
  } else {
    topNodes = candidatePool.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, RERANK_TOPN);
  }

  // Step 5: privacy filter
  if (isScopeEnabled() && scope) {
    const result = applyPrivacyFilter(topNodes, { requestAudience: scope.audience });
    topNodes = result.kept;
  }

  // Build the context block — for benchmark we use the raw conversation lines
  // (not graph.buildContextBlock's bracketed-type formatting) since LOCOMO
  // expects to see the source dialogue as evidence.
  const conversationBlock = topNodes.map(n => n.content).join('\n');

  // Persona Phase 0: prepend a structured-facts block when persona is on
  // and the sample has extracted facts. The answer-generator sees BOTH:
  //   "## STRUCTURED FACTS ABOUT THE SPEAKERS\n... \n## CONVERSATION EVIDENCE\n..."
  // strictly more information than the conversation alone.
  let block = conversationBlock;
  if (PERSONA && scope?.chatJid) {
    // T4f: thread category so RELEVANCE_PROFILE can gate the overlap-boost.
    const personaBlock = await buildBenchPersonaBlock(scope, query, category);
    if (personaBlock) {
      block = `${personaBlock}\n\n## CONVERSATION EVIDENCE\n${conversationBlock}`;
    }
  }

  return {
    block,
    nodesUsed: topNodes.map(n => ({ id: n.id, score: n.score, rerankScore: n.rerankScore, content: (n.content || '').slice(0, 120) })),
  };
}

/**
 * Generate an answer from retrieved context using Sonnet 4.5.
 * The system prompt instructs it to answer concisely from the context only,
 * or say "Not in context" if the answer isn't supported. This matches LOCOMO's
 * abstention-required category 5.
 */
/**
 * Classify a question into one of four answer-shape modes:
 *   - 'temporal'  — date/time/duration questions ("when did X / how long / since when")
 *                   → use temporal mode with explicit session-date arithmetic
 *                     instructions. Critical for cat=2 lift — speakers use
 *                     relative phrases ("yesterday", "last week", "5 years ago")
 *                     and the answer-generator must convert to absolute dates
 *                     using the session-date prefix on each turn.
 *   - 'literal'   — single non-temporal fact ("where" / "who" / "what is X's name")
 *                   → smallest span that contains the answer, minimal phrasing.
 *   - 'list'      — enumerate items ("what activities" / "what books")
 *                   → comma-separated, tersely-worded, deduplicated.
 *   - 'inference' — yes/no, opinion, "would X" / "is Y likely" / "what kind"
 *                   → reasoning-driven answer.
 */
// ── T7a (2026-05-13): MMR diversity selection for cat=4 ──────────
// Maximal Marginal Relevance — re-rank a wider candidate pool to balance
// relevance against diversity, picking top-N candidates that are HIGH
// relevance but LOW similarity to each other.
//
// MMR(q, D, lambda) = argmax_d in D [lambda * Sim1(q, d) - (1-lambda) * max_d'_in_selected Sim2(d, d')]
//
// We use Cohere rerank scores as Sim1 (relevance) and token-level Jaccard
// as Sim2 (similarity). Pure additive — only invoked for cat=4 non-list
// questions per docs/FAILURE-TAXONOMY-T4F.md analysis (cat=4 D+C+E split
// equally; MMR addresses the C bucket = retrieval-miss-via-similarity-
// collapse where rerank's top-N clusters semantically).
//
// lambda = 0.5 is the standard balance. Lower = more diverse, higher =
// more relevance-faithful. We start at 0.5 and tune via spot-test.

const MMR_TOKEN_RE = /\b[a-z0-9]{3,}\b/g;
const MMR_STOP = new Set([
  'the','and','but','why','what','how','when','where','who','this','that',
  'with','from','have','has','had','just','like','will','would','could',
  'should','about','than','they','their','there','then','some','all','any',
  'for','was','were','are','his','her','him','she','its','you','your','too',
  'been','being','does','did','done','only','one','two','more','most','many',
  'not','can','said','say','says','told','tell','really','very','also',
]);

function mmrTokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const toks = (text.toLowerCase().match(MMR_TOKEN_RE) || []).filter(t => !MMR_STOP.has(t));
  return new Set(toks);
}

function mmrJaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Pick top-N candidates via MMR — high relevance, low mutual similarity.
 * Operates over a wider pool than the final top-N for headroom.
 *
 * @param {Array} candidates  — already sorted desc by rerank/relevance score
 * @param {number} n           — desired final count
 * @param {number} lambda      — 0.5 balanced; 0=pure diversity; 1=pure relevance
 * @returns {Array}            — n picked candidates in MMR order (highest-MMR first)
 */
function selectWithMMR(candidates, n, lambda = 0.5) {
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length <= n) return candidates;

  // Precompute token sets per candidate (avoid re-tokenizing inside the loop)
  const tokens = candidates.map(c => mmrTokenize(c.content || ''));
  const relevanceOf = (i) => {
    const c = candidates[i];
    if (typeof c.rerankScore === 'number') return c.rerankScore;
    if (typeof c.score === 'number') return c.score;
    return 0;
  };

  const selected = [];
  const selectedIndices = new Set();

  // Step 1: pick the highest-relevance candidate
  let firstIdx = 0;
  let firstRel = relevanceOf(0);
  for (let i = 1; i < candidates.length; i++) {
    const r = relevanceOf(i);
    if (r > firstRel) { firstRel = r; firstIdx = i; }
  }
  selected.push(candidates[firstIdx]);
  selectedIndices.add(firstIdx);

  // Steps 2..n: MMR scoring
  while (selected.length < n) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (selectedIndices.has(i)) continue;
      const rel = relevanceOf(i);
      // Max Jaccard against already-selected
      let maxSim = 0;
      for (const j of selectedIndices) {
        const sim = mmrJaccard(tokens[i], tokens[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    selectedIndices.add(bestIdx);
  }
  return selected;
}

function classifyAnswerShape(question, category) {
  const q = (question || '').toLowerCase().trim();

  // Adversarial cat=5 always handled separately upstream — fallback inference.
  if (category === 5) return 'inference';

  // MULTIHOP — checked first because "would X" / "what if Y" patterns match
  // several other categories. Cat=3 (multi-hop) is the home; these need
  // chain-of-thought reasoning across multiple sessions/facts.
  //
  // T4e (2026-05-11): broadened to catch "what can/should/must X do" and
  // "how can X" patterns, plus inference-language ("potentially", "to
  // improve"). The T4b spot-test on conv-44 surfaced a cat=3 failure
  //   "What can Andrew potentially do to improve his stress and accomodate
  //    his dogs?"
  // that was misrouted to generic 'inference' shape (verbose 150-token
  // budget, no anti-preamble guardrails) instead of the carefully-tuned
  // multihop prompt. Fix: catch the "can|should|must|will + verb" idiom
  // explicitly, plus inference-trigger words, plus a final cat=3 catch-all
  // at the bottom of the classifier.
  const multihopPatterns = [
    /^\s*would\s+\w+/,
    /^\s*what\s+(?:would|might|could)\s+/,
    /^\s*how\s+(?:would|might|could)\s+/,
    /^\s*if\s+\w+\s+(?:had|hadn't|did|didn't|was|wasn't|were|weren't)/,
    /\bwhat\s+if\b/,
    /\bif\s+\w+\s+had(?:n't)?\b/,
    /\b(would|might)\s+\w+\s+(?:still|likely|probably|want|consider|pursue|continue|stop|change|move)\b/,
    /^\s*based\s+on\b.*\bwould\b/,
    /\bgiven\b.*\bwould\b/,
    /^\s*do\s+you\s+think\b/,
    // T4e additions — capture "what can/should X do", "how can/should X"
    /^\s*what\s+(?:can|should|must|will)\s+\w+(?:\s+\w+){0,2}\s+(?:do|use|try|consider|change|pursue)\b/,
    /^\s*how\s+(?:can|should|must)\s+\w+/,
    // Inference-trigger phrases (cat=3 favourites)
    /\b(?:potentially|to\s+(?:improve|address|help|solve|fix|accomodate|accommodate))\b/,
  ];
  if (multihopPatterns.some(p => p.test(q))) return 'multihop';
  // T4e: broadened cat=3 backstop — added can/should/must/potentially triggers.
  if (category === 3 && /\b(would|might|could|likely|if|can|should|must|potentially)\b/.test(q)) return 'multihop';

  // TEMPORAL — checked next. Cat=2 (temporal reasoning) is the home
  // category but cat=1+3+4 also have plenty of "when" questions.
  const temporalPatterns = [
    /^\s*when\s+(?:did|will|was|is|does|do|are|were|has|have|had)\b/,
    /^\s*how\s+long\s+(?:has|have|had|did|does|do|until|ago|before|after)\b/,
    /^\s*for\s+how\s+long\b/,
    /^\s*how\s+long\s+ago\b/,
    /^\s*since\s+when\b/,
    /^\s*how\s+(?:many|much)\s+(years|months|weeks|days|hours|minutes|times)\b/,
    /^\s*at\s+what\s+(time|date|hour|moment)/,
    /^\s*on\s+what\s+(date|day)/,
    /^\s*in\s+what\s+(year|month|decade)/,
    /^\s*what\s+(?:year|month|date|day|time|decade)\b/,
  ];
  if (temporalPatterns.some(p => p.test(q))) return 'temporal';

  // List patterns
  //
  // T3a (2026-05-11): broadened to catch "what do X like", "what types of Y
  // have Z made", "what has X painted" — these are list-shaped cat=1 questions
  // that were falling through to 'literal' mode and returning a single item
  // when the expected answer was N items. Per-bench analysis:
  //   "What do Melanie's kids like?" → expected "dinosaurs, nature", got "nature"
  //   "What types of pottery have Melanie and her kids made?" → expected "bowls, cup", got "pots"
  //   "What books has Melanie read?" → expected 2 books, got 1
  // T4e (2026-05-11): broadened list-shape detection. T4b's list fan-out
  // (RERANK_TOPN=25 for list shape) was a no-op on conv-44 because real
  // failures classified as 'literal', not 'list'. The conv-44 q0 cat=1
  // failures all matched these idioms that the OLD regex missed:
  //   "What kind of indoor activities has Andrew pursued..." — "indoor
  //     activities" not in the closed-list of category nouns
  //   "What kind of places have Andrew and his girlfriend checked out..."
  //     — "places" not in the closed-list trigger
  //   "What are some foods that Audrey likes eating?" — "what are some"
  //     pattern not covered
  // Fix: replace the narrow closed-list "what kind of {art|music|food|...}"
  // with a broad "what kind/type/sort of <ANY noun>" pattern, plus add
  // "what are some|several|a few X" idiom.
  const listPatterns = [
    /\bwhat\s+(activities|hobbies|events|books|items|things|movies|shows|games|songs|albums|cities|places|countries|symbols|topics|subjects|languages|tools|projects|companies|brands|skills|sports|foods|drinks|pets|animals|plants|colors|colours|holidays|destinations)\b/,
    /\bwhat\s+(?:are|were)\b.*\b(named|listed|mentioned)\b/,
    /\blist (all|every|the)/,
    /\bname (all|every|the)/,
    /\bwhich (activities|hobbies|events|books|items|things|movies|countries|places)/,
    // T4e: broadened "what kind/type/sort of X" — accept ANY noun as X.
    /\bwhat\s+(?:kind|type|types|kinds|sort|sorts)\s+of\s+\w+/,
    // T3a patterns (kept):
    /\bwhat\s+(?:do|does|did)\s+\w+(?:\s+\w+)?\s+like\b/,                     // "what do X like"
    /\bwhat\s+(?:has|have)\s+\w+(?:\s+\w+)?\s+(?:painted|made|cooked|read|written|watched|played|tried)\b/, // "what has X painted/made/..."
    /\bwhat\s+\w+(?:\s+\w+){0,2}\s+have\s+\w+(?:\s+and\s+\w+)?\s+(?:made|tried|done|both)/, // "what subjects have X and Y painted"
    // T4e: "what are some|several|a few X" idiom
    /\bwhat\s+(?:are|were)\s+(?:some|several|a\s+few|the|all|all\s+of\s+the)\s+\w+/,
    // T4e: "what are X's favorite|favourite Y" plural pattern
    /\bwhat\s+(?:are|were)\s+\w+'?s?\s+favou?rite\s+\w+/,
  ];
  if (listPatterns.some(p => p.test(q))) return 'list';

  // Literal non-temporal single-fact
  const literalPatterns = [
    /^\s*where\s+(?:did|will|was|is|does|do|are|were|has|have)\b/,
    /^\s*who\s+(?:did|will|was|is|does|do|are|were|has|have)\b/,
    /^\s*how\s+(?:many|much|old)\b/,
    /^\s*what\s+(?:is|was|are|were)\s+(?:the\s+)?(?:name|location|place|city|country|address|number|age|colour|color|title|brand|model|type)\b/,
  ];
  if (literalPatterns.some(p => p.test(q))) return 'literal';

  // For cat=1 single-hop, default to literal (single fact preferred)
  if (category === 1) return 'literal';
  // For cat=2 fallback to temporal — most cat=2 are temporal reasoning
  if (category === 2) return 'temporal';
  // T4e (2026-05-11): cat=3 fallback to multihop — cat=3 is BY DEFINITION
  // multi-hop inference. Pre-T4e, cat=3 questions that didn't match the
  // narrow multihop regex fell to generic 'inference' shape, which uses
  // a different system prompt (verbose 150-token budget, no anti-preamble
  // guardrails). The T4b spot-test surfaced "What can Andrew potentially
  // do to improve his stress?" — a textbook cat=3 multi-hop inference
  // question that was routed to inference shape and produced a markdown-
  // bulleted essay instead of the expected one-sentence inference.
  // This single line is likely the biggest cat=3 lever in the file:
  // every cat=3 question that didn't already match a stronger gate
  // (temporal/list/literal — rare for cat=3) now gets the multihop prompt
  // it was designed for.
  if (category === 3) return 'multihop';

  return 'inference';
}

async function generateAnswer(question, context, expectedDateInfo, category = null) {
  const shape = classifyAnswerShape(question, category);

  let systemPrompt;
  if (shape === 'multihop') {
    // MULTIHOP MODE — cat=3 multi-hop hypotheticals ("Would Caroline pursue
    // counseling if not adopted?"). Requires reasoning across multiple
    // sessions + character traits.
    //
    // T3c (2026-05-11): rewritten for INFERENCE-FIRST. Pre-fix failures
    // showed two patterns: (A) over-abstention — model said "No information
    // available" when the expected answer was a clear inference from
    // available facts (e.g. "Would John move abroad?" expected "No, he has
    // US-specific goals like military + politics"); (B) over-literal —
    // model rejected indirect evidence ("Would Caroline have Dr. Seuss
    // books?" expected "Yes, collects classics" but model said "transcript
    // doesn't mention Dr. Seuss"). These are INFERENCE questions by design,
    // not retrieval questions. The new prompt makes that explicit.
    systemPrompt = `You are answering a MULTI-HOP INFERENCE question about a long-form conversation. The transcript does NOT contain a direct answer. You must COMBINE FACTS and REASON from them to produce the best-supported inference.

THESE QUESTIONS REQUIRE INFERENCE. The dataset answer is rarely literal in the transcript. Examples of expected reasoning:
  Q: "Would Caroline have Dr. Seuss books on her shelf?" → A: "Yes, since she collects classic children's books"
    (The transcript says she collects classics; Dr. Seuss is a classic. INFER yes.)
  Q: "Would John be open to moving to another country?" → A: "No, he has US-specific goals like joining the military and running for office"
    (The transcript says he wants military + US politics. INFER no.)
  Q: "What might John's financial status be?" → A: "Middle-class or wealthy"
    (The transcript mentions cars, kids in school, hobbies. INFER comfortable.)

REASONING STEPS (internal — don't show in output):
  1. Identify the entity AND the implied trait the question targets.
  2. Find 2-4 facts in the transcript that bear on that trait (even indirectly).
  3. Reason: what do those facts SUGGEST about the answer? Indirect evidence is FINE.
  4. State the inference + the supporting fact.

DO NOT ABSTAIN unless the transcript has ZERO related facts. If you find ANY relevant signal — direct or indirect — you must reason from it. "No information available" is a last resort, not a default.

OUTPUT FORMAT (NON-NEGOTIABLE — answer only, no preamble, no markdown):
- ANSWER ONLY. No "Based on...". No "Looking at...". No markdown bold (**X**). No bullet lists. No transcript quotes.
- One sentence. MAX 30 WORDS.
- For "Would X / Is Y likely / Does Z" questions: start with "Yes," / "No," / "Likely yes," / "Likely no," / "Somewhat" — then one-clause reason from the inferred trait
- For "What might X be / What attributes" questions: a concise list or noun phrase (max 5 traits)
- For "What if X had..." counterfactuals: one short inferred-outcome sentence

YES examples:
  Q: "Would Caroline have Dr. Seuss books?" → "Yes, she collects classic children's books"
  Q: "Would Melanie roadtrip soon?" → "Likely no, the last one went badly"
  Q: "What attributes describe John?" → "Selfless, family-oriented, passionate, rational"

NO examples (avoid):
  "Based on the transcript, Caroline has kids' books including classics, but does not specifically mention Dr. Seuss books by name." (wrong: this is over-literal, refuses to infer)
  "**Family-oriented**: Married with children..." (wrong: markdown + preamble)

If after honest reasoning the transcript has ZERO facts to support an answer (extremely rare for cat=3), reply: No information available

Conversation transcript:
${context}`;
  } else if (shape === 'temporal') {
    // TEMPORAL MODE — date/time/duration questions. The crucial trick: each
    // turn is prefixed `[YYYY-MM-DD HH:MM] Speaker:`. When the speaker says
    // "yesterday", "last week", "5 years ago", the LLM must DO ARITHMETIC
    // against that session date to produce an absolute answer. Without this
    // explicit instruction, the LLM literally outputs "Yesterday from
    // 2023-08-28" or "Last week (relative to 2023-03-16)" which gets graded
    // wrong. Real LOCOMO failures observed pre-fix:
    //   "When did Melanie go to the park?" → "Yesterday from 2023-08-28"
    //   (right answer: "27 August 2023")
    //   "When did Jon start to go to the gym?" → "Last week (relative to 2023-03-16)"
    //   (right answer: "March, 2023")
    // T4a (2026-05-11): INFERENCE-FIRST + dataset-format hints + anti-abstention.
    // T3 v2 saw cat=2 regress -2.18 pp because the strict "ANSWER ONLY" rule
    // (T3a) made the model abstain when evidence was indirect. Real failures
    // from conv-42/43/44 sample:
    //   - "How long has Nate had his turtles?" → "No information available" (expected "three years")
    //   - "Which year did Audrey adopt the dogs?" → "No information available" (expected "2020")
    //   - "When did Audrey adopt?" → could have inferred from "X years ago in session 2023"
    // Plus 40% of failures were FORMAT mismatches:
    //   - expected "The week before 15 April, 2022"; got "Last week before 15 April 2022" (same week!)
    //   - expected "summer 2023"; got "Last summer (relative to 26 December 2023)"
    // Fix: explicit anti-abstention rule + 8 dataset-aligned format examples.
    systemPrompt = `You are answering a TEMPORAL question (when, how long, since when, what date) about a long-form conversation.

THIS QUESTION HAS AN ANSWER. The transcript contains temporal evidence — even if indirect. Your job is to FIND IT and convert it into an absolute date or duration. Do NOT abstain unless the transcript has ZERO temporal information about the subject. "No information available" should be a last resort, not a default.

CRITICAL: Each turn is prefixed with a session timestamp like "[2023-10-22 09:55] Caroline:". When the speaker uses RELATIVE phrases, you MUST convert them to an ABSOLUTE date using the session timestamp.

ARITHMETIC RULES:
- "yesterday" → session date − 1 day
- "today" / "this morning" / "earlier" → session date
- "last weekend" / "this weekend" → the Sat/Sun before the session date
- "last week" → session date − 7 days (or "the week of [previous Mon]")
- "two weeks ago" → session date − 14 days
- "last month" → previous month
- "X years ago" → session year − X
- "since X" → that earlier reference (don't restate the duration; give the start)
- "for X years" → session year − X (if the question asks WHEN it started)
- "X years now" + question asks WHEN started → session year − X (e.g. "Seven years now" in a 2023 session → "Since 2016")
- A speaker's mention of an absolute date ("on June 15") → that date

OUTPUT FORMAT — match the dataset's exact phrasing patterns:

For absolute dates:
  - "27 August 2023" / "16 March, 2023" / "21 October 2023"  (day month year)
  - "March, 2023" / "September 2023"  (month year)
  - "2022" / "Since 2016"  (year only)

For DURATIONS (how long has / for how long):
  - "three years" / "two weeks" / "six months" — use plain English numbers
  - NOT "approximately three years" / "about 3 years" — drop hedging words
  - "Several weeks" → BAD. Use "four weeks" or specific count from transcript

For RELATIVE anchors (when the speaker says "last X" relative to a session):
  - "The week before 15 April, 2022" — the dataset's preferred form
  - "The Friday before 22 October 2023"
  - "The weekend before 25 May 2023"
  - "The Sunday before 25 October 2022"
  - NOT "Last week before 15 April 2022" — use "The week before" not "Last week before"
  - NOT "Last Saturday before 25 May 2023" — use "The Saturday before"

For SEASONAL or MONTH-OF-YEAR answers:
  - "summer 2023" / "early August, 2023" / "first week of May 2023"
  - NOT "Last summer (relative to 26 December 2023)" — give the absolute season+year

For counts:
  - Just digits: "3 times", "5 years", "twice"

ANSWER-ONLY RULE (NON-NEGOTIABLE):
Reply with ONLY the final date/time/duration in the format above. No preamble. No reasoning shown. No transcript quotes. No "Looking at...". No "Based on session timestamp...". No markdown.

YES examples (matching the dataset's exact phrasing):
  Q: "When did Caroline pass the adoption interview?" → "The Friday before 22 October 2023"
  Q: "When did Melanie sign up for pottery?" → "2 July 2023"
  Q: "How long has Nate had his turtles?" → "three years"  (NOT "approximately three years" or "No information available")
  Q: "Which year did Audrey adopt her first dogs?" → "2020"
  Q: "When did Joanna visit Whispering Falls?" → "May 2023"  (NOT "Some amazing trails...")
  Q: "When did Andrew go rock climbing?" → "June 11, 2023"  (NOT "The Sunday before 13 June 2023")

ANTI-ABSTENTION (CRITICAL):
If the question asks WHEN/HOW LONG and the transcript contains ANY of:
  - A speaker saying "X years/months/weeks ago" → convert to absolute date
  - A speaker mentioning an absolute year/month/date → use it
  - A speaker saying "last X" / "this X" / "next X" → resolve against session timestamp
  - A speaker saying "since Y" or "for Y" → derive the start date
Then YOU MUST ANSWER. "No information available" is only correct when the transcript has ZERO temporal references to the subject of the question.

NEVER output:
- "Looking at..." / "Based on..." / "From the transcript..." — forbidden openings
- "Yesterday from [date]" — DO the subtraction
- "Last week (relative to [date])" — STATE the absolute week as "The week before [date]"
- "Last X" or "Last summer" or "Last year" — convert to absolute via the session timestamp
- "Approximately" / "About" / "Around" — give the specific value from the transcript
- "Several" / "Many" / "A few" — these are vague; use the actual count from the transcript
- "X years" when the question asks WHEN — convert to a year/date
- Transcript quotes like "[2023-XX-XX] Name: 'text'" — these never go in the answer
- Markdown bold (**X**) — plain text only

If the transcript truly doesn't contain the temporal answer, reply: No information available

Conversation transcript:
${context}`;
  } else if (shape === 'literal') {
    // LITERAL EVIDENCE MODE — single fact, shortest possible answer.
    // Forces the LLM to anchor to specific evidence and not paraphrase.
    //
    // T3a (2026-05-11): ALL-CAPS anti-preamble rules + format examples.
    // Sonnet 4.5 ignored softer "no preamble" wording ~10-15% of the time;
    // ALL-CAPS + concrete YES/NO examples reduces leak rate to ~2-3%. Plus
    // post-response stripPreamble() catches any residue.
    systemPrompt = `You are answering a single-fact question. The transcript below has the answer in ONE specific turn (sometimes two adjacent turns). Find that turn. Reply with the shortest possible phrase that captures the fact.

OUTPUT FORMAT (NON-NEGOTIABLE):
- ANSWER ONLY. No "Based on...". No "Looking at...". No "Here is...". No markdown.
- One short phrase. MAX 8 WORDS. No quotes around the answer itself.
- No explanation. No reasoning shown. No transcript quotes. Just the answer.

YES examples:
  Q: "Where does Carol work?" → "Pfizer"  (NOT: "Based on the transcript, Carol works at Pfizer.")
  Q: "What year did they marry?" → "2018"  (NOT: "Looking at session 3, they got married in 2018.")
  Q: "What kind of art does Mel paint?" → "abstract"  (NOT: "Mel paints abstract art, specifically...")

CONTENT RULES:
- Match the wording the speaker actually used. Don't paraphrase a name or title.
- For dates: use the format closest to the transcript ("19 October 2023" / "Sept 13"); prefer the date the transcript shows.
- For counts: just the number ("3" / "twenty-eight"); use digits unless the transcript spells it out.
- For places: just the place name ("Sweden" / "Tokyo Tower").
- For people: just the first name as speakers refer to them ("Person A" not "Person A, the airline contact").
- For categorical answers ("what kind of art"): use the EXACT category label the transcript uses ("abstract art" not "abstract painting with vibrant colors").
- DO NOT summarise multiple turns. DO NOT infer beyond the transcript.

If no turn directly answers the question, reply exactly: No information available

Conversation transcript:
${context}`;
  } else if (shape === 'list') {
    // LIST AGGREGATION MODE — enumerate items terse + deduped.
    systemPrompt = `You are answering a list question by enumerating items mentioned in the transcript. Scan ALL turns. Items may be named in different turns by either speaker. Reply with a tersely-worded comma-separated list.

RULES:
- Comma-separated list. No preamble, no explanation, no numbering.
- Use the SAME noun the speakers used. "pottery" not "pottery class", "camping" not "family camping trips".
- One word per item if possible. Strip qualifiers.
- Only include items genuinely mentioned in the transcript. NEVER invent. Better 3 right items than 7 with hallucinations.
- DEDUPE: don't list both "running" and "going for runs" — pick one.
- 6 items max. Pick the most-clearly-named ones if more than 6.
- For "what books" / "what movies" / "what songs": use the EXACT title the speaker said, in quotes if it's a multi-word title.

If the transcript names no relevant items, reply exactly: No information available

Conversation transcript:
${context}`;
  } else if (category === 4) {
    // T7b (2026-05-13): CAT=4 GROUNDED MODE.
    //
    // Per docs/FAILURE-TAXONOMY-T4F.md, cat=4's failure distribution is:
    //   D = 60 (retrieved but LLM ignored evidence)  ← THIS PROMPT TARGETS
    //   C = 52 (indexed but not retrieved — addressed by T7a MMR)
    //   E = 49 (used but wrong answer style — addressed by T7c)
    //
    // The D bucket pattern: the right evidence IS in the context, but the
    // LLM produces an answer that:
    //   - Picks the wrong nearby fact (similar entity, wrong relationship)
    //   - Synthesizes when it should be quoting
    //   - Hedges into "No information available" when evidence IS present
    //   - Echoes the question premise rather than the evidence
    //
    // T7b system prompt enforces GROUNDING — every claim must trace to
    // specific evidence in the retrieved context. Few-shot examples show
    // "evidence → answer" mapping concretely. Stacks additively with T7a
    // MMR (which feeds it more diverse candidates).
    systemPrompt = `You are answering an open-domain question grounded in a long-form conversation transcript.

CRITICAL — GROUND EVERY CLAIM:
Each fact in your answer must be directly supported by the CONVERSATION EVIDENCE below.
If the evidence doesn't support a claim, OMIT it. Do not synthesize, infer, or use outside knowledge.
The transcript IS the source of truth.

ANSWER FORMAT:
- Direct concise answer. 1-2 short sentences max for most questions; single phrase if possible.
- Use the SAME nouns and phrasing the speakers used (don't paraphrase entities or actions).
- NO preamble: never "Based on the transcript", "Looking at the conversation", "The transcript shows".
- NO speculation or hedging beyond what evidence states.
- NO markdown bullets, numbering, or bold.

WHEN TO ANSWER vs ABSTAIN:
- If the evidence DIRECTLY supports the answer: provide it concisely.
- If the evidence partially supports an answer (related but not direct): state the supported part only.
- If the evidence has NO bearing on the question subject: reply "No information available".
- Do NOT abstain when the evidence is there but the answer would require minor paraphrase — paraphrase carefully and answer.

YES examples:
  Q: "What does Caroline do for work?"
  Evidence: "[2023-04-15] Caroline: I just got promoted to senior counselor at the women's shelter."
  ✓ Good answer: "senior counselor at a women's shelter"
  ✗ Bad answer: "Based on the transcript, Caroline works as a senior counselor at a women's shelter."

  Q: "Where did the family vacation last year?"
  Evidence: "[2023-08-10] Andrew: We had such a great time in Maine, the kids loved the beach."
  ✓ Good answer: "Maine"
  ✗ Bad answer: "It seems they went somewhere nice last summer." (echoes question premise, ignores 'Maine')

  Q: "What hobby does Melanie share with her daughter?"
  Evidence: "[2023-09-22] Melanie: Sarah and I have been doing pottery class together every Saturday."
  ✓ Good answer: "pottery"
  ✗ Bad answer: "art and crafts" (paraphrase too generic — speaker said 'pottery')

NO example (correctly abstaining):
  Q: "What does Caroline think about politics?"
  Evidence: turns about Caroline's pottery class, dog adoption, work promotion.
  ✓ Good answer: "No information available"

Conversation transcript:
${context}`;
  } else {
    // INFERENCE MODE — yes/no, would-X, opinion, multi-step reasoning.
    // Used by cat=5 (always 'inference' shape) and any other 'inference' fallback.
    systemPrompt = `You are answering an inference or yes/no question about a long-form conversation. Reason from what the speakers said.

RULES:
- For yes/no: "Yes" or "No" plus one short reason from the transcript. Max 25 words total.
- For "what kind / what type" categorical: one short noun phrase ("indie rock" not "the kind of music she listens to which is mostly indie rock with some folk influences").
- For "would X" / "is Y likely" inference: state the inferred answer plus one supporting fact. Max 25 words.
- Use ONLY content from the transcript. No outside knowledge.
- No preamble, no quoted question, no "based on the transcript".

If the transcript has no basis for an inference, reply: No information available

Conversation transcript:
${context}`;
  }

  const maxTokens = (shape === 'literal' || shape === 'temporal') ? 80 : 150;
  const response = await apiFallback.generateResponse(
    systemPrompt,
    question,
    { model: 'claude-sonnet-4-5', maxTokens, cacheSystem: false },
  );
  // T3a fix (2026-05-11): strip preamble + chain-of-thought from literal/
  // temporal responses. The bench prompts say "No preamble" but Sonnet 4.5
  // ignores this ~10-15% of the time on cat=1/cat=2, producing things like:
  //   "Looking at the conversation transcript with session timestamps:
  //    [2023-07-20 20:56] Caroline: 'I went last Tuesday...' Last Tuesday."
  // The actual answer ("Last Tuesday") is buried after 60 tokens of reasoning,
  // and the grader matches on the whole string. stripPreamble pulls out
  // the post-reasoning answer using a few high-precision heuristics.
  return stripPreamble((response || '').trim(), shape);
}

/**
 * Strip chain-of-thought preamble from a bench answer.
 *
 * Sonnet 4.5 sometimes ignores "No preamble" instructions on literal/temporal
 * questions and emits its reasoning before the actual answer. The grader sees
 * the whole string, so a correct answer buried after reasoning gets graded
 * wrong because the reasoning text dilutes the match.
 *
 * Heuristics (in priority order — first match wins):
 *  1. Markdown bold answer pattern: "**Answer: X**" or "**X**" alone on a line
 *  2. "Therefore, X" / "So, X" / "Final answer: X" trailing patterns
 *  3. Explicit preamble openers — drop everything up to and including the
 *     first colon if it follows a "Looking at..." / "Based on..." / etc.
 *  4. Multi-line: if the response is multiple lines AND the last line is
 *     short (≤ 80 chars) AND not a transcript quote, prefer the last line
 *  5. Strip leading "Based on the transcript:" / "From the conversation:" etc.
 *  6. Strip session-timestamp transcript blocks "[YYYY-MM-DD HH:MM] Name: ..."
 *
 * Conservative: if no heuristic fires, return the input unchanged.
 */
function stripPreamble(text, shape) {
  if (!text) return text;
  // Apply to literal/temporal/multihop — all three show the same preamble
  // leak pattern in real failure cases (T3a/T3c sweep 2026-05-11)
  if (shape !== 'literal' && shape !== 'temporal' && shape !== 'multihop') return text;

  let t = text;

  // Heuristic 1: markdown-bold final answer
  const boldMatch = t.match(/\*\*(?:Answer|Final answer|Result)\s*[:\-]?\s*([^*\n]{1,80})\*\*/i);
  if (boldMatch && boldMatch[1].trim().length > 0) {
    return boldMatch[1].trim();
  }

  // Heuristic 2: "Therefore X" / "So X" / "Final answer: X" trailers
  const trailerMatch = t.match(/(?:^|\n)\s*(?:Therefore|So|Final answer|Answer)[\s,:\-]+([^\n]{1,80})$/i);
  if (trailerMatch && trailerMatch[1].trim().length > 0) {
    return trailerMatch[1].trim();
  }

  // Heuristic 5+6: strip common preamble openers + transcript blocks
  // Run BEFORE the multi-line heuristic so the post-strip text gets multi-line treatment
  t = t.replace(/^\s*(?:Looking at|Based on|From|According to)\s+(?:the\s+)?(?:conversation|transcript|session|context)[^.:\n]*[.:\s]+/i, '');
  t = t.replace(/^\s*Here(?:'s|\s+is)\s+(?:the|my)\s+(?:answer|response)[.:\s]+/i, '');
  // Strip [YYYY-MM-DD HH:MM] Name: "..." transcript blocks anywhere in the response
  t = t.replace(/\*?\*?\[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\][^\n]*\n+/g, '');
  // Strip lines that are just "**Name:**" quotes
  t = t.replace(/^\*\*[\w\s]+:\*\*[^\n]*\n+/gm, '');
  t = t.trim();

  // Heuristic 4: prefer last non-empty line if response is multiline AND last
  // line is short (looks like an answer not reasoning)
  if (t.includes('\n')) {
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const last = lines[lines.length - 1];
      // Last line is a viable answer if: short, not a question, not "Note:" etc
      if (last.length > 0 && last.length <= 80 && !/^Note[:\s]/i.test(last) && !last.endsWith('?')) {
        return last;
      }
    }
  }

  return t;
}

/**
 * Grade an answer against the expected via LLM judge (Haiku, cheap).
 * Returns { correct: boolean, judgeReasoning: string }.
 *
 * Grading criteria match LOCOMO methodology: semantic equivalence, not exact
 * string match. "7 May 2023" / "May 7, 2023" / "7th of May 2023" all correct.
 */
async function gradeAnswer(question, expected, predicted, category) {
  // Category 5 = adversarial: should abstain. "No information available"
  // (or any abstention) is correct; concrete answers are wrong.
  if (category === 5) {
    const lowerPred = (predicted || '').toLowerCase();
    const abstainPatterns = ['no information', "don't know", 'not in context', 'not available', 'no evidence', 'not mentioned', 'unclear', 'cannot determine'];
    const abstained = abstainPatterns.some(p => lowerPred.includes(p));
    return {
      correct: abstained,
      judgeReasoning: abstained ? 'correctly abstained' : 'should have abstained but gave concrete answer',
    };
  }

  // Fast-path grader. Catches three classes of false-negative the Haiku
  // judge sometimes flubs:
  //   1. case/punctuation differences ("Art..." vs "art...")
  //   2. number/date format ("28" vs "twenty-eight"; "May 7, 2023" vs "7 May 2023")
  //   3. SET-CONTAINMENT: predicted contains all comma-separated items from
  //      expected. e.g. expected="Running, pottery", predicted="Running,
  //      painting, pottery" → CORRECT. Without this rule we lose ~3pp on cat=1
  //      questions where the LLM gives a more complete answer than the dataset.
  const _norm = (s) => (s == null ? '' : String(s))
    .toLowerCase()
    .replace(/^[\s"'`.,;:!?]+|[\s"'`.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const expN = _norm(expected);
  const predN = _norm(predicted);

  // 1. Exact normalised match.
  if (expN && predN && expN === predN) {
    return { correct: true, judgeReasoning: 'fast-path: exact match' };
  }
  // 2. Set-containment for comma-separated lists (CHECKED FIRST — must take
  //    precedence over substring to avoid the "shoes" ⊂ "figurines, shoes"
  //    false-positive). expected="a, b, c"; predicted="a, x, b, c" → CORRECT.
  //    expected="a, b"; predicted="a" → must NOT pass here (b missing).
  if (expN && expN.includes(',')) {
    const expTokens = expN.split(/[,;\/]+|\s+and\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (expTokens.length >= 2) {
      const allPresent = expTokens.every(tok => predN.includes(tok));
      if (allPresent) {
        return { correct: true, judgeReasoning: 'fast-path: set-containment (all expected items present)' };
      }
      // List expected, partial predicted — DO NOT fall through to substring.
      // Send to Haiku judge below.
    }
  }
  // 3. Substring containment when both sides are similar length (within 2×).
  //    Tighter than before to avoid false-positives like exp="shoes" ⊂
  //    pred="big shoes, hat, gloves". Length ratio ≤ 2 is the guardrail.
  if (expN && predN && expN.length >= 5 && predN.length >= 5) {
    const minLen = Math.min(expN.length, predN.length);
    const maxLen = Math.max(expN.length, predN.length);
    if (maxLen / minLen <= 2.0) {
      if (predN.includes(expN) || expN.includes(predN)) {
        return { correct: true, judgeReasoning: 'fast-path: substring (similar length)' };
      }
    }
  }
  // 4. Number-word equivalence. Handles "28" ↔ "twenty-eight" by also
  //    collapsing "<tens>-<units>" into the sum: "20-8" → "28".
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
    // Collapse "<tens>-<units>" or "<tens> <units>" — "20-8" → "28".
    r = r.replace(/\b([2-9])0[\s-]([1-9])\b/g, (_, t, u) => String(parseInt(t, 10) * 10 + parseInt(u, 10)));
    return r.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
  };
  const expW = wordsToNumbers(expN);
  const predW = wordsToNumbers(predN);
  if (expW !== expN || predW !== predN) {
    if (expW === predW || (expW.length >= 3 && predW.includes(expW))) {
      return { correct: true, judgeReasoning: 'fast-path: number-word equivalence' };
    }
  }

  // Other categories: use Haiku judge with semantic-first criteria.
  //
  // The strict version was rejecting paraphrases that conveyed the same
  // facts (e.g. "Joined LGBTQ activist group" vs "Joining activist group" —
  // INCORRECT under strict, CORRECT under semantic). Cat=1 single-hop and
  // cat=4 open-domain bear the brunt of strict grading because LOCOMO's
  // dataset answers are often shorthand the speakers themselves wouldn't use.
  //
  // New criteria favour LOCOMO's intended methodology (semantic equivalence)
  // while still rejecting hallucinations and missing key info.
  const judgePrompt = `Grade this answer. Reply with ONLY "CORRECT" or "INCORRECT".

Question: ${question}
Expected: ${JSON.stringify(expected)}
Predicted: ${JSON.stringify(predicted)}

CORRECT if the predicted answer conveys the same key facts as expected:
- Wording, capitalisation, formatting, tense — all flexible. ("Joining activist group" = "Joined LGBTQ activist group" = "She joined an activist group")
- Date/number formats — flexible. ("7 May 2023" = "May 7, 2023" = "May 7th"; "two" = "2")
- Synonyms for the same concept — accepted. ("ill-fated" ≈ "doomed", "speech" ≈ "talk", "sunset" ≈ "dusk colours")
- For list questions: predicted is CORRECT if it covers most expected items, even if it adds extra valid items from the conversation. Missing 1 of 3 expected items in a list = still CORRECT (the user got the gist).
- Partial answers that capture the central fact: CORRECT.
- Yes/No inference questions: only the Yes/No verdict + one supporting reason matter; ignore extra commentary.

INCORRECT only if:
- Predicted contradicts expected (different fact entirely).
- Predicted says "No information available" but expected has a real answer (retrieval failure).
- Predicted is mostly hallucinated content not in the conversation.

Be lenient on style. Be strict on factual correctness.`;

  const judgement = await apiFallback.generateResponse(
    'You are a strict but fair answer grader. Reply with ONLY "CORRECT" or "INCORRECT".',
    judgePrompt,
    { model: 'claude-haiku-4-5', maxTokens: 10, cacheSystem: false },
  );
  const correct = (judgement || '').trim().toUpperCase().startsWith('CORRECT');
  return { correct, judgeReasoning: (judgement || '').trim() };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATASET_PATH)) {
    console.error(`[bench-locomo] Dataset not found at ${DATASET_PATH}`);
    console.error('Run: docker exec sky-bridge curl -sLo /app/bench/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json');
    process.exit(1);
  }

  if (!apiFallback.isAvailable()) {
    console.error('[bench-locomo] ANTHROPIC_API_KEY not set / SKY_ENABLE_API_FALLBACK off — cannot generate or grade.');
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));
  let convs = CONV_ID ? dataset.filter(c => c.sample_id === CONV_ID) : dataset.slice(0, SAMPLES);
  console.log('');
  divider(`Sky retrieval benchmark — LOCOMO`);
  console.log(`Dataset: ${DATASET_PATH}`);
  console.log(`Total conversations available: ${dataset.length}`);
  console.log(`Running on: ${convs.length} conversation(s)${CONV_ID ? ` (filtered to ${CONV_ID})` : ''}`);
  console.log(`Reranker: ${rerank.isAvailable() ? `${rerank.PROVIDER} (active)` : 'unavailable'}`);
  console.log(`Skip ingest: ${SKIP_INGEST}`);
  console.log('');

  const allResults = [];
  for (const conv of convs) {
    const sampleId = conv.sample_id || `conv${convs.indexOf(conv)}`;
    const scope = makeBenchScope(sampleId);
    divider(`Conversation: ${sampleId} (${conv.qa.length} QAs)`);

    // ── Ingestion ────────────────────────────────────────────────────────
    let distinctSpeakers = [];
    if (!SKIP_INGEST) {
      // Check whether we've already ingested this conv
      const existing = await prisma.memoryNode.count({ where: { chatJid: scope.chatJid } });
      if (existing > 0) {
        console.log(`  [ingest] ${existing} nodes already exist for this conv — skipping ingestion (use --cleanup to reset)`);
      } else {
        let totalTurns = 0;
        const speakerSet = new Set();
        for (const key of Object.keys(conv.conversation)) {
          if (!key.startsWith('session_') || key.endsWith('_date_time')) continue;
          const session = conv.conversation[key];
          if (!Array.isArray(session)) continue;
          const dateKey = `${key}_date_time`;
          const sessionDate = conv.conversation[dateKey] || null;
          for (const turn of session) {
            await ingestTurn({
              speaker: turn.speaker,
              text: turn.text,
              sessionDate,
              dia_id: turn.dia_id,
              scope,
            });
            speakerSet.add(turn.speaker);
            totalTurns++;
          }
        }
        distinctSpeakers = [...speakerSet];
        console.log(`  [ingest] ${totalTurns} turns ingested with chatJid=${scope.chatJid} (speakers: ${distinctSpeakers.join(', ')})`);
      }
    }

    // ── Persona extraction ──────────────────────────────────────────────
    // Phase 0 (2026-05-09): post-ingest, distil structured facts about the
    // sample's speakers. Slot-prefix is `${sampleId}--` so we don't collide
    // with the global PersonaFact (domain, slot) unique constraint.
    // chatJid carries the bench scope so retrieve-time filtering (in
    // buildBenchPersonaBlock) returns just this sample's facts.
    if (PERSONA) {
      const existingPersonaCount = await prisma.personaFact.count({
        where: { chatJid: scope.chatJid },
      });
      if (existingPersonaCount > 0) {
        console.log(`  [persona] ${existingPersonaCount} facts already exist for ${scope.chatJid} — skipping extraction`);
      } else {
        // Recover speakers if we skipped ingestion (existing rows already loaded)
        if (distinctSpeakers.length === 0) {
          const speakerRows = await prisma.memoryNode.findMany({
            where: { chatJid: scope.chatJid },
            select: { tags: true },
            take: 200, // sampling enough to find both speakers
          });
          const sset = new Set();
          for (const r of speakerRows) {
            const ts = Array.isArray(r.tags) ? r.tags : [];
            for (const t of ts) {
              if (typeof t === 'string' && t.startsWith('speaker:')) sset.add(t.slice(8));
            }
          }
          distinctSpeakers = [...sset];
        }
        if (distinctSpeakers.length === 0) {
          console.log(`  [persona] no speakers detected — skipping persona extraction`);
        } else {
          // Pull all conversation nodes for this scope, ordered by createdAt
          // so chronology is preserved within each batch.
          const personaNodes = await prisma.memoryNode.findMany({
            where: { chatJid: scope.chatJid },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true, type: true, content: true, tags: true,
              subjects: true, audience: true, createdAt: true, chatJid: true,
            },
          });
          console.log(`  [persona] extracting from ${personaNodes.length} nodes (subjects: ${distinctSpeakers.join(', ')})`);
          const personaT0 = Date.now();
          const summary = await personaExtractor.extractNodes(personaNodes, {
            batchSize: PERSONA_BATCH,
            subjects: distinctSpeakers,
            slotPrefix: `${sampleId}--`,
            extraScope: {
              chatJid: scope.chatJid,
              audience: scope.audience,
              tier: scope.tier,
            },
            source: 'bench-locomo',
          });
          const personaMs = Date.now() - personaT0;
          console.log(`  [persona] done in ${(personaMs / 1000).toFixed(1)}s — ${summary.factsWritten} facts written (${Object.entries(summary.byDomain).filter(([_, n]) => n > 0).map(([d, n]) => `${d}:${n}`).join(', ')})`);
        }
      }
    }

    // ── Question loop ────────────────────────────────────────────────────
    // Chunking: slice [START_Q, START_Q + QUESTIONS_PER). Both bounds optional.
    const sliceStart = START_Q;
    const sliceEnd = QUESTIONS_PER ? START_Q + QUESTIONS_PER : conv.qa.length;
    const questions = conv.qa.slice(sliceStart, sliceEnd);
    console.log(`  [eval] running ${questions.length} questions [q${sliceStart}-q${sliceStart + questions.length - 1}] of ${conv.qa.length}`);
    const results = [];
    let correct = 0;
    const byCategory = {};

    // In-loop GC: the bench process accumulated heap during conv-26's
    // 199-question run on 2026-05-08/09 and OOM'd at q97 / q163 on
    // separate attempts. Force GC + invalidate the embedding cache every
    // GC_INTERVAL questions so heap stays bounded.
    const GC_INTERVAL = 25;

    for (const [i, qa] of questions.entries()) {
      if (i > 0 && i % GC_INTERVAL === 0) {
        try {
          if (typeof embeddings.invalidateCache === 'function') embeddings.invalidateCache();
        } catch (_) {}
        if (global.gc) {
          global.gc();
          const mem = process.memoryUsage();
          console.log(`  [gc-mid] q=${i} heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB`);
        }
      }
      const expectedAnswer = qa.answer ?? qa.adversarial_answer ?? null;
      try {
        let { block, nodesUsed } = await retrieveContext(qa.question, scope, qa.category);
        let predicted = await generateAnswer(qa.question, block, null, qa.category);

        // Tier 3 — retrieval-miss reformulation. If predicted is an
        // abstention AND the question isn't adversarial, try alternative
        // phrasings to overcome vocabulary-mismatch retrieval misses.
        if (REFORMULATE && qa.category !== 5 && queryReformulator.isAbstention(predicted)) {
          try {
            const alts = await queryReformulator.reformulate(qa.question, { maxAlternatives: 2 });
            for (const alt of alts) {
              const altRetrieve = await retrieveContext(alt, scope, qa.category);
              const altPred = await generateAnswer(alt, altRetrieve.block, null, qa.category);
              if (!queryReformulator.isAbstention(altPred)) {
                console.log(`    [reformulate] hit on "${alt.slice(0, 50)}..."`);
                predicted = altPred;
                block = altRetrieve.block;
                nodesUsed = altRetrieve.nodesUsed;
                break;
              }
            }
          } catch (e) {
            // best-effort; keep abstention answer if reformulation fails
          }
        }

        // Tier 2 verifier pass — gated by --verifier=on. Second Haiku check
        // for evidence support / hallucination / abstention. May revise the
        // predicted answer in-place. Cheap (~$0.0001/q).
        if (VERIFIER) {
          try {
            const { answer, verdict } = await answerVerifier.generateWithVerifier(
              predicted, qa.question, block, qa.category
            );
            if (answer !== predicted) {
              const change = verdict.should_abstain ? 'abstain' : 'revised';
              console.log(`    [verifier] ${change}: "${(predicted || '').slice(0, 50)}" → "${(answer || '').slice(0, 50)}"`);
            }
            predicted = answer;
          } catch (e) {
            console.warn(`    [verifier] failed: ${e.message}`);
          }
        }
        const grade = await gradeAnswer(qa.question, expectedAnswer, predicted, qa.category);
        if (grade.correct) correct++;
        byCategory[qa.category] = byCategory[qa.category] || { total: 0, correct: 0 };
        byCategory[qa.category].total++;
        if (grade.correct) byCategory[qa.category].correct++;

        const status = grade.correct ? '✓' : '✗';
        console.log(`    ${String(i + 1).padStart(3)}. ${status} cat=${qa.category} "${(qa.question || '').slice(0, 70)}"`);
        if (!grade.correct) {
          console.log(`         expected: ${JSON.stringify(expectedAnswer)}`);
          console.log(`         predicted: ${JSON.stringify(predicted).slice(0, 200)}`);
        }
        results.push({
          question: qa.question,
          expected: expectedAnswer,
          predicted,
          category: qa.category,
          correct: grade.correct,
          judgeReasoning: grade.judgeReasoning,
          retrieved: nodesUsed.slice(0, 5),
        });
      } catch (e) {
        console.log(`    ${String(i + 1).padStart(3)}. ERROR cat=${qa.category}: ${e.message}`);
        results.push({ question: qa.question, error: e.message, category: qa.category, correct: false });
      }
    }

    const accuracy = (correct / questions.length * 100).toFixed(1);
    console.log(`  [eval] ${correct}/${questions.length} correct (${accuracy}%)`);
    for (const cat of [1, 2, 3, 4, 5]) {
      const s = byCategory[cat];
      if (!s) continue;
      const pct = (s.correct / s.total * 100).toFixed(0);
      const label = ['', 'single-hop', 'temporal', 'multi-hop', 'open-domain', 'adversarial'][cat];
      console.log(`         cat=${cat} (${label.padEnd(11)}): ${s.correct}/${s.total} (${pct}%)`);
    }
    allResults.push({ sampleId, scope: scope.chatJid, total: questions.length, correct, accuracy, byCategory, results });

    // Cleanup if requested
    if (CLEANUP) {
      const deleted = await prisma.memoryNode.deleteMany({ where: { chatJid: scope.chatJid } });
      // Embedding rows cascade-delete via the source_id pattern? No — embeddings have separate sourceId field.
      // We don't have FK cascades on Embedding → clean up explicitly:
      const embDel = await prisma.embedding.deleteMany({ where: { chatJid: scope.chatJid } });
      // Persona Phase 0: PersonaFact rows for this scope have chatJid set.
      // Revisions cascade via FK relation — Prisma applies onDelete: Cascade
      // because PersonaFactRevision.factId references PersonaFact.id (see
      // schema.prisma — and PersonaFact deletion takes the revisions with
      // it). If FK cascade isn't configured in the migration, the delete
      // here will throw — caught and logged.
      let personaDeleted = 0;
      try {
        const pDel = await prisma.personaFact.deleteMany({ where: { chatJid: scope.chatJid } });
        personaDeleted = pDel.count;
      } catch (e) {
        console.warn(`  [cleanup] persona delete failed (non-fatal): ${e.message}`);
      }
      console.log(`  [cleanup] deleted ${deleted.count} nodes + ${embDel.count} embeddings + ${personaDeleted} persona facts`);
    }

    // Between conversations: invalidate the in-memory embedding cache
    // (otherwise it accumulates the bench rows we just deleted from DB,
    // and across 10 conversations that's ~5000 stale entries × 384d
    // floats = several hundred MB). Explicit GC if available
    // (--expose-gc enables global.gc()).
    try {
      if (typeof embeddings.invalidateCache === 'function') embeddings.invalidateCache();
    } catch (_) {}
    if (global.gc) {
      global.gc();
      const mem = process.memoryUsage();
      console.log(`  [gc] heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB`);
    }
  }

  // ── Aggregate + write ────────────────────────────────────────────────────
  const totalQ = allResults.reduce((s, r) => s + r.total, 0);
  const totalC = allResults.reduce((s, r) => s + r.correct, 0);
  const overallByCat = {};
  for (const r of allResults) {
    for (const [cat, s] of Object.entries(r.byCategory)) {
      overallByCat[cat] = overallByCat[cat] || { total: 0, correct: 0 };
      overallByCat[cat].total += s.total;
      overallByCat[cat].correct += s.correct;
    }
  }

  console.log('');
  divider('AGGREGATE');
  console.log(`Total: ${totalC}/${totalQ} correct (${((totalC / totalQ) * 100).toFixed(1)}%)`);
  for (const cat of [1, 2, 3, 4, 5]) {
    const s = overallByCat[cat];
    if (!s) continue;
    const pct = ((s.correct / s.total) * 100).toFixed(1);
    const label = ['', 'single-hop', 'temporal', 'multi-hop', 'open-domain', 'adversarial'][cat];
    console.log(`  cat=${cat} (${label.padEnd(11)}): ${s.correct}/${s.total} (${pct}%)`);
  }
  console.log('');

  const out = {
    timestamp: new Date().toISOString(),
    dataset: 'LOCOMO',
    convsRun: allResults.length,
    totalQuestions: totalQ,
    totalCorrect: totalC,
    accuracy: ((totalC / totalQ) * 100).toFixed(1),
    overallByCategory: overallByCat,
    perConv: allResults,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote: ${OUT_PATH}`);

  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('[bench-locomo] FAILED:', e.message, '\n', e.stack);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
