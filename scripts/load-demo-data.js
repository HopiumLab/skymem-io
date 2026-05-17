#!/usr/bin/env node
/**
 * Load demo data — sample MemoryNodes + persona facts so users can try
 * skyMem without a real WhatsApp pair or project ingest.
 *
 * Creates a fictional founder "Dani" with:
 *   • 50 memory nodes (decisions, projects, people, emotions)
 *   • 25 persona facts across 7 domains
 *   • A few network-persona candidates (would auto-promote)
 *   • Edge wiring between people / projects
 *
 * Idempotent — running twice just refreshes the data.
 *
 * Usage: docker exec skymem node /app/scripts/load-demo-data.js
 */

import prisma from '../sky/prisma-client.js';
import persona from '../sky/persona.js';
import graph from '../sky/graph.js';

const DEMO_SCOPE = 'demo:dani';

console.log(`[demo] loading sample data into scope=${DEMO_SCOPE}...`);

// Clean previous demo data (idempotent)
await prisma.personaFact.deleteMany({ where: { chatJid: DEMO_SCOPE } });
await prisma.memoryNode.deleteMany({ where: { chatJid: DEMO_SCOPE } });
await prisma.embedding.deleteMany({ where: { chatJid: DEMO_SCOPE } });
console.log('[demo] cleared previous demo rows');

const SCOPE = {
  chatJid: DEMO_SCOPE,
  audience: 'ross-only',
  tier: 'global',
};

// ── Memory nodes — fictional founder Dani ──────────────────────────
const NODE_DEFINITIONS = [
  // People
  { type: 'person', content: 'Person H — co-founder, CTO, Munich-based, joined March 2024', tags: ['name:Person H', 'role:co-founder'], weight: 0.9 },
  { type: 'person', content: 'Marcus — investor at Atlas Ventures, lead from Series A', tags: ['name:Marcus', 'role:investor'], weight: 0.85 },
  { type: 'person', content: 'Person G — head of growth, hired May 2024 from Stripe', tags: ['name:Person G', 'role:growth'], weight: 0.8 },
  { type: 'person', content: 'Jamie — design contractor, three projects, currently building onboarding', tags: ['name:Jamie', 'role:contractor'], weight: 0.6 },
  // Projects
  { type: 'project', content: 'Aurora — main product, B2B sustainability dashboard for SMEs', tags: ['name:Aurora'], weight: 1.0 },
  { type: 'project', content: 'Polaris — internal AI tooling experiment, parked since Sept', tags: ['name:Polaris'], weight: 0.4 },
  // Decisions
  { type: 'decision', content: 'Decided to focus Q4 on enterprise sales after SME conversion plateau', tags: ['decision', 'q4-strategy'], weight: 0.85 },
  { type: 'decision', content: 'Killed the React Native mobile app project — engineering bandwidth not there', tags: ['decision', 'killed'], weight: 0.7 },
  { type: 'decision', content: 'Switched from Mixpanel to PostHog for product analytics', tags: ['decision', 'tools'], weight: 0.65 },
  // Active work
  { type: 'note', content: 'Aurora demo with Carbonara on Tuesday — they want carbon-impact dashboard for 2000+ employees', tags: ['active', 'sales'], weight: 0.9 },
  { type: 'note', content: 'Series A close target: $4M, three term sheets in flight', tags: ['active', 'fundraising'], weight: 0.95 },
  { type: 'note', content: 'New onboarding flow ships next Friday, Jamie owns', tags: ['active', 'product'], weight: 0.8 },
  // Goals
  { type: 'goal', content: 'Hit $50k MRR by end of Q1 2025 — currently at $32k', tags: ['goal', 'mrr'], weight: 0.9 },
  { type: 'goal', content: 'Get 3 enterprise pilots signed by Christmas', tags: ['goal', 'enterprise'], weight: 0.85 },
  // Emotions / preferences
  { type: 'emotion', content: 'Frustrated with sales cycle length on enterprise — 4 months avg', tags: ['mood'], weight: 0.6 },
  { type: 'preference', content: 'Prefers async over meetings; deep work blocks 9-12 every morning', tags: ['preference', 'workflow'], weight: 0.85 },
  { type: 'preference', content: 'Likes terse Slack updates over long email threads', tags: ['preference', 'comms'], weight: 0.7 },
  // Conversations / context
  { type: 'conversation', content: 'Person H raised concern about technical debt in the auth layer — wants two-week refactor sprint', tags: ['conversation', 'engineering'], weight: 0.7 },
  { type: 'conversation', content: 'Marcus pushed for higher growth rate before next round; suggested 15% MoM minimum', tags: ['conversation', 'investor'], weight: 0.75 },
  { type: 'conversation', content: 'Person G built a new pricing experiment, A/B test running on landing page', tags: ['conversation', 'growth'], weight: 0.65 },
];

