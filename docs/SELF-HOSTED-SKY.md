# Self-Hosted Sky: the plan

**Goal:** anyone can run their own Sky. Clone, keys, QR, and she's in your WhatsApp tonight,
running entirely on hardware you control. "POW, she's in your phone, running your own setup."

This doc is the honest gap analysis between what ships today and that experience, plus a
sequenced plan. The marketing promise on thisissky.ai ("Run your own") is written against
Phase 1 only, so the site never promises what the repo can't deliver.

---

## What ships today (verified against this repo, June 2026)

- `./install.sh` defaults to **personal-PA mode**: prompts for Anthropic + Cohere keys,
  walks through WhatsApp pairing via Baileys, prints a QR code in the terminal (~10s).
- Once paired, every message to Sky is ingested and extracted into the memory graph
  (persona facts, typed edges, trajectories, chat-tagging, the full 13-layer stack).
- Nightly maintenance exists (`npm run nightly`, behavioural-pattern mining).
- Everything is local: docker compose, BYO keys, ELv2 license.

So the core "POW" already exists as the dogfood path. What's missing is everything around it.

## The gaps, honestly

| Gap | Why it matters |
|---|---|
| No morning-brief scheduler exposed as a feature | The brief is Sky's signature moment; today it's dogfood wiring, not a documented capability with config (time, timezone, content toggles). |
| Baileys pairing fragility | Session drops, re-pairing, multi-device quirks. No `sky doctor` to diagnose, no auto-reconnect docs. |
| Always-on requirement is implicit | Sky on a laptop dies when the lid closes. Nobody tells the user they need an always-on box (mini PC, home server, cheap VPS) and what the trade-offs are (VPS = your WhatsApp session and keys on rented metal). |
| 16 GB RAM floor | Fine for builders, heavy for a "run your assistant" audience. No documented slim profile (e.g. local embeddings off, smaller models). |
| Action surface is thin in self-host | Site copy says she books meetings and chases email. Self-hosted Sky reads WhatsApp; calendar/email actions need integrations that aren't packaged. The site must not promise these for self-host until they land. |
| No update channel | `git pull` is not an update strategy for non-developers. |
| Safety rails | An agent that messages your real contacts needs explicit confirmation defaults, an allowlist, and an audit trail surfaced to the user (the audit_log primitive already exists; expose it). |

## The plan

### Phase 1: "the honest dogfood path" (now → +4 weeks)
Ship what exists, packaged truthfully. This is what thisissky.ai's "Run your own" section sells today.

1. `SELF-HOSTING.md` walkthrough in this repo: hardware guidance (always-on machine, RAM),
   pairing, re-pairing, backup/restore of the graph volume.
2. `sky doctor`: one command that checks docker health, key validity, Baileys session state,
   disk, and prints fixes. Most support load dies here.
3. Morning brief as config: `BRIEF_HOUR=06:30 BRIEF_TZ=Europe/London` in `.env`, cron in the
   compose stack. It already runs nightly maintenance; the brief is the same shape.
4. Outbound-message confirmation default ON + per-contact allowlist + `audit_log` surfaced
   as `sky log`. Safety before reach.

### Phase 2: "one box, one command" (+1 to +3 months)
5. Prebuilt multi-arch image on GHCR (no local build, ARM for Mac minis and Pis with
   documented slim profile).
6. `sky update` (pull image, migrate prisma, restart) and versioned releases.
7. Umbrel / CasaOS / Start9 app-store listings: the self-host audience already lives there,
   and each listing is distribution.

### Phase 3: "yours, but we rack it" (+3 to +6 months, optional revenue)
8. Provisioned single-tenant VPS: we run the box, the user brings keys, data is theirs and
   exportable, priced monthly. This is the bridge between waitlist and self-host, and it's
   only honest if export-and-leave is one command.

## What the site says, mapped to phases

- thisissky.ai "Run your own" section: Phase 1 only. Clone, keys, QR, fair warning about
  Docker + RAM + always-on. It links here and to skymem.io.
- When Phase 2 lands, the section gains "or one command on a Mac mini in your closet".
- Phase 3, if built, becomes a third pricing shape on both sites.

## Decisions needed from Ross

- Does Phase 3 (managed-but-yours) fit the brand, or does it dilute "data never leaves you"?
- Is the WhatsApp-via-Baileys risk acceptable long-term (unofficial API), or should
  self-hosted Sky get a first-class Telegram/Signal mode as a hedge?
- Pricing if hosted seats open while self-host is free: what does the hosted tier add
  (uptime, integrations, support) so free doesn't read as crippled and hosted doesn't read as a tax?
