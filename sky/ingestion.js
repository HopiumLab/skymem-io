/**
 * Sky Memory Ingestion Pipeline
 *
 * Takes raw text (conversation, documents, notes) and decomposes it
 * into atomic memory nodes, then stores them in the graph.
 *
 * One node = one semantic unit. Not one sentence — one IDEA.
 * A paragraph might produce 1 node or 8, depending on density.
 *
 * Process:
 *   Raw input
 *   → Strip noise
 *   → Semantic decomposition (LLM-assisted)
 *   → Atomic node extraction
 *   → Metadata tagging (type, tags)
 *   → Node creation with initial weight: 0.3
 *   → Store to graph
 *   → Create explicit edges for named relationships
 *
 * Vision: MEMORY_ENGINE_VISION.md
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma-client.js';
import graph from './graph.js';
import embeddings from './embeddings.js';
import localLLM from './local-llm.js';
import personRegistry from './person-registry.js';
import { deriveScopeForNode } from './scope-helpers.js';

const client = new Anthropic();

const CONTRADICTION_SIMILARITY_THRESHOLD = 0.75;

// ============================================================
// DECOMPOSITION — LLM extracts atomic nodes from raw text
// ============================================================

const DECOMPOSE_PROMPT = `You are a memory ingestion engine. Your job is to extract atomic semantic units from raw text.

Rules:
- One node = one idea, one fact, one relationship, one decision, or one event
- Do NOT split by sentence — split by MEANING
- Ignore pleasantries, filler, and formatting artifacts
- ALWAYS extract emotional states, mood indicators, frustration, excitement, or stress signals
- Tag emotional content with the detected mood (e.g., "frustrated", "excited", "anxious")
- NEVER discard: names, numbers, dates, locations, amounts, codes, URLs, decisions, commitments, preferences, opinions, emotional expressions
- For each node, classify its type: person | project | idea | event | emotion | decision | fact
- IMPORTANT: Only use type "person" for NEW people being introduced for the first time. If someone is just MENTIONED in conversation (e.g., "I talked to Person B about..."), that should be a "fact" node, NOT a "person" node. The person already exists in the graph — we don't need another person node every time their name comes up.
- Add 1–4 relevant tags (lowercase, hyphenated)
- Include the person's name as a tag when they're mentioned (e.g., ["jt", "business-idea"])
- Keep content concise but complete — enough to be understood without the original text
- If something is obvious or generic, skip it
- For relationships between people/projects, use "involves" or "relates_to" to note them

Return a JSON array. No other text. Format:
[
  {
    "type": "fact|person|project|idea|event|emotion|decision",
    "content": "atomic semantic unit",
    "tags": ["tag1", "tag2"],
    "relates_to": ["optional: content substring of another node in this batch it connects to"]
  }
]

Raw text to decompose:`;

const MAX_CHUNK_CHARS = 3000; // Keep chunks small enough for Haiku to produce valid JSON

async function decompose(rawText) {
  // Strip obvious noise
  const cleaned = rawText
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 20) return []; // too short to bother

  // Chunk large texts to avoid Haiku output truncation
  if (cleaned.length > MAX_CHUNK_CHARS) {
    console.log(`[Ingestion] Large text (${cleaned.length} chars) — chunking into ~${MAX_CHUNK_CHARS} char pieces`);
    const chunks = chunkText(cleaned, MAX_CHUNK_CHARS);
    const allNodes = [];
    for (const chunk of chunks) {
      const nodes = await _decomposeChunk(chunk);
      allNodes.push(...nodes);
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 1000)); // rate limit between chunks
    }
    return allNodes;
  }

  return _decomposeChunk(cleaned);
}

function chunkText(text, maxChars) {
  const chunks = [];
  // Split on paragraph boundaries (double newline, period+space, or bullet points)
  const sentences = text.split(/(?<=[.!?])\s+|(?:\n\n)/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function _decomposeChunk(text) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', // fast + cheap for ingestion
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `${DECOMPOSE_PROMPT}\n\n${text}`,
      }],
    });

    const raw = response.content[0].text.trim();

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[Ingestion] No JSON array found in decompose response');
      return [];
    }

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn(`[Ingestion] Decompose failed: ${err.message}`);
    return [];
  }
}

// ============================================================
// SENTIMENT SCORING — Local LLM (Qwen), fast + free
// ============================================================

/**
 * Score the emotional state of a message using the local Qwen model.
 * Returns { mood, intensity, valence, triggers } — no API cost.
 *
 * @param {string} text - The message to score
 * @returns {Promise<{mood: string, intensity: number, valence: number, triggers: string[]}>}
 */
