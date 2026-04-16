import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import { approvalRoutes } from "../routes/approvals.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
  listIssuesForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  getForProject: vi.fn(),
  upsertForProject: vi.fn(),
  deleteForProject: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  secretService: () => mockSecretService,
  projectService: () => mockProjectService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  logActivity: mockLogActivity,
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
    app.use(express.json());
    app.use(actorMiddleware());
    app.use("/api", goalRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  it("returns 404 for malformed GET /goals/:id lookups", async () => {
    const res = await request(buildApp()).get("/api/goals/undefined");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Goal not found/);
  });

  it("returns 404 for malformed PATCH /goals/:id lookups", async () => {
    const res = await request(buildApp())
      .patch("/api/goals/not-a-uuid")
      .send({ title: "test" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Goal not found/);
  });

  it("returns 404 for malformed DELETE /goals/:id lookups", async () => {
    const res = await request(buildApp()).delete("/api/goals/undefined");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Goal not found/);
  });
});

describe("approval routes malformed id", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware());
    app.use("/api", approvalRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  it("returns 404 for malformed GET /approvals/:id lookups", async () => {
    const res = await request(buildApp()).get("/api/approvals/undefined");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Approval not found/);
  });

  it("returns 404 for malformed GET /approvals/:id/issues lookups", async () => {
    const res = await request(buildApp()).get("/api/approvals/not-a-uuid/issues");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Approval not found/);
  });

  it("returns 404 for malformed GET /approvals/:id/comments lookups", async () => {
    const res = await request(buildApp()).get("/api/approvals/undefined/comments");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Approval not found/);
  });
});

describe("project routes malformed id", () => {
  const projectId = "22222222-2222-4222-8222-222222222222";

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware());
    app.use("/api", projectRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.resolveByReference.mockResolvedValue({ project: null, ambiguous: false });
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.update.mockResolvedValue(null);
  });

  it("returns 404 for malformed GET /projects/:id lookups", async () => {
    const res = await request(buildApp()).get("/api/projects/undefined");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it("returns 404 for malformed PATCH /projects/:id lookups", async () => {
    const res = await request(buildApp())
      .patch("/api/projects/not-a-uuid")
      .send({ name: "test" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it("returns 404 for malformed DELETE /projects/:id lookups", async () => {
    const res = await request(buildApp()).delete("/api/projects/not-a-uuid");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it("converts archivedAt strings back into Date objects before patching projects", async () => {
    const archivedAt = "2026-03-24T12:34:56.000Z";
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
    });
    mockProjectService.update.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      archivedAt: new Date(archivedAt),
    });

    const res = await request(buildApp())
      .patch(`/api/projects/${projectId}`)
      .send({ archivedAt });

    expect(res.status).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledTimes(1);
    const updateInput = mockProjectService.update.mock.calls[0]?.[1];
    expect(updateInput).toMatchObject({ archivedAt: expect.any(Date) });
    expect((updateInput as { archivedAt: Date }).archivedAt.toISOString()).toBe(archivedAt);
  });
});
