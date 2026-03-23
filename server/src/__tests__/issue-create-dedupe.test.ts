import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { and, eq } from "drizzle-orm";
import { applyPendingMigrations, agents, companies, createDb, ensurePostgresDatabase, goals, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";

describe("issue create dedupe", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let embeddedPostgres: EmbeddedPostgres;
  let db: ReturnType<typeof createDb>;
  let companyId = "";
  let goalId = "";
  let agentId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-create-dedupe-"));
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
    goalId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Create Dedupe Test Company",
      issuePrefix: "ICD",
    });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Prevent duplicate merge-review tasks",
      status: "active",
      level: "company",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Merge Queue Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  async function createParentIssue() {
    const result = await issueService(db).create(companyId, {
      goalId,
      title: `Parent ${randomUUID()}`,
      status: "in_review",
      priority: "medium",
      createdByUserId: "board-user",
    });
    return result.issue;
  }

  it("reuses an open agent-created child issue for the same parent and title", async () => {
    const parent = await createParentIssue();
    const svc = issueService(db);
    const payload = {
      goalId,
      parentId: parent.id,
      title: "Review and merge Tabula PR #377 (GRA-1565)",
      description: "MERGEABLE PR with no review task yet.",
      status: "todo" as const,
      priority: "medium" as const,
      createdByAgentId: agentId,
    };

    const [first, second] = await Promise.all([
      svc.create(companyId, payload),
      svc.create(companyId, payload),
    ]);

    expect(first.issue.id).toBe(second.issue.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);

    const matchingIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.parentId, parent.id),
          eq(issues.title, payload.title),
        ),
      );

    expect(matchingIssues).toHaveLength(1);
  });

  it("does not dedupe user-created child issues with the same parent and title", async () => {
    const parent = await createParentIssue();
    const svc = issueService(db);
    const payload = {
      goalId,
      parentId: parent.id,
      title: "Review and merge Tabula PR #390 (GRA-1610)",
      description: "Manual duplicate for board triage.",
      status: "todo" as const,
      priority: "medium" as const,
      createdByUserId: "board-user",
    };

    const first = await svc.create(companyId, payload);
    const second = await svc.create(companyId, payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.issue.id).not.toBe(second.issue.id);
  });
});
