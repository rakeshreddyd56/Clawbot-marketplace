#!/usr/bin/env bash
set -euo pipefail
unset CLAUDECODE
cd /Users/rakeshreddy/Downloads/Clawbot-marketplace

AGENT_ID="reviewer"
AGENT_ROLE="reviewer"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="http://localhost:4000"

# Load agent system prompt + dashboard instructions
SYSTEM_PROMPT="$(cat .claude/agents/reviewer.md)

$(cat .claude/coordination/DASHBOARD_INSTRUCTIONS.md)"

# Register with dashboard on startup
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"initializing\",\"role\":\"${AGENT_ROLE}\"}" >/dev/null 2>&1 || true

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --model sonnet \
  --max-turns 30 \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the ${AGENT_ID} for Clawbot Marketplace. Your agent ID for dashboard API calls is '${AGENT_ID}' and project ID is '${PROJECT_ID}'.

FIRST: Register yourself with the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"planning\",\"currentTask\":\"\",\"role\":\"${AGENT_ROLE}\"}'
\`\`\`

THEN: Read CLAUDE.md. Check for tasks in REVIEW status that need your attention:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=REVIEW'
\`\`\`

Also check BACKLOG for review tasks:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=BACKLOG'
\`\`\`

Claim a task before starting:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"IN_PROGRESS\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Do a comprehensive code review focusing on: architecture compliance, escrow correctness, identity freshness, security, error handling, code quality. Write reviews to reviews/ directory.

If you find issues, create tasks for them:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"Review finding: description\",\"priority\":\"P1\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

When done reviewing, move tasks to TESTED or back to IN_PROGRESS if issues found:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"TESTED\"}'
\`\`\`

Update docs/TASKS.md and progress.txt after each review."
