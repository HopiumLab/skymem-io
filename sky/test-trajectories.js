/**
 * Smoke test: trajectories module against real PersonaFactRevision data.
 *
 * Run via: node sky/test-trajectories.js (requires populated PersonaFact +
 * PersonaFactRevision rows in the DB).
 */
import prisma from './prisma-client.js';
import trajectories from './trajectories.js';

const N_TO_TEST = 5;

console.log('=== Trajectories smoke test ===');

// Find the facts with the most revisions — those are the ones with
// histories where slope/velocity is meaningful.
const candidates = await prisma.$queryRawUnsafe(
  `SELECT factId, COUNT(*) as n FROM PersonaFactRevision GROUP BY factId ORDER BY n DESC LIMIT ${N_TO_TEST * 3}`
);

if (candidates.length === 0) {
  console.log('No PersonaFactRevision rows found — run the persona bootstrap first.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Found ${candidates.length} candidate facts; testing top ${Math.min(N_TO_TEST, candidates.length)}.`);

for (const c of candidates.slice(0, N_TO_TEST)) {
  const fact = await prisma.personaFact.findUnique({
    where: { id: c.factId },
    select: { domain: true, slot: true, confidence: true, chatJid: true },
  });
  if (!fact) continue;

  const traj = await trajectories.computeTrajectory(c.factId);
  console.log(`\n[${fact.domain}/${fact.slot}] (chatJid=${fact.chatJid || 'global'}) — ${Number(c.n)} revisions`);
  console.log(`  state: ${traj.state}  ${traj.summary}`);
  console.log(`  slope: ${traj.confidenceSlope.toFixed(4)}/day  velocity: ${traj.confidenceVelocity.toFixed(3)}  volatility: ${traj.volatility.toFixed(2)}`);
  console.log(`  span: ${traj.daysSpan.toFixed(1)}d (${traj.firstSeen.slice(0, 10)} → ${traj.lastSeen.slice(0, 10)})`);
}

console.log('\n=== getInterestingTrajectories ===');
const interesting = await trajectories.getInterestingTrajectories({
  states: ['rising', 'declining', 'volatile'],
  minSlopeMag: 0.0,
  limit: 8,
});
console.log(`Found ${interesting.length} interesting trajectories`);
for (const t of interesting) {
  console.log(`  ${t.factId.slice(0, 16)} state=${t.state} ${t.summary}`);
}

await prisma.$disconnect();
