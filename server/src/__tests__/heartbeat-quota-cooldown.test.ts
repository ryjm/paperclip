import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

async function writeFakeQuotaClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-sonnet-4-5"
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "You're out of extra usage · resets 8pm (America/Los_Angeles)",
  errors: [{ code: "rate_limit_event", message: "overageDisabledReason=out_of_credits" }]
}));
process.exit(1);
`;
  await writeFile(commandPath, script, "utf8");
  await chmod(commandPath, 0o755);
}

async function waitForRun(
  svc: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await svc.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for heartbeat run ${runId}`);
}

async function waitForAgentState(
  db: ReturnType<typeof createDb>,
  agentId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    const cooldown = (agent?.metadata as Record<string, unknown> | null)?.paperclipWakeCooldown;
    if (agent?.status === "capacity_blocked" && cooldown) {
      return agent;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for agent ${agentId} to become idle with a cooldown`);
}

describe("heartbeatService quota cooldown suppression", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-heartbeat-quota-cooldown-"));
    const port = await detectPort();
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    await embeddedPostgres.initialise();
    await embeddedPostgres.start();

    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");

    databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  it("persists Claude quota cooldowns, marks the agent capacity blocked, and requires explicit override for manual retries", async () => {
    const svc = heartbeatService(db);
    const root = await mkdtemp(join(tmpdir(), "paperclip-quota-claude-"));
    const workspace = join(root, "workspace");
    const commandPath = join(root, "fake-claude.js");
    await writeFakeQuotaClaudeCommand(commandPath);

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Quota Cooldown Test Co",
      issuePrefix: "QCD",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Engineer",
      status: "active",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: {
        command: commandPath,
        cwd: workspace,
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
        },
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cooldown issue",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      issueNumber: 1,
      identifier: "QCD-1",
    });

    const firstRun = await svc.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "test-suite",
      contextSnapshot: { issueId },
    });

    expect(firstRun).not.toBeNull();
    const finalizedFirstRun = await waitForRun(svc, firstRun!.id);
    expect(finalizedFirstRun.status).toBe("failed");
    expect(finalizedFirstRun.errorCode).toBe("claude_quota_cooldown");

    const updatedAgent = await waitForAgentState(db, agentId);

    expect(updatedAgent?.status).toBe("capacity_blocked");
    expect(updatedAgent?.metadata).toMatchObject({
      paperclipWakeCooldown: {
        kind: "provider_quota_reset",
        provider: "anthropic",
        adapterType: "claude_local",
        errorCode: "claude_quota_cooldown",
      },
    });

    const cooldownResetAt = (updatedAgent?.metadata as Record<string, unknown> | null)?.paperclipWakeCooldown;
    expect(cooldownResetAt).toBeTruthy();
    expect(
      new Date(
        ((cooldownResetAt as Record<string, unknown>).resetAt as string) ?? "",
      ).getTime(),
    ).toBeGreaterThan(Date.now());

    const unchangedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(unchangedIssue).toMatchObject({
      assigneeAgentId: agentId,
      status: "todo",
    });

    const suppressedWake = await svc.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    expect(suppressedWake).toBeNull();

    const skippedWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "agent_wake_cooldown.active"))
      .then((rows) => rows[rows.length - 1] ?? null);

    expect(skippedWake?.status).toBe("skipped");

    const overrideWake = await svc.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId },
      overrideCooldown: true,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    expect(overrideWake).not.toBeNull();
    const finalizedOverrideRun = await waitForRun(svc, overrideWake!.id);
    expect(finalizedOverrideRun.errorCode).toBe("claude_quota_cooldown");

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    expect(runs).toHaveLength(2);

    await rm(root, { recursive: true, force: true });
  });
});
