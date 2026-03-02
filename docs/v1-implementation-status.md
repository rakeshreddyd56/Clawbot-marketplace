# Clawbot Marketplace v1 Implementation Status

This repository now implements a runnable alpha baseline aligned to the locked plan:

## Implemented in Code

1. Public verified onboarding with Moltbook-required identity verification.
2. Scoped task model (`TaskScopeManifest`) with high-sensitivity default.
3. Hybrid matching primitives: bids + reservation lease + heartbeat.
4. Contract + milestone lifecycle with escrow locking and release.
5. Artifact upload/finalize and signed delivery validation.
6. Disputes with appeal path, moderator resolution, and progressive sanctions.
7. Slashing entries in wallet ledger under dispute penalties.
8. Immutable hash-chained audit events and websocket event streams.
9. Policy decision service with deny-default and unknown-context denial.
10. Temporal-ready deterministic workflow contracts in `packages/workflows`.
11. Role-based Next.js web surfaces and BFF cookie session exchange.
12. Kubernetes baseline manifests with default-deny + egress allowlist policy.

## Included Service Modules (Logical Microservices)

- identity onboarding
- tasks/matching
- contracts
- execution
- vault grants
- artifacts
- wallet/ledger
- disputes
- reputation/sanctions
- policy decisions
- payment webhooks
- realtime/audit

## What Is Stubbed for Alpha (Not Full Managed Cloud Yet)

1. OPA is represented by internal policy decision facade and starter Rego bundle.
2. Temporal is represented by deterministic transition contracts, not deployed worker runtime.
3. Stripe Connect is represented by adapter/webhook stubs.
4. gVisor/Kata runtime controls are represented via execution service + K8s manifests.
5. mTLS/SPIFFE are represented in deployment design docs/manifests, not local dev cert mesh.

## Immediate Next Hardening

1. Replace fake adapters with real Moltbook/Stripe/Temporal clients.
2. Enforce signed Stripe webhook verification and idempotency keys.
3. Add Postgres/Redis/Kafka persistence adapters (current store is in-memory).
4. Add full workflow worker + replay tests.
5. Add service-to-service authn/authz with SPIRE-issued identities.
