#!/usr/bin/env bash
# FINALE v2 — picks up after conv-49 finishes (already in flight as PID 15645).
#
# Differences from v1:
# - Skips conv-49 (already running independently)
# - Phase B sequential bench has NUCLEUS_FLAG=on (MemMachine pattern,
#   projected +3-8pp on top of persona+Cohere)
# - Phase B chunked-followup also has NUCLEUS_FLAG=on
#
# Phase A continuation:
#   A2. conv-50 fresh persona + question loop
#   A3. conv-43 chunked (3 × 80 q)
#   A4. conv-48 chunked (3 × 80 q)
#
# Phase B (full stack):
#   B1. Cohere migration
#   B2. Full 10-sample bench with persona + Cohere + nucleus
#   B3. Chunked re-runs for conv-43+48 with persona+Cohere+nucleus if needed
#
# Usage: docker exec skymem bash /app/scripts/run-finale-v2.sh

set -u
RUN_TAG="finale-v2-$(date +%Y%m%d-%H%M%S)"
LOG="/app/bench/${RUN_TAG}-master.log"
echo "Run: $RUN_TAG  start: $(date -u +%H:%M:%S)" | tee "$LOG"

export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

step() {
  echo "" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
  echo "STEP: $1  ($(date -u +%H:%M:%S))" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
}

# Wait for any in-flight conv-49 process to complete before we start.
step "0. Wait for any in-flight conv-49 to complete"
while pgrep -f "bench-locomo.js.*conv-49" > /dev/null 2>&1; do
  sleep 30
  echo "  conv-49 still running at $(date -u +%H:%M:%S)" | tee -a "$LOG"
done
echo "  conv-49 done." | tee -a "$LOG"

# ============================================================
# Phase A continuation
# ============================================================

step "A2. conv-50 fresh persona + questions"
node --max-old-space-size=2560 --expose-gc \
  /app/scripts/bench-locomo.js \
  --conv-id=conv-50 --persona=on --skip-ingest \
  > "/app/bench/${RUN_TAG}-conv-50.log" 2>&1
echo "exit=$?" | tee -a "$LOG"
grep -E "^  \[eval\]" "/app/bench/${RUN_TAG}-conv-50.log" | tail -1 | tee -a "$LOG"
sleep 5

step "A3. conv-43 chunked (3 × 80 q)"
PERSONA_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-43 242 80 "${RUN_TAG}-c43" 2>&1 | tee -a "$LOG"
sleep 5

step "A4. conv-48 chunked (3 × 80 q)"
PERSONA_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-48 239 80 "${RUN_TAG}-c48" 2>&1 | tee -a "$LOG"
sleep 5

# ============================================================
# Phase B — full stack: persona + Cohere + nucleus
# ============================================================

step "B1. Cohere embedding migration"
SKY_EMBED_PROVIDER=cohere node /app/scripts/reembed.js --rps=20 \
  > "/app/bench/${RUN_TAG}-cohere-migration.log" 2>&1
echo "exit=$?" | tee -a "$LOG"
tail -10 "/app/bench/${RUN_TAG}-cohere-migration.log" | tee -a "$LOG"
sleep 5

step "B2. Full 10-sample bench with persona + Cohere + nucleus expansion"
SKY_EMBED_PROVIDER=cohere PERSONA_FLAG=on NUCLEUS_FLAG=on bash /app/scripts/run-locomo-sequential.sh "${RUN_TAG}-cohere-nucleus" 2>&1 | tee -a "$LOG"
sleep 5

step "B3. Chunked rerun for big convs that OOM in B2"
SEQ_MASTER="/app/bench/seq-${RUN_TAG}-cohere-nucleus-master.log"
if grep -q "conv-43.*no eval line" "$SEQ_MASTER" 2>/dev/null; then
  echo "conv-43 OOM in B2 — chunked" | tee -a "$LOG"
  SKY_EMBED_PROVIDER=cohere PERSONA_FLAG=on NUCLEUS_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-43 242 80 "${RUN_TAG}-cn-c43" 2>&1 | tee -a "$LOG"
fi
if grep -q "conv-48.*no eval line" "$SEQ_MASTER" 2>/dev/null; then
  echo "conv-48 OOM in B2 — chunked" | tee -a "$LOG"
  SKY_EMBED_PROVIDER=cohere PERSONA_FLAG=on NUCLEUS_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-48 239 80 "${RUN_TAG}-cn-c48" 2>&1 | tee -a "$LOG"
fi

step "DONE"
echo "$(date -u +%H:%M:%S)" | tee -a "$LOG"
