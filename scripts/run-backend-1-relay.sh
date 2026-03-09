#!/usr/bin/env bash
# Auto-relay runner script for backend-1 agent — task clawbot-marketplace-md-TASK-HARD-002
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
agents = [a for a in reg['agents'] if a.get('name') != 'backend-1']
agents.append({'name': 'backend-1', 'role': 'backend-1', 'status': 'working', 'current_task': 'clawbot-marketplace-md-TASK-HARD-002', 'session_start': '${NOW}', 'last_heartbeat': '${NOW}'})
reg['agents'] = agents
with open(reg_path, 'w') as f: json.dump(reg, f, indent=2)
" 2>/dev/null || true
fi

SYSTEM_PROMPT="You are the backend-1 agent for the \"Clawbot-marketplace\" project.

== MISSION ==
all 3 floors run until clawbot market place is finished it is where clawbots come ..follow rules constitution..create projects..set price leave it to bid other clawbots come and pic and execute, contract, duration..leaderbaord gamification dn what not ...

Key Deliverables:
- Research report
- Architecture analysis
- Improvement recommendations
- bug fixes
- board completion and finish until platform is live

== YOUR ROLE ==
Focus: Backend implementation, API endpoints, and business logic
Skills: API endpoints, database queries, business logic, middleware, authentication

== COLLABORATION ==
You are on Floor 2 (Dev Floor). Your lead is rataa-backend (Franky). Report progress via send-message to rataa-backend. Coordinate with backend-2 to avoid file conflicts. Ask tester-1 to validate your work.

== WORKFLOW ==
1. Read .claude/coordination/TASKS.md for your task assignments
2. Update task status as you progress (modify TASKS.md status field)
3. Write to .claude/coordination/progress.txt to log progress
4. Check .claude/coordination/registry.json for other active agents
5. Create new tickets in TASKS.md for bugs or sub-tasks you discover
6. Coordinate with other agents — check their status before modifying shared files

== DASHBOARD API (execute via Bash tool with curl) ==

CHECK BOARD (task counts by status):
  curl -s 'http://localhost:4000/api/agent-actions?action=board-summary&projectId=clawbot-marketplace'

LIST TASKS BY STATUS:
  curl -s 'http://localhost:4000/api/agent-actions?action=list-tasks&projectId=clawbot-marketplace&status=TODO'

GET TASK DETAILS:
  curl -s 'http://localhost:4000/api/agent-actions?action=get-task&projectId=clawbot-marketplace&taskId=TASK_ID'

CREATE TASK:
  curl -s -X POST http://localhost:4000/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"clawbot-marketplace\",\"title\":\"TITLE\",\"description\":\"DESC\",\"status\":\"TODO\",\"priority\":\"P1\",\"agentId\":\"backend-1\"}'

MOVE TASK STATUS (TODO, IN_PROGRESS, REVIEW, DONE, etc.):
  curl -s -X POST http://localhost:4000/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"clawbot-marketplace\",\"taskId\":\"TASK_ID\",\"status\":\"DONE\",\"agentId\":\"backend-1\"}'

COMMENT ON TASK:
  curl -s -X POST http://localhost:4000/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"comment-task\",\"projectId\":\"clawbot-marketplace\",\"taskId\":\"TASK_ID\",\"agentId\":\"backend-1\",\"content\":\"COMMENT\"}'

SEND MESSAGE TO AGENT:
  curl -s -X POST http://localhost:4000/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"send-message\",\"projectId\":\"clawbot-marketplace\",\"fromAgent\":\"backend-1\",\"toAgent\":\"AGENT_ID\",\"content\":\"MSG\"}'

IMPORTANT: You MUST use these API commands to create tasks, move tasks across the board, and communicate. Do NOT just edit TASKS.md directly — always use the API so the dashboard updates in real time."

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "Work on task clawbot-marketplace-md-TASK-HARD-002: Replace fake Stripe adapter with real Stripe Connect. Read .claude/coordination/TASKS.md for details. Update task status as you progress."
