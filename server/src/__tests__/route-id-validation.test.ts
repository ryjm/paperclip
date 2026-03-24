import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import { approvalRoutes } from "../routes/approvals.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/index.js", () => ({
  goalService: () => ({
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  approvalService: () => ({
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(),
  }),
  issueApprovalService: () => ({
    linkManyForApproval: vi.fn(),
    listIssuesForApproval: vi.fn(),
  }),
  secretService: () => ({
    normalizeHireApprovalPayloadForPersistence: vi.fn(),
  }),
  projectService: () => ({
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    resolveByReference: vi.fn().mockResolvedValue({ project: null, ambiguous: false }),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

function actorMiddleware() {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    };
    next();
  };
}

describe("goal routes malformed id", () => {
  function buildApp() {
    const app = express();
    app.use(actorMiddleware());
    app.use("/api", goalRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  it("rejects non-UUID id with 400 on GET /goals/:id", async () => {
    const res = await request(buildApp()).get("/api/goals/undefined");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid goal id/);
  });

  it("rejects non-UUID id with 400 on PATCH /goals/:id", async () => {
    const res = await request(buildApp())
      .patch("/api/goals/not-a-uuid")
      .send({ title: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid goal id/);
  });

  it("rejects non-UUID id with 400 on DELETE /goals/:id", async () => {
    const res = await request(buildApp()).delete("/api/goals/undefined");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid goal id/);
  });
});

describe("approval routes malformed id", () => {
  function buildApp() {
    const app = express();
    app.use(actorMiddleware());
    app.use("/api", approvalRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  it("rejects non-UUID id with 400 on GET /approvals/:id", async () => {
    const res = await request(buildApp()).get("/api/approvals/undefined");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid approval id/);
  });

  it("rejects non-UUID id with 400 on GET /approvals/:id/issues", async () => {
    const res = await request(buildApp()).get("/api/approvals/not-a-uuid/issues");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid approval id/);
  });

  it("rejects non-UUID id with 400 on GET /approvals/:id/comments", async () => {
    const res = await request(buildApp()).get("/api/approvals/undefined/comments");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid approval id/);
  });
});

describe("project routes malformed id", () => {
  function buildApp() {
    const app = express();
    app.use(actorMiddleware());
    app.use("/api", projectRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  it("rejects non-UUID non-shortname id with 400 on GET /projects/:id", async () => {
    const res = await request(buildApp()).get("/api/projects/undefined");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid project id/);
  });

  it("rejects non-UUID non-shortname id with 400 on PATCH /projects/:id", async () => {
    const res = await request(buildApp())
      .patch("/api/projects/not-a-uuid")
      .send({ name: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid project id/);
  });

  it("rejects non-UUID non-shortname id with 400 on DELETE /projects/:id", async () => {
    const res = await request(buildApp()).delete("/api/projects/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid project id/);
  });
});
