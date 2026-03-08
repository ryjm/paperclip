import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  issues,
} from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";

describe("dashboardService stranded work summary", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let erroredAgentId = "";
  let healthyAgentId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-dashboard-service-"));
    const port = await detectPort();
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
    erroredAgentId = randomUUID();
    healthyAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Dashboard Test Company",
      issuePrefix: "DST",
    });

    await db.insert(agents).values([
      {
        id: erroredAgentId,
        companyId,
        name: "Errored Engineer",
        status: "error",
        role: "engineer",
      },
      {
        id: healthyAgentId,
        companyId,
        name: "Healthy Engineer",
        status: "active",
        role: "engineer",
      },
    ]);
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  it("counts todo and in-progress work on errored agents as stranded without folding it into stale tasks", async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Errored todo",
        status: "todo",
        priority: "high",
        assigneeAgentId: erroredAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 1,
        identifier: "DST-1",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Errored in progress",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: erroredAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 2,
        identifier: "DST-2",
        startedAt: twoHoursAgo,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Healthy stale issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: healthyAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 3,
        identifier: "DST-3",
        startedAt: twoHoursAgo,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Completed issue",
        status: "done",
        priority: "low",
        assigneeAgentId: erroredAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 4,
        identifier: "DST-4",
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.agents.error).toBe(1);
    expect(summary.tasks.inProgress).toBe(2);
    expect(summary.strandedTasks).toBe(2);
    expect(summary.staleTasks).toBe(1);
  });
});
