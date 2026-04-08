import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-issues-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId, issuePrefix };
  }

  async function insertHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    status: string;
  }) {
    const now = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "test",
      status: input.status,
      startedAt: now,
      finishedAt: input.status === "queued" || input.status === "running" ? null : now,
      updatedAt: now,
    });
  }

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = issueService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });
  it("reconciles stale execution locks in list results before building inbox data", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const staleRunId = randomUUID();
    const issueId = randomUUID();
    const lockedAt = new Date("2026-04-01T00:05:00.000Z");

    await insertHeartbeatRun({
      companyId,
      agentId,
      runId: staleRunId,
      status: "failed",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Inbox drift issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: staleRunId,
      executionLockedAt: lockedAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const result = await svc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.executionRunId).toBeNull();
    expect(result[0]?.activeRun).toBeNull();

    const persisted = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(persisted).toEqual({
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("reconciles stale execution locks in raw issue reads", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const staleRunId = randomUUID();
    const issueId = randomUUID();
    const lockedAt = new Date("2026-04-01T00:05:00.000Z");

    await insertHeartbeatRun({
      companyId,
      agentId,
      runId: staleRunId,
      status: "succeeded",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Raw issue drift",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: staleRunId,
      executionLockedAt: lockedAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const issue = await svc.getById(issueId);

    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();

    const persisted = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(persisted).toEqual({
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("clears stale execution locks before retrying checkout", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const staleRunId = randomUUID();
    const currentRunId = randomUUID();
    const issueId = randomUUID();

    await insertHeartbeatRun({
      companyId,
      agentId,
      runId: staleRunId,
      status: "failed",
    });
    await insertHeartbeatRun({
      companyId,
      agentId,
      runId: currentRunId,
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout should recover",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: staleRunId,
      executionLockedAt: new Date("2026-04-01T00:05:00.000Z"),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo", "backlog", "blocked", "in_progress"], currentRunId);

    expect(checkedOut).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const persisted = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(persisted).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("releases checkout and execution lock state together", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const issueId = randomUUID();

    await insertHeartbeatRun({
      companyId,
      agentId,
      runId,
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release should clear lock state",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date("2026-04-01T00:05:00.000Z"),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const released = await svc.release(issueId, agentId, runId);

    expect(released).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("assigns the default project workspace when creating a project-backed issue without an explicit workspace", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Routing",
      status: "active",
      executionWorkspacePolicy: {
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary Workspace",
      sourceType: "local_path",
      cwd: `/tmp/${projectWorkspaceId}`,
      repoRef: null,
      isPrimary: true,
    });

    const created = await svc.create(companyId, {
      title: "Route workspace from mentioned project",
      status: "todo",
      priority: "medium",
      projectId,
    });

    expect(created.projectId).toBe(projectId);
    expect(created.projectWorkspaceId).toBe(projectWorkspaceId);
  });
});
