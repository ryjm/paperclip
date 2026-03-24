import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getActiveRunForAgent: vi.fn(),
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentInstructionsService: () => ({}),
  agentService: () => mockAgentService,
  approvalService: () => ({}),
  budgetService: () => ({}),
  companySkillService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({
    readLog: vi.fn(),
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({
      censorUsernameInLogs: false,
    }),
  }),
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
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent issue route id validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for malformed issue ids on live-runs routes", async () => {
    const res = await request(createApp()).get("/api/issues/undefined/live-runs");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid issue id. Use an issue UUID or identifier like PAP-123.",
    });
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("returns 404 when an identifier-shaped issue reference does not exist", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/issues/PAP-999/active-run");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-999");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("resolves issue identifiers before loading active run details", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
      executionRunId: null,
      assigneeAgentId: null,
      status: "todo",
    });

    const res = await request(createApp()).get("/api/issues/PAP-475/active-run");

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.getActiveRunForAgent).not.toHaveBeenCalled();
  });
});
