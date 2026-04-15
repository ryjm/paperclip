const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;

export function isIssueIdentifierRef(value: string): boolean {
  return ISSUE_IDENTIFIER_PATTERN.test(value.trim());
}
