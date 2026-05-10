/**
 * Request Lifecycle Logger
 *
 * Captures the full trace of every message through Sky:
 * - What came in (source, sender, content, group)
 * - What was classified as (conversation, command, idea, action)
 * - What the graph retrieved (nodes, scores, similarity)
 * - What clusters matched
 * - What session context was loaded (messages, topic)
 * - What prompt was built (size, sections included)
 * - How the response was generated (CLI, API, which model)
 * - What was ingested to the graph after
 * - What sentiment was detected
 * - Timing for each phase
 *
 * Logs to: logs/sky-requests.jsonl (one JSON object per line)
 * Dashboard: /api/logs/requests (last N requests)
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'sky-requests.jsonl');
const MAX_RECENT = 100; // keep last N in memory for dashboard

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// In-memory ring buffer of recent requests
const _recentRequests = [];

/**
 * Create a new request trace. Call at the START of message processing.
 * Returns a trace object you add to throughout the lifecycle.
 */
function startTrace(source, message, options = {}) {
  const trace = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source, // whatsapp, terminal, api
    message: message.substring(0, 500),
    messageLength: message.length,

    // Sender info (for group chats)
    sender: options.sender || 'ross',
    group: options.group || null,
    isGroupChat: !!options.group,

    // Classification
    classification: null, // conversation, command, idea, action
    classificationMethod: null, // qwen, regex, none

    // Routing
    route: null, // conversation, action, idea, command, pdf-intercept
    routeDetails: null, // which repo, which command

    // Graph retrieval
    graphQuery: null, // what was actually queried
    graphQueryLength: null,
    graphNodes: [], // { id, type, content (50 chars), weight, score, similarity }
    graphRetrievalMs: null,

    // Cluster retrieval
    clusterMatch: null, // { label, score, size, nodes }
    clusterRetrievalMs: null,

    // Session context
    sessionId: null,
    sessionTopic: null,
    sessionMessagesLoaded: 0,

    // Prompt
    promptSize: null, // chars
    promptTokens: null, // estimated
    promptSections: [], // which sections were included

    // Response generation
    responseMethod: null, // cli, api-fallback, cached
    responseModel: null, // claude-sonnet, claude-haiku, qwen
    responseMs: null,
    responseLength: null,

    // Graph ingestion (post-response)
    ingestionNodes: null, // how many nodes created
    ingestionMs: null,

    // Sentiment
    sentiment: null, // { mood, intensity, valence, triggers }

    // Person linking
    personAnchorsLinked: [], // which person anchors were connected

    // Errors
    errors: [],

    // Timing
    totalMs: null,
    phases: {}, // { classification: ms, context: ms, retrieval: ms, response: ms, ingestion: ms }
    _startTime: Date.now(),
    _phaseStarts: {},
  };

  return trace;
}

/**
 * Start timing a phase.
 */
function startPhase(trace, phaseName) {
  if (!trace || !trace._phaseStarts) return;
  trace._phaseStarts[phaseName] = Date.now();
}

/**
 * End timing a phase.
 */
function endPhase(trace, phaseName) {
  if (!trace || !trace._phaseStarts) return; // guard against null trace
  if (trace._phaseStarts[phaseName]) {
    trace.phases[phaseName] = Date.now() - trace._phaseStarts[phaseName];
    delete trace._phaseStarts[phaseName];
  }
}

/**
 * Log a graph retrieval result.
 */
function logGraphRetrieval(trace, nodes, queryUsed, durationMs) {
  if (!trace) return;
  trace.graphQuery = (queryUsed || '').substring(0, 300);
  trace.graphQueryLength = (queryUsed || '').length;
  trace.graphRetrievalMs = durationMs;
  trace.graphNodes = (nodes || []).map(n => ({
    id: n.id?.substring(0, 12),
    type: n.type,
    content: (n.content || '').substring(0, 60),
    weight: n.weight,
    score: n.score,
  }));
}

/**
 * Log a cluster match.
 */
function logClusterMatch(trace, cluster, durationMs) {
  if (!trace) return;
  trace.clusterRetrievalMs = durationMs;
  if (cluster) {
    trace.clusterMatch = {
      label: cluster.label?.substring(0, 60),
      score: cluster.score,
      size: cluster.size,
      topNodes: (cluster.nodes || []).slice(0, 3).map(n => n.content?.substring(0, 50)),
    };
  }
}

/**
 * Log the prompt composition.
 */
function logPrompt(trace, promptText, sections) {
  trace.promptSize = promptText?.length || 0;
  trace.promptTokens = Math.round((promptText?.length || 0) / 4);
  trace.promptSections = sections || [];
}

