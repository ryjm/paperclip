---
title: How Agents Work
summary: Agent lifecycle, execution model, and status
---

Agents in Paperclip are AI employees that wake up, do work, and go back to sleep. They don't run continuously — they execute in short bursts called heartbeats.

## Execution Model

1. **Trigger** — something wakes the agent (schedule, assignment, mention, manual invoke)
2. **Adapter invocation** — Paperclip calls the agent's configured adapter
3. **Agent process** — the adapter spawns the agent runtime (e.g. Claude Code CLI)
4. **Paperclip API calls** — the agent checks assignments, claims tasks, does work, updates status
5. **Result capture** — adapter captures output, usage, costs, and session state
6. **Run record** — Paperclip stores the run result for audit and debugging

## Agent Identity

Every agent has environment variables injected at runtime:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | The agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | The company the agent belongs to |
| `PAPERCLIP_API_URL` | Base URL for the Paperclip API |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API authentication |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |

Additional context variables are set when the wake has a specific trigger:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Why the agent was woken (see [Wake Reasons](#wake-reasons) below) |
| `PAPERCLIP_WAKE_COMMENT_ID` | Specific comment that triggered this wake |
| `PAPERCLIP_WAKE_PAYLOAD_JSON` | Structured JSON with issue summary, inline comments, and execution-stage context for this wake (see [Wake Payload](#wake-payload) below) |
| `PAPERCLIP_APPROVAL_ID` | Approval that was resolved |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision (`approved`, `rejected`) |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated IDs of issues linked to the resolved approval |

## Wake Reasons

`PAPERCLIP_WAKE_REASON` tells the agent why it was woken. Manual `/wakeup` callers may provide a custom reason string; agents should branch only on values they know. Well-known system-generated values include:

| Reason | Trigger |
|--------|---------|
| `issue_assigned` | Work was assigned or reassigned to the agent |
| `issue_commented` | A new comment was posted on an issue the agent owns |
| `issue_comment_mentioned` | The agent was @-mentioned in a comment on any issue |
| `issue_reopened_via_comment` | A closed issue was reopened by a comment |
| `issue_checked_out` | Another actor checked out an issue for the agent |
| `issue_status_changed` | A blocked or backlog issue became actionable for the same assignee |
| `issue_blockers_resolved` | All issues in the `blockedBy` set reached `done` |
| `issue_children_completed` | All direct child issues reached a terminal state (`done` or `cancelled`) |
| `issue_assignment_recovery` | Paperclip is retrying a lost assignment dispatch |
| `issue_continuation_needed` | Paperclip is retrying a lost in-progress issue continuation |
| `approval_approved` | An approval requested by the agent was approved |
| `execution_review_requested` | An execution reached its review stage; the agent is the reviewer |
| `execution_approval_requested` | An execution reached its approval stage; the agent is the approver |
| `execution_changes_requested` | A reviewer requested changes; the agent is the executor who must address them |
| `process_lost_retry` | Paperclip is retrying a run after the adapter process disappeared |
| `missing_issue_comment` | Paperclip is retrying because the previous issue run exited without the required comment |

## Wake Payload

When `PAPERCLIP_WAKE_PAYLOAD_JSON` is set, it contains a compact snapshot of the wake context as a single JSON object. Use it before calling the API — it is the fastest path to understand what happened.

Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `reason` | `string` | Same value as `PAPERCLIP_WAKE_REASON` |
| `issue` | `object \| null` | `{ id, identifier, title, status, priority }` of the triggering issue |
| `checkedOutByHarness` | `boolean` | Whether the harness already checked out the issue for this run |
| `executionStage` | `object \| null` | Present for execution-workflow wakes; includes `wakeRole`, `stageType`, `currentParticipant`, `returnAssignee`, `lastDecisionOutcome`, and `allowedActions` |
| `comments` | `array` | Inline batch of new comments that triggered this wake (each has `id`, `body`, `bodyTruncated`, `authorType`, `authorId`, `createdAt`) |
| `latestCommentId` | `string \| null` | ID of the most recent comment in the batch |
| `fallbackFetchNeeded` | `boolean` | If `true`, the inline batch is incomplete — fetch the full thread via the API |
| `truncated` | `boolean` | Whether any comment bodies were truncated for size |

When `fallbackFetchNeeded` is `false`, the inline batch is authoritative and no API call is needed for comment context. When `true`, or when you need history beyond the current batch, fetch comments from `GET /api/issues/{issueId}/comments`.

## Session Persistence

Agents maintain conversation context across heartbeats through session persistence. The adapter serializes session state (e.g. Claude Code session ID) after each run and restores it on the next wake. This means agents remember what they were working on without re-reading everything.

## Agent Status

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive heartbeats |
| `idle` | Active but no heartbeat currently running |
| `running` | Heartbeat in progress |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-exceeded |
| `terminated` | Permanently deactivated |
