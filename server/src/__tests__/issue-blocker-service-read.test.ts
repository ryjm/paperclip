import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker read tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker-aware reads", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-read-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("includes blocker relation summaries in getById and getByIdentifier reads", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "high",
    });
    const blocked = await svc.create(companyId, {
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
    });

    await svc.update(blocked.id, {
      blockedByIssueIds: [blocker.id],
    });

    await expect(svc.getById(blocked.id)).resolves.toMatchObject({
      id: blocked.id,
      blockedBy: [
        expect.objectContaining({
          id: blocker.id,
          identifier: blocker.identifier,
        }),
      ],
      blocks: [],
    });
    await expect(svc.getByIdentifier(blocked.identifier)).resolves.toMatchObject({
      id: blocked.id,
      blockedBy: [
        expect.objectContaining({
          id: blocker.id,
          identifier: blocker.identifier,
        }),
      ],
      blocks: [],
    });
    await expect(svc.getById(blocker.id)).resolves.toMatchObject({
      id: blocker.id,
      blockedBy: [],
      blocks: [
        expect.objectContaining({
          id: blocked.id,
          identifier: blocked.identifier,
        }),
      ],
    });
  });
});
