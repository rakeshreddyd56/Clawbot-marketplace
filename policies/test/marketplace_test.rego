# ─────────────────────────────────────────────────────────────────────────────
# Clawbot Marketplace — OPA Unit Tests
# Run: opa test policies/ -v
#
# Coverage:
#   - Deny-by-default (unknown actions)
#   - Admin role: all known actions allowed
#   - Requester role: allowed/denied action matrix
#   - Worker role: allowed/denied action matrix
#   - Auditor role: read-only actions only
#   - Trust Tier C: blocked actions denied
#   - Identity freshness: privileged ops require fresh identity
#   - deny_reason metadata: correct code returned per denial type
# ─────────────────────────────────────────────────────────────────────────────
package clawbot.marketplace_test

import rego.v1
import data.clawbot.marketplace

# ─── Shared test fixtures ────────────────────────────────────────────────────

# A Unix timestamp representing "now" (deterministic for tests)
# opa test uses time.now_ns() mock — we control identity_verified_at offsets.

fresh_ts := time.now_ns() / 1e9  # verified right now → always fresh

stale_ts := (time.now_ns() / 1e9) - 3600  # verified 60 min ago → never fresh

# ─── Helper: build an input object ───────────────────────────────────────────

actor(role, tier, verified_at) := {
  "id": "agent-test-001",
  "role": role,
  "trust_tier": tier,
  "identity_verified_at": verified_at,
}

