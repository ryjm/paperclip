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
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
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

async function createCommittedRepoWithLocalOrigin(root: string) {
  const upstreamRoot = path.join(root, "upstream.git");
  const repoRoot = path.join(root, "repo");
  await mkdir(root, { recursive: true });
  await runGit(root, ["init", "--bare", upstreamRoot]);
  await runGit(root, ["clone", upstreamRoot, repoRoot]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "tag.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "packages", "app"), { recursive: true });
  await writeFile(path.join(repoRoot, "packages", "app", "note.txt"), "clean\n", "utf8");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
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

  it("two agents working on the same project get isolated worktrees that cannot overwrite each other (GRA-1301)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-concurrent-isolation-"));
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
      const agentA = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-a",
        projectId: "project-1",
        taskKey: "issue-100",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });
      const agentB = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-b",
        projectId: "project-1",
        taskKey: "issue-200",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(agentA.cwd).not.toBe(agentB.cwd);
      expect(agentA.cwd).not.toBe(projectCwd);
      expect(agentB.cwd).not.toBe(projectCwd);

      await writeFile(path.join(agentA.cwd, "note.txt"), "agent-a change\n", "utf8");
      await expect(readFile(path.join(agentB.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      await expect(readFile(path.join(projectCwd, "note.txt"), "utf8")).resolves.toBe("clean\n");

      await writeFile(path.join(agentB.cwd, "note.txt"), "agent-b change\n", "utf8");
      await expect(readFile(path.join(agentA.cwd, "note.txt"), "utf8")).resolves.toBe(
        "agent-a change\n",
      );
      await expect(readFile(path.join(projectCwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("surfaces a warning when the shared checkout has an interrupted rebase (GRA-1362)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-rebase-detect-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = path.join(root, "repo");
    const projectCwd = path.join(repoRoot, "packages", "app");
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    await createCommittedRepo(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "conflict-branch"]);
    await writeFile(path.join(repoRoot, "packages", "app", "note.txt"), "branch version\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "branch change"]);
    await runGit(repoRoot, ["checkout", "master"]);
    await writeFile(path.join(repoRoot, "packages", "app", "note.txt"), "main version\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "main change"]);

    try {
      await runGit(repoRoot, ["rebase", "conflict-branch"]);
    } catch {
      // Expected to fail with conflict.
    }

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-rebase",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(workspace.mode).toBe("git_worktree");
      expect(workspace.cwd).not.toBe(projectCwd);

      const allWarnings = workspace.warnings.join("\n");
      expect(allWarnings).toContain("interrupted rebase");
      expect(allWarnings).toContain("isolated worktree is unaffected");
    } finally {
      try {
        await runGit(repoRoot, ["rebase", "--abort"]);
      } catch {
        // Ignore cleanup failures in test teardown.
      }
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("uses an isolated git clone when the tracked repoUrl differs from the shared origin (GRA-1926)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-clone-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = await createCommittedRepoWithLocalOrigin(path.join(root, "source"));
    const projectCwd = path.join(repoRoot, "packages", "app");
    const trackedRepoUrl = "https://github.com/ryjm/tabula.git";
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: trackedRepoUrl,
        repoRef: "main",
      });

      expect(workspace.mode).toBe("git_clone");
      expect(workspace.cwd).toContain(resolveDefaultAgentWorkspaceDir("agent-1"));
      expect(workspace.cwd).not.toBe(projectCwd);
      await expect(readFile(path.join(workspace.cwd, "note.txt"), "utf8")).resolves.toBe("clean\n");

      const checkoutRoot = path.join(workspace.rootDir, "repo");
      const originUrl = await runGit(checkoutRoot, ["config", "--get", "remote.origin.url"]);
      const branchName = await runGit(checkoutRoot, ["branch", "--show-current"]);
      const branchStatus = await runGit(checkoutRoot, ["status", "--short", "--branch"]);

      expect(originUrl).toBe(trackedRepoUrl);
      expect(branchStatus).toContain(`## ${branchName}...origin/${branchName} [gone]`);
      expect(workspace.warnings.join("\n")).toContain("isolated git clone");
      expect(workspace.warnings.join("\n")).toContain("does not match tracked repo");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("reuses the same isolated git clone for later heartbeats when the shared origin is mismatched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-task-clone-reuse-"));
    tempRoots.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const repoRoot = await createCommittedRepoWithLocalOrigin(path.join(root, "source"));
    const projectCwd = path.join(repoRoot, "packages", "app");
    const trackedRepoUrl = "https://github.com/ryjm/tabula.git";
    const previousHome = rememberEnv("PAPERCLIP_HOME");
    const previousInstance = rememberEnv("PAPERCLIP_INSTANCE_ID");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "workspace-test";

    try {
      const first = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: trackedRepoUrl,
        repoRef: "main",
      });

      expect(first.mode).toBe("git_clone");
      await writeFile(path.join(first.cwd, "note.txt"), "task-local change\n", "utf8");

      const second = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-1",
        projectId: "project-1",
        taskKey: "issue-1",
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: trackedRepoUrl,
        repoRef: "main",
      });

      expect(second.mode).toBe("git_clone");
      expect(second.cwd).toBe(first.cwd);
      await expect(readFile(path.join(second.cwd, "note.txt"), "utf8")).resolves.toBe(
        "task-local change\n",
      );
      await expect(readFile(path.join(projectCwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
      await expect(runGit(path.join(second.rootDir, "repo"), ["config", "--get", "remote.origin.url"])).resolves.toBe(
        trackedRepoUrl,
      );
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });

  it("an agent without a task key still gets an isolated worktree, not the shared checkout (GRA-1301)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-no-taskkey-isolation-"));
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
      const workspace = await ensureTaskScopedProjectWorkspace({
        agentId: "agent-idle",
        projectId: "project-1",
        taskKey: null,
        workspaceId: "workspace-1",
        projectCwd,
        repoUrl: null,
        repoRef: null,
      });

      expect(workspace.mode).toBe("git_worktree");
      expect(workspace.cwd).not.toBe(projectCwd);

      await writeFile(path.join(workspace.cwd, "note.txt"), "idle agent change\n", "utf8");
      await expect(readFile(path.join(projectCwd, "note.txt"), "utf8")).resolves.toBe("clean\n");
    } finally {
      restoreEnv("PAPERCLIP_HOME", previousHome);
      restoreEnv("PAPERCLIP_INSTANCE_ID", previousInstance);
    }
  });
});
