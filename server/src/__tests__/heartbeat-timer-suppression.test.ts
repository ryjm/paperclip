import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getTimerWakeSuppressionStateKey,
  heartbeatService,
  shouldSuppressTimerWakeForAssignedIssues,
} from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-timer-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

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
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let companyId = "";
  let issueNumber = 1;

  const heartbeat = () => heartbeatService(db);

  beforeAll(async () => {
    const started = await startTempDatabase();
    databaseDir = started.dataDir;
    embeddedPostgres = started.instance;
    const connectionString = started.connectionString;
    db = createDb(connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Timer Suppression Test Company",
      issuePrefix: "HTS",
    });
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.$client.end({ timeout: 0 });
    }
    await embeddedPostgres?.stop();
    if (databaseDir) {
      fs.rmSync(databaseDir, { recursive: true, force: true });
    }
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
  });

  async function seedTimerAgent(name = "Suppressed Timer Agent") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
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
    const secondTick = await heartbeat().tickTimers(new Date("2026-03-23T12:01:35.000Z"));

    expect(secondTick).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
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
        bodySnippet: "Still blocked after follow-up",
      },
    });

    const secondTick = await heartbeat().tickTimers(new Date("2026-03-23T12:01:35.000Z"));

    expect(secondTick).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toHaveLength(2);
    expect(wakeups.every((row) => row.reason === "heartbeat.blocked_only_inbox")).toBe(true);
    expect(wakeups[0]?.payload).not.toEqual(wakeups[1]?.payload);
  });

  it("skips timer wakeups when the agent has no assigned actionable issues", async () => {
    await seedTimerAgent();

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
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        status: "skipped",
        reason: "heartbeat.empty_agent_queue",
        payload: {
          suppressionStateKey: "empty_agent_queue",
        },
      },
    ]);
  });

  it("still suppresses timer wakes when only unrelated company work exists", async () => {
    const agentId = await seedTimerAgent();

    const currentIssueNumber = issueNumber;
    issueNumber += 1;
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: `Other Agent Work ${currentIssueNumber}`,
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
      issueNumber: currentIssueNumber,
      identifier: `HTS-${currentIssueNumber}`,
    });

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
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        status: "skipped",
        reason: "heartbeat.empty_agent_queue",
        payload: {
          suppressionStateKey: "empty_agent_queue",
        },
      },
    ]);
  });

  it("does not write duplicate empty-agent-queue skip rows while the agent stays idle", async () => {
    const agentId = await seedTimerAgent();

    await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));
    const secondTick = await heartbeat().tickTimers(new Date("2026-03-23T12:01:35.000Z"));

    expect(secondTick).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        reason: "heartbeat.empty_agent_queue",
      },
    ]);
  });

  it("resumes timer wakeups after fresh work is assigned to the agent", async () => {
    const agentId = await seedTimerAgent();

    await heartbeat().tickTimers(new Date("2026-03-23T12:00:30.000Z"));

    const currentIssueNumber = issueNumber;
    issueNumber += 1;
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: `Fresh Work ${currentIssueNumber}`,
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
      assigneeAgentId: agentId,
      issueNumber: currentIssueNumber,
      identifier: `HTS-${currentIssueNumber}`,
    });

    const secondTick = await heartbeat().tickTimers(new Date("2026-03-23T12:01:35.000Z"));

    expect(secondTick).toMatchObject({
      checked: 1,
      enqueued: 1,
      skipped: 0,
    });

    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toEqual([
      {
        reason: "heartbeat.empty_agent_queue",
        status: "skipped",
      },
      {
        reason: "heartbeat_timer",
        status: "claimed",
      },
    ]);
  });
});
