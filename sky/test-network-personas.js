/**
 * Smoke test: Phase 4 (network personas) + Phase 5 (chat-tagging) against
 * real MemoryNode + PersonaFact data.
 */
//
// Tests:
//   1. findPromotionCandidates returns reasonable people from the user's graph
//   2. (optional, off by default) promote one candidate and verify
//      a 'people' PersonaFact with that slot exists afterward
//   3. autoTagOneToOneChats walks 1:1 chats and finds tag-able ones
//
// Run via:
//   docker exec skymem sh -c '
//     export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s|@localhost:|@host.docker.internal:|g")
//     node /app/sky/test-network-personas.js [--promote-one] [--auto-tag]
//   '

import prisma from './prisma-client.js';
import networkPersonas from './network-personas.js';
import chatTagging from './chat-tagging.js';

const PROMOTE_ONE = process.argv.includes('--promote-one');
const AUTO_TAG = process.argv.includes('--auto-tag');

console.log('=== Phase 4 + 5 smoke test ===\n');

// 1. Discovery
console.log('1. findPromotionCandidates...');
const candidates = await networkPersonas.findPromotionCandidates({ limit: 15 });
console.log(`   Found ${candidates.length} candidates above thresholds:`);
for (const c of candidates) {
  console.log(`   - ${c.name.padEnd(28)} weight=${c.weight.toFixed(2)} refs=${String(c.referenceCount).padStart(3)} span=${String(c.temporalSpanDays).padStart(3)}d score=${c.score.toFixed(3)}`);
}

// 2. Optional: promote one
if (PROMOTE_ONE && candidates.length > 0) {
  const top = candidates[0];
  console.log(`\n2. Promoting top candidate: ${top.name}`);
  const result = await networkPersonas.promoteToPersona(top, { dryRun: false });
  console.log(`   Result: ok=${result.ok} factsWritten=${result.extractedFacts}`);
  console.log(`   Source nodes: ${result.contentNodes}`);
  console.log(`   By domain: ${JSON.stringify(result.byDomain)}`);

  // Verify the PersonaFact landed
  const verify = await prisma.personaFact.findUnique({
    where: { domain_slot: { domain: 'people', slot: top.slot } },
  });
  console.log(`   Verify: PersonaFact ${verify ? 'EXISTS' : 'MISSING'} for people/${top.slot}`);
} else if (PROMOTE_ONE) {
  console.log('\n2. No candidates to promote — skipping.');
} else {
  console.log('\n2. Skipping promotion (--promote-one not set).');
}

// 3. Chat-tag walk
console.log('\n3. autoTagOneToOneChats...');
const tagResult = await chatTagging.autoTagOneToOneChats({ dryRun: !AUTO_TAG });
console.log(`   Evaluated ${tagResult.evaluated} 1:1 chats`);
console.log(`   ${AUTO_TAG ? 'Tagged' : 'Would tag'}: ${tagResult.tagged}`);
console.log(`   Skipped (no matching persona): ${tagResult.skipped}`);

if (AUTO_TAG) {
  // Show what got tagged
  const tags = await prisma.chatTag.findMany({
    take: 10,
    include: { persona: { select: { domain: true, slot: true } } },
  });
  console.log(`\n   Sample ChatTag rows (${tags.length}):`);
  for (const t of tags) {
    console.log(`     ${t.chatJid.slice(0, 40).padEnd(40)} → ${t.persona.domain}/${t.persona.slot}  weight=${t.weight}  source=${t.source}`);
  }
}

// 4. Cache invalidation sanity
console.log('\n4. Cache invalidation...');
chatTagging.invalidateCache();
console.log('   ✓ invalidateCache() — no throw');

console.log('\n=== smoke test complete ===');
await prisma.$disconnect();
