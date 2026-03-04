#!/usr/bin/env bash
# Auto-generated runner script for coordinator agent
# Project: Clawbot-marketplace
set -euo pipefail
cd "$(dirname "$0")/.."

unset CLAUDECODE

# Register agent in coordination registry
COORD_DIR=".claude/coordination"
REGISTRY="${COORD_DIR}/registry.json"
mkdir -p "${COORD_DIR}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

if command -v python3 &>/dev/null; then
  python3 -c "
import json, os, sys
reg_path = '${REGISTRY}'
try:
    with open(reg_path) as f: reg = json.load(f)
except: reg = {'agents': []}
if not isinstance(reg.get('agents'), list): reg['agents'] = []
agents = [a for a in reg['agents'] if a.get('name') != 'coordinator']
agents.append({'name': 'coordinator', 'role': 'coordinator', 'status': 'working', 'current_task': '', 'session_start': '${NOW}', 'last_heartbeat': '${NOW}'})
reg['agents'] = agents
with open(reg_path, 'w') as f: json.dump(reg, f, indent=2)
" 2>/dev/null || true
fi

SYSTEM_PROMPT="$(cat .claude/agents/coordinator.md)"

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the coordinator agent. Read .claude/coordination/TASKS.md and begin working on your assigned tasks. Update task status as you progress."
