#!/usr/bin/env bash
# Auto-relay runner script for coder agent — task TASK-HARD-003
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
agents = [a for a in reg['agents'] if a.get('name') != 'coder']
agents.append({'name': 'coder', 'role': 'coder', 'status': 'working', 'current_task': 'TASK-HARD-003', 'session_start': '${NOW}', 'last_heartbeat': '${NOW}'})
reg['agents'] = agents
with open(reg_path, 'w') as f: json.dump(reg, f, indent=2)
" 2>/dev/null || true
fi

SYSTEM_PROMPT="$(cat .claude/agents/coder.md)"

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "Work on task TASK-HARD-003: Add PostgreSQL persistence layer. Read .claude/coordination/TASKS.md for details. Update task status as you progress."