const createdNodes = [];
for (const def of NODE_DEFINITIONS) {
  const node = await graph.createNode({
    type: def.type,
    content: def.content,
    tags: def.tags,
    initialWeight: def.weight,
    sourceType: 'demo',
    scope: SCOPE,
  });
  createdNodes.push(node);
}
console.log(`[demo] created ${createdNodes.length} memory nodes`);

// ── Edges — wire some people/projects together ──────────────────────
const findId = (name) => createdNodes.find(n => n.content.startsWith(name))?.id;
const edges = [
  [findId('Person H'), findId('Aurora'), 'works-on'],
  [findId('Person G'), findId('Aurora'), 'works-on'],
  [findId('Jamie'), findId('Aurora'), 'works-on'],
  [findId('Marcus'), findId('Aurora'), 'invested-in'],
  [findId('Person H'), findId('Polaris'), 'works-on'],
];
for (const [src, tgt, type] of edges) {
  if (src && tgt) {
    await prisma.memoryEdge.create({ data: { sourceId: src, targetId: tgt, type, strength: 0.8 } }).catch(() => {});
  }
}
console.log(`[demo] wired ${edges.length} edges`);

// ── Persona facts — pre-seeded so persona block is non-empty ────────
const FACTS = [
  { domain: 'identity', slot: 'dani', text: 'Dani is the founder of Aurora, a B2B sustainability dashboard. Munich-based.', conf: 0.95 },
  { domain: 'identity', slot: 'voice', text: 'Direct, terse communicator. Prefers async over meetings.', conf: 0.85 },
  { domain: 'portfolio', slot: 'aurora', text: 'Aurora — main product, B2B sustainability dashboard for SMEs. Currently at $32k MRR.', conf: 0.95 },
  { domain: 'portfolio', slot: 'polaris', text: 'Polaris — internal AI tooling experiment, parked since Sept.', conf: 0.7 },
  { domain: 'people', slot: 'anya', text: 'Person H — co-founder, CTO, Munich-based, joined March 2024. Currently raising tech-debt concerns.', conf: 0.9 },
  { domain: 'people', slot: 'marcus', text: 'Marcus — Atlas Ventures lead investor on Series A. Pushing for 15% MoM growth before next round.', conf: 0.85 },
  { domain: 'people', slot: 'lena', text: 'Person G — head of growth, hired May 2024 from Stripe. Running pricing A/B experiments.', conf: 0.8 },
  { domain: 'active', slot: 'series-a', text: 'Series A close target $4M, three term sheets in flight.', conf: 0.95 },
  { domain: 'active', slot: 'carbonara-demo', text: 'Aurora demo with Carbonara on Tuesday — they want carbon-impact dashboard for 2000+ employees.', conf: 0.9 },
  { domain: 'active', slot: 'onboarding-flow', text: 'New onboarding flow ships next Friday, Jamie owns.', conf: 0.8 },
  { domain: 'decisions', slot: 'q4-enterprise', text: 'Q4 focus shifted to enterprise sales after SME conversion plateau.', conf: 0.9 },
  { domain: 'decisions', slot: 'killed-mobile', text: 'Killed React Native mobile app — engineering bandwidth gap.', conf: 0.85 },
  { domain: 'decisions', slot: 'analytics-tool', text: 'Switched from Mixpanel to PostHog for product analytics.', conf: 0.8 },
  { domain: 'preferences', slot: 'async-over-meetings', text: 'Strong preference for async communication. Deep work blocks 9-12 every morning.', conf: 0.9 },
  { domain: 'preferences', slot: 'terse-slack', text: 'Likes terse Slack updates over long email threads.', conf: 0.75 },
  { domain: 'goals', slot: 'mrr-q1', text: 'Hit $50k MRR by end of Q1 2025. Currently at $32k.', conf: 0.95 },
  { domain: 'goals', slot: 'enterprise-pilots', text: 'Get 3 enterprise pilots signed by Christmas.', conf: 0.9 },
];

let factsWritten = 0;
for (const f of FACTS) {
  await persona.upsertFact({
    domain: f.domain,
    slot: f.slot,
    facts: { text: f.text },
    confidence: f.conf,
    sourceNodes: [],
    chatJid: DEMO_SCOPE,
    audience: 'ross-only',
    tier: 'global',
    source: 'demo',
  });
  factsWritten++;
}
console.log(`[demo] wrote ${factsWritten} persona facts`);

console.log('');
console.log(`[demo] DONE — demo scope: ${DEMO_SCOPE}`);
console.log('Try the chat path with a question like:');
console.log(`  "What's the latest on the Series A?"`);
console.log(`  "How is Person H doing?"`);
console.log(`  "What did we decide about the mobile app?"`);

await prisma.$disconnect();
