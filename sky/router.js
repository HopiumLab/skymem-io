/**
 * Sky model router — picks the right transport + model for each task class.
 *
 * Shipped 2026-05-08 (P1-7) as part of the rebuild plan.
 *
 * Goal: 90% cost reduction vs "Sonnet for everything" by routing trivial
 * tasks to Qwen / Haiku and reserving Sonnet/Opus for tasks that need them.
 *
 * Task taxonomy:
 *   - 'classify'    : message-intent / topic classification → Qwen → Haiku fallback
 *   - 'summarize'   : long-form → short → Haiku
 *   - 'decompose'   : raw text → atomic node JSON → Haiku batched
 *   - 'chat'        : Sky's chat reply → Sonnet via API (with prompt caching)
 *   - 'agent'       : specialist agent work → Sonnet via CLI/API
 *   - 'reason'      : hard reasoning tasks → Opus (rare)
 *   - 'planner'     : retrieval planning (P2-1) → Haiku
 *
 * The router does NOT spawn agents itself — sky/agent-runner.js owns that.
 * It DOES pick the model an agent should use when the agent's YAML doesn't
 * pin one.
 *
 * Caller pattern:
 *   import router from './router.js';
 *   const { transport, model } = router.pick('chat');
 *   if (transport === 'api') { await apiFallback.generateResponse(...) }
 *   else if (transport === 'cli') { ... }
 *   else if (transport === 'qwen') { ... }
 *
 * Override per-call by setting env vars:
 *   SKY_ROUTE_CHAT=api          (default: api when SKY_CLAUDE_AUTH_MODE=api_key, else cli)
 *   SKY_ROUTE_CLASSIFY=qwen     (default: qwen with api fallback)
 *   SKY_ROUTE_DECOMPOSE=api     (default: api Haiku)
 *   SKY_ROUTE_AGENT=cli         (default: cli)
 *   SKY_ROUTE_REASON=api-opus   (default: api Opus)
 */

import apiFallback from './api-fallback.js';
import localLLM from './local-llm.js';

/**
 * Pick transport + model for a task class. Returns synchronously; does not
 * itself check availability — caller is responsible for falling back if the
 * picked transport is unhealthy.
 *
 * @param {string} taskClass — one of the keys above
 * @returns {{ transport: 'api'|'cli'|'qwen', model: string|null, fallback?: object }}
 */
function pick(taskClass) {
  const authMode = (process.env.SKY_CLAUDE_AUTH_MODE || 'oauth').toLowerCase();
  const apiPrimary = authMode === 'api_key' && apiFallback.isAvailable();

  // Per-task default routing tables.
  const routes = {
    classify: () => ({
      transport: 'qwen',
      model: 'qwen2.5:3b',
      fallback: { transport: 'api', model: apiFallback.DEFAULT_HAIKU_MODEL },
    }),
    summarize: () => ({
      transport: 'api',
      model: apiFallback.DEFAULT_HAIKU_MODEL,
    }),
    decompose: () => ({
      transport: 'api',
      model: apiFallback.DEFAULT_HAIKU_MODEL,
    }),
    chat: () => apiPrimary
      ? { transport: 'api', model: apiFallback.DEFAULT_CHAT_MODEL, fallback: { transport: 'cli', model: 'claude-code-cli' } }
      : { transport: 'cli', model: 'claude-code-cli', fallback: { transport: 'api', model: apiFallback.DEFAULT_CHAT_MODEL } },
    agent: () => apiPrimary
      ? { transport: 'api', model: apiFallback.DEFAULT_CHAT_MODEL, fallback: { transport: 'cli', model: 'claude-code-cli' } }
      : { transport: 'cli', model: 'claude-code-cli' },
    reason: () => ({
      transport: 'api',
      model: apiFallback.DEFAULT_OPUS_MODEL,
    }),
    planner: () => ({
      transport: 'api',
      model: apiFallback.DEFAULT_HAIKU_MODEL,
    }),
  };

  // Env override always wins.
  const envKey = `SKY_ROUTE_${taskClass.toUpperCase()}`;
  const override = process.env[envKey];
  if (override) {
    const [transport, model] = override.split(':');
    return { transport, model: model || null, _overrideFromEnv: envKey };
  }

  const fn = routes[taskClass];
  if (!fn) {
    throw new Error(`router.pick: unknown taskClass "${taskClass}". Known: ${Object.keys(routes).join(', ')}`);
  }
  return fn();
}

/**
 * Convenience: classify with automatic fallback chain.
 * Tries Qwen → Haiku API → returns null if both fail.
 */
async function classify(text, categories) {
  const route = pick('classify');
  if (route.transport === 'qwen') {
    try {
      const result = await localLLM.classify(text, categories);
      if (result) return result;
    } catch (_) { /* fall through */ }
  }
  // Fall through to API
  try {
    return await apiFallback.classify(text, categories);
  } catch (e) {
    console.warn(`[Router] classify failed: ${e.message}`);
    return null;
  }
}

/**
 * Health snapshot for /api/health style readiness checks.
 */
async function health() {
  const qwenUp = await localLLM.isAvailable().catch(() => false);
  const apiUp = apiFallback.isAvailable();
  return {
    qwen: qwenUp,
    api: apiUp,
    cli: true, // we don't ping the CLI from here; assume available, runClaudeCLI will surface errors
    primary: pick('chat'),
  };
}

export default {
  pick,
  classify,
  health,
};