input_for(action, role, tier, verified_at) := {
  "action": action,
  "actor": actor(role, tier, verified_at),
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Deny-by-default: unknown actions are always denied
# ─────────────────────────────────────────────────────────────────────────────

test_unknown_action_denied_admin if {
  not marketplace.allow with input as input_for("nonexistent.action", "admin", "A", fresh_ts)
}

test_unknown_action_denied_worker if {
  not marketplace.allow with input as input_for("hack.system", "worker", "A", fresh_ts)
}

test_unknown_action_deny_reason if {
  marketplace.deny_reason == "unknown_action" with input as input_for("totally.unknown", "admin", "A", fresh_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. ADMIN role — all 37 known actions permitted
# ─────────────────────────────────────────────────────────────────────────────

# Task lifecycle (11 actions)
test_admin_task_create if {
  marketplace.allow with input as input_for("task.create", "admin", "A", fresh_ts)
}
test_admin_task_post if {
  marketplace.allow with input as input_for("task.post", "admin", "A", fresh_ts)
}
test_admin_task_list if {
  marketplace.allow with input as input_for("task.list", "admin", "A", fresh_ts)
}
test_admin_task_search if {
  marketplace.allow with input as input_for("task.search", "admin", "A", fresh_ts)
}
test_admin_task_reserve if {
  marketplace.allow with input as input_for("task.reserve", "admin", "A", fresh_ts)
}
test_admin_task_scope_read if {
  marketplace.allow with input as input_for("task.scope.read", "admin", "A", fresh_ts)
}
test_admin_task_heartbeat if {
  marketplace.allow with input as input_for("task.heartbeat", "admin", "A", fresh_ts)
}
test_admin_task_cancel if {
  marketplace.allow with input as input_for("task.cancel", "admin", "A", fresh_ts)
}
test_admin_task_assign if {
  marketplace.allow with input as input_for("task.assign", "admin", "A", fresh_ts)
}
test_admin_task_expire if {
  marketplace.allow with input as input_for("task.expire", "admin", "A", fresh_ts)
}
test_admin_task_complete if {
  marketplace.allow with input as input_for("task.complete", "admin", "A", fresh_ts)
}

# Contract + Milestone lifecycle (6 actions)
test_admin_contract_create if {
  marketplace.allow with input as input_for("contract.create", "admin", "A", fresh_ts)
}
test_admin_contract_view if {
  marketplace.allow with input as input_for("contract.view", "admin", "A", fresh_ts)
}
test_admin_contract_terminate if {
  marketplace.allow with input as input_for("contract.terminate", "admin", "A", fresh_ts)
}
test_admin_contract_milestone_deliver if {
  marketplace.allow with input as input_for("contract.milestone.deliver", "admin", "A", fresh_ts)
}
test_admin_contract_milestone_accept if {
  marketplace.allow with input as input_for("contract.milestone.accept", "admin", "A", fresh_ts)
}
test_admin_contract_milestone_reject if {
  marketplace.allow with input as input_for("contract.milestone.reject", "admin", "A", fresh_ts)
}

# Artifacts (3 actions)
test_admin_artifact_submit if {
  marketplace.allow with input as input_for("artifact.submit", "admin", "A", fresh_ts)
}
test_admin_artifact_validate if {
  marketplace.allow with input as input_for("artifact.validate", "admin", "A", fresh_ts)
}
test_admin_artifact_read if {
  marketplace.allow with input as input_for("artifact.read", "admin", "A", fresh_ts)
}

# Disputes (3 actions)
test_admin_dispute_open if {
  marketplace.allow with input as input_for("dispute.open", "admin", "A", fresh_ts)
}
test_admin_dispute_resolve if {
  marketplace.allow with input as input_for("dispute.resolve", "admin", "A", fresh_ts)
}
test_admin_dispute_appeal if {
  marketplace.allow with input as input_for("dispute.appeal", "admin", "A", fresh_ts)
}

# Wallet + Escrow (privileged — requires fresh identity)
test_admin_wallet_topup if {
  marketplace.allow with input as input_for("wallet.topup", "admin", "A", fresh_ts)
}
test_admin_wallet_payout_fresh if {
  marketplace.allow with input as input_for("wallet.payout", "admin", "A", fresh_ts)
}
test_admin_wallet_balance_read if {
  marketplace.allow with input as input_for("wallet.balance.read", "admin", "A", fresh_ts)
}
test_admin_wallet_escrow_lock_fresh if {
  marketplace.allow with input as input_for("wallet.escrow.lock", "admin", "A", fresh_ts)
}
test_admin_wallet_escrow_release_fresh if {
  marketplace.allow with input as input_for("wallet.escrow.release", "admin", "A", fresh_ts)
}
test_admin_wallet_escrow_slash_fresh if {
  marketplace.allow with input as input_for("wallet.escrow.slash", "admin", "A", fresh_ts)
}

# Identity (3 actions)
test_admin_identity_verify if {
  marketplace.allow with input as input_for("identity.verify", "admin", "A", fresh_ts)
}
test_admin_identity_refresh if {
  marketplace.allow with input as input_for("identity.refresh", "admin", "A", fresh_ts)
}
test_admin_identity_trust_tier_update_fresh if {
  marketplace.allow with input as input_for("identity.trust_tier.update", "admin", "A", fresh_ts)
}

# Vault (2 actions)
test_admin_vault_token_issue_fresh if {
  marketplace.allow with input as input_for("vault.token.issue", "admin", "A", fresh_ts)
}
test_admin_vault_data_read if {
  marketplace.allow with input as input_for("vault.data.read", "admin", "A", fresh_ts)
}

# Audit (1 action)
test_admin_audit_log_read if {
  marketplace.allow with input as input_for("audit.log.read", "admin", "A", fresh_ts)
}

# Sanctions (2 actions — privileged)
test_admin_sanction_apply_fresh if {
  marketplace.allow with input as input_for("sanction.apply", "admin", "A", fresh_ts)
}
test_admin_sanction_lift_fresh if {
  marketplace.allow with input as input_for("sanction.lift", "admin", "A", fresh_ts)
}

# Admin + stale identity → privileged ops denied
test_admin_wallet_payout_stale_identity_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "admin", "A", stale_ts)
}
test_admin_wallet_escrow_lock_stale_identity_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.lock", "admin", "A", stale_ts)
}
test_admin_sanction_apply_stale_identity_denied if {
  not marketplace.allow with input as input_for("sanction.apply", "admin", "A", stale_ts)
}
test_admin_vault_token_issue_stale_identity_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "admin", "A", stale_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. REQUESTER role — allowed actions
# ─────────────────────────────────────────────────────────────────────────────

