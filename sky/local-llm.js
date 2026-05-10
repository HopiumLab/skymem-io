/**
 * Local LLM via Ollama — handles lightweight tasks to save Claude API costs.
 * Falls back to Claude CLI if Ollama is unavailable.
 *
 * Uses Ollama's HTTP API (localhost:11434 by default).
 * No npm packages needed — uses native Node.js fetch.
 */

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';

// Preferred models in order — small and fast
const MODEL_PREFERENCE = [
  'qwen2.5:3b',
  'qwen2.5:1.5b',
  'llama3.2:3b',
  'llama3.2:1b',
];

let _cachedModel = null;
let _availabilityChecked = false;
let _isAvailable = false;

/**
 * Check if Ollama is running and accessible.
 * Caches result for 60 seconds to avoid hammering.
 */
let _lastCheck = 0;
async function isAvailable() {
  const now = Date.now();
  if (_availabilityChecked && now - _lastCheck < 60_000) {
    return _isAvailable;
  }

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    _isAvailable = res.ok;
    _availabilityChecked = true;
    _lastCheck = now;
    return _isAvailable;
  } catch {
    _isAvailable = false;
    _availabilityChecked = true;
    _lastCheck = now;
    return false;
  }
}

/**
 * Find the best available model from our preference list.
 * Returns the model name or null if none available.
 */
async function getBestModel() {
  if (_cachedModel) return _cachedModel;

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const available = data.models?.map(m => m.name) || [];

    if (available.length === 0) return null;

    // Try preferred models in order
    for (const preferred of MODEL_PREFERENCE) {
      const match = available.find(m => m === preferred || m.startsWith(preferred.split(':')[0]));
      if (match) {
        _cachedModel = match;
        console.log(`[LocalLLM] Using model: ${match}`);
        return match;
      }
    }

    // Fall back to whatever is available
    _cachedModel = available[0];
    console.log(`[LocalLLM] No preferred model found, using: ${_cachedModel}`);
    return _cachedModel;
  } catch {
    return null;
  }
}

/**
 * Generate a completion from the local LLM.
 * @param {string} prompt - The full prompt
 * @param {string} [model] - Override model (otherwise picks best available)
 * @returns {Promise<string|null>} Response text, or null if unavailable
 */
