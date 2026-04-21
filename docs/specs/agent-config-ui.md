# Agent Configuration & Activity UI

## Context

Agents are the employees of a Paperclip company. Each agent has an adapter type (`claude_local`, `codex_local`, `process`, `http`) that determines how it runs, a position in the org chart (who it reports to), a heartbeat policy (how/when it wakes up), and a budget. The UI at `/agents` needs to support creating and configuring agents, viewing their org hierarchy, and inspecting what they've been doing -- their run history, live logs, and accumulated costs.

This document mixes product intent with current implementation reality. Sections that describe "should" behavior are product intent; the notes below are the implemented API/UI contract that new work must preserve unless it intentionally migrates the product.

Current implementation notes:

- Run policy is stored in `runtimeConfig.heartbeat`. The current form labels this section "Run Policy" and exposes timer heartbeat controls plus advanced wake controls.
- New agents default timer heartbeats off (`heartbeat.enabled: false`, `intervalSec: 300`). Edit mode reads existing `runtimeConfig.heartbeat` and treats missing `wakeOnDemand` as enabled.
- The current UI exposes `heartbeat.enabled`, `heartbeat.intervalSec`, `heartbeat.wakeOnDemand`, `heartbeat.cooldownSec`, and `heartbeat.maxConcurrentRuns`. Imported or older configs may still contain legacy aliases such as `wakeOnAssignment`, `wakeOnAutomation`, and `wakeOnOnDemand`; those are compatibility data, not separate first-class controls in the current form.
- The canonical rich wake endpoint is `POST /agents/:id/wakeup`. The older `POST /agents/:id/heartbeat/invoke` route still exists as a minimal on-demand compatibility path, but new docs and workflows should prefer `/wakeup` when a reason, payload, idempotency key, retry, or resume context is needed.
- Issue properties now surface execution review/approval state and blocker relations. Agent activity UI should treat those as part of the visible execution lifecycle when linking runs back to issue work.

This spec covers three surfaces:

1. **Agent Creation Dialog** -- the "New Agent" flow
2. **Agent Detail Page** -- configuration, activity, and logs
3. **Agents List Page** -- improvements to the existing list

---

## 1. Agent Creation Dialog

Follows the existing `NewIssueDialog` / `NewProjectDialog` pattern: a `Dialog` component with expand/minimize toggle, company badge breadcrumb, and Cmd+Enter submit.

### Fields

**Identity (always visible):**

| Field | Control | Required | Default | Notes |
|-------|---------|----------|---------|-------|
| Name | Text input (large, auto-focused) | Yes | -- | e.g. "Alice", "Build Bot" |
| Title | Text input (subtitle style) | No | -- | e.g. "VP of Engineering" |
| Role | Chip popover (select) | No | `general` | Values from `AGENT_ROLES`: ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general |
| Reports To | Chip popover (agent select) | No | -- | Dropdown of existing agents in the company. If this is the first agent, auto-set role to `ceo` and gray out Reports To. Otherwise required unless role is `ceo`. |
| Capabilities | Text input | No | -- | Free-text description of what this agent can do |

**Adapter (collapsible section, default open):**

| Field | Control | Default | Notes |
|-------|---------|---------|-------|
| Adapter Type | Chip popover (select) | `claude_local` | `claude_local`, `codex_local`, `process`, `http` |
| Test environment | Button | -- | Runs adapter-specific diagnostics and returns pass/warn/fail checks for current unsaved config |
| CWD | Text input | -- | Working directory for local adapters |
| Prompt Template | Textarea | -- | Supports `{{ agent.id }}`, `{{ agent.name }}` etc. |
| Model | Text input | -- | Optional model override |

**Adapter-specific fields (shown/hidden based on adapter type):**

*claude_local:*
| Field | Control | Default |
|-------|---------|---------|
| Max Turns Per Run | Number input | 80 |
| Skip Permissions | Toggle | true |

*codex_local:*
| Field | Control | Default |
|-------|---------|---------|
| Search | Toggle | false |
| Bypass Sandbox | Toggle | true |

*process:*
| Field | Control | Default |
|-------|---------|---------|
| Command | Text input | -- |
| Args | Text input (comma-separated) | -- |

*http:*
| Field | Control | Default |
|-------|---------|---------|
| URL | Text input | -- |
| Method | Select | POST |
| Headers | Key-value pairs | -- |

**Runtime (collapsible section, default collapsed):**

| Field | Control | Default |
|-------|---------|---------|
| Context Mode | Chip popover | `thin` |
| Monthly Budget (cents) | Number input | 0 |
| Timeout (sec) | Number input | 900 |
| Grace Period (sec) | Number input | 15 |
| Extra Args | Text input | -- |
| Env Vars | Key-value pair editor | -- |

**Heartbeat Policy (collapsible section, default collapsed):**

| Field | Control | Default |
|-------|---------|---------|
| Heartbeat on interval | Toggle + number input | off for new agents; existing value for edits |
| Interval (sec) | Number input | 300 |
| Wake on demand | Toggle | true |
| Cooldown (sec) | Number input | 10 |
| Max concurrent runs | Number input | 1 |

