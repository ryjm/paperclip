import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DeploymentMode } from "@paperclipai/shared";

export type RuntimeCheckoutKind =
  | "repo_checkout"
  | "tmp_checkout"
  | "tmp_rebased"
  | "no_git";

export type RuntimeProvenance = {
  startedAt: string;
  cwd: string;
  repoRoot: string | null;
  packageVersion: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  gitCommitShortSha: string | null;
  checkoutKind: RuntimeCheckoutKind;
};

export type HealthRuntimeProvenance = Omit<RuntimeProvenance, "cwd" | "repoRoot"> & {
  cwd?: string;
  repoRoot?: string | null;
};

let cachedRuntimeProvenance: RuntimeProvenance | null = null;
const runtimeStartedAt = new Date().toISOString();

function runGit(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function resolveRepoRoot(cwd: string): string | null {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd);
  return root ? path.resolve(root) : null;
}

function findPackageVersion(cwd: string, repoRoot: string | null): string | null {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (repoRoot) pushCandidate(path.join(repoRoot, "package.json"));

  let cursor = path.resolve(cwd);
  while (true) {
    pushCandidate(path.join(cursor, "package.json"));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version.trim();
      }
    } catch {
      // Ignore malformed package metadata and keep searching ancestors.
    }
  }

  return null;
}

function resolveCheckoutKind(repoRoot: string | null): RuntimeCheckoutKind {
  if (!repoRoot) return "no_git";
  const normalized = path.resolve(repoRoot);
  if (!normalized.startsWith("/tmp/")) return "repo_checkout";
  return path.basename(normalized).startsWith("paperclip-rebased-")
    ? "tmp_rebased"
    : "tmp_checkout";
}

export function getRuntimeProvenance(): RuntimeProvenance {
  if (cachedRuntimeProvenance) return cachedRuntimeProvenance;

  const cwd = path.resolve(process.cwd());
  const repoRoot = resolveRepoRoot(cwd);
  const gitCommitSha = repoRoot ? runGit(["rev-parse", "HEAD"], repoRoot) : null;
  const gitBranch = repoRoot ? runGit(["branch", "--show-current"], repoRoot) : null;

  cachedRuntimeProvenance = {
    startedAt: runtimeStartedAt,
    cwd,
    repoRoot,
    packageVersion: findPackageVersion(cwd, repoRoot),
    gitBranch,
    gitCommitSha,
    gitCommitShortSha: gitCommitSha ? gitCommitSha.slice(0, 12) : null,
    checkoutKind: resolveCheckoutKind(repoRoot),
  };

  return cachedRuntimeProvenance;
}

export function getHealthRuntimeProvenance(
  deploymentMode: DeploymentMode,
  runtimeProvenance: RuntimeProvenance = getRuntimeProvenance(),
): HealthRuntimeProvenance {
  if (deploymentMode === "local_trusted") {
    return runtimeProvenance;
  }

  const { cwd: _cwd, repoRoot: _repoRoot, ...rest } = runtimeProvenance;
  return rest;
}
