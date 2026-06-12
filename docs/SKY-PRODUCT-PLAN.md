# Sky as a real product: the plan

**The question:** how does thisissky.ai stop being a waitlist and become a product anyone can use?

**The uncomfortable first fact:** this repo's roadmap currently says PA mode is
"founder dogfood + emotional brand, never the lead product." Stage 1 is builders and MCP.
So this plan is not an execution detail, it is a strategy decision. There are two honest
ways to hold it:

- **A. Sky stays the brand engine, run lean.** A small hosted cohort, concierge-grade,
  priced to cover costs, whose job is proof that the cognition works on real lives.
  skyMem-for-builders stays the lead.
- **B. Sky becomes a lead product.** Real investment: action layer, official channels,
  billing, support, compliance. The builders roadmap slows down.

Everything below is sequenced so the first 90 days are identical for A and B.
You only have to choose at day 90, with cohort data in hand.

---

## The core product insight: there are two Skys

| | Hosted Sky | Self-hosted Sky |
|---|---|---|
| Whose number | **Hers.** You text Sky like any contact. | **Yours.** Paired into your WhatsApp via Baileys. |
| What she sees | Only what you tell her + sources you explicitly connect (calendar, email). | Everything in your chats. |
| Onboarding | Save a contact, send "hi". 30 seconds. | Clone, keys, Docker, QR. 30 minutes. |
| Platform risk | None to the user's account. WhatsApp Business API, fully official. | Baileys is unofficial; user accepts the risk on their own account. |
| Privacy story | Consent is trivially clear. | Maximal memory, maximal responsibility, all local. |

This split solves the three hardest problems at once:

1. **Onboarding.** "Message this number" is the entire funnel. No pairing, no QR, no docker.
2. **Meta ToS.** Companion mode runs on the WhatsApp Business API legitimately. Baileys
   never touches a hosted user's account; it stays the self-host power path.
3. **Trust.** Hosted Sky knowing "only what you give her" is a feature, not a weakness:
   the memory graph makes the little she's told compound, which is exactly the skyMem demo.

The site already sells this shape by accident: waitlist (hosted, her number) and
"run your own" (embedded, your number). Keep it.

## What exists vs what "product" requires

**Exists and works (verified in this repo):** WhatsApp ingest, 13-layer memory, persona,
trajectories, network promotion, nightly maintenance, briefs as dogfood wiring, audit primitives.

**Does not exist yet as shippable product surface:**

| Gap | Needed for | Build note |
|---|---|---|
| Action layer (calendar, email drafts, send-with-confirm) | The site's "she books meetings" claims | Google OAuth (calendar read first), Gmail draft-only second, outbound send always confirmation-first. Sequence it; do not block launch on it. Memory + briefs alone are already a product. |
| WhatsApp Business API integration | Hosted channel | 24h session windows fit companion mode (user texts first). Morning brief needs one approved template ("Your morning brief is ready, reply to open"), which is exactly what templates are for. |
| Multi-user hosting | Cohort > 1 | Pod-per-user: the existing compose stack is the unit. Slim profile first (drop local @xenova embeddings for hosted Cohere, target <2 GB/user). True multi-tenant is a month-6 problem, not month-1. |
| Metering + caps | Not going broke | Per-user token budget, Haiku for extraction, alerting at 80%. BYOK tier for power users (their keys, lower price). |
| Billing | Revenue | Stripe, monthly, founder price $25 to start. No free tier; the QR self-host path IS the free tier. |
| Trust surface | Anyone non-technical | Privacy policy, GDPR export + delete as one command each (audit_log and the graph make this honest), "we never train on your data", confirmation-first outbound, per-contact allowlist. |
| Ops | Sleep | Session-health dashboard, missed-brief detection, on-call runbook. A PA that misses one morning brief is dead to that user. |

## The 90 days (same for strategy A and B)

**Weeks 1-2, cohort zero (n=10, concierge).**
Hand-picked from the waitlist. Hosted companion Sky on a WhatsApp Business number
(or Telegram if WABA approval drags; it is days vs weeks). Briefs + memory Q&A only.
Ross watches every conversation (with consent). $25/month from day one; free users lie.

**Weeks 3-6, self-serve mechanics (n=50).**
Stripe, automated provisioning (pod per user), calendar read via Google OAuth,
the trust surface (policy, export, delete), session-health alerts.
Activation metric: user receives and replies to a morning brief within 48h of signup.

**Weeks 7-12, the spigot (n=200-500).**
Open the waitlist in batches. Ship email drafts (draft-only). Self-host Phase 2
(prebuilt image) ships in parallel and feeds the open-source flywheel.
Kill criteria defined in advance: if D30 < 40% or cost/user > $15/mo at n=200, pause and rethink.

**Day 90: the A/B decision**, with real data:
D30 retention, briefs replied %, corrections per user per week (memory quality),
support minutes per user, gross margin per user.

## Unit economics sketch (sanity, not gospel)

Per active user per month: extraction on ~40 msgs/day (Haiku) + nightly sweep +
30 briefs (Sonnet) + retrieval embeddings ≈ **$4-9/mo** in API costs at today's prices,
plus ~$3-5/mo infra per slim pod. At $25/mo that is a thin-but-real margin in the worst
case and a fine one in the typical case. Levers if wrong: extraction batching, brief on
Haiku with Sonnet verifier, BYOK tier.

## What "everyone" actually means in sequence

1. Now: operators and founders who live in WhatsApp (the Ross-shaped wedge; the site already speaks to them).
2. After product-market signal: their teams (assistant-with-shared-context, maps to skyMem org mode).
3. Only then: actual consumers, and only if D30 supports it.

"Everyone" as a day-one target is how PA products die; the graveyard is full of
general-purpose assistants that were nobody's assistant in particular.

## Decisions only Ross can make

1. **A or B** at day 90, and what it means for the builders roadmap in this repo.
2. **Channel order:** wait for WhatsApp Business API approval, or launch cohort zero on
   Telegram in week 1 and accept the "she lives in WhatsApp" copy needs a footnote for a while.
3. **Price:** $25 founder-cohort pricing vs higher ($39-49) to filter for serious users
   and fund the concierge time.
4. **The name on the door:** does hosted Sky bill as Real Talk Holdings or does Sky become
   its own entity (matters for WABA business verification, which needs a registered business).
