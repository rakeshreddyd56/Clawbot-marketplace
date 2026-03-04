#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/Users/rakeshreddy/Downloads/Clawbot-marketplace"
PROJECT_ID="clawbot-marketplace"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:4000}"
cd "$PROJECT_ROOT"

echo "=== Clawbot Multi-Agent Fleet Launcher ==="
echo "Project: $PROJECT_ROOT"
echo "Dashboard: $DASHBOARD_URL"
echo "Time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

# Register project launch with dashboard
curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"create-task\",\"projectId\":\"${PROJECT_ID}\",\"title\":\"Fleet launch initiated\",\"status\":\"DONE\",\"priority\":\"P3\",\"agentId\":\"launcher\"}" >/dev/null 2>&1 || true

# Kill any existing clawbot tmux sessions
for s in architect coder-1 coder-2 reviewer tester security devops ui-builder ui-polish ui-tester; do
  tmux kill-session -t "clawbot-${s}" 2>/dev/null || true
done
sleep 1

# Helper: launch an agent and register with dashboard
launch_agent() {
  local name="$1"
  local role="$2"
  local num="$3"
  local total="$4"

  echo "[${num}/${total}] Launching ${name} agent..."

  # Register agent as launching
  curl -s -X POST "${DASHBOARD_URL}/api/agent-actions" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"update-agent\",\"projectId\":\"${PROJECT_ID}\",\"agentId\":\"${name}\",\"status\":\"initializing\",\"role\":\"${role}\"}" >/dev/null 2>&1 || true

  tmux new-session -d -s "clawbot-${name}" -c "$PROJECT_ROOT" \
    "bash scripts/run-${name}.sh 2>&1 | tee /tmp/clawbot-${name}.log; echo '${name} DONE'; sleep 999999"
}

# Determine which agents to launch (default: core 7)
AGENTS="${1:-core}"

case "$AGENTS" in
  core)
    TOTAL=7
    launch_agent "architect"  "architect"        1 $TOTAL
    launch_agent "coder-1"    "coder"            2 $TOTAL
    launch_agent "coder-2"    "coder"            3 $TOTAL
    launch_agent "reviewer"   "reviewer"         4 $TOTAL
    launch_agent "tester"     "tester"           5 $TOTAL
    launch_agent "security"   "security-auditor" 6 $TOTAL
    launch_agent "devops"     "devops"           7 $TOTAL
    ;;
  all)
    TOTAL=10
    launch_agent "architect"  "architect"        1  $TOTAL
    launch_agent "coder-1"    "coder"            2  $TOTAL
    launch_agent "coder-2"    "coder"            3  $TOTAL
    launch_agent "reviewer"   "reviewer"         4  $TOTAL
    launch_agent "tester"     "tester"           5  $TOTAL
    launch_agent "security"   "security-auditor" 6  $TOTAL
    launch_agent "devops"     "devops"           7  $TOTAL
    launch_agent "ui-builder" "coder"            8  $TOTAL
    launch_agent "ui-polish"  "coder"            9  $TOTAL
    launch_agent "ui-tester"  "tester"           10 $TOTAL
    ;;
  ui)
    TOTAL=3
    launch_agent "ui-builder" "coder"  1 $TOTAL
    launch_agent "ui-polish"  "coder"  2 $TOTAL
    launch_agent "ui-tester"  "tester" 3 $TOTAL
    ;;
  *)
    # Launch a specific agent by name
    if [ -f "scripts/run-${AGENTS}.sh" ]; then
      launch_agent "$AGENTS" "coder" 1 1
    else
      echo "Unknown agent or group: $AGENTS"
      echo "Usage: $0 [core|all|ui|agent-name]"
      echo "  core       — architect, coder-1, coder-2, reviewer, tester, security, devops (default)"
      echo "  all        — core + ui-builder, ui-polish, ui-tester"
      echo "  ui         — ui-builder, ui-polish, ui-tester"
      echo "  agent-name — launch a specific agent (e.g., coder-1, architect)"
      exit 1
    fi
    ;;
esac

echo ""
echo "=== ${TOTAL:-1} agents launched ==="
echo ""
echo "Monitor:"
echo "  tmux ls                              — list sessions"
echo "  tmux attach -t clawbot-architect     — attach to agent"
echo "  tail -f /tmp/clawbot-*.log           — view all logs"
echo ""
echo "Dashboard: ${DASHBOARD_URL}"
echo "  Board:  ${DASHBOARD_URL}/board"
echo "  Agents: ${DASHBOARD_URL}/agents"
echo ""
tmux ls 2>/dev/null || echo "No tmux sessions found"
