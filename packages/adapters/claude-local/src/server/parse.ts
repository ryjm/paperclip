import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;
const CLAUDE_QUOTA_SIGNAL_RE =
  /(?:out of extra usage|out_of_credits|overageDisabledReason\s*=\s*out_of_credits|usage limit)/i;
const CLAUDE_RESET_RE = /\bresets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s*\(([^)]+)\))?/i;

interface ClaudeWakeCooldown {
  kind: "provider_quota_reset";
  scope: "agent";
  provider: string;
  adapterType: string;
  errorCode: string;
  message: string;
  resetAt: string;
  resetLabel: string | null;
  timezone: string | null;
  detectedAt: string;
  sourceRunId: string | null;
}

function collectClaudeMessages(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): string[] {
  const resultText = asString(input.parsed?.result, "").trim();
  const raw = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return [...new Set(raw)];
}

function parseClockLabel(value: string) {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return null;
  }

  const hour = meridiem === "pm"
    ? (hour12 % 12) + 12
    : hour12 % 12;
  return { hour, minute };
}

function timeZoneFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readTimeZoneParts(date: Date, timeZone: string) {
  try {
    const formatted = timeZoneFormatter(timeZone).formatToParts(date);
    const lookup = (type: Intl.DateTimeFormatPartTypes) =>
      formatted.find((part) => part.type === type)?.value ?? "";
    const year = Number.parseInt(lookup("year"), 10);
    const month = Number.parseInt(lookup("month"), 10);
    const day = Number.parseInt(lookup("day"), 10);
    const hour = Number.parseInt(lookup("hour"), 10);
    const minute = Number.parseInt(lookup("minute"), 10);
    const second = Number.parseInt(lookup("second"), 10);
    if ([year, month, day, hour, minute, second].some((part) => !Number.isFinite(part))) {
      return null;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

function readTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = readTimeZoneParts(date, timeZone);
  if (!parts) return null;
  const zonedMillis = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedMillis - date.getTime();
}

function zonedLocalDateTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}) {
  const utcGuess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );
  const firstOffset = readTimeZoneOffsetMs(new Date(utcGuess), input.timeZone);
  if (firstOffset === null) return null;

  let utcMillis = utcGuess - firstOffset;
  const secondOffset = readTimeZoneOffsetMs(new Date(utcMillis), input.timeZone);
  if (secondOffset !== null && secondOffset !== firstOffset) {
    utcMillis = utcGuess - secondOffset;
  }
  return new Date(utcMillis);
}

function resolveResetAt(input: {
  resetLabel: string;
  timeZone: string | null;
  now: Date;
}) {
  const parsedClock = parseClockLabel(input.resetLabel);
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  if (!parsedClock || !timeZone) return null;

  const todayInZone = readTimeZoneParts(input.now, timeZone);
  if (!todayInZone) return null;

  const buildCandidate = (year: number, month: number, day: number) =>
    zonedLocalDateTimeToUtc({
      year,
      month,
      day,
      hour: parsedClock.hour,
      minute: parsedClock.minute,
      second: 0,
      timeZone,
    });

  let candidate = buildCandidate(todayInZone.year, todayInZone.month, todayInZone.day);
  if (!candidate) return null;

  if (candidate.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(todayInZone.year, todayInZone.month - 1, todayInZone.day + 1));
    candidate = buildCandidate(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
    );
    if (!candidate) return null;
  }

  return {
    resetAt: candidate,
    timeZone,
  };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const messages = collectClaudeMessages(input);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function detectClaudeQuotaCooldown(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  now?: Date;
}): ClaudeWakeCooldown | null {
  const now = input.now ?? new Date();
  const messages = collectClaudeMessages(input);
  const matchingLine = messages.find(
    (line) => CLAUDE_QUOTA_SIGNAL_RE.test(line) && CLAUDE_RESET_RE.test(line),
  );
  const combined = messages.join("\n");
  const sourceText =
    matchingLine ??
    (CLAUDE_QUOTA_SIGNAL_RE.test(combined) && CLAUDE_RESET_RE.test(combined) ? combined : null);
  if (!sourceText) return null;

  const resetMatch = sourceText.match(CLAUDE_RESET_RE);
  if (!resetMatch) return null;

  const resetLabel = resetMatch[1]?.trim() ?? null;
  if (!resetLabel) return null;
  const explicitTimeZone = resetMatch[2]?.trim() || null;
  const resolvedReset = resolveResetAt({
    resetLabel,
    timeZone: explicitTimeZone,
    now,
  });
  if (!resolvedReset) return null;

  return {
    kind: "provider_quota_reset",
    scope: "agent",
    provider: "anthropic",
    adapterType: "claude_local",
    errorCode: "claude_quota_cooldown",
    message: matchingLine ?? sourceText,
    resetAt: resolvedReset.resetAt.toISOString(),
    resetLabel,
    timezone: explicitTimeZone ?? resolvedReset.timeZone,
    detectedAt: now.toISOString(),
    sourceRunId: null,
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}
