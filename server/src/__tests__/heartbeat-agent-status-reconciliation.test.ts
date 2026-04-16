import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat reconciliation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat agent status reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  }) {
    const now = new Date("2026-04-16T19:45:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "test",
      status: input.status,
      startedAt: now,
      finishedAt: input.status === "queued" || input.status === "running" ? null : now,
      updatedAt: now,
    });
  }

  it("downgrades stale running agents to idle after a successful run", async () => {
    const { companyId, agentId } = await seedAgent("running");
    await insertRun({ companyId, agentId, status: "succeeded" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("idle");
  });

  it("downgrades stale running agents to error after a failed run", async () => {
    const { companyId, agentId } = await seedAgent("running");
    await insertRun({ companyId, agentId, status: "failed" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("error");
  });

  it("preserves running status when a live run still exists", async () => {
    const { companyId, agentId } = await seedAgent("running");
    await insertRun({ companyId, agentId, status: "running" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("running");
  });
});
