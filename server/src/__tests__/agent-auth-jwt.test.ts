import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const paperclipHomeEnv = "PAPERCLIP_HOME";
  const paperclipInstanceEnv = "PAPERCLIP_INSTANCE_ID";
  const paperclipConfigEnv = "PAPERCLIP_CONFIG";
  const tempDirs: string[] = [];

  async function loadJwtModule() {
    return import("../agent-auth-jwt.js");
  }

  async function writeInstanceEnvFile(instanceId: string, contents: string | null) {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-jwt-"));
    tempDirs.push(paperclipHome);
    process.env[paperclipHomeEnv] = paperclipHome;
    process.env[paperclipInstanceEnv] = instanceId;

    const instanceRoot = path.join(paperclipHome, "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "config.json"), "{}\n", "utf8");
    if (contents !== null) {
      await fs.writeFile(path.join(instanceRoot, ".env"), contents, "utf8");
    }
    return { paperclipHome, instanceRoot };
  }

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    paperclipHome: process.env[paperclipHomeEnv],
    paperclipInstanceId: process.env[paperclipInstanceEnv],
    paperclipConfig: process.env[paperclipConfigEnv],
  };

  beforeEach(() => {
    vi.resetModules();
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    delete process.env[paperclipHomeEnv];
    delete process.env[paperclipInstanceEnv];
    delete process.env[paperclipConfigEnv];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
    if (originalEnv.paperclipHome === undefined) delete process.env[paperclipHomeEnv];
    else process.env[paperclipHomeEnv] = originalEnv.paperclipHome;
    if (originalEnv.paperclipInstanceId === undefined) delete process.env[paperclipInstanceEnv];
    else process.env[paperclipInstanceEnv] = originalEnv.paperclipInstanceId;
    if (originalEnv.paperclipConfig === undefined) delete process.env[paperclipConfigEnv];
    else process.env[paperclipConfigEnv] = originalEnv.paperclipConfig;
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("creates and verifies a token", async () => {
    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
    });
  });

  it("returns null when secret is missing from both env and the Paperclip .env file", async () => {
    process.env[secretEnv] = "";
    delete process.env[betterAuthSecretEnv];
    await writeInstanceEnvFile("jwt-missing", null);
    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", async () => {
    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("falls back to the Paperclip .env file when runtime env omits the JWT secret", async () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    await writeInstanceEnvFile("jwt-dotenv", "PAPERCLIP_AGENT_JWT_SECRET=dotenv-secret\n");

    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "codex_local",
      run_id: "run-1",
    });
  });

  it("falls back to BETTER_AUTH_SECRET in the .env file when PAPERCLIP_AGENT_JWT_SECRET is absent on disk", async () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    await writeInstanceEnvFile("jwt-better-auth", "BETTER_AUTH_SECRET=env-file-fallback\n");

    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");
    expect(typeof token).toBe("string");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.sub).toBe("agent-1");
  });

  it("keeps using the startup Paperclip .env path after PAPERCLIP_CONFIG drifts", async () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    await writeInstanceEnvFile("jwt-stable", "PAPERCLIP_AGENT_JWT_SECRET=stable-secret\n");

    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();

    const driftRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-jwt-drift-"));
    tempDirs.push(driftRoot);
    const driftConfigPath = path.join(driftRoot, "config.json");
    await fs.writeFile(driftConfigPath, "{}\n", "utf8");
    await fs.writeFile(path.join(driftRoot, ".env"), "", "utf8");
    process.env[paperclipConfigEnv] = driftConfigPath;

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "codex_local",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", async () => {
    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", async () => {
    const { createLocalAgentJwt, verifyLocalAgentJwt } = await loadJwtModule();
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