`Wake on demand` maps to `runtimeConfig.heartbeat.wakeOnDemand` and covers assignment wakes, UI/API manual wakes, and automation-initiated wakes in the current app model. Legacy config aliases (`wakeOnAssignment`, `wakeOnAutomation`, `wakeOnOnDemand`) may be preserved when present but should not be shown as independent toggles unless the runtime policy is split again.

### Behavior

- On submit, calls `agentsApi.create(companyId, data)` where `data` packs identity fields at the top level and adapter-specific fields into `adapterConfig` and heartbeat/runtime into `runtimeConfig`.
- After creation, navigate to the new agent's detail page.
- If the company has zero agents, pre-fill role as `ceo` and disable Reports To.
- The adapter config section updates its visible fields when adapter type changes, preserving any shared field values (cwd, promptTemplate, etc.).

---

## 2. Agent Detail Page

Restructure the existing tabbed layout. Keep the header (name, role, title, status badge, action buttons) and add richer tabs.

### Header

```
[StatusBadge]  Agent Name                    [Invoke] [Pause/Resume] [...]
               Role / Title
```

The `[...]` overflow menu contains: Terminate, Reset Session, Create API Key.

### Tabs

#### Overview Tab

Two-column layout: left column is a summary card, right column is the org position.

**Summary card:**
- Adapter type + model (if set)
- Heartbeat interval (e.g. "every 5 min") or "Disabled"
- Last heartbeat time (relative, e.g. "3 min ago")
- Session status: "Active (session abc123...)" or "No session"
- Current month spend / budget with progress bar

**Org position card:**
- Reports to: clickable agent name (links to their detail page)
- Direct reports: list of agents who report to this agent (clickable)

#### Configuration Tab

Editable form with the same sections as the creation dialog (Adapter, Runtime, Heartbeat Policy) but pre-populated with current values. Uses inline editing -- click a value to edit, press Enter or blur to save via `agentsApi.update()`.

Sections:
- **Identity**: name, title, role, reports to, capabilities
- **Adapter Config**: all adapter-specific fields for the current adapter type
- **Run Policy**: timer heartbeat enable/disable, interval, `wakeOnDemand`, cooldown, max concurrent runs
- **Runtime**: context mode, budget, timeout, grace, env vars, extra args

Each section is a collapsible card. Save happens per-field (PATCH on blur/enter), not a single form submit. Validation errors show inline.

#### Runs Tab

This is the primary activity/history view. Shows a paginated list of heartbeat runs, most recent first.

**Run list item:**
```
[StatusIcon] #run-id-short   source: timer     2 min ago     1.2k tokens   $0.03
             "Reviewed 3 PRs and filed 2 issues"
```

Fields per row:
- Status icon (green check = succeeded, red X = failed, yellow spinner = running, gray clock = queued, orange timeout = timed_out, slash = cancelled)
- Run ID (short, first 8 chars)
- Invocation source chip (timer, assignment, on_demand, automation)
- Relative timestamp
- Token usage summary (total input + output)
- Cost
- Result summary (first line of result or error)

**Clicking a run** opens a run detail inline (accordion expand) or a slide-over panel showing:

- Full status timeline (queued -> running -> outcome) with timestamps
- Session before/after
- Token breakdown: input, output, cached input
- Cost breakdown
- Error message and error code (if failed)
- Exit code and signal (if applicable)
- Process-loss recovery state when user-visible: a failed run with `errorCode: process_lost` shows a Resume action that calls `/agents/:id/wakeup` with `reason: resume_process_lost_run` and `payload.resumeFromRunId`. Generic failed/timed_out runs show Retry. Retry chains should surface `retryOfRunId` and `processLossRetryCount` when present.

**Log viewer** within the run detail:
- Streams `heartbeat_run_events` for the run, ordered by `seq`
- Each event rendered as a log line with timestamp, level (color-coded), and message
- Events of type `stdout`/`stderr` shown in monospace
- System events shown with distinct styling
- For running runs, auto-scrolls and appends live via WebSocket events (`heartbeat.run.event`, `heartbeat.run.log`)
- "View full log" link fetches from `heartbeatsApi.log(runId)` and shows in a scrollable monospace container
- Truncation: show last 200 events by default, "Load more" button to fetch earlier events

#### Issues Tab

Keep as-is: list of issues assigned to this agent with status, clickable to navigate to issue detail.

When a run is tied to an issue, the issue-side UI may also show:

- Active execution run state (`queued` or `running`) via issue live-run/active-run queries
- Execution review/approval policy: reviewers, approvers, "Run review now", "Run approval now"
- Current execution state: review pending, approval pending, or changes requested with the current participant
- Blocker controls: `blockedBy` relations selected from other issues and `blocks` summaries for issues this issue blocks

#### Costs Tab

Expand the existing costs tab:

