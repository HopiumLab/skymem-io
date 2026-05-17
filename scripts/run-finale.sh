#!/usr/bin/env bash
# FINALE — finish headline #1 + run headline #2.
#
# Phase A (finish #1):
#   1. conv-49 question-loop rerun (data exists, skip ingest+extract)
#   2. conv-50 fresh persona extract + question-loop
#   3. conv-43 chunked (3 × ~80 q)
#   4. conv-48 chunked (3 × ~80 q)
#
# Phase B (#2):
#   5. Cohere migration (re-embed all bench MemoryNodes)
#   6. Bench v4: full 10-sample LOCOMO with persona+Cohere
#
# Usage: docker exec skymem bash /app/scripts/run-finale.sh

set -u
RUN_TAG="finale-$(date +%Y%m%d-%H%M%S)"
LOG="/app/bench/${RUN_TAG}-master.log"
echo "Run: $RUN_TAG  start: $(date -u +%H:%M:%S)" | tee "$LOG"

export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

step() {
  echo "" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
  echo "STEP: $1  ($(date -u +%H:%M:%S))" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
}

# ============================================================
# Phase A — finish headline #1
# ============================================================

step "A1. conv-49 question loop rerun (skip-ingest)"
node --max-old-space-size=2560 --expose-gc \
  /app/scripts/bench-locomo.js \
  --conv-id=conv-49 --persona=on --skip-ingest \
  > "/app/bench/${RUN_TAG}-conv-49.log" 2>&1
echo "exit=$?" | tee -a "$LOG"
grep -E "^  \[eval\]" "/app/bench/${RUN_TAG}-conv-49.log" | tail -1 | tee -a "$LOG"
sleep 5

step "A2. conv-50 (data exists, persona will extract fresh)"
# conv-50 has 568 nodes ingested but 0 persona facts — extractor will run
node --max-old-space-size=2560 --expose-gc \
  /app/scripts/bench-locomo.js \
  --conv-id=conv-50 --persona=on --skip-ingest \
  > "/app/bench/${RUN_TAG}-conv-50.log" 2>&1
echo "exit=$?" | tee -a "$LOG"
grep -E "^  \[eval\]" "/app/bench/${RUN_TAG}-conv-50.log" | tail -1 | tee -a "$LOG"
sleep 5

step "A3. conv-43 chunked (3 × 80 q, total 242)"
PERSONA_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-43 242 80 "${RUN_TAG}-c43" 2>&1 | tee -a "$LOG"
sleep 5

step "A4. conv-48 chunked (3 × 80 q, total 239)"
PERSONA_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-48 239 80 "${RUN_TAG}-c48" 2>&1 | tee -a "$LOG"
sleep 5

# ============================================================
# Phase B — headline #2 with Cohere
# ============================================================

step "B1. Cohere embedding migration"
echo "Setting SKY_EMBED_PROVIDER=cohere for the migration + bench" | tee -a "$LOG"
# Re-embed all MemoryNodes (the user + bench data) with Cohere v3
SKY_EMBED_PROVIDER=cohere node /app/scripts/reembed.js --rps=20 \
  > "/app/bench/${RUN_TAG}-cohere-migration.log" 2>&1
echo "exit=$?" | tee -a "$LOG"
tail -10 "/app/bench/${RUN_TAG}-cohere-migration.log" | tee -a "$LOG"
sleep 5

step "B2. Bench #2: full 10-sample with persona + Cohere + nucleus expansion"
# Run with Cohere active AND nucleus expansion enabled. The MemMachine paper
# credits nucleus expansion (±2 adjacent turns per retrieved conversation
# node) with +3-8pp lift. Nucleus is built (sky/nucleus-expansion.js,
# committed 5db79b4) but gated `--nucleus=off` until validated. Phase B
# is the validation: stack persona + Cohere + nucleus and see the lift.
SKY_EMBED_PROVIDER=cohere NUCLEUS_FLAG=on bash /app/scripts/run-locomo-sequential.sh "${RUN_TAG}-cohere" 2>&1 | tee -a "$LOG"
sleep 5

step "B3. Chunked rerun for conv-43 + conv-48 with Cohere (if needed)"
# Check whether the sequential run already covered them. If they show
# up as "Killed" / no eval line, run chunked.
SEQ_MASTER="/app/bench/seq-${RUN_TAG}-cohere-master.log"
if grep -q "conv-43.*no eval line" "$SEQ_MASTER" 2>/dev/null; then
  echo "conv-43 OOM in cohere bench — running chunked" | tee -a "$LOG"
  SKY_EMBED_PROVIDER=cohere PERSONA_FLAG=on NUCLEUS_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-43 242 80 "${RUN_TAG}-cohere-c43" 2>&1 | tee -a "$LOG"
fi
if grep -q "conv-48.*no eval line" "$SEQ_MASTER" 2>/dev/null; then
  echo "conv-48 OOM in cohere bench — running chunked" | tee -a "$LOG"
  SKY_EMBED_PROVIDER=cohere PERSONA_FLAG=on NUCLEUS_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-48 239 80 "${RUN_TAG}-cohere-c48" 2>&1 | tee -a "$LOG"
fi

step "DONE"
echo "$(date -u +%H:%M:%S)" | tee -a "$LOG"
echo "" | tee -a "$LOG"
echo "Finale logs at: /app/bench/${RUN_TAG}-*.log" | tee -a "$LOG"
