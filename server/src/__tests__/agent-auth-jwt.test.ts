import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const homeEnv = "PAPERCLIP_HOME";
  const instanceEnv = "PAPERCLIP_INSTANCE_ID";
  const configEnv = "PAPERCLIP_CONFIG";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    home: process.env[homeEnv],
    instance: process.env[instanceEnv],
    config: process.env[configEnv],
  };

  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-jwt-test-"));
    process.env[homeEnv] = tmpHome;
    process.env[instanceEnv] = "default";
    process.env[configEnv] = path.join(tmpHome, "instances", "default", "config.json");
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
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
    if (originalEnv.home === undefined) delete process.env[homeEnv];
    else process.env[homeEnv] = originalEnv.home;
    if (originalEnv.instance === undefined) delete process.env[instanceEnv];
    else process.env[instanceEnv] = originalEnv.instance;
    if (originalEnv.config === undefined) delete process.env[configEnv];
    else process.env[configEnv] = originalEnv.config;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeInstanceEnvFile(contents: string) {
    const dir = path.join(tmpHome, "instances", "default");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{}\n");
    fs.writeFileSync(path.join(dir, ".env"), contents);
  }

  it("creates and verifies a token", () => {
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

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", () => {
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

  it("falls back to the Paperclip instance .env file when process env has neither secret", () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    writeInstanceEnvFile(`PAPERCLIP_AGENT_JWT_SECRET=env-file-secret\n`);
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

  it("falls back to BETTER_AUTH_SECRET in the .env file when PAPERCLIP_AGENT_JWT_SECRET is absent on disk", () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    writeInstanceEnvFile(`BETTER_AUTH_SECRET=env-file-fallback\n`);
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");
    expect(typeof token).toBe("string");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.sub).toBe("agent-1");
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
