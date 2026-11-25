#!/usr/bin/env bash
set -euo pipefail

# Raiz do repo = pasta deste script (funciona na estação ~/lab/troca-ideIA
# e no deploy ~/troca-ideia sem depender de caminho fixo).
pod="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"


while true; do
  ROOM_URL=http://127.0.0.1:7676 \
  POKE_RUN_TIMEOUT_MIN=${POKE_RUN_TIMEOUT_MIN:-15} \
  "$pod/cmd/poke/bin/poke" -config "$pod/agents.json" >> "$pod/poke-orchestrator.log" 2>&1
  echo "restart poke ($?)" >> "$pod/poke-orchestrator.log"
  sleep 5
done
