import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, issues, projectWorkspaces, projects, workspaceRuntimeServices } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-service-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("projectService local git state", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-service-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 20_000);

  it("hydrates local checkout git state separately from configured remote refs", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);

    await runGit(repoRoot, ["checkout", "-b", "feature/local-git-state"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\nfeature commit\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Feature commit"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\nfeature commit\nworking tree change\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "untracked\n", "utf8");

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const project = await svc.create(companyId, {
      name: "Workspace Git State",
      status: "in_progress",
    });
    await svc.createWorkspace(project.id, {
      name: "Main checkout",
      sourceType: "local_path",
      cwd: repoRoot,
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: true,
    });

    const hydratedProject = await svc.getById(project.id);
    const listedWorkspaces = await svc.listWorkspaces(project.id);

    expect(hydratedProject?.primaryWorkspace?.repoRef).toBe("main");
    expect(hydratedProject?.primaryWorkspace?.defaultRef).toBe("main");
    expect(hydratedProject?.primaryWorkspace?.localGitState).toMatchObject({
      repoRoot: path.resolve(repoRoot),
      workspacePath: path.resolve(repoRoot),
      branchName: "feature/local-git-state",
      trackedRef: "main",
      hasDirtyTrackedFiles: true,
      hasUntrackedFiles: true,
      dirtyEntryCount: 1,
      untrackedEntryCount: 1,
      aheadCount: 1,
      behindCount: 0,
    });
    expect(listedWorkspaces[0]?.localGitState).toMatchObject({
      branchName: "feature/local-git-state",
      trackedRef: "main",
      dirtyEntryCount: 1,
      untrackedEntryCount: 1,
      aheadCount: 1,
      behindCount: 0,
    });
  }, 20_000);

  it("falls back to null git state for non-git local paths", async () => {
    const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-non-git-"));
    tempDirs.add(localPath);
    await fs.writeFile(path.join(localPath, "notes.txt"), "hello\n", "utf8");

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const project = await svc.create(companyId, {
      name: "Non Git Workspace",
      status: "planned",
    });
    await svc.createWorkspace(project.id, {
      name: "Notes folder",
      sourceType: "non_git_path",
      cwd: localPath,
      isPrimary: true,
    });

    const hydratedProject = await svc.getById(project.id);
    const listedWorkspaces = await svc.listWorkspaces(project.id);

    expect(hydratedProject?.primaryWorkspace?.localGitState).toBeNull();
    expect(listedWorkspaces[0]?.localGitState).toBeNull();
  });
});
