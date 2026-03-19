import type { Agent, AgentWakeCooldown } from "@paperclipai/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getAgentWakeCooldown(agent: Pick<Agent, "metadata"> | null | undefined): AgentWakeCooldown | null {
  const metadata = asRecord(agent?.metadata);
  const cooldown = asRecord(metadata?.paperclipWakeCooldown);
  if (!cooldown) return null;

  const kind = asNonEmptyString(cooldown.kind);
  const scope = asNonEmptyString(cooldown.scope);
  const provider = asNonEmptyString(cooldown.provider);
  const adapterType = asNonEmptyString(cooldown.adapterType);
  const errorCode = asNonEmptyString(cooldown.errorCode);
  const message = asNonEmptyString(cooldown.message);
  const resetAt = asNonEmptyString(cooldown.resetAt);
  const detectedAt = asNonEmptyString(cooldown.detectedAt);
  if (
    kind !== "provider_quota_reset" ||
    scope !== "agent" ||
    !provider ||
    !adapterType ||
    !errorCode ||
    !message ||
    !resetAt ||
    !detectedAt
  ) {
    return null;
  }

  if (Number.isNaN(new Date(resetAt).getTime()) || Number.isNaN(new Date(detectedAt).getTime())) {
    return null;
  }

  return {
    kind: "provider_quota_reset",
    scope: "agent",
    provider,
    adapterType,
    errorCode,
    message,
    resetAt,
    resetLabel: asNonEmptyString(cooldown.resetLabel),
    timezone: asNonEmptyString(cooldown.timezone),
    detectedAt,
    sourceRunId: asNonEmptyString(cooldown.sourceRunId),
  };
}

export function getActiveAgentWakeCooldown(
  agent: Pick<Agent, "metadata"> | null | undefined,
  now = new Date(),
): AgentWakeCooldown | null {
  const cooldown = getAgentWakeCooldown(agent);
  if (!cooldown) return null;
  return new Date(cooldown.resetAt).getTime() > now.getTime() ? cooldown : null;
}

export function formatAgentWakeCooldownDeadline(cooldown: AgentWakeCooldown): string {
  return new Date(cooldown.resetAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
