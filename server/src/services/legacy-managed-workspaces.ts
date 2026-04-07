import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, projectWorkspaces } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFile = promisify(execFileCallback);
const LEGACY_WORKSPACE_METADATA_FILENAME = "paperclip-workspace.json";
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

type LegacyManagedWorkspaceMetadata = {
  mode: string | null;
  taskKey: string | null;
  sourceRepoRoot: string | null;
  branchName: string | null;
};

export type LegacyManagedWorkspaceCleanupResult = {
  scannedMetadataFiles: number;
  matchedIssueWorkspaces: number;
  removedWorkspaces: number;
  prunedIssueBranches: number;
  skippedActiveBranches: number;
  skippedNonTerminal: number;
  skippedMissingIssue: number;
  warnings: string[];
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function withinDir(candidate: string, root: string) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function listLegacyWorkspaceMetadataFiles(rootDir: string) {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === LEGACY_WORKSPACE_METADATA_FILENAME) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

async function readLegacyWorkspaceMetadata(metadataPath: string) {
  const raw = await fs.readFile(metadataPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const metadata: LegacyManagedWorkspaceMetadata = {
    mode: readNonEmptyString(parsed.mode),
    taskKey: readNonEmptyString(parsed.taskKey),
    sourceRepoRoot: readNonEmptyString(parsed.sourceRepoRoot),
    branchName: readNonEmptyString(parsed.branchName),
  };
  return metadata;
}

async function runGit(cwd: string, args: string[]) {
  try {
    await execFile("git", args, {
      cwd,
      encoding: "utf8",
    });
    return null;
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
    };
    const stdout = typeof err.stdout === "string" ? err.stdout.trim() : "";
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    return stderr || stdout || err.message || String(error);
  }
}

async function readGitOutput(cwd: string, args: string[]) {
  try {
    const result = await execFile("git", args, {
      cwd,
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function branchMatchesIssueIdentifier(branchName: string, identifier: string) {
  const normalizedIdentifier = readNonEmptyString(identifier)?.toLowerCase();
  if (!normalizedIdentifier) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedIdentifier)}([^a-z0-9]|$)`, "i")
    .test(branchName);
}

async function resolveGitRepoRoot(cwd: string) {
  const repoRoot = await readGitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  return repoRoot ? path.resolve(repoRoot) : null;
}

async function gitRefExists(cwd: string, ref: string) {
  return (await readGitOutput(cwd, ["rev-parse", "--verify", "--quiet", ref])) !== null;
}

async function resolvePreferredBaseRef(cwd: string, preferredRef: string | null) {
  const candidates = [
    readNonEmptyString(preferredRef),
    await readGitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    "main",
    await readGitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]
    .map((value) => readNonEmptyString(value))
    .filter((value, index, values): value is string => value !== null && values.indexOf(value) === index);

  for (const candidate of candidates) {
    if (await gitRefExists(cwd, candidate)) {
      return candidate;
    }
  }

  return null;
}

async function branchMergedIntoRef(cwd: string, branchName: string, baseRef: string) {
  try {
    await execFile("git", ["merge-base", "--is-ancestor", branchName, baseRef], {
      cwd,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

async function listLocalBranches(cwd: string) {
  const output = await readGitOutput(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function listActiveWorktreeBranches(cwd: string) {
  const output = await readGitOutput(cwd, ["worktree", "list", "--porcelain"]);
  if (!output) return new Set<string>();

  const branches = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("branch ")) continue;
    const ref = trimmed.slice("branch ".length).trim();
    const branchName = ref.replace(/^refs\/heads\//, "");
    if (branchName) branches.add(branchName);
  }
  return branches;
}

async function pruneTerminalIssueBranches(input: {
  db: Db;
  issueIds: Set<string>;
}) {
  const warnings: string[] = [];
  const terminalStatuses = [...TERMINAL_ISSUE_STATUSES];
  const issueRows = input.issueIds.size > 0
    ? await input.db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(inArray(issues.id, [...input.issueIds]))
    : await input.db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.status, terminalStatuses),
            isNotNull(issues.identifier),
            isNotNull(issues.projectId),
          ),
        );

  const terminalIssues = issueRows.filter(
    (row): row is typeof row & { identifier: string; projectId: string } =>
      TERMINAL_ISSUE_STATUSES.has(row.status) &&
      readNonEmptyString(row.identifier) !== null &&
      readNonEmptyString(row.projectId) !== null,
  );
  if (terminalIssues.length === 0) {
    return {
      prunedIssueBranches: 0,
      skippedActiveBranches: 0,
      warnings,
    };
  }

  const projectIds = [...new Set(terminalIssues.map((row) => row.projectId))];
  const projectWorkspaceRows = await input.db
    .select({
      projectId: projectWorkspaces.projectId,
      cwd: projectWorkspaces.cwd,
      repoRef: projectWorkspaces.repoRef,
      defaultRef: projectWorkspaces.defaultRef,
      isPrimary: projectWorkspaces.isPrimary,
      createdAt: projectWorkspaces.createdAt,
      id: projectWorkspaces.id,
    })
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));

  const repoInfoByProjectId = new Map<string, { repoRoot: string; baseRef: string | null }>();
  for (const workspace of projectWorkspaceRows) {
    if (repoInfoByProjectId.has(workspace.projectId)) continue;
    const cwd = readNonEmptyString(workspace.cwd);
    if (!cwd) continue;
    const repoRoot = await resolveGitRepoRoot(cwd);
    if (!repoRoot) continue;
    const baseRef = await resolvePreferredBaseRef(
      repoRoot,
      readNonEmptyString(workspace.defaultRef) ?? readNonEmptyString(workspace.repoRef),
    );
    repoInfoByProjectId.set(workspace.projectId, { repoRoot, baseRef });
  }

  const issuesByRepoRoot = new Map<string, Array<{ identifier: string }>>();
  for (const issue of terminalIssues) {
    const repoInfo = repoInfoByProjectId.get(issue.projectId);
    if (!repoInfo) continue;
    const existing = issuesByRepoRoot.get(repoInfo.repoRoot);
    if (existing) existing.push({ identifier: issue.identifier });
    else issuesByRepoRoot.set(repoInfo.repoRoot, [{ identifier: issue.identifier }]);
  }

  let prunedIssueBranches = 0;
  let skippedActiveBranches = 0;

  for (const [repoRoot, repoIssues] of issuesByRepoRoot.entries()) {
    const localBranches = await listLocalBranches(repoRoot);
    if (localBranches.length === 0) continue;

    const activeWorktreeBranches = await listActiveWorktreeBranches(repoRoot);
    const baseRef = repoIssues.length > 0
      ? [...repoInfoByProjectId.values()].find((candidate) => candidate.repoRoot === repoRoot)?.baseRef ?? null
      : null;
    const handledBranches = new Set<string>();

    for (const issue of repoIssues) {
      for (const branchName of localBranches) {
        if (handledBranches.has(branchName)) continue;
        if (!branchMatchesIssueIdentifier(branchName, issue.identifier)) continue;
        handledBranches.add(branchName);

        if (activeWorktreeBranches.has(branchName)) {
          skippedActiveBranches += 1;
          continue;
        }

        if (baseRef && !(await branchMergedIntoRef(repoRoot, branchName, baseRef))) {
          continue;
        }

        const branchDeleteError = await runGit(repoRoot, ["branch", "-d", branchName]);
        if (branchDeleteError) {
          warnings.push(
            `Failed to delete stale issue branch "${branchName}" for "${issue.identifier}": ${branchDeleteError}`,
          );
          continue;
        }
        prunedIssueBranches += 1;
      }
    }
  }

  return {
    prunedIssueBranches,
    skippedActiveBranches,
    warnings,
  };
}

async function cleanupLegacyWorkspaceRoot(input: {
  metadataPath: string;
  metadata: LegacyManagedWorkspaceMetadata;
}) {
  const warnings: string[] = [];
  const workspaceRoot = path.dirname(input.metadataPath);
  const workspacesRoot = path.join(resolvePaperclipInstanceRoot(), "workspaces");

  if (
    !withinDir(workspaceRoot, workspacesRoot) ||
    !workspaceRoot.includes(`${path.sep}project-workspaces${path.sep}`)
  ) {
    warnings.push(`Refusing to remove legacy workspace outside managed root: ${workspaceRoot}`);
    return { removed: false, warnings };
  }

  const repoCheckoutRoot = path.join(workspaceRoot, "repo");
  const repoCheckoutExists = await fs
    .stat(repoCheckoutRoot)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const repoRoot = input.metadata.sourceRepoRoot;

  if (input.metadata.mode === "git_worktree" && repoCheckoutExists) {
    if (repoRoot) {
      const worktreeRemoveError = await runGit(repoRoot, ["worktree", "remove", "--force", repoCheckoutRoot]);
      if (worktreeRemoveError) {
        warnings.push(`Failed to remove legacy git worktree "${repoCheckoutRoot}": ${worktreeRemoveError}`);
      }
      const worktreePruneError = await runGit(repoRoot, ["worktree", "prune"]);
      if (worktreePruneError) {
        warnings.push(`Failed to prune legacy git worktrees for "${repoRoot}": ${worktreePruneError}`);
      }
      if (input.metadata.branchName) {
        const branchDeleteError = await runGit(repoRoot, ["branch", "-d", input.metadata.branchName]);
        if (branchDeleteError) {
          warnings.push(`Failed to delete legacy branch "${input.metadata.branchName}": ${branchDeleteError}`);
        }
      }
    } else {
      warnings.push(`Legacy git worktree metadata at "${input.metadataPath}" is missing sourceRepoRoot.`);
    }
  }

  await fs.rm(workspaceRoot, { recursive: true, force: true });
  const removed = !(await fs
    .stat(workspaceRoot)
    .then(() => true)
    .catch(() => false));

  return {
    removed,
    warnings,
  };
}

export async function cleanupLegacyManagedProjectWorkspaces(input: {
  db: Db;
  issueIds?: string[] | null;
}): Promise<LegacyManagedWorkspaceCleanupResult> {
  const legacyRoot = path.join(resolvePaperclipInstanceRoot(), "workspaces");
  const issueFilter = new Set(
    (input.issueIds ?? [])
      .map((value) => readNonEmptyString(value))
      .filter((value): value is string => value !== null),
  );

  const metadataFiles = await listLegacyWorkspaceMetadataFiles(legacyRoot).catch(() => []);
  const entries: Array<{
    metadataPath: string;
    metadata: LegacyManagedWorkspaceMetadata;
  }> = [];
  const warnings: string[] = [];

  for (const metadataPath of metadataFiles) {
    try {
      const metadata = await readLegacyWorkspaceMetadata(metadataPath);
      if (!metadata.taskKey) {
        warnings.push(`Legacy workspace metadata missing taskKey: ${metadataPath}`);
        continue;
      }
      if (issueFilter.size > 0 && !issueFilter.has(metadata.taskKey)) {
        continue;
      }
      entries.push({ metadataPath, metadata });
    } catch (error) {
      warnings.push(
        `Failed to read legacy workspace metadata "${metadataPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const issueIds = Array.from(new Set(entries.map((entry) => entry.metadata.taskKey!)));
  const issueRows = issueIds.length > 0
    ? await input.db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(inArray(issues.id, issueIds))
    : [];
  const issueStatusById = new Map(issueRows.map((row) => [row.id, row.status]));

  let removedWorkspaces = 0;
  let prunedIssueBranches = 0;
  let skippedActiveBranches = 0;
  let skippedNonTerminal = 0;
  let skippedMissingIssue = 0;

  for (const entry of entries) {
    const status = issueStatusById.get(entry.metadata.taskKey!);
    if (!status) {
      skippedMissingIssue += 1;
      warnings.push(`Legacy workspace references missing issue "${entry.metadata.taskKey}" (${entry.metadataPath}).`);
      continue;
    }
    if (!TERMINAL_ISSUE_STATUSES.has(status)) {
      skippedNonTerminal += 1;
      continue;
    }

    const cleanup = await cleanupLegacyWorkspaceRoot(entry);
    warnings.push(...cleanup.warnings);
    if (cleanup.removed) {
      removedWorkspaces += 1;
    }
  }

  const branchSweep = await pruneTerminalIssueBranches({
    db: input.db,
    issueIds: issueFilter,
  });
  prunedIssueBranches = branchSweep.prunedIssueBranches;
  skippedActiveBranches = branchSweep.skippedActiveBranches;
  warnings.push(...branchSweep.warnings);

  return {
    scannedMetadataFiles: metadataFiles.length,
    matchedIssueWorkspaces: entries.length,
    removedWorkspaces,
    prunedIssueBranches,
    skippedActiveBranches,
    skippedNonTerminal,
    skippedMissingIssue,
    warnings,
  };
}
