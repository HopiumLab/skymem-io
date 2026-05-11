#!/usr/bin/env bash
# T6 — Ablation runner.
#
# Pulls one layer out at a time, runs the LOCOMO bench on a single conv,
# and emits per-variant summary JSON. Compared against the T3 fullstack
# baseline, this tells us EXACTLY how many points each layer contributes.
#
# Pre-T6, every "layer X earns N pp" claim in pitch/site was an estimate.
# After T6 the numbers are reproducible from this script.
#
# Strategy:
#   1. Use ONE representative conversation (default conv-43, 242 questions,
#      good mix of categories) so each variant runs in 30-45 min instead
#      of 3 hours
#   2. Run the same conv 6 times: baseline + 5 ablations
#   3. Each run writes its own summary JSON tagged with the variant name
#   4. A summary-of-summaries script aggregates the deltas
#
# Pattern matches scripts/run-t3-fullstack.sh — same chunk size, heap,
# DB rewrite, env setup. Differs only in the flag combinations.
#
# Usage: docker exec -d sky-bridge bash /app/scripts/run-ablation.sh [conv-id]
#
# Default conv-id: conv-43. Override on the command line:
#   bash scripts/run-ablation.sh conv-50

set -u

CONV_ID="${1:-conv-43}"
RUN_TAG="abl-$(date +%Y%m%d-%H%M%S)"
LOG="/app/bench/${RUN_TAG}-master.log"
SUMMARY_DIR="/app/bench/${RUN_TAG}"
mkdir -p "$SUMMARY_DIR"

echo "ABLATION RUN: $RUN_TAG  start: $(date -u +%H:%M:%S)" | tee "$LOG"
echo "Target conv: $CONV_ID" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# DB rewrite + connection pool (same as T3 fullstack)
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

CHUNK_SIZE=30
BENCH_HEAP=3000

# Each variant: (label, embed_provider, flags...)
# Order: baseline first, then progressively-disabled variants.
# The labels become summary-JSON keys.
declare -a VARIANTS=(
  "baseline|cohere|--persona=on  --nucleus=on  --verifier=on  --reformulate=on"
  "no-persona|cohere|--persona=off --nucleus=on  --verifier=on  --reformulate=on"
  "no-nucleus|cohere|--persona=on  --nucleus=off --verifier=on  --reformulate=on"
  "no-verifier|cohere|--persona=on  --nucleus=on  --verifier=off --reformulate=on"
  "no-reformulate|cohere|--persona=on  --nucleus=on  --verifier=on  --reformulate=off"
  "minilm-instead-of-cohere|local|--persona=on  --nucleus=on  --verifier=on  --reformulate=on"
)

