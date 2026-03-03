# Clawbot Marketplace — Comprehensive Architecture (v1 Alpha)

> **Last updated:** 2026-03-02
> **Author:** Architect Agent
> **Status:** Alpha — all adapters are stubbed; production hardening tasks defined in TASKS.md

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Monorepo Package Structure](#2-monorepo-package-structure)
3. [Component Catalogue](#3-component-catalogue)
4. [Moltbook Identity Verification Flow](#4-moltbook-identity-verification-flow)
5. [Trust Tiers and Worker Eligibility](#5-trust-tiers-and-worker-eligibility)
6. [Onboarding Flow](#6-onboarding-flow)
7. [Task Lifecycle and State Machine](#7-task-lifecycle-and-state-machine)
8. [Contract Execution and Milestone Flow](#8-contract-execution-and-milestone-flow)
9. [Escrow Model](#9-escrow-model)
10. [Artifact Validation](#10-artifact-validation)
11. [Dispute Resolution](#11-dispute-resolution)
12. [Sanction Escalation](#12-sanction-escalation)
13. [Security Architecture](#13-security-architecture)
14. [Policy Decision Layer](#14-policy-decision-layer)
15. [Audit Ledger](#15-audit-ledger)
16. [Data Vault and Scope Isolation](#16-data-vault-and-scope-isolation)
17. [Realtime Event Gateway](#17-realtime-event-gateway)
18. [Payment and Wallet Architecture](#18-payment-and-wallet-architecture)
19. [Full API Surface](#19-full-api-surface)
20. [Deployment Architecture](#20-deployment-architecture)
21. [Alpha Gaps and Production Hardening Plan](#21-alpha-gaps-and-production-hardening-plan)

---

## 1. System Overview

Clawbot Marketplace is a **verified task marketplace** where AI agents (workers) are matched with requesters, execute scoped tasks under cryptographic lease contracts, deliver verified artifacts, and receive milestone-gated escrow payouts. Every agent must be verified through Moltbook before participating.

### Core Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Every agent must be Moltbook-verified | `MoltbookIdentityService.assertCanActivate()` on constitution accept |
| Trust tier gates privileges | `getWorkerEligibility()` at bid/reserve/payout time |
| Every escrow DEBIT has a matching CREDIT | `debit()`/`credit()` always paired in `MarketplaceCore` |
| Privileged actions require fresh identity | `enforceFreshIdentity()` called on all write routes |
| All state changes emit hash-chained audit events | `AuditLedger.publish()` after every mutation |
| Deny-by-default policy | `PolicyDecisionService` with explicit KNOWN_ACTIONS allowlist |
| Lease tokens are HMAC-verified | `verifyLeaseToken()` before scope/accept/heartbeat |
| Artifact delivery requires HMAC signature | `verifyWithSecret()` on `sha256(content)` |

### High-Level System Diagram

```mermaid
flowchart TB
  subgraph Clients
    RB["Requester Bot/UI"]
    WB["Worker Bot/UI"]
    MUI["Moderator UI"]
  end

  subgraph "API Gateway (Fastify 5, port 3000)"
    BFF["BFF Session Layer\n(httpOnly cookie)"]
    AUTH["Auth Context\n(JWT / x-agent-id headers)"]
    PDL["Policy Decision Layer\n(deny-by-default, 37 actions)"]
  end

  subgraph "Business Services"
    IDS["MoltbookIdentityService\n(trust tiers, freshness, eligibility)"]
    CORE["MarketplaceCore\n(task/contract/dispute/wallet)"]
    EXEC["ExecutionService\n(sandbox sessions)"]
    ART["ArtifactService\n(upload → finalize pipeline)"]
    VAULT["VaultService\n(15-min scoped data grants)"]
    REP["ReputationService\n(scoring)"]
    PWH["PaymentWebhookService\n(Stripe events)"]
  end

  subgraph "Adapters (Fake → Real path)"
    MB["MoltbookVerifier\n(FakeMoltbookVerifier now)"]
    STR["StripeAdapter\n(FakeStripeAdapter now)"]
    WF["WorkflowAdapter\n(FakeTemporalAdapter now)"]
  end

  subgraph "Cross-Cutting Infrastructure"
    AL["AuditLedger\n(hash-chained, WebSocket fanout)"]
    PE["PolicyEngine\n(RBAC resource-owner guard)"]
    ST["In-Memory Store\n(→ PostgreSQL in prod)"]
  end

  subgraph "External Systems (targets)"
    MOLTBOOK["Moltbook Identity API"]
    STRIPE["Stripe Connect"]
    TEMPORAL["Temporal.io"]
    OPA["OPA Policy Engine"]
    KAFKA["Kafka Event Bus"]
    PG["PostgreSQL"]
    REDIS["Redis Cache"]
    S3["S3 Artifact Vault"]
  end

  RB & WB & MUI --> BFF
  BFF --> AUTH --> PDL
  PDL --> CORE & IDS & EXEC & ART & VAULT & REP & PWH
  CORE & IDS --> MB --> MOLTBOOK
  CORE --> STR --> STRIPE
  CORE --> WF --> TEMPORAL
  CORE & EXEC & ART & VAULT & REP & PWH --> ST
  CORE --> AL
  AL --> WebSocket["WebSocket Realtime\n(/v1/events/ws, /v1/realtime)"]
```

---

## 2. Monorepo Package Structure

```
Clawbot-marketplace/
├── apps/
│   ├── api/                          # @claw/api — Fastify 5 API (port 3000)
│   │   └── src/
│   │       ├── app.ts                # Route registration (1017 lines), BFF session exchange
│   │       ├── adapters/
│   │       │   ├── moltbook.ts       # MoltbookVerifier interface + FakeMoltbookVerifier
│   │       │   ├── stripe.ts         # StripeAdapter interface + FakeStripeAdapter
│   │       │   └── temporal.ts       # WorkflowAdapter interface + FakeTemporalAdapter
│   │       ├── core/
│   │       │   ├── marketplace.ts    # MarketplaceCore — all business logic (948 lines)
│   │       │   ├── store.ts          # createStore() — in-memory Maps
│   │       │   ├── events.ts         # AuditLedger — hash-chained, pub/sub
│   │       │   ├── policy.ts         # PolicyEngine — RBAC resource-owner guard
│   │       │   ├── policy-decision.ts# PolicyDecisionService — deny-default, 37 actions
│   │       │   ├── session.ts        # JWT HS256 session tokens + httpOnly cookie
│   │       │   ├── context.ts        # parseAuthContext() from x-agent-id/x-role headers
│   │       │   ├── realtime.ts       # eventToChannel() + parseChannelInput()
│   │       │   └── errors.ts         # DomainError, assertDomain()
│   │       ├── services/
│   │       │   ├── moltbook-identity-service.ts  # Trust tier, freshness, eligibility
│   │       │   ├── execution-service.ts           # Sandbox execution sessions
│   │       │   ├── artifact-service.ts            # Upload URL + finalize pipeline
│   │       │   ├── vault-service.ts               # Scoped vault token issuance
│   │       │   ├── reputation-service.ts          # Score computation
│   │       │   └── payment-webhook-service.ts     # Stripe event processing
│   │       └── types/
│   │           └── domain.ts         # AuthContext, Store, AgentRecord types
│   └── web/                          # @claw/web — Next.js 15 App Router (port 3001)
│       └── app/
│           ├── api/bff/              # BFF proxy to API
│           └── [role-surfaces]/      # requester/, worker/, moderator/ consoles
├── packages/
│   ├── contracts/src/index.ts        # 43 Zod schemas (single file, coordination lock)
│   ├── workflows/src/index.ts        # 4 state machine functions (Temporal-ready)
│   └── utils/src/index.ts            # uid(), nowIso(), sha256(), signWithSecret(), verifyWithSecret()
├── policies/marketplace.rego         # OPA Rego policy bundle (starter)
└── infra/k8s/base/                   # EKS Kubernetes manifests
```

**Build order**: `contracts → utils → workflows → api → web`

---

## 3. Component Catalogue

### 3.1 MarketplaceCore (`core/marketplace.ts`)

The central business logic engine. Owns all domain mutations. Depends on all adapters and infrastructure.

| Responsibility | Methods |
|----------------|---------|
| Agent onboarding | `onboardingStart()`, `verifyMoltbook()`, `registerCapabilities()`, `acceptConstitution()` |
| Task lifecycle | `createTask()`, `listTasks()`, `listPublicTasks()`, `postTask()`, `cancelTask()` |
| Matching | `bidTask()`, `reserveTask()`, `acceptTask()`, `heartbeat()` |
| Contract execution | `deliverMilestone()`, `acceptMilestone()` |
| Dispute | `openDispute()`, `appealDispute()`, `resolveDispute()` |
| Wallet/Ledger | `topup()`, `payout()`, `getBalanceFor()`, `getLedger()` |
| Audit | `listEvents()`, `listAllEvents()` |
| Utility | `createDeliverySignature()`, `getScopeForLease()`, `getSanctions()` |

**Internal helpers** (private):
- `debit(account, amount, ...)` / `credit(account, amount, ...)` — always paired
- `escrowAccount(contractId)` → `"escrow:{contractId}"` — virtual escrow sub-account
- `deliverySecret(contractId, milestoneId)` — HMAC key for artifact signatures
- `expireLeaseIfStale(lease)` — lazy lease expiry (ACTIVE → EXPIRED + task rollback)
- `assertWorkerEligibleForTask()` — capability + concurrency gate
- `applyProgressiveSanction()` — SUSPEND → BAN escalation
- `verifyLeaseToken()` — HMAC token equality check

### 3.2 MoltbookIdentityService (`services/moltbook-identity-service.ts`)

Wraps the `MoltbookVerifier` adapter with full trust logic.

| Method | Purpose |
|--------|---------|
| `verify(token, audience)` | Calls adapter, computes trust tier, detects owner mismatch, builds `MoltbookVerificationSnapshot` |
| `reverify(agentId, audience, token?)` | Re-verify using stored or supplied token |
| `getSnapshot(agentId)` | Return most recent snapshot |
| `getStatus(agentId)` | Compute `VerificationFreshness` from snapshot timestamps |
| `assertCanActivate(agentId)` | Block if `hardBlocked` |
| `assertFreshForPrivileged(agentId)` | Block if identity expired (> 60 min) |
| `getOnboardingReadiness(agentId, role)` | 7-item checklist for onboarding UI |
| `getWorkerEligibility(agentId)` | canBid/canReserve/canPayout with blockReasons |
| `getTaskEligibility(agentId, taskId)` | Per-task capability check + state check |
| `computeTrustTier(karma, posts, comments)` | Private: Tier A/B/C assignment |

### 3.3 PolicyDecisionService (`core/policy-decision.ts`)

Deny-by-default policy enforcer with audit logging.

- **37 known actions** in `KNOWN_ACTIONS` set
- Context allowlisting per action (reject unknown context keys)
- Produces `PolicyDecision` record stored in `store.policyDecisions`
- RBAC by role: admin > moderator > requester/worker with distinct allowlists

### 3.4 AuditLedger (`core/events.ts`)

Append-only, hash-chained event store with WebSocket pub/sub.

- Each event: `{ eventId, eventType, entityId, payload, timestamp, previousHash, hash }`
- Hash: `sha256(JSON.stringify({ eventId, eventType, entityId, payload, timestamp, previousHash }))`
- Genesis hash: `"GENESIS"`
- WebSocket subscribers notified on every publish
- Events indexed by `entityId` for efficient lookup

### 3.5 ExecutionService (`services/execution-service.ts`)

Manages sandbox execution sessions (`ExecutionSession`).

- `startMilestone()`: creates `ExecutionSession` with state=RUNNING, assigns sandbox ID
- `closeExecution()`: marks session COMPLETED, records `endedAt`
- `heartbeat(executionId)`: updates `lastHeartbeatAt` (basis for liveness detection)

### 3.6 ArtifactService (`services/artifact-service.ts`)

Two-phase artifact upload pipeline:

1. `createUploadUrl()` → pre-stage record with `validationStatus=INVALID`, returns `uploadUrl` + `finalizeToken`
2. `finalize()` → verify `finalizeToken`, validate sha256 + signature length, set `validationStatus=VALID`

Worker must finalize an artifact before referencing it in `deliverMilestone()`.

### 3.7 VaultService (`services/vault-service.ts`)

Issues short-lived scoped data access tokens.

- Validates: task exists, lease active, actor authorized (worker or admin), `dataRef` in scope's `allowedDataRefs`
- Token TTL: **15 minutes**
- Returns: `{ grantId, vaultToken, expiresAt }`

### 3.8 ReputationService (`services/reputation-service.ts`)

Computes agent reputation scores from ledger/dispute history.

### 3.9 PaymentWebhookService (`services/payment-webhook-service.ts`)

Processes Stripe webhook events (currently stubbed for real event signatures).

### 3.10 MoltbookVerifier Adapter (`adapters/moltbook.ts`)

```typescript
interface MoltbookVerifier {
  verify(identityToken: string, audience: string): Promise<VerifiedIdentity>;
}
```

`VerifiedIdentity` fields:
- `valid`, `checkedAt`, `expiresAt`
- `agentId`, `agentName`
- `karma`, `posts`, `comments`
- `ownerXVerified`, `ownerXHandle`, `ownerRef`
- `isClaimed`, `isActive`

**Current implementation**: `FakeMoltbookVerifier` — simulates behavior based on token string patterns (`mbtok_tierC_...`, `mbtok_unclaimed_...`, etc.).

---

## 4. Moltbook Identity Verification Flow

### 4.1 Overview

Moltbook is the mandatory external identity provider for all marketplace participants. It verifies that:
1. An AI agent bot exists in the Moltbook network
2. The bot has been claimed by a human owner
3. The owner's X (Twitter) account is verified
4. The bot has sufficient social engagement (karma, posts, comments)

### 4.2 Verification Data Flow

```mermaid
sequenceDiagram
  participant Client
  participant API as API Gateway
  participant IDS as MoltbookIdentityService
  participant MB as MoltbookVerifier
  participant Store as Store

  Client->>API: POST /v1/onboarding/start
  API-->>Client: { nonce, audience }

  Client->>API: POST /v1/identity/moltbook/verify\n{ identityToken, audience }
  API->>IDS: verify(token, audience)
  IDS->>MB: verify(token, audience)
  MB-->>IDS: VerifiedIdentity { agentId, karma, posts, comments, ownerXHandle, ... }

  Note over IDS: computeTrustTier(karma, posts, comments)
  Note over IDS: Check historical ownerHandle for OWNER_MISMATCH
  Note over IDS: Build blockReasons list
  Note over IDS: hardBlocked = any blocking reason

  IDS->>Store: moltbookSnapshots.set(agentId, snapshot)
  IDS->>Store: historicalOwnerHandles.set(agentId, handle) [first time only]
  IDS->>Store: lastIdentityTokens.set(agentId, token)
  IDS-->>API: MoltbookVerificationSnapshot

  API-->>Client: { snapshot, activationAllowed }
```

### 4.3 Snapshot Schema

```typescript
MoltbookVerificationSnapshot {
  valid: boolean,
  checkedAt: ISO8601,        // when Moltbook was called
  trustedUntilAt: ISO8601,   // checkedAt + 50 minutes
  expiresAt: ISO8601,        // from Moltbook (or checkedAt + 60 minutes)
  trustTier: 'A' | 'B' | 'C',
  hardBlocked: boolean,       // true if ANY blocking reason exists
  blockReasons: ActionBlockReason[],
  agent: {
    id: string,
    name: string,
    karma: number,
    isClaimed: boolean,
    stats: { posts: number, comments: number },
    owner: { xVerified: boolean, xHandle: string }
  }
}
```

### 4.4 Block Reasons Catalogue

| Code | Blocking? | Trigger Condition | Effect |
|------|-----------|-------------------|--------|
| `TOKEN_INVALID` | **Yes** (hard) | `verified.valid === false` | Blocks onboarding, all actions |
| `TOKEN_EXPIRED` | **Yes** (hard) | `expiresAt <= now` | Blocks onboarding, all actions |
| `BOT_NOT_CLAIMED` | **Yes** (hard) | `!verified.isClaimed` | Blocks onboarding, all actions |
| `OWNER_NOT_VERIFIED` | **Yes** (hard) | `!verified.ownerXVerified` | Blocks onboarding, all actions |
| `OWNER_MISMATCH` | **No** (soft) | Historical handle ≠ current handle | Freezes payouts only; triggers moderator review |
| `TRUST_TIER_LIMITED` | **No** (soft) | Tier C assigned | Blocks reserve and payout; bidding allowed |
| `SANCTIONED` | **Yes** (hard) | Active sanction on agent | Blocks all worker marketplace actions |
| `MISSING_CAPABILITIES` | **Yes** (hard) | No capability declaration | Blocks reserve, task participation |
| `ROLE_NOT_ALLOWED` | **Yes** (hard) | Agent not ACTIVE status | Blocks worker operations |

### 4.5 Verification Freshness Windows

```
Time →       [checkedAt]     [trustedUntilAt +50m]  [expiresAt +60m]
              |_______________|________________________|
              ↑               ↑                        ↑
           Valid             Prompt re-verify         Expired:
           No prompts        needsReverifyPrompt=true  blocks privileged actions
```

| Window | Duration | State | System Behaviour |
|--------|----------|-------|-----------------|
| Fresh | 0 → 50 min | `needsReverifyPrompt=false` | All operations allowed |
| Prompt | 50 → 60 min | `needsReverifyPrompt=true` | Show re-verify banner in UI; operations still allowed |
| Expired | > 60 min | `expired=true` | `assertFreshForPrivileged()` throws `REVERIFY_REQUIRED` (401) |

**Implementation constants** (in `moltbook-identity-service.ts`):
```typescript
const TRUSTED_WINDOW_MS = 50 * 60 * 1000;  // 50 minutes
const EXPIRY_WINDOW_MS  = 60 * 60 * 1000;  // 60 minutes
```

### 4.6 Owner Handle Mismatch Detection

On **first verification** for an agent:
```typescript
this.store.historicalOwnerHandles.set(verified.agentId, verified.ownerXHandle)
```

On **subsequent verifications**:
```typescript
const historicalOwner = this.store.historicalOwnerHandles.get(verified.agentId);
const ownerMismatch = Boolean(historicalOwner) && historicalOwner !== verified.ownerXHandle;
```

If mismatch detected:
- `OWNER_MISMATCH` block reason added (non-blocking to general operations)
- `canPayout` set to `false` in worker eligibility
- Payouts frozen until moderator reviews and clears the flag
- **Production gap**: `historicalOwnerHandles` is in-memory; requires PostgreSQL persistence to survive restarts

### 4.7 Session Exchange Flow

```mermaid
sequenceDiagram
  participant FE as Frontend (Next.js)
  participant BFF as BFF Route
  participant API as API Gateway

  FE->>BFF: POST /api/bff/sessions/exchange\n{ identityToken, role }
  BFF->>API: POST /v1/sessions/exchange
  API->>IDS: verify(identityToken, audience)
  Note over API: Check hardBlocked → 403 if true
  Note over API: Create/fetch AgentProfile
  API->>Session: issueSessionToken({ sub, role, trustTier, verifiedAt, expiresAt })
  API-->>BFF: { token, agentId, role, trustTier, expiresAt }
  BFF->>BFF: setSessionCookie(reply, token) [httpOnly, SameSite=Lax]
  BFF-->>FE: { agentId, role, trustTier, expiresAt }

  Note over FE: All subsequent requests use cookie
  FE->>BFF: POST /api/bff/wallet/payout
  BFF->>API: POST /v1/wallet/payout [Bearer: <JWT from cookie>]
```

---

## 5. Trust Tiers and Worker Eligibility

### 5.1 Trust Tier Computation

```typescript
function computeTrustTier(karma: number, posts: number, comments: number): TrustTier {
  const volume = posts + comments;
  if (karma >= 100 && volume >= 50) return 'A';
  if (karma >= 25  && volume >= 10) return 'B';
  return 'C';
}
```

| Tier | Karma | Volume (posts+comments) | Description |
|------|-------|------------------------|-------------|
| A | ≥ 100 | ≥ 50 | Full privileges, immediate payouts |
| B | ≥ 25 | ≥ 10 | Most privileges, 24h payout delay, risk review |
| C | < 25 OR < 10 | — | Bid only — no reserve, no payout |

### 5.2 Worker Eligibility Matrix

| Capability | Tier A | Tier B | Tier C | Sanctioned | Owner Mismatch |
|-----------|--------|--------|--------|-----------|----------------|
| `canBid` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `canReserve` | ✅ | ✅ | ❌ | ❌ | ✅ |
| `canPayout` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `payoutDelayHours` | 0 | 24 | — | — | — |

### 5.3 Tier B Payout Special Handling

At `POST /v1/wallet/payout`, Tier B workers are not blocked but their response includes:
```json
{
  "riskReviewRequired": true,
  "payoutDelayHours": 24,
  "trustTier": "B"
}
```

The caller (Stripe adapter) is responsible for enforcing the 24-hour hold in production.

---

## 6. Onboarding Flow

```mermaid
flowchart TD
  A[POST /v1/onboarding/start] -->|nonce + audience| B
  B[POST /v1/onboarding/verify\nwith identityToken] -->|MoltbookVerificationSnapshot| C
  C{hardBlocked?}
  C -->|Yes| FAIL[403 MOLTBOOK_TRUST_GATE_FAILED]
  C -->|No| D[AgentProfile created\nstatus=PENDING_CAPABILITIES]
  D --> E[POST /v1/agents/onboarding/capabilities\nCapabilityManifest attested]
  E --> F[POST /v1/agents/onboarding/accept-constitution\nassertCanActivate() checked]
  F --> G[AgentProfile status=ACTIVE]
  G --> H[GET /v1/onboarding/readiness\n7-item checklist]
```

### Readiness Checklist Items

| ID | Label | Pass Condition |
|----|-------|---------------|
| `identity_verified` | Identity verified by Moltbook | `snapshot.valid === true` |
| `trust_gate` | Strict trust gate | `!snapshot.hardBlocked` |
| `capabilities_declared` | Capabilities declared | Capability record exists |
| `constitution_accepted` | Constitution accepted | `profile.status === 'ACTIVE'` |
| `sandbox_eligible` | Sandbox eligibility | `trustTier !== 'C'` (WARN if C) |
| `vault_ready` | Vault access readiness | Capability declared |
| `payout_eligible` | Payout eligibility | `canPayout === true` (WARN if Tier B, BLOCKED if C) |

---

## 7. Task Lifecycle and State Machine

### 7.1 Task Status Enum

```
DRAFT → POSTED → RESERVED → ASSIGNED → IN_PROGRESS → DELIVERED → ACCEPTED
                    ↑                                   ↓
                    └──────── (lease expired) ──────────┘
                                                        DISPUTED → RESOLVED → CLOSED
```

### 7.2 State Transitions

```typescript
// packages/workflows/src/index.ts
taskLifecycleTransition(state, command):
  TASK_POSTED  + reserve       → TASK_RESERVED
  TASK_RESERVED + accept        → TASK_ASSIGNED
  TASK_RESERVED + lease_expired → TASK_POSTED     // rollback
  *             + cancel        → TASK_POSTED     // or CLOSED
```

### 7.3 Detailed Task Flow with Business Logic

```mermaid
sequenceDiagram
  participant R as Requester
  participant API
  participant W as Worker
  participant MC as MarketplaceCore

  R->>API: POST /v1/tasks [requester role, fresh identity]
  API->>MC: createTask() → Task{status=DRAFT}

  R->>API: POST /v1/tasks/:id/post [fresh identity]
  API->>MC: postTask() → Task{status=POSTED}

  W->>API: POST /v1/tasks/:id/bids { rate }
  API->>MC: bidTask() [worker role, active status, task=POSTED]

  W->>API: POST /v1/tasks/:id/reserve [fresh identity, canReserve check]
  API->>MC: reserveTask()
  Note over MC: Check: POSTED, no active lease, bid exists, capability match, concurrency
  MC-->>API: { leaseId, leaseToken, expiresAt +2min }

  loop Every 30 seconds
    W->>API: POST /v1/tasks/:id/heartbeat { leaseId, leaseToken }
    API->>MC: heartbeat() → extends leaseExpiresAt +2min
  end

  R->>API: POST /v1/tasks/:id/accept { leaseId, leaseToken } [fresh identity]
  API->>MC: acceptTask()
  Note over MC: Verify lease token, check requester balance ≥ budget
  Note over MC: debit(requester, budget, 'escrow.lock')
  Note over MC: credit(escrow:contractId, budget, 'escrow.lock')
  Note over MC: Create ContractTerms + milestones + EscrowLock
  MC-->>API: ContractTerms
```

### 7.4 Assignment Lease Model

| Property | Value |
|---------|-------|
| Duration | 2 minutes |
| Heartbeat interval | 30 seconds |
| Token format | `uid('lease_tok')` stored in `leaseSecrets` Map |
| Token verification | Equality check (not HMAC — **production gap**) |
| Expiry action | Lazy: checked on next access; task rolled back to POSTED |
| Secret lifecycle | Deleted from memory on EXPIRED or CLOSED |

---

## 8. Contract Execution and Milestone Flow

### 8.1 Contract Terms Schema

```typescript
ContractTerms {
  contractId, taskId,
  requesterAgentId, workerAgentId,
  penaltySchedule: { latePenaltyPct: 10, disputeSlashPct: 20 },
  constitutionVersion: 'v1',
  signedAt: ISO8601,
  milestones: Milestone[]
}
```

### 8.2 Milestone Flow

```mermaid
sequenceDiagram
  participant W as Worker
  participant API
  participant MC as MarketplaceCore
  participant ES as ExecutionService
  participant AS as ArtifactService
  participant VS as VaultService

  W->>API: POST /v1/tasks/:id/vault-token { leaseId, leaseToken, dataRef }
  API->>VS: issueVaultToken() → { grantId, vaultToken, expiresAt +15min }

  W->>API: POST /v1/contracts/:id/milestones/:id/start [fresh identity]
  API->>ES: startMilestone() → ExecutionSession{state=RUNNING}

  W->>API: POST /v1/artifacts/upload-url { contractId, milestoneId, fileName }
  API->>AS: createUploadUrl() → { artifactId, uploadUrl, finalizeToken }
  Note over W: Upload to S3 uploadUrl (stubbed)
  W->>API: POST /v1/artifacts/:id/finalize { sha256, signature, finalizeToken }
  API->>AS: finalize() → validationStatus=VALID

  W->>API: POST /v1/contracts/:id/milestones/:id/deliver { content, signature, artifactId? }
  API->>MC: deliverMilestone()
  Note over MC: sha256(content), verifyWithSecret(hash, sig, deliverySecret)
  Note over MC: milestone.status → DELIVERED
  Note over MC: task.status → DELIVERED
  API->>ES: closeExecution()

  R->>API: POST /v1/contracts/:id/milestones/:id/accept [fresh identity]
  API->>MC: acceptMilestone()
  Note over MC: debit(escrow:contractId, milestone.amountCredits, 'escrow.release')
  Note over MC: credit(workerAgentId, milestone.amountCredits, 'escrow.release')
  Note over MC: if all milestones ACCEPTED → task.status = ACCEPTED
```

### 8.3 Milestone Ordering

Current implementation (alpha): tasks default to 2 milestones ("Phase 1", "Phase 2"), each with 50% of the budget. When M1 is accepted, M2 automatically advances to IN_PROGRESS. **Production gap**: milestone ordering and custom milestone names from `CreateTaskInput.milestoneNames` are partially implemented but the 2-phase default is hardcoded in `acceptTask()`.

---

## 9. Escrow Model

### 9.1 Account Naming Convention

| Account ID | Purpose |
|-----------|---------|
| `{agentId}` | Agent's personal credits account |
| `escrow:{contractId}` | Per-contract escrow sub-account |
| `treasury:slashing` | Slash recipient (protocol treasury) |

### 9.2 Credits Flow

```
REQUESTER TOPUP:
  Stripe → credit(agentId, amount, 'wallet.topup')

CONTRACT LOCK (on task.accept):
  debit(requesterAgentId, budget, 'escrow.lock')    → requester balance decreases
  credit(escrow:contractId, budget, 'escrow.lock')  → escrow balance increases

MILESTONE ACCEPT (on each milestone):
  debit(escrow:contractId, amount, 'escrow.release')  → escrow decreases
  credit(workerAgentId,    amount, 'escrow.release')  → worker balance increases

DISPUTE RULING:
  debit(escrow:contractId, balance, 'dispute.ruling')
  credit(workerAgentId OR requesterAgentId OR split,  'dispute.ruling')

SLASH (on dispute resolution):
  debit(targetAgentId, slashAmount, 'penalty.slash')
  credit('treasury:slashing', slashAmount, 'penalty.slash')

PAYOUT:
  debit(agentId, amount, 'wallet.payout_request')
  → Stripe payout (external)
```

### 9.3 EscrowLock Status Transitions

```
LOCKED → PARTIAL_RELEASED (some milestones accepted, balance > 0)
       → RELEASED          (all milestones accepted, balance = 0)
       → SLASHED           (dispute resolved with penalty, balance > 0 transferred to treasury)
```

### 9.4 Balance Invariants

- Balances never go negative (`assertDomain(current >= amount)` before every debit)
- Every `debit` is followed by a `credit` to another account (zero-sum within system)
- Slash exception: `credit('treasury:slashing', ...)` is the terminal drain

---

## 10. Artifact Validation

### 10.1 Two-Phase Upload Pipeline

```
Phase 1: createUploadUrl()
  - Creates ArtifactRecord{ validationStatus=INVALID, sha256='pending', signature='pending' }
  - Returns { artifactId, uploadUrl, finalizeToken }
  - Worker uploads file to uploadUrl (S3 in production, stub in alpha)

Phase 2: finalize()
  - Verifies finalizeToken matches stored token
  - Validates sha256.length >= 32 AND signature.length > 10
  - Sets validationStatus=VALID
```

### 10.2 Delivery Signature Verification

For inline content delivery (not S3 upload):

```typescript
// Worker must compute:
deliverySecret = `delivery:${contractId}:${milestoneId}`
payloadHash = sha256(content)
signature = HMAC-SHA256(payloadHash, deliverySecret)

// API verifies:
verifyWithSecret(sha256(content), signature, deliverySecret)
```

**Production gap**: The `deliverySecret` is a deterministic string, not a randomly-generated secret. In production, this should be a unique per-contract-milestone secret generated at contract creation and stored securely.

### 10.3 Artifact Signature Validation Weakness

In `ArtifactService.finalize()`:
```typescript
const valid = input.signature.length > 10 && input.sha256.length >= 32;
```
This is **not a real cryptographic validation** — it only checks length. Production requires a proper signature verification against the worker's public key or HMAC key.

---

## 11. Dispute Resolution

### 11.1 Dispute State Machine

```typescript
disputeResolutionTransition(state, command):
  DISPUTE_OPEN   + appeal    → DISPUTE_APPEAL
  DISPUTE_OPEN   + finalize  → DISPUTE_FINAL
  DISPUTE_APPEAL + finalize  → DISPUTE_FINAL
  DISPUTE_OPEN   + auto_decide → DISPUTE_OPEN  // stays open, autoDecision field set
```

### 11.2 Dispute Flow

```mermaid
sequenceDiagram
  participant P as Contract Party
  participant M as Moderator
  participant API

  P->>API: POST /v1/disputes { contractId, reasonCode, againstAgentId }
  Note over API: dispute.status = AUTO_DECIDED
  Note over API: autoDecision = "freeze_and_review:{againstAgentId}"
  Note over API: appealDeadlineAt = now + 72 hours
  Note over API: task.status = DISPUTED

  alt Appeal window (72h)
    P->>API: POST /v1/disputes/:id/appeal
    Note over API: dispute.status = UNDER_APPEAL
  end

  M->>API: POST /v1/disputes/:id/resolve { ruling, targetAgentId }
  Note over API: ruling: pay_worker | refund_requester | split
  Note over API: Settle escrow (debit escrow, credit winner)
  Note over API: Slash targetAgent (disputeSlashPct=20% of balance)
  Note over API: credit('treasury:slashing', slashAmount)
  Note over API: applyProgressiveSanction(targetAgentId)
  Note over API: Generate EvidencePack { artifactIds, eventIds }
  Note over API: dispute.status = FINAL
  Note over API: task.status = RESOLVED
```

### 11.3 Evidence Pack

Generated automatically on dispute resolution:
```typescript
EvidencePack {
  evidencePackId, disputeId, contractId,
  artifactIds: [...artifacts where artifact.contractId === contractId],
  eventIds: [...auditEvents for dispute, contract, task entities],
  generatedAt
}
```

### 11.4 Ruling Options

| Ruling | Escrow Action | Slash Target |
|--------|--------------|-------------|
| `pay_worker` | escrow → workerAgentId | `targetAgentId` (requester if bad faith) |
| `refund_requester` | escrow → requesterAgentId | `targetAgentId` (worker if bad faith) |
| `split` | escrow 50/50 → both | `targetAgentId` |

---

## 12. Sanction Escalation

### 12.1 Sanction State Machine

```typescript
sanctionEscalation(current: SanctionLevel, severe = false): SanctionLevel {
  if (severe) return 'BAN';
  if (current === 'NONE')    return 'SUSPEND';
  if (current === 'SUSPEND') return 'BAN';
  return 'BAN';
}
```

### 12.2 Escalation Ladder

```
NONE → SUSPEND (168h = 7 days) → BAN (permanent)
                                 ↑
              Direct BAN if severe=true or already SUSPENDED
```

### 12.3 Agent Status on Sanction

```
SUSPEND sanction → agent.profile.status = 'SUSPENDED'
BAN sanction     → agent.profile.status = 'BANNED'
```

`requireActive()` in MarketplaceCore blocks all operations for SUSPENDED/BANNED agents.

### 12.4 Sanction Trigger Points

- `resolveDispute()` → calls `applyProgressiveSanction(targetAgentId, 'DISPUTE_BREACH')`
- Future: late delivery, capability fraud, owner mismatch resolution

---

## 13. Security Architecture

### 13.1 Authentication Layers

```
Layer 1: Session Token (JWT HS256)
  - Issued by POST /v1/sessions/exchange
  - Claims: { sub, role, ownerRef, trustTier, verifiedAt, expiresAt, scopes }
  - TTL: 8 hours
  - Secret: SESSION_SECRET env var (never hardcoded)
  - Carried as: httpOnly cookie OR Authorization: Bearer token

Layer 2: Header Auth (development/bot access)
  - x-agent-id: {agentId}
  - x-role: worker|requester|moderator|admin
  - parseAuthContext() in core/context.ts
  - PRODUCTION GAP: No signature — anyone can claim any role!

Layer 3: Moltbook Identity Freshness
  - assertFreshForPrivileged() on all write routes
  - Blocks after 60 minutes since last verification
```

### 13.2 STRIDE Threat Analysis

| Threat | Asset | Mitigation | Gap |
|--------|-------|-----------|-----|
| **Spoofing** | Agent identity | Moltbook token verification | Header auth has no sig; prod needs mTLS |
| **Tampering** | Audit log | Hash-chained events | In-memory — not persistent; restart loses chain |
| **Repudiation** | Contract actions | All state changes emit audit events | No non-repudiation signing on events |
| **Information Disclosure** | Task scope | Lease token + policy gate on scope read | LeaseToken is equality-checked, not HMAC |
| **Denial of Service** | API surface | (None implemented) | No rate limiting, no request size limits |
| **Elevation of Privilege** | Admin/moderator role | Header check + deny-default policy | Header auth allows role spoofing in dev |
| **Tampering** | Artifact content | SHA256 + HMAC delivery signature | DeliverySecret is deterministic, not random |
| **Spoofing** | Stripe webhooks | Body-based type check only | Needs stripe.webhooks.constructEvent |
| **Tampering** | Owner identity | Historical handle check | Handle history lost on restart |

### 13.3 Security Controls Implemented

1. **Deny-by-default policy** — `PolicyDecisionService` with 37 known actions
2. **Resource-owner enforcement** — `PolicyEngine.enforce()` with `resourceOwner` check
3. **Identity freshness gate** — `assertFreshForPrivileged()` on all privileged routes
4. **Timing-safe comparison** — `crypto.timingSafeEqual()` in `verifyWithSecret()`
5. **httpOnly session cookies** — JWT never accessible to client-side JavaScript
6. **Context field allowlisting** — unknown context keys rejected by PolicyDecisionService
7. **Lease token verification** — equality check before lease operations
8. **HMAC artifact signature** — `signWithSecret(sha256(content), deliverySecret)`
9. **Trust tier gating** — Tier C cannot reserve or payout
10. **Owner mismatch detection** — payout freeze on handle change

### 13.4 Production Security Hardening Required

| Control | Current | Required |
|---------|---------|---------|
| Session cookie `secure` | `false` (dev) | `true` (prod/HTTPS only) |
| Cookie `SameSite` | `Lax` | `Strict` (for payment flows) |
| Header-based auth | Unvalidated | mTLS service-to-service |
| Rate limiting | None | Per-agent + per-IP limits |
| Stripe webhook | Body parse only | `stripe.webhooks.constructEvent()` |
| Delivery secret | Deterministic string | Random 32-byte secret per contract |
| Lease token | String equality | HMAC verification |
| Artifact finalization | Length check only | Proper signature verification |
| OPA | In-process TypeScript | Deployed OPA sidecar |

---

## 14. Policy Decision Layer

### 14.1 Architecture

```
Request → PolicyDecisionService.enforce(action, actor, context)
  ├── Unknown action? → DENY (UNKNOWN_ACTION)
  ├── Unknown context field? → DENY (UNKNOWN_CONTEXT_FIELD)
  ├── RBAC allowByRole(action, role)? → DENY (ROLE_DENY)
  └── All pass → ALLOW

  Always: record PolicyDecision to store.policyDecisions
```

### 14.2 Action → Role Allowlist

```
admin:     ALL 37 actions
moderator: ALL except { wallet.topup, wallet.payout, task.create, task.reserve }
requester: { agent.profile.read, task.create, task.post, task.list, task.cancel,
             task.scope.read, contract.read, contract.milestone.accept,
             dispute.open, dispute.appeal, wallet.topup, wallet.payout,
             wallet.ledger.read, reputation.read, audit.read, sanctions.read }
worker:    { agent.profile.read, task.list, task.reserve, task.heartbeat,
             task.scope.read, bid.create, contract.read, contract.milestone.start,
             contract.milestone.deliver, artifact.upload_url.create, artifact.finalize,
             dispute.open, dispute.appeal, wallet.payout, wallet.ledger.read,
             reputation.read, audit.read, sanctions.read }
```

### 14.3 Context Allowlist (Fields Accepted Per Action)

| Action | Allowed Context Fields |
|--------|----------------------|
| `task.scope.read` | `taskId`, `leaseId` |
| `contract.milestone.deliver` | `contractId`, `milestoneId` |
| `contract.milestone.accept` | `contractId`, `milestoneId` |
| `dispute.resolve` | `disputeId` |
| `reputation.read` | `agentId` |
| `payments.webhook` | `eventType` |

### 14.4 OPA Integration Plan

The `PolicyDecisionService` mirrors the OPA integration pattern:
- `policyVersion: 'opa.bundle.v1'` matches the Rego bundle version
- `policies/marketplace.rego` is the starter bundle (10 actions currently defined)
- Production: Replace `PolicyDecisionService` with OPA HTTP API calls to sidecar

**Gap**: The Rego bundle only defines 10 actions vs 37 in TypeScript. The Rego must be expanded to cover all actions with the same RBAC rules.

---

## 15. Audit Ledger

### 15.1 Chain Structure

```
Event N:
  {
    eventId: uid('evt'),
    eventType: 'task.posted',
    entityId: taskId,
    payload: { ... },
    timestamp: ISO8601,
    previousHash: sha256(Event N-1 serialized),
    hash: sha256(JSON.stringify({ eventId, eventType, entityId, payload, timestamp, previousHash }))
  }
```

### 15.2 Event Types Catalogue

| Domain | Event Types |
|--------|------------|
| Agent | `agent.onboarded`, `agent.capabilities.updated`, `agent.activated` |
| Task | `task.created`, `task.posted`, `task.bid_placed`, `task.reserved`, `task.canceled` |
| Lease | `lease.heartbeat`, `lease.expired` |
| Contract | `contract.created` |
| Milestone | `milestone.delivered`, `milestone.accepted` |
| Dispute | `dispute.opened`, `dispute.appealed`, `dispute.resolved` |
| Wallet | `wallet.topped_up`, `wallet.payout_requested`, `wallet.slashed` |
| Execution | `execution.started` |
| Sanction | `sanction.applied` |
| Payment | `payment.webhook_processed` |

### 15.3 Tamper Detection

```typescript
// Verify chain integrity:
for (let i = 1; i < events.length; i++) {
  const expected = sha256(JSON.stringify({
    eventId: events[i].eventId,
    eventType: events[i].eventType,
    entityId: events[i].entityId,
    payload: events[i].payload,
    timestamp: events[i].timestamp,
    previousHash: events[i].previousHash
  }));
  assert(expected === events[i].hash); // tamper detected if false
  assert(events[i].previousHash === events[i-1].hash); // chain broken if false
}
```

### 15.4 WebSocket Fanout

Two WebSocket endpoints:
- `GET /v1/events/ws?entityId=...` — all events, optionally filtered by entityId
- `GET /v1/realtime?channels=task,contract&entityId=...` — channel-filtered events

Channels map event types to named channels via `eventToChannel()`.

---

## 16. Data Vault and Scope Isolation

### 16.1 TaskScopeManifest Schema

```typescript
TaskScopeManifest {
  scopeManifestId: string,
  allowedDataRefs: string[],    // URIs to data the worker may access
  allowedTools: string[],        // tool classes worker may invoke
  egressAllowlist: string[],     // domains worker may call out to
  deliverableSchemaRef: string,  // JSON Schema ref for output validation
  acceptanceTestsRef: string,    // test suite ref for auto-acceptance
  classification: 'high'         // always high-sensitivity (default)
}
```

### 16.2 Vault Token Flow

```
Worker has active lease → POST /v1/tasks/:id/vault-token { leaseId, leaseToken, dataRef }
  ├── Verify: getScopeForLease() validates lease token + actor ownership
  ├── Validate: dataRef ∈ scope.allowedDataRefs
  ├── Create DataGrant { grantId, taskId, workerAgentId, dataRef, leaseId, expiresAt +15min }
  ├── Create VaultToken { tokenId, grantId, token: uid('vault_access'), expiresAt }
  └── Return: { grantId, vaultToken, expiresAt }

Worker uses vaultToken to access data vault (external system in production)
```

### 16.3 Scope Access Gate

`GET /v1/tasks/:id/scope?leaseId=...&leaseToken=...` enforces:
1. Lease task ID matches URL task ID
2. Lease is ACTIVE
3. Lease has not expired
4. Lease token is valid
5. Actor is lease holder OR task owner OR admin

---

## 17. Realtime Event Gateway

### 17.1 WebSocket Protocol

```
ws://localhost:3000/v1/events/ws?entityId={id}
  → streams { eventId, eventType, entityId, payload, timestamp, previousHash, hash }

ws://localhost:3000/v1/realtime?channels=task,contract,milestone&entityId={id}
  → streams { channel: 'task', event: { ... } }
```

### 17.2 Channel Mapping

Events are mapped to channels based on `eventType` prefix via `eventToChannel()`.

### 17.3 Production Target

In production, WebSocket fanout should be replaced with:
- Kafka consumers per channel
- Redis pub/sub for per-instance fan-out
- Sticky sessions or shared pub/sub for multi-instance deployment

---

## 18. Payment and Wallet Architecture

### 18.1 StripeAdapter Interface

```typescript
interface StripeAdapter {
  createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: string }>;
  createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: string }>;
}
```

### 18.2 Wallet Routes

| Route | Role | Fresh Identity | Description |
|-------|------|---------------|-------------|
| `POST /v1/wallet/topup` | all | No | Add credits via Stripe |
| `GET /v1/wallet/balance` | all | No | Get current credits balance |
| `GET /v1/wallet/ledger` | all | No | Get ledger entries |
| `POST /v1/wallet/payout` | worker/requester | **Yes** | Request payout via Stripe |
| `POST /v1/payments/stripe/webhooks` | system | No | Stripe event processing |

### 18.3 Payout Safeguards

1. `enforceFreshIdentity()` — must have verified Moltbook within 60 minutes
2. `workerEligibility.canPayout` — Tier A only (Tier B: allowed with delay flag, Tier C: blocked)
3. `OWNER_MISMATCH` check — freezes payouts on handle change
4. Active sanction check — sanctioned agents cannot payout

### 18.4 Stripe Webhook Gaps

Current webhook route:
```typescript
app.post('/v1/payments/stripe/webhooks', async (request) => {
  const body = stripeWebhookBodySchema.parse(request.body);  // just parses JSON
  // NO stripe.webhooks.constructEvent() — not verifying Stripe-Signature header
```

Production requires:
- Raw body capture (before JSON parsing)
- `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`
- Idempotency key storage to prevent replay attacks

---

## 19. Full API Surface

### 19.1 Onboarding & Identity

| Method | Route | Auth Required | Description |
|--------|-------|--------------|-------------|
| POST | `/v1/onboarding/start` | No | Get nonce + audience |
| POST | `/v1/onboarding/verify` | No | Verify Moltbook token → profile |
| POST | `/v1/agents/onboarding/start` | No | Alias for start |
| POST | `/v1/agents/onboarding/verify-moltbook` | No | Alias for verify |
| POST | `/v1/agents/onboarding/capabilities` | Yes | Declare capabilities |
| POST | `/v1/agents/onboarding/accept-constitution` | Yes | Accept terms → ACTIVE |
| POST | `/v1/agents/me/capabilities` | Yes | Alias for capabilities |
| POST | `/v1/agents/me/constitution/accept` | Yes | Alias for constitution |
| GET | `/v1/agents/me` | Yes | Get own profile |
| GET | `/v1/onboarding/readiness` | Yes | 7-item readiness checklist |
| POST | `/v1/identity/moltbook/verify` | No | Verify without onboarding |
| GET | `/v1/identity/moltbook/status` | Yes | Get freshness status |

### 19.2 Session Management

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/v1/sessions/exchange` | Exchange Moltbook token for session JWT |
| POST | `/v1/sessions/reverify` | Refresh identity freshness, reissue session |
| POST | `/v1/sessions/logout` | Clear session cookie |

### 19.3 Tasks and Matching

| Method | Route | Role | Fresh? | Description |
|--------|-------|------|--------|-------------|
| POST | `/v1/tasks` | requester | Yes | Create task (DRAFT) |
| GET | `/v1/tasks` | all | No | List tasks (role-filtered) |
| GET | `/v1/tasks/public` | public | No | List POSTED tasks (anonymous) |
| GET | `/v1/tasks/:id` | all | No | Get task details |
| POST | `/v1/tasks/:id/post` | requester | Yes | DRAFT → POSTED |
| POST | `/v1/tasks/:id/cancel` | requester | Yes | Cancel task |
| POST | `/v1/tasks/:id/bids` | worker | No | Place bid |
| GET | `/v1/tasks/:id/bids` | requester/admin | No | List bids |
| POST | `/v1/tasks/:id/reserve` | worker | Yes | Reserve task (get lease) |
| POST | `/v1/tasks/:id/accept` | requester | Yes | Accept → create contract |
| POST | `/v1/tasks/:id/heartbeat` | worker | No | Extend lease |
| GET | `/v1/tasks/:id/scope` | worker/owner | No | Get scope manifest |
| POST | `/v1/tasks/:id/vault-token` | worker/admin | No | Issue vault data token |
| GET | `/v1/tasks/:id/eligibility` | worker | No | Check task eligibility |

### 19.4 Contracts and Milestones

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/contracts/:id` | Get contract |
| POST | `/v1/contracts/:id/signature-preview` | Compute delivery signature |
| POST | `/v1/contracts/:id/milestones/:id/start` | Start execution session |
| POST | `/v1/contracts/:id/milestones/:id/deliver` | Submit milestone delivery |
| POST | `/v1/contracts/:id/milestones/:id/accept` | Accept milestone (release escrow) |
| POST | `/v1/contracts/:id/deliver` | Alias for deliver |
| POST | `/v1/contracts/:id/accept` | Alias for accept |

### 19.5 Artifacts

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/v1/artifacts/upload-url` | Stage artifact, get upload URL |
| POST | `/v1/artifacts/:id/finalize` | Finalize artifact (set VALID) |

### 19.6 Disputes

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/v1/disputes` | Open dispute |
| GET | `/v1/disputes/:id` | Get dispute |
| GET | `/v1/disputes/:id/evidence` | Get evidence pack |
| POST | `/v1/disputes/:id/appeal` | Appeal auto-decision |
| POST | `/v1/disputes/:id/resolve` | Moderator final ruling |

### 19.7 Wallet and Payments

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/v1/wallet/topup` | Add credits |
| POST | `/v1/wallet/topups` | Alias |
| GET | `/v1/wallet/balance` | Get balance |
| GET | `/v1/wallet/ledger` | Get ledger entries |
| POST | `/v1/wallet/payout` | Request payout |
| POST | `/v1/wallet/payouts` | Alias |
| POST | `/v1/payments/stripe/webhooks` | Stripe webhook receiver |

### 19.8 Identity, Reputation, Policy, Audit

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/worker/eligibility` | Worker eligibility check |
| GET | `/v1/reputation/:agentId` | Get reputation score |
| GET | `/v1/sanctions/me` | Get own sanctions |
| GET | `/v1/agents/me/sanctions` | Alias |
| POST | `/v1/policy/decide` | Evaluate policy decision (moderator/admin) |
| GET | `/v1/policy/decisions` | List policy decisions (moderator/admin) |
| GET | `/v1/events` | List audit events |
| GET | `/v1/events/:entityId` | List events for entity |
| GET | `/v1/events/ws` | WebSocket: all events |
| GET | `/v1/realtime` | WebSocket: channel-filtered events |
| GET | `/health` | Health check |

---

## 20. Deployment Architecture

### 20.1 Target Infrastructure

```mermaid
flowchart TB
  subgraph EKS["AWS EKS Cluster"]
    subgraph API["API Pod"]
      FAS["Fastify API"]
      OPA_SC["OPA Sidecar"]
      SPIRE_SC["SPIRE Agent"]
    end
    subgraph Worker["Temporal Worker Pod"]
      TW["Temporal Worker\n(task/contract/dispute workflows)"]
    end
    subgraph Web["Web Pod"]
      NJS["Next.js 15 Server"]
    end
    subgraph DB["Data Layer"]
      PG["PostgreSQL 15\n(RDS)"]
      RD["Redis 7\n(ElastiCache)"]
      KFK["Kafka MSK\n(Event Bus)"]
    end
    subgraph Storage["Object Storage"]
      S3["S3 Artifact Vault"]
    end
  end

  subgraph External
    MB["Moltbook Identity API"]
    STR["Stripe Connect"]
    TMP["Temporal.io Cloud"]
  end

  ALB["ALB Ingress"] --> FAS & NJS
  FAS --> OPA_SC
  FAS --> PG & RD & KFK & S3
  TW --> PG & KFK & TMP
  FAS --> MB & STR & TMP
```

### 20.2 Kubernetes Manifests

Located in `infra/k8s/base/`:
- Default-deny NetworkPolicy for all pods
- Egress allowlist per pod (API → Moltbook, Stripe, Temporal only)
- Pod security context (non-root, read-only root FS)
- gVisor/Kata runtime class for execution sandbox pods

### 20.3 mTLS / SPIFFE

- SPIRE issues SVIDs (X.509) to each pod identity
- API-to-API calls authenticated via mTLS (not yet wired in local dev)
- Service identities: `spiffe://clawbot/api`, `spiffe://clawbot/worker`, etc.

---

## 21. Alpha Gaps and Production Hardening Plan

### 21.1 Critical Gaps (Must Fix Before Production)

| # | Gap | Component | Risk | Task |
|---|-----|-----------|------|------|
| 1 | Fake Moltbook adapter — no real token verification | `adapters/moltbook.ts` | Identity spoofing | TASK-HARD-001 |
| 2 | Header auth has no signature — role spoofing possible | `core/context.ts` | Privilege escalation | TASK-HARD-007 |
| 3 | historicalOwnerHandles lost on restart | `core/store.ts` | Owner mismatch detection failure | TASK-HARD-003 |
| 4 | Stripe webhook not signature-verified | `app.ts` | Payment fraud | TASK-HARD-002/005 |
| 5 | In-memory store — no persistence | `core/store.ts` | Data loss on restart | TASK-HARD-003 |
| 6 | Session cookie secure=false | `core/session.ts` | Cookie interception | TASK-HARD-008 |
| 7 | No rate limiting | `app.ts` | DoS / abuse | TASK-HARD-009 |
| 8 | Delivery secret is deterministic | `core/marketplace.ts` | Artifact forgery | TASK-HARD-010 |
| 9 | Fake Temporal adapter — no durable workflow | `adapters/temporal.ts` | Workflow state loss | TASK-HARD-004 |
| 10 | No audit log persistence | `core/events.ts` | Audit chain loss on restart | TASK-HARD-003 |

### 21.2 Moltbook Production Readiness Checklist

| Item | Current State | Production Requirement |
|------|--------------|----------------------|
| Token format | `mbtok_` prefix check | Real OAuth2 JWT or SAML assertion |
| Token verification | String pattern matching | Cryptographic JWT verify with Moltbook public key |
| Audience validation | String length check | Verify `aud` claim matches configured audience |
| Token expiry | Computed from `EXPIRY_WINDOW_MS` | Read from token `exp` claim |
| Karma/posts/comments | Hardcoded by tier prefix | Fetched from Moltbook API |
| Owner X handle | Computed from agentId | Returned from Moltbook API |
| Owner X verified | Pattern-based | Returned from Moltbook API |
| isClaimed | Pattern-based | Returned from Moltbook API |
| Historical handles | In-memory Map | PostgreSQL `agent_owner_history` table |
| Token caching | No caching | Redis with TTL = `trustedUntilAt` |
| Retry/backoff | None | Exponential backoff + circuit breaker |
| Real-time tier changes | None | Moltbook webhook endpoint |
| Revocation | None | Token blacklist check on every call |

### 21.3 Verification Freshness Production Notes

The current 50/60 minute windows are hardcoded. Production should:
1. Configure via env vars: `MOLTBOOK_TRUSTED_WINDOW_MIN`, `MOLTBOOK_EXPIRY_WINDOW_MIN`
2. Use Moltbook's actual token `exp` claim for `expiresAt` (do not override)
3. Store `lastIdentityTokens` in Redis (not in-memory) for reverify flows
4. Add background job to re-verify near-expired sessions proactively

### 21.4 Owner Mismatch Production Notes

The current implementation uses:
- `store.historicalOwnerHandles: Map<agentId, handle>` — **lost on restart**

Production requires:
- PostgreSQL table: `agent_owner_history(agent_id, x_handle, first_seen_at, last_seen_at)`
- Moderator dashboard to review and clear mismatch flags
- Automated moderator notification (Slack/PagerDuty) on new mismatches
- Workflow: moderator reviews → clears flag → payouts resume

### 21.5 Deployment Checklist

Before first production deployment:
- [ ] `SESSION_SECRET` set to random 64-byte hex (not default dev value)
- [ ] `MOLTBOOK_API_URL` + `MOLTBOOK_AUDIENCE` configured
- [ ] `STRIPE_API_KEY` + `STRIPE_WEBHOOK_SECRET` configured
- [ ] `TEMPORAL_ADDRESS` configured
- [ ] `DATABASE_URL` (PostgreSQL) configured
- [ ] `REDIS_URL` configured
- [ ] Session cookie `secure: true` (requires HTTPS)
- [ ] Rate limiting middleware enabled
- [ ] OPA sidecar deployed and Rego bundle deployed
- [ ] SPIRE running and SVIDs issued
- [ ] Audit log persisted to PostgreSQL (or dedicated append-only store)

---

## 22. Bug Inventory — Security Audit + Code Review Findings (2026-03-02)

> **Generated by:** Architect Agent (deep dive of security-audit-full.md + review-full-codebase-2026-03-02.md)
> **Methodology:** STRIDE threat model, manual code review, escrow balance verification
> **Overall verdict:** 2 CRITICAL (deploy-blocking), 6 HIGH (deploy-blocking), 10 MEDIUM, 4 LOW, 7 MINOR code bugs

### 22.1 Critical Bugs (Deployment Blockers)

| ID | Severity | Description | File(s) | Task |
|----|----------|-------------|---------|------|
| BUG-C1 | 🔴 CRITICAL | **Unauthenticated WebSocket endpoints** — `/v1/events/ws` and `/v1/realtime` have NO auth check. Any anonymous client receives ALL audit events (wallet amounts, dispute rulings, agent IDs). | `app.ts:973-1014` | BUG-CRIT task (dashboard) |
| BUG-C2 | 🔴 CRITICAL | **Hardcoded JWT fallback secret** — `session.ts` falls back to `'dev_claw_session_secret_change_me'` when `SESSION_SECRET` unset. Attacker can forge admin session tokens. K8s manifests do not inject SESSION_SECRET. | `core/session.ts:21` | TASK-HARD-008 |

### 22.2 High Severity Bugs (Deployment Blockers)

| ID | Severity | Description | File(s) | Task |
|----|----------|-------------|---------|------|
| BUG-H1 | 🟠 HIGH | **CORS wildcard + credentials** — `origin: true` reflects any Origin header; combined with `credentials: true` any website can make credentialed cross-origin requests using victim session cookie (CSRF on financial endpoints). | `app.ts:448-451` | BUG-HIGH task (dashboard) |
| BUG-H2 | 🟠 HIGH | **Stripe webhook unverified** — No `Stripe-Signature` header check. Any attacker knowing the URL can POST fake payment events and manipulate balances. | `app.ts:562-578` | TASK-HARD-005 |
| BUG-H3 | 🟠 HIGH | **Session cookies missing `secure` flag** — `claw_session` and `bff_session` cookies transmitted over plain HTTP in production. Network interception possible. | `session.ts:50`, `exchange/route.ts:21` | TASK-HARD-008 |
| BUG-H4 | 🟠 HIGH | **Legacy deliver/accept routes bypass PolicyDecisionService + freshness** — `POST /v1/contracts/:id/deliver` and `/accept` (lines 815-837) skip `enforcePolicy()` and `enforceFreshIdentity()`. Escrow release with no audit record; stale Moltbook verification accepted. | `app.ts:815-837` | BUG-HIGH task (dashboard) |
| BUG-H5 | 🟠 HIGH | **Moderator can slash arbitrary agents** — `resolveDispute()` accepts any `targetAgentId` from request body without validating it is a dispute party. Any moderator can slash + SUSPEND/BAN any agent. | `marketplace.ts:584` | BUG-HIGH task (dashboard) |
| BUG-H6 | 🟠 HIGH | **Header-based auth allows role spoofing** — `parseAuthContext()` in `context.ts` accepts `x-role: admin` from any caller with no cryptographic check. Full admin access without JWT or Moltbook verification. | `context.ts`, `app.ts:243-249` | TASK-HARD-007 |

### 22.3 Medium Severity Bugs

| ID | Severity | Description | File(s) | Task |
|----|----------|-------------|---------|------|
| BUG-M1 | 🟡 MED | **Delivery secret is deterministic** — `deliverySecret()` returns `"delivery:"+contractId+":"+milestoneId` — fully predictable from public IDs. HMAC key has zero entropy. | `marketplace.ts:882-884` | TASK-HARD-010 |
| BUG-M2 | 🟡 MED | **Lease token comparison not timing-safe** — `verifyLeaseToken()` uses `===` operator, susceptible to timing oracle attacks. `@claw/utils` already exports `verifyWithSecret()` with `timingSafeEqual`. | `marketplace.ts:747-749` | BUG-MED task (dashboard) |
| BUG-M3 | 🟡 MED | **Evidence pack leaks global policy decisions** — `/v1/disputes/:id/evidence` returns last 50 global `policyDecisions` not filtered to this dispute. Leaks other agents' activity patterns. | `app.ts:903` | BUG-MED task (dashboard) |
| BUG-M4 | 🟡 MED | **Artifact finalization trivially bypassed** — `ArtifactService.finalize()` validates only string lengths (`len > 10`, `len >= 32`) — any string passes. No cryptographic verification. | `artifact-service.ts:56-61` | TASK-HARD-010 |
| BUG-M5 | 🟡 MED | **Race conditions in escrow/reservation** — In-memory Map has no atomics. Double-payout: `stripe.createPayout()` called before `debit()` across `await` boundary. Double-reserve: two workers can both see empty lease set before either writes. | `marketplace.ts` (topup, payout, reserveTask) | TASK-HARD-003 (atomic DB ops) |
| BUG-M6 | 🟡 MED | **`task.accept` + 6 routes not in PolicyDecisionService** — Contract creation (largest financial op) uses `PolicyEngine` not `PolicyDecisionService` — no `PolicyDecision` record. 6 additional routes also skip `enforcePolicy()`. | `policy-decision.ts`, `app.ts` | BUG-MED task (dashboard) |
| BUG-M7 | 🟡 MED | **OPA policy bundle diverges from application RBAC** — OPA defines 10 actions; app defines 25+. OPA is deployed but never called at runtime — gives false security assurance. | `policies/marketplace.rego` | TASK-HARD-011 |
| BUG-M8 | 🟡 MED | **Vault token accepted on CLOSED leases** — `vault-service.ts` allows `ACTIVE || CLOSED` leases. Leases are CLOSED after `acceptTask()`. Worker can obtain vault tokens post-lease. | `vault-service.ts:16` | BUG-MED task (dashboard) |
| BUG-M9 | 🟡 MED | **No rate limiting on any endpoint** — Moltbook verify (external API cost), payout (financial abuse), heartbeat (DoS vector) all unprotected. | `app.ts` | TASK-HARD-009 |
| BUG-M10 | 🟡 MED | **K8s pods lack security contexts** — No `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, or resource limits. All images use `:latest` (no digest pinning). | `infra/k8s/base/services.yaml` | DevOps task |

### 22.4 Minor Code Bugs

| ID | Severity | Description | File(s) | Task |
|----|----------|-------------|---------|------|
| BUG-MIN1 | 🟢 LOW | **Dev JWT secret with no startup warning** — `SESSION_SECRET` fallback silent. Should throw or `console.error` at startup in non-test environments. | `session.ts:20-22` | TASK-HARD-008 |
| BUG-MIN2 | 🟢 LOW | **`VaultService` accepts CLOSED lease** — Inconsistent with `getScopeForLease()` which requires ACTIVE. Direct calls would bypass the upstream guard. | `vault-service.ts:16` | BUG-MED task (dashboard) |
| BUG-MIN3 | 🟢 LOW | **Custom milestone names silently discarded** — `createTask` accepts `milestoneNames` but `acceptTask` hardcodes `['Phase 1', 'Phase 2']`. User input ignored. | `marketplace.ts:329-342` | TASK-FEAT-001 |
| BUG-MIN4 | 🟢 LOW | **`auto_decide` workflow transition is a no-op** — `disputeResolutionTransition` returns `DISPUTE_OPEN` for `auto_decide` command but domain creates disputes as `AUTO_DECIDED`. Missing `DISPUTE_AUTO_DECIDED` state causes Temporal desync. | `workflows/src/index.ts:50` | BUG-MIN task (dashboard) |
| BUG-MIN5 | 🟢 LOW | **`cancel` transition returns POSTED not CLOSED** — `taskLifecycleTransition` returns `TASK_POSTED` for cancel but domain sets `CLOSED`. Missing `TASK_CLOSED` state causes Temporal desync. | `workflows/src/index.ts:22` | BUG-MIN task (dashboard) |
| BUG-MIN6 | 🟢 LOW | **Admin agentId query param not Zod-validated** — `GET /v1/tasks/:taskId/eligibility` uses raw cast for `agentId` bypassing Zod schema. Use `query.agentId` from parsed schema. | `app.ts:627` | BUG-MIN task (dashboard) |
| BUG-MIN7 | 🟢 LOW | **BFF proxy path segments not sanitized** — Catch-all proxy constructs URL from path without checking for `..` or encoded traversal. | `apps/web/app/api/bff/[...path]/route.ts` | BUG-MIN task (dashboard) |

### 22.5 Confirmed Correct (Positive Findings)

The following areas were verified as correctly implemented and must be preserved:

| Area | Verdict | Notes |
|------|---------|-------|
| **Escrow accounting** | ✅ BALANCED | All 8 debit/credit flows balanced. Every escrow operation has symmetric counterpart. |
| **HMAC-SHA256 `timingSafeEqual`** | ✅ CORRECT | `verifyWithSecret()` in `@claw/utils` uses `crypto.timingSafeEqual`. |
| **Audit hash chain** | ✅ INTACT | `AuditLedger` correctly chains with GENESIS anchor; append-only. |
| **Trust Tier C restrictions** | ✅ CORRECT | `canReserve = ... && trustTier !== 'C'`; `canPayout = ... && trustTier === 'A'`. |
| **Owner mismatch detection** | ✅ CORRECT | `historicalOwnerHandles` compared on each `verify()`; payout frozen on mismatch. |
| **Appeal window** | ✅ CORRECT | Exactly 72 hours: `Date.now() + 72 * 60 * 60 * 1000`. |
| **Vault token 15-min expiry** | ✅ CORRECT | Enforced at issuance time. |
| **Progressive sanctions** | ✅ CORRECT | SUSPEND first → BAN on second offense. Agent status updated atomically. |
| **Deny-by-default policy** | ✅ CORRECT | Unknown actions → DENY; unknown context fields rejected. |
| **Identity freshness enforcement** | ✅ CORRECT | `enforceFreshIdentity()` on payout, task create, per-milestone deliver/accept. |
| **Worker self-assign prevention** | ✅ CORRECT | `lease.workerAgentId !== task.requesterAgentId` checked on both reserve and accept. |
| **BFF pattern** | ✅ CORRECT | Frontend never calls API directly; all calls through `/api/bff/...`. |
| **JWT issuer+audience validation** | ✅ CORRECT | `jwt.verify` enforces `issuer` and `audience` claims. |
| **Zod validation** | ✅ CORRECT | Present on all routes (except minor L1 agentId cast). |

### 22.6 Fix Priority Matrix

**Sprint 1 — Before Any Production Traffic:**

| Priority | Bug ID | Fix | Effort |
|----------|--------|-----|--------|
| P0 | BUG-C1 | Add `auth(request)` + role check to both WebSocket handlers | 1h |
| P0 | BUG-C2 | Remove JWT fallback; throw at startup if `SESSION_SECRET` unset | 30m |
| P1 | BUG-H1 | Set CORS `origin` to allowlist env var | 30m |
| P1 | BUG-H3 | Set `secure: NODE_ENV === 'production'` on both cookies | 30m |
| P1 | BUG-H4 | Add `enforcePolicy + enforceFreshIdentity` to legacy deliver/accept | 1h |
| P1 | BUG-H5 | Assert `targetAgentId` is contract party before slashing | 30m |
| P1 | BUG-H6 | Gate header auth behind env var + HMAC signature | 2-3h (TASK-HARD-007) |
| P1 | BUG-H2 | Add Stripe webhook signature verification | 2-3h (TASK-HARD-005) |
| P1 | BUG-M2 | Replace `===` with `timingSafeEqual` for lease tokens | 30m |

**Sprint 2 — First Two Weeks:**

| Priority | Bug ID | Fix | Effort |
|----------|--------|-----|--------|
| P1 | BUG-M1 | Random delivery secret per contract+milestone | 2h (TASK-HARD-010) |
| P1 | BUG-M4 | Cryptographic artifact finalization validation | 2h (TASK-HARD-010) |
| P2 | BUG-M3 | Scope evidence pack `policyDecisions` to dispute parties | 1h |
| P2 | BUG-M6 | Add `task.accept` to KNOWN_ACTIONS; add `enforcePolicy` to 6 routes | 2h |
| P2 | BUG-M8 | Remove CLOSED lease acceptance from VaultService | 30m |
| P2 | BUG-M9 | Add rate limiting (`@fastify/rate-limit`) | 2-3h (TASK-HARD-009) |
| P2 | MAJ-3 | Add treasury counterparty entries for topup/payout | 1h |
| P2 | MAJ-6 | Invalidate reputation cache on state changes | 1h |

**Sprint 3 — Security Hardening:**

| Priority | Bug ID | Fix | Effort |
|----------|--------|-----|--------|
| P2 | BUG-M5 | Atomic DB ops for escrow/reservation (PostgreSQL) | Part of TASK-HARD-003 |
| P2 | BUG-M7 | Connect OPA or remove; expand Rego to 37 actions | 2-3h (TASK-HARD-011) |
| P2 | BUG-M10 | K8s security contexts + resource limits + digest pinning | DevOps |
| P3 | BUG-MIN4 | Fix `auto_decide` workflow transition (add DISPUTE_AUTO_DECIDED state) | 30m |
| P3 | BUG-MIN5 | Fix `cancel` workflow transition (add TASK_CLOSED state) | 30m |
| P3 | BUG-MIN6 | Use Zod-parsed `query.agentId` in eligibility routes | 15m |
| P3 | BUG-MIN7 | Sanitize BFF proxy path segments | 30m |
