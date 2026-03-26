import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { issues, projectWorkspaces } from "@paperclipai/db";
import { cleanupLegacyManagedProjectWorkspaces } from "../services/legacy-managed-workspaces.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function gitStdout(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createTempRepo(input?: {
  defaultBranch?: string;
}) {
  const defaultBranch = input?.defaultBranch ?? "main";
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-legacy-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

function createDbDouble(issueRows: Array<{ id: string; status: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: async () => issueRows,
      }),
    }),
  } as unknown as Db;
}

function createBranchSweepDbDouble(input: {
  issueRows: Array<{
    id: string;
    identifier: string;
    status: string;
    projectId: string;
  }>;
  projectWorkspaceRows: Array<{
    projectId: string;
    cwd: string | null;
    repoRef?: string | null;
    defaultRef?: string | null;
  }>;
}) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === issues) {
            return Promise.resolve(input.issueRows);
          }
          if (table === projectWorkspaces) {
            return {
              orderBy: async () => input.projectWorkspaceRows.map((row, index) => ({
                projectId: row.projectId,
                cwd: row.cwd,
                repoRef: row.repoRef ?? null,
                defaultRef: row.defaultRef ?? null,
                isPrimary: index === 0,
                createdAt: new Date(index),
                id: `project-workspace-${index + 1}`,
              })),
            };
          }
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;
}

