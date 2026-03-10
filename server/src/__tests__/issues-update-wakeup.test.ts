import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeOnIssueUpdate } from "../routes/issues-update-wakeup.js";

describe("shouldWakeAssigneeOnIssueUpdate", () => {
  it("wakes when a board user moves an already-assigned issue from backlog to todo", () => {
    expect(
      shouldWakeAssigneeOnIssueUpdate({
        actorType: "board",
        actorAgentId: null,
        actorRunId: null,
        previousStatus: "backlog",
        nextStatus: "todo",
        previousAssigneeAgentId: "agent-1",
        nextAssigneeAgentId: "agent-1",
      })
    ).toBe(true);
  });

  it("keeps waking when the assignee changes onto a non-backlog issue", () => {
    expect(
      shouldWakeAssigneeOnIssueUpdate({
        actorType: "board",
        actorAgentId: null,
        actorRunId: null,
        previousStatus: "backlog",
        nextStatus: "blocked",
        previousAssigneeAgentId: null,
        nextAssigneeAgentId: "agent-2",
      })
    ).toBe(true);
  });

  it("does not wake when an assigned issue remains in backlog", () => {
    expect(
      shouldWakeAssigneeOnIssueUpdate({
        actorType: "board",
        actorAgentId: null,
        actorRunId: null,
        previousStatus: "backlog",
        nextStatus: "backlog",
        previousAssigneeAgentId: "agent-1",
        nextAssigneeAgentId: "agent-1",
      })
    ).toBe(false);
  });

  it("skips self-wake when the assignee agent reopens work inside its own run", () => {
    expect(
      shouldWakeAssigneeOnIssueUpdate({
        actorType: "agent",
        actorAgentId: "agent-1",
        actorRunId: "run-1",
        previousStatus: "blocked",
        nextStatus: "todo",
        previousAssigneeAgentId: "agent-1",
        nextAssigneeAgentId: "agent-1",
      })
    ).toBe(false);
  });
});
