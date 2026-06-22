---
title: Execution Workspaces
summary: List, inspect, control, and archive execution workspaces
---

Execution workspaces are the concrete workspace sessions Paperclip realizes for project and issue execution. They may point at a shared project checkout, an isolated git worktree, or an adapter-managed sandbox.

Timestamp fields in JSON responses are serialized as ISO 8601 strings.

## List Execution Workspaces

```
GET /api/companies/{companyId}/execution-workspaces
```

Query parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | Filter to execution workspaces for one project |
| `projectWorkspaceId` | string | Filter to workspaces derived from one project workspace |
| `issueId` | string | Filter to the execution workspace linked to an issue |
| `status` | string | Filter by one or more comma-separated statuses: `active`, `idle`, `in_review`, `archived`, `cleanup_failed` |
| `reuseEligible` | boolean | Restrict results to reusable active workspaces (`active`, `idle`, `in_review`) |
| `summary` | boolean | Return lightweight summary rows instead of full workspace objects |

Example:

```
GET /api/companies/{companyId}/execution-workspaces?projectId={projectId}&reuseEligible=true&summary=true
```

When `summary=true`, the response is an array of:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Execution workspace id |
| `name` | string | Display name |
| `mode` | string | Workspace mode such as `shared_workspace` or `isolated_workspace` |
| `projectWorkspaceId` | string | Backing project workspace id, when present |

Without `summary=true`, the response is an array of full execution workspace objects.

Results are ordered by `lastUsedAt` descending, then `createdAt` descending.

## Get Execution Workspace

```
GET /api/execution-workspaces/{workspaceId}
```

Returns the full execution workspace, including its persisted config and current runtime services.

Core fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Execution workspace id |
| `companyId` | string | Owning company id |
| `projectId` | string | Owning project id |
| `projectWorkspaceId` | string | Backing project workspace id, when present |
| `sourceIssueId` | string | Issue currently attached to the workspace, when present |
| `mode` | string | `shared_workspace`, `isolated_workspace`, `operator_branch`, `adapter_managed`, or `cloud_sandbox` |
| `strategyType` | string | Realization strategy such as `project_primary` or `git_worktree` |
| `status` | string | `active`, `idle`, `in_review`, `archived`, or `cleanup_failed` |
| `cwd` | string | Local path if the workspace exists on disk |
| `repoUrl` | string | Repository URL when tracked |
| `baseRef` | string | Base branch or ref |
| `branchName` | string | Active branch name when known |
| `providerType` | string | `local_fs`, `git_worktree`, `adapter_managed`, or `cloud_sandbox` |
| `providerRef` | string | Provider-specific identifier or realized path |
| `derivedFromExecutionWorkspaceId` | string | Parent execution workspace id when this workspace was derived from another one |
| `lastUsedAt` | string | Most recent activity timestamp |
| `openedAt` | string | When the workspace was opened |
| `closedAt` | string | When the workspace was closed, if archived |
| `cleanupEligibleAt` | string | ISO timestamp for cleanup eligibility |
| `cleanupReason` | string | Cleanup or archive warning/failure summary |
| `config` | object | Normalized execution workspace config |
| `metadata` | object | Raw persisted metadata |
| `runtimeServices` | array | Current runtime services visible from this workspace |
| `createdAt` | string | Record creation timestamp |
| `updatedAt` | string | Record update timestamp |

`config` may include:

- `provisionCommand`
- `teardownCommand`
- `cleanupCommand`
- `workspaceRuntime`
- `desiredState`
- `serviceStates`

For shared workspaces that inherit runtime config from the project workspace, `runtimeServices` may reflect those inherited project-level services.

## Get Close Readiness

```
GET /api/execution-workspaces/{workspaceId}/close-readiness
```

Returns the preflight state for archiving a workspace.

Important response fields:

| Field | Type | Description |
|-------|------|-------------|
| `workspaceId` | string | Execution workspace id |
| `state` | string | `ready`, `ready_with_warnings`, or `blocked` |
| `blockingReasons` | string[] | Reasons the workspace cannot be archived yet |
| `warnings` | string[] | Non-blocking warnings such as dirty git state or attached runtime services |
| `linkedIssues` | array | Issues currently linked to the workspace, with `isTerminal` flags |
| `plannedActions` | array | Cleanup actions Paperclip plans to run during archive |
| `isDestructiveCloseAllowed` | boolean | Whether archive can proceed |
| `isSharedWorkspace` | boolean | Whether the workspace is a shared project session |
| `isProjectPrimaryWorkspace` | boolean | Whether the path matches the project's primary workspace |
| `git` | object | Git readiness summary, including dirty/untracked counts and ahead/behind state |
| `runtimeServices` | array | Attached runtime services that may be stopped on archive |

This endpoint is the authoritative way to decide whether a workspace can be safely archived and what side effects to expect.

`plannedActions[].kind` is one of:

- `archive_record`
- `stop_runtime_services`
- `cleanup_command`
- `teardown_command`
- `git_worktree_remove`
- `git_branch_delete`
- `remove_local_directory`

