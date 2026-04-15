import { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOptimisticIssueUpdateToCompanyIssueCollections,
  mergeIssueIntoCompanyIssueCollections,
  restoreCompanyIssueCollectionQueries,
  snapshotCompanyIssueCollectionQueries,
} from "./companyIssueCollections";
import { queryKeys } from "./queryKeys";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Investigate stale reads",
    description: null,
    status: "in_review",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("companyIssueCollections", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  it("updates every cached company issue collection while leaving non-collections alone", () => {
    const issue = createIssue();
    const searchIssue = createIssue({ id: "issue-2", identifier: "PAP-2", title: "Another issue" });

    queryClient.setQueryData(queryKeys.issues.list(issue.companyId), [issue]);
    queryClient.setQueryData(queryKeys.issues.search(issue.companyId, "stale"), [issue, searchIssue]);
    queryClient.setQueryData(queryKeys.issues.listByProject(issue.companyId, "project-1"), [issue]);
    queryClient.setQueryData(queryKeys.issues.labels(issue.companyId), [{ id: "label-1", name: "bug", color: "#000" }]);
    queryClient.setQueryData(queryKeys.issues.list("company-2"), [createIssue({ companyId: "company-2" })]);

    applyOptimisticIssueUpdateToCompanyIssueCollections(
      queryClient,
      issue.companyId,
      [issue.id, issue.identifier!],
      { status: "blocked" },
    );

    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.list(issue.companyId))?.[0]?.status).toBe("blocked");
    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.search(issue.companyId, "stale"))?.[0]?.status).toBe("blocked");
    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.listByProject(issue.companyId, "project-1"))?.[0]?.status).toBe("blocked");
    expect(queryClient.getQueryData(queryKeys.issues.labels(issue.companyId))).toEqual([{ id: "label-1", name: "bug", color: "#000" }]);
    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.list("company-2"))?.[0]?.status).toBe("in_review");
  });

  it("restores and merges snapshots across all cached company issue collections", () => {
    const issue = createIssue();
    queryClient.setQueryData(queryKeys.issues.list(issue.companyId), [issue]);
    queryClient.setQueryData(queryKeys.issues.search(issue.companyId, "stale"), [issue]);

    const snapshots = snapshotCompanyIssueCollectionQueries(queryClient, issue.companyId);

    applyOptimisticIssueUpdateToCompanyIssueCollections(
      queryClient,
      issue.companyId,
      [issue.id, issue.identifier!],
      { status: "blocked" },
    );
    mergeIssueIntoCompanyIssueCollections(
      queryClient,
      issue.companyId,
      [issue.id, issue.identifier!],
      createIssue({ status: "blocked", title: "Blocked by upstream fix" }),
    );

    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.list(issue.companyId))?.[0]?.title).toBe("Blocked by upstream fix");
    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.search(issue.companyId, "stale"))?.[0]?.status).toBe("blocked");

    restoreCompanyIssueCollectionQueries(queryClient, snapshots);

    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.list(issue.companyId))?.[0]?.status).toBe("in_review");
    expect(queryClient.getQueryData<Issue[]>(queryKeys.issues.search(issue.companyId, "stale"))?.[0]?.title).toBe("Investigate stale reads");
  });
});
