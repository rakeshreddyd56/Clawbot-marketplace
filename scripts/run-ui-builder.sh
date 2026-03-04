#!/usr/bin/env bash
set -euo pipefail
unset CLAUDECODE
cd /Users/rakeshreddy/Downloads/Clawbot-marketplace

AGENT_ID="ui-builder"
AGENT_ROLE="coder"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="http://localhost:4000"

# Load system prompt + dashboard instructions
SYSTEM_PROMPT="You are a senior React/Next.js developer building production-quality UI components. You follow the existing design system (custom CSS with CSS variables, no Tailwind). You use the BFF proxy pattern for all API calls. You write accessible, responsive components. You follow the project conventions in CLAUDE.md. You match the existing code style exactly — read 2-3 existing components before writing new ones.

$(cat .claude/coordination/DASHBOARD_INSTRUCTIONS.md)"

# Register with dashboard on startup
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"initializing\",\"role\":\"${AGENT_ROLE}\"}" >/dev/null 2>&1 || true

exec claude \
  --system-prompt "$SYSTEM_PROMPT" \
  --model sonnet \
  --max-turns 80 \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  -p "You are the ${AGENT_ID} for Clawbot Marketplace. Your agent ID for dashboard API calls is '${AGENT_ID}' and project ID is '${PROJECT_ID}'.

FIRST: Register yourself with the dashboard:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${AGENT_ID}\",\"status\":\"planning\",\"currentTask\":\"\",\"role\":\"${AGENT_ROLE}\"}'
\`\`\`

THEN: Read CLAUDE.md. Check the dashboard for frontend tasks:
\`\`\`bash
curl -s '${DASHBOARD_URL}/api/agent-actions?action=list-tasks&projectId=${PROJECT_ID}&status=BACKLOG'
\`\`\`

Pick the highest priority frontend task and claim it:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"IN_PROGRESS\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Build missing frontend components and features. Study existing patterns in apps/web/components/ first. Focus on: Moltbook Re-verify UI, Onboarding Checklist, Trust Tier Card, WebSocket reconnection, loading skeletons, error boundaries.

When you finish a task, move it to REVIEW:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"move-task\",\"projectId\":\"${PROJECT_ID}\",\"taskId\":\"TASK_ID_HERE\",\"status\":\"REVIEW\"}'
\`\`\`

If you discover new UI needs, create tasks:
\`\`\`bash
curl -s -X POST ${DASHBOARD_URL}/api/agent-actions -H 'Content-Type: application/json' -d '{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"UI: description\",\"priority\":\"P2\",\"agentId\":\"${AGENT_ID}\"}'
\`\`\`

Run npm run build to verify everything compiles. Update docs/TASKS.md and progress.txt after each task. Keep working through the backlog until no UI tasks remain."
