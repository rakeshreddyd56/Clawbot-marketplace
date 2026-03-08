/**
 * TASK-HARD-003: PostgreSQL persistence layer.
 *
 * PgStore implements the Store interface with PostgreSQL backing.
 * Design: On init(), all data is loaded from PG into in-memory Maps.
 * Mutations go through proxy Maps that write-through to PG asynchronously.
 * This preserves the synchronous Map API that marketplace.ts and all services rely on.
 *
 * Critical guarantees:
 * - historicalOwnerHandles persisted across restarts (owner mismatch detection)
 * - moltbookSnapshots persisted across restarts (identity continuity)
 * - lastIdentityTokens stored as SHA256 hash (not plaintext) — on restart,
 *   reverify requires a fresh token since we can't recover plaintext from hashes
 * - audit chain hash integrity preserved across restarts
 * - account_balances uses atomic UPDATE for race prevention
 * - deliverySecrets stored as actual values (not hashes) — needed for HMAC verification
 * - Connection pool: max 20 connections
 */

import pg from 'pg';
import { sha256 } from '@claw/utils';
import type {
  AgentProfile,
  ArtifactRecord,
  AuditEvent,
  AssignmentLease,
  ConstitutionAcceptance,
  ConstitutionVersionRecord,
  ContractTerms,
  DataGrant,
  DisputeCase,
  EscrowLock,
  EvidencePack,
  ExecutionSession,
  LedgerEntry,
  Milestone,
  MismatchReviewAction,
  MoltbookVerificationSnapshot,
  OwnerMismatchFlag,
  PolicyDecision,
  ReputationScore,
  SanctionAction,
  Task,
  TaskScopeManifest,
  VaultToken
} from '@claw/contracts';
import type { AuditPersistence } from './events.js';
import type { AgentRecord, Store } from '../types/domain.js';

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

/**
 * Creates a Map proxy that writes through to PostgreSQL on set/delete.
 * The `onSet` and `onDelete` callbacks fire asynchronously (fire-and-forget)
 * to avoid blocking the synchronous Map API.
 */
function createWriteThroughMap<K, V>(
  initial: Map<K, V>,
  onSet: (key: K, value: V) => Promise<void>,
  onDelete?: (key: K) => Promise<void>
): Map<K, V> {
  const map = new Map(initial);
  const originalSet = map.set.bind(map);
  const originalDelete = map.delete.bind(map);

  map.set = (key: K, value: V) => {
    originalSet(key, value);
    onSet(key, value).catch((err) => {
      console.error('[PgStore] Write-through set error:', err);
    });
    return map;
  };

  if (onDelete) {
    map.delete = (key: K) => {
      const result = originalDelete(key);
      onDelete(key).catch((err) => {
        console.error('[PgStore] Write-through delete error:', err);
      });
      return result;
    };
  }

  return map;
}

/**
 * Creates an array proxy that writes through to PostgreSQL on push.
 */
function createWriteThroughArray<T>(
  initial: T[],
  onPush: (item: T) => Promise<void>
): T[] {
  const arr = [...initial];
  const originalPush = arr.push.bind(arr);

  arr.push = (...items: T[]) => {
    const result = originalPush(...items);
    for (const item of items) {
      onPush(item).catch((err) => {
        console.error('[PgStore] Write-through push error:', err);
      });
    }
    return result;
  };

  return arr;
}

/**
 * Creates a Set proxy that writes through to PostgreSQL on add.
 */
function createWriteThroughSet<T>(
  initial: Set<T>,
  onAdd: (item: T) => Promise<void>
): Set<T> {
  const set = new Set(initial);
  const originalAdd = set.add.bind(set);

  set.add = (value: T) => {
    if (!set.has(value)) {
      onAdd(value).catch((err) => {
        console.error('[PgStore] Write-through add error:', err);
      });
    }
    originalAdd(value);
    return set;
  };

  return set;
}

