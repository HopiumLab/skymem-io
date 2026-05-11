# skyMem failure catalog

**What this is:** a public, curated catalog of real failure modes skyMem has hit in production, with root cause, fix, and (where applicable) the commit that resolved it.

**Why this exists:** every memory system has weaknesses. Most systems hide them. We publish ours because the credibility of a memory system that claims "audit-grade", "EU AI Act ready", and "the trusted state layer for persistent AI agents" requires that we don't pretend bugs don't exist.

If you're evaluating skyMem against another memory system, this is the doc to read first. Then read the equivalent doc for the competitor. If they don't have one, ask yourself why.

**Maintained by:** the same team that ships the engine. Updated on every confirmed in-production failure that surfaces. Each entry is dated and traceable to a commit.

---

## How to read each entry

```
ID    — short identifier for cross-referencing
Class — runtime config | engine | chat path | tooling | filesystem | capability | log hygiene | latency | defensibility
Date surfaced — when the failure was observed in production / dogfood
Symptom — what the user / operator saw
Root cause — what was actually wrong (debugged, not guessed)
Fix — code change, config change, or operational change applied
Status — fixed / partial / known-open
Commit — git SHA of the fix in HopiumLab/skymem-io (or "operational" if no code change)
```

If an entry says **status: known-open**, the bug has been confirmed and is in our queue. We don't sit on confirmed bugs silently.

---

## 2026-05-10 dogfood + bench sweep (P0 / P1)

This sweep was triggered by two things:
1. the user's Sky-the-PA on WhatsApp hallucinated ("Keeva app", "Kat Fraser your mate"), dropped context between consecutive messages, and confabulated her own capabilities
2. The T3 fullstack LOCOMO bench attempt crashed on the first chunk (`exit=137` OOM), then again on the second with a Prisma `String → napi string` marshaling failure

What looked like two separate incidents traced back to 11 interacting bugs — most of them silent-failure patterns that had been quietly degrading the system for hours or days. All 11 are below.

---

### A — OOM `exit=137` on the first bench chunk

| | |
|---|---|
| **Class** | runtime config |
| **Date** | 2026-05-10 |
| **Symptom** | First bench chunk dies with `exit=137` before completing a question; subsequent chunks crash similarly until BENCH_HEAP is raised |
| **Root cause** | The first chunk pays a cold-start tax — embedding model load + persona load + Cohere client init + first-question retrieval all at once. With `--max-old-space-size=1500` (BENCH_HEAP=1500 MB) the peak overlap exceeds the heap limit |
| **Fix** | Raised `BENCH_HEAP=1500 → 3000`. Subsequent chunks reuse the warm cache so peak memory is much lower; only the first one needed the headroom |
| **Status** | fixed |
| **Commit** | operational (script-level config in `scripts/run-t3-fullstack.sh`) |

### B — Prisma 6.19.2 NAPI marshaling failure on 53k-row embedding cache load

