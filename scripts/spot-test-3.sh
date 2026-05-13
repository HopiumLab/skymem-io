#!/usr/bin/env bash
# spot-test-3.sh — multi-conv spot-test runner (LOCKED PROTOCOL after T5).
#
# Runs the same bench code over 3 specified conversations in sequence and
# emits a PASS/FAIL verdict against per-cat target gates. Replaces the
# old "single-conv spot-test then kick full bench" pattern that fooled us
# in T4f (conv-49 spot 68.88% → bench 63.78%) and T5 (conv-42 cat=2 spot
# +7-12pp → bench -0.93).
#
# Usage:
#   bash scripts/spot-test-3.sh \
#     --convs=conv-42,conv-43,conv-44 \
#     --target-cat=2 \
#     --target-min=65 \
#     [--tag=t6-cat4-profile-spot]
#
# Output:
#   - 3 per-conv chunk logs at /app/bench/<tag>-<conv>-q<N>.log
#   - 3 per-conv summary lines
#   - 1 aggregate PASS/FAIL verdict
#   - PASS criteria: target-cat ≥ target-min on ALL THREE convs
#
# The bench-locomo.js arguments mirror run-t3-fullstack.sh so spot results
# are directly comparable to full-bench expectations. Pre-fix variant is
# whichever code is currently on disk — this runner doesn't toggle features.

set -u

CONVS=""
TARGET_CAT=""
TARGET_MIN=""
TAG=""

for arg in "$@"; do
  case "$arg" in
    --convs=*)        CONVS="${arg#--convs=}" ;;
    --target-cat=*)   TARGET_CAT="${arg#--target-cat=}" ;;
    --target-min=*)   TARGET_MIN="${arg#--target-min=}" ;;
    --tag=*)          TAG="${arg#--tag=}" ;;
    --help|-h)
      sed -n 's/^# //p' "$0" | head -25
      exit 0
      ;;
  esac
done

if [ -z "$CONVS" ] || [ -z "$TARGET_CAT" ] || [ -z "$TARGET_MIN" ]; then
  echo "ERROR: --convs, --target-cat, --target-min are all required"
  echo "Run with --help for usage."
  exit 1
fi

[ -z "$TAG" ] && TAG="spot3-$(date +%Y%m%d-%H%M%S)"

# Conv totals from LOCOMO dataset — used for chunk sizing
declare -A CONV_TOTALS=(
  [conv-26]=199 [conv-30]=105 [conv-41]=193 [conv-42]=260 [conv-43]=242
  [conv-44]=158 [conv-47]=190 [conv-48]=239 [conv-49]=196 [conv-50]=204
)

CHUNK_SIZE=30
BENCH_HEAP=3000

LOG="/app/bench/${TAG}-master.log"

echo "============================================================" | tee "$LOG"
echo "  spot-test-3 — multi-conv validation gate" | tee -a "$LOG"
echo "============================================================" | tee -a "$LOG"
echo "  Convs:       $CONVS" | tee -a "$LOG"
echo "  Target cat:  $TARGET_CAT" | tee -a "$LOG"
echo "  Target min:  $TARGET_MIN%" | tee -a "$LOG"
echo "  Tag:         $TAG" | tee -a "$LOG"
echo "  Start:       $(date -u +%H:%M:%S)" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# DB pool tuning (same as run-t3-fullstack.sh)
export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"
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

# Per-conv results table
declare -A CONV_OVERALL_CORRECT CONV_OVERALL_TOTAL
declare -A CONV_TARGET_CORRECT CONV_TARGET_TOTAL
declare -A CONV_CAT_DETAIL

IFS=',' read -ra CONV_ARRAY <<< "$CONVS"
START_TS=$(date +%s)

