import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueComments, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createApp } from "../app.js";
import { issueService } from "../services/issues.ts";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker-aware routes", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let app!: Awaited<ReturnType<typeof createApp>>;
  let storageDir = "";
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-routes-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    storageDir = await mkdtemp(join(tmpdir(), "paperclip-issue-blocker-routes-storage-"));
    app = await createApp(db, {
      uiMode: "none",
      serverPort: 3100,
      storageService: createStorageService(createLocalDiskStorageProvider(storageDir)),
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
    await rm(storageDir, { recursive: true, force: true });
  }, 120_000);

  it("keeps per-issue routes healthy after adding blocker relations", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "high",
    });
    const blocked = await svc.create(companyId, {
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
    });

    const linkRes = await request(app)
      .patch(`/api/issues/${blocked.id}`)
      .send({ status: "blocked", blockedByIssueIds: [blocker.id] });

    expect(linkRes.status).toBe(200);
    expect(linkRes.body.blockedBy).toEqual([
      expect.objectContaining({
        id: blocker.id,
        identifier: blocker.identifier,
      }),
    ]);
    expect(linkRes.body.blocks).toEqual([]);

    const detailRes = await request(app).get(`/api/issues/${blocked.identifier}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.blockedBy).toEqual([
      expect.objectContaining({
        id: blocker.id,
        identifier: blocker.identifier,
      }),
    ]);

    const initialCommentsRes = await request(app).get(`/api/issues/${blocked.identifier}/comments`);
    expect(initialCommentsRes.status).toBe(200);
    expect(initialCommentsRes.headers["cache-control"]).toBe("no-store");
    expect(initialCommentsRes.body).toEqual([]);

    const heartbeatRes = await request(app).get(`/api/issues/${blocked.identifier}/heartbeat-context`);
    expect(heartbeatRes.status).toBe(200);
    expect(heartbeatRes.body.issue).toEqual(
      expect.objectContaining({
        id: blocked.id,
        identifier: blocked.identifier,
      }),
    );

    const addCommentRes = await request(app)
      .post(`/api/issues/${blocked.identifier}/comments`)
      .send({ body: "Still blocked while route regression coverage runs." });
    expect(addCommentRes.status).toBe(201);
    expect(addCommentRes.body.body).toBe("Still blocked while route regression coverage runs.");

    const commentDetailRes = await request(app).get(
      `/api/issues/${blocked.identifier}/comments/${addCommentRes.body.id}`,
    );
    expect(commentDetailRes.status).toBe(200);
    expect(commentDetailRes.headers["cache-control"]).toBe("no-store");
    expect(commentDetailRes.body.body).toBe("Still blocked while route regression coverage runs.");

    const patchRes = await request(app)
      .patch(`/api/issues/${blocked.identifier}`)
      .send({ status: "blocked", comment: "PATCH route still works with blocker metadata present." });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe("blocked");
    expect(patchRes.body.comment).toEqual(
      expect.objectContaining({
        body: "PATCH route still works with blocker metadata present.",
      }),
    );

    const finalCommentsRes = await request(app).get(`/api/issues/${blocked.id}/comments`);
    expect(finalCommentsRes.status).toBe(200);
    expect(finalCommentsRes.headers["cache-control"]).toBe("no-store");
    expect(finalCommentsRes.body.map((comment: { body: string }) => comment.body)).toEqual([
      "PATCH route still works with blocker metadata present.",
      "Still blocked while route regression coverage runs.",
    ]);
  });

  it("PATCH comment is immediately visible on first GET, heartbeat-context, and comments read", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "VIS",
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Comment visibility regression",
      status: "todo",
      priority: "medium",
    });

    const patchRes = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ comment: "Immediate visibility test comment." });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.comment).toEqual(
      expect.objectContaining({ body: "Immediate visibility test comment." }),
    );
    const commentId = patchRes.body.comment.id;
    const commentCreatedAt = patchRes.body.comment.createdAt;

    const [detailRes, heartbeatRes, commentsRes] = await Promise.all([
      request(app).get(`/api/issues/${issue.identifier}`),
      request(app).get(`/api/issues/${issue.identifier}/heartbeat-context`),
      request(app).get(`/api/issues/${issue.identifier}/comments`),
    ]);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(issue.id);

    expect(heartbeatRes.status).toBe(200);
    expect(heartbeatRes.body.commentCursor).toEqual({
      totalComments: 1,
      latestCommentId: commentId,
      latestCommentAt: commentCreatedAt,
    });

    expect(commentsRes.status).toBe(200);
    expect(commentsRes.headers["cache-control"]).toBe("no-store");
    expect(commentsRes.body).toHaveLength(1);
    expect(commentsRes.body[0]).toEqual(
      expect.objectContaining({
        id: commentId,
        body: "Immediate visibility test comment.",
      }),
    );
  });
});
