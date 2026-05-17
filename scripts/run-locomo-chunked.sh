#!/usr/bin/env bash
# Chunked LOCOMO runner — for the big convs (240+ questions) that OOM
# even with 16GB container cap. Splits one conv across 3 processes
# using --start-question + --questions-per. Each chunk gets a fresh
# native allocator (the thing V8 GC can't reach).
#
# Usage:
#   docker exec skymem bash /app/scripts/run-locomo-chunked.sh <conv-id> <total-q> [chunk-size] [run-tag]
#
# Example:
#   bash run-locomo-chunked.sh conv-43 242 80 chunk-43
#   → 3 processes: q0-79, q80-159, q160-241
#
# Aggregates each chunk's [eval] line into a combined accuracy number.

set -u
CONV="${1:?conv-id required}"
TOTAL="${2:?total-q required}"
CHUNK="${3:-80}"
RUN_TAG="${4:-chunked-${CONV}}"
PERSONA_FLAG="${PERSONA_FLAG:-on}"
NUCLEUS_FLAG="${NUCLEUS_FLAG:-off}"
HEAP_MB="${HEAP_MB:-2560}"

LOG="/app/bench/chunked-${RUN_TAG}.log"
echo "Chunked run: $CONV total=$TOTAL chunk-size=$CHUNK persona=$PERSONA_FLAG" | tee "$LOG"

export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

START=0
TOTAL_C=0
TOTAL_Q=0
declare -A CAT_TOTAL
declare -A CAT_CORRECT

while [ "$START" -lt "$TOTAL" ]; do
  CHUNK_LOG="/app/bench/chunked-${RUN_TAG}-q${START}.log"
  echo "" | tee -a "$LOG"
  echo "── chunk q$START start $(date -u +%H:%M:%S) ──" | tee -a "$LOG"
  node --max-old-space-size="${HEAP_MB}" --expose-gc \
    /app/scripts/bench-locomo.js \
    --conv-id="$CONV" \
    --persona="$PERSONA_FLAG" \
    --nucleus="$NUCLEUS_FLAG" \
    --start-question="$START" \
    --questions-per="$CHUNK" \
    > "$CHUNK_LOG" 2>&1
  EC=$?
  EVAL_LINE=$(grep -E "^  \[eval\] [0-9]+/[0-9]+ correct" "$CHUNK_LOG" | tail -1)
  if [ -n "$EVAL_LINE" ]; then
    C=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
    T=$(echo "$EVAL_LINE" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
    PCT=$(echo "$EVAL_LINE" | grep -oE "[0-9.]+%" | head -1)
    echo "  chunk q$START: $C/$T ($PCT) exit=$EC" | tee -a "$LOG"
    TOTAL_C=$((TOTAL_C + C))
    TOTAL_Q=$((TOTAL_Q + T))

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
    echo "  chunk q$START: CRASHED exit=$EC" | tee -a "$LOG"
  fi
  START=$((START + CHUNK))
  sleep 3
done

echo "" | tee -a "$LOG"
echo "==== AGGREGATE for $CONV ====" | tee -a "$LOG"
echo "Total: $TOTAL_C/$TOTAL_Q" | tee -a "$LOG"
if [ "$TOTAL_Q" -gt 0 ]; then
  PCT=$(awk "BEGIN { printf \"%.2f\", $TOTAL_C * 100 / $TOTAL_Q }")
  echo "Accuracy: $PCT%" | tee -a "$LOG"
fi
echo "Per category:" | tee -a "$LOG"
for CAT in 1 2 3 4 5; do
  T=${CAT_TOTAL[$CAT]:-0}
  C=${CAT_CORRECT[$CAT]:-0}
  if [ "$T" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.1f\", $C * 100 / $T }")
    echo "  cat=$CAT: $C/$T ($PCT%)" | tee -a "$LOG"
  fi
done
