/**
 * Chat Tagging — Phase 5 (2026-05-09).
 *
 * Per-chat persona attribution. The mechanic the user described:
 *   "1:1 chats tag whole-conversation to the other participant. Group
 *   chats attribute proportionally. Massive depth multiplier for network
 *   personas."
 *
 * Design ref: docs/persona-layer-vNext.md (Chat-tagging — Phase 5).
 *
 * The pipeline:
 *   1. ChatTag rows map chatJid → personaId, with a weight (1.0 for 1:1,
 *      share-of-messages for groups). Multiple tags allowed per chat.
 *   2. On every MemoryNode create, the in-memory cache returns the tags
 *      for that chat. The result is stored on MemoryNode.attributedPersonas
 *      as `[{personaId, weight}, ...]` for retrieval-time consumption.
 *   3. Phase 4 (network personas) consumes the attribution signal as a
 *      depth multiplier — facts about persona X gain confidence when
 *      MULTIPLE tagged-chat conversations corroborate them, not just the
 *      message-text mentions.
 *
 * For MVP we wire:
 *   - 1:1 auto-tagger from chatJid pattern (`whatsapp:dm:<jid>`)
 *   - manual tag/untag CLI helpers
 *   - in-memory cache (60s TTL — chat tags rarely change)
 *   - createNode hook in sky/graph.js reads cache, sets attributedPersonas
 *
 * Group-chat proportional attribution (per-message-share aggregator) is
 * a follow-up — sketched but not wired.
 */

import prisma from './prisma-client.js';

// ============================================================
// CACHE
// ============================================================

const _cache = new Map(); // chatJid → { tags: [{personaId, weight, source}], at: ms }
const CACHE_TTL_MS = 60_000;

function _cacheGet(chatJid) {
  const e = _cache.get(chatJid);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    _cache.delete(chatJid);
    return null;
  }
  return e.tags;
}

function _cacheSet(chatJid, tags) {
  _cache.set(chatJid, { tags, at: Date.now() });
}

function invalidateCache(chatJid = null) {
  if (chatJid) _cache.delete(chatJid);
  else _cache.clear();
}

// ============================================================
// LOOKUPS
// ============================================================

/**
 * Get all ChatTag rows for a chatJid, cached. Returns the raw tags
 * `[{personaId, weight, source}]` shape suitable for storing on a node's
 * attributedPersonas field.
 */
async function getTagsForChatJid(chatJid) {
  if (!chatJid) return [];
  const cached = _cacheGet(chatJid);
  if (cached) return cached;

  try {
    const rows = await prisma.chatTag.findMany({
      where: { chatJid },
      select: { personaId: true, weight: true, source: true },
    });
    const tags = rows.map(r => ({
      personaId: r.personaId,
      weight: r.weight,
      source: r.source,
    }));
    _cacheSet(chatJid, tags);
    return tags;
  } catch (e) {
    console.warn(`[ChatTag] getTagsForChatJid(${chatJid}) failed: ${e.message}`);
    return [];
  }
}

/**
 * Build the attributedPersonas JSON field for a new MemoryNode. Called
 * by sky/graph.js#createNode. Returns null when no tags exist (so the
 * field stays null vs an empty array — easier to filter later).
 */
async function attributePersonasForNode({ chatJid }) {
  if (!chatJid) return null;
  const tags = await getTagsForChatJid(chatJid);
  if (!tags || tags.length === 0) return null;
  return tags.map(t => ({ personaId: t.personaId, weight: t.weight }));
}

// ============================================================
// MUTATIONS
// ============================================================

/**
 * Tag a 1:1 chat to one PersonaFact at full weight (1.0). Idempotent.
 *
 * @param {string} chatJid
 * @param {string} personaId — must reference an existing PersonaFact id
 *   in domain='people' (network persona).
 */
async function tagOneToOne(chatJid, personaId, { source = 'auto-1to1' } = {}) {
  if (!chatJid || !personaId) {
    throw new Error('[ChatTag] tagOneToOne requires chatJid + personaId');
  }
  const persona = await prisma.personaFact.findUnique({
    where: { id: personaId },
    select: { id: true, domain: true },
  });
  if (!persona) throw new Error(`[ChatTag] no PersonaFact with id ${personaId}`);
  if (persona.domain !== 'people') {
    throw new Error(`[ChatTag] PersonaFact ${personaId} domain is '${persona.domain}', expected 'people'`);
  }

  const tag = await prisma.chatTag.upsert({
    where: { chatJid_personaId: { chatJid, personaId } },
    create: { chatJid, personaId, weight: 1.0, source },
    update: { weight: 1.0, source, updatedAt: new Date() },
  });
  invalidateCache(chatJid);
  return tag;
}