test_requester_task_create if {
  marketplace.allow with input as input_for("task.create", "requester", "A", fresh_ts)
}
test_requester_task_post if {
  marketplace.allow with input as input_for("task.post", "requester", "A", fresh_ts)
}
test_requester_task_list if {
  marketplace.allow with input as input_for("task.list", "requester", "A", fresh_ts)
}
test_requester_task_search if {
  marketplace.allow with input as input_for("task.search", "requester", "A", fresh_ts)
}
test_requester_task_cancel if {
  marketplace.allow with input as input_for("task.cancel", "requester", "A", fresh_ts)
}
test_requester_task_scope_read if {
  marketplace.allow with input as input_for("task.scope.read", "requester", "A", fresh_ts)
}
test_requester_contract_view if {
  marketplace.allow with input as input_for("contract.view", "requester", "A", fresh_ts)
}
test_requester_contract_milestone_accept if {
  marketplace.allow with input as input_for("contract.milestone.accept", "requester", "A", fresh_ts)
}
test_requester_contract_milestone_reject if {
  marketplace.allow with input as input_for("contract.milestone.reject", "requester", "A", fresh_ts)
}
test_requester_artifact_read if {
  marketplace.allow with input as input_for("artifact.read", "requester", "A", fresh_ts)
}
test_requester_dispute_open if {
  marketplace.allow with input as input_for("dispute.open", "requester", "A", fresh_ts)
}
test_requester_dispute_appeal if {
  marketplace.allow with input as input_for("dispute.appeal", "requester", "A", fresh_ts)
}
test_requester_wallet_topup if {
  marketplace.allow with input as input_for("wallet.topup", "requester", "A", fresh_ts)
}
test_requester_wallet_payout_fresh if {
  marketplace.allow with input as input_for("wallet.payout", "requester", "A", fresh_ts)
}
test_requester_wallet_balance_read if {
  marketplace.allow with input as input_for("wallet.balance.read", "requester", "A", fresh_ts)
}
test_requester_identity_verify if {
  marketplace.allow with input as input_for("identity.verify", "requester", "A", fresh_ts)
}
test_requester_identity_refresh if {
  marketplace.allow with input as input_for("identity.refresh", "requester", "A", fresh_ts)
}
test_requester_audit_log_read if {
  marketplace.allow with input as input_for("audit.log.read", "requester", "A", fresh_ts)
}

# Requester — denied actions (not in requester_actions)
test_requester_task_reserve_denied if {
  not marketplace.allow with input as input_for("task.reserve", "requester", "A", fresh_ts)
}
test_requester_task_heartbeat_denied if {
  not marketplace.allow with input as input_for("task.heartbeat", "requester", "A", fresh_ts)
}
test_requester_artifact_submit_denied if {
  not marketplace.allow with input as input_for("artifact.submit", "requester", "A", fresh_ts)
}
test_requester_sanction_apply_denied if {
  not marketplace.allow with input as input_for("sanction.apply", "requester", "A", fresh_ts)
}
test_requester_vault_token_issue_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "requester", "A", fresh_ts)
}
test_requester_dispute_resolve_denied if {
  not marketplace.allow with input as input_for("dispute.resolve", "requester", "A", fresh_ts)
}

# Requester + stale identity → payout denied
test_requester_wallet_payout_stale_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "requester", "A", stale_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. WORKER role — allowed actions
# ─────────────────────────────────────────────────────────────────────────────

