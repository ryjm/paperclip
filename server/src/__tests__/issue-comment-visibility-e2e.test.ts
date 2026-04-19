import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comment visibility tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function registerHeartbeatServiceMock() {
  vi.doMock("../services/heartbeat.js", async () => {
    const actual = await vi.importActual<typeof import("../services/heartbeat.js")>(
      "../services/heartbeat.js",
    );
    return {
      ...actual,
      heartbeatService: () => ({
        wakeup: async () => null,
        reportRunActivity: async () => undefined,
        getRun: async () => null,
        getActiveRunForAgent: async () => null,
        cancelRun: async () => null,
        reconcileAgentStatus: async () => undefined,
      }),
    };
  });
}

describeEmbeddedPostgres("issue PATCH comment visibility (DB-backed)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comment-vis-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
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
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/goals.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/issue-assignment-wakeup.js");
    vi.doUnmock("../services/issue-execution-policy.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");

    registerHeartbeatServiceMock();

    vi.doMock("../services/issue-assignment-wakeup.js", () => ({
      queueIssueAssignmentWakeup: () => {},
    }));
  });

  async function createApp(actor: Record<string, unknown>) {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const storage = {
      provider: "local" as const,
      putFile: async () => ({ provider: "local" as const, objectKey: "", contentType: "", byteSize: 0, sha256: "", originalFilename: null }),
      getObject: async () => { throw new Error("not implemented"); },
      headObject: async () => ({ exists: false }),
      deleteObject: async () => {},
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, storage as any));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
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

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue for comment visibility",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, userId, issueId, issuePrefix };
  }

  it("new comment is immediately visible in heartbeat-context and comments after PATCH", async () => {
    const { companyId, userId, issueId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const baselineCtx = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);
    expect(baselineCtx.status).toBe(200);
    expect(baselineCtx.body.commentCursor.totalComments).toBe(0);
    expect(baselineCtx.body.commentCursor.latestCommentId).toBeNull();

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Regression test comment" });
    expect(patchRes.status).toBe(200);

    const ctx = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.commentCursor.totalComments).toBe(1);
    expect(ctx.body.commentCursor.latestCommentId).toBeTruthy();
    expect(ctx.body.commentCursor.latestCommentAt).toBeTruthy();

    const newCommentId = ctx.body.commentCursor.latestCommentId;

    const commentsRes = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .query({ order: "desc" });
    expect(commentsRes.status).toBe(200);
    expect(commentsRes.body).toHaveLength(1);
    expect(commentsRes.body[0].id).toBe(newCommentId);
    expect(commentsRes.body[0].body).toBe("Regression test comment");

    const afterRes = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .query({ after: newCommentId, order: "asc" });
    expect(afterRes.status).toBe(200);
    expect(afterRes.body).toHaveLength(0);
  }, 15_000);

  it("incremental comments?after= returns only comments added after the cursor", async () => {
    const { companyId, userId, issueId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const patch1 = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "First comment" });
    expect(patch1.status).toBe(200);

    const ctx1 = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);
    expect(ctx1.status).toBe(200);
    const firstCommentId = ctx1.body.commentCursor.latestCommentId;
    expect(firstCommentId).toBeTruthy();

    const patch2 = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Second comment" });
    expect(patch2.status).toBe(200);

    const ctx2 = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);
    expect(ctx2.status).toBe(200);
    expect(ctx2.body.commentCursor.totalComments).toBe(2);
    const secondCommentId = ctx2.body.commentCursor.latestCommentId;
    expect(secondCommentId).not.toBe(firstCommentId);

    const incrementalRes = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .query({ after: firstCommentId, order: "asc" });
    expect(incrementalRes.status).toBe(200);
    expect(incrementalRes.body).toHaveLength(1);
    expect(incrementalRes.body[0].id).toBe(secondCommentId);
    expect(incrementalRes.body[0].body).toBe("Second comment");
  }, 15_000);
});
