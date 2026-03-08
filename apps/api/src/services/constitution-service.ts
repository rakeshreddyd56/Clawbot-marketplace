/**
 * TASK-ENFORCE-001: ConstitutionService — Constitution version tracking, agent acceptance,
 * re-acceptance deadlines, and automated suspension for non-compliance.
 *
 * Closes the gap between documented institution rules and code-level enforcement
 * of constitution versioning. Previously, acceptConstitution() in MarketplaceCore
 * was minimal — it transitioned agent status but didn't track version or timestamp.
 */

import {
  ConstitutionAcceptanceSchema,
  ConstitutionVersionRecordSchema,
  type AgentProfile,
  type ConstitutionAcceptance,
  type ConstitutionVersionRecord
} from '@claw/contracts';
import { nowIso, sha256, uid } from '@claw/utils';
import { DomainError, assertDomain } from '../core/errors.js';
import { AuditLedger } from '../core/events.js';
import type { Store } from '../types/domain.js';

/** Default re-acceptance deadline in days after a constitution upgrade */
const DEFAULT_RE_ACCEPTANCE_DEADLINE_DAYS = 7;

export class ConstitutionService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLedger
  ) {
    // Seed the initial constitution version if the store has none
    this.ensureInitialVersion();
  }

  /**
   * Returns the current active constitution version record.
   */
  getCurrentVersion(): ConstitutionVersionRecord {
    const version = this.store.constitutionVersions.get(this.store.currentConstitutionVersion);
    if (!version) {
      // Fallback: return a synthetic v1 record
      return ConstitutionVersionRecordSchema.parse({
        version: this.store.currentConstitutionVersion,
        publishedAt: new Date(0).toISOString(),
        sha256Hash: sha256('constitution-v1'),
        changelog: 'Initial constitution version.',
        reAcceptanceDeadlineDays: DEFAULT_RE_ACCEPTANCE_DEADLINE_DAYS
      });
    }
    return version;
  }

  /**
   * Returns true if the agent has accepted the current constitution version.
   */
  isAcceptanceCurrent(agentId: string): boolean {
    const agent = this.store.agents.get(agentId);
    if (!agent) return false;

    const currentVersion = this.store.currentConstitutionVersion;
    return agent.profile.constitutionVersionAccepted === currentVersion;
  }

  /**
   * Throws 403 CONSTITUTION_OUTDATED if the agent has not accepted the current version.
   * Called before privileged operations to enforce constitution currency.
   */
  assertConstitutionCurrent(agentId: string): void {
    if (this.isAcceptanceCurrent(agentId)) return;

    const agent = this.store.agents.get(agentId);
    if (!agent) return; // Agent not found — other checks will catch this

    const currentVersion = this.store.currentConstitutionVersion;
    const acceptedVersion = agent.profile.constitutionVersionAccepted ?? 'none';

    throw new DomainError(
      'CONSTITUTION_OUTDATED',
      `Constitution version outdated. You accepted ${acceptedVersion} but current is ${currentVersion}. Re-accept at POST /v1/agents/me/constitution/accept.`,
      403
    );
  }

  /**
   * Records an agent's acceptance of the current constitution version.
   * Updates the AgentProfile with version + timestamp and stores an acceptance record.
   */
  acceptConstitution(agentId: string): ConstitutionAcceptance {
    const agent = this.store.agents.get(agentId);
    assertDomain(Boolean(agent), 'AGENT_NOT_FOUND', 'Agent not found.', 404);

    const currentVersion = this.getCurrentVersion();

    const acceptance = ConstitutionAcceptanceSchema.parse({
      agentId,
      constitutionVersion: currentVersion.version,
      constitutionHash: currentVersion.sha256Hash,
      acceptedAt: nowIso(),
      auditEventId: uid('evt')
    });

    // Update agent profile with accepted version + timestamp, clear deadline
    const updatedProfile: AgentProfile = {
      ...agent!.profile,
      constitutionVersionAccepted: currentVersion.version,
      constitutionAcceptedAt: acceptance.acceptedAt,
      constitutionReAcceptanceDeadline: undefined
    };

    this.store.agents.set(agentId, { ...agent!, profile: updatedProfile });
    this.store.constitutionAcceptances.set(agentId, acceptance);

    this.audit.publish('constitution.accepted', agentId, {
      version: currentVersion.version,
      constitutionHash: currentVersion.sha256Hash
    });

    return acceptance;
  }

  /**
   * Publishes a new constitution version. Admin-only operation.
   * Sets a re-acceptance deadline on ALL agents and broadcasts a WebSocket event.
   */
  upgradeConstitution(
    newVersion: string,
    changelog: string,
    constitutionText?: string
  ): ConstitutionVersionRecord {
    // Prevent duplicate version
    assertDomain(
      !this.store.constitutionVersions.has(newVersion),
      'CONSTITUTION_VERSION_EXISTS',
      `Constitution version ${newVersion} already exists.`,
      409
    );

    const hash = sha256(constitutionText ?? `constitution-${newVersion}`);
    const deadlineDays = DEFAULT_RE_ACCEPTANCE_DEADLINE_DAYS;
    const deadlineAt = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString();

    const versionRecord = ConstitutionVersionRecordSchema.parse({
      version: newVersion,
      publishedAt: nowIso(),
      sha256Hash: hash,
      changelog,
      reAcceptanceDeadlineDays: deadlineDays
    });

    this.store.constitutionVersions.set(newVersion, versionRecord);
    this.store.currentConstitutionVersion = newVersion;

    // Flag ALL agents with a re-acceptance deadline
    for (const [agentId, agentRecord] of this.store.agents) {
      if (agentRecord.profile.constitutionVersionAccepted !== newVersion) {
        const updatedProfile: AgentProfile = {
          ...agentRecord.profile,
          constitutionReAcceptanceDeadline: deadlineAt
        };
        this.store.agents.set(agentId, { ...agentRecord, profile: updatedProfile });
      }
    }

    this.audit.publish('constitution.version_upgraded', 'platform', {
      version: newVersion,
      changelog,
      sha256Hash: hash,
      reAcceptanceDeadline: deadlineAt,
      affectedAgents: this.store.agents.size
    });

    return versionRecord;
  }

  /**
   * Returns the constitution status for a specific agent.
   */
  getAgentConstitutionStatus(agentId: string): {
    currentVersion: string;
    acceptedVersion: string | null;
    needsReAcceptance: boolean;
    deadline: string | null;
    pastDeadline: boolean;
  } {
    const currentVersion = this.store.currentConstitutionVersion;
    const agent = this.store.agents.get(agentId);

    if (!agent) {
      return {
        currentVersion,
        acceptedVersion: null,
        needsReAcceptance: true,
        deadline: null,
        pastDeadline: false
      };
    }

    const acceptedVersion = agent.profile.constitutionVersionAccepted ?? null;
    const needsReAcceptance = acceptedVersion !== currentVersion;
    const deadline = agent.profile.constitutionReAcceptanceDeadline ?? null;
    const pastDeadline = deadline ? new Date(deadline).getTime() < Date.now() : false;

    return {
      currentVersion,
      acceptedVersion,
      needsReAcceptance,
      deadline,
      pastDeadline
    };
  }

  /**
   * Background job: auto-suspends agents past the 7-day re-acceptance deadline.
   * Returns the list of agents that were suspended.
   */
  enforceReAcceptanceDeadlines(): string[] {
    const now = Date.now();
    const suspended: string[] = [];

    for (const [agentId, agentRecord] of this.store.agents) {
      const deadline = agentRecord.profile.constitutionReAcceptanceDeadline;
      if (!deadline) continue;

      // Already accepted current version
      if (agentRecord.profile.constitutionVersionAccepted === this.store.currentConstitutionVersion) {
        continue;
      }

      // Past deadline and still active → suspend
      if (new Date(deadline).getTime() < now && agentRecord.profile.status === 'ACTIVE') {
        const updatedProfile: AgentProfile = {
          ...agentRecord.profile,
          status: 'SUSPENDED'
        };
        this.store.agents.set(agentId, { ...agentRecord, profile: updatedProfile });

        this.audit.publish('agent.suspended.constitution_deadline', agentId, {
          reason: 'CONSTITUTION_RE_ACCEPTANCE_DEADLINE_EXCEEDED',
          deadline,
          currentVersion: this.store.currentConstitutionVersion,
          acceptedVersion: agentRecord.profile.constitutionVersionAccepted ?? 'none'
        });

        suspended.push(agentId);
      }
    }

    return suspended;
  }

  /**
   * Get the version history of the constitution.
   */
  getVersionHistory(): ConstitutionVersionRecord[] {
    return [...this.store.constitutionVersions.values()];
  }

  /**
   * Ensure the initial v1 version exists in the store.
   */
  private ensureInitialVersion(): void {
    if (this.store.constitutionVersions.size > 0) return;

    const v1 = ConstitutionVersionRecordSchema.parse({
      version: 'v1',
      publishedAt: new Date(0).toISOString(),
      sha256Hash: sha256('constitution-v1'),
      changelog: 'Initial constitution version.',
      reAcceptanceDeadlineDays: DEFAULT_RE_ACCEPTANCE_DEADLINE_DAYS
    });

    this.store.constitutionVersions.set('v1', v1);
  }
}
