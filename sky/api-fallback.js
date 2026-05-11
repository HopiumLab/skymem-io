/**
 * Claude API path — primary chat transport when SKY_CLAUDE_AUTH_MODE=api_key.
 *
 * Originally a fallback for "local CLI at capacity"; promoted to first-class
 * transport on 2026-05-08 because:
 *   - OAuth-via-CLI was breaking on a ~12h cycle, leaking 401s as Sky's reply
 *   - api_key path is durable and predictable
 *   - prompt caching makes the marginal cost competitive with subscription
 *
 * Architecture:
 *   sky/router.js picks (transport, model) per task class
 *   this module: implements the API transport with prompt caching
 *   sky/claude-cli.js: implements the CLI transport (still wired for fallback)
 *
 * Models supported:
 *   - claude-sonnet-4-5         (default chat model)
 *   - claude-haiku-4-5          (classification, summarisation, decomposition)
 *   - claude-opus-4-7           (hard reasoning, rare)
 *
 * Override per-call via options.model. Override defaults via env:
 *   SKY_API_FALLBACK_MODEL          (chat)
 *   SKY_API_HAIKU_MODEL             (light tasks)
 *   SKY_API_OPUS_MODEL              (hard reasoning)
 */

import Anthropic from '@anthropic-ai/sdk';

const API_KEY = process.env.ANTHROPIC_API_KEY;
let client = null;

const DEFAULT_CHAT_MODEL  = process.env.SKY_API_FALLBACK_MODEL || 'claude-sonnet-4-5';
const DEFAULT_HAIKU_MODEL = process.env.SKY_API_HAIKU_MODEL    || 'claude-haiku-4-5';
const DEFAULT_OPUS_MODEL  = process.env.SKY_API_OPUS_MODEL     || 'claude-opus-4-7';

/**
 * Check if API path is available.
 *
 * P0-2 (2026-05-08): the user flipped to api_key auth mode. SKY_ENABLE_API_FALLBACK
 * gates whether this transport is allowed. Was disarmed historically because
 * the user was on Claude Max and didn't want the fallback charging the API key.
 *
 * Now: the api path is the durable transport. Always-on when ANTHROPIC_API_KEY
 * is set unless explicitly disabled (`SKY_ENABLE_API_FALLBACK=false`).
 */
function isAvailable() {
  if (process.env.SKY_ENABLE_API_FALLBACK === 'false') return false;
  return !!API_KEY;
}

function getClient() {
  if (!client && API_KEY) {
    client = new Anthropic({ apiKey: API_KEY });
  }
  return client;
}

/**
 * Generate a response from Claude API with prompt caching.
 *
 * P1-8 (2026-05-08): the system prompt (Sky identity + voice + rules) is
 * ~5k chars / 1.2k tokens and identical across every chat turn. Anthropic's
 * prompt-cache mechanism gives 90% discount on cached tokens — for a daily
 * driver like Sky's chat path, this is meaningful money.
 *
 * Mechanic: pass system as an array of blocks; mark the static-identity
 * block with `cache_control: { type: 'ephemeral' }`. Cache TTL is 5 min by
 * default; first request is full-price + cache-write surcharge, every
 * subsequent request within 5 min reads at 10% of normal cost.
 *
 * Cache hit rate target: >70% during active chat sessions, ~0% overnight
 * (cache expires). Net cost reduction: ~50-70% on system-prompt tokens.
 *
 * @param {string|object[]} systemPrompt - System text OR pre-built blocks
 * @param {string|object[]} userMessage  - User message text OR conversation array
 * @param {object} options
 *   model:       'claude-sonnet-4-5' | 'claude-haiku-4-5' | 'claude-opus-4-7'
 *   maxTokens:   default 4096
 *   onChunk:     streaming callback(text)
 *   cacheSystem: default true — enable prompt caching on the system block
 */