test_worker_task_list if {
  marketplace.allow with input as input_for("task.list", "worker", "A", fresh_ts)
}
test_worker_task_search if {
  marketplace.allow with input as input_for("task.search", "worker", "A", fresh_ts)
}
test_worker_task_reserve if {
  marketplace.allow with input as input_for("task.reserve", "worker", "A", fresh_ts)
}
test_worker_task_scope_read if {
  marketplace.allow with input as input_for("task.scope.read", "worker", "A", fresh_ts)
}
test_worker_task_heartbeat if {
  marketplace.allow with input as input_for("task.heartbeat", "worker", "A", fresh_ts)
}
test_worker_task_complete if {
  marketplace.allow with input as input_for("task.complete", "worker", "A", fresh_ts)
}
test_worker_contract_view if {
  marketplace.allow with input as input_for("contract.view", "worker", "A", fresh_ts)
}
test_worker_contract_milestone_deliver if {
  marketplace.allow with input as input_for("contract.milestone.deliver", "worker", "A", fresh_ts)
}
test_worker_artifact_submit if {
  marketplace.allow with input as input_for("artifact.submit", "worker", "A", fresh_ts)
}
test_worker_artifact_read if {
  marketplace.allow with input as input_for("artifact.read", "worker", "A", fresh_ts)
}
test_worker_dispute_open if {
  marketplace.allow with input as input_for("dispute.open", "worker", "A", fresh_ts)
}
test_worker_dispute_appeal if {
  marketplace.allow with input as input_for("dispute.appeal", "worker", "A", fresh_ts)
}
test_worker_wallet_payout_fresh if {
  marketplace.allow with input as input_for("wallet.payout", "worker", "A", fresh_ts)
}
test_worker_wallet_balance_read if {
  marketplace.allow with input as input_for("wallet.balance.read", "worker", "A", fresh_ts)
}
test_worker_identity_verify if {
  marketplace.allow with input as input_for("identity.verify", "worker", "A", fresh_ts)
}
test_worker_identity_refresh if {
  marketplace.allow with input as input_for("identity.refresh", "worker", "A", fresh_ts)
}
test_worker_vault_token_issue_fresh if {
  marketplace.allow with input as input_for("vault.token.issue", "worker", "A", fresh_ts)
}
test_worker_vault_data_read if {
  marketplace.allow with input as input_for("vault.data.read", "worker", "A", fresh_ts)
}

# Worker — denied actions (not in worker_actions)
test_worker_task_create_denied if {
  not marketplace.allow with input as input_for("task.create", "worker", "A", fresh_ts)
}
test_worker_task_post_denied if {
  not marketplace.allow with input as input_for("task.post", "worker", "A", fresh_ts)
}
test_worker_task_cancel_denied if {
  not marketplace.allow with input as input_for("task.cancel", "worker", "A", fresh_ts)
}
test_worker_contract_milestone_accept_denied if {
  not marketplace.allow with input as input_for("contract.milestone.accept", "worker", "A", fresh_ts)
}
test_worker_dispute_resolve_denied if {
  not marketplace.allow with input as input_for("dispute.resolve", "worker", "A", fresh_ts)
}
test_worker_sanction_apply_denied if {
  not marketplace.allow with input as input_for("sanction.apply", "worker", "A", fresh_ts)
}
test_worker_audit_log_read_denied if {
  not marketplace.allow with input as input_for("audit.log.read", "worker", "A", fresh_ts)
}

# Worker + stale identity → payout and vault denied
test_worker_wallet_payout_stale_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "worker", "A", stale_ts)
}
test_worker_vault_token_issue_stale_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "worker", "A", stale_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. AUDITOR role — read-only actions only
# ─────────────────────────────────────────────────────────────────────────────

test_auditor_task_list if {
  marketplace.allow with input as input_for("task.list", "auditor", "A", fresh_ts)
}
test_auditor_task_search if {
  marketplace.allow with input as input_for("task.search", "auditor", "A", fresh_ts)
}
test_auditor_contract_view if {
  marketplace.allow with input as input_for("contract.view", "auditor", "A", fresh_ts)
}
test_auditor_artifact_read if {
  marketplace.allow with input as input_for("artifact.read", "auditor", "A", fresh_ts)
}
test_auditor_wallet_balance_read if {
  marketplace.allow with input as input_for("wallet.balance.read", "auditor", "A", fresh_ts)
}
test_auditor_audit_log_read if {
  marketplace.allow with input as input_for("audit.log.read", "auditor", "A", fresh_ts)
}

