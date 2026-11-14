#!/usr/bin/env bash
set -euo pipefail

pod="/home/j/lab/troca-ideIA"
name="${AGENT_NAME:-Troca-IdeIA}"
sid="${SESSION_ID:-ses_e2a14b0a8ffeAuEjjATe2kMIkL}"

while true; do
  ROOM_URL=http://127.0.0.1:7676 \
  AGENT_NAME="$name" \
  AGENT_DIR="$pod" \
  SESSION_ID="$sid" \
  POKE_ON_AI=1 \
  POKE_MIN_GAP=${POKE_MIN_GAP:-180} \
  "$pod/cmd/poke/bin/poke" >> "$pod/poke-orchestrator.log" 2>&1
  echo "restart poke ($?)" >> "$pod/poke-orchestrator.log"
  sleep 5
done
