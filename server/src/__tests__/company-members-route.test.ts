import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  ensurePostgresDatabase,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describe("company members route", () => {
  let databaseDir = "";
  let storageDir = "";
  let databaseUrl = "";
  let embeddedPostgres: EmbeddedPostgres;
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let companyId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-company-members-route-db-"));
    storageDir = await mkdtemp(join(tmpdir(), "paperclip-company-members-route-storage-"));
    const port = await detectPort(55435);
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
      name: "Company Members Route Test Company",
      issuePrefix: "CMR",
    });

    app = await createApp(db, {
      uiMode: "none",
      storageService: createStorageService(createLocalDiskStorageProvider(storageDir)),
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }, 120_000);

  async function seedAgentToken(permissionKey?: PermissionKey) {
    const agentId = randomUUID();
    const token = `pc-${randomUUID()}`;

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });

    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "test key",
      keyHash: hashToken(token),
    });

    if (permissionKey) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey,
      });
    }

    return { agentId, token };
  }

  async function seedUserMember() {
    const userId = randomUUID();
    const createdAt = new Date();

    await db.insert(authUsers).values({
      id: userId,
      name: "Jane Member",
      email: "jane@example.com",
      emailVerified: true,
      image: null,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    return userId;
  }

  it("allows agents with users:read_directory and returns hydrated user email data", async () => {
    const { agentId, token } = await seedAgentToken("users:read_directory");
    const userId = await seedUserMember();

    const res = await request(app)
      .get(`/api/companies/${companyId}/members`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalType: "user",
          principalId: userId,
          user: {
            id: userId,
            name: "Jane Member",
            email: "jane@example.com",
          },
        }),
        expect.objectContaining({
          principalType: "agent",
          principalId: agentId,
          user: null,
        }),
      ]),
    );
  });

  it("preserves access for agents with users:manage_permissions", async () => {
    const { token } = await seedAgentToken("users:manage_permissions");

    const res = await request(app)
      .get(`/api/companies/${companyId}/members`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("rejects agents without a member-directory grant", async () => {
    const { token } = await seedAgentToken();

    const res = await request(app)
      .get(`/api/companies/${companyId}/members`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Permission denied" });
  });
});
