# Architecture Decision Records

## ADR-001: Fastify over Express for API Gateway

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Need a high-performance HTTP framework for the marketplace API with WebSocket support
- **Decision**: Use Fastify 5
- **Rationale**:
  - 2-3x faster than Express in benchmarks
  - Built-in schema validation
  - First-class TypeScript support
  - Plugin-based architecture (WebSocket, CORS, cookies)
  - Schema-based serialization
- **Alternatives Rejected**:
  - Express: Slower, less opinionated
  - Hono: Less mature ecosystem
  - NestJS: Too much abstraction for this use case

## ADR-002: Zod for Runtime Validation + Type Inference

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Need runtime validation that also generates TypeScript types
- **Decision**: Use Zod 3.24 for all domain schemas in `packages/contracts`
- **Rationale**:
  - Single source of truth for types AND validation
  - `z.infer<typeof Schema>` eliminates duplication
  - Composable schemas
  - Excellent error messages
- **Consequences**: All 43 domain schemas live in one file — requires coordination lock

## ADR-003: In-Memory Store for Alpha (PostgreSQL for Production)

- **Date**: 2026-03-02
- **Status**: Accepted (transitional)
- **Context**: Rapid alpha development without database complexity
- **Decision**: Use Map-based in-memory store, migrate to PostgreSQL for beta
- **Rationale**:
  - Fast iteration for API surface design
  - No migration/schema management overhead during design phase
  - Clean abstraction boundary in `core/store.ts` makes migration straightforward
- **Follow-up**: TASK-HARD-003 to add PostgreSQL persistence

## ADR-004: Deterministic State Machines in Shared Package

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Workflow state transitions must be deterministic for Temporal replay safety
- **Decision**: Pure functions in `packages/workflows` — `(state, command) => newState`
- **Rationale**:
  - Replay-safe (no side effects)
  - Testable in isolation
  - Shared between API and future Temporal workers
  - Throws on invalid transitions (fail-fast)

## ADR-005: BFF Cookie Auth for Frontend

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Next.js frontend needs secure auth without exposing JWT to browser JS
- **Decision**: Backend-for-Frontend pattern with httpOnly cookie session
- **Rationale**:
  - JWT never accessible to client-side JavaScript (XSS-safe)
  - BFF proxy at `/api/bff/[...path]` attaches Bearer token from cookie
  - SameSite=Lax prevents CSRF
  - Clean separation: frontend never calls API directly

## ADR-006: Hash-Chained Audit Log

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Need tamper-evident audit trail for marketplace operations
- **Decision**: Each audit event includes SHA256 hash of (event + previousHash)
- **Rationale**:
  - Blockchain-style integrity (detect any modification)
  - Append-only (no deletes or updates)
  - Supports compliance and dispute evidence
- **Consequence**: Event publishing must be sequential (hash chain)

## ADR-007: Deny-by-Default Policy Enforcement

- **Date**: 2026-03-02
- **Status**: Accepted
- **Context**: Multiple roles (admin, moderator, requester, worker) with different permissions
- **Decision**: PolicyDecisionService with deny-by-default, explicit allowlists per role
- **Rationale**:
  - Unknown actions are denied (secure by default)
  - Unknown context fields are rejected
  - Every decision is logged for audit
  - Mirrors production OPA integration pattern
