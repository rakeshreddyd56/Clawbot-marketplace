import type { Store } from '../types/domain.js';

export function createStore(): Store {
  return {
    agents: new Map(),
    tasks: new Map(),
    scopes: new Map(),
    bids: new Map(),
    leases: new Map(),
    contracts: new Map(),
    artifacts: new Map(),
    executions: new Map(),
    dataGrants: new Map(),
    vaultTokens: new Map(),
    disputes: new Map(),
    evidencePacks: new Map(),
    reputations: new Map(),
    policyDecisions: [],
    sanctions: new Map(),
    escrowLocks: new Map(),
    moltbookSnapshots: new Map(),
    historicalOwnerHandles: new Map(),
    lastIdentityTokens: new Map(),
    ledger: [],
    balances: new Map(),
    deliverySecrets: new Map(),
    taskMilestoneNames: new Map(),
    processedWebhookEventIds: new Set()
  };
}