| | |
|---|---|
| **Class** | engine |
| **Date** | 2026-05-10 |
| **Symptom** | `prisma.embedding.findMany({ select: { ..., vector: true } })` throws `Failed to convert rust 'String' into napi 'string'` on every 5-min cache reload. Cache stays empty → every retrieval pays a fresh Cohere embed call. Visible as 66s cold tax per chunk, OOM on first chunk, Cohere rate limits on long runs |
| **Root cause** | Confirmed Prisma 6.19.2 bug: NAPI string marshaling fails when a result set is too large. At 53,926 rows × 1024-dim vector data, the marshaler chokes. Verified by isolating the call: `TAKE 100` works, `TAKE 5000` works, full dataset fails consistently |
| **Fix** | Cursor-paginated chunked load — 5000 rows per batch, per-batch try/catch (one bad batch doesn't blackout the cache), progress logging. Total load time 53,926 rows in 11 batches, ~66s cold. Smaller batches stay well below the marshaling threshold |
| **Status** | fixed |
| **Commit** | `ace6f09` — `sky/embeddings.js` `loadCache()` rewrite |

### C — WhatsApp bridge silent-degraded mode after transient DB outage

| | |
|---|---|
| **Class** | engine |
| **Date** | 2026-05-10 |
| **Symptom** | Sky-the-PA hallucinates ("Keeva app, Thursday's the demo"), confabulates relationships ("Kat Fraser, your mate"), drops context between her own consecutive WhatsApp messages — for 3+ hours after a Docker restart |
| **Root cause** | `bridges/whatsapp-baileys/start.js` wrapped `sky.init()` in a `try { ... } catch { console.error('Sky will still work but memory/context may be limited'); /* Don't exit */ }`. When MySQL wasn't ready at boot, init failed once, the catch swallowed the error, and the bridge ran indefinitely with no DB connection. Every WhatsApp turn was a fresh hallucination with no session memory. **Classic silent-degraded anti-pattern** |
| **Fix** | Retry with backoff `[2s, 5s, 10s, 20s, 30s]`, then `process.exit(1)` so Docker / PM2 restarts with fresh DB state. Loud comment in the file forbidding future contributors from re-introducing the catch-and-continue: *"DO NOT run in degraded mode — a memoryless Sky hallucinates."* |
| **Status** | fixed |
| **Commit** | `ace6f09` — `bridges/whatsapp-baileys/start.js` |

### D — Bench scripts broken by git's Windows CRLF auto-conversion

| | |
|---|---|
| **Class** | tooling |
| **Date** | 2026-05-10 |
| **Symptom** | `$'\r': command not found` errors on bench script startup; the script reports `syntax error near unexpected token 'elif'`. Bench never runs |
| **Root cause** | Git on Windows auto-converts LF endings to CRLF on checkout. Shell scripts written for the Linux container inherit `\r` characters that bash can't parse |
| **Fix** | `.gitattributes` pins `*.sh`, `*.bash`, Dockerfile, `*.yml`, and `*.js`/`*.mjs` to LF endings via `text eol=lf`. Plus an in-container `sed -i 's/\r$//'` to recover already-converted files |
| **Status** | fixed |
| **Commit** | `c7e7ad6` — new `.gitattributes` |

### E — Tier 5 schema never migrated to MySQL (defensibility-critical)

| | |
|---|---|
| **Class** | defensibility |
| **Date** | 2026-05-10 |
| **Symptom** | Every `logAuditEvent` and `logDecision` call throws `The table 'AuditLog' does not exist in the current database`. Has been broken since the Tier 5 commit landed |
| **Root cause** | The Tier 5 commit added `AuditLog`, `ContradictionPair`, `DecisionLineage` models to `prisma/schema.prisma` and the `sky/observability.js` runtime, but the migration was never run against production MySQL. The Prisma client had the model definitions so writes would compile; MySQL had no tables. **The entire audit-grade pitch — provenance for every belief, decisions logged court-grade, EU AI Act ready — was fiction in production until this was caught** |
| **Fix** | `npx prisma db push` against live MySQL — created the three tables in 377ms (zero data loss, additive only). Smoke-test write + delete cycle confirmed working. Going forward: schema migrations run in `docker-entrypoint.sh` so this category of fiction cannot recur |
| **Status** | fixed |
| **Commit** | `91cd8f9` — operational schema push + docs |

### F — 92-second WhatsApp turn latency

| | |
|---|---|
| **Class** | latency |
| **Date** | 2026-05-10 |
| **Symptom** | First WhatsApp message after a restart takes ~93s end-to-end (`total:92983ms`); subsequent messages drop to 3-7s |
| **Root cause** | Cold-start tax stacking: embedding cache cold load (Bug B fix took it from "fails entirely" to "66s once") + failing observability writes throwing on every turn (Bug E) + first-message API cold path. Subsequent turns ride a warm cache and drop to 3-7s naturally |
| **Fix** | Resolved automatically by fixing B (cache load works, so cold tax is paid once not per turn) and E (observability writes succeed instead of throwing, removing the per-turn error overhead) |
| **Status** | fixed |
| **Commit** | upstream of `ace6f09` + `91cd8f9` |

### G — 163 `[ProjectManager] Path not found` warnings every startup

| | |
|---|---|
| **Class** | log hygiene |
| **Date** | 2026-05-10 |
| **Symptom** | sky-server logs flood with 163 `[ProjectManager] WARNING: Path not found for repo X` warnings on every restart — drowning real errors in noise |
| **Root cause** | Repo paths in the DB are stored as Windows host paths (`C:/Users/ross/Desktop/Projects/X`), but sky-server runs inside a Linux container where the host Projects dir is bind-mounted at `/projects`. `existsSync('C:/Users/...')` is always false inside the container |
| **Fix** | New `resolveRepoPath()` helper translates Windows host paths to container mount paths (`/projects/X`) before the existence check. Per-repo warnings collapsed into a single summary line listing the count of genuinely-missing paths (if any) |
| **Status** | fixed |
| **Commit** | `91cd8f9`, `2812e87` — `server/project-manager.js` |

### H — Auth-backup rotation `EACCES` on stuck directories

| | |
|---|---|
| **Class** | filesystem |
| **Date** | 2026-05-10 |
| **Symptom** | WhatsApp bridge logs `EACCES: permission denied, unlink ...auth-backup-2026-04-28T...` on every startup; disk usage slowly accumulates |
| **Root cause** | Auth-backup directories were created by a different uid (outside the container or by a previous container version); the current container's `node` user can't `unlink` files in them |
| **Fix** | Removed stuck directories from the host (where we have permissions). Code path already handles `unlink` failure gracefully via try/catch + warn, so no code change needed |
| **Status** | fixed |
| **Commit** | operational |

### I — Silent catch on `ctxRecent` cross-channel context load

| | |
|---|---|
| **Class** | engine |
| **Date** | 2026-05-10 |
| **Symptom** | When the cross-channel-context retrieval throws (DB error, transient timeout), Sky loses awareness of activity on other channels — and starts confabulating. Failure was invisible because the catch was empty (`/* */`) |
| **Root cause** | `sky/index.js` chat path had `} catch (e) { /* */ } finally { ... }` around `getRecentConversations`. Same anti-pattern as Bug C, just localised to one phase |
| **Fix** | Catch now logs the error via `console.warn` AND calls `requestLogger.logError(trace, 'ctxRecent', e)` so the request's `ERRORS` counter reflects the actual failure count. Behaviour unchanged (best-effort retrieval; the request still completes with degraded context), but the failure is no longer invisible |
| **Status** | fixed |
| **Commit** | `91cd8f9` |

### J — Idea-routing false-positive on "build out X"

| | |
|---|---|
| **Class** | chat path |
| **Date** | 2026-05-10 |
| **Symptom** | User says "you need a SkyMem or to **build out your own system**". Sky replies with `I couldn't find a seed idea matching "your own system". Say "I've got an idea: [description]" first, then "validate your own system" and I'll promote it.` Conversation derails |
| **Root cause** | The `detectIdea()` regex included `build out` and `flesh out` as trigger verbs. These are far too common in casual conversation. Captured target ("your own system") was then searched against the idea seed table, never found, and the boilerplate fallback was returned |
| **Fix** | Two-part: (1) tightened the regex — dropped `build out` and `flesh out`, now REQUIRES the keyword `idea` in the matched phrase, so only unambiguous validate-the-X-idea commands trigger; (2) when `handleValidateIdea` finds no matching seed, it returns `null` and the dispatcher falls through to the normal chat path instead of returning boilerplate |
| **Status** | fixed |
| **Commit** | `1495cab` — `sky/index.js` `detectIdea` + `handleValidateIdea` + dispatcher |

### K — Sky-the-PA cannot create_event / send_email from WhatsApp chat

| | |
|---|---|
| **Class** | capability |
| **Date** | 2026-05-10 |
| **Symptom** | User asks Sky on WhatsApp to "put this in the calendar" or "send Person A an email". Sky says she doesn't have calendar/email tools — but they exist and the Google bridge is connected. Users have to confabulate her capabilities. The Claude Code `sky-email` skill could invoke them, but Sky-the-PA herself had no path |
| **Root cause** | The capability lives in `bridges/google/index.js` (`createEvent`, `sendEmail`, `getUpcomingEvents`) and the OAuth is wired. But the WhatsApp chat path's API call to Claude never passed any tool definitions — Sky-the-PA's LLM literally couldn't reach those functions |
| **Fix** | New module `sky/sky-pa-tools.js` defines three Anthropic tool_use specs (`create_calendar_event`, `send_email`, `get_calendar_events`) with input schemas + handlers that call the bridge. `sky/api-fallback.js` extended with the full tool_use loop (call API → execute tool_use blocks → append tool_result → call again → repeat, with `maxToolIterations=4` safety bound). `sky/index.js` chat path now passes the tools + handlers and prepends a `getToolPrompt()` block to the cached system message. Result: Sky-the-PA can now create events and send emails end-to-end from a single WhatsApp turn |
| **Status** | fixed |
| **Commit** | `1495cab` — new file `sky/sky-pa-tools.js`, extended `sky/api-fallback.js`, wired in `sky/index.js` |

---

## Cross-cutting lessons

The 2026-05-10 sweep made three patterns explicit. These are now project-wide rules in `SKY-REBUILD.md`:

### Rule 1 — silent catch-and-continue is forbidden

The Bug C anti-pattern (`Sky will still work but memory/context may be limited`) produced 3 hours of hallucinations because the bridge "succeeded" with no memory access. **Either fail loud and retry, or fast-fail and let Docker restart you.** Never half-succeed quietly.

Implicated bugs: **C** (bridge init), **I** (ctxRecent retrieval).

### Rule 2 — schema migrations must run on deploy

Bug E was "the Tier 5 audit-grade pitch was fiction in production for two days." The schema was committed; the `prisma db push` was not run. **Migrations land in `docker-entrypoint.sh` so this category of failure cannot recur silently.**

Implicated bugs: **E** (Tier 5 schema), and historically a class of "I added the model but forgot to migrate" risks.

### Rule 3 — never restart sky-bridge while T1 bench runs

A self-inflicted restart at 20:26 (to pick up tool wiring changes) killed an in-flight bench chunk and forced a re-kick. **Engine changes go in via a planned restart window OR after the bench completes — never opportunistically.**

This is operational, not code, but it's in the canon now.

---

## What this catalog is NOT

- **Not a complete history.** It's the bugs we've confirmed, reproduced, and fixed. Failure modes we suspect but haven't yet reproduced sit in a private triage queue until they're confirmed
- **Not a vulnerability disclosure.** Security issues go through `SECURITY.md` and the disclosure policy there
- **Not a marketing artefact.** Each entry is dated, named, and traceable. If we ever soft-peddle a real failure here, please open an issue with the receipts and we'll fix the entry

---

## Contributing

If you hit a failure mode while running skyMem (Docker, MCP server, bench, anything), open an issue with:
- What you saw
- What you did
- The relevant log lines (skip secrets — see `LICENSE` § "DATA USE")

If you've debugged a fix, a PR with a new entry below + the code change is the ideal path. We don't gate on aesthetics — the discipline is that every confirmed failure has a public entry, fast.

---

## Cross-references

- `docs/skymem-pitch.md` — the marketing claims this doc keeps honest
- `docs/comparison-honest.md` — capability matrix vs every public competitor
- `docs/BENCH-METHODOLOGY.md` — reproducibility receipts for the LOCOMO numbers
- `docs/agent-drift-eval-spec.md` — our own benchmark spec, same honesty contract
- `SKY-REBUILD.md` § "Bug catalog" — internal canon mirror of this doc
