#!/usr/bin/env bash
# Clawbot Multi-Agent Monitor — Checks status every 5 minutes

PROJECT_ROOT="/Users/rakeshreddy/Downloads/Clawbot-marketplace"

echo "=== Clawbot Agent Fleet Monitor ==="
echo "Checking every 5 minutes. Ctrl+C to stop."
echo ""

while true; do
  echo "============================================"
  echo "STATUS CHECK: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "============================================"
  echo ""

  # Check tmux sessions
  echo "--- ACTIVE SESSIONS ---"
  tmux ls 2>/dev/null | grep clawbot || echo "No clawbot sessions found"
  echo ""

  # Check progress log
  echo "--- RECENT PROGRESS ---"
  tail -20 "$PROJECT_ROOT/progress.txt" 2>/dev/null || echo "No progress yet"
  echo ""

  # Check coordination registry
  echo "--- AGENT REGISTRY ---"
  cat "$PROJECT_ROOT/.claude/coordination/registry.json" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Empty"
  echo ""

  # Check locks
  echo "--- ACTIVE LOCKS ---"
  cat "$PROJECT_ROOT/.claude/coordination/locks.json" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "None"
  echo ""

  # Check git activity
  echo "--- GIT LOG (last 10) ---"
  cd "$PROJECT_ROOT" && git log --oneline -10 2>/dev/null || echo "No commits"
  echo ""

  # Check events
  echo "--- RECENT EVENTS ---"
  tail -10 "$PROJECT_ROOT/.claude/coordination/events.log" 2>/dev/null || echo "No events"
  echo ""

  # Check task status
  echo "--- TASKS STATUS ---"
  grep -E "^### TASK-|^\- \*\*Status:" "$PROJECT_ROOT/docs/TASKS.md" 2>/dev/null | paste - - || echo "No tasks"
  echo ""

  # Check for reviews
  echo "--- REVIEWS ---"
  ls "$PROJECT_ROOT/reviews/" 2>/dev/null || echo "No reviews yet"
  echo ""

  # Check log tails
  for agent in architect coder-1 coder-2 reviewer tester security devops; do
    if [ -f "/tmp/clawbot-${agent}.log" ]; then
      echo "--- ${agent} (last 3 lines) ---"
      tail -3 "/tmp/clawbot-${agent}.log" 2>/dev/null
      echo ""
    fi
  done

  echo "Next check in 5 minutes..."
  echo ""
  sleep 300
done
