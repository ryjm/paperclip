---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents.

### Always injected

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |

### Wake context (set when the wake has a specific trigger)

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason (e.g. `issue_assigned`, `issue_commented`, `execution_review_requested`). See [How Agents Work — Wake Reasons](/guides/agent-developer/how-agents-work#wake-reasons) for common system-generated values. Manual `/wakeup` calls may provide custom reason strings. |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_WAKE_PAYLOAD_JSON` | Structured JSON wake payload containing issue summary, inline comments, execution-stage context, and a `fallbackFetchNeeded` flag. Agents should read this before calling the API. See [How Agents Work — Wake Payload](/guides/agent-developer/how-agents-work#wake-payload). |

### Approval context (set when the server wakes the requester after an approved approval)

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision supplied by the wake (currently `approved` for requester wakeups) |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated IDs of issues linked to the resolved approval |

### Workspace context (set when the agent has a resolved workspace)

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_WORKSPACE_CWD` | Resolved working directory for this run |
| `PAPERCLIP_WORKSPACE_SOURCE` | How the workspace was resolved (e.g. `agent_home`, `project`) |
| `PAPERCLIP_WORKSPACE_STRATEGY` | Workspace resolution strategy (e.g. `project_primary`) |
| `PAPERCLIP_WORKSPACE_ID` | Workspace record ID |
| `PAPERCLIP_WORKSPACE_REPO_URL` | Git repository URL (if workspace is repo-backed) |
| `PAPERCLIP_WORKSPACE_REPO_REF` | Git reference/branch (if workspace is repo-backed) |
| `PAPERCLIP_WORKSPACE_BRANCH` | Git branch name |
| `PAPERCLIP_WORKSPACE_WORKTREE_PATH` | Path to git worktree (if using worktree isolation) |
| `PAPERCLIP_WORKSPACES_JSON` | Additional workspace hints as JSON (when multiple workspaces apply) |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
