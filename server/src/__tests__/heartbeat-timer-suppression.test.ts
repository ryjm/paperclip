import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { asc, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getTimerWakeSuppressionStateKey,
  heartbeatService,
  shouldSuppressTimerWakeForAssignedIssues,
} from "../services/heartbeat.ts";

describe("shouldSuppressTimerWakeForAssignedIssues", () => {
  it("suppresses timer wakes when every assigned issue is blocked and the latest activity is my own comment", () => {
    expect(
      shouldSuppressTimerWakeForAssignedIssues("agent-1", [
        {
          id: "issue-1",
          status: "blocked",
          latestActivityId: "activity-1",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-1",
        },
        {
          id: "issue-2",
          status: "blocked",
          latestActivityId: "activity-2",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-1",
        },
      ]),
    ).toBe(true);
  });

  it("does not suppress when there is no assigned work", () => {
    expect(shouldSuppressTimerWakeForAssignedIssues("agent-1", [])).toBe(false);
  });

  it("does not suppress when any assigned issue is still actionable", () => {
    expect(
      shouldSuppressTimerWakeForAssignedIssues("agent-1", [
        {
          id: "issue-1",
          status: "blocked",
          latestActivityId: "activity-1",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-1",
        },
        {
          id: "issue-2",
          status: "todo",
          latestActivityId: "activity-2",
          latestActivityAction: "issue.updated",
          latestActivityAgentId: null,
        },
      ]),
    ).toBe(false);
  });

  it("does not suppress when the latest activity came from someone else", () => {
    expect(
      shouldSuppressTimerWakeForAssignedIssues("agent-1", [
        {
          id: "issue-1",
          status: "blocked",
          latestActivityId: "activity-1",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-2",
        },
      ]),
    ).toBe(false);
  });

  it("does not suppress when a later status change replaced the blocker comment as latest activity", () => {
    expect(
      shouldSuppressTimerWakeForAssignedIssues("agent-1", [
        {
          id: "issue-1",
          status: "blocked",
          latestActivityId: "activity-1",
          latestActivityAction: "issue.updated",
          latestActivityAgentId: null,
        },
      ]),
    ).toBe(false);
  });

  it("builds a stable suppression state key from the latest blocked-only activity", () => {
    expect(
      getTimerWakeSuppressionStateKey("agent-1", [
        {
          id: "issue-2",
          status: "blocked",
          latestActivityId: "activity-2",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-1",
        },
        {
          id: "issue-1",
          status: "blocked",
          latestActivityId: "activity-1",
          latestActivityAction: "issue.comment_added",
          latestActivityAgentId: "agent-1",
        },
      ]),
    ).toBe("issue-1:activity-1|issue-2:activity-2");
  });
});

describe("heartbeat timer suppression", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let issueNumber = 1;

  const heartbeat = () => heartbeatService(db);

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-heartbeat-timer-"));
    const port = await detectPort(55434);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    await embeddedPostgres.initialise();
    await embeddedPostgres.start();

    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");

    databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Timer Suppression Test Company",
      issuePrefix: "HTS",
    });
  }, 120_000);

  beforeEach(async () => {
    issueNumber = 1;

    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  async function seedTimerAgent() {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Suppressed Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
        },
      },
      lastHeartbeatAt: new Date("2026-03-23T11:58:00.000Z"),
    });
    return agentId;
  }

  async function seedBlockedIssueWithLatestAgentComment(agentId: string) {
    const issueId = randomUUID();
    const currentIssueNumber = issueNumber;
    issueNumber += 1;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Blocked Issue ${currentIssueNumber}`,
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      issueNumber: currentIssueNumber,
      identifier: `HTS-${currentIssueNumber}`,
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: {
        bodySnippet: "Blocked waiting on external input",
      },
    });

    return issueId;
  }

  it("suppresses repeated timer wake checks when the agent has no assigned work", async () => {
    const agentId = await seedTimerAgent();

    const first = await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));
    const second = await heartbeat().tickTimers(new Date("2026-03-23T12:05:31.000Z"));
    const third = await heartbeat().tickTimers(new Date("2026-03-23T12:10:31.000Z"));

    expect(first).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });
    expect(second).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });
    expect(third).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const [wakeups, runs] = await Promise.all([
      db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .orderBy(asc(agentWakeupRequests.requestedAt)),
      db
        .select({
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(asc(heartbeatRuns.createdAt)),
    ]);

    expect(wakeups).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("skips timer wakeups when the inbox only contains unchanged blocked issues", async () => {
    const agentId = await seedTimerAgent();
    await seedBlockedIssueWithLatestAgentComment(agentId);

    const result = await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));

    expect(result).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        status: "skipped",
        reason: "heartbeat.blocked_only_inbox",
      },
    ]);
  });

  it("does not write duplicate blocked-only skip rows while the issue state is unchanged", async () => {
    const agentId = await seedTimerAgent();
    await seedBlockedIssueWithLatestAgentComment(agentId);

    await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));
    await heartbeat().tickTimers(new Date("2026-03-23T12:00:31.000Z"));
    await heartbeat().tickTimers(new Date("2026-03-23T12:05:31.000Z"));

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        status: "skipped",
        reason: "heartbeat.blocked_only_inbox",
      },
    ]);
  });

  it("records a fresh blocked-only skip when the blocking context changes", async () => {
    const agentId = await seedTimerAgent();
    const issueId = await seedBlockedIssueWithLatestAgentComment(agentId);

    await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: {
        bodySnippet: "Still blocked after another follow-up",
      },
    });

    await heartbeat().tickTimers(new Date("2026-03-23T12:05:31.000Z"));

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        status: "skipped",
        reason: "heartbeat.blocked_only_inbox",
      },
      {
        status: "skipped",
        reason: "heartbeat.blocked_only_inbox",
      },
    ]);
  });
});
