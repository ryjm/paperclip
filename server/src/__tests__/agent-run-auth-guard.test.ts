import { describe, expect, it, vi } from "vitest";
import { agentRunAuthGuard } from "../middleware/agent-run-auth-guard.js";

function makeReq(method: string, actorSource: string, runId?: string) {
  return {
    method,
    actor: { type: "board", userId: "local-board", source: actorSource },
    header: (name: string) => {
      if (name.toLowerCase() === "x-paperclip-run-id") return runId;
      return undefined;
    },
  } as any;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
  return res;
}

describe("agentRunAuthGuard", () => {
  const guard = agentRunAuthGuard();

  it("allows GET requests with run-id and local_implicit", () => {
    const req = makeReq("GET", "local_implicit", "run-123");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows POST without run-id (normal board UI)", () => {
    const req = makeReq("POST", "local_implicit");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects POST with run-id but local_implicit source", () => {
    const req = makeReq("POST", "local_implicit", "run-123");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Agent run mutations require Bearer authentication. "
           + "Ensure PAPERCLIP_API_KEY is injected for this run.",
    });
  });

  it("rejects PATCH with run-id but local_implicit source", () => {
    const req = makeReq("PATCH", "local_implicit", "run-123");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows POST with run-id when authenticated via agent_jwt", () => {
    const req = {
      method: "POST",
      actor: { type: "agent", agentId: "agent-1", source: "agent_jwt" },
      header: (name: string) => {
        if (name.toLowerCase() === "x-paperclip-run-id") return "run-123";
        return undefined;
      },
    } as any;
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows POST with run-id when authenticated via board_key", () => {
    const req = makeReq("POST", "board_key", "run-123");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows DELETE with run-id when authenticated via session", () => {
    const req = makeReq("DELETE", "session", "run-123");
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