async function scoreSentiment(text) {
  const prompt = `Classify the emotional state in this message. Respond ONLY in JSON.

Message: "${text.substring(0, 500)}"

{
  "mood": "one of: neutral, happy, excited, frustrated, angry, anxious, sad, reflective, determined, overwhelmed, playful, stressed",
  "intensity": 0.0-1.0,
  "valence": -1.0 to 1.0 (negative to positive),
  "triggers": ["what caused this mood - max 2 words each, max 3 triggers"]
}`;

  const fallback = { mood: 'neutral', intensity: 0.3, valence: 0.0, triggers: [] };

  try {
    const result = await localLLM.generate(prompt);
    if (!result) return fallback;

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      mood: parsed.mood || 'neutral',
      intensity: typeof parsed.intensity === 'number' ? Math.min(1, Math.max(0, parsed.intensity)) : 0.3,
      valence: typeof parsed.valence === 'number' ? Math.min(1, Math.max(-1, parsed.valence)) : 0.0,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.slice(0, 3) : [],
    };
  } catch {
    return fallback;
  }
}

// ============================================================
// INGEST — Full pipeline
// ============================================================

/**
 * Ingest raw text into the memory graph.
 *
 * @param {string} rawText - The text to ingest
 * @param {string} sourceType - Where this came from: conversation | document | manual | life-journey
 * @param {string|null} sourceId - The ID of the source record
 * @param {object|null} scope - Phase 1 scope tuple { chatJid, companyId, tier, audience, subjects }.
 *                              When null, derived from sourceType via deriveScopeForNode.
 *                              Passed through unchanged to every internal createNode call so
 *                              sentiment / conversation-raw / atom nodes all carry the same scope.
 * @returns {Array<{id, type, content}>} The created nodes
 */