async function generateResponse(systemPrompt, userMessage, options = {}) {
  const {
    model = DEFAULT_CHAT_MODEL,
    maxTokens = 4096,
    onChunk = null,
    cacheSystem = true,
    tools = null,           // Anthropic tool definitions (array)
    toolHandlers = null,    // { [toolName]: async (input) => result }
    maxToolIterations = 4,  // safety bound on the tool_use loop
  } = options;

  const anthropic = getClient();
  if (!anthropic) {
    throw new Error('Claude API key not configured. Set ANTHROPIC_API_KEY in .env');
  }

  // Build the system parameter — array of blocks if caching, plain string otherwise.
  // The block form is required to attach cache_control. Caching only kicks in
  // when the cached block is ≥1024 tokens (Anthropic's minimum for ephemeral
  // cache); shorter prompts pass through uncached.
  let system;
  if (cacheSystem && typeof systemPrompt === 'string' && systemPrompt.length >= 4000) {
    system = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
  } else if (typeof systemPrompt === 'string') {
    system = systemPrompt;
  } else {
    // Caller passed pre-built blocks — pass through.
    system = systemPrompt;
  }

  // Messages: accept string (single user turn) or full conversation array.
  let messages = typeof userMessage === 'string'
    ? [{ role: 'user', content: userMessage }]
    : userMessage.slice();

  // Streaming path: no tool_use support (streaming + tools needs different
  // event handling; callers that want tools must use the non-streaming path)
  if (onChunk) {
    console.log(`[API] model=${model}${cacheSystem && Array.isArray(system) ? ' (cached system, streaming)' : ' (streaming)'}`);
    let fullText = '';
    const stream = anthropic.messages.stream({ model, max_tokens: maxTokens, system, messages });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        onChunk(event.delta.text);
      }
    }
    return fullText;
  }

  // Non-streaming path — with optional tool_use loop.
  // The loop: call API → if response has tool_use blocks, execute each tool
  // and append { role: 'user', content: [tool_result blocks] } → call API
  // again. Repeat until no more tool_use blocks (or hit maxToolIterations).
  const hasTools = Array.isArray(tools) && tools.length > 0 && toolHandlers;
  let response = null;
  let iteration = 0;
  while (iteration < maxToolIterations) {
    iteration += 1;
    const apiParams = { model, max_tokens: maxTokens, system, messages };
    if (hasTools) apiParams.tools = tools;
    const tag = hasTools ? ` (tools: ${tools.length})` : '';
    console.log(`[API] model=${model}${cacheSystem && Array.isArray(system) ? ' (cached system)' : ''}${tag}${iteration > 1 ? ` iter=${iteration}` : ''}`);

    response = await anthropic.messages.create(apiParams);

    // Log usage for THIS turn (each tool-use round counts separately)
    const usage = response.usage || {};
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    if (cacheRead > 0 || cacheWrite > 0) {
      console.log(`[API] usage: in=${inputTokens} cache_read=${cacheRead} cache_write=${cacheWrite} out=${outputTokens}`);
    } else {
      console.log(`[API] usage: in=${inputTokens} out=${outputTokens}`);
    }

    // End conditions
    if (response.stop_reason !== 'tool_use' || !hasTools) break;
    const toolUseBlocks = (response.content || []).filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    // Execute each tool call and build the tool_result content blocks
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const handler = toolHandlers[block.name];
      let result;
      let isError = false;
      if (!handler) {
        result = `Unknown tool: ${block.name}`;
        isError = true;
        console.warn(`[API] tool_use for unknown tool "${block.name}"`);
      } else {
        try {
          const out = await handler(block.input || {});
          result = typeof out === 'string' ? out : JSON.stringify(out ?? null);
          console.log(`[API] tool_use ${block.name} → OK`);
        } catch (e) {
          result = e?.message || String(e);
          isError = true;
          console.error(`[API] tool_use ${block.name} → ERR: ${result}`);
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      });
    }

    // Append the assistant message AND the tool results
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
  }

  if (iteration >= maxToolIterations && response?.stop_reason === 'tool_use') {
    console.warn(`[API] tool_use loop hit maxToolIterations=${maxToolIterations}; returning whatever text the model produced`);
  }

  // Extract text from the final response
  const text = (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return text;
}

/**
 * Classify text using Haiku (cheap, fast). Fallback to local Qwen handled
 * upstream by sky/router.js when Qwen is available.
 */
async function classify(text, categories) {
  const prompt = `Classify this text into exactly one of these categories: ${categories.join(', ')}

Text: "${text}"

Reply with ONLY the category name, nothing else.`;

  const response = await generateResponse(
    'You are a text classifier. Reply with only the category name.',
    prompt,
    { model: DEFAULT_HAIKU_MODEL, maxTokens: 50, cacheSystem: false },
  );
  return response.trim().toLowerCase();
}

/**
 * Quick summary using Haiku.
 */
async function summarize(text, maxLength = 200) {
  const response = await generateResponse(
    'You are a concise summarizer.',
    `Summarize this in under ${maxLength} characters:\n\n${text}`,
    { model: DEFAULT_HAIKU_MODEL, maxTokens: 200, cacheSystem: false },
  );
  return response.trim();
}

export default {
  isAvailable,
  getClient,
  generateResponse,
  classify,
  summarize,
  // Model defaults exposed so router.js can read them.
  DEFAULT_CHAT_MODEL,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
};
