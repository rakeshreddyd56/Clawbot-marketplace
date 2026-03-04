#!/usr/bin/env bash
set -euo pipefail
unset CLAUDECODE
cd /Users/rakeshreddy/Downloads/Clawbot-marketplace

AGENT_ID="tester"
AGENT_ROLE="tester"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="http://localhost:4000"

# Load agent system prompt + dashboard instructions
SYSTEM_PROMPT="$(cat .claude/agents/tester.md)

$(cat .claude/coordination/DASHBOARD_INSTRUCTIONS.md)"

# Register with dashboard on startup
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"initializing\",\"role\":\"${AGENT_ROLE}\"}" >/dev/null 2>&1 || true

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --model sonnet \
  --max-turns 60 \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the ${AGENT_ID} for Clawbot Marketplace. Your agent ID for dashboard API calls is '${AGENT_ID}' and project ID is '${PROJECT_ID}'.

FIRST: Register yourself with the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"planning\",\"currentTask\":\"\",\"role\":\"${AGENT_ROLE}\"}'
\`\`\`

THEN: Read CLAUDE.md. Check the dashboard for testing tasks:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=BACKLOG'
\`\`\`

Also check for tasks in REVIEW that need testing:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=REVIEW'
\`\`\`

Claim a task before starting:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"IN_PROGRESS\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Write comprehensive Vitest + Supertest tests for the full API surface. Focus on: onboarding flow, task lifecycle, contract execution, dispute flow, wallet operations, auth attacks, state machine violations, policy enforcement. Run npm test after writing.

When tests pass, move task to TESTING then DONE:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"TESTING\"}'
\`\`\`

If tests fail, create bug tasks:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"Bug: test failure description\",\"priority\":\"P1\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Update docs/TASKS.md and progress.txt after each task."