async function ingest(rawText, sourceType = 'manual', sourceId = null, scope = null) {
  console.log(`[Ingestion] Processing ${rawText.length} chars (source: ${sourceType})`);

  // If no scope was passed, derive a sensible default from sourceType. The
  // caller is encouraged to pass scope (every site in sky/index.js does post-
  // Stage-C); this is a safety net for legacy paths and external callers.
  const effectiveScope = scope || deriveScopeForNode({ sourceType, sourceId });

  // Step 0: Sentiment scoring (local, free, fast)
  if (sourceType === 'conversation') {
    scoreSentiment(rawText).then(async (sentiment) => {
      try {
        if (sentiment.mood !== 'neutral' && sentiment.intensity > 0.3) {
          const emotionContent = `the user's mood: ${sentiment.mood} (intensity: ${sentiment.intensity.toFixed(1)}, valence: ${sentiment.valence.toFixed(1)})${sentiment.triggers.length ? '. Triggers: ' + sentiment.triggers.join(', ') : ''}`;

          await graph.createNode({
            type: 'emotion',
            content: emotionContent,
            tags: ['mood', 'sentiment', sentiment.mood, ...sentiment.triggers],
            sourceType: 'sentiment',
            sourceId: sourceId,
            initialWeight: 0.4, // moderate weight — mood is transient but trackable
            scope: effectiveScope,
          });

          console.log(`[Ingestion] Mood detected: ${sentiment.mood} (${sentiment.intensity.toFixed(1)}) — node created`);
        }
      } catch (e) {
        console.warn(`[Ingestion] Sentiment node creation failed: ${e.message}`);
      }
    }).catch(() => {}); // non-blocking — never slow down ingestion
  }

  // Step 0.5: Raw conversation safety net — store full text as low-weight backup
  if (sourceType === 'conversation' && rawText.length > 50) {
    graph.createNode({
      type: 'fact',
      content: rawText.substring(0, 2000), // cap at 2000 chars
      tags: ['raw', 'conversation', 'backup'],
      sourceType: 'conversation-raw',
      sourceId: sourceId,
      initialWeight: 0.15, // very low weight — safety net only
      scope: effectiveScope,
    }).catch(() => {}); // non-blocking
  }

  // Step 1: Decompose into atomic units
  const atoms = await decompose(rawText);

  if (!atoms.length) {
    console.log('[Ingestion] No atomic nodes extracted');
    return [];
  }

  console.log(`[Ingestion] ${atoms.length} atomic nodes extracted`);

  // Step 2: Create nodes in graph + link to person anchors
  //
  // IMPORTANT: created[] is pre-allocated and indexed by atom position so that
  // Steps 3 + 4 can use atom index → node mapping. If we used push(), a single
  // failed atom would shift every subsequent index and Step 3's relates_to edges
  // would attach to the wrong nodes (or crash with TypeError reading .id of
  // undefined). Bridge has been clean-exiting on group-chat ingestion likely
  // because of an unhandled exception escaping this loop.
  const created = new Array(atoms.length).fill(null);
  const nodeMap = new Map(); // content substring → node id (for edge creation)

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    try {
      let nodeType = atom.type || 'fact';

      // Person handling via registry — the ONLY authority on person nodes
      if (nodeType === 'person') {
        const personKey = personRegistry.findPerson(atom.content);
        if (personKey) {
          // Known person — demote to fact and link to their anchor
          console.log(`[Ingestion] Person registry: "${atom.content.substring(0, 40)}" → fact (known: ${personKey})`);
          nodeType = 'fact';
        }
        // If not a known person, let it through as person type — it might be someone new
      }

      const node = await graph.createNode({
        type: nodeType,
        content: atom.content,
        tags: atom.tags || [],
        sourceType,
        sourceId,
        scope: effectiveScope,
      });
      created[i] = node;
      // Index by first 50 chars for relation matching
      nodeMap.set(atom.content.slice(0, 50), node.id);

      // Step 2.5: Person anchor linking — connect new nodes to existing person anchors
      if (sourceType === 'conversation' || sourceType === 'group-chat') {
        // Link to person anchors via registry
        const personKey = personRegistry.findPerson(node.content);
        if (personKey) {
          personRegistry.linkToPerson(node.id, personKey, sourceType === 'life-architecture' ? 0.7 : 0.5).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[Ingestion] Failed to create node for atom ${i}: ${err.message}`);
    }
  }

  // Step 3: Create explicit edges from relates_to hints
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    if (!atom.relates_to?.length) continue;
    const sourceNode = created[i];
    if (!sourceNode) continue; // atom failed to create — nothing to attach edges to

    for (const relTarget of atom.relates_to) {
      // Find the target node by matching content
      const targetKey = [...nodeMap.keys()].find(k =>
        k.toLowerCase().includes(relTarget.toLowerCase().slice(0, 30)) ||
        relTarget.toLowerCase().includes(k.toLowerCase().slice(0, 30))
      );

      if (targetKey && nodeMap.get(targetKey) !== sourceNode.id) {
        await graph.upsertEdge({
          sourceId: sourceNode.id,
          targetId: nodeMap.get(targetKey),
          type: 'relates_to',
          strength: 0.5,
          linkerNote: `Explicit relation from ingestion: "${atom.content.slice(0, 60)}"`,
        }).catch(e => console.warn(`[Ingestion] Edge creation failed: ${e.message}`));
      }
    }
  }

  // Step 4: Intra-batch edges — nodes in the same ingestion run share context
  // Connect nodes that co-appeared (weak link). Skip null slots from failed atoms.
  const successful = created.filter(n => n !== null);
  if (successful.length > 1) {
    const cap = Math.min(successful.length, 5);
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        await graph.upsertEdge({
          sourceId: successful[i].id,
          targetId: successful[j].id,
          type: 'mentions',
          strength: 0.3, // weak — just co-occurrence
          linkerNote: `Co-ingested from same source (${sourceType}/${sourceId || 'manual'})`,
        }).catch(() => {}); // ignore errors on weak edges
      }
    }
  }

  console.log(`[Ingestion] Complete: ${successful.length}/${atoms.length} nodes created, edges linked`);

  // Step 5: Contradiction detection — fire and forget
  // Checks if any new nodes update or contradict existing knowledge
  // Pass the filtered array — contradiction logic shouldn't see null slots from failed atoms
  _detectAndHandleContradictions(successful).catch(e =>
    console.warn(`[Ingestion] Contradiction detection failed: ${e.message}`)
  );

  return successful;
}

// ============================================================
// QUICK HELPERS
// ============================================================

/**
 * Ingest a single known fact directly (no decomposition needed).
 * Use when you know exactly what you want to store.
 */
async function ingestFact({ type, content, tags = [], sourceType = 'manual', sourceId = null, scope = null }) {
  // Derive a default scope if none was passed. Most ingestFact callers are
  // global-by-design (manual / fact-loading) so the default lands sensibly.
  const effectiveScope = scope || deriveScopeForNode({ sourceType, sourceId });
  return graph.createNode({ type, content, tags, sourceType, sourceId, scope: effectiveScope });
}

/**
 * Ingest a person profile (from LIFE-JOURNEY/people/ or conversation).
 */
async function ingestPerson({ name, facts = [], tags = [] }) {
  const nodes = [];

  // Create a root node for the person — high weight, these are core relationship anchors
  const personNode = await graph.createNode({
    type: 'person',
    content: name,
    tags: [name.toLowerCase().replace(/\s+/g, '-'), ...tags],
    sourceType: 'manual',
    initialWeight: 0.7,
  });
  nodes.push(personNode);

  // Create fact nodes and link them to the person
  for (const fact of facts) {
    const factNode = await graph.createNode({
      type: 'fact',
      content: fact,
      tags: [name.toLowerCase().replace(/\s+/g, '-')],
      sourceType: 'manual',
    });

    await graph.upsertEdge({
      sourceId: personNode.id,
      targetId: factNode.id,
      type: 'involves',
      strength: 0.7,
      linkerNote: `Fact about ${name}`,
    });

    nodes.push(factNode);
  }

  return nodes;
}

// ============================================================
// CONTRADICTION DETECTION — LLM-classified temporal reasoning
// ============================================================

/**
 * Detect contradiction signals in text.
 * Returns true if the content seems to be correcting or contradicting prior state.
 */
function _hasContradictionSignal(content) {
  const lower = content.toLowerCase();
  return (
    /\b(no longer|not anymore|was wrong|incorrect|actually|instead|updated|changed|now is|turned out|in fact|despite|however|but actually|correction|revised|overridden)\b/.test(lower)
  );
}

/**
 * LLM-classified contradiction detection.
 * Uses Claude Haiku to classify the relationship between two semantically similar nodes.
 *
 * @param {object} existingNode - The existing node from the graph
 * @param {object} newNode - The newly ingested node
 * @returns {{ relationship: string, reason?: string, effectiveDate?: string|null }}
 */
async function classifyContradiction(existingNode, newNode) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Given two memory nodes from the same person's knowledge graph:

EXISTING: ${existingNode.content} (type: ${existingNode.type}, created: ${existingNode.createdAt})
NEW: ${newNode.content} (type: ${newNode.type})

Classify the relationship:
- "contradicts": The new node directly replaces or invalidates the existing node
- "refines": The new node adds nuance or evolves the existing node without invalidating it
- "unrelated": High semantic similarity but different domain or meaning

If contradicts: provide a reason and an effectiveDate if inferrable from context.

Respond ONLY in JSON:
{ "relationship": "contradicts|refines|unrelated", "reason": "...", "effectiveDate": "ISO|null" }`,
      }],
    });

    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Ingestion] No JSON found in contradiction classification response');
      return { relationship: 'unrelated' };
    }

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn(`[Ingestion] Contradiction classification failed: ${err.message}`);
    return { relationship: 'unrelated' };
  }
}

