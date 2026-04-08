import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

describe("heartbeatService terminal issue assignment suppression", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-heartbeat-terminal-issue-"));
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
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  async function seedFixture(input?: {
    issueStatus?: "todo" | "in_progress" | "cancelled";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `TIA${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TerminalIssueAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { cwd: tmpdir() },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Suppress stale assignment wake",
      status: input?.issueStatus ?? "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  it("skips new issue_assigned wakeups for cancelled issues", async () => {
    const svc = heartbeatService(db);
    const { agentId, issueId } = await seedFixture({ issueStatus: "cancelled" });

    const run = await svc.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "test-suite",
      contextSnapshot: { issueId },
    });

    expect(run).toBeNull();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("skipped");
    expect(wakeups[0]?.reason).toBe("issue_assignment_terminal");
    expect(wakeups[0]?.payload).toMatchObject({
      issueId,
      issueStatus: "cancelled",
      suppressedWakeReason: "issue_assigned",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("cancels queued issue_assigned runs before execution when the issue is already cancelled", async () => {
    const svc = heartbeatService(db);
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const { companyId, agentId, issueId } = await seedFixture({
      issueStatus: "cancelled",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    await svc.resumeQueuedRuns();
    const cancelledRun = await svc.getRun(runId);

    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.error).toContain("issue is cancelled");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");
    expect(wakeup?.error).toContain("issue is cancelled");

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("drops deferred issue execution wakes instead of promoting them for cancelled issues", async () => {
    const svc = heartbeatService(db);
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const deferredWakeupId = randomUUID();
    const { companyId, agentId, issueId } = await seedFixture({
      issueStatus: "cancelled",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_assigned",
        },
      },
      status: "deferred_issue_execution",
    });

    await svc.cancelRun(runId);

    const deferredWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWakeup?.status).toBe("cancelled");
    expect(deferredWakeup?.error).toContain("issue is cancelled");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });
});
