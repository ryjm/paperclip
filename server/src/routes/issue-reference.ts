import { isUuidLike } from "@paperclipai/shared";

export const INVALID_ISSUE_REFERENCE_MESSAGE =
  "Invalid issue id. Use an issue UUID or identifier like PAP-123.";

const ISSUE_IDENTIFIER_RE = /^[A-Z]+-\d+$/i;

export type ParsedIssueReference =
  | { kind: "uuid"; value: string }
  | { kind: "identifier"; value: string }
  | { kind: "invalid"; value: string };

export function parseIssueReference(rawId: string): ParsedIssueReference {
  const value = rawId.trim();
  if (isUuidLike(value)) {
    return { kind: "uuid", value };
  }
  if (ISSUE_IDENTIFIER_RE.test(value)) {
    return { kind: "identifier", value };
  }
  return { kind: "invalid", value };
}
