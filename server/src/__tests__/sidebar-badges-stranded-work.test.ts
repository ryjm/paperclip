import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
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
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";

describe("GET /companies/:companyId/sidebar-badges stranded work", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let erroredAgentId = "";
  let healthyAgentId = "";
  let app: express.Express;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-sidebar-badges-"));
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
      name: "Sidebar Badge Test Company",
      issuePrefix: "SBT",
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

    app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", sidebarBadgeRoutes(db));
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120000);

  it("counts stranded work in inbox without adding a duplicate generic agent-error alert", async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    const twentySixHoursAgo = new Date(now - 26 * 60 * 60 * 1000);

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
        identifier: "SBT-1",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Healthy stale issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: healthyAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 2,
        identifier: "SBT-2",
        startedAt: twoHoursAgo,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Healthy truly stale issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: healthyAgentId,
        createdByAgentId: healthyAgentId,
        issueNumber: 3,
        identifier: "SBT-3",
        startedAt: twentySixHoursAgo,
      },
    ]);

    const res = await request(app).get(`/api/companies/${companyId}/sidebar-badges`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      inbox: 2,
    });
  });
});
