import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { applyPendingMigrations, companies, createDb, ensurePostgresDatabase } from "@paperclipai/db";
import { issueService } from "../services/issues.js";

describe("issueService search", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-search-"));
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
    await db.insert(companies).values({
      id: companyId,
      name: "Issue Search Test Company",
      issuePrefix: "ISS",
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  it("finds overlapping issues from token matches when the exact query phrase is absent", async () => {
    const svc = issueService(db);
    const canonical = await svc.create(companyId, {
      title: "Close host-header auth bypass on the embedded API server",
      description:
        "The desktop API server trusts Host: localhost and lets a remote client bypass authentication by spoofing the header.",
      status: "todo",
      priority: "high",
    });
    await svc.create(companyId, {
      title: "Add auth audit logging to issue updates",
      description: "Record when issue status changes succeed or fail.",
      status: "todo",
      priority: "medium",
    });
    await svc.create(companyId, {
      title: "Refresh dashboard chart layout",
      description: "Pure UI cleanup for summary cards.",
      status: "todo",
      priority: "low",
    });

    const results = await svc.list(companyId, { q: "localhost header auth bypass" });

    expect(results.map((issue) => issue.id)).toEqual([canonical.id]);
  });
});
