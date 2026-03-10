const ACTIONABLE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);

type IssueUpdateWakeInput = {
  actorType: "board" | "agent" | "none";
  actorAgentId: string | null;
  actorRunId: string | null;
  previousStatus: string;
  nextStatus: string;
  previousAssigneeAgentId: string | null;
  nextAssigneeAgentId: string | null;
};

export function shouldWakeAssigneeOnIssueUpdate(input: IssueUpdateWakeInput): boolean {
  if (!input.nextAssigneeAgentId) return false;
  if (input.nextStatus === "backlog") return false;

  if (input.nextAssigneeAgentId !== input.previousAssigneeAgentId) {
    return true;
  }

  const becameActionable =
    ACTIONABLE_ISSUE_STATUSES.has(input.nextStatus) &&
    !ACTIONABLE_ISSUE_STATUSES.has(input.previousStatus);
  if (!becameActionable) return false;

  if (input.actorType !== "agent") return true;
  if (!input.actorAgentId) return true;
  if (input.actorAgentId !== input.nextAssigneeAgentId) return true;
  return !input.actorRunId;
}