## List Workspace Operations

```
GET /api/execution-workspaces/{workspaceId}/workspace-operations
```

Returns recorded workspace operations for that execution workspace, newest first.

Each operation includes:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Operation id |
| `phase` | string | `worktree_prepare`, `workspace_provision`, `workspace_teardown`, or `worktree_cleanup` |
| `status` | string | `running`, `succeeded`, `failed`, or `skipped` |
| `command` | string | Command or control label recorded for the operation |
| `cwd` | string | Working directory used for the operation |
| `exitCode` | number | Process exit code, when available |
| `heartbeatRunId` | string | Heartbeat run associated with the operation, when present |
| `logStore` | string | Backing log storage provider key |
| `logRef` | string | Log object reference in the backing store |
| `logBytes` | number | Stored log size in bytes |
| `logSha256` | string | SHA-256 of the stored log payload |
| `logCompressed` | boolean | Whether the stored log payload is compressed |
| `stdoutExcerpt` | string | Tail excerpt of captured stdout |
| `stderrExcerpt` | string | Tail excerpt of captured stderr |
| `metadata` | object | Route-specific metadata such as action, command id, or runtime service id |
| `startedAt` | string | ISO start timestamp |
| `finishedAt` | string | ISO finish timestamp |
| `createdAt` | string | Record creation timestamp |
| `updatedAt` | string | Record update timestamp |

## Control Runtime Services

```
POST /api/execution-workspaces/{workspaceId}/runtime-services/{action}
```

`action` must be one of:

- `start`
- `stop`
- `restart`

Request body:

```json
{
  "workspaceCommandId": "command-id",
  "runtimeServiceId": "2d7418d8-3f0b-4f15-bd35-2a855e338b72",
  "serviceIndex": 0
}
```

This same request body shape is used by both runtime control endpoints. All request fields are optional:

- `workspaceCommandId` targets a configured workspace command
- `runtimeServiceId` targets a specific persisted runtime service instance and must be a UUID
- `serviceIndex` targets a service definition by index in the resolved runtime config

The response shape is:

```json
{
  "workspace": { "...": "updated execution workspace" },
  "operation": { "...": "recorded workspace operation" }
}
```

Common failure modes:

- `403` if the caller lacks permission to manage execution workspace runtime services
- `404` if the workspace, selected workspace command, or selected runtime service does not exist
- `422` if the workspace has no local path or no resolved runtime configuration

## Control Runtime Commands

```
POST /api/execution-workspaces/{workspaceId}/runtime-commands/{action}
```

`action` must be one of:

- `start`
- `stop`
- `restart`
- `run`

Use this endpoint for both service-style commands and one-shot jobs defined in the workspace runtime model:

- use `run` for workspace jobs
- use `start`, `stop`, or `restart` for workspace services

Paperclip returns `422` when the action does not match the selected command kind, for example trying to `run` a service or `start` a job.

This endpoint uses the same request body and response shape as `POST /api/execution-workspaces/{workspaceId}/runtime-services/{action}`.

Additional command-specific failure modes:

- `422` if `run` is requested without selecting a workspace job
- `422` if the selected `serviceIndex` is outside the resolved runtime config

## Update or Archive an Execution Workspace

```
PATCH /api/execution-workspaces/{workspaceId}
```

Editable fields:

```json
{
  "name": "Frontend review workspace",
  "cwd": "/repos/app/.worktrees/frontend-review",
  "repoUrl": "https://github.com/org/app",
  "baseRef": "main",
  "branchName": "paperclip/frontend-review",
  "providerRef": "/repos/app/.worktrees/frontend-review",
  "status": "active",
  "cleanupEligibleAt": "2026-06-21T18:00:00.000Z",
  "cleanupReason": null,
  "config": {
    "provisionCommand": "pnpm install",
    "teardownCommand": "docker compose down",
    "cleanupCommand": "rm -rf .cache",
    "workspaceRuntime": {},
    "desiredState": "running",
    "serviceStates": {
      "0": "running"
    }
  },
  "metadata": {
    "createdByRuntime": true
  }
}
```

Notes:

- `config` is normalized into the workspace metadata and merged with the existing stored config.
- sending `"config": null` clears the normalized `metadata.config` block
- Agent callers are blocked from patching host-executed workspace commands through `config` or `metadata.config`.
- Setting `status` to `archived` triggers the archive flow instead of a simple field update.

Archive behavior:

- Paperclip checks close readiness first.
- If the workspace is blocked, the server returns `409` with an `error` and `closeReadiness`.
- If archive proceeds, Paperclip may stop runtime services, run cleanup and teardown commands, remove git worktrees, delete runtime-created branches, or remove runtime-created local directories.
- Shared workspaces archive the execution-workspace record and detach linked issues without deleting the underlying project workspace.
- If cleanup fails after the archive transition starts, the workspace may be returned as `cleanup_failed` with a `cleanupReason`.
- If teardown or cleanup throws an unexpected server error, the route returns `500` after marking the workspace `cleanup_failed`.
