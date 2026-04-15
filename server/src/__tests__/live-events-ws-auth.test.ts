import { createHash, randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizeUpgrade } from "../realtime/live-events-ws.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres live event websocket auth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createUpgradeRequest(token: string) {
  const req = new IncomingMessage(new Socket());
  req.headers = { authorization: `Bearer ${token}` };
  return req;
}

function liveEventsUrl(companyId: string) {
  return new URL(`http://localhost/api/companies/${encodeURIComponent(companyId)}/events/ws`);
}

describeEmbeddedPostgres("live event websocket agent auth", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-ws-auth-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyCounter += 1;
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Live Events Auth ${companyCounter}`,
      issuePrefix: `LWA${companyCounter}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(input: {
    companyId: string;
    status: "active" | "terminated" | "pending_approval";
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: input.status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedKey(input: { companyId: string; agentId: string; revokedAt?: Date | null }) {
    const token = `pc-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: input.agentId,
      companyId: input.companyId,
      name: "test key",
      keyHash: hashToken(token),
      revokedAt: input.revokedAt ?? null,
    });
    return token;
  }

  it("authorizes active agents in the matching company", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, status: "active" });
    const token = await seedKey({ companyId, agentId });

    const context = await authorizeUpgrade(
      db,
      createUpgradeRequest(token),
      companyId,
      liveEventsUrl(companyId),
      { deploymentMode: "authenticated" },
    );

    expect(context).toEqual({
      companyId,
      actorType: "agent",
      actorId: agentId,
    });

    const key = await db
      .select({ lastUsedAt: agentApiKeys.lastUsedAt })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);

    expect(key?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects revoked keys", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, status: "active" });
    const token = await seedKey({ companyId, agentId, revokedAt: new Date() });

    const context = await authorizeUpgrade(
      db,
      createUpgradeRequest(token),
      companyId,
      liveEventsUrl(companyId),
      { deploymentMode: "authenticated" },
    );

    expect(context).toBeNull();
  });

  it("rejects keys from a different company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId, status: "active" });
    const token = await seedKey({ companyId, agentId });

    const context = await authorizeUpgrade(
      db,
      createUpgradeRequest(token),
      otherCompanyId,
      liveEventsUrl(otherCompanyId),
      { deploymentMode: "authenticated" },
    );

    expect(context).toBeNull();
  });

  it("rejects terminated agents even when their key is still active", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, status: "terminated" });
    const token = await seedKey({ companyId, agentId });

    const context = await authorizeUpgrade(
      db,
      createUpgradeRequest(token),
      companyId,
      liveEventsUrl(companyId),
      { deploymentMode: "authenticated" },
    );

    expect(context).toBeNull();
  });

  it("rejects pending approval agents even when their key is still active", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, status: "pending_approval" });
    const token = await seedKey({ companyId, agentId });

    const context = await authorizeUpgrade(
      db,
      createUpgradeRequest(token),
      companyId,
      liveEventsUrl(companyId),
      { deploymentMode: "authenticated" },
    );

    expect(context).toBeNull();
  });
});
