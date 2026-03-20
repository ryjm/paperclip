import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { eq } from "drizzle-orm";
import {
  agentTaskSessions,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { createApp } from "../app.js";
import { issueService } from "../services/issues.js";
import { ensureTaskScopedProjectWorkspace } from "../services/project-run-workspace.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createCommittedRepo(root: string) {
  await mkdir(root, { recursive: true });
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.name", "Paperclip Test"]);
  await runGit(root, ["config", "user.email", "paperclip@example.com"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
  await runGit(root, ["config", "tag.gpgsign", "false"]);
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await writeFile(join(root, "packages", "app", "note.txt"), "clean\n", "utf8");
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "initial"]);
}

function rememberEnv(key: string) {
  return Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] ?? null : undefined;
}

function restoreEnv(key: string, previous: string | null | undefined) {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous ?? "";
}

describe("issue done transition route", () => {
  let databaseDir = "";
  let storageDir = "";
  let databaseUrl = "";
  let embeddedPostgres: EmbeddedPostgres;
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let companyId = "";
  let codeLabelId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-done-route-db-"));
    storageDir = await mkdtemp(join(tmpdir(), "paperclip-issue-done-route-storage-"));
    const port = await detectPort(55434);
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
      name: "Issue Done Transition Route Test Company",
      issuePrefix: "TDR",
    });

    const issues = issueService(db);
    const codeLabel = await issues.createLabel(companyId, {
      name: "code",
      color: "#64748b",
    });
    codeLabelId = codeLabel.id;

    app = await createApp(db, {
      uiMode: "none",
      storageService: createStorageService(createLocalDiskStorageProvider(storageDir)),
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }, 120000);

  async function createCodeIssue() {
    return issueService(db).create(companyId, {
      title: `Code issue ${randomUUID()}`,
      status: "todo",
      priority: "high",
      labelIds: [codeLabelId],
    });
  }

  it("rejects done transitions for code issues without GitHub evidence", async () => {
    const issue = await createCodeIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Implemented locally." });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("latest completion comment must include a GitHub commit or pull request link");
    expect(res.body.details).toMatchObject({
      requiredLabel: "code",
      fallback: {
        nonCode: "Remove the code label before marking done when the task did not require repository changes.",
      },
    });
  });

  it("allows done when the same patch removes the code label", async () => {
    const issue = await createCodeIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", labelIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.labelIds).toEqual([]);
  });

  it("rejects done when commit evidence is local-only (not on remote)", async () => {
    const issue = await createCodeIssue();
    const originalFetch = globalThis.fetch;
    // Mock: commit 404, repo 200 (public) → commit is local-only
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    try {
      const res = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "done",
          comment: "Done in https://github.com/acme/paperclip/commit/deadbeef1234567",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("not reachable on the remote repository");
      expect(res.body.details.remoteVerification).toMatchObject({
        result: "unreachable",
        fix: "git push the branch containing the cited commit, then retry the done transition.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows done without a new comment when the latest existing comment has a GitHub link", async () => {
    const issue = await createCodeIssue();
    await issueService(db).addComment(
      issue.id,
      "Shipped in https://github.com/acme/paperclip/commit/abc1234",
      { userId: "local-board" },
    );

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("cleans task-scoped workspaces and task sessions when a closed issue has no active run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "paperclip-closed-issue-gc-"));
    const repoRoot = join(tempRoot, "repo");
    const projectCwd = join(repoRoot, "packages", "app");
    const paperclipHome = join(tempRoot, "paperclip-home");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "issue-done-route-test";

    try {
      const agentId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Workspace Cleanup Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Workspace Cleanup Project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "repo",
        cwd: projectCwd,
        isPrimary: true,
      });

      const issue = await issueService(db).create(companyId, {
        title: `Workspace cleanup issue ${randomUUID()}`,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        projectId,
      });
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId,
        projectId,
        taskKey: issue.id,
        workspaceId: projectWorkspaceId,
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: issue.id,
        sessionParamsJson: { cwd: workspace.cwd },
        sessionDisplayId: "session-1",
      });

      const res = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done" });

      expect(res.status).toBe(200);
      await expect(readFile(join(workspace.cwd, "note.txt"), "utf8")).rejects.toThrow();
      const remainingSessions = await db
        .select({ id: agentTaskSessions.id })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.taskKey, issue.id));
      expect(remainingSessions).toEqual([]);
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips closed-issue workspace cleanup while an execution run is still active", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "paperclip-closed-issue-active-run-"));
    const repoRoot = join(tempRoot, "repo");
    const projectCwd = join(repoRoot, "packages", "app");
    const paperclipHome = join(tempRoot, "paperclip-home");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "issue-done-route-test";

    try {
      const agentId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const runId = randomUUID();

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Workspace Cleanup Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Workspace Cleanup Project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "repo",
        cwd: projectCwd,
        isPrimary: true,
      });

      const issue = await issueService(db).create(companyId, {
        title: `Workspace cleanup issue ${randomUUID()}`,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        projectId,
      });
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId,
        projectId,
        taskKey: issue.id,
        workspaceId: projectWorkspaceId,
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: issue.id,
        sessionParamsJson: { cwd: workspace.cwd },
        sessionDisplayId: "session-1",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: issue.id, taskKey: issue.id },
      });
      await db
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionRunId: runId,
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      const res = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done" });

      expect(res.status).toBe(200);
      await expect(readFile(join(workspace.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      const remainingSessions = await db
        .select({ id: agentTaskSessions.id })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.taskKey, issue.id));
      expect(remainingSessions).toHaveLength(1);
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
