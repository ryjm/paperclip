---
title: Goals and Projects
summary: Goal hierarchy, project management, and workspace inheritance
---

Goals define the "why" and projects define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

### List Goals

```
GET /api/companies/{companyId}/goals
```

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

Valid status values: `planned`, `active`, `achieved`, `cancelled`.

## Projects

Projects group related issues toward a deliverable. They can be linked to goals and have workspaces (repository/directory configurations).

### List Projects

```
GET /api/companies/{companyId}/projects
```

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details including workspaces.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

Notes:

- `workspace` is optional. If present, the project is created and seeded with that workspace.
- A workspace must include at least one of `cwd` or `repoUrl`.
- For repo-only projects, omit `cwd` and provide `repoUrl`.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

## Project Workspaces

Workspaces link a project to a repository and directory:

```
POST /api/projects/{projectId}/workspaces
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

Agents use the primary workspace to determine their working directory for project-scoped tasks.

### Runtime configuration on project workspaces

A project workspace can define runtime configuration — services and jobs that describe how to run the project. This configuration does not start anything by itself. It serves as the **default fallback** for execution workspaces created under the project.

The inheritance chain for runtime config is:

1. **Project workspace level** — `executionWorkspacePolicy` on the project, including `workspaceRuntime` (services, jobs, commands).
2. **Issue level overrides** — `executionWorkspaceSettings` on individual issues can override the project defaults.
3. **Persisted execution workspace** — once an execution workspace is realized, its own `config.workspaceRuntime` takes precedence.

This means the project workspace config answers "which commands exist and how to run them" by default, while each execution workspace can override that configuration with workspace-specific settings.

Paperclip does not automatically start or stop workspace services when an issue is assigned or a heartbeat runs. It also does not restart workspace services on server boot. All runtime service control is manual, driven from the workspace UI. See [Execution Workspaces and Runtime Services](/guides/board-operator/execution-workspaces-and-runtime-services) for full details on runtime control.

### Manage Workspaces

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```

## How project workspaces relate to execution workspaces

Project workspaces define the canonical code location and runtime defaults for a project. When issues execute against a project, Paperclip creates or reuses **execution workspaces** that isolate code and runtime state from the project primary workspace.

### Execution workspace modes

The execution workspace mode determines how an issue gets its working directory at runtime. The mode is resolved with the following precedence:

1. If the issue has an explicit non-`inherit` mode set in `executionWorkspaceSettings` → use it.
2. Else if the project has an `executionWorkspacePolicy` enabled → use the project default mode.
3. Else → `shared_workspace` (the project primary workspace).

Available modes:

| Mode | Behavior |
|---|---|
| `shared_workspace` | Use the project primary workspace directly. Multiple issues share the same checkout. |
| `isolated_workspace` | Create a per-issue workspace with its own checkout path, branch, and local runtime instance. Uses `git_worktree` strategy by default. |
| `reuse_existing` | Reuse an existing execution workspace from another issue. The reused workspace retains its branch, checkout, and any running services. |
| `operator_branch` | Operator-driven branching mode. |
| `agent_default` | Fall back to the agent's own workspace configuration. |
| `inherit` | Derive from the project policy or legacy settings. |

### Workspace reuse across issues

Multiple issues can intentionally share one execution workspace so they work against the same branch and running services. There are two paths to reuse:

- **`inheritExecutionWorkspaceFromIssueId`** on issue creation — links the new issue to the same execution workspace as a source issue, setting mode to `reuse_existing`. This defaults to the parent issue if not explicitly specified.
- **Child issue inheritance** — child issues (via `parentId`) inherit their parent's `projectWorkspaceId` and execution workspace linkage server-side.

For non-child follow-ups that should share the same workspace, pass `inheritExecutionWorkspaceFromIssueId` explicitly at creation time rather than relying on free-text references.

### What project workspace config does and does not control

Project workspace configuration controls:

- Which services, jobs, and commands are available as defaults for execution workspaces.
- The execution workspace policy (default mode for new issues).
- The canonical `cwd` and `repoUrl` used as the base for worktree creation.

Project workspace configuration does **not** control:

- Automatic service lifecycle — no services start or stop when issues are assigned, heartbeats run, or the server boots.
- Execution workspace overrides — each execution workspace can replace the inherited runtime config with its own settings.
- Running service processes — even when runtime config is inherited, any running service process belongs to its specific execution workspace, not the project workspace.

For the full runtime control model, see [Execution Workspaces and Runtime Services](/guides/board-operator/execution-workspaces-and-runtime-services).
