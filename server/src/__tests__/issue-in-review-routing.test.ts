import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  companyMemberships,
  createDb,
  ensurePostgresDatabase,
} from "@paperclipai/db";
import { createApp } from "../app.js";
import { issueService } from "../services/issues.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

describe("issue in_review routing", () => {
  let databaseDir = "";
  let storageDir = "";
  let databaseUrl = "";
  let embeddedPostgres: EmbeddedPostgres;
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let companyId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-review-route-db-"));
    storageDir = await mkdtemp(join(tmpdir(), "paperclip-issue-review-route-storage-"));
    const port = await detectPort(55435);
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

    await db.insert(companies).values({
      id: companyId,
      name: "Issue In Review Routing Test Company",
      issuePrefix: "IRR",
    });

    app = await createApp(db, {
      uiMode: "none",
      storageService: createStorageService(createLocalDiskStorageProvider(storageDir)),
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }, 120000);

  async function createAgent(name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function addActiveUserMembership(userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
  }

  async function createAssignedIssue(input: {
    createdByUserId: string;
    assigneeAgentId: string;
  }) {
    return issueService(db).create(companyId, {
      title: `Review routing ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      createdByUserId: input.createdByUserId,
      assigneeAgentId: input.assigneeAgentId,
    });
  }

  it("routes in_review issues back to the requester when no reviewer is explicitly supplied", async () => {
    const requesterUserId = "board-requester";
    await addActiveUserMembership(requesterUserId);
    const implementerId = await createAgent("Implementer");
    const issue = await createAssignedIssue({
      createdByUserId: requesterUserId,
      assigneeAgentId: implementerId,
    });

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.assigneeUserId).toBe(requesterUserId);

    const activity = (await db.select().from(activityLog))
      .filter((row) => row.entityType === "issue" && row.entityId === issue.id && row.action === "issue.updated")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    expect(activity?.details).toMatchObject({
      identifier: issue.identifier,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: requesterUserId,
      _previous: {
        status: "todo",
        assigneeAgentId: implementerId,
        assigneeUserId: null,
      },
    });
  });

  it("preserves an explicitly supplied reviewer on the in_review transition", async () => {
    const requesterUserId = "board-requester-explicit";
    await addActiveUserMembership(requesterUserId);
    const implementerId = await createAgent("Implementer Explicit");
    const reviewerId = await createAgent("Reviewer Explicit");
    const issue = await createAssignedIssue({
      createdByUserId: requesterUserId,
      assigneeAgentId: implementerId,
    });

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", assigneeAgentId: reviewerId, assigneeUserId: null });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.assigneeAgentId).toBe(reviewerId);
    expect(res.body.assigneeUserId).toBeNull();
  });
});
