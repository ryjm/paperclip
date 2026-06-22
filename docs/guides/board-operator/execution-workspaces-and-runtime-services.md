---
title: Execution Workspaces And Runtime Services
summary: How project runtime configuration, execution workspaces, and issue runs fit together
---

This guide documents the intended runtime model for projects, execution workspaces, and issue runs in Paperclip.

Paperclip now presents this as a workspace-command model:

- `Services` are long-running commands that stay supervised.
- `Jobs` are one-shot commands that run once and exit.
- Raw runtime JSON is still available for advanced config, but it is no longer the primary mental model.

## Project runtime configuration

You can define how to run a project on the project workspace itself.

- Project workspace runtime config describes the services and jobs available for that project checkout.
- This is the default runtime configuration that child execution workspaces may inherit.
- Defining the config does not start anything by itself.

## Manual runtime control

Workspace commands are manually controlled from the UI.

- Project workspace services are started and stopped from the project workspace UI, and project jobs can be run on demand there.
- Execution workspace services are started and stopped from the execution workspace UI, and execution-workspace jobs can be run on demand there.
- Paperclip does not automatically start or stop these workspace services as part of issue execution.
- Paperclip also does not automatically restart workspace services on server boot.

### Runtime control routes

Two routes expose runtime control for execution workspaces:

```
POST /api/execution-workspaces/{id}/runtime-services/:action
POST /api/execution-workspaces/{id}/runtime-commands/:action
```

Both routes share the same handler. The `:action` path parameter must be one of `start`, `stop`, `restart`, or `run`.

### Actions

- **`start`** — starts the configured runtime services for the execution workspace. Ensures the workspace checkout is available first (provisioning if necessary). Requires an effective runtime config (own or inherited from the project workspace).
- **`stop`** — stops running runtime services. Does not require runtime config.
- **`restart`** — stops then starts services. Equivalent to a `stop` followed by a `start`.
- **`run`** — runs a one-shot job command. Requires a `workspaceCommandId` that points to a job-type workspace command. Does not affect long-running services.

### Job vs service restrictions

Workspace commands are typed as either `service` (long-running) or `job` (one-shot).

- A **job** only accepts the `run` action. Calling `start`, `stop`, or `restart` on a job returns `422`.
- A **service** accepts `start`, `stop`, and `restart`. Calling `run` on a service returns `422`.
- The `run` action itself requires a workspace command to be selected — calling `run` with no `workspaceCommandId` returns `422`.

### Request body — targeting

The request body selects which commands or services to act on:

| Field | Type | Purpose |
|---|---|---|
| `workspaceCommandId` | `string` (optional) | Selects a named workspace command definition from the effective runtime config. |
| `runtimeServiceId` | `string` UUID (optional) | Targets an existing runtime service instance by its ID. |
| `serviceIndex` | `integer` (optional) | Targets a specific configured service by its position in the runtime config. |

When `workspaceCommandId` points to a service-type command and no `runtimeServiceId` is provided, Paperclip automatically matches the command to its corresponding runtime service instance by name, command string, and working directory.

When none of these fields are set, service actions (`start`, `stop`, `restart`) apply to all configured services.

### Local-path requirement

The execution workspace must have a local `cwd` (checkout path) before any runtime command can run. If the workspace has no local path, the route returns `422` with:

```
Execution workspace needs a local path before Paperclip can run workspace commands
```

For `start`, `restart`, and `run`, the handler additionally ensures the workspace checkout is provisioned and available before proceeding.

### Common failure responses

| Status | Condition |
|---|---|
| `404` | Execution workspace not found. |
| `404` | Action is not `start`, `stop`, `restart`, or `run`. |
| `404` | `workspaceCommandId` does not match any command in the effective runtime config. |
| `404` | `runtimeServiceId` does not match any existing runtime service on this workspace. |
| `422` | Workspace has no local `cwd`. |
| `422` | Job command used with `start`, `stop`, or `restart`. |
| `422` | Service command used with `run`. |
| `422` | `run` action called with no workspace command selected. |
| `422` | `start` or `restart` called but no effective runtime config exists (neither own config nor inherited project workspace config). |
| `422` | `serviceIndex` is out of range for the configured service entries. |

## Execution workspace inheritance

Execution workspaces isolate code and runtime state from the project primary workspace.

- An isolated execution workspace has its own checkout path, branch, and local runtime instance.
- The runtime configuration may inherit from the linked project workspace by default.
- The execution workspace may override that runtime configuration with its own workspace-specific settings.
- The inherited configuration answers "which commands exist and how to run them", but any running service process is still specific to that execution workspace.

## Issues and execution workspaces

Issues are attached to execution workspace behavior, not to automatic runtime management.

- An issue may create a new execution workspace when you choose an isolated workspace mode.
- An issue may reuse an existing execution workspace when you choose reuse.
- Multiple issues may intentionally share one execution workspace so they can work against the same branch and running runtime services.
- Assigning or running an issue does not automatically start or stop workspace services for that workspace.

## Execution workspace lifecycle

Execution workspaces are durable until a human closes them.

- The UI can archive an execution workspace.
- Closing an execution workspace stops its runtime services and cleans up its workspace artifacts when allowed.
- Shared workspaces that point at the project primary checkout are treated more conservatively during cleanup than disposable isolated workspaces.

## Resolved workspace logic during heartbeat runs

Heartbeat still resolves a workspace for the run, but that is about code location and session continuity, not runtime-service control.

1. Heartbeat resolves a base workspace for the run.
2. Paperclip realizes the effective execution workspace, including creating or reusing a worktree when needed.
3. Paperclip persists execution-workspace metadata such as paths, refs, and provisioning settings.
4. Heartbeat passes the resolved code workspace to the agent run.
5. Workspace runtime services remain manual UI-managed controls rather than automatic heartbeat-managed services.

## Current implementation guarantees

With the current implementation:

- Project workspace command config is the fallback for execution workspace UI controls.
- Execution workspace runtime overrides are stored on the execution workspace.
- Heartbeat runs do not auto-start workspace services.
- Server startup does not auto-restart workspace services.