run_variant() {
  local label="$1"
  local provider="$2"
  local flags="$3"
  local vlog="/app/bench/${RUN_TAG}-${label}.log"
  local vsummary="/app/bench/${RUN_TAG}-${label}-summary.json"

  echo "" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"
  echo "VARIANT: ${label}  provider=${provider}  flags=${flags}" | tee -a "$LOG"
  echo "  log:     ${vlog}" | tee -a "$LOG"
  echo "  summary: ${vsummary}" | tee -a "$LOG"
  echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG"

  export SKY_EMBED_PROVIDER="${provider}"
  # Each variant: chunk through the entire conv
  # Look up the total question count for this conv from a known map
  local TOTAL
  case "$CONV_ID" in
    conv-26) TOTAL=199 ;;
    conv-30) TOTAL=105 ;;
    conv-41) TOTAL=193 ;;
    conv-42) TOTAL=260 ;;
    conv-43) TOTAL=242 ;;
    conv-44) TOTAL=158 ;;
    conv-47) TOTAL=190 ;;
    conv-48) TOTAL=239 ;;
    conv-49) TOTAL=196 ;;
    conv-50) TOTAL=204 ;;
    *) TOTAL=200 ;;
  esac

  local q=0
  local variant_total=0
  local variant_correct=0
  while [ "$q" -lt "$TOTAL" ]; do
    local qend=$((q + CHUNK_SIZE))
    [ "$qend" -gt "$TOTAL" ] && qend=$TOTAL
    local clog="/app/bench/${RUN_TAG}-${label}-q${q}.log"
    echo "── ${label} ${CONV_ID} q${q}-${qend} start $(date -u +%H:%M:%S) ──" | tee -a "$LOG"
    if SKY_EMBED_PROVIDER="${provider}" node --max-old-space-size="${BENCH_HEAP}" --expose-gc \
      /app/scripts/bench-locomo.js \
      --conv-id="${CONV_ID}" \
      ${flags} \
      --skip-ingest \
      --start-question="${q}" \
      --questions-per="$((qend - q))" \
      > "$clog" 2>&1; then
      # Pull final tallies from the chunk log.
      #
      # FIX (Bug L, 2026-05-11): bench-locomo.js formats the AGGREGATE block as
      # "Total: <correct>/<total> correct (<pct>%)" — NOT as the original
      # "Total questions: N" / "Correct: N" patterns this script used to assume.
      # The mismatch silently wrote 0/0 for every variant in run abl-20260511-021039
      # and meant the wrapper aggregator produced an all-zeros ABLATION-TABLE.json.
      # The chunk logs themselves were always correct; the wrapper just couldn't
      # read them.
      local ck_total ck_correct ck_line
      ck_line=$(grep -E '^Total: [0-9]+/[0-9]+ correct' "$clog" | tail -1)
      if [ -n "$ck_line" ]; then
        # Strip the prefix and the trailing " correct" to get "N/M"
        ck_correct=$(echo "$ck_line" | sed -E 's|^Total: ([0-9]+)/[0-9]+ correct.*|\1|')
        ck_total=$(echo "$ck_line"   | sed -E 's|^Total: [0-9]+/([0-9]+) correct.*|\1|')
      fi
      variant_total=$((variant_total + ${ck_total:-0}))
      variant_correct=$((variant_correct + ${ck_correct:-0}))
      echo "  ${label} q${q}: ${ck_correct:-?}/${ck_total:-?} exit=0" | tee -a "$LOG"
    else
      echo "  ${label} q${q}: CRASHED exit=$?" | tee -a "$LOG"
    fi
    q="$qend"
  done

  # Variant summary JSON
  local pct
  if [ "$variant_total" -gt 0 ]; then
    pct=$(awk "BEGIN { printf \"%.2f\", ($variant_correct / $variant_total) * 100 }")
  else
    pct="0.00"
  fi
  cat > "$vsummary" <<EOF
{
  "runTag": "${RUN_TAG}",
  "variant": "${label}",
  "provider": "${provider}",
  "flags": "${flags}",
  "convId": "${CONV_ID}",
  "totalQuestions": ${variant_total},
  "totalCorrect": ${variant_correct},
  "accuracy": ${pct}
}
EOF
  echo "  ✓ ${label}: ${variant_correct}/${variant_total} = ${pct}%" | tee -a "$LOG"
}

echo "Ablation conv=${CONV_ID}  variants=${#VARIANTS[@]}  chunk=${CHUNK_SIZE}  heap=${BENCH_HEAP}MB" | tee -a "$LOG"

for variant in "${VARIANTS[@]}"; do
  IFS='|' read -r label provider flags <<< "$variant"
  run_variant "$label" "$provider" "$flags"
done

# Aggregate summary — read every variant JSON and emit a single ABLATION-TABLE.json
node -e "
const { readdirSync, readFileSync, writeFileSync } = require('fs');
const tag = '${RUN_TAG}';
const variants = readdirSync('/app/bench')
  .filter(f => f.startsWith(tag + '-') && f.endsWith('-summary.json'))
  .map(f => JSON.parse(readFileSync('/app/bench/' + f, 'utf8')));
const baseline = variants.find(v => v.variant === 'baseline');
const baseAcc = baseline ? baseline.accuracy : 0;
const rows = variants.map(v => ({
  variant: v.variant,
  accuracy: v.accuracy,
  delta_pp: parseFloat((v.accuracy - baseAcc).toFixed(2)),
  total: v.totalQuestions,
  correct: v.totalCorrect,
}));
rows.sort((a, b) => (a.variant === 'baseline' ? -1 : b.variant === 'baseline' ? 1 : a.delta_pp - b.delta_pp));
const out = {
  runTag: tag,
  convId: '${CONV_ID}',
  variants: rows,
};
writeFileSync('/app/bench/' + tag + '-ABLATION-TABLE.json', JSON.stringify(out, null, 2));
console.log('Wrote ABLATION-TABLE.json');
console.log(JSON.stringify(rows, null, 2));
" 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "ABLATION COMPLETE: ${RUN_TAG}  end: $(date -u +%H:%M:%S)" | tee -a "$LOG"
echo "Summary table: /app/bench/${RUN_TAG}-ABLATION-TABLE.json" | tee -a "$LOG"
