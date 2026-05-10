#!/usr/bin/env bash
# Chunked conv-50 follow-up. Conv-50's full-process attempt OOM'd at 204q.
# This script waits for the v2 orchestrator to land conv-43 + conv-48 chunks,
# then runs conv-50 chunked while the orchestrator is in B1 (Cohere migration,
# low memory).
#
# Usage: docker exec sky-bridge bash /app/scripts/run-conv50-chunked-followup.sh

set -u
LOG="/app/bench/conv50-followup.log"
echo "Conv-50 chunked follow-up start: $(date -u +%H:%M:%S)" | tee "$LOG"
export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

# Wait for any conv-43 / conv-48 child to complete
while pgrep -f "bench-locomo.js.*conv-(43|48)" > /dev/null 2>&1; do
  sleep 60
  echo "  waiting for conv-43/48 chunks at $(date -u +%H:%M:%S)" | tee -a "$LOG"
done
echo "  conv-43 + conv-48 chunks done." | tee -a "$LOG"

# Run conv-50 chunked. 568 nodes already ingested, 0 persona facts → the
# first chunk's pre-step will extract persona (~3 min), subsequent chunks
# skip extraction. Total: ~30 min.
echo "" | tee -a "$LOG"
echo "── conv-50 chunked (3 × 70 q) ──" | tee -a "$LOG"
PERSONA_FLAG=on bash /app/scripts/run-locomo-chunked.sh conv-50 204 70 conv50-followup 2>&1 | tee -a "$LOG"
echo "Done: $(date -u +%H:%M:%S)" | tee -a "$LOG"
