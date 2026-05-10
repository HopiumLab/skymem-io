#!/usr/bin/env bash
# Watcher: wait for B2 chunked-fullstack to finish, then auto-kick T3.
# Fully autonomous overnight pipeline — the user can come home to both
# headlines #2 (Tier 1) and #3 (Tier 1+2+3) landed.
#
# Usage:
#   docker exec -d sky-bridge bash /app/scripts/wait-for-b2-then-t3.sh

set -u
LOG="/app/bench/wait-then-t3.log"
echo "Watcher start: $(date -u +%H:%M:%S)" | tee "$LOG"
export DATABASE_URL="$(echo "$DATABASE_URL" | sed -e 's|@localhost:|@host.docker.internal:|g')"

# Wait for any B2 chunked-fullstack process to finish
while pgrep -f "run-b2-chunked-fullstack" > /dev/null 2>&1 || pgrep -f "bench-locomo.js.*--persona=on --nucleus=on" > /dev/null 2>&1; do
  sleep 120
  echo "  B2 still running at $(date -u +%H:%M:%S)" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "B2 done at $(date -u +%H:%M:%S). Pause 30s, then kick T3." | tee -a "$LOG"
sleep 30

echo "" | tee -a "$LOG"
echo "Kicking T3 full-stack at $(date -u +%H:%M:%S)" | tee -a "$LOG"
bash /app/scripts/run-t3-fullstack.sh 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "T3 done at $(date -u +%H:%M:%S)" | tee -a "$LOG"
