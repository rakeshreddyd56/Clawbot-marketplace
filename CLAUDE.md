# Project Configuration

## Identity
- Project: Clawbot Marketplace
- Stack: TypeScript 5, Fastify 5 (API), Next.js 15 (App Router), Zod 3.24, Vitest, WebSocket
- Node: >= 20 | Package Manager: npm
- Architecture: npm workspaces monorepo

## Workspace Layout
| Package | Path | Purpose |
|---------|------|---------|
| @claw/api | `apps/api` | Fastify API gateway + services (port 3000) |
| @claw/web | `apps/web` | Next.js frontend with role-based consoles (port 3001) |
| @claw/contracts | `packages/contracts` | Zod schemas for all domain models (43 schemas) |
| @claw/utils | `packages/utils` | Crypto, ID, time utilities |
| @claw/workflows | `packages/workflows` | Deterministic state machines (Temporal-ready) |
| — | `infra/k8s/base` | Kubernetes manifests (EKS-oriented) |
| — | `policies` | OPA Rego policy bundle |

## Critical Commands
- Install: `npm install`
- Build: `npm run build` (builds in dependency order)
- Dev API: `npm run dev` (port 3000)
- Dev Web: `npm run dev:web` (port 3001)
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`

**Build order**: contracts → utils → workflows → api → web

## IMPORTANT: Read Before Every Session
1. Read this `CLAUDE.md` — project rules and constraints
2. Read `docs/marketplace-architecture.md` — system design
3. Read `docs/v1-implementation-status.md` — what's built vs stubbed
4. Read `docs/TASKS.md` — find your assigned task or pick highest-priority unblocked
5. Check `progress.txt` — see what other agents have done

## IMPORTANT: Do Before Every Commit
1. Run `npm run build` — packages must compile
2. Run `npm test` — all tests must pass
3. Run `npm run typecheck` — no type errors
4. Update `docs/TASKS.md` — mark your task status
5. Append to `progress.txt` — one-line summary of what you did
6. Commit with conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `arch:`

## Architecture Rules — DO NOT VIOLATE
- NEVER store secrets in code — use environment variables (SESSION_SECRET, etc.)
- NEVER bypass TypeScript strict mode
- NEVER delete another agent's in-progress work
- All domain schemas MUST live in `packages/contracts/src/index.ts` (Zod)
- All state machines MUST live in `packages/workflows/src/index.ts`
- All API endpoints MUST have Zod input validation
- All API routes MUST check policy via PolicyDecisionService
- All state changes MUST publish hash-chained audit events via AuditLedger
- All escrow operations MUST be balanced (every DEBIT has a corresponding CREDIT)
- All privileged operations (payout, reserve) MUST check identity freshness
- Deny-by-default: unknown actions are denied
- Frontend MUST use BFF proxy (`/api/bff/...`), never call API directly
- Use `@claw/utils` for IDs (`uid()`), timestamps (`nowIso()`), crypto (`sha256()`, `signWithSecret()`)

## Multi-Agent Coordination Rules
- Check `.claude/coordination/registry.json` before starting work
- Register yourself when starting: append your agent name and task
- Deregister when done: remove your entry
- Acquire file locks before modifying shared files
- If two agents conflict on the same file, the one registered FIRST has priority
- Use git worktrees for parallel work: `claude --worktree <branch-name>`
- NEVER force-push. Use `--force-with-lease` if rebasing
- Check `.claude/coordination/locks.json` before modifying any file

## File Ownership Boundaries
- `apps/api/src/` — Backend agent territory
  - `core/marketplace.ts` — Requires lock (central business logic)
  - `core/store.ts` — Requires lock (shared data store)
  - `services/` — Individual files lockable
  - `adapters/` — Individual files lockable
- `apps/web/` — Frontend agent territory
  - `app/*/page.tsx` — Individual pages lockable
  - `components/` — Individual components lockable
- `packages/contracts/src/index.ts` — Requires coordination (all schemas in one file)
- `packages/workflows/src/index.ts` — Requires coordination (all state machines)
- `packages/utils/src/index.ts` — Requires coordination
- `infra/`, `policies/` — DevOps agent territory only
- `docs/marketplace-architecture.md` — Architect agent territory
- `docs/TASKS.md` — Any agent (short-lived lock)
- `progress.txt` — Any agent (append-only with lock)

## Key Domain Concepts
- **Agents**: Workers/requesters verified via Moltbook identity tokens
- **Trust Tiers**: A (high trust), B (medium), C (restricted — no reserve/payout)
- **Tasks**: Posted by requesters with scope manifests (data refs, tools, egress)
- **Assignment Leases**: 2-minute leases with 30-second heartbeat interval
- **Contracts**: Milestone-based with escrow locking and penalty schedules
- **Artifacts**: Deliverables validated with SHA256 hash + HMAC signature
- **Disputes**: Open → auto-decide → appeal (72h window) → final ruling
- **Sanctions**: Progressive escalation: NONE → SUSPEND → BAN
- **Audit Log**: Hash-chained immutable events (tamper detection)
- **Vault Tokens**: Short-lived (15min) scoped data access grants
- **Policy Decisions**: Deny-by-default RBAC (37 known actions, 4 roles)

## Style & Conventions
- Use the project's existing patterns. Read 2-3 similar files before creating new ones
- Prefer composition over inheritance
- Prefer explicit over implicit
- Error messages must be actionable — use DomainError with status codes
- Use Zod schemas for all external input validation
- In-memory store for local dev (production: PostgreSQL + Redis + Kafka)
- Routes are thin: validation → service call → audit event → response
- Services contain business logic, not routes