/**
 * Tag a group chat with multiple personas at proportional weights.
 * Weights MUST sum to ≤ 1.0 (untagged participants account for the rest).
 *
 * @param {string} chatJid
 * @param {Array<{personaId: string, weight: number}>} weights
 */
async function tagGroup(chatJid, weights, { source = 'auto-group' } = {}) {
  if (!chatJid || !Array.isArray(weights) || weights.length === 0) {
    throw new Error('[ChatTag] tagGroup requires chatJid + non-empty weights');
  }
  const sum = weights.reduce((s, w) => s + (w.weight || 0), 0);
  if (sum > 1.0001) {
    throw new Error(`[ChatTag] group weights sum to ${sum.toFixed(2)}, must be ≤ 1.0`);
  }
  // Upsert each
  for (const w of weights) {
    if (!w.personaId || typeof w.weight !== 'number') continue;
    await prisma.chatTag.upsert({
      where: { chatJid_personaId: { chatJid, personaId: w.personaId } },
      create: { chatJid, personaId: w.personaId, weight: w.weight, source },
      update: { weight: w.weight, source, updatedAt: new Date() },
    });
  }
  invalidateCache(chatJid);
  return prisma.chatTag.findMany({ where: { chatJid } });
}

/**
 * Remove all tags for a chat. Used when a chat is reassigned.
 */
async function untagChat(chatJid) {
  if (!chatJid) return 0;
  const r = await prisma.chatTag.deleteMany({ where: { chatJid } });
  invalidateCache(chatJid);
  return r.count;
}

// ============================================================
// AUTO-TAGGING
// ============================================================

/**
 * Auto-tag every 1:1 WhatsApp chat where the other participant has a
 * matching network PersonaFact. Pattern:
 *   chatJid = "whatsapp:dm:<jid>"
 *   we map jid → person name via MemoryNode.tags (`name:<X>` / `person:<X>`)
 *   then look for a PersonaFact in domain='people' with that name's slot
 *
 * Cheap to run nightly. Idempotent (existing tags get refreshed).
 *
 * Returns counts: { evaluated, tagged, skipped }.
 */
async function autoTagOneToOneChats(options = {}) {
  const { dryRun = false } = options;

  // Gather distinct 1:1 chatJids from MemoryNode
  const chatRows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT chatJid FROM MemoryNode WHERE chatJid LIKE 'whatsapp:dm:%' LIMIT 5000`
  );
  const chatJids = chatRows.map(r => r.chatJid).filter(Boolean);

  let tagged = 0;
  let skipped = 0;
  for (const chatJid of chatJids) {
    // Find the dominant non-the user speaker tag in this chat
    const sample = await prisma.memoryNode.findMany({
      where: { chatJid, tags: { array_contains: 'sender:other' } },
      take: 5,
      select: { tags: true, subjects: true },
    });

    // Try to extract a person name from sample tags / subjects
    const candidateNames = new Set();
    for (const r of sample) {
      const tags = Array.isArray(r.tags) ? r.tags : [];
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        if (t.startsWith('name:')) candidateNames.add(t.slice(5).trim());
        if (t.startsWith('person:')) candidateNames.add(t.slice(7).trim());
      }
      const subjects = Array.isArray(r.subjects) ? r.subjects : [];
      for (const s of subjects) {
        if (typeof s === 'string' && s.length > 0 && s.length < 40) candidateNames.add(s);
      }
    }

    if (candidateNames.size === 0) {
      skipped++;
      continue;
    }

    // Find a matching PersonaFact in domain='people'. Use the network-personas
    // slot convention (kebab-case lowercase). First match wins; in practice
    // there should only be one canonical person per chat.
    let matched = null;
    for (const name of candidateNames) {
      const slot = name
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9\-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (!slot) continue;
      const pf = await prisma.personaFact.findUnique({
        where: { domain_slot: { domain: 'people', slot } },
        select: { id: true },
      });
      if (pf) {
        matched = { name, slot, personaId: pf.id };
        break;
      }
    }

    if (!matched) {
      skipped++;
      continue;
    }

    if (!dryRun) {
      try {
        await tagOneToOne(chatJid, matched.personaId, { source: 'auto-1to1' });
      } catch (e) {
        console.warn(`[ChatTag] tagOneToOne(${chatJid}) failed: ${e.message}`);
        continue;
      }
    }
    tagged++;
  }

  return { evaluated: chatJids.length, tagged, skipped };
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  getTagsForChatJid,
  attributePersonasForNode,
  tagOneToOne,
  tagGroup,
  untagChat,
  autoTagOneToOneChats,
  invalidateCache,
};
