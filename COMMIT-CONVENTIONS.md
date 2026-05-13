# Commit conventions

**Status:** locked 2026-05-13. Adopted after v0.4 retrospective — the prior commit log was a tornado of styles (`T6: cat=4...`, `release v0.4...`, `README: add...`, `Phase 2.3...`). Going forward: Conventional Commits with bench-sprint scopes.

---

## The format

```
<type>(<scope>): <subject>

[body — what changed and why, hard-wrapped at 72 chars]

[footer — refs, breaking changes, co-authors]
```

**Subject line:** ≤ 72 chars, imperative mood ("add X" not "added X"), no trailing period.

**Body:** required for non-trivial changes. Explain the **why**, not the **what** (the diff shows the what).

**Footer:** issue refs, BREAKING CHANGE markers, Co-Authored-By lines.

---

## Types

| Type | Use for |
|---|---|
| `feat` | New feature, capability, mechanism |
| `fix` | Bug fix (production behaviour was wrong) |
| `perf` | Performance improvement |
| `refactor` | Code restructure with no behaviour change |
| `docs` | Documentation only |
| `test` | Test additions or changes |
| `bench` | Benchmark code, runners, results (skyMem-specific) |
| `chore` | Tooling, scripts, build config |
| `style` | Whitespace, formatting (rare) |
| `revert` | Reverts a prior commit |

---

## Scopes (skyMem-specific)

| Scope | Files / areas |
|---|---|
| `bench` | `scripts/bench-locomo.js`, `scripts/run-*.sh`, `scripts/spot-test-*.sh` |
| `cognition` | `sky/graph.js`, `sky/clusters.js`, `sky/persona.js`, `sky/linker.js` |
| `retrieval` | `sky/embeddings.js`, `sky/rerank.js`, `sky/keyword-search.js`, `sky/planner.js` |
| `verifier` | `sky/answer-verifier.js`, `sky/query-reformulator.js` |
| `dashboard` | `server/dashboard/*`, `server/index.js` API routes |
| `server` | `server/index.js` core |
| `prisma` | `prisma/schema.prisma`, migrations |
| `mcp` | `sky/mcp-server.js` |
| `docs` | `docs/*` (also use type `docs:`) |
| `ci` | `.github/workflows/*`, `docker-compose.yml`, `Dockerfile` |
| `release` | Version bumps + release notes only |

**Sprint scopes:** for memory-engine work targeted at specific LOCOMO categories or T-series sprints, the scope can include the sprint identifier:

```
feat(bench/t6): cat=4 RERANK_PROFILE 12 → 16
fix(bench/t4f): conv-47 regression investigation (T4g)
bench(t5): land results — 70.49% (-0.26 vs T4f)
docs(t5): results doc with regression analysis
```

---

## Subject line examples

### Good ✓
```
feat(bench): add spot-test-3 multi-conv validation gate
fix(dashboard/agents): clear filter dropdowns on auto-refresh
perf(dashboard): render only visible nodes (50k → 8k DOM cap)
docs(t5): publish results doc — 70.49% net regression analysis
revert(bench/t5): roll back temporal-proximity boost (didn't earn keep)
release: v0.4 — 70.75% LOCOMO + cognition router per-cat profiles
chore(docker): add ./skills volume mount to sky-server
bench(t6): cat=4 RERANK_PROFILE 12 → 16
```

### Bad ✗
```
T6: cat=4 stuff                  ← no type, jargon-only
fixed the dropdown bug           ← no type, past tense
Update README.md.                ← no type, no scope, no info, period
Made some changes                ← no type, no scope, no info
```

---

## Body — when to write one

**Always** for:
- New features (`feat`)
- Bug fixes (`fix`)
- Performance changes (`perf`)
- Bench sprints (`bench`)
- Anything that changes behaviour

**Skip the body** only for trivial commits (`chore: bump prettier`, `style: fix trailing whitespace`).

