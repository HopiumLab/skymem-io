#!/usr/bin/env bash
# Sequential LOCOMO runner — one conv per process so memory fully releases
# between samples. Workaround for Docker 6GB cap OOM-killing the
# --samples=10 invocation.
#
# Usage:
#   docker exec skymem bash /app/scripts/run-locomo-sequential.sh [run-tag]
#
# Writes per-conv result JSON to /app/bench/results-locomo-*.json (already
# done by bench-locomo.js) plus a per-run log at
# /app/bench/seq-<run-tag>.log and an aggregate JSON.
#
# Persona ON by default; flip with PERSONA_FLAG=off env var.
# Nucleus expansion off by default; flip with NUCLEUS_FLAG=on.

set -u
RUN_TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
PERSONA_FLAG="${PERSONA_FLAG:-on}"
NUCLEUS_FLAG="${NUCLEUS_FLAG:-off}"
HEAP_MB="${HEAP_MB:-2560}"

LOG="/app/bench/seq-${RUN_TAG}.log"
SUMMARY="/app/bench/seq-${RUN_TAG}-summary.json"
echo "Run tag: $RUN_TAG" | tee "$LOG"
echo "Persona: $PERSONA_FLAG  Nucleus: $NUCLEUS_FLAG  Heap: ${HEAP_MB}MB" | tee -a "$LOG"

# Ensure DATABASE_URL points at host.docker.internal (mysql is on the host)
export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

# Conv IDs from locomo10.json (10 conversations)
CONVS=(conv-26 conv-30 conv-41 conv-42 conv-43 conv-44 conv-47 conv-48 conv-49 conv-50)

START_TS=$(date +%s)
TOTAL_Q=0
TOTAL_C=0
declare -A CAT_TOTAL
declare -A CAT_CORRECT

for CONV in "${CONVS[@]}"; do
  echo "" | tee -a "$LOG"
  echo "================================================================" | tee -a "$LOG"
  echo "STARTING $CONV at $(date -u +%H:%M:%S)" | tee -a "$LOG"
  echo "================================================================" | tee -a "$LOG"
  CONV_LOG="/app/bench/seq-${RUN_TAG}-${CONV}.log"
  node --max-old-space-size="${HEAP_MB}" --expose-gc \
    /app/scripts/bench-locomo.js \
    --conv-id="$CONV" \
    --persona="$PERSONA_FLAG" \
    --nucleus="$NUCLEUS_FLAG" \
    > "$CONV_LOG" 2>&1
  EC=$?
  echo "$CONV exit=$EC" | tee -a "$LOG"

  # Parse the [eval] line: "  [eval] X/Y correct (Z%)"
  EVAL_LINE=$(grep -E "^  \[eval\] [0-9]+/[0-9]+ correct" "$CONV_LOG" | tail -1)
  if [ -n "$EVAL_LINE" ]; then
    CONV_C=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
    CONV_T=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
    CONV_PCT=$(echo "$EVAL_LINE" | grep -oE "[0-9.]+%" | head -1)
    echo "  $CONV: $CONV_C/$CONV_T correct ($CONV_PCT)" | tee -a "$LOG"
    TOTAL_Q=$((TOTAL_Q + CONV_T))
    TOTAL_C=$((TOTAL_C + CONV_C))

    # Per-cat breakdown
    while IFS= read -r line; do
      CAT=$(echo "$line" | grep -oE "cat=[0-9]+" | head -1 | cut -d= -f2)
      C=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
      T=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
      if [ -n "$CAT" ] && [ -n "$T" ]; then
        CAT_TOTAL[$CAT]=$((${CAT_TOTAL[$CAT]:-0} + T))
        CAT_CORRECT[$CAT]=$((${CAT_CORRECT[$CAT]:-0} + C))
      fi
    done < <(grep -E "^         cat=[0-9]+ \(" "$CONV_LOG")
  else
    echo "  $CONV: no eval line found in log — likely crashed" | tee -a "$LOG"
  fi

  # Force a brief pause so the OS reclaims memory before the next process
  sleep 5
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo "" | tee -a "$LOG"
echo "================================================================" | tee -a "$LOG"
echo "AGGREGATE — RUN $RUN_TAG" | tee -a "$LOG"
echo "================================================================" | tee -a "$LOG"
echo "Total: $TOTAL_C/$TOTAL_Q" | tee -a "$LOG"
if [ "$TOTAL_Q" -gt 0 ]; then
  PCT=$(awk "BEGIN { printf \"%.2f\", $TOTAL_C * 100 / $TOTAL_Q }")
  echo "Accuracy: $PCT%" | tee -a "$LOG"
fi
echo "Wall time: $((ELAPSED / 60)) min ($ELAPSED s)" | tee -a "$LOG"
echo "Per category:" | tee -a "$LOG"
for CAT in 1 2 3 4 5; do
  T=${CAT_TOTAL[$CAT]:-0}
  C=${CAT_CORRECT[$CAT]:-0}
  if [ "$T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.1f\", $C * 100 / $T }")
    echo "  cat=$CAT: $C/$T ($PCT%)" | tee -a "$LOG"
  fi
done

# Emit a JSON summary for downstream processing
cat > "$SUMMARY" <<EOF
{
  "runTag": "$RUN_TAG",
  "personaFlag": "$PERSONA_FLAG",
  "nucleusFlag": "$NUCLEUS_FLAG",
  "totalQuestions": $TOTAL_Q,
  "totalCorrect": $TOTAL_C,
  "accuracy": $(awk "BEGIN { Q=$TOTAL_Q; if (Q < 1) Q = 1; printf \"%.2f\", $TOTAL_C * 100 / Q }"),
  "elapsedSec": $ELAPSED,
  "byCategory": {
$(for CAT in 1 2 3 4 5; do
  T=${CAT_TOTAL[$CAT]:-0}
  C=${CAT_CORRECT[$CAT]:-0}
  if [ "$T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", $C * 100 / $T }")
    echo "    \"cat$CAT\": {\"correct\": $C, \"total\": $T, \"pct\": $PCT},"
  fi
done | sed '$ s/,$//')
  }
}
EOF
echo "Summary written: $SUMMARY" | tee -a "$LOG"
