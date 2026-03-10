import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
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
  issueComments,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

describe("heartbeatService stranded work recovery", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;

  beforeAll(async () => {
    databaseDir = await mkdtemp(
      join(tmpdir(), "paperclip-heartbeat-recovery-")
    );
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
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  async function seedOrg(opts?: { erroredStatus?: "active" | "error" }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const erroredAgentId = randomUUID();
    const issuePrefix = `REC${companyId
      .replace(/-/g, "")
      .slice(0, 6)
      .toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Recovery Manager",
        status: "active",
        role: "manager",
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: false,
          },
        },
      },
      {
        id: erroredAgentId,
        companyId,
        name: "Errored Engineer",
        status: opts?.erroredStatus ?? "active",
        role: "engineer",
        reportsTo: managerId,
      },
    ]);

    return { companyId, managerId, erroredAgentId, issuePrefix };
  }

  it("reassigns todo and in-progress issues when an assignee run is reaped into error", async () => {
    const svc = heartbeatService(db);
    const { companyId, managerId, erroredAgentId, issuePrefix } =
      await seedOrg();
    const runId = randomUUID();
    const todoIssueId = randomUUID();
    const inProgressIssueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: erroredAgentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-03-07T00:00:00.000Z"),
      contextSnapshot: {
        issueId: inProgressIssueId,
      },
    });

    await db.insert(issues).values([
      {
        id: todoIssueId,
        companyId,
        title: "Todo work",
        status: "todo",
        priority: "high",
        assigneeAgentId: erroredAgentId,
        createdByAgentId: managerId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: inProgressIssueId,
        companyId,
        title: "In-progress work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: erroredAgentId,
        checkoutRunId: runId,
        executionRunId: runId,
        createdByAgentId: managerId,
        startedAt: new Date("2026-03-07T00:00:00.000Z"),
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const result = await svc.reapOrphanedRuns();

    expect(result.reaped).toBe(1);

    const recoveredIssues = await db
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(inArray(issues.id, [todoIssueId, inProgressIssueId]));

    const byId = new Map(recoveredIssues.map((issue) => [issue.id, issue]));
    expect(byId.get(todoIssueId)).toMatchObject({
      id: todoIssueId,
      status: "todo",
      assigneeAgentId: managerId,
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(byId.get(inProgressIssueId)).toMatchObject({
      id: inProgressIssueId,
      status: "todo",
      assigneeAgentId: managerId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const comments = await db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(inArray(issueComments.issueId, [todoIssueId, inProgressIssueId]));

    expect(comments).toHaveLength(2);
    expect(
      comments.every((comment) => comment.body.includes("## Auto-escalated"))
    ).toBe(true);
    expect(
      comments.every((comment) => comment.body.includes("Recovery Manager"))
    ).toBe(true);

    const erroredAgent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, erroredAgentId))
      .then((rows) => rows[0] ?? null);

    expect(erroredAgent?.status).toBe("error");
  });

  it("rescues already-stranded work on scheduler ticks", async () => {
    const svc = heartbeatService(db);
    const { companyId, managerId, erroredAgentId, issuePrefix } = await seedOrg(
      { erroredStatus: "error" }
    );
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already stranded todo",
      status: "todo",
      priority: "high",
      assigneeAgentId: erroredAgentId,
      createdByAgentId: managerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const tick = await svc.tickTimers(new Date("2026-03-07T12:00:00.000Z"));

    expect(tick).toMatchObject({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });

    const recoveredIssue = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(recoveredIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: managerId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## Auto-escalated");
    expect(comments[0]?.body).toContain("Errored Engineer");
    expect(comments[0]?.body).toContain("Recovery Manager");
  });
});
