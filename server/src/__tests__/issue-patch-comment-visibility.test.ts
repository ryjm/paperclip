import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function registerHeartbeatServiceMock() {
  vi.doMock("../services/heartbeat.js", async () => {
    const actual = await vi.importActual<typeof import("../services/heartbeat.js")>(
      "../services/heartbeat.js",
    );
    return {
      ...actual,
      heartbeatService: (db: any) => {
        const real = actual.heartbeatService(db);
        return {
          ...real,
          wakeup: async () => null,
        };
      },
    };
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-patch-comment-visibility tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PATCH /issues/:id with comment — immediate read visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-patch-comment-vis-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerHeartbeatServiceMock();
  });

  async function createApp(companyId: string) {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "test-user",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue for comment visibility",
      status: "todo",
      priority: "medium",
      createdByUserId: "test-user",
    });

    return { companyId, agentId, issueId };
  }

  it("heartbeat-context reflects new comment on first read after PATCH", async () => {
    const { companyId, issueId } = await seedFixture();
    const app = await createApp(companyId);

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Status update with comment" });
    expect(patchRes.status).toBe(200);

    const contextRes = await request(app)
      .get(`/api/issues/${issueId}/heartbeat-context`);
    expect(contextRes.status).toBe(200);

    const { commentCursor } = contextRes.body;
    expect(commentCursor.totalComments).toBe(1);
    expect(commentCursor.latestCommentId).toBeTruthy();
    expect(commentCursor.latestCommentAt).toBeTruthy();
  });

  it("GET /comments returns new comment on first read after PATCH", async () => {
    const { companyId, issueId } = await seedFixture();
    const app = await createApp(companyId);

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Visible immediately" });
    expect(patchRes.status).toBe(200);

    const commentsRes = await request(app)
      .get(`/api/issues/${issueId}/comments`);
    expect(commentsRes.status).toBe(200);
    expect(commentsRes.body).toHaveLength(1);
    expect(commentsRes.body[0].body).toBe("Visible immediately");
  });

  it("GET /comments?after= returns new comment on first read after PATCH", async () => {
    const { companyId, issueId } = await seedFixture();
    const app = await createApp(companyId);

    const seedCommentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Seed comment" });
    expect(seedCommentRes.status).toBe(201);
    const seedCommentId = seedCommentRes.body.id;

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "After-patch comment" });
    expect(patchRes.status).toBe(200);

    const afterRes = await request(app)
      .get(`/api/issues/${issueId}/comments?after=${seedCommentId}&order=asc`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.length).toBeGreaterThanOrEqual(1);
    expect(afterRes.body.some((c: any) => c.body === "After-patch comment")).toBe(true);
  });

  it("heartbeat-context cursor matches the PATCH-created comment ID", async () => {
    const { companyId, issueId } = await seedFixture();
    const app = await createApp(companyId);

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Cursor match test" });
    expect(patchRes.status).toBe(200);

    const commentsRes = await request(app)
      .get(`/api/issues/${issueId}/comments`);
    expect(commentsRes.status).toBe(200);
    const patchComment = commentsRes.body.find((c: any) => c.body === "Cursor match test");
    expect(patchComment).toBeTruthy();

    const contextRes = await request(app)
      .get(`/api/issues/${issueId}/heartbeat-context`);
    expect(contextRes.status).toBe(200);
    expect(contextRes.body.commentCursor.latestCommentId).toBe(patchComment.id);
    expect(contextRes.body.commentCursor.totalComments).toBe(1);
  });
});