/**
 * After ingesting a batch, check new nodes for contradiction with existing graph.
 *
 * Process:
 *  1. For each new node, find semantically similar existing nodes (> 0.75)
 *  2. Pre-filter: only run expensive LLM classification if either:
 *     - _hasContradictionSignal() fires on the new node's content, OR
 *     - Semantic similarity > 0.85 (very high match even without contradiction signals)
 *  3. Call classifyContradiction() via Claude Haiku for qualified candidates
 *  4. If "contradicts": supersede the old node, set validFrom on new node
 *  5. If "refines": create supports edge at 0.6
 *  6. If "unrelated": skip
 */
async function _detectAndHandleContradictions(newNodes) {
  if (!newNodes.length) return;

  for (const newNode of newNodes) {
    try {
      const hasSignal = _hasContradictionSignal(newNode.content);

      // Find semantically similar existing nodes
      const similar = await embeddings.searchSimilar(newNode.content, 5, 'memory_node');
      const candidates = similar.filter(s =>
        s.similarity > CONTRADICTION_SIMILARITY_THRESHOLD && s.sourceId !== newNode.id
      );

      for (const hit of candidates) {
        // Pre-filter: skip expensive LLM call unless we have a reason to check
        if (!hasSignal && hit.similarity <= 0.85) continue;

        const existingNode = await graph.getNode(hit.sourceId);
        if (!existingNode) continue;

        // LLM classification
        const classification = await classifyContradiction(existingNode, newNode);

        if (classification.relationship === 'contradicts') {
          // Supersede: old node fades, new node takes over
          await graph.supersede(existingNode.id, newNode.id, classification.reason || 'LLM-detected contradiction');

          // Set validFrom on the new node
          const effectiveDate = classification.effectiveDate
            ? new Date(classification.effectiveDate)
            : new Date();

          await prisma.memoryNode.update({
            where: { id: newNode.id },
            data: { validFrom: effectiveDate },
          });

          console.log(`[Ingestion] Contradiction: "${newNode.content.slice(0, 50)}" supersedes "${existingNode.content.slice(0, 50)}" (reason: ${classification.reason || 'n/a'})`);
        } else if (classification.relationship === 'refines') {
          // Refinement: create a supports edge
          await graph.upsertEdge({
            sourceId: newNode.id,
            targetId: existingNode.id,
            type: 'supports',
            strength: 0.6,
            linkerNote: `Refinement detected: ${classification.reason || 'adds nuance to existing knowledge'}`,
          }).catch(() => {});

          console.log(`[Ingestion] Refinement: "${newNode.content.slice(0, 50)}" refines "${existingNode.content.slice(0, 50)}"`);
        }
        // "unrelated" → skip silently
      }
    } catch (err) {
      console.warn(`[Ingestion] Contradiction check failed for node: ${err.message}`);
    }
  }
}

