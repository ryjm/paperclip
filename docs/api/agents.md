---
title: Agents
summary: Agent lifecycle, configuration, keys, and wake invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Wake Agent

```
POST /api/agents/{agentId}/wakeup
```

Queues a heartbeat run for the agent. Responds `202` with the created
`HeartbeatRun`, or `202 {"status":"skipped","reason":"wakeup_skipped",...}` when
the runtime declines to start a new run (for example because one is already in
flight). This is the endpoint the CLI and board UI both use.

Request body (all fields optional):

```json
{
  "source": "on_demand",
  "triggerDetail": "manual",
  "reason": "Investigate stuck run",
  "payload": { "issueId": "PORA-137" },
  "idempotencyKey": "pora-137-manual-wake-1",
  "forceFreshSession": false
}
```

- `source`: `timer` | `assignment` | `on_demand` | `automation` (default `on_demand`).
- `triggerDetail`: `manual` | `ping` | `callback` | `system`.
- `payload`: opaque JSON wake payload delivered to the agent prompt.
- `forceFreshSession`: when `true`, start the adapter with a clean session.

Agents may only wake themselves; board users must have manage-agents access for
the agent's company.

### Deprecated: Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Legacy endpoint that accepts no body and always invokes the heartbeat with
`source=on_demand` / `triggerDetail=manual`. Prefer `POST /wakeup` for new
integrations; existing callers continue to work.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
