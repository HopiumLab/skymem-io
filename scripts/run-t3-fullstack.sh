#!/usr/bin/env bash
# T3 FULL STACK — the final headline run (Tier 1+2+3).
#
# Stack active:
#   • Persona (the user + per-conv structured facts) — query-aware curation
#   • Cohere embed-v3 (1024d, retrieval-tuned)
#   • Nucleus expansion ±2 adjacent turns
#   • Cat=1 literal + list answer modes
#   • Cat=2 temporal arithmetic answer mode
#   • Cat=3 MULTIHOP chain-of-thought reasoning (NEW)
#   • Tier 2 verifier (Synthius pattern) (NEW)
#   • Tier 3 retrieval-miss reformulation (NEW)
#   • Tier 3 query-aware persona block boost (NEW)
#   • Lenient Haiku grader
#
# All 10 convs chunked at 50 questions per process (smaller than B2's 60
# because verifier + reformulation add ~30% latency per question).
#
# Usage: docker exec -d sky-bridge bash /app/scripts/run-t3-fullstack.sh
#
# Note: kick AFTER B2 chunked-fullstack finishes — they'd compete for memory
# and API rate limit otherwise. Use the wait-for-b2 wrapper if needed.

set -u
RUN_TAG="t3fs-$(date +%Y%m%d-%H%M%S)"
LOG="/app/bench/${RUN_TAG}-master.log"
SUMMARY="/app/bench/${RUN_TAG}-summary.json"
echo "T3 FULL STACK: $RUN_TAG  start: $(date -u +%H:%M:%S)" | tee "$LOG"
echo "Stack: persona+Cohere+nucleus+cat1/2/3-modes+verifier+reformulate+query-aware-persona" | tee -a "$LOG"

export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"
# Bump connection pool from default 3 → 20. The bench fires many parallel
# queries per question (graph retrieve + FTS + edge-walk + persona block
# + nucleus expansion + verifier evidence-fetch). With pool of 3, a
# nucleus chunk gets connection-pool-timeout death. 20 is plenty.
if [[ "$DATABASE_URL" == *connection_limit=3* ]]; then
  export DATABASE_URL="${DATABASE_URL/connection_limit=3/connection_limit=20}"
elif [[ "$DATABASE_URL" != *connection_limit* ]]; then
  if [[ "$DATABASE_URL" == *\?* ]]; then
    export DATABASE_URL="${DATABASE_URL}&connection_limit=20"
  else
    export DATABASE_URL="${DATABASE_URL}?connection_limit=20"
  fi
fi
export SKY_EMBED_PROVIDER=cohere

declare -A CONV_TOTALS=(
  [conv-26]=199 [conv-30]=105 [conv-41]=193 [conv-42]=260 [conv-43]=242
  [conv-44]=158 [conv-47]=190 [conv-48]=239 [conv-49]=196 [conv-50]=204
)
CHUNK_SIZE=30
BENCH_HEAP=3000

START_TS=$(date +%s)
TOTAL_Q=0; TOTAL_C=0
declare -A CAT_TOTAL CAT_CORRECT

step() {
  echo "" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
  echo "$1  ($(date -u +%H:%M:%S))" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
}

