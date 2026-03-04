#!/usr/bin/env bash
set -euo pipefail
unset CLAUDECODE
cd /Users/rakeshreddy/Downloads/Clawbot-marketplace

AGENT_ID="security"
AGENT_ROLE="security-auditor"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="http://localhost:4000"

# Load agent system prompt + dashboard instructions
SYSTEM_PROMPT="$(cat .claude/agents/security-auditor.md)

$(cat .claude/coordination/DASHBOARD_INSTRUCTIONS.md)"

# Register with dashboard on startup
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"initializing\",\"role\":\"${AGENT_ROLE}\"}" >/dev/null 2>&1 || true

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --model sonnet \
  --max-turns 40 \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the ${AGENT_ID} auditor for Clawbot Marketplace. Your agent ID for dashboard API calls is '${AGENT_ID}' and project ID is '${PROJECT_ID}'.

FIRST: Register yourself with the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"planning\",\"currentTask\":\"\",\"role\":\"${AGENT_ROLE}\"}'
\`\`\`

THEN: Read CLAUDE.md. Check the dashboard for security tasks:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=BACKLOG'
\`\`\`

Claim a task before starting:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"IN_PROGRESS\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Conduct a full STRIDE threat model and security audit. Focus on: escrow safety, identity/JWT, audit trail integrity, policy enforcement, signatures, secrets, input validation, dependencies.

For EVERY vulnerability found, create a task on the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"SECURITY: vulnerability description\",\"priority\":\"P0\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Write full report to reviews/security-audit-full.md.

When done, move task to REVIEW:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"REVIEW\"}'
\`\`\`

Update docs/TASKS.md and progress.txt after each task."
