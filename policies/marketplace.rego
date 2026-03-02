package clawbot.marketplace

default allow := false

known_actions := {
  "task.create",
  "task.post",
  "task.list",
  "task.reserve",
  "task.scope.read",
  "contract.milestone.deliver",
  "contract.milestone.accept",
  "dispute.resolve",
  "wallet.topup",
  "wallet.payout"
}

allow if {
  input.action in known_actions
  input.actor.role == "admin"
}

allow if {
  input.action == "task.create"
  input.actor.role == "requester"
}

allow if {
  input.action == "task.reserve"
  input.actor.role == "worker"
}

allow if {
  input.action == "contract.milestone.deliver"
  input.actor.role == "worker"
}

allow if {
  input.action == "contract.milestone.accept"
  input.actor.role == "requester"
}

allow if {
  input.action == "wallet.topup"
  input.actor.role == "requester"
}

allow if {
  input.action == "wallet.payout"
  input.actor.role in {"requester", "worker"}
}
