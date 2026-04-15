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

  it("supports incremental comment cursor reads via both after aliases", async () => {
    const companyId = randomUUID();
    const oldestCommentId = randomUUID();
    const middleCommentId = randomUUID();
    const newestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Cursor pagination issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: oldestCommentId,
        companyId,
        issueId: issue.id,
        body: "oldest",
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: middleCommentId,
        companyId,
        issueId: issue.id,
        body: "middle",
        createdAt: new Date("2026-04-10T00:00:01.000Z"),
      },
      {
        id: newestCommentId,
        companyId,
        issueId: issue.id,
        body: "newest",
        createdAt: new Date("2026-04-10T00:00:02.000Z"),
      },
    ]);

    for (const queryParam of ["after", "afterCommentId"]) {
      const res = await request(app).get(
        `/api/issues/${issue.id}/comments?${queryParam}=${middleCommentId}&order=asc`,
      );

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject([
        {
          id: newestCommentId,
          body: "newest",
        },
      ]);
      expect(res.body).toHaveLength(1);
    }
  });
});
