import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
    await db.delete(issues);
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
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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

    return { companyId, agentId, issuePrefix };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
    errorCode?: string | null;
  }) {
    const now = new Date("2026-04-16T19:45:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "test",
      status: input.status,
      errorCode: input.errorCode ?? null,
      startedAt: now,
      finishedAt: input.status === "queued" || input.status === "running" ? null : now,
      updatedAt: now,
    });
  }

  async function insertIssue(input: {
    companyId: string;
    issuePrefix: string;
    agentId: string;
    status: "todo" | "in_progress" | "in_review" | "blocked";
  }) {
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: input.companyId,
      title: "Actionable assigned work",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber: 1,
      identifier: `${input.issuePrefix}-1`,
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

  it("recovers error agents stranded by an idle process_lost failure", async () => {
    const { companyId, agentId } = await seedAgent("error");
    await insertRun({ companyId, agentId, status: "failed", errorCode: "process_lost" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("idle");
  });

  it("keeps error agents in error when a queued retry still exists", async () => {
    const { companyId, agentId } = await seedAgent("error");
    await insertRun({ companyId, agentId, status: "failed", errorCode: "process_lost" });
    await insertRun({ companyId, agentId, status: "queued" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("error");
  });

  it("keeps error agents in error when they still own actionable work", async () => {
    const { companyId, agentId, issuePrefix } = await seedAgent("error");
    await insertRun({ companyId, agentId, status: "failed", errorCode: "process_lost" });
    await insertIssue({
      companyId,
      issuePrefix,
      agentId,
      status: "in_progress",
    });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("error");
  });

  it("keeps error agents in error for non-process_lost failures", async () => {
    const { companyId, agentId } = await seedAgent("error");
    await insertRun({ companyId, agentId, status: "failed", errorCode: "adapter_crash" });

    const reconciled = await heartbeatService(db).reconcileAgentStatus(agentId);

    expect(reconciled?.status).toBe("error");
  });
});
