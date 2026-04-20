import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalWorkspaceGitState } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function tryReadGitOutput(cwd: string, args: string[]) {
  try {
    const { stdout } = await runGit(args, cwd);
    return readNonEmptyString(stdout);
  } catch {
    return null;
  }
}

export async function inspectLocalWorkspaceGitState(input: {
  workspacePath: string | null | undefined;
  trackedRef?: string | null;
}): Promise<{ gitState: LocalWorkspaceGitState | null; warnings: string[] }> {
  const warnings: string[] = [];
  const workspacePath = readNonEmptyString(input.workspacePath);

  if (!workspacePath) {
    return { gitState: null, warnings };
  }

  if (!(await pathExists(workspacePath))) {
    warnings.push(`Workspace path "${workspacePath}" does not exist, so Paperclip cannot inspect local git state.`);
    return { gitState: null, warnings };
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = readNonEmptyString((await runGit(["rev-parse", "--show-toplevel"], workspacePath)).stdout);
  } catch (error) {
    warnings.push(
      `Could not inspect git state for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return { gitState: null, warnings };
  }

  if (!repoRoot) {
    return { gitState: null, warnings };
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const branchName =
    await tryReadGitOutput(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ?? await tryReadGitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);

  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  try {
    const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], workspacePath)).stdout;
    for (const line of statusOutput.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("??")) {
        untrackedEntryCount += 1;
        continue;
      }
      dirtyEntryCount += 1;
    }
  } catch (error) {
    warnings.push(
      `Could not read git working tree status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const trackedRef =
    readNonEmptyString(input.trackedRef)
    ?? await tryReadGitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  if (trackedRef) {
    try {
      const counts = readNonEmptyString((await runGit(["rev-list", "--left-right", "--count", `${trackedRef}...HEAD`], workspacePath)).stdout);
      const [behindRaw, aheadRaw] = counts?.split(/\s+/) ?? [];
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch (error) {
      warnings.push(
        `Could not compare "${workspacePath}" against ${trackedRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    gitState: {
      repoRoot: resolvedRepoRoot,
      workspacePath: resolvedWorkspacePath,
      branchName: branchName === "HEAD" ? null : branchName,
      trackedRef,
      hasDirtyTrackedFiles: dirtyEntryCount > 0,
      hasUntrackedFiles: untrackedEntryCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
    },
    warnings,
  };
}
