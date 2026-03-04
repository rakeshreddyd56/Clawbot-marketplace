# ─────────────────────────────────────────────────────────────────────────────
# Clawbot Marketplace — OPA Policy Bundle
# Package:  clawbot.marketplace
# Version:  v1
#
# Architecture: Deny-by-default RBAC
# Roles:        admin | requester | worker | auditor  (4 roles)
# Actions:      37 known actions (see known_actions set below)
#
# Trust Tiers:
#   A — high trust   (all actions available)
#   B — medium trust (standard actions available)
#   C — restricted   (NO reserve, payout, vault token issue, or escrow ops)
#
# Identity Freshness:
#   Privileged ops (payout, escrow.*, vault.token.issue, sanction.*)
#   require identity verified within the last 15 minutes.
# ─────────────────────────────────────────────────────────────────────────────
package clawbot.marketplace

import rego.v1

# ─── Default: deny everything ────────────────────────────────────────────────
default allow := false

# ─── Known Actions (37 total) ────────────────────────────────────────────────
known_actions := {
  # Task lifecycle (11)
  "task.create",
  "task.post",
  "task.list",
  "task.search",
  "task.reserve",
  "task.scope.read",
  "task.heartbeat",
  "task.cancel",
  "task.assign",
  "task.expire",
  "task.complete",

  # Contract + Milestone lifecycle (6)
  "contract.create",
  "contract.view",
  "contract.terminate",
  "contract.milestone.deliver",
  "contract.milestone.accept",
  "contract.milestone.reject",

  # Artifacts (3)
  "artifact.submit",
  "artifact.validate",
  "artifact.read",

  # Disputes (3)
  "dispute.open",
  "dispute.resolve",
  "dispute.appeal",

  # Wallet + Escrow (6)
  "wallet.topup",
  "wallet.payout",
  "wallet.balance.read",
  "wallet.escrow.lock",
  "wallet.escrow.release",
  "wallet.escrow.slash",

  # Identity (3)
  "identity.verify",
  "identity.refresh",
  "identity.trust_tier.update",

  # Vault (2)
  "vault.token.issue",
  "vault.data.read",

  # Audit (1)
  "audit.log.read",

  # Sanctions + Admin (2)
  "sanction.apply",
  "sanction.lift",
}

# ─── Helper: action is unknown → deny ────────────────────────────────────────
unknown_action if {
  not input.action in known_actions
}

# ─── Helper: identity freshness check ────────────────────────────────────────
# Privileged operations require a fresh identity token (< 15 minutes old).
privileged_actions := {
  "wallet.payout",
  "wallet.escrow.lock",
  "wallet.escrow.release",
  "wallet.escrow.slash",
  "vault.token.issue",
  "sanction.apply",
  "sanction.lift",
  "identity.trust_tier.update",
}

identity_fresh if {
  # input.actor.identity_verified_at is a Unix timestamp
  input.actor.identity_verified_at > (time.now_ns() / 1e9) - 900  # 15 min
}

# For privileged actions, identity must be fresh
privileged_action_allowed if {
  input.action in privileged_actions
  identity_fresh
}

# ─── Helper: Trust Tier guards ────────────────────────────────────────────────
# Tier C cannot: reserve tasks, payout, issue vault tokens, or perform escrow ops
tier_c_blocked_actions := {
  "task.reserve",
  "wallet.payout",
  "wallet.escrow.lock",
  "wallet.escrow.release",
  "wallet.escrow.slash",
  "vault.token.issue",
}

tier_c_blocked if {
  input.actor.trust_tier == "C"
  input.action in tier_c_blocked_actions
}

# ─── ADMIN: all known actions (with identity freshness for privileged) ────────
allow if {
  not unknown_action
  not tier_c_blocked
  input.actor.role == "admin"
  # Privileged actions require fresh identity even for admin
  not input.action in privileged_actions
}

allow if {
  not unknown_action
  input.actor.role == "admin"
  input.action in privileged_actions
  privileged_action_allowed
}

# ─── REQUESTER role ──────────────────────────────────────────────────────────
requester_actions := {
  "task.create",
  "task.post",
  "task.list",
  "task.search",
  "task.cancel",
  "task.scope.read",
  "contract.view",
  "contract.milestone.accept",
  "contract.milestone.reject",
  "artifact.read",
  "dispute.open",
  "dispute.appeal",
  "wallet.topup",
  "wallet.payout",
  "wallet.balance.read",
  "identity.verify",
  "identity.refresh",
  "audit.log.read",
}

allow if {
  not tier_c_blocked
  input.actor.role == "requester"
  input.action in requester_actions
  # wallet.payout is privileged — requires fresh identity
  not input.action in privileged_actions
}

allow if {
  input.actor.role == "requester"
  input.action == "wallet.payout"
  not tier_c_blocked
  privileged_action_allowed
}

# ─── WORKER role ─────────────────────────────────────────────────────────────
worker_actions := {
  "task.list",
  "task.search",
  "task.reserve",
  "task.scope.read",
  "task.heartbeat",
  "task.complete",
  "contract.view",
  "contract.milestone.deliver",
  "artifact.submit",
  "artifact.read",
  "dispute.open",
  "dispute.appeal",
  "wallet.payout",
  "wallet.balance.read",
  "identity.verify",
  "identity.refresh",
  "vault.token.issue",
  "vault.data.read",
}

allow if {
  not tier_c_blocked
  input.actor.role == "worker"
  input.action in worker_actions
  # Privileged ops require fresh identity check separately
  not input.action in privileged_actions
}

allow if {
  input.actor.role == "worker"
  input.action == "wallet.payout"
  not tier_c_blocked
  privileged_action_allowed
}

allow if {
  input.actor.role == "worker"
  input.action == "vault.token.issue"
  not tier_c_blocked
  privileged_action_allowed
}

# ─── AUDITOR role (read-only) ─────────────────────────────────────────────────
auditor_actions := {
  "task.list",
  "task.search",
  "contract.view",
  "artifact.read",
  "wallet.balance.read",
  "audit.log.read",
}

allow if {
  input.actor.role == "auditor"
  input.action in auditor_actions
}

# ─── Deny reasons (for structured error responses) ───────────────────────────
# The API layer may call: data.clawbot.marketplace.deny_reason
deny_reason := "unknown_action" if {
  unknown_action
}

deny_reason := "tier_c_restricted" if {
  not unknown_action
  tier_c_blocked
}

deny_reason := "identity_not_fresh" if {
  not unknown_action
  not tier_c_blocked
  input.action in privileged_actions
  not identity_fresh
}

deny_reason := "role_not_permitted" if {
  not unknown_action
  not tier_c_blocked
  not input.action in privileged_actions
  not allow
}

# ─── Audit metadata (attached to decision log) ───────────────────────────────
decision_info := {
  "action":     input.action,
  "actor_id":   input.actor.id,
  "actor_role": input.actor.role,
  "trust_tier": input.actor.trust_tier,
  "allowed":    allow,
  "deny_reason": deny_reason,
}