for CONV in "${CONV_ARRAY[@]}"; do
  TOTAL_Q="${CONV_TOTALS[$CONV]:-}"
  if [ -z "$TOTAL_Q" ]; then
    echo "WARN: unknown conv $CONV, skipping" | tee -a "$LOG"
    continue
  fi

  echo "──────────────────────────────────────────────────────────" | tee -a "$LOG"
  echo "  $CONV ($TOTAL_Q questions)  $(date -u +%H:%M:%S)" | tee -a "$LOG"
  echo "──────────────────────────────────────────────────────────" | tee -a "$LOG"

  CONV_C=0
  CONV_T=0
  declare -A LOCAL_CAT_C LOCAL_CAT_T
  for c in 1 2 3 4 5; do LOCAL_CAT_C[$c]=0; LOCAL_CAT_T[$c]=0; done

  for ((S=0; S<TOTAL_Q; S+=CHUNK_SIZE)); do
    CLOG="/app/bench/${TAG}-${CONV}-q${S}.log"
    echo "  -- q${S} start $(date -u +%H:%M:%S) --" | tee -a "$LOG"

    SKY_EMBED_PROVIDER=cohere node --max-old-space-size="${BENCH_HEAP}" --expose-gc \
      /app/scripts/bench-locomo.js \
      --conv-id="$CONV" \
      --persona=on \
      --nucleus=cat3only \
      --verifier=on \
      --reformulate=on \
      --skip-ingest \
      --start-question="$S" \
      --questions-per="$CHUNK_SIZE" \
      > "$CLOG" 2>&1
    EC=$?

    EVAL=$(grep -E "^  \[eval\] [0-9]+/[0-9]+ correct" "$CLOG" | tail -1)
    if [ -n "$EVAL" ]; then
      C=$(echo "$EVAL" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
      T=$(echo "$EVAL" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
      PCT=$(echo "$EVAL" | grep -oE "[0-9.]+%" | head -1)
      echo "     ${CONV} q${S}: $C/$T (${PCT}) exit=$EC" | tee -a "$LOG"
      CONV_C=$((CONV_C + C))
      CONV_T=$((CONV_T + T))

      while IFS= read -r line; do
        CAT=$(echo "$line" | grep -oE "cat=[0-9]+" | head -1 | cut -d= -f2)
        CC=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f1)
        CT=$(echo "$line" | grep -oE "[0-9]+/[0-9]+" | head -1 | cut -d/ -f2)
        if [ -n "$CAT" ] && [ -n "$CT" ]; then
          LOCAL_CAT_C[$CAT]=$((${LOCAL_CAT_C[$CAT]:-0} + CC))
          LOCAL_CAT_T[$CAT]=$((${LOCAL_CAT_T[$CAT]:-0} + CT))
        fi
      done < <(grep -E "^         cat=[0-9]+ \(" "$CLOG")
    else
      echo "     ${CONV} q${S}: CRASHED exit=$EC" | tee -a "$LOG"
    fi
    sleep 3
  done

  # Per-conv summary
  CONV_OVERALL_CORRECT[$CONV]=$CONV_C
  CONV_OVERALL_TOTAL[$CONV]=$CONV_T
  CONV_TARGET_CORRECT[$CONV]="${LOCAL_CAT_C[$TARGET_CAT]:-0}"
  CONV_TARGET_TOTAL[$CONV]="${LOCAL_CAT_T[$TARGET_CAT]:-0}"

  CAT_DETAIL=""
  for c in 1 2 3 4 5; do
    if [ "${LOCAL_CAT_T[$c]:-0}" -gt 0 ]; then
      P=$(awk "BEGIN { printf \"%.1f\", ${LOCAL_CAT_C[$c]} * 100 / ${LOCAL_CAT_T[$c]} }")
      CAT_DETAIL="${CAT_DETAIL} cat=$c:${LOCAL_CAT_C[$c]}/${LOCAL_CAT_T[$c]}(${P}%)"
    fi
  done
  CONV_CAT_DETAIL[$CONV]="$CAT_DETAIL"

  if [ "$CONV_T" -gt 0 ]; then
    P=$(awk "BEGIN { printf \"%.2f\", $CONV_C * 100 / $CONV_T }")
    echo "  >> ${CONV} TOTAL: $CONV_C/$CONV_T (${P}%)${CAT_DETAIL}" | tee -a "$LOG"
  fi
  echo "" | tee -a "$LOG"
done

END_TS=$(date +%s); ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────
# Verdict
# ──────────────────────────────────────────────────────────
echo "============================================================" | tee -a "$LOG"
echo "  VERDICT — cat=$TARGET_CAT must be ≥ $TARGET_MIN% on ALL convs" | tee -a "$LOG"
echo "============================================================" | tee -a "$LOG"

PASS_COUNT=0
FAIL_DETAIL=""
for CONV in "${CONV_ARRAY[@]}"; do
  TC="${CONV_TARGET_CORRECT[$CONV]:-0}"
  TT="${CONV_TARGET_TOTAL[$CONV]:-0}"
  if [ "$TT" -eq 0 ]; then
    echo "  $CONV cat=$TARGET_CAT: 0/0 — NO DATA (treating as FAIL)" | tee -a "$LOG"
    FAIL_DETAIL="${FAIL_DETAIL} $CONV(no-data)"
    continue
  fi
  PCT=$(awk "BEGIN { printf \"%.2f\", $TC * 100 / $TT }")
  STATUS=$(awk "BEGIN { print ($PCT >= $TARGET_MIN) ? \"PASS\" : \"FAIL\" }")
  echo "  $CONV cat=$TARGET_CAT: $TC/$TT (${PCT}%) — $STATUS" | tee -a "$LOG"
  if [ "$STATUS" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_DETAIL="${FAIL_DETAIL} $CONV(${PCT}%)"
  fi
done

echo "" | tee -a "$LOG"
N_CONVS=${#CONV_ARRAY[@]}
echo "  $PASS_COUNT/$N_CONVS passed (need all $N_CONVS to PASS)" | tee -a "$LOG"
echo "  Wall: $((ELAPSED / 60))m $((ELAPSED % 60))s" | tee -a "$LOG"

if [ "$PASS_COUNT" -eq "$N_CONVS" ]; then
  echo "" | tee -a "$LOG"
  echo "  ✓ VERDICT: PASS — safe to kick full bench" | tee -a "$LOG"
  exit 0
else
  echo "" | tee -a "$LOG"
  echo "  ✗ VERDICT: FAIL — DO NOT kick full bench" | tee -a "$LOG"
  echo "    Failed convs:${FAIL_DETAIL}" | tee -a "$LOG"
  echo "    Either: tune the mechanism, target different convs, or step back." | tee -a "$LOG"
  exit 1
fi
