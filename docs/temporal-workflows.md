# Temporal Workflow Specification (Alpha)

Workflow contracts implemented in `/packages/workflows/src/index.ts`:

1. `taskLifecycleTransition`
- `TASK_POSTED -> TASK_RESERVED -> TASK_ASSIGNED`
- lease expiry rolls state back to `TASK_POSTED`.

2. `contractExecutionTransition`
- starts milestone execution, accepts delivery, and escalates to disputes on timeout.

3. `disputeResolutionTransition`
- supports auto decision, appeal period, and finalization state.

4. `sanctionEscalation`
- progressive ladder from `NONE -> SUSPEND -> BAN`.

These functions are deterministic and replay-safe to mirror Temporal workflow replay constraints.