async function generate(prompt, model = null) {
  if (!(await isAvailable())) return null;

  const useModel = model || (await getBestModel());
  if (!useModel) return null;

  const startTime = Date.now();

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,    // Low temp for deterministic classification
          num_predict: 256,     // Keep responses short — these are utility calls
        },
      }),
      signal: AbortSignal.timeout(15_000), // 15s max — if it's slower than this, use Claude
    });

    if (!res.ok) {
      console.warn(`[LocalLLM] Generate failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const elapsed = Date.now() - startTime;
    console.log(`[LocalLLM] Generated in ${elapsed}ms (${useModel})`);

    return data.response?.trim() || null;
  } catch (e) {
    console.warn(`[LocalLLM] Generate error: ${e.message}`);
    return null;
  }
}

/**
 * Classify text into one of the given categories.
 * @param {string} text - Text to classify
 * @param {string[]} categories - Possible categories
 * @returns {Promise<string|null>} The matched category, or null if unavailable
 */
async function classify(text, categories) {
  const categoryList = categories.join(', ');
  const prompt = `Classify the following text into EXACTLY ONE of these categories: ${categoryList}

Text: "${text}"

Reply with ONLY the category name, nothing else.`;

  const result = await generate(prompt);
  if (!result) return null;

  // Find the best matching category (fuzzy match in case LLM adds punctuation)
  const lower = result.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  for (const cat of categories) {
    if (lower === cat.toLowerCase().replace(/[^a-z0-9-]/g, '')) return cat;
    if (lower.includes(cat.toLowerCase().replace(/[^a-z0-9-]/g, ''))) return cat;
  }

  // If exact match failed, return the raw result if it looks like a category
  if (result.length < 30) return result.trim();
  return null;
}

/**
 * Summarize text concisely.
 * @param {string} text - Text to summarize
 * @param {number} [maxLength=200] - Max character length for summary
 * @returns {Promise<string|null>} Summary or null if unavailable
 */
async function summarize(text, maxLength = 200) {
  const prompt = `Summarize the following text in ${maxLength} characters or less. Be concise and direct.

Text: "${text.substring(0, 2000)}"

Summary:`;

  return generate(prompt);
}

/**
 * Extract key topics and entities from text.
 * @param {string} text - Text to extract from
 * @returns {Promise<string[]|null>} Array of keywords, or null if unavailable
 */
async function extractKeywords(text) {
  const prompt = `Extract the key topics, entities, and important facts from this text. Return them as a comma-separated list. Maximum 10 items.

Text: "${text.substring(0, 2000)}"

Keywords:`;

  const result = await generate(prompt);
  if (!result) return null;

  return result.split(',').map(k => k.trim()).filter(k => k.length > 0 && k.length < 100);
}

/**
 * Route a message to the best matching option.
 * @param {string} message - The user's message
 * @param {Array<{name: string, description?: string}>} options - Available routing targets
 * @returns {Promise<string|null>} The matched option name, or null if unavailable
 */
async function route(message, options) {
  const optionList = options.map(o =>
    o.description ? `- ${o.name}: ${o.description}` : `- ${o.name}`
  ).join('\n');

  const prompt = `Given this user request, which of the following targets is the best match? Reply with ONLY the target name.

Request: "${message}"

Available targets:
${optionList}

If none match well, reply "none".

Best match:`;

  const result = await generate(prompt);
  if (!result) return null;

  const lower = result.toLowerCase().trim();
  if (lower === 'none') return null;

  // Find best matching option
  for (const opt of options) {
    if (lower === opt.name.toLowerCase()) return opt.name;
    if (lower.includes(opt.name.toLowerCase())) return opt.name;
  }

  // Partial match
  for (const opt of options) {
    const optWords = opt.name.toLowerCase().split(/[\s-]+/);
    if (optWords.some(w => w.length > 2 && lower.includes(w))) return opt.name;
  }

  return null;
}

/**
 * Detect if a message is a command or just conversation.
 * @param {string} message - The user's message
 * @returns {Promise<'command'|'conversation'|null>} Result or null if unavailable
 */
async function detectCommand(message) {
  const prompt = `Is this message a command to execute in a code repository, or just conversation/question?

Message: "${message}"

Reply with ONLY one word: COMMAND or CONVERSATION`;

  const result = await generate(prompt);
  if (!result) return null;

  const lower = result.toLowerCase().trim();
  if (lower.includes('command')) return 'command';
  if (lower.includes('conversation')) return 'conversation';
  return null;
}

/**
 * Extract key facts and decisions from a conversation exchange.
 * Used for background knowledge graph updates.
 * @param {string} userMessage - What the user said
 * @param {string} response - What Sky responded
 * @returns {Promise<Array<{fact: string, category: string}>|null>}
 */
async function extractFacts(userMessage, response) {
  const prompt = `Extract any key facts, decisions, or actionable items from this conversation. Return as JSON array.

User: "${userMessage.substring(0, 500)}"
Assistant: "${response.substring(0, 500)}"

Return ONLY a JSON array like: [{"fact": "...", "category": "decision|preference|contact|project|deadline|financial"}]
If no important facts, return: []

JSON:`;

  const result = await generate(prompt);
  if (!result) return null;

  try {
    // Try to parse JSON from the response (LLMs sometimes add text around it)
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Invalidate cached model and availability (useful if Ollama restarts).
 */
function resetCache() {
  _cachedModel = null;
  _availabilityChecked = false;
  _isAvailable = false;
  _lastCheck = 0;
}

/**
 * Classify a chat message into a retrieval intent. P1-3 (2026-05-08).
 *
 * Drives adaptive ranking in graph.retrieve (P1-4). Different intents prefer
 * different signal mixes:
 *
 *   status        → "what's the latest with X" / "where am I with X" / "any news on X"
 *                   → recency dominates, weight de-emphasised
 *   definitional  → "what is X" / "tell me about X" / "who is X"
 *                   → weight (anchor nodes) dominates, recency de-emphasised
 *   decision      → "should I" / "what did we decide about" / "is X better than Y"
 *                   → balanced; favour decision-type nodes
 *   scheduling    → "when am I" / "book a" / "what's on tomorrow"
 *                   → recency + calendar/event nodes
 *   command       → "!balance" / "!brief" / "!help" — bypasses retrieval entirely
 *   chitchat      → "hey" / "thanks" / "lol" — minimal retrieval needed
 *
 * Falls back to 'definitional' if Qwen unavailable — same defaults as pre-fix.
 *
 * Latency target: <500ms warm Qwen. Returns null on failure (caller treats
 * as 'definitional' default).
 */
const INTENTS = ['status', 'definitional', 'decision', 'scheduling', 'command', 'chitchat'];

async function classifyIntent(message) {
  if (!message || message.length < 3) return 'chitchat';
  if (message.startsWith('!')) return 'command';

  // Cheap regex fast-path for clear cases — saves Qwen latency.
  // Order matters: more specific patterns first.
  const m = message.toLowerCase();
  if (/\bwhat'?s the latest\b|\bany news\b|\bwhere am i with\b|\bhow'?s\b|\bupdate on\b|\bprogress on\b|\bstatus on\b/.test(m)) return 'status';
  if (/\bwhen (am i|is|do i|are we|will)\b|\bbook (a|an|me)\b|\bschedule (a|an|me)\b|\btomorrow\b|\bnext week\b|\bcalendar\b/.test(m)) return 'scheduling';
  if (/\bwhat is\b|\bwho is\b|\btell me about\b|\bwhat'?s (a|an)\b/.test(m)) return 'definitional';
  if (/\bshould i\b|\bwhat did (we|i) decide\b|\bdo (we|i) (need|want)\b|\bis (it|that) (better|worth|good)\b/.test(m)) return 'decision';
  if (/^(hey|hi|hello|yo|sup|thanks|thank you|cool|nice|lol|haha|cheers|night|morning)\b/i.test(message.trim())) return 'chitchat';

  // Fall through to Qwen for ambiguous cases. Best-effort; null → caller picks default.
  try {
    const result = await classify(message.slice(0, 500), INTENTS);
    return result || null;
  } catch {
    return null;
  }
}

export default {
  isAvailable,
  getBestModel,
  generate,
  classify,
  classifyIntent,
  summarize,
  extractKeywords,
  route,
  detectCommand,
  extractFacts,
  resetCache,
  MODEL_PREFERENCE,
  INTENTS,
};