async function createLegacyGitWorkspace(input?: {
  issueId?: string;
  branchName?: string;
  baseRef?: string;
}) {
  const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-legacy-worktree-home-"));
  const baseRef = input?.baseRef ?? "main";
  const repoRoot = await createTempRepo({ defaultBranch: baseRef });
  const issueId = input?.issueId ?? "issue-1";
  const branchName = input?.branchName ?? "paperclip/test/issue-1";
  const workspaceRoot = path.join(
    paperclipHome,
    "instances",
    "test-instance",
    "workspaces",
    "agent-1",
    "project-workspaces",
    "project-1",
    issueId,
    "workspace-1",
  );
  const repoCheckoutRoot = path.join(workspaceRoot, "repo");

  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

  await fs.mkdir(workspaceRoot, { recursive: true });
  await runGit(repoRoot, ["worktree", "add", "-b", branchName, repoCheckoutRoot, baseRef]);
  await fs.writeFile(
    path.join(workspaceRoot, "paperclip-workspace.json"),
    JSON.stringify(
      {
        mode: "git_worktree",
        taskKey: issueId,
        sourceRepoRoot: repoRoot,
        branchName,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    paperclipHome,
    repoRoot,
    issueId,
    branchName,
    workspaceRoot,
    repoCheckoutRoot,
  };
}

async function createStaleIssueBranchFixture(input: {
  branchName: string;
  baseRef?: string;
  currentRef?: string;
}) {
  const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-legacy-worktree-home-"));
  const baseRef = input.baseRef ?? "main";
  const repoRoot = await createTempRepo({ defaultBranch: baseRef });

  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

  await runGit(repoRoot, ["branch", input.branchName, baseRef]);
  if (input.currentRef) {
    await runGit(repoRoot, ["checkout", "-b", input.currentRef, baseRef]);
  }

  return {
    paperclipHome,
    repoRoot,
    branchName: input.branchName,
  };
}

describe("cleanupLegacyManagedProjectWorkspaces", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all(
      [...cleanupDirs].map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
        cleanupDirs.delete(dir);
      }),
    );
  });

  it("removes a legacy git worktree and prunes its merged branch for terminal issues", async () => {
    const fixture = await createLegacyGitWorkspace({
      issueId: "issue-done",
      branchName: "paperclip/test/issue-done",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createDbDouble([{ id: fixture.issueId, status: "done" }]),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 1,
      matchedIssueWorkspaces: 1,
      removedWorkspaces: 1,
      skippedNonTerminal: 0,
      skippedMissingIssue: 0,
      warnings: [],
    });
    await expect(fs.stat(fixture.workspaceRoot)).rejects.toThrow();
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toBe("");
  });

  it("leaves legacy workspaces alone when the linked issue is not terminal", async () => {
    const fixture = await createLegacyGitWorkspace({
      issueId: "issue-blocked",
      branchName: "paperclip/test/issue-blocked",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createDbDouble([{ id: fixture.issueId, status: "blocked" }]),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 1,
      matchedIssueWorkspaces: 1,
      removedWorkspaces: 0,
      skippedNonTerminal: 1,
      skippedMissingIssue: 0,
      warnings: [],
    });
    await expect(fs.stat(fixture.workspaceRoot)).resolves.toBeTruthy();
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toContain(fixture.branchName);
  });

  it("skips nested repo metadata while scanning legacy workspaces", async () => {
    const fixture = await createLegacyGitWorkspace({
      issueId: "issue-nested",
      branchName: "paperclip/test/issue-nested",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    await fs.writeFile(
      path.join(fixture.repoCheckoutRoot, "paperclip-workspace.json"),
      JSON.stringify({ taskKey: "nested-issue" }, null, 2),
      "utf8",
    );

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createDbDouble([{ id: fixture.issueId, status: "blocked" }]),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 1,
      matchedIssueWorkspaces: 1,
      removedWorkspaces: 0,
      skippedNonTerminal: 1,
      skippedMissingIssue: 0,
      warnings: [],
    });
  });

  it("warns and keeps unmerged legacy branches instead of force deleting them", async () => {
    const fixture = await createLegacyGitWorkspace({
      issueId: "issue-unmerged",
      branchName: "paperclip/test/issue-unmerged",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    await fs.writeFile(path.join(fixture.repoCheckoutRoot, "feature.txt"), "keep me\n", "utf8");
    await runGit(fixture.repoCheckoutRoot, ["add", "feature.txt"]);
    await runGit(fixture.repoCheckoutRoot, ["commit", "-m", "Keep unmerged branch"]);

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createDbDouble([{ id: fixture.issueId, status: "done" }]),
    });

    expect(result.scannedMetadataFiles).toBe(1);
    expect(result.matchedIssueWorkspaces).toBe(1);
    expect(result.removedWorkspaces).toBe(1);
    expect(result.skippedNonTerminal).toBe(0);
    expect(result.skippedMissingIssue).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`Failed to delete legacy branch "${fixture.branchName}"`),
    );
    await expect(fs.stat(fixture.workspaceRoot)).rejects.toThrow();
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toContain(fixture.branchName);
  });

  it("prunes stale terminal-issue branches even after the legacy workspace metadata is already gone", async () => {
    const fixture = await createStaleIssueBranchFixture({
      branchName: "gra-993-branch-drift-guardrail-main",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createBranchSweepDbDouble({
        issueRows: [
          {
            id: "issue-done",
            identifier: "GRA-993",
            status: "done",
            projectId: "project-1",
          },
        ],
        projectWorkspaceRows: [
          {
            projectId: "project-1",
            cwd: fixture.repoRoot,
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 0,
      matchedIssueWorkspaces: 0,
      removedWorkspaces: 0,
      prunedIssueBranches: 1,
      skippedActiveBranches: 0,
      skippedNonTerminal: 0,
      skippedMissingIssue: 0,
      warnings: [],
    });
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toBe("");
  });

  it("falls back to master when pruning stale branches from repos without origin HEAD metadata", async () => {
    const fixture = await createStaleIssueBranchFixture({
      branchName: "gra-1096-master-fallback-cleanup",
      baseRef: "master",
      currentRef: "feature/current-work",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createBranchSweepDbDouble({
        issueRows: [
          {
            id: "issue-master",
            identifier: "GRA-1096",
            status: "done",
            projectId: "project-1",
          },
        ],
        projectWorkspaceRows: [
          {
            projectId: "project-1",
            cwd: fixture.repoRoot,
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 0,
      matchedIssueWorkspaces: 0,
      removedWorkspaces: 0,
      prunedIssueBranches: 1,
      skippedActiveBranches: 0,
      skippedNonTerminal: 0,
      skippedMissingIssue: 0,
      warnings: [],
    });
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toBe("");
  });

  it("skips pruning branches that are still attached to an active worktree", async () => {
    const fixture = await createLegacyGitWorkspace({
      issueId: "issue-active",
      branchName: "gra-928-active-task-main",
    });
    cleanupDirs.add(fixture.paperclipHome);
    cleanupDirs.add(fixture.repoRoot);

    await fs.rm(path.join(fixture.workspaceRoot, "paperclip-workspace.json"), { force: true });

    const result = await cleanupLegacyManagedProjectWorkspaces({
      db: createBranchSweepDbDouble({
        issueRows: [
          {
            id: "issue-active",
            identifier: "GRA-928",
            status: "done",
            projectId: "project-1",
          },
        ],
        projectWorkspaceRows: [
          {
            projectId: "project-1",
            cwd: fixture.repoRoot,
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      scannedMetadataFiles: 0,
      matchedIssueWorkspaces: 0,
      removedWorkspaces: 0,
      prunedIssueBranches: 0,
      skippedActiveBranches: 1,
      skippedNonTerminal: 0,
      skippedMissingIssue: 0,
      warnings: [],
    });
    await expect(fs.stat(fixture.repoCheckoutRoot)).resolves.toBeTruthy();
    expect(await gitStdout(fixture.repoRoot, ["branch", "--list", fixture.branchName])).toContain(fixture.branchName);
  });
});
