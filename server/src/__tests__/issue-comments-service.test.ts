import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comments service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.listComments cursor pagination", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comments-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns older comments for descending cursor pagination", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const oldestCommentId = randomUUID();
    const middleCommentId = randomUUID();
    const newestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cursor pagination issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values([
      {
        id: oldestCommentId,
        companyId,
        issueId,
        body: "oldest",
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: middleCommentId,
        companyId,
        issueId,
        body: "middle",
        createdAt: new Date("2026-04-10T00:00:01.000Z"),
      },
      {
        id: newestCommentId,
        companyId,
        issueId,
        body: "newest",
        createdAt: new Date("2026-04-10T00:00:02.000Z"),
      },
    ]);

    await expect(
      svc.listComments(issueId, {
        afterCommentId: middleCommentId,
        order: "desc",
      }),
    ).resolves.toMatchObject([
      {
        id: oldestCommentId,
        body: "oldest",
      },
    ]);
  });

  it("returns newer comments for ascending cursor pagination", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const oldestCommentId = randomUUID();
    const middleCommentId = randomUUID();
    const newestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cursor pagination issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values([
      {
        id: oldestCommentId,
        companyId,
        issueId,
        body: "oldest",
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: middleCommentId,
        companyId,
        issueId,
        body: "middle",
        createdAt: new Date("2026-04-10T00:00:01.000Z"),
      },
      {
        id: newestCommentId,
        companyId,
        issueId,
        body: "newest",
        createdAt: new Date("2026-04-10T00:00:02.000Z"),
      },
    ]);

    await expect(
      svc.listComments(issueId, {
        afterCommentId: middleCommentId,
        order: "asc",
      }),
    ).resolves.toMatchObject([
      {
        id: newestCommentId,
        body: "newest",
      },
    ]);
  });
});