// ============================================================
// PERSON ANCHOR LINKING — via person-registry.js (single source of truth)
// ============================================================

/**
 * Update an existing person anchor with new information.
 * Called when the user says things like "my mum's name is Caroline" or "Person B's full title is..."
 */
async function updatePerson(nameQuery, newFacts) {
  const personKey = personRegistry.findPerson(nameQuery);
  if (!personKey) return null;

  const anchor = await personRegistry.getOrCreateAnchor(personKey);
  if (!anchor) return null;

  // Create fact nodes for each new piece of info and link to the anchor
  const created = [];
  for (const fact of (Array.isArray(newFacts) ? newFacts : [newFacts])) {
    const factNode = await graph.createNode({
      type: 'fact',
      content: fact,
      tags: Array.isArray(anchor.tags) ? [...anchor.tags] : [],
      sourceType: 'manual',
      initialWeight: 0.6,
    });

    await graph.upsertEdge({
      sourceId: anchor.id,
      targetId: factNode.id,
      type: 'involves',
      strength: 0.7,
      linkerNote: `Person update: ${fact.substring(0, 60)}`,
    });

    created.push(factNode);
  }

  console.log(`[Ingestion] Updated person "${anchor.content.substring(0, 40)}" with ${created.length} new facts`);
  return { anchor, created };
}

/**
 * Create a new person anchor with optional facts and relationships.
 * Called when the user mentions someone new: "my step brother Dan"
 */
async function addPerson({ name, relationship = '', facts = [], tags = [], linkedTo = [] }) {
  // Check if person already exists in registry
  const existingKey = personRegistry.findPerson(name);
  if (existingKey) {
    console.log(`[Ingestion] Person "${name}" already in registry — updating`);
    return updatePerson(name, facts);
  }

  // Add to registry as new person
  const key = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const anchor = await personRegistry.addNewPerson(key, {
    name,
    relationship,
    aliases: [name.toLowerCase().split(' ')[0]], // first name as alias
    tags,
  });

  // Create fact nodes and link
  const created = [anchor];
  for (const fact of facts) {
    const factNode = await graph.createNode({
      type: 'fact',
      content: fact,
      tags: [name.toLowerCase().replace(/\s+/g, '-')],
      sourceType: 'manual',
      initialWeight: 0.5,
    });

    await graph.upsertEdge({
      sourceId: anchor.id,
      targetId: factNode.id,
      type: 'involves',
      strength: 0.7,
      linkerNote: `Fact about ${name}`,
    });

    created.push(factNode);
  }

  // Link to other people
  for (const link of linkedTo) {
    const targetKey = personRegistry.findPerson(link.name);
    if (targetKey) {
      const targetAnchor = await personRegistry.getOrCreateAnchor(targetKey);
      if (targetAnchor) {
        await graph.upsertEdge({
          sourceId: anchor.id,
          targetId: targetAnchor.id,
          type: link.type || 'relates_to',
          strength: link.strength || 0.6,
          linkerNote: link.note || `${name} connected to ${targetAnchor.content.substring(0, 40)}`,
        });
      }
    }
  }

  console.log(`[Ingestion] Created person "${name}" with ${facts.length} facts and ${linkedTo.length} links`);
  return { anchor, created };
}

export default {
  ingest,
  ingestFact,
  ingestPerson,
  addPerson,
  updatePerson,
  decompose,
  classifyContradiction,
  scoreSentiment,
};
