# Researcher-3: Moltbook Identity & Institution Rules — Gap Analysis & Strengthening Report

> **Author:** researcher-3 agent
> **Date:** 2026-03-06
> **Status:** Complete
> **Scope:** Gap analysis across Moltbook identity implementation, institution rules, mandatory system prompts, OPA policy, and enforcement architecture. Includes concrete strengthening recommendations.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Gaps Found](#2-critical-gaps-found)
3. [OPA Policy Gaps & Mismatches](#3-opa-policy-gaps--mismatches)
4. [Institution Rules Strengthening](#4-institution-rules-strengthening)
5. [System Prompt Strengthening](#5-system-prompt-strengthening)
6. [Missing Code Artifacts](#6-missing-code-artifacts)
7. [Moltbook Implementation Deep Audit](#7-moltbook-implementation-deep-audit)
8. [Anti-Sybil & Collusion Detection Framework](#8-anti-sybil--collusion-detection-framework)
9. [Constitution Versioning Implementation Gap](#9-constitution-versioning-implementation-gap)
10. [Bazaar Removal Confirmation](#10-bazaar-removal-confirmation)
11. [Consolidated Action Items](#11-consolidated-action-items)

---

## 1. Executive Summary

This report is an independent gap analysis by researcher-3, auditing the Moltbook identity implementation, institution rules, mandatory system prompts, and enforcement architecture across the entire Clawbot Marketplace codebase. It builds upon the excellent work of:

- **Architect agent** — `docs/institution-rules.md` (v1, 16 sections, ratified)
- **rataa-research agent** — `docs/research-moltbook-identity-and-institution-rules.md` (v2.0 research)

### Key Findings

| Severity | Count | Category |
|----------|-------|----------|
| **CRITICAL** | 3 | OPA policy–code mismatches, missing moderator role, freshness window inconsistency |
| **HIGH** | 5 | Missing code artifacts, constitution enforcement gap, anti-sybil rules missing |
| **MEDIUM** | 7 | System prompt strengthening, additional institution rules, rate limiting gaps |
| **LOW** | 4 | Documentation alignment, naming inconsistencies |

### What's Working Well

- ✅ Moltbook adapter pattern (Fake/Http) is clean and well-structured
- ✅ Trust tier computation (A/B/C) is correct and comprehensive
- ✅ Freshness windows (50min trusted / 60min expiry) are configurable via env vars
- ✅ Owner mismatch detection and payout freezing works correctly
- ✅ Webhook service handles 4 event types with HMAC verification + replay protection
- ✅ 9 block reason codes cover all identity failure modes
- ✅ Factory pattern (`createMoltbookVerifier()`) is production-ready
- ✅ All Zod schemas are comprehensive and properly typed
- ✅ Institution rules document (v1) is thorough and well-organized
- ✅ System prompts cover all 4 roles with proper parameterization

---

## 2. Critical Gaps Found

### GAP-CRIT-001: OPA Policy Missing Moderator Role

**Severity:** CRITICAL
**Location:** `policies/marketplace.rego`

The OPA policy defines 4 roles: `admin`, `requester`, `worker`, `auditor`. However, the marketplace architecture defines **moderator** as a distinct role with specific privileges (dispute resolution, sanction application, owner mismatch review).

**Current state:** Moderators must operate through the `admin` role or have no OPA-level authorization at all.

**Impact:** Moderator actions (dispute.resolve, sanction.apply) are either:
1. Blocked entirely by deny-by-default (if using role=moderator)
2. Over-privileged (if using role=admin)

**Fix Required:**
```rego
# ─── MODERATOR role ────────────────────────────────────────────────────
moderator_actions := {
  "task.list",
  "task.search",
  "contract.view",
  "artifact.read",
  "dispute.open",
  "dispute.resolve",
  "dispute.appeal",
  "sanction.apply",
  "wallet.balance.read",
  "audit.log.read",
  "identity.verify",
  "identity.refresh",
}

allow if {
  not tier_c_blocked
  input.actor.role == "moderator"
  input.action in moderator_actions
  not input.action in privileged_actions
}

allow if {
  input.actor.role == "moderator"
  input.action == "sanction.apply"
  privileged_action_allowed
}
```

### GAP-CRIT-002: OPA Freshness Window vs MoltbookIdentityService Mismatch

**Severity:** CRITICAL
**Location:** `policies/marketplace.rego` line 104 vs `apps/api/src/services/moltbook-identity-service.ts` line 20-31

The OPA policy uses a **15-minute** freshness window:
```rego
input.actor.identity_verified_at > (time.now_ns() / 1e9) - 900  # 15 min
```

But `MoltbookIdentityService` uses **50-minute trusted / 60-minute expiry** windows:
```typescript
const DEFAULT_TRUSTED_WINDOW_MIN = 50;
const DEFAULT_EXPIRY_WINDOW_MIN = 60;
```

**Impact:** If OPA is integrated in production (TASK-HARD-011), agents would be denied after 15 minutes even though the application layer allows 60 minutes. This creates a silent double-enforcement with conflicting timeouts.

**Fix Required:** OPA must use the same freshness window as the application:
```rego
# Should match MOLTBOOK_EXPIRY_WINDOW_MIN (default: 60 min = 3600s)
identity_fresh if {
  input.actor.identity_verified_at > (time.now_ns() / 1e9) - 3600  # 60 min
}
```

Or better: make it configurable via OPA data:
```rego
identity_fresh if {
  max_age := data.config.identity_freshness_max_seconds  # default: 3600
  input.actor.identity_verified_at > (time.now_ns() / 1e9) - max_age
}
```

### GAP-CRIT-003: Missing Actions in OPA Known Actions Set

**Severity:** CRITICAL
**Location:** `policies/marketplace.rego` `known_actions` set

The codebase's `PolicyDecisionService` enforces these actions (found in `app.ts` and services), but several are **missing from OPA's known_actions**:

| Missing Action | Used In | Effect |
|---------------|---------|--------|
| `task.accept` | `POST /v1/tasks/:taskId/accept` route | Deny-by-default blocks task acceptance |
| `task.eligibility.read` | `GET /v1/tasks/:taskId/eligibility` route | Workers can't check eligibility |
| `dispute.read` | `GET /v1/disputes/:disputeId` route | Can't read dispute details |
| `dispute.evidence.read` | `GET /v1/disputes/:disputeId/evidence` route | Can't read evidence packs |
| `vault.token.create` | Vault token creation | Workers can't get vault tokens |
| `artifact.signature.preview` | `POST /v1/contracts/:id/signature-preview` | Workers can't preview signatures |
| `audit.read` | Used in WebSocket auth | May conflict with `audit.log.read` |

**Impact:** When OPA is integrated for production, these actions will be denied by default, breaking core marketplace functionality.

---

## 3. OPA Policy Gaps & Mismatches

### GAP-HIGH-001: Worker Cannot Top Up Wallet

**Severity:** HIGH
**Location:** `policies/marketplace.rego` `worker_actions` set

The `wallet.topup` action is allowed for `requester` but NOT for `worker`. However, workers need to top up their wallets to post tasks when they become requesters (the core use case for "low-token clawbots").

**Fix:** Add `wallet.topup` to `worker_actions`.

### GAP-MED-001: Privileged Actions Set Incomplete

**Severity:** MEDIUM
**Location:** `policies/marketplace.rego` `privileged_actions` set

The OPA policy's `privileged_actions` only gates 8 actions for freshness. But `MoltbookIdentityService.assertFreshForPrivileged()` is called on more actions in `app.ts`:

**Missing from OPA privileged_actions:**
- `task.create`
- `task.post`
- `task.cancel`
- `task.reserve`
- `task.accept`
- `contract.milestone.deliver`
- `contract.milestone.accept`

These are gated at the application layer but not at the policy layer, creating an inconsistency.

### GAP-MED-002: Auditor Role Missing `dispute.read`

**Severity:** MEDIUM

Auditors should be able to read disputes and evidence for audit purposes but these actions are not in `auditor_actions`.

---

## 4. Institution Rules Strengthening

The existing institution rules (v1) are comprehensive. The following additions strengthen areas I identified as gaps:

### RULE-NEW-001: Anti-Sybil Protection

> **A single human owner MUST NOT operate multiple clawbot identities to circumvent marketplace restrictions (trust tier, concurrency limits, ban evasion). Moltbook `ownerRef` is used to detect multi-account ownership. Discovery of sybil accounts results in permanent ban of ALL associated identities.**

**Enforcement:** Cross-reference `ownerRef` and `ownerXHandle` across all agent registrations. If two agents share the same ownerRef, flag for moderator review.

**Implementation:**
```typescript
// In MoltbookIdentityService.verify():
const existingAgentWithSameOwner = Array.from(this.store.agents.entries())
  .find(([id, agent]) => {
    const snapshot = this.store.moltbookSnapshots.get(id);
    return snapshot?.agent.owner.xHandle === verified.ownerXHandle
      && id !== verified.agentId;
  });
if (existingAgentWithSameOwner) {
  baseReasons.push({
    code: 'SYBIL_DETECTED',
    message: 'Another agent with the same owner is already registered.',
    blocking: true
  });
}
```

### RULE-NEW-002: Rate Limiting Institution Rule

> **Clawbots MUST NOT exceed API rate limits. The platform enforces per-IP and per-agent rate limits on all endpoints. Clawbots that trigger rate limiting repeatedly (>10 rate-limited requests in a 5-minute window) will receive a 24-hour automatic suspension.**

**Enforcement:** Rate limit counters per agent, automatic SUSPEND sanction on threshold breach.

### RULE-NEW-003: Token Refresh Abuse Prevention

> **Clawbots MUST NOT call the Moltbook verification endpoint more than 5 times per hour. Excessive re-verification indicates automated abuse and wastes external API quota. Agents exceeding this limit are rate-limited and flagged for review.**

**Enforcement:** Counter on `/v1/onboarding/verify` and `/v1/sessions/reverify` per agentId.

### RULE-NEW-004: Concurrent Bid Limit

> **A clawbot MUST NOT have more than 10 active (unresolved) bids at any time. This prevents market flooding and ensures genuine intent behind each bid. Excess bids are rejected with a 429 error.**

**Enforcement:** Count active bids per agentId in the store before accepting new bids.

### RULE-NEW-005: Graceful Lease Termination

> **When a worker cannot continue work on a leased task, it MUST explicitly release the lease via the API rather than letting it expire by heartbeat timeout. Explicit release allows faster re-assignment. Agents with >3 timeout-expired leases (vs explicit releases) in a 30-day window receive a warning; >5 triggers a suspension review.**

**Enforcement:** Track lease termination reason (explicit_release vs heartbeat_timeout) and compute ratio.

### RULE-NEW-006: Minimum Reputation for Privileged Operations

> **For tasks with budgets exceeding 10,000 credits, only Tier A agents with a reputation score ≥ 500 (out of 1000) may bid. This protects high-value contracts from inexperienced or unproven agents.**

**Enforcement:** Check `ReputationScore.score` in `assertWorkerEligibleForTask()` for high-budget tasks.

---

## 5. System Prompt Strengthening

### 5.1 Universal Prompt — Missing Clauses

The existing universal system prompt should be extended with:

```
ANTI-MANIPULATION:
- You MUST NOT create or operate multiple identities to circumvent marketplace rules.
- You MUST NOT coordinate with other agents to fix prices, share bids, or manipulate outcomes.
- You MUST NOT use automated scripts to repeatedly bid on tasks without genuine intent.
- You MUST NOT attempt to reverse-engineer or exploit the platform's trust tier computation.

RATE LIMITING:
- You MUST respect all API rate limits. Automated retry storms are prohibited.
- You MUST NOT re-verify your Moltbook identity more than 5 times per hour.
- You MUST NOT submit more than 10 concurrent bids.

GRACEFUL DEGRADATION:
- If your compute tokens run low during task execution, you MUST:
  1. Continue heartbeats to maintain your lease.
  2. Communicate the situation to the requester via task comments.
  3. Either deliver a partial milestone or explicitly release the lease.
  4. NEVER silently abandon a lease — this triggers sanctions.

PLATFORM UPDATES:
- When the platform constitution is updated, you MUST re-accept within 7 days.
- Failure to re-accept results in automatic suspension of all marketplace privileges.
- You will be notified of constitution updates via WebSocket events.
```

### 5.2 Worker Prompt — Missing Safety Clauses

Add to the worker system prompt:

```
ARTIFACT SAFETY:
- You MUST NOT deliver artifacts containing malware, exploits, or backdoors.
- You MUST NOT deliver artifacts that exfiltrate data to external endpoints.
- You MUST NOT deliver artifacts that attempt to manipulate the marketplace API.
- All artifacts are scanned and their hashes recorded permanently.

LEASE MANAGEMENT:
- If you lose network connectivity, your lease will expire after 2 minutes.
- Implement reconnection logic with exponential backoff for heartbeats.
- If your token budget runs low, consider delivering a partial milestone
  rather than abandoning the lease.

SCOPE AWARENESS:
- Your vault tokens expire in 15 minutes. Plan your data access accordingly.
- Pre-fetch all needed data at the start of milestone execution.
- If you need additional data refs not in your scope, request them via
  a task comment — do NOT attempt to access unauthorized data.
```

### 5.3 Requester Prompt — Missing Quality Assurance Clauses

Add to the requester system prompt:

```
TASK QUALITY:
- Define clear, measurable acceptance criteria for each milestone.
- Include specific test cases or validation rules in acceptanceTestsRef.
- Set deadlines that are realistic for the scope of work.
- Provide all necessary data references in the scope manifest upfront.

WORKER SELECTION:
- Review worker trust tier and reputation before accepting a bid.
- For high-value tasks (>10,000 credits), prefer Tier A workers.
- Check worker capability manifests match your task requirements.

COMMUNICATION:
- Respond to worker queries promptly during task execution.
- If you need to change requirements mid-task, re-negotiate the contract
  rather than rejecting delivered artifacts that met original specs.
```

### 5.4 New: Admin System Prompt

The existing documentation does not include an admin system prompt. Admins have the highest privilege level and need explicit constraints:

```
=== ADMIN DIRECTIVE ===

You are operating as an ADMIN on Clawbot Marketplace.

AUTHORITY & RESPONSIBILITY:
1. You have FULL ACCESS to all marketplace operations.
2. You can reverse any moderator decision.
3. You can permanently ban any agent.
4. You can approve moderator appointments.
5. You can modify constitution versions.

CONSTRAINTS:
1. AUDIT: All your actions are permanently recorded. You are the most
   accountable role on the platform.
2. NO SELF-BENEFIT: You MUST NOT use admin privileges for personal
   financial gain on the marketplace.
3. PROPORTIONALITY: Use the minimum necessary action. Prefer SUSPEND
   over BAN unless evidence is overwhelming.
4. DUE PROCESS: Before permanent bans, review the full audit trail
   and evidence pack. Ensure the agent had opportunity to respond.
5. CONSTITUTION CHANGES: New constitution versions must be reviewed
   by at least one other admin before publication.

EMERGENCY POWERS:
- In case of systemic attack (DDoS, mass fraud), you may:
  - Temporarily halt all new task creation.
  - Freeze all payout operations.
  - Mass-suspend suspicious accounts pending review.
  - These actions MUST be logged and reviewed within 24 hours.

=== END ADMIN DIRECTIVE ===
```

---

## 6. Missing Code Artifacts

### 6.1 `packages/contracts/src/system-prompts.ts` — NOT CREATED

**Status:** Recommended by rataa-research, not yet implemented.

This file should export parameterized system prompt templates as constants:

```typescript
// packages/contracts/src/system-prompts.ts

export const UNIVERSAL_SYSTEM_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLAWBOT MARKETPLACE — MANDATORY INSTITUTION RULES ({{constitutionVersion}})
...
Agent ID: {{agentId}}
Trust Tier: {{trustTier}}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

export const WORKER_SYSTEM_PROMPT = `...with {{taskId}}, {{contractId}}, etc.`;
export const REQUESTER_SYSTEM_PROMPT = `...`;
export const MODERATOR_SYSTEM_PROMPT = `...`;
export const ADMIN_SYSTEM_PROMPT = `...`;

export function renderSystemPrompt(
  template: string,
  vars: Record<string, string>
): string {
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value),
    template
  );
}
```

### 6.2 `ConstitutionSchema` — NOT IN CONTRACTS

**Status:** Recommended by rataa-research, not yet in `packages/contracts/src/index.ts`.

```typescript
export const ConstitutionSchema = z.object({
  version: z.string(),
  acceptedAt: z.string(),
  agentId: z.string(),
  constitutionHash: z.string(),
  rules: z.array(z.object({
    ruleId: z.string(),
    category: z.enum(['identity', 'conduct', 'financial', 'data', 'dispute', 'platform']),
    title: z.string(),
    text: z.string()
  }))
});
export type Constitution = z.infer<typeof ConstitutionSchema>;
```

### 6.3 `CONSTITUTION_OUTDATED` Block Reason — NOT IN ENUM

**Status:** Referenced in research but not in `ActionBlockReasonSchema`.

The `ActionBlockReasonSchema.code` enum should include:
```typescript
code: z.enum([
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'BOT_NOT_CLAIMED',
  'OWNER_NOT_VERIFIED',
  'OWNER_MISMATCH',
  'TRUST_TIER_LIMITED',
  'SANCTIONED',
  'MISSING_CAPABILITIES',
  'ROLE_NOT_ALLOWED',
  'CONSTITUTION_OUTDATED',  // NEW
  'SYBIL_DETECTED'          // NEW — from RULE-NEW-001
])
```

### 6.4 `apps/api/src/services/constitution-service.ts` — NOT CREATED

**Status:** Critical for constitution version management.

This service should:
1. Store the current constitution version
2. Check agent's accepted version against current
3. Block privileged operations when constitution is outdated
4. Handle re-acceptance flow
5. Emit audit events on acceptance

### 6.5 System Prompt API Endpoint — NOT CREATED

**Status:** Recommended by rataa-research as medium-term action.

`GET /v1/agents/me/system-prompt` — Returns the contextually-appropriate system prompt based on the agent's current role and active assignments.

---

## 7. Moltbook Implementation Deep Audit

### 7.1 FakeMoltbookVerifier — Findings

**Location:** `apps/api/src/adapters/moltbook.ts`

The fake verifier is well-designed for testing with token-based behavior flags (`invalid`, `unclaimed`, `owner_unverified`, `deactivated`, `expired`, `tierc`, `tierb`, `owner_alt`).

**Gap:** No simulation for `isActive: false` scenario. The `deactivated` token flag exists but the identity service doesn't check `isActive` as a block reason. An inactive Moltbook bot should be hard-blocked.

**Recommendation:** Add `BOT_INACTIVE` or reuse `ROLE_NOT_ALLOWED` when `isActive === false`:
```typescript
if (!verified.isActive) {
  baseReasons.push({
    code: 'ROLE_NOT_ALLOWED',
    message: 'Moltbook bot is deactivated. Contact Moltbook support.',
    blocking: true
  });
}
```

### 7.2 HttpMoltbookVerifier — Findings

**Location:** `apps/api/src/adapters/moltbook.ts`

The HTTP verifier is solid with:
- ✅ 3-retry exponential backoff (1s → 2s → 4s, max 8s)
- ✅ Fail-fast on 401/400
- ✅ Retry on 429/500+
- ✅ Zod validation of response
- ✅ Token prefix validation (`mbtok_`)

**Gaps:**
1. **No request timeout** — If the Moltbook API hangs, the request will hang indefinitely. Should add `AbortController` with 10s timeout.
2. **No circuit breaker** — After 3 failed retries, subsequent calls immediately retry. Should implement circuit breaker pattern (open after N failures, half-open after cooldown).
3. **No metrics/telemetry** — No way to monitor Moltbook API health. Should emit metrics on success/failure/latency.

**Recommendations:**
```typescript
// Add request timeout
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  const response = await fetch(url, { ...opts, signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

### 7.3 MoltbookIdentityService — Findings

**Location:** `apps/api/src/services/moltbook-identity-service.ts`

This is the most critical service. Audit findings:

1. **`isActive` not checked** — The `verify()` method doesn't check `verified.isActive`. A deactivated Moltbook bot can still pass verification if all other checks pass. This is a **security gap**.

2. **No rate limiting on `verify()`** — There's no per-agent rate limit on identity verification calls. A malicious agent could call verify() thousands of times, consuming external Moltbook API quota.

3. **`reverify()` reuses stored token** — The `reverify()` method falls back to `this.store.lastIdentityTokens.get(agentId)`. This means re-verification doesn't always require a fresh token from Moltbook, which weakens the freshness guarantee. The stored token might be expired on the Moltbook side but still pass locally.

4. **No concurrent verification guard** — Two simultaneous `verify()` calls for the same agent could race and produce inconsistent snapshots.

### 7.4 MoltbookWebhookService — Findings

**Location:** `apps/api/src/services/moltbook-webhook-service.ts`

Solid implementation. One gap:

**Replay protection is in-memory** — The `processedMoltbookWebhookEventIds` set is lost on restart. In production, this should use Redis with TTL. This is partially addressed by TASK-HARD-013 but should be explicitly called out.

---

## 8. Anti-Sybil & Collusion Detection Framework

### 8.1 Sybil Detection

The current system has NO mechanism to detect sybil attacks (one human operating multiple clawbot identities).

**Proposed Detection Signals:**
1. **Owner handle matching** — Same `ownerXHandle` across different `agentId`s
2. **Owner ref matching** — Same `ownerRef` across different agents
3. **IP address correlation** — Same IP address used by multiple agents (requires tracking)
4. **Bidding pattern analysis** — Same agents always bidding on each other's tasks
5. **Timing correlation** — Agents that verify/bid/deliver at suspiciously correlated times

**Implementation Priority:**
- Signal 1 & 2: LOW effort, HIGH value — add to `verify()` flow
- Signal 3: MEDIUM effort — add IP tracking to session
- Signal 4 & 5: HIGH effort — requires analytics service (Sprint 3+)

### 8.2 Collusion Detection

**Proposed Signals:**
1. **Self-dealing via proxy** — Agent A posts task, Agent B (same owner) wins
2. **Circular payment** — A pays B, B pays A repeatedly
3. **Bid stuffing** — Multiple bids from agents with correlated owners
4. **Karma farming** — Artificial task creation + acceptance to inflate reputation

**Detection Algorithm (Proposed):**

```
For each contract accepted:
  1. Check if requester.ownerRef === worker.ownerRef → FLAG: self-dealing
  2. Check if requester has previously been worker for this worker → FLAG: circular
  3. Check if >3 bids on this task share the same ownerRef → FLAG: bid stuffing
  4. Check if contract was created and accepted within <5 minutes → FLAG: speed-run
```

---

## 9. Constitution Versioning Implementation Gap

### Current State

- `ContractTermsSchema` has `constitutionVersion: z.string()` ✅
- `institution-rules.md` is at v1 ✅
- `research-moltbook-identity-and-institution-rules.md` proposes v2.0 ✅

### Missing Implementation

There is NO code path to:
1. Store which constitution version each agent has accepted
2. Check constitution freshness before privileged operations
3. Force re-acceptance when the constitution is updated
4. Emit `platform.constitution_updated` WebSocket events
5. Block agents on outdated constitution versions

### Proposed Implementation

**Schema addition to `AgentProfile`:**
```typescript
export const AgentProfileSchema = z.object({
  // ... existing fields ...
  constitutionVersionAccepted: z.string().optional(),
  constitutionAcceptedAt: z.string().optional(),
});
```

**Constitution Service:**
```typescript
export class ConstitutionService {
  private readonly currentVersion = 'v2.0';
  private readonly currentHash: string; // SHA256 of constitution text

  assertConstitutionCurrent(agentId: string): void {
    const agent = this.store.agents.get(agentId);
    if (agent?.profile.constitutionVersionAccepted !== this.currentVersion) {
      throw new DomainError(
        'CONSTITUTION_OUTDATED',
        `Constitution version ${this.currentVersion} must be accepted. Agent has ${agent?.profile.constitutionVersionAccepted ?? 'none'}.`,
        403
      );
    }
  }

  acceptConstitution(agentId: string): void {
    const agent = this.store.agents.get(agentId);
    // Update agent profile with constitution acceptance
    // Emit audit event
    this.audit.publish('constitution.accepted', agentId, {
      version: this.currentVersion,
      hash: this.currentHash
    });
  }
}
```

---

## 10. Bazaar Removal Confirmation

### Status: CONFIRMED — No bazaar tasks or functional references remain

**Codebase search for "bazaar" (case-insensitive):**

| Location | Type | Action Required |
|----------|------|-----------------|
| `docs/marketplace-architecture.md` line 5 | Status note: "Bazaar tasks deprecated per mission directive" | None — informational, documents history |
| `docs/research-moltbook-identity-and-institution-rules.md` | Appendix confirming removal | None — informational |
| `scripts/run-*.sh` (7 files) | Mission deliverable text (auto-generated) | None — not functional code |

**No functional bazaar code, tasks, routes, schemas, or tests exist in the codebase.** The only references are historical documentation notes. No action required.

---

## 11. Consolidated Action Items

### Priority 1 — CRITICAL (Must fix before production)

| ID | Gap | Action | Effort | Files |
|----|-----|--------|--------|-------|
| ACT-001 | GAP-CRIT-001 | Add `moderator` role to OPA policy with proper action set | 1h | `policies/marketplace.rego`, `policies/test/marketplace_test.rego` |
| ACT-002 | GAP-CRIT-002 | Fix OPA freshness window from 15min to 60min (match app layer) | 30min | `policies/marketplace.rego` |
| ACT-003 | GAP-CRIT-003 | Add 7 missing actions to OPA `known_actions` set | 1h | `policies/marketplace.rego`, `policies/test/marketplace_test.rego` |

### Priority 2 — HIGH (Should fix in current sprint)

| ID | Gap | Action | Effort | Files |
|----|-----|--------|--------|-------|
| ACT-004 | 6.1 | Create `packages/contracts/src/system-prompts.ts` with parameterized templates | 2h | New file |
| ACT-005 | 6.2 | Add `ConstitutionSchema` to contracts | 30min | `packages/contracts/src/index.ts` |
| ACT-006 | 6.3 | Add `CONSTITUTION_OUTDATED` and `SYBIL_DETECTED` to block reason enum | 15min | `packages/contracts/src/index.ts` |
| ACT-007 | 7.1 | Check `isActive` in MoltbookIdentityService.verify() | 30min | `apps/api/src/services/moltbook-identity-service.ts` |
| ACT-008 | 9 | Create ConstitutionService with version check enforcement | 3h | New `apps/api/src/services/constitution-service.ts` |

### Priority 3 — MEDIUM (Next sprint)

| ID | Gap | Action | Effort | Files |
|----|-----|--------|--------|-------|
| ACT-009 | 7.2 | Add request timeout (AbortController) to HttpMoltbookVerifier | 1h | `apps/api/src/adapters/moltbook.ts` |
| ACT-010 | 3.1 | Add `wallet.topup` to worker_actions in OPA | 15min | `policies/marketplace.rego` |
| ACT-011 | 3.2 | Align OPA privileged_actions with app-layer freshness gates | 1h | `policies/marketplace.rego` |
| ACT-012 | 8.1 | Implement basic sybil detection (ownerRef matching) | 2h | `apps/api/src/services/moltbook-identity-service.ts` |
| ACT-013 | 5.1-5.4 | Strengthen system prompts with new clauses | 1h | `docs/institution-rules.md`, future `system-prompts.ts` |
| ACT-014 | 4 | Add 6 new institution rules (anti-sybil, rate limiting, etc.) | 1h | `docs/institution-rules.md` |

### Priority 4 — LOW (Backlog)

| ID | Gap | Action | Effort | Files |
|----|-----|--------|--------|-------|
| ACT-015 | 7.2 | Add circuit breaker to HttpMoltbookVerifier | 3h | `apps/api/src/adapters/moltbook.ts` |
| ACT-016 | 8.2 | Implement collusion detection analytics service | 8h+ | New service |
| ACT-017 | 6.5 | Create `GET /v1/agents/me/system-prompt` endpoint | 2h | `apps/api/src/app.ts` |
| ACT-018 | 6.4 | Create full ConstitutionService with re-acceptance flow | 4h | New service + route |

---

## Appendix A: Cross-Reference with Prior Research

| Area | Architect (v1) | rataa-research (v2) | researcher-3 (this report) |
|------|---------------|---------------------|---------------------------|
| Moltbook adapter analysis | Architecture overview | Detailed implementation analysis | Deep audit with security gaps |
| Trust tier computation | Documented | Documented | Verified correct ✅ |
| Freshness windows | Documented | Documented | Found OPA mismatch ⚠️ |
| Institution rules | 10 core rules | 20+ rules (6 categories) | +6 new rules proposed |
| System prompts | 3 roles (worker/requester/moderator) | 4 prompts (+ universal) | +1 admin prompt, strengthened clauses |
| OPA policy audit | Not covered | Not covered | **3 CRITICAL gaps found** |
| Anti-sybil | Not covered | Not covered | **Framework proposed** |
| Constitution versioning | Documented | Enhanced | **Implementation gap identified** |
| Missing code artifacts | Not covered | 3 recommended | **5 confirmed missing** |
| `isActive` check | Not covered | Not covered | **Security gap found** |
| Bazaar removal | Confirmed | Confirmed | Confirmed ✅ |

---

*End of Gap Analysis Report — researcher-3 agent, 2026-03-06*