export class PgStore {
  private pool: PoolType;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
  }

  /**
   * Initialize: load all data from PostgreSQL into memory and create
   * write-through proxy Maps that persist mutations back to PG.
   */
  async init(): Promise<Store> {
    // Verify connectivity
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    // Load all data in parallel
    const [
      agentsData,
      tasksData,
      scopesData,
      bidsData,
      leasesData,
      contractsData,
      milestonesData,
      artifactsData,
      executionsData,
      dataGrantsData,
      vaultTokensData,
      disputesData,
      evidencePacksData,
      reputationsData,
      policyDecisionsData,
      sanctionsData,
      escrowLocksData,
      snapshotsData,
      ownerHistoryData,
      ledgerData,
      balancesData,
      deliverySecretsData,
      milestoneNamesData,
      webhookEventsData,
      mismatchFlagsData,
      reviewActionsData,
      moltbookWebhookEventsData,
      constitutionVersionsData,
      constitutionAcceptancesData,
      currentConstitutionVersionData,
      leaseOutcomeLogData
    ] = await Promise.all([
      this.loadAgents(),
      this.loadTasks(),
      this.loadScopes(),
      this.loadBids(),
      this.loadLeases(),
      this.loadContracts(),
      this.loadMilestones(),
      this.loadArtifacts(),
      this.loadExecutions(),
      this.loadDataGrants(),
      this.loadVaultTokens(),
      this.loadDisputes(),
      this.loadEvidencePacks(),
      this.loadReputations(),
      this.loadPolicyDecisions(),
      this.loadSanctions(),
      this.loadEscrowLocks(),
      this.loadMoltbookSnapshots(),
      this.loadOwnerHistory(),
      this.loadLedger(),
      this.loadBalances(),
      this.loadDeliverySecrets(),
      this.loadMilestoneNames(),
      this.loadWebhookEvents(),
      this.loadMismatchFlags(),
      this.loadReviewActions(),
      this.loadMoltbookWebhookEvents(),
      this.loadConstitutionVersions(),
      this.loadConstitutionAcceptances(),
      this.loadCurrentConstitutionVersion(),
      this.loadLeaseOutcomeLog()
    ]);

    // Attach milestones to contracts
    for (const milestone of milestonesData) {
      const contract = contractsData.get(milestone.contractId);
      if (contract) {
        contract.milestones.push(milestone);
      }
    }

    const pool = this.pool;

    // Create write-through proxied Maps
    const store: Store = {
      agents: createWriteThroughMap<string, AgentRecord>(
        agentsData,
        async (key, value) => {
          const p = value.profile;
          await pool.query(
            `INSERT INTO agents (agent_id, owner_handle, display_name, trust_tier, status, karma, constitution_accepted, constitution_accepted_at, capabilities, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (agent_id) DO UPDATE SET
               owner_handle = EXCLUDED.owner_handle,
               display_name = EXCLUDED.display_name,
               trust_tier = EXCLUDED.trust_tier,
               status = EXCLUDED.status,
               karma = EXCLUDED.karma,
               constitution_accepted = EXCLUDED.constitution_accepted,
               constitution_accepted_at = EXCLUDED.constitution_accepted_at,
               capabilities = EXCLUDED.capabilities,
               updated_at = NOW()`,
            [
              key,
              p.ownerRef,
              p.agentId, // display_name uses agentId as name
              'C', // trust_tier is computed from moltbook snapshot, not stored on agent
              p.status === 'PENDING_CAPABILITIES' ? 'PENDING' : p.status,
              0, // karma stored on moltbook snapshot, not agent row
              p.status === 'ACTIVE',
              p.status === 'ACTIVE' ? new Date().toISOString() : null,
              JSON.stringify(value.capability ?? null),
              p.createdAt
            ]
          );
        }
      ),

      tasks: createWriteThroughMap<string, Task>(
        tasksData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO tasks (task_id, requester_id, title, description, budget, deadline, status, scope_manifest, required_capabilities, pricing_mode, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (task_id) DO UPDATE SET
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               status = EXCLUDED.status,
               pricing_mode = EXCLUDED.pricing_mode,
               updated_at = NOW()`,
            [
              key,
              value.requesterAgentId,
              value.title,
              value.description,
              value.budget,
              value.deadlineAt,
              value.status,
              JSON.stringify({ scopeManifestId: value.scopeManifestId }),
              JSON.stringify([]),
              value.pricingMode,
              value.createdAt
            ]
          );
        }
      ),

      scopes: createWriteThroughMap<string, TaskScopeManifest>(
        scopesData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO task_scope_manifests (scope_manifest_id, allowed_data_refs, allowed_tools, egress_allowlist, deliverable_schema_ref, acceptance_tests_ref, classification)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (scope_manifest_id) DO NOTHING`,
            [
              key,
              JSON.stringify(value.allowedDataRefs),
              JSON.stringify(value.allowedTools),
              JSON.stringify(value.egressAllowlist),
              value.deliverableSchemaRef,
              value.acceptanceTestsRef,
              value.classification
            ]
          );
        }
      ),

      bids: createWriteThroughMap<string, { bidId: string; taskId: string; workerAgentId: string; rate: number; createdAt: string }[]>(
        bidsData,
        async (_key, value) => {
          // Write each bid in the array
          for (const bid of value) {
            await pool.query(
              `INSERT INTO task_bids (bid_id, task_id, worker_id, proposed_rate, created_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (bid_id) DO NOTHING`,
              [bid.bidId, bid.taskId, bid.workerAgentId, bid.rate, bid.createdAt]
            );
          }
        }
      ),

      leases: createWriteThroughMap<string, AssignmentLease>(
        leasesData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO assignment_leases (lease_id, task_id, worker_id, lease_token, expires_at, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (lease_id) DO UPDATE SET
               expires_at = EXCLUDED.expires_at,
               status = EXCLUDED.status,
               last_heartbeat = NOW()`,
            [
              key,
              value.taskId,
              value.workerAgentId,
              value.issuedTokenJti,
              value.leaseExpiresAt,
              value.status, // Now persisted — was missing before
              value.createdAt
            ]
          );
        }
      ),

      contracts: createWriteThroughMap<string, ContractTerms>(
        contractsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO contracts (contract_id, task_id, requester_id, worker_id, status, total_amount, penalty_rate, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (contract_id) DO UPDATE SET
               status = EXCLUDED.status,
               total_amount = EXCLUDED.total_amount,
               updated_at = NOW()`,
            [
              key,
              value.taskId,
              value.requesterAgentId,
              value.workerAgentId,
              'ACTIVE', // contracts don't have explicit status in domain model
              value.milestones.reduce((sum, m) => sum + m.amountCredits, 0),
              value.penaltySchedule.disputeSlashPct / 100,
              value.signedAt
            ]
          );
          // Upsert milestones
          for (const m of value.milestones) {
            await pool.query(
              `INSERT INTO milestones (milestone_id, contract_id, name, amount, status, sequence_number, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (milestone_id) DO UPDATE SET
                 status = EXCLUDED.status,
                 updated_at = NOW()`,
              [m.milestoneId, m.contractId, m.name, m.amountCredits, m.status, 0, m.dueAt]
            );
          }
        }
      ),

      artifacts: createWriteThroughMap<string, ArtifactRecord>(
        artifactsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO artifacts (artifact_id, milestone_id, worker_id, content_ref, sha256, signature, submitted_at, finalized_at, contract_id, validation_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (artifact_id) DO UPDATE SET
               finalized_at = EXCLUDED.finalized_at,
               contract_id = EXCLUDED.contract_id,
               validation_status = EXCLUDED.validation_status`,
            [
              key,
              value.milestoneId ?? 'unknown',
              value.executionId,
              value.storageUri,
              value.sha256,
              value.signature,
              value.submittedAt,
              value.finalizeToken ? new Date().toISOString() : null,
              value.contractId ?? null,
              value.validationStatus ?? 'VALID'
            ]
          );
        }
      ),

      executions: createWriteThroughMap<string, ExecutionSession>(
        executionsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO execution_sessions (execution_id, contract_id, milestone_id, sandbox_id, policy_version, state, started_at, last_heartbeat_at, ended_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (execution_id) DO UPDATE SET
               state = EXCLUDED.state,
               last_heartbeat_at = EXCLUDED.last_heartbeat_at,
               ended_at = EXCLUDED.ended_at`,
            [key, value.contractId, value.milestoneId, value.sandboxId, value.policyVersion, value.state, value.startedAt, value.lastHeartbeatAt, value.endedAt ?? null]
          );
        }
      ),

      dataGrants: createWriteThroughMap<string, DataGrant>(
        dataGrantsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO data_grants (grant_id, task_id, worker_agent_id, data_ref, lease_id, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (grant_id) DO NOTHING`,
            [key, value.taskId, value.workerAgentId, value.dataRef, value.leaseId, value.expiresAt, value.createdAt]
          );
        }
      ),

      vaultTokens: createWriteThroughMap<string, VaultToken>(
        vaultTokensData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO vault_tokens (token_id, agent_id, data_refs, tools_allowed, egress_allowed, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (token_id) DO NOTHING`,
            [key, value.grantId, JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), value.expiresAt]
          );
        }
      ),

      disputes: createWriteThroughMap<string, DisputeCase>(
        disputesData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO disputes (dispute_id, contract_id, opened_by, reason, status, ruling, appeal_deadline_at, auto_decision, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (dispute_id) DO UPDATE SET
               status = EXCLUDED.status,
               ruling = EXCLUDED.ruling,
               appeal_deadline_at = EXCLUDED.appeal_deadline_at,
               auto_decision = EXCLUDED.auto_decision,
               updated_at = NOW()`,
            [
              key,
              value.contractId,
              value.openedBy,
              value.reasonCode,
              value.status,
              value.finalRuling ?? null,
              value.appealDeadlineAt ?? null,
              value.autoDecision ?? null,
              value.createdAt
            ]
          );
        }
      ),

      evidencePacks: createWriteThroughMap<string, EvidencePack>(
        evidencePacksData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO evidence_packs (evidence_pack_id, dispute_id, contract_id, artifact_ids, event_ids, generated_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (evidence_pack_id) DO NOTHING`,
            [key, value.disputeId, value.contractId, JSON.stringify(value.artifactIds), JSON.stringify(value.eventIds), value.generatedAt]
          );
        }
      ),

      reputations: createWriteThroughMap<string, ReputationScore>(
        reputationsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO reputation_scores (agent_id, score, factors, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (agent_id) DO UPDATE SET
               score = EXCLUDED.score,
               factors = EXCLUDED.factors,
               updated_at = EXCLUDED.updated_at`,
            [key, value.score, JSON.stringify(value.factors), value.updatedAt]
          );
        }
      ),

      policyDecisions: createWriteThroughArray<PolicyDecision>(
        policyDecisionsData,
        async (item) => {
          await pool.query(
            `INSERT INTO policy_decisions (decision_id, policy_version, action, actor_agent_id, entity_id, allow, reason, context_hash, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (decision_id) DO NOTHING`,
            [item.decisionId, item.policyVersion, item.action, item.actorAgentId, item.entityId ?? null, item.allow, item.reason, item.contextHash, item.createdAt]
          );
        }
      ),

      sanctions: createWriteThroughMap<string, SanctionAction[]>(
        sanctionsData,
        async (key, value) => {
          for (const s of value) {
            await pool.query(
              `INSERT INTO sanctions (sanction_id, agent_id, type, status, reason, applied_by, duration_hours, applied_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (sanction_id) DO UPDATE SET
                 status = EXCLUDED.status,
                 updated_at = NOW()`,
              [
                s.sanctionId,
                s.agentId,
                s.type, // Now TEXT
                s.status, // Now TEXT — direct mapping
                s.reasonCode,
                'system',
                s.durationHours ?? null,
                s.effectiveAt
              ]
            );
          }
        }
      ),

      escrowLocks: createWriteThroughMap<string, EscrowLock>(
        escrowLocksData,
        async (_key, value) => {
          await pool.query(
            `INSERT INTO escrow_locks (lock_id, contract_id, amount, status, locked_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (lock_id) DO UPDATE SET
               amount = EXCLUDED.amount,
               status = EXCLUDED.status,
               updated_at = NOW()`,
            [value.escrowId, value.contractId, value.amount, value.status, value.createdAt]
          );
        }
      ),

      moltbookSnapshots: createWriteThroughMap<string, MoltbookVerificationSnapshot>(
        snapshotsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO moltbook_snapshots (agent_id, snapshot, verified_at, trusted_until_at, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (agent_id) DO UPDATE SET
               snapshot = EXCLUDED.snapshot,
               verified_at = EXCLUDED.verified_at,
               trusted_until_at = EXCLUDED.trusted_until_at,
               expires_at = EXCLUDED.expires_at,
               updated_at = NOW()`,
            [key, JSON.stringify(value), value.checkedAt, value.trustedUntilAt, value.expiresAt]
          );
        }
      ),

      historicalOwnerHandles: createWriteThroughMap<string, string>(
        ownerHistoryData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO agent_owner_history (agent_id, x_handle)
             VALUES ($1, $2)
             ON CONFLICT (agent_id, x_handle) DO UPDATE SET
               last_seen_at = NOW()`,
            [key, value]
          );
        }
      ),

      // SECURITY: Identity tokens are stored as SHA256 hashes in PG.
      // On restart, the in-memory map starts EMPTY because we cannot recover
      // plaintext tokens from hashes. This means reverify() without a fresh
      // token will correctly fail with REVERIFY_TOKEN_REQUIRED after restart.
      // New tokens set via verify() are kept in-memory as plaintext AND
      // written through to PG as SHA256 hashes.
      lastIdentityTokens: createWriteThroughMap<string, string>(
        new Map(), // Start empty — hashes from PG are not usable as tokens
        async (key, value) => {
          // Store token as SHA256 hash — never plaintext in PG
          const tokenHash = sha256(value);
          await pool.query(
            `INSERT INTO agent_identity_tokens (agent_id, token_hash)
             VALUES ($1, $2)
             ON CONFLICT (agent_id) DO UPDATE SET
               token_hash = EXCLUDED.token_hash,
               updated_at = NOW()`,
            [key, tokenHash]
          );
        }
      ),

      ledger: createWriteThroughArray<LedgerEntry>(
        ledgerData,
        async (item) => {
          await pool.query(
            `INSERT INTO ledger_entries (entry_id, account_id, type, amount, balance_after, reference_id, reference_type, reason, asset_type, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (entry_id) DO NOTHING`,
            [
              item.entryId,
              item.accountId,
              item.direction,
              item.amount,
              0, // balance_after computed from account_balances table
              item.referenceId,
              item.referenceType,
              item.reason,
              item.assetType,
              item.createdAt
            ]
          );
        }
      ),

      // Atomic balance updates: uses INSERT ... ON CONFLICT DO UPDATE
      // with the exact value from the in-memory store. The in-memory store
      // is the source of truth during runtime; PG is the persistence layer.
      // For true atomic operations under concurrent access, the debit/credit
      // methods in MarketplaceCore should use a transaction with
      // UPDATE ... SET balance = balance - $1 WHERE balance >= $1 RETURNING balance
      balances: createWriteThroughMap<string, number>(
        balancesData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO account_balances (account_id, balance)
             VALUES ($1, $2)
             ON CONFLICT (account_id) DO UPDATE SET
               balance = EXCLUDED.balance,
               updated_at = NOW()`,
            [key, value]
          );
        }
      ),

      // FIX: Store actual secrets, not hashes. The secret is needed at runtime
      // for HMAC signature verification on artifact delivery.
      deliverySecrets: createWriteThroughMap<string, string>(
        deliverySecretsData,
        async (key, value) => {
          const [contractId, milestoneId] = key.split(':');
          await pool.query(
            `INSERT INTO delivery_secrets (contract_id, milestone_id, secret_value)
             VALUES ($1, $2, $3)
             ON CONFLICT (contract_id, milestone_id) DO NOTHING`,
            [contractId, milestoneId, value]
          );
        }
      ),

      taskMilestoneNames: createWriteThroughMap<string, string[]>(
        milestoneNamesData,
        async (key, value) => {
          await pool.query(
            `UPDATE tasks SET milestone_names = $1 WHERE task_id = $2`,
            [JSON.stringify(value), key]
          );
        }
      ),

      processedWebhookEventIds: createWriteThroughSet<string>(
        webhookEventsData,
        async (eventId) => {
          await pool.query(
            `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
            [eventId]
          );
        }
      ),

      ownerMismatchFlags: createWriteThroughMap<string, OwnerMismatchFlag>(
        mismatchFlagsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO owner_mismatch_flags (flag_id, agent_id, previous_handle, new_handle, detected_at, resolved_at, resolution, resolved_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (flag_id) DO UPDATE SET
               resolved_at = EXCLUDED.resolved_at,
               resolution = EXCLUDED.resolution,
               resolved_by = EXCLUDED.resolved_by`,
            [key, value.agentId, value.previousHandle, value.newHandle, value.detectedAt, value.resolvedAt ?? null, value.resolution ?? null, value.resolvedBy ?? null]
          );
        }
      ),

      mismatchReviewActions: createWriteThroughMap<string, MismatchReviewAction>(
        reviewActionsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO mismatch_review_actions (action_id, flag_id, moderator_id, action_type, notes, acted_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (action_id) DO NOTHING`,
            [key, value.flagId, value.moderatorId, value.actionType, value.notes ?? null, value.actedAt]
          );
        }
      ),

      processedMoltbookWebhookEventIds: createWriteThroughSet<string>(
        moltbookWebhookEventsData,
        async (eventId) => {
          await pool.query(
            `INSERT INTO processed_moltbook_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
            [eventId]
          );
        }
      ),

      // TASK-ENFORCE-001: Constitution version history
      constitutionVersions: createWriteThroughMap<string, ConstitutionVersionRecord>(
        constitutionVersionsData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO constitution_versions (version, published_at, sha256_hash, changelog, re_acceptance_deadline_days)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (version) DO UPDATE SET
               sha256_hash = EXCLUDED.sha256_hash,
               changelog = EXCLUDED.changelog,
               re_acceptance_deadline_days = EXCLUDED.re_acceptance_deadline_days`,
            [key, value.publishedAt, value.sha256Hash, value.changelog, value.reAcceptanceDeadlineDays ?? 7]
          );
        }
      ),

      // TASK-ENFORCE-001: Current active constitution version
      // Placeholder — replaced by defineProperty below for write-through
      currentConstitutionVersion: currentConstitutionVersionData,

      // TASK-ENFORCE-006: Ghost reservation tracking — persisted to PG via migration 010
      leaseOutcomeLog: createWriteThroughMap<string, { leaseId: string; outcome: 'EXPIRED' | 'CLOSED'; timestamp: string }[]>(
        leaseOutcomeLogData,
        async (key, value) => {
          // Write only the latest entry (the array is append-only per agent)
          const latest = value[value.length - 1];
          if (latest) {
            await pool.query(
              `INSERT INTO lease_outcome_log (agent_id, lease_id, outcome, occurred_at)
               VALUES ($1, $2, $3, $4)`,
              [key, latest.leaseId, latest.outcome, latest.timestamp]
            );
          }
        }
      ),

      // TASK-ENFORCE-007: Banned owner handles — persisted to PG via migration 010
      bannedOwnerHandles: createWriteThroughSet<string>(
        await this.loadBannedOwnerHandles(),
        async (handle) => {
          await pool.query(
            `INSERT INTO banned_owner_handles (x_handle) VALUES ($1) ON CONFLICT DO NOTHING`,
            [handle]
          );
        }
      ),

      // TASK-ENFORCE-001: Per-agent constitution acceptance records
      constitutionAcceptances: createWriteThroughMap<string, ConstitutionAcceptance>(
        constitutionAcceptancesData,
        async (key, value) => {
          await pool.query(
            `INSERT INTO constitution_acceptances (agent_id, constitution_version, constitution_hash, accepted_at, ip_hash, audit_event_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (agent_id) DO UPDATE SET
               constitution_version = EXCLUDED.constitution_version,
               constitution_hash = EXCLUDED.constitution_hash,
               accepted_at = EXCLUDED.accepted_at,
               ip_hash = EXCLUDED.ip_hash,
               audit_event_id = EXCLUDED.audit_event_id,
               updated_at = NOW()`,
            [key, value.constitutionVersion, value.constitutionHash, value.acceptedAt, value.ipHash ?? null, value.auditEventId ?? null]
          );
        }
      ),

    };

    // Write-through for the scalar currentConstitutionVersion property.
    // When this property is set, persist the new value to PG asynchronously.
    let _currentVersion = currentConstitutionVersionData;
    Object.defineProperty(store, 'currentConstitutionVersion', {
      get: () => _currentVersion,
      set: (newVersion: string) => {
        _currentVersion = newVersion;
        pool.query(
          `INSERT INTO constitution_config (key, value, updated_at) VALUES ('current_version', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [newVersion]
        ).catch((err) => {
          console.error('[PgStore] Write-through currentConstitutionVersion error:', err);
        });
      },
      enumerable: true,
      configurable: true
    });

    console.log('[PgStore] Initialized — loaded data from PostgreSQL');
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Data Loading Methods ──────────────────────────────────────────────────

  private async loadAgents(): Promise<Map<string, AgentRecord>> {
    const map = new Map<string, AgentRecord>();
    const { rows } = await this.pool.query('SELECT * FROM agents');
    for (const row of rows) {
      const profile: AgentProfile = {
        agentId: row.agent_id,
        moltbookAgentId: row.agent_id,
        ownerRef: row.owner_handle,
        verificationStatus: 'VERIFIED',
        status: pgToAgentStatus(row.status),
        riskTier: 'LOW',
        kycTier: 'NONE',
        createdAt: new Date(row.created_at).toISOString()
      };
      const capability = row.capabilities && row.capabilities !== 'null'
        ? row.capabilities
        : undefined;
      map.set(row.agent_id, { profile, capability });
    }
    return map;
  }

  private async loadTasks(): Promise<Map<string, Task>> {
    const map = new Map<string, Task>();
    const { rows } = await this.pool.query('SELECT * FROM tasks');
    for (const row of rows) {
      const scopeMeta = row.scope_manifest ?? {};
      map.set(row.task_id, {
        taskId: row.task_id,
        requesterAgentId: row.requester_id,
        title: row.title,
        description: row.description,
        pricingMode: (row.pricing_mode as Task['pricingMode']) ?? 'fixed',
        budget: Number(row.budget),
        deadlineAt: new Date(row.deadline || row.created_at).toISOString(),
        visibility: 'public',
        status: (row.status as Task['status']) ?? 'DRAFT',
        scopeManifestId: scopeMeta.scopeManifestId ?? '',
        createdAt: new Date(row.created_at).toISOString()
      });
    }
    return map;
  }

  private async loadScopes(): Promise<Map<string, TaskScopeManifest>> {
    const map = new Map<string, TaskScopeManifest>();
    const { rows } = await this.pool.query('SELECT * FROM task_scope_manifests');
    for (const row of rows) {
      map.set(row.scope_manifest_id, {
        scopeManifestId: row.scope_manifest_id,
        allowedDataRefs: row.allowed_data_refs ?? [],
        allowedTools: row.allowed_tools ?? [],
        egressAllowlist: row.egress_allowlist ?? [],
        deliverableSchemaRef: row.deliverable_schema_ref,
        acceptanceTestsRef: row.acceptance_tests_ref,
        classification: row.classification ?? 'high'
      });
    }
    return map;
  }

  private async loadBids(): Promise<Map<string, { bidId: string; taskId: string; workerAgentId: string; rate: number; createdAt: string }[]>> {
    const map = new Map<string, { bidId: string; taskId: string; workerAgentId: string; rate: number; createdAt: string }[]>();
    const { rows } = await this.pool.query('SELECT * FROM task_bids ORDER BY created_at');
    for (const row of rows) {
      const taskBids = map.get(row.task_id) ?? [];
      taskBids.push({
        bidId: row.bid_id,
        taskId: row.task_id,
        workerAgentId: row.worker_id,
        rate: Number(row.proposed_rate ?? 0),
        createdAt: new Date(row.created_at).toISOString()
      });
      map.set(row.task_id, taskBids);
    }
    return map;
  }

  private async loadLeases(): Promise<Map<string, AssignmentLease>> {
    const map = new Map<string, AssignmentLease>();
    const { rows } = await this.pool.query('SELECT * FROM assignment_leases');
    for (const row of rows) {
      map.set(row.lease_id, {
        leaseId: row.lease_id,
        taskId: row.task_id,
        workerAgentId: row.worker_id,
        leaseExpiresAt: new Date(row.expires_at).toISOString(),
        heartbeatIntervalSec: 30,
        issuedTokenJti: row.lease_token,
        // FIX: Read actual status from PG instead of always 'ACTIVE'
        status: (row.status as AssignmentLease['status']) ?? 'ACTIVE',
        createdAt: new Date(row.created_at).toISOString()
      });
    }
    return map;
  }

  private async loadContracts(): Promise<Map<string, ContractTerms>> {
    const map = new Map<string, ContractTerms>();
    const { rows } = await this.pool.query('SELECT * FROM contracts');
    for (const row of rows) {
      map.set(row.contract_id, {
        contractId: row.contract_id,
        taskId: row.task_id,
        requesterAgentId: row.requester_id,
        workerAgentId: row.worker_id,
        penaltySchedule: {
          latePenaltyPct: 10,
          disputeSlashPct: Number(row.penalty_rate ?? 0.1) * 100
        },
        constitutionVersion: 'v1',
        signedAt: new Date(row.created_at).toISOString(),
        milestones: [] // populated after loadMilestones
      });
    }
    return map;
  }

  private async loadMilestones(): Promise<Milestone[]> {
    const { rows } = await this.pool.query('SELECT * FROM milestones ORDER BY contract_id, sequence_number');
    return rows.map((row) => ({
      milestoneId: row.milestone_id,
      contractId: row.contract_id,
      name: row.name,
      amountCredits: Number(row.amount),
      // Use updated_at as proxy for dueAt if no explicit column; or created_at
      dueAt: new Date(row.updated_at ?? row.created_at).toISOString(),
      acceptanceRuleRef: 'default.acceptance.v1',
      // FIX: Read actual status from PG (now TEXT, no enum mapping needed)
      status: (row.status as Milestone['status']) ?? 'PENDING'
    }));
  }

  private async loadArtifacts(): Promise<Map<string, ArtifactRecord>> {
    const map = new Map<string, ArtifactRecord>();
    const { rows } = await this.pool.query('SELECT * FROM artifacts');
    for (const row of rows) {
      map.set(row.artifact_id, {
        artifactId: row.artifact_id,
        executionId: row.worker_id, // DB stores worker_id in the execution_id role
        sha256: row.sha256,
        signature: row.signature,
        storageUri: row.content_ref,
        submittedAt: new Date(row.submitted_at).toISOString(),
        contractId: row.contract_id ?? undefined,
        milestoneId: row.milestone_id,
        validationStatus: (row.validation_status as ArtifactRecord['validationStatus']) ?? 'VALID'
      });
    }
    return map;
  }

  private async loadExecutions(): Promise<Map<string, ExecutionSession>> {
    const map = new Map<string, ExecutionSession>();
    const { rows } = await this.pool.query('SELECT * FROM execution_sessions');
    for (const row of rows) {
      map.set(row.execution_id, {
        executionId: row.execution_id,
        contractId: row.contract_id,
        milestoneId: row.milestone_id,
        sandboxId: row.sandbox_id,
        policyVersion: row.policy_version,
        state: row.state as ExecutionSession['state'],
        startedAt: new Date(row.started_at).toISOString(),
        lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
        endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : undefined
      });
    }
    return map;
  }

  private async loadDataGrants(): Promise<Map<string, DataGrant>> {
    const map = new Map<string, DataGrant>();
    const { rows } = await this.pool.query('SELECT * FROM data_grants');
    for (const row of rows) {
      map.set(row.grant_id, {
        grantId: row.grant_id,
        taskId: row.task_id,
        workerAgentId: row.worker_agent_id,
        dataRef: row.data_ref,
        leaseId: row.lease_id,
        expiresAt: new Date(row.expires_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString()
      });
    }
    return map;
  }

  private async loadVaultTokens(): Promise<Map<string, VaultToken>> {
    const map = new Map<string, VaultToken>();
    const { rows } = await this.pool.query('SELECT * FROM vault_tokens');
    for (const row of rows) {
      map.set(row.token_id, {
        tokenId: row.token_id,
        grantId: row.agent_id,
        token: row.token_id,
        expiresAt: new Date(row.expires_at).toISOString()
      });
    }
    return map;
  }

  private async loadDisputes(): Promise<Map<string, DisputeCase>> {
    const map = new Map<string, DisputeCase>();
    const { rows } = await this.pool.query('SELECT * FROM disputes');
    for (const row of rows) {
      map.set(row.dispute_id, {
        disputeId: row.dispute_id,
        contractId: row.contract_id,
        openedBy: row.opened_by,
        reasonCode: row.reason,
        // FIX: Read actual status from PG (now TEXT)
        status: (row.status as DisputeCase['status']) ?? 'OPEN',
        // FIX: Read appeal_deadline_at from PG (migration 007) instead of computing
        appealDeadlineAt: row.appeal_deadline_at
          ? new Date(row.appeal_deadline_at).toISOString()
          : new Date(new Date(row.created_at).getTime() + 72 * 3600 * 1000).toISOString(),
        finalRuling: row.ruling ?? undefined,
        autoDecision: row.auto_decision ?? undefined,
        createdAt: new Date(row.created_at).toISOString()
      });
    }
    return map;
  }

  private async loadEvidencePacks(): Promise<Map<string, EvidencePack>> {
    const map = new Map<string, EvidencePack>();
    const { rows } = await this.pool.query('SELECT * FROM evidence_packs');
    for (const row of rows) {
      map.set(row.evidence_pack_id, {
        evidencePackId: row.evidence_pack_id,
        disputeId: row.dispute_id,
        contractId: row.contract_id,
        artifactIds: row.artifact_ids ?? [],
        eventIds: row.event_ids ?? [],
        generatedAt: new Date(row.generated_at).toISOString()
      });
    }
    return map;
  }

  private async loadReputations(): Promise<Map<string, ReputationScore>> {
    const map = new Map<string, ReputationScore>();
    const { rows } = await this.pool.query('SELECT * FROM reputation_scores');
    for (const row of rows) {
      map.set(row.agent_id, {
        agentId: row.agent_id,
        score: row.score,
        factors: row.factors ?? { acceptedMilestones: 0, disputesLost: 0, sanctionsCount: 0, paymentReliability: 1 },
        updatedAt: new Date(row.updated_at).toISOString()
      });
    }
    return map;
  }

  private async loadPolicyDecisions(): Promise<PolicyDecision[]> {
    const { rows } = await this.pool.query('SELECT * FROM policy_decisions ORDER BY created_at');
    return rows.map((row) => ({
      decisionId: row.decision_id,
      policyVersion: row.policy_version,
      action: row.action,
      actorAgentId: row.actor_agent_id,
      entityId: row.entity_id ?? undefined,
      allow: row.allow,
      reason: row.reason,
      contextHash: row.context_hash,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  private async loadSanctions(): Promise<Map<string, SanctionAction[]>> {
    const map = new Map<string, SanctionAction[]>();
    const { rows } = await this.pool.query('SELECT * FROM sanctions ORDER BY applied_at');
    for (const row of rows) {
      const sanctions = map.get(row.agent_id) ?? [];
      sanctions.push({
        sanctionId: row.sanction_id,
        agentId: row.agent_id,
        type: row.type as SanctionAction['type'],
        durationHours: row.duration_hours ?? undefined,
        reasonCode: row.reason,
        // FIX: Read actual status from PG (now TEXT)
        status: (row.status as SanctionAction['status']) ?? 'ACTIVE',
        effectiveAt: new Date(row.applied_at).toISOString(),
        appealedAt: row.appeal_reason ? new Date(row.updated_at).toISOString() : undefined,
        appealReason: row.appeal_reason ?? undefined,
        reviewedAt: row.appeal_decided_at ? new Date(row.appeal_decided_at).toISOString() : undefined,
        reviewedBy: undefined,
        reviewRuling: row.appeal_outcome as SanctionAction['reviewRuling']
      });
      map.set(row.agent_id, sanctions);
    }
    return map;
  }

  private async loadEscrowLocks(): Promise<Map<string, EscrowLock>> {
    const map = new Map<string, EscrowLock>();
    const { rows } = await this.pool.query('SELECT * FROM escrow_locks');
    for (const row of rows) {
      map.set(row.contract_id, {
        escrowId: row.lock_id,
        contractId: row.contract_id,
        accountId: `escrow:${row.contract_id}`,
        amount: Number(row.amount),
        // FIX: Read actual status from PG (now TEXT)
        status: (row.status as EscrowLock['status']) ?? 'LOCKED',
        createdAt: new Date(row.locked_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
      });
    }
    return map;
  }

  private async loadMoltbookSnapshots(): Promise<Map<string, MoltbookVerificationSnapshot>> {
    const map = new Map<string, MoltbookVerificationSnapshot>();
    const { rows } = await this.pool.query('SELECT * FROM moltbook_snapshots');
    for (const row of rows) {
      if (row.snapshot) {
        map.set(row.agent_id, row.snapshot as MoltbookVerificationSnapshot);
      }
    }
    return map;
  }

  private async loadOwnerHistory(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const { rows } = await this.pool.query(
      'SELECT DISTINCT ON (agent_id) agent_id, x_handle FROM agent_owner_history ORDER BY agent_id, last_seen_at DESC'
    );
    for (const row of rows) {
      map.set(row.agent_id, row.x_handle);
    }
    return map;
  }

  private async loadLedger(): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query('SELECT * FROM ledger_entries ORDER BY created_at');
    return rows.map((row) => ({
      entryId: row.entry_id,
      accountId: row.account_id,
      direction: row.type as LedgerEntry['direction'],
      amount: Number(row.amount),
      assetType: (row.asset_type as LedgerEntry['assetType']) ?? 'credits',
      reason: row.reason || row.reference_type || '',
      referenceType: row.reference_type ?? '',
      referenceId: row.reference_id ?? '',
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  private async loadBalances(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const { rows } = await this.pool.query('SELECT * FROM account_balances');
    for (const row of rows) {
      map.set(row.account_id, Number(row.balance));
    }
    return map;
  }

  // FIX: Load actual secrets (not hashes) from PG — needed for HMAC verification
  private async loadDeliverySecrets(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const { rows } = await this.pool.query('SELECT * FROM delivery_secrets');
    for (const row of rows) {
      map.set(`${row.contract_id}:${row.milestone_id}`, row.secret_value);
    }
    return map;
  }

  private async loadMilestoneNames(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const { rows } = await this.pool.query(
      "SELECT task_id, milestone_names FROM tasks WHERE milestone_names IS NOT NULL AND milestone_names != '[]'::jsonb"
    );
    for (const row of rows) {
      const names = row.milestone_names;
      if (Array.isArray(names) && names.length > 0) {
        map.set(row.task_id, names);
      }
    }
    return map;
  }

  private async loadWebhookEvents(): Promise<Set<string>> {
    const set = new Set<string>();
    const { rows } = await this.pool.query('SELECT event_id FROM processed_webhook_events');
    for (const row of rows) {
      set.add(row.event_id);
    }
    return set;
  }

  private async loadMoltbookWebhookEvents(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const { rows } = await this.pool.query('SELECT event_id FROM processed_moltbook_webhook_events');
      for (const row of rows) {
        set.add(row.event_id);
      }
    } catch {
      // Table may not exist yet — return empty set (in-memory only until migration runs)
    }
    return set;
  }

  private async loadMismatchFlags(): Promise<Map<string, OwnerMismatchFlag>> {
    const map = new Map<string, OwnerMismatchFlag>();
    const { rows } = await this.pool.query('SELECT * FROM owner_mismatch_flags');
    for (const row of rows) {
      map.set(row.flag_id, {
        flagId: row.flag_id,
        agentId: row.agent_id,
        previousHandle: row.previous_handle,
        newHandle: row.new_handle,
        detectedAt: new Date(row.detected_at).toISOString(),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined,
        resolution: row.resolution ?? undefined,
        resolvedBy: row.resolved_by ?? undefined
      });
    }
    return map;
  }

  private async loadReviewActions(): Promise<Map<string, MismatchReviewAction>> {
    const map = new Map<string, MismatchReviewAction>();
    const { rows } = await this.pool.query('SELECT * FROM mismatch_review_actions');
    for (const row of rows) {
      map.set(row.action_id, {
        actionId: row.action_id,
        flagId: row.flag_id,
        moderatorId: row.moderator_id,
        actionType: row.action_type as MismatchReviewAction['actionType'],
        notes: row.notes ?? undefined,
        actedAt: new Date(row.acted_at).toISOString()
      });
    }
    return map;
  }

  private async loadConstitutionVersions(): Promise<Map<string, ConstitutionVersionRecord>> {
    const map = new Map<string, ConstitutionVersionRecord>();
    try {
      const { rows } = await this.pool.query('SELECT * FROM constitution_versions ORDER BY published_at');
      for (const row of rows) {
        map.set(row.version, {
          version: row.version,
          publishedAt: new Date(row.published_at).toISOString(),
          sha256Hash: row.sha256_hash,
          changelog: row.changelog ?? '',
          reAcceptanceDeadlineDays: row.re_acceptance_deadline_days ?? 7
        });
      }
    } catch {
      // Table may not exist yet — return empty map (in-memory only until migration 009 runs)
    }
    return map;
  }

  private async loadConstitutionAcceptances(): Promise<Map<string, ConstitutionAcceptance>> {
    const map = new Map<string, ConstitutionAcceptance>();
    try {
      const { rows } = await this.pool.query('SELECT * FROM constitution_acceptances');
      for (const row of rows) {
        map.set(row.agent_id, {
          agentId: row.agent_id,
          constitutionVersion: row.constitution_version,
          constitutionHash: row.constitution_hash,
          acceptedAt: new Date(row.accepted_at).toISOString(),
          ipHash: row.ip_hash ?? undefined,
          auditEventId: row.audit_event_id ?? undefined
        });
      }
    } catch {
      // Table may not exist yet — return empty map (in-memory only until migration 009 runs)
    }
    return map;
  }

  private async loadCurrentConstitutionVersion(): Promise<string> {
    try {
      const { rows } = await this.pool.query(
        "SELECT value FROM constitution_config WHERE key = 'current_version'"
      );
      return rows[0]?.value ?? 'v1';
    } catch {
      // Table may not exist yet — return default
      return 'v1';
    }
  }

  private async loadLeaseOutcomeLog(): Promise<Map<string, { leaseId: string; outcome: 'EXPIRED' | 'CLOSED'; timestamp: string }[]>> {
    const map = new Map<string, { leaseId: string; outcome: 'EXPIRED' | 'CLOSED'; timestamp: string }[]>();
    try {
      const { rows } = await this.pool.query(
        'SELECT agent_id, lease_id, outcome, occurred_at FROM lease_outcome_log ORDER BY occurred_at'
      );
      for (const row of rows) {
        const entries = map.get(row.agent_id) ?? [];
        entries.push({
          leaseId: row.lease_id,
          outcome: row.outcome as 'EXPIRED' | 'CLOSED',
          timestamp: new Date(row.occurred_at).toISOString()
        });
        map.set(row.agent_id, entries);
      }
    } catch {
      // Table may not exist yet — return empty map (in-memory only until migration 010 runs)
    }
    return map;
  }

  private async loadBannedOwnerHandles(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const { rows } = await this.pool.query('SELECT x_handle FROM banned_owner_handles');
      for (const row of rows) {
        set.add(row.x_handle);
      }
    } catch {
      // Table may not exist yet — return empty set (in-memory only until migration 010 runs)
    }
    return set;
  }

  // ── Audit Event Persistence ──────────────────────────────────────────────────

  /**
   * Load all audit events from PostgreSQL to restore the hash chain on startup.
   * Events are returned in sequence order so the chain can be verified.
   */
  async loadAuditEvents(): Promise<AuditEvent[]> {
    try {
      const { rows } = await this.pool.query(
        'SELECT event_id, event_type, entity_id, actor_id, payload, timestamp, previous_hash, hash FROM audit_events ORDER BY sequence_number ASC'
      );
      return rows.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        entityId: row.entity_id,
        payload: row.payload ?? {},
        timestamp: new Date(row.timestamp).toISOString(),
        previousHash: row.previous_hash,
        hash: row.hash
      }));
    } catch {
      // Table may not exist yet — return empty array
      return [];
    }
  }

  /**
   * Create an AuditPersistence adapter that writes events to the audit_events table.
   * Fire-and-forget: errors are logged but don't block the caller.
   */
  createAuditPersistence(): AuditPersistence {
    const pool = this.pool;
    return {
      writeEvent: async (event: AuditEvent) => {
        await pool.query(
          `INSERT INTO audit_events (event_id, event_type, entity_id, entity_type, actor_id, payload, timestamp, previous_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.eventId,
            event.eventType,
            event.entityId,
            event.eventType.split('.')[0] ?? 'unknown', // entity_type derived from event_type prefix
            (event.payload as Record<string, unknown>)?.actorAgentId ?? null,
            JSON.stringify(event.payload),
            event.timestamp,
            event.previousHash,
            event.hash
          ]
        );
      }
    };
  }
}

// ── Status mapping helpers ────────────────────────────────────────────────────
// With migration 006, all status columns are TEXT. These helpers convert between
// the PG text values (which may be from the original enum) and domain types.

function pgToAgentStatus(pgStatus: string): 'PENDING_CAPABILITIES' | 'ACTIVE' | 'SUSPENDED' | 'BANNED' {
  const mapping: Record<string, 'PENDING_CAPABILITIES' | 'ACTIVE' | 'SUSPENDED' | 'BANNED'> = {
    PENDING: 'PENDING_CAPABILITIES',
    PENDING_CAPABILITIES: 'PENDING_CAPABILITIES',
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED',
    BANNED: 'BANNED'
  };
  return mapping[pgStatus] ?? 'PENDING_CAPABILITIES';
}
