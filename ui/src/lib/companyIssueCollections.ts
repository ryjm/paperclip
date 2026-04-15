import type { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import {
  applyOptimisticIssueFieldUpdateToCollection,
  matchesIssueRef,
} from "./optimistic-issue-comments";

type IssueCollectionSnapshot = readonly [readonly unknown[], Issue[] | undefined];

function isCompanyIssueCollectionQueryKey(queryKey: readonly unknown[], companyId: string) {
  return queryKey[0] === "issues"
    && queryKey[1] === companyId
    && queryKey[2] !== "labels";
}

export function snapshotCompanyIssueCollectionQueries(
  queryClient: QueryClient,
  companyId: string,
): IssueCollectionSnapshot[] {
  return queryClient.getQueriesData<Issue[]>({
    predicate: (query) => isCompanyIssueCollectionQueryKey(query.queryKey, companyId),
  });
}

export async function cancelCompanyIssueCollectionQueries(
  queryClient: QueryClient,
  companyId: string,
) {
  await queryClient.cancelQueries({
    predicate: (query) => isCompanyIssueCollectionQueryKey(query.queryKey, companyId),
  });
}

export async function invalidateCompanyIssueCollectionQueries(
  queryClient: QueryClient,
  companyId: string,
) {
  await queryClient.invalidateQueries({
    predicate: (query) => isCompanyIssueCollectionQueryKey(query.queryKey, companyId),
  });
}

export function applyOptimisticIssueUpdateToCompanyIssueCollections(
  queryClient: QueryClient,
  companyId: string,
  refs: Iterable<string>,
  data: Record<string, unknown>,
) {
  queryClient.setQueriesData<Issue[] | undefined>(
    {
      predicate: (query) => isCompanyIssueCollectionQueryKey(query.queryKey, companyId),
    },
    (cached) => applyOptimisticIssueFieldUpdateToCollection(cached, refs, data),
  );
}

export function mergeIssueIntoCompanyIssueCollections(
  queryClient: QueryClient,
  companyId: string,
  refs: Iterable<string>,
  nextIssue: Issue,
) {
  queryClient.setQueriesData<Issue[] | undefined>(
    {
      predicate: (query) => isCompanyIssueCollectionQueryKey(query.queryKey, companyId),
    },
    (cached) => cached?.map((issue) => (matchesIssueRef(issue, refs) ? { ...issue, ...nextIssue } : issue)),
  );
}

export function restoreCompanyIssueCollectionQueries(
  queryClient: QueryClient,
  snapshots: ReadonlyArray<IssueCollectionSnapshot>,
) {
  for (const [queryKey, cached] of snapshots) {
    queryClient.setQueryData(queryKey, cached);
  }
}
