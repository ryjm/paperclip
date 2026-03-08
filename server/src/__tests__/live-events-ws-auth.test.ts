import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
} from "@paperclipai/db";
import { authorizeUpgrade } from "../realtime/live-events-ws.js";

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

describe("live event websocket agent auth", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyCounter = 0;

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-live-events-ws-auth-"));
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
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  async function seedCompany() {
    companyCounter += 1;
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Live Events Auth ${companyCounter}`,
      issuePrefix: `LWA${companyCounter}`,
    });
    return companyId;
  }

  async function seedAgent(opts: {
    companyId: string;
    status: "active" | "terminated" | "pending_approval";
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: opts.companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: opts.status,
      adapterType: "codex_local",
      adapterConfig: {},
    });
    return agentId;
  }

  async function seedKey(opts: { companyId: string; agentId: string; revokedAt?: Date | null }) {
    const token = `pc-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: opts.agentId,
      companyId: opts.companyId,
      name: "test key",
      keyHash: hashToken(token),
      revokedAt: opts.revokedAt ?? null,
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