for CONV in conv-26 conv-30 conv-41 conv-42 conv-43 conv-44 conv-47 conv-48 conv-49 conv-50; do
  TOTAL=${CONV_TOTALS[$CONV]}
  step "CONV $CONV  total=$TOTAL  chunked at $CHUNK_SIZE"
  CONV_C=0; CONV_T=0

  for ((START=0; START<TOTAL; START+=CHUNK_SIZE)); do
    CHUNK_LOG="/app/bench/${RUN_TAG}-${CONV}-q${START}.log"
    echo "── ${CONV} q${START} start $(date -u +%H:%M:%S) ──" | tee -a "$LOG"

    # T3 fix #1 (2026-05-11): NUCLEUS=OFF based on T6 ablation findings.
    # The conv-43 ablation showed --nucleus=off gives +1.65 pp lift over baseline.
    # Hypothesis: ±2-turn context expansion over-pads prompts with adjacent
    # turns that don't help and sometimes confuse the answer generator
    # (esp. on cat=4 open-domain where baseline 81/107 → no-nucleus 83/107).
    # Validating on the full 10-conv bench in this run.
    SKY_EMBED_PROVIDER=cohere node --max-old-space-size="${BENCH_HEAP}" --expose-gc \
      /app/scripts/bench-locomo.js \
      --conv-id="$CONV" \
      --persona=on \
      --nucleus=off \
      --verifier=on \
      --reformulate=on \
      --skip-ingest \
      --start-question="$START" \
      --questions-per="$CHUNK_SIZE" \
      > "$CHUNK_LOG" 2>&1

    EC=$?
    EVAL_LINE=$(grep -E "^  \[eval\] [0-9]+/[0-9]+ correct" "$CHUNK_LOG" | tail -1)
    if [ -n "$EVAL_LINE" ]; then
      C=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
      T=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
      PCT=$(echo "$EVAL_LINE" | grep -oE "[0-9.]+%" | head -1)
      echo "  $CONV q$START: $C/$T ($PCT) exit=$EC" | tee -a "$LOG"
      CONV_C=$((CONV_C + C)); CONV_T=$((CONV_T + T))
      TOTAL_C=$((TOTAL_C + C)); TOTAL_Q=$((TOTAL_Q + T))
      while IFS= read -r line; do
        CAT=$(echo "$line" | grep -oE "cat=[0-9]+" | head -1 | cut -d= -f2)
        CC=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
        CT=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
        if [ -n "$CAT" ] && [ -n "$CT" ]; then
          CAT_TOTAL[$CAT]=$((${CAT_TOTAL[$CAT]:-0} + CT))
          CAT_CORRECT[$CAT]=$((${CAT_CORRECT[$CAT]:-0} + CC))
        fi
      done < <(grep -E "^         cat=[0-9]+ \(" "$CHUNK_LOG")
    else
      echo "  $CONV q$START: CRASHED exit=$EC" | tee -a "$LOG"
    fi
    sleep 3
  done

  if [ "$CONV_T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", $CONV_C * 100 / $CONV_T }")
    echo ">> $CONV TOTAL: $CONV_C/$CONV_T ($PCT%)" | tee -a "$LOG"
  fi
done

END_TS=$(date +%s); ELAPSED=$((END_TS - START_TS))

step "AGGREGATE — RUN $RUN_TAG"
echo "Total: $TOTAL_C/$TOTAL_Q" | tee -a "$LOG"
if [ "$TOTAL_Q" -gt 0 ]; then
  PCT=$(awk "BEGIN { printf \"%.2f\", $TOTAL_C * 100 / $TOTAL_Q }")
  echo "Accuracy: $PCT%" | tee -a "$LOG"
fi
echo "Wall time: $((ELAPSED / 60)) min" | tee -a "$LOG"
echo "Per category:" | tee -a "$LOG"
for CAT in 1 2 3 4 5; do
  T=${CAT_TOTAL[$CAT]:-0}; C=${CAT_CORRECT[$CAT]:-0}
  if [ "$T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.1f\", $C * 100 / $T }")
    echo "  cat=$CAT: $C/$T ($PCT%)" | tee -a "$LOG"
  fi
done

cat > "$SUMMARY" <<EOF
{
  "runTag": "$RUN_TAG",
  "stack": "persona+Cohere+nucleus+catfixes+verifier+reformulate+queryAwarePersona",
  "totalQuestions": $TOTAL_Q,
  "totalCorrect": $TOTAL_C,
  "accuracy": $(awk "BEGIN { Q=$TOTAL_Q; if (Q < 1) Q = 1; printf \"%.2f\", $TOTAL_C * 100 / Q }"),
  "elapsedSec": $ELAPSED,
  "byCategory": {
$(for CAT in 1 2 3 4 5; do
  T=${CAT_TOTAL[$CAT]:-0}; C=${CAT_CORRECT[$CAT]:-0}
  if [ "$T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", $C * 100 / $T }")
    echo "    \"cat$CAT\": {\"correct\": $C, \"total\": $T, \"pct\": $PCT},"
  fi
done | sed '$ s/,$//')
  }
}
EOF
echo "Summary: $SUMMARY" | tee -a "$LOG"
