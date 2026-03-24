import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  documentService: () => ({}),
  logActivity: vi.fn(),
  projectService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue route id validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for malformed issue ids on detail routes", async () => {
    const res = await request(createApp()).get("/api/issues/undefined");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid issue id. Use an issue UUID or identifier like PAP-123.",
    });
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed issue ids on mutation routes", async () => {
    const res = await request(createApp())
      .patch("/api/issues/undefined")
      .send({ title: "new title" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid issue id. Use an issue UUID or identifier like PAP-123.",
    });
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("returns 404 when an identifier-shaped issue reference does not exist", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/issues/PAP-999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-999");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });
});
