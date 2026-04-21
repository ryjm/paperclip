---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm paperclipai issue update <issue-id> [--status done] [--comment "..."]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout issue for an agent (accepts UUID or identifier like PORA-137)
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> \
  [--expected-statuses todo,backlog,blocked]

# Release issue back to todo and clear the assignee
pnpm paperclipai issue release <issue-id>
```

Use `issue checkout` to claim agent-owned work. Do not use
`issue update --status in_progress` as a claim operation; checkout performs the
single-assignee ownership transition and returns `409 Conflict` if another
agent owns the issue.

Multiline markdown is preserved when you pass the comment body via a shell
here-string or `$(cat)`; the CLI forwards the body verbatim:

```sh
pnpm paperclipai issue comment PORA-137 --body "$(cat <<'MD'
## Verification

- Confirmed CLI uses `POST /api/agents/:id/wakeup`.
- `pnpm paperclipai agent local-cli --help` matches the docs example.
MD
)"
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
# List agents for a company
pnpm paperclipai agent list --company-id <company-id>

# Get one agent by UUID or url-key
pnpm paperclipai agent get <agentRef>

# Provision a local CLI session for an agent:
#   - mints a long-lived API key on the agent
#   - symlinks Paperclip skills into ~/.codex/skills and ~/.claude/skills
#   - prints the PAPERCLIP_* shell exports the local Codex/Claude sessions need
pnpm paperclipai agent local-cli <agentRef> --company-id <company-id>

# Useful flags:
#   --key-name <label>      Override the API key label (default: "local-cli")
#   --no-install-skills     Skip the skills symlink install
#   --json                  Emit the full result (including the minted token) as JSON
```

The command prints a shell `export` block once per run; treat that output as a
one-time secret and redirect it to a local file such as `~/.paperclip/env.sh`
rather than committing or pasting it into chat. Re-running `agent local-cli`
creates a new key — the previous key stays valid until revoked via the API.

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Heartbeat

`heartbeat run` calls `POST /api/agents/:id/wakeup` and streams the resulting
heartbeat-run events back to your terminal until the run reaches a terminal
status:

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> \
  [--api-base http://localhost:3100] \
  [--source on_demand|timer|assignment|automation] \
  [--trigger manual|ping|callback|system] \
  [--timeout-ms 0] \
  [--debug] \
  [--json]
```

`--timeout-ms 0` disables the client-side timeout (the default); any positive
value fails the CLI with `timed_out` once exceeded. Pass `--debug` to see raw
adapter stdout/stderr instead of the formatted event stream.
