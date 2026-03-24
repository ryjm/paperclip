import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  ensurePostgresDatabase,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { accessService } from "../services/access.js";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-members-route-"));
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

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("members directory route", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const access = accessService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "MDR",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(authUsers).values({
      id: userId,
      name: "Member User",
      email: "member@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date("2026-03-24T00:00:00.000Z"),
      updatedAt: new Date("2026-03-24T00:00:00.000Z"),
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sync Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await access.ensureMembership(companyId, "user", userId, "member", "active");
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");

    return { access, companyId, userId, agentId };
  }

  it("returns hydrated user email data for directory lookups", async () => {
    const { companyId, userId, agentId } = await seedFixture();
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/members`);

    expect(res.status).toBe(200);
    const userMember = res.body.find((member: any) => member.principalId === userId);
    const agentMember = res.body.find((member: any) => member.principalId === agentId);
    expect(userMember).toMatchObject({
      principalType: "user",
      principalId: userId,
      user: {
        id: userId,
        email: "member@example.com",
        name: "Member User",
      },
    });
    expect(agentMember).toMatchObject({
      principalType: "agent",
      principalId: agentId,
      user: null,
    });
  });

  it("allows agent callers with tasks:assign to read the directory", async () => {
    const { access, companyId, agentId } = await seedFixture();
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      null,
    );
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/members`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects agent callers without directory-read access", async () => {
    const { companyId, agentId } = await seedFixture();
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/members`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });
});