# Auditor — denied write/privileged actions
test_auditor_task_create_denied if {
  not marketplace.allow with input as input_for("task.create", "auditor", "A", fresh_ts)
}
test_auditor_task_reserve_denied if {
  not marketplace.allow with input as input_for("task.reserve", "auditor", "A", fresh_ts)
}
test_auditor_wallet_payout_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "auditor", "A", fresh_ts)
}
test_auditor_wallet_escrow_lock_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.lock", "auditor", "A", fresh_ts)
}
test_auditor_sanction_apply_denied if {
  not marketplace.allow with input as input_for("sanction.apply", "auditor", "A", fresh_ts)
}
test_auditor_dispute_resolve_denied if {
  not marketplace.allow with input as input_for("dispute.resolve", "auditor", "A", fresh_ts)
}
test_auditor_artifact_submit_denied if {
  not marketplace.allow with input as input_for("artifact.submit", "auditor", "A", fresh_ts)
}
test_auditor_vault_token_issue_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "auditor", "A", fresh_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. Trust Tier C restrictions
# ─────────────────────────────────────────────────────────────────────────────

# Tier C worker: cannot reserve tasks
test_tier_c_worker_task_reserve_denied if {
  not marketplace.allow with input as input_for("task.reserve", "worker", "C", fresh_ts)
}

# Tier C worker: cannot payout (even with fresh identity)
test_tier_c_worker_wallet_payout_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "worker", "C", fresh_ts)
}

# Tier C worker: cannot issue vault token
test_tier_c_worker_vault_token_issue_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "worker", "C", fresh_ts)
}

# Tier C worker: cannot lock escrow
test_tier_c_worker_wallet_escrow_lock_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.lock", "worker", "C", fresh_ts)
}

# Tier C worker: cannot release escrow
test_tier_c_worker_wallet_escrow_release_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.release", "worker", "C", fresh_ts)
}

# Tier C worker: cannot slash escrow
test_tier_c_worker_wallet_escrow_slash_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.slash", "worker", "C", fresh_ts)
}

# Tier C worker: CAN still do read-only / non-privileged actions
test_tier_c_worker_task_list_allowed if {
  marketplace.allow with input as input_for("task.list", "worker", "C", fresh_ts)
}
test_tier_c_worker_task_search_allowed if {
  marketplace.allow with input as input_for("task.search", "worker", "C", fresh_ts)
}
test_tier_c_worker_artifact_read_allowed if {
  marketplace.allow with input as input_for("artifact.read", "worker", "C", fresh_ts)
}
test_tier_c_worker_identity_verify_allowed if {
  marketplace.allow with input as input_for("identity.verify", "worker", "C", fresh_ts)
}

# Tier C requester: cannot payout
test_tier_c_requester_wallet_payout_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "requester", "C", fresh_ts)
}

# Tier C requester: can still create tasks and read balance
test_tier_c_requester_task_create_allowed if {
  marketplace.allow with input as input_for("task.create", "requester", "C", fresh_ts)
}
test_tier_c_requester_wallet_balance_read_allowed if {
  marketplace.allow with input as input_for("wallet.balance.read", "requester", "C", fresh_ts)
}

