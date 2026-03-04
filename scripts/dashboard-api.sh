#!/usr/bin/env bash
# Dashboard API helper for multi-agent coordination
# Source this or call functions directly from agent scripts
#
# Usage:
#   source scripts/dashboard-api.sh
#   dashboard_claim_task "TASK-HARD-001" "coder-1"
#   dashboard_move_task "$TASK_ID" "REVIEW"
#   dashboard_heartbeat "coder-1" "working" "TASK-HARD-001"

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:4000}"
PROJECT_ID="${PROJECT_ID:-clawbot-marketplace}"

# List all tasks on the board (optionally filter by status)
dashboard_list_tasks() {
  local status="${1:-}"
  local url="${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}"
  [ -n "$status" ] && url="${url}&status=${status}"
  curl -s "$url" 2>/dev/null
}

# Get board summary (task counts by status)
dashboard_board_summary() {
  curl -s "${DASHBOARD_URL}/api/agent-actions?action=board-summary&projectId=${PROJECT_ID}" 2>/dev/null
}

# Move a task to a new status
# Args: task_id new_status [agent_id]
dashboard_move_task() {
  local task_id="$1"
  local status="$2"
  local agent_id="${3:-}"
  curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"${task_id}\",\"status\":\"${status}\",\"agentId\":\"${agent_id}\"}" 2>/dev/null
}

# Claim a task: move to IN_PROGRESS and assign to agent
# Args: task_id agent_id
dashboard_claim_task() {
  local task_id="$1"
  local agent_id="$2"
  dashboard_move_task "$task_id" "IN_PROGRESS" "$agent_id"
}

# Complete a task: move to DONE
# Args: task_id
dashboard_complete_task() {
  local task_id="$1"
  dashboard_move_task "$task_id" "DONE"
}

# Send task to review
# Args: task_id
dashboard_send_to_review() {
  local task_id="$1"
  dashboard_move_task "$task_id" "REVIEW"
}

# Create a new task on the board
# Args: title [status] [priority] [agent_id] [description]
dashboard_create_task() {
  local title="$1"
  local status="${2:-BACKLOG}"
  local priority="${3:-P2}"
  local agent_id="${4:-}"
  local description="${5:-}"
  curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"${title}\",\"status\":\"${status}\",\"priority\":\"${priority}\",\"agentId\":\"${agent_id}\",\"description\":\"${description}\"}" 2>/dev/null
}

# Update agent status and heartbeat
# Args: agent_id status [current_task] [role]
dashboard_heartbeat() {
  local agent_id="$1"
  local status="$2"
  local current_task="${3:-}"
  local role="${4:-coder}"
  curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${agent_id}\",\"status\":\"${status}\",\"currentTask\":\"${current_task}\",\"role\":\"${role}\"}" 2>/dev/null
}

# Read the mission briefing
dashboard_read_mission() {
  curl -s "${DASHBOARD_URL}/api/agent-actions?action=read-mission&projectId=${PROJECT_ID}" 2>/dev/null
}

# Find task ID by external ID (e.g. TASK-HARD-001)
dashboard_find_task() {
  local external_id="$1"
  curl -s "${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}" 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data.get('tasks', []):
    if t.get('externalId') == '${external_id}' or '${external_id}' in t.get('id', ''):
        print(t['id'])
        break
" 2>/dev/null
}
