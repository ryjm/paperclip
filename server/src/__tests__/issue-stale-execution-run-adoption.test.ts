import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.js";

describe("issueService stale execution lock adoption", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let agentId = "";
  let issueCounter = 1;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-service-"));
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

    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Service Test Company",
      issuePrefix: "TIS",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Engineer",
      status: "active",
      role: "platform",
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  async function seedIssue(status: "todo" | "in_progress") {
    const staleRunId = randomUUID();
    const currentRunId = randomUUID();
    const issueId = randomUUID();
    const issueNumber = issueCounter;
    issueCounter += 1;

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-03-07T00:00:00.000Z"),
        finishedAt: new Date("2026-03-07T00:05:00.000Z"),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date("2026-03-07T00:10:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status,
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: staleRunId,
      createdByAgentId: agentId,
      issueNumber,
      identifier: `TIS-${issueNumber}`,
    });

    return { currentRunId, issueId };
  }

  async function seedSupersededIssue(options: {
    status: "todo" | "in_progress";
    ownerRunStatus: "queued" | "running";
    ownerHasCheckout: boolean;
  }) {
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const issueId = randomUUID();
    const issueNumber = issueCounter;
    issueCounter += 1;

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "running",
        createdAt: new Date("2026-03-07T00:00:00.000Z"),
        startedAt: new Date("2026-03-07T00:00:00.000Z"),
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: options.ownerRunStatus,
        createdAt: new Date("2026-03-07T00:10:00.000Z"),
        startedAt:
          options.ownerRunStatus === "running"
            ? new Date("2026-03-07T00:10:00.000Z")
            : null,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status: options.status,
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: options.ownerHasCheckout ? newerRunId : null,
      executionRunId: newerRunId,
      createdByAgentId: agentId,
      issueNumber,
      identifier: `TIS-${issueNumber}`,
    });

    return { olderRunId, newerRunId, issueId };
  }

  async function seedMentionCollisionIssue() {
    const olderRunId = randomUUID();
    const issueId = randomUUID();
    const issueNumber = issueCounter;
    issueCounter += 1;

    await db.insert(heartbeatRuns).values({
      id: olderRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      startedAt: new Date("2026-03-07T00:00:00.000Z"),
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        wakeSource: "timer",
        wakeReason: "heartbeat_timer",
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: olderRunId,
      executionAgentNameKey: "platform engineer",
      createdByAgentId: agentId,
      issueNumber,
      identifier: `TIS-${issueNumber}`,
    });

    return { olderRunId, issueId };
  }

  it("adopts a stale execution run during checkout when checkoutRunId is empty", async () => {
    const svc = issueService(db);
    const { currentRunId, issueId } = await seedIssue("todo");

    const updated = await svc.checkout(
      issueId,
      agentId,
      ["todo"],
      currentRunId
    );

    expect(updated.status).toBe("in_progress");
    expect(updated.checkoutRunId).toBe(currentRunId);
    expect(updated.executionRunId).toBe(currentRunId);
  });

  it("adopts a stale execution run for same-agent ownership checks", async () => {
    const svc = issueService(db);
    const { currentRunId, issueId } = await seedIssue("in_progress");

    const ownership = await svc.assertCheckoutOwner(
      issueId,
      agentId,
      currentRunId
    );
    const released = await svc.release(issueId, agentId, currentRunId);

    expect(ownership.checkoutRunId).toBe(currentRunId);
    expect(ownership.executionRunId).toBe(currentRunId);
    expect(released?.status).toBe("todo");
    expect(released?.checkoutRunId).toBeNull();
  });

  it("reports checkout supersession when a newer same-agent run already owns execution", async () => {
    const svc = issueService(db);
    const { olderRunId, newerRunId, issueId } = await seedSupersededIssue({
      status: "todo",
      ownerRunStatus: "queued",
      ownerHasCheckout: false,
    });

    await expect(
      svc.checkout(issueId, agentId, ["todo"], olderRunId)
    ).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout superseded by newer run",
      details: expect.objectContaining({
        issueId,
        actorRunId: olderRunId,
        reason: "superseded_by_newer_run",
        supersededByField: "executionRunId",
        supersededByRunId: newerRunId,
        ownerRunStatus: "queued",
        ownerRunInvocationSource: "automation",
        ownerRunTriggerDetail: "system",
      }),
    });
  });

  it("reports ownership supersession when a newer same-agent run already checked out the issue", async () => {
    const svc = issueService(db);
    const { olderRunId, newerRunId, issueId } = await seedSupersededIssue({
      status: "in_progress",
      ownerRunStatus: "running",
      ownerHasCheckout: true,
    });

    await expect(
      svc.assertCheckoutOwner(issueId, agentId, olderRunId)
    ).rejects.toMatchObject({
      status: 409,
      message: "Issue run ownership superseded by newer run",
      details: expect.objectContaining({
        issueId,
        actorRunId: olderRunId,
        reason: "superseded_by_newer_run",
        supersededByField: "checkoutRunId",
        supersededByRunId: newerRunId,
        ownerRunStatus: "running",
        ownerRunInvocationSource: "automation",
        ownerRunTriggerDetail: "system",
      }),
    });
  });

  it("moves issue execution to a newer mention wake run while a timer run is still active", async () => {
    const issuesSvc = issueService(db);
    const heartbeatSvc = heartbeatService(db);
    const { olderRunId, issueId } = await seedMentionCollisionIssue();

    const newerRun = await heartbeatSvc.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: {
        issueId,
        commentId: "comment-1",
      },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    });

    expect(newerRun).not.toBeNull();
    expect(newerRun?.id).not.toBe(olderRunId);
    expect(newerRun?.status).toBe("queued");

    const updatedIssue = await issuesSvc.getById(issueId);
    expect(updatedIssue?.executionRunId).toBe(newerRun?.id);

    await expect(
      issuesSvc.checkout(issueId, agentId, ["todo"], olderRunId)
    ).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout superseded by newer run",
      details: expect.objectContaining({
        issueId,
        actorRunId: olderRunId,
        reason: "superseded_by_newer_run",
        supersededByField: "executionRunId",
        supersededByRunId: newerRun?.id,
        ownerRunStatus: "queued",
        ownerRunInvocationSource: "automation",
        ownerRunTriggerDetail: "system",
      }),
    });
  });
});