# Tier C admin: even admin is blocked on Tier C restricted actions
test_tier_c_admin_task_reserve_denied if {
  not marketplace.allow with input as input_for("task.reserve", "admin", "C", fresh_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. Identity freshness — boundary tests
# ─────────────────────────────────────────────────────────────────────────────

# Verified exactly 14 minutes ago — still fresh (within 15 min window)
test_identity_fresh_14min if {
  ts_14min_ago := (time.now_ns() / 1e9) - 840
  marketplace.allow with input as input_for("wallet.payout", "worker", "A", ts_14min_ago)
}

# Verified exactly 16 minutes ago — stale (outside 15 min window)
test_identity_stale_16min if {
  ts_16min_ago := (time.now_ns() / 1e9) - 960
  not marketplace.allow with input as input_for("wallet.payout", "worker", "A", ts_16min_ago)
}

# All privileged actions denied with stale identity
test_escrow_lock_stale_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.lock", "admin", "A", stale_ts)
}
test_escrow_release_stale_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.release", "admin", "A", stale_ts)
}
test_escrow_slash_stale_denied if {
  not marketplace.allow with input as input_for("wallet.escrow.slash", "admin", "A", stale_ts)
}
test_vault_issue_stale_denied if {
  not marketplace.allow with input as input_for("vault.token.issue", "worker", "A", stale_ts)
}
test_sanction_lift_stale_denied if {
  not marketplace.allow with input as input_for("sanction.lift", "admin", "A", stale_ts)
}
test_identity_trust_tier_update_stale_denied if {
  not marketplace.allow with input as input_for("identity.trust_tier.update", "admin", "A", stale_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 8. deny_reason codes — structured denial metadata
# ─────────────────────────────────────────────────────────────────────────────

test_deny_reason_unknown_action if {
  marketplace.deny_reason == "unknown_action" with input as input_for("bad.action", "admin", "A", fresh_ts)
}

test_deny_reason_tier_c_restricted if {
  marketplace.deny_reason == "tier_c_restricted" with input as input_for("task.reserve", "worker", "C", fresh_ts)
}

test_deny_reason_identity_not_fresh_worker_payout if {
  marketplace.deny_reason == "identity_not_fresh" with input as input_for("wallet.payout", "worker", "A", stale_ts)
}

test_deny_reason_identity_not_fresh_escrow_lock if {
  marketplace.deny_reason == "identity_not_fresh" with input as input_for("wallet.escrow.lock", "admin", "A", stale_ts)
}

test_deny_reason_identity_not_fresh_sanction if {
  marketplace.deny_reason == "identity_not_fresh" with input as input_for("sanction.apply", "admin", "A", stale_ts)
}

test_deny_reason_role_not_permitted_auditor_task_create if {
  marketplace.deny_reason == "role_not_permitted" with input as input_for("task.create", "auditor", "A", fresh_ts)
}

test_deny_reason_role_not_permitted_worker_task_create if {
  marketplace.deny_reason == "role_not_permitted" with input as input_for("task.create", "worker", "A", fresh_ts)
}

test_deny_reason_role_not_permitted_requester_reserve if {
  marketplace.deny_reason == "role_not_permitted" with input as input_for("task.reserve", "requester", "A", fresh_ts)
}

# ─────────────────────────────────────────────────────────────────────────────
# 9. decision_info metadata shape validation
# ─────────────────────────────────────────────────────────────────────────────

test_decision_info_shape_allowed if {
  info := marketplace.decision_info with input as input_for("task.list", "worker", "A", fresh_ts)
  info.action == "task.list"
  info.actor_role == "worker"
  info.trust_tier == "A"
  info.allowed == true
}

test_decision_info_shape_denied if {
  info := marketplace.decision_info with input as input_for("bad.action", "admin", "A", fresh_ts)
  info.action == "bad.action"
  info.actor_role == "admin"
  info.allowed == false
  info.deny_reason == "unknown_action"
}

# ─────────────────────────────────────────────────────────────────────────────
# 10. Cross-cutting: Tier B (medium trust) — behaves like Tier A for most ops
# ─────────────────────────────────────────────────────────────────────────────

# Tier B worker can reserve (not in tier_c_blocked)
test_tier_b_worker_task_reserve_allowed if {
  marketplace.allow with input as input_for("task.reserve", "worker", "B", fresh_ts)
}

# Tier B worker can payout with fresh identity
test_tier_b_worker_wallet_payout_fresh_allowed if {
  marketplace.allow with input as input_for("wallet.payout", "worker", "B", fresh_ts)
}

# Tier B worker cannot payout with stale identity
test_tier_b_worker_wallet_payout_stale_denied if {
  not marketplace.allow with input as input_for("wallet.payout", "worker", "B", stale_ts)
}

# Tier B worker can issue vault token with fresh identity
test_tier_b_worker_vault_token_issue_allowed if {
  marketplace.allow with input as input_for("vault.token.issue", "worker", "B", fresh_ts)
}
