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
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";

describe("issueService stale checkout run adoption", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let agentId = "";
  let issueCounter = 1;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-service-"));
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
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Service Test Company",
      issuePrefix: "TIS",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Engineer",
      status: "active",
      role: "platform",
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  async function seedInProgressIssueWithStaleCheckout() {
    const staleRunId = randomUUID();
    const currentRunId = randomUUID();
    const issueId = randomUUID();
    const issueNumber = issueCounter;
    issueCounter += 1;

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-03-07T00:00:00.000Z"),
        finishedAt: new Date("2026-03-07T00:05:00.000Z"),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date("2026-03-07T00:10:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      createdByAgentId: agentId,
      issueNumber,
      identifier: `TIS-${issueNumber}`,
    });

    return { staleRunId, currentRunId, issueId };
  }

  it("adopts a stale checkout run during checkout", async () => {
    const svc = issueService(db);
    const { currentRunId, issueId } = await seedInProgressIssueWithStaleCheckout();

    const updated = await svc.checkout(issueId, agentId, ["todo"], currentRunId);

    expect(updated.status).toBe("in_progress");
    expect(updated.checkoutRunId).toBe(currentRunId);
    expect(updated.executionRunId).toBe(currentRunId);
  });

  it("adopts a stale checkout run for same-agent ownership checks", async () => {
    const svc = issueService(db);
    const { staleRunId, currentRunId, issueId } = await seedInProgressIssueWithStaleCheckout();

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, currentRunId);
    const released = await svc.release(issueId, agentId, currentRunId);

    expect(ownership.adoptedFromRunId).toBe(staleRunId);
    expect(ownership.checkoutRunId).toBe(currentRunId);
    expect(ownership.executionRunId).toBe(currentRunId);
    expect(released?.status).toBe("todo");
    expect(released?.checkoutRunId).toBeNull();
  });
});
