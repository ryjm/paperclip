export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function compactOutputText(value: string, maxLength = HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS) {
  if (value.length <= maxLength) return value;

  const headChars = Math.max(0, Math.floor(maxLength * 0.65));
  const tailChars = Math.max(0, Math.floor(maxLength * 0.2));
  const omittedChars = Math.max(0, value.length - headChars - tailChars);
  const marker = `\n[paperclip truncated adapter output: omitted ${omittedChars} chars]\n`;
  return `${value.slice(0, headChars)}${marker}${value.slice(value.length - tailChars)}`;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeRawOutputFields(record: Record<string, unknown>) {
  let nextRecord = record;

  for (const key of ["stdout", "stderr"] as const) {
    const value = record[key];
    if (typeof value !== "string" || value.length <= HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS) {
      continue;
    }

    if (nextRecord === record) {
      nextRecord = { ...record };
    }

    nextRecord[key] = compactOutputText(value, HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS);
    nextRecord[`${key}Truncated`] = true;
    nextRecord[`${key}OriginalLength`] = value.length;
  }

  return nextRecord;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? sanitizeRawOutputFields(resultJson)
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}