- **Cumulative totals** from `agent_runtime_state`: total input tokens, total output tokens, total cached tokens, total cost
- **Monthly budget** progress bar (current month spend vs budget)
- **Per-run cost table**: date, run ID, tokens in/out/cached, cost -- sortable by date or cost
- **Chart** (stretch): simple bar chart of daily spend over last 30 days

### Properties Panel (Right Sidebar)

The existing `AgentProperties` panel continues to show the quick-glance info. Add:
- Session ID (truncated, with copy button)
- Last error (if any, in red)
- Link to "View Configuration" (scrolls to / switches to Configuration tab)

---

## 3. Agents List Page

### Current state

Shows a flat list of agents with status badge, name, role, title, and budget bar.

### Improvements

**Add "New Agent" button** in the header (Plus icon + "New Agent"), opens the creation dialog.

**Add view toggle**: List view (current) and Org Chart view.

**Org Chart view:**
- Tree layout showing reporting hierarchy
- Each node shows: agent name, role, status badge
- CEO at the top, direct reports below, etc.
- Uses the `agentsApi.org(companyId)` endpoint which already returns `OrgNode[]`
- Clicking a node navigates to agent detail

**List view improvements:**
- Add adapter type as a small chip/tag on each row
- Add "last active" relative timestamp
- Add running indicator (animated dot) if agent currently has a running heartbeat

**Filtering:**
- Tab filters: All, Active, Paused, Error (similar to Issues page pattern)

---

## 4. Component Inventory

New components needed:

| Component | Purpose |
|-----------|---------|
| `NewAgentDialog` | Agent creation form dialog |
| `AgentConfigForm` | Shared form sections for create + edit (adapter, heartbeat, runtime) |
| `AdapterConfigFields` | Conditional fields based on adapter type |
| `HeartbeatPolicyFields` | Heartbeat configuration fields |
| `EnvVarEditor` | Key-value pair editor for environment variables |
| `RunListItem` | Single run row in the runs list |
| `RunDetail` | Expanded run detail with log viewer |
| `LogViewer` | Streaming log viewer with auto-scroll |
| `OrgChart` | Tree visualization of agent hierarchy |
| `AgentSelect` | Reusable agent picker (for Reports To, etc.) |

Reused existing components:
- `StatusBadge`, `EntityRow`, `EmptyState`, `PropertyRow`
- shadcn: `Dialog`, `Tabs`, `Button`, `Popover`, `Command`, `Separator`, `Toggle`

---

## 5. API Surface

This table records the current API reality for the agent activity/configuration surfaces. No new server work is required for this docs correction, but stale route names should not be copied into new implementation work.

| Action | Endpoint | Used by |
|--------|----------|---------|
| List agents | `GET /companies/:id/agents` | List page |
| Get org tree | `GET /companies/:id/org` | Org chart view |
| Create agent | `POST /companies/:id/agents` | Creation dialog |
| Update agent | `PATCH /agents/:id` | Configuration tab |
| Pause/Resume/Terminate | `POST /agents/:id/{action}` | Header actions |
| Reset session | `POST /agents/:id/runtime-state/reset-session` | Overflow menu |
| Create API key | `POST /agents/:id/keys` | Overflow menu |
| Get runtime state | `GET /agents/:id/runtime-state` | Overview tab, properties panel |
| Wakeup | `POST /agents/:id/wakeup` | Canonical manual wake, retry, resume, and automation wake path |
| Legacy invoke | `POST /agents/:id/heartbeat/invoke` | Minimal on-demand compatibility path; avoid for new reason/payload/idempotency workflows |
| List runs | `GET /companies/:id/heartbeat-runs?agentId=X` | Runs tab |
| List live company runs | `GET /companies/:id/live-runs` | Agents list, dashboard, active indicators |
| List issue live runs | `GET /issues/:issueId/live-runs` | Issue execution widgets |
| Get issue active run | `GET /issues/:issueId/active-run` | Issue execution widgets |
| Cancel run | `POST /heartbeat-runs/:id/cancel` | Run detail |
| Run events | `GET /heartbeat-runs/:id/events` | Log viewer |
| Run log | `GET /heartbeat-runs/:id/log` | Full log view |
| Run workspace operations | `GET /heartbeat-runs/:id/workspace-operations` | Run detail workspace operation logs |

---

## 6. Implementation Order

1. **New Agent Dialog** -- unblocks agent creation from the UI
2. **Agents List improvements** -- add New Agent button, tab filters, adapter chip, running indicator
3. **Agent Detail: Configuration tab** -- editable adapter/heartbeat/runtime config
4. **Agent Detail: Runs tab** -- run history list with status, tokens, cost
5. **Agent Detail: Run Detail + Log Viewer** -- expandable run detail with streaming logs
6. **Agent Detail: Overview tab** -- summary card, org position
7. **Agent Detail: Costs tab** -- expanded cost breakdown
8. **Org Chart view** -- tree visualization on list page
9. **Properties panel updates** -- session ID, last error

Steps 1-5 are the core. Steps 6-9 are polish.
