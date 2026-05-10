/**
 * Verify the persona-retrieval round-trip:
 *   write a fact → retrieveForQuery returns it → buildPersonaBlock renders cleanly
 *
 * Run via: node sky/test-persona-retrieval.js (requires DB connection).
 */
import prisma from './prisma-client.js';
import persona from './persona.js';

const stats = await persona.stats();
console.log('=== Persona DB stats ===');
console.log(`  Total facts: ${stats.totalFacts}`);
console.log(`  Avg confidence: ${(Number(stats.avgConfidence) || 0).toFixed(2)}`);
console.log(`  Revisions: ${stats.totalRevisions}`);
console.log(`  By domain:`);
for (const r of stats.byDomain) console.log(`    - ${r.domain}: ${r.count}`);

console.log('\n=== retrieveForQuery (with intent hint = definitional) ===');
const facts1 = await persona.retrieveForQuery('Tell me about Project A', {
  domainHints: ['identity', 'people', 'portfolio'],
  slotHints: ['project-a', 'demo', 'sample'],
  limit: 8,
});
console.log(`  Got ${facts1.length} facts`);
for (const f of facts1) {
  console.log(`    [${f.domain}/${f.slot}] (${f.confidence.toFixed(2)}, ${f._matchType}) ${(typeof f.facts === 'object' ? JSON.stringify(f.facts) : f.facts).slice(0, 100)}`);
}

console.log('\n=== retrieveForQuery (no hints — grounding only) ===');
const facts2 = await persona.retrieveForQuery('hey what\'s up', { limit: 5 });
console.log(`  Got ${facts2.length} facts`);
for (const f of facts2) {
  console.log(`    [${f.domain}/${f.slot}] (${f.confidence.toFixed(2)}, ${f._matchType})`);
}

console.log('\n=== buildPersonaBlock render ===');
const block = persona.buildPersonaBlock(facts1);
console.log(block);

await prisma.$disconnect();
