import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_PAPERCLIP_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const LOCAL_PAPERCLIP_REPO_ROOT_SLASHED = normalizePathSlashes(LOCAL_PAPERCLIP_REPO_ROOT);
const PAPERCLIP_CONTROL_PLANE_ROUTE_RE =
  /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+)?\/api\/(?:issues|companies|agents|approvals|projects|goals|activity|routines|assets|access|execution-workspaces)(?:\/|\b)/i;
const PAPERCLIP_CONTROL_PLANE_SOURCE_PATH_RE =
  /\b(?:server\/src\/|ui\/src\/|packages\/(?:adapter-utils|db|shared|adapters)\/|skills\/paperclip\/)/i;
const PAPERCLIP_CONTROL_PLANE_KEYWORD_RE =
  /\b(?:paperclip|control-plane|heartbeat(?:-context)?|wake payload|PAPERCLIP_WAKE_PAYLOAD_JSON)\b/i;

export type IssueSourceRepoHint = {
  repoPath: string;
  reason: string;
  signals: string[];
};

function normalizePathSlashes(value: string) {
  return value.replaceAll("\\", "/");
}

function nonEmptyText(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function detectIssueSourceRepoHint(input: {
  title?: string | null;
  description?: string | null;
  commentBodies?: Array<string | null | undefined>;
}): IssueSourceRepoHint | null {
  const combinedText = [
    nonEmptyText(input.title),
    nonEmptyText(input.description),
    ...(input.commentBodies ?? []).map((value) => nonEmptyText(value)),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  if (!combinedText) return null;

  const normalizedText = normalizePathSlashes(combinedText);
  const signals: string[] = [];

  if (normalizedText.includes(LOCAL_PAPERCLIP_REPO_ROOT_SLASHED)) {
    signals.push("issue text mentions the local Paperclip repo path");
  }
  if (PAPERCLIP_CONTROL_PLANE_SOURCE_PATH_RE.test(combinedText)) {
    signals.push("issue text references Paperclip server or UI source paths");
  }
  if (PAPERCLIP_CONTROL_PLANE_ROUTE_RE.test(combinedText)) {
    signals.push("issue text references Paperclip control-plane API routes");
  }
  if (
    signals.length === 0
    && PAPERCLIP_CONTROL_PLANE_KEYWORD_RE.test(combinedText)
  ) {
    signals.push("issue text references Paperclip control-plane behavior");
  }

  if (signals.length === 0) return null;

  return {
    repoPath: LOCAL_PAPERCLIP_REPO_ROOT,
    reason: signals[0]!,
    signals,
  };
}
