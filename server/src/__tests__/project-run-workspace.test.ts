import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { ensureTaskScopedProjectWorkspace } from "../services/project-run-workspace.js";

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
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await writeFile(path.join(root, "packages", "app", "note.txt"), "clean\n", "utf8");
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

describe("ensureTaskScopedProjectWorkspace", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a task-scoped git worktree and leaves dirty shared changes behind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-worktree-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = path.join(root, "repo");
    const projectCwd = path.join(repoRoot, "packages", "app");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);
    await writeFile(path.join(projectCwd, "note.txt"), "dirty shared change\n", "utf8");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(workspace.mode).toBe("git_worktree");
      expect(workspace.cwd).toContain(resolveDefaultAgentWorkspaceDir("agent-1"));
      expect(workspace.cwd).not.toBe(projectCwd);
      await expect(readFile(path.join(workspace.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      expect(workspace.warnings.join("\n")).toContain("uncommitted change(s)");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("reuses the same task-scoped git worktree for later heartbeats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-worktree-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = path.join(root, "repo");
    const projectCwd = path.join(repoRoot, "packages", "app");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const first = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      await writeFile(path.join(first.cwd, "note.txt"), "task-local change\n", "utf8");

      const second = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(second.cwd).toBe(first.cwd);
      await expect(readFile(path.join(second.cwd, "note.txt"), "utf8")).resolves.toBe(
        "task-local change\n",
      );
      await expect(readFile(path.join(projectCwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      expect(second.warnings).toEqual([]);
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("creates separate worktrees for different task keys against the same project workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-worktree-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = path.join(root, "repo");
    const projectCwd = path.join(repoRoot, "packages", "app");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const issueOne = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });
      const issueTwo = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-2",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(issueOne.cwd).not.toBe(issueTwo.cwd);

      await writeFile(path.join(issueOne.cwd, "note.txt"), "issue one diff\n", "utf8");

      await expect(readFile(path.join(issueOne.cwd, "note.txt"), "utf8")).resolves.toBe(
        "issue one diff\n",
      );
      await expect(readFile(path.join(issueTwo.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("copies non-git project directories into task-scoped workspaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-copy-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const projectCwd = path.join(root, "workspace");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await mkdir(projectCwd, { recursive: true });
    await writeFile(path.join(projectCwd, "note.txt"), "clean\n", "utf8");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(workspace.mode).toBe("directory_copy");
      expect(workspace.cwd).not.toBe(projectCwd);
      await writeFile(path.join(projectCwd, "note.txt"), "source changed\n", "utf8");
      await expect(readFile(path.join(workspace.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      expect(workspace.warnings.join("\n")).toContain("not auto-synced back");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });
});