### Body template

```
WHY this change exists:
<one paragraph — what problem are we solving>

WHAT changed (high-level — the diff shows the details):
- <bullet 1>
- <bullet 2>

EXPECTED RESULT:
<numbers, projections, what we believe should happen>

NEXT STEPS (if any):
<follow-on work this enables or unblocks>
```

For bench commits specifically, include the run tag:

```
Run tag: t3fs-20260512-064522
Summary: /app/bench/t3fs-20260512-064522-summary.json
```

---

## Footer — required signoffs

Every commit gets the co-author line at the bottom:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

For releases, also add:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Breaking changes

If a commit changes a public API, dashboard route, MCP tool name, or anything that would surprise an existing consumer:

```
feat(mcp): rename retrieve_memory → retrieve_context

BREAKING CHANGE: The MCP tool `retrieve_memory` has been renamed
`retrieve_context` for consistency with the function name in
sky/index.js. Existing MCP clients calling `retrieve_memory` will
get "tool not found." Update tool names in your MCP client config.
```

The `BREAKING CHANGE:` marker (uppercase, followed by colon and description) goes in the footer. This flags it for changelog generation and release notes.

---

## Releases

Tagged releases follow semver-ish (`v0.1`, `v0.2`, `v0.2.1`, `v0.3`, `v0.4` so far):

- **MAJOR**: skip for now (we're pre-1.0). Reserved for architecture breaks.
- **MINOR**: aggregate benchmark improvement OR major feature surface. Each T-sprint result is roughly a minor.
- **PATCH**: bug fixes, doc updates, allowlist additions to the public-repo extract.

**Tag creation:**
```bash
git tag -a v0.X -m "v0.X — <headline>

<release notes body — same as the GitHub release>"
git push origin v0.X
```

**GitHub release creation** (via `gh`):
```bash
gh release create v0.X --title "v0.X — <headline>" --notes "$(cat <<'EOF'
<markdown release notes>
EOF
)"
```

Release notes should cover:
- Headline aggregate number + Δ vs previous
- Per-cat breakdown table
- Sprint mechanism summary (what shipped, what didn't)
- New docs added
- Reproduce-locally block

---

## When NOT to commit

- **Don't commit on bench-running.** If a full bench is mid-flight in `sky-bridge`, defer commits that touch the bench code or shared paths.
- **Don't squash sprint history.** Each T-sprint result is its own commit so the bench retrospective stays readable. (Internal feature branches CAN squash before merge — public branches don't.)
- **Don't `git commit --amend` after pushing.** Force-push rewrites history and breaks anyone who pulled.

---

## Examples from the v0.1 → v0.4 cycle

What we *should have* written (after-the-fact, mapped to the actual changes):

| Real commit subject | What it should have been |
|---|---|
| `Phase 2.4 — Skills catalog` | `feat(dashboard): add skills catalog with category drill-in` |
| `Dashboard perf fix — render only visible nodes (T6)` | `perf(dashboard): render only visible nodes (50k → 8k DOM cap)` |
| `T5 RESULTS: 70.49% (-0.26 vs T4f) — third Rule #4 receipt` | `bench(t5): land results — 70.49% (-0.26 vs T4f, Rule #4 #3)` |
| `T6: cat=4 RERANK_PROFILE 12 → 16 + spot-test-3 runner` | Should be two commits: `bench(t6): cat=4 RERANK_PROFILE 12 → 16` + `feat(bench): add spot-test-3 multi-conv validation gate` |
| `Agents page: fix duplicate filter dropdown entries` | `fix(dashboard/agents): clear filter dropdowns on auto-refresh` |
| `release v0.4: 70.75% LOCOMO + cognition router per-cat profiles` | `release: v0.4 — 70.75% LOCOMO + cognition router` |

Going forward, every commit uses this format. The bench retrospectives will be easier to read, the changelog auto-generates cleanly, and the GitHub releases stay tidy.
