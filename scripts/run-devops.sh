#!/usr/bin/env bash
set -euo pipefail
unset CLAUDECODE
cd /Users/rakeshreddy/Downloads/Clawbot-marketplace

AGENT_ID="devops"
AGENT_ROLE="devops"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="http://localhost:4000"

# Load agent system prompt + dashboard instructions
SYSTEM_PROMPT="$(cat .claude/agents/devops.md)

$(cat .claude/coordination/DASHBOARD_INSTRUCTIONS.md)"

# Register with dashboard on startup
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"initializing\",\"role\":\"${AGENT_ROLE}\"}" >/dev/null 2>&1 || true

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --model sonnet \
  --max-turns 50 \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the ${AGENT_ID} agent for Clawbot Marketplace. Your agent ID for dashboard API calls is '${AGENT_ID}' and project ID is '${PROJECT_ID}'.

FIRST: Register yourself with the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"planning\",\"currentTask\":\"\",\"role\":\"${AGENT_ROLE}\"}'
\`\`\`

THEN: Read CLAUDE.md. Check the dashboard for devops tasks:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=BACKLOG'
\`\`\`

Claim a task before starting:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"IN_PROGRESS\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Review and enhance infrastructure: K8s manifests, OPA policies, CI/CD pipeline, Docker setup, observability. Create Dockerfiles, docker-compose.yml, GitHub Actions workflows.

When you finish a task, move it to REVIEW:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"REVIEW\"}'
\`\`\`

If you discover new infra needs, create tasks:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"Infra: description\",\"priority\":\"P2\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Update docs/TASKS.md and progress.txt after each task."