/**
 * Log how the response was generated. Call from each transport
 * (CLI close handler, API fallback, local Qwen) at completion. Without
 * this, responseMethod / responseModel / responseMs / responseLength
 * stay null in every request log entry.
 *
 * @param {object} trace
 * @param {object} info — { method, model, ms, length }
 *   method: 'cli' | 'api-fallback' | 'qwen' | 'cached'
 *   model:  e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5', 'qwen2.5:3b'
 *   ms:     wall-clock from spawn/request-start to first/last chunk
 *   length: response chars
 */
function logResponse(trace, { method, model, ms, length } = {}) {
  if (!trace) return;
  if (method !== undefined) trace.responseMethod = method;
  if (model !== undefined) trace.responseModel = model;
  if (ms !== undefined) trace.responseMs = ms;
  if (length !== undefined) trace.responseLength = length;
}

/**
 * Log an error in the trace.
 */
function logError(trace, phase, error) {
  if (!trace) return;
  trace.errors.push({
    phase,
    message: error?.message || String(error),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Finalize and persist the trace. Call at the END of message processing.
 */
function endTrace(trace) {
  if (!trace) return;
  trace.totalMs = Date.now() - (trace._startTime || Date.now());

  // Clean up internal timing fields
  delete trace._startTime;
  delete trace._phaseStarts;

  // Add to ring buffer
  _recentRequests.push(trace);
  if (_recentRequests.length > MAX_RECENT) {
    _recentRequests.shift();
  }

  // Persist to JSONL file
  try {
    appendFileSync(LOG_FILE, JSON.stringify(trace) + '\n');
  } catch (e) {
    console.warn(`[RequestLog] Failed to write: ${e.message}`);
  }

  // Log a one-line summary to console
  const nodesSummary = trace.graphNodes.length > 0
    ? `graph:${trace.graphNodes.length}[${trace.graphNodes.map(n => n.type).join(',')}]`
    : 'graph:0';
  const clusterSummary = trace.clusterMatch
    ? `cluster:${trace.clusterMatch.label?.substring(0, 20)}`
    : 'cluster:none';
  const errors = trace.errors.length > 0 ? ` ERRORS:${trace.errors.length}` : '';

  console.log(
    `[RequestLog] ${trace.id} | ${trace.source} | ${trace.route || '?'} | ${nodesSummary} | ${clusterSummary} | prompt:${trace.promptTokens}tok | ${trace.responseMethod || '?'}:${trace.responseMs || '?'}ms | total:${trace.totalMs}ms${errors}`
  );

  return trace;
}

/**
 * Get recent requests for the dashboard.
 */
function getRecentRequests(limit = 50) {
  return _recentRequests.slice(-limit).reverse();
}

/**
 * Get a summary of request patterns for analysis.
 */
function getRequestStats() {
  const recent = _recentRequests.slice(-100);
  if (!recent.length) return { count: 0 };

  const avgTotalMs = Math.round(recent.reduce((s, r) => s + (r.totalMs || 0), 0) / recent.length);
  const avgPromptTokens = Math.round(recent.reduce((s, r) => s + (r.promptTokens || 0), 0) / recent.length);
  const avgGraphNodes = (recent.reduce((s, r) => s + (r.graphNodes?.length || 0), 0) / recent.length).toFixed(1);
  const errorCount = recent.filter(r => r.errors.length > 0).length;

  const routeBreakdown = {};
  recent.forEach(r => { routeBreakdown[r.route || 'unknown'] = (routeBreakdown[r.route || 'unknown'] || 0) + 1; });

  const methodBreakdown = {};
  recent.forEach(r => { methodBreakdown[r.responseMethod || 'unknown'] = (methodBreakdown[r.responseMethod || 'unknown'] || 0) + 1; });

  const graphHitRate = recent.filter(r => r.graphNodes?.length > 0).length / recent.length;
  const clusterHitRate = recent.filter(r => r.clusterMatch).length / recent.length;

  return {
    count: recent.length,
    avgTotalMs,
    avgPromptTokens,
    avgGraphNodes: parseFloat(avgGraphNodes),
    errorCount,
    errorRate: (errorCount / recent.length * 100).toFixed(1) + '%',
    graphHitRate: (graphHitRate * 100).toFixed(1) + '%',
    clusterHitRate: (clusterHitRate * 100).toFixed(1) + '%',
    routeBreakdown,
    methodBreakdown,
  };
}

export default {
  startTrace,
  startPhase,
  endPhase,
  logGraphRetrieval,
  logClusterMatch,
  logPrompt,
  logResponse,
  logError,
  endTrace,
  getRecentRequests,
  getRequestStats,
};
