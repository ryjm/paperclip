/**
 * Verifies that commit evidence cited in issue comments is actually reachable
 * on the remote repository, not just a locally-constructed URL pointing at an
 * unpushed commit.
 *
 * Review links are inherently remote-visible, so only commit links require
 * verification.
 */

import { logger } from "../middleware/logger.js";

const VERIFY_TIMEOUT_MS = 10_000;
const URL_RE = /https?:\/\/[^\s<>)\]}]+/g;

export interface GitHubCommitRef {
  provider: "github";
  host: string;
  owner: string;
  repo: string;
  sha: string;
  url: string;
}

export interface GitLabCommitRef {
  provider: "gitlab";
  host: string;
  origin: string;
  projectPath: string;
  sha: string;
  url: string;
}

export type CommitEvidenceRef = GitHubCommitRef | GitLabCommitRef;

type ReviewEvidenceLink = {
  kind: "review";
  provider: "github" | "gitlab";
  url: string;
};

type CommitEvidenceLink = {
  kind: "commit";
  provider: "github" | "gitlab";
  url: string;
  ref: CommitEvidenceRef;
};

type EvidenceLink = ReviewEvidenceLink | CommitEvidenceLink;

function trimCandidateUrl(rawUrl: string): string {
  return rawUrl.replace(/[.,;:!?]+$/, "");
}

function parseGitHubEvidence(url: URL, normalizedUrl: string): EvidenceLink | null {
  if (url.hostname !== "github.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return null;
  const [owner, repo, kind, value] = segments;
  if (kind === "commit" && /^[0-9a-fA-F]{7,40}$/.test(value)) {
    return {
      kind: "commit",
      provider: "github",
      url: normalizedUrl,
      ref: {
        provider: "github",
        host: url.host,
        owner,
        repo,
        sha: value,
        url: normalizedUrl,
      },
    };
  }
  if (kind === "pull" && /^\d+$/.test(value)) {
    return {
      kind: "review",
      provider: "github",
      url: normalizedUrl,
    };
  }
  return null;
}

function parseGitLabEvidence(url: URL, normalizedUrl: string): EvidenceLink | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const dashIndex = segments.indexOf("-");
  if (dashIndex < 2 || dashIndex !== segments.length - 3) return null;
  const projectPathSegments = segments.slice(0, dashIndex);
  const kind = segments[dashIndex + 1];
  const value = segments[dashIndex + 2];
  const projectPath = projectPathSegments.join("/");
  if (kind === "commit" && /^[0-9a-fA-F]{7,40}$/.test(value)) {
    return {
      kind: "commit",
      provider: "gitlab",
      url: normalizedUrl,
      ref: {
        provider: "gitlab",
        host: url.host,
        origin: url.origin,
        projectPath,
        sha: value,
        url: normalizedUrl,
      },
    };
  }
  if (kind === "merge_requests" && /^\d+$/.test(value)) {
    return {
      kind: "review",
      provider: "gitlab",
      url: normalizedUrl,
    };
  }
  return null;
}

function parseEvidenceUrl(rawUrl: string): EvidenceLink | null {
  const normalizedUrl = trimCandidateUrl(rawUrl);
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return null;
  }
  return parseGitHubEvidence(url, normalizedUrl) ?? parseGitLabEvidence(url, normalizedUrl);
}

export function extractCommitEvidenceRefs(body: string): CommitEvidenceRef[] {
  const refs: CommitEvidenceRef[] = [];
  for (const match of body.matchAll(URL_RE)) {
    const evidence = parseEvidenceUrl(match[0]);
    if (evidence?.kind === "commit") refs.push(evidence.ref);
  }
  return refs;
}

export function containsCommitOrReviewLink(body: string | null | undefined): boolean {
  if (!body) return false;
  for (const match of body.matchAll(URL_RE)) {
    if (parseEvidenceUrl(match[0])) return true;
  }
  return false;
}

export interface VerifyResult {
  /** true when all commit refs are confirmed on the remote (or only PR links are present) */
  valid: boolean;
  /** human-readable explanation when invalid */
  error?: string;
  /** refs that could not be found on the remote */
  unreachableRefs?: CommitEvidenceRef[];
  /** true when verification was skipped due to network/auth issues */
  softPass?: boolean;
}

/**
 * Verify a single commit ref exists on GitHub.
 *
 * Strategy:
 * - 200 → exists
 * - 404 with GITHUB_TOKEN set → definitely not found (we have auth)
 * - 404 without GITHUB_TOKEN → check repo visibility; if public, commit
 *   is definitively missing; if private/inaccessible, soft-pass
 * - 403/429 (rate limit) → soft-pass
 * - network/timeout → soft-pass
 */
async function verifyCommitRef(ref: GitHubCommitRef): Promise<{
  exists: boolean;
  softPass: boolean;
  error?: string;
}> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Paperclip-Evidence-Validator",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const commitUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${ref.sha}`;

  let commitResponse: Response;
  try {
    commitResponse = await fetch(commitUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ ref, error: msg }, "GitHub commit verification network error, soft-passing");
    return { exists: false, softPass: true, error: `Network error verifying commit: ${msg}` };
  }

  if (commitResponse.ok) {
    return { exists: true, softPass: false };
  }

  if (commitResponse.status === 403 || commitResponse.status === 429) {
    logger.warn(
      { ref, status: commitResponse.status },
      "GitHub API rate limited during commit verification, soft-passing",
    );
    return { exists: false, softPass: true, error: "GitHub API rate limited" };
  }

  if (commitResponse.status === 404) {
    // With auth token, 404 is definitive
    if (token) {
      return {
        exists: false,
        softPass: false,
        error: `Commit ${ref.sha.slice(0, 7)} not found on github.com/${ref.owner}/${ref.repo}`,
      };
    }

    // Without auth, 404 could mean private repo — check repo visibility
    try {
      const repoUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
      const repoResponse = await fetch(repoUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (repoResponse.ok) {
        // Repo is public → commit definitively doesn't exist
        return {
          exists: false,
          softPass: false,
          error: `Commit ${ref.sha.slice(0, 7)} not found on github.com/${ref.owner}/${ref.repo} (public repo)`,
        };
      }

      // Repo not accessible → could be private, soft-pass
      logger.warn(
        { ref, repoStatus: repoResponse.status },
        "Cannot verify commit on inaccessible repo, soft-passing (set GITHUB_TOKEN for private repos)",
      );
      return {
        exists: false,
        softPass: true,
        error: `Cannot verify commit on inaccessible repo github.com/${ref.owner}/${ref.repo} — set GITHUB_TOKEN for private repo verification`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ ref, error: msg }, "Failed to check repo visibility, soft-passing");
      return { exists: false, softPass: true, error: `Network error checking repo visibility: ${msg}` };
    }
  }

  // Other status codes (422 for malformed sha, 5xx, etc.)
  if (commitResponse.status >= 500) {
    logger.warn({ ref, status: commitResponse.status }, "GitHub API error, soft-passing");
    return { exists: false, softPass: true, error: `GitHub API returned ${commitResponse.status}` };
  }

  return {
    exists: false,
    softPass: false,
    error: `GitHub API returned ${commitResponse.status} for commit ${ref.sha.slice(0, 7)}`,
  };
}

async function verifyGitLabCommitRef(ref: GitLabCommitRef): Promise<{
  exists: boolean;
  softPass: boolean;
  error?: string;
}> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Paperclip-Evidence-Validator",
  };
  const token = process.env.GITLAB_TOKEN;
  if (token) {
    headers["PRIVATE-TOKEN"] = token;
  }

  const encodedProjectPath = encodeURIComponent(ref.projectPath);
  const commitUrl = `${ref.origin}/api/v4/projects/${encodedProjectPath}/repository/commits/${ref.sha}`;

  let commitResponse: Response;
  try {
    commitResponse = await fetch(commitUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ ref, error: msg }, "GitLab commit verification network error, soft-passing");
    return { exists: false, softPass: true, error: `Network error verifying commit: ${msg}` };
  }

  if (commitResponse.ok) {
    return { exists: true, softPass: false };
  }

  if (commitResponse.status === 401 || commitResponse.status === 403 || commitResponse.status === 429) {
    logger.warn(
      { ref, status: commitResponse.status },
      "GitLab API auth or rate-limit error during commit verification, soft-passing",
    );
    return { exists: false, softPass: true, error: "GitLab API auth or rate-limit error" };
  }

  if (commitResponse.status === 404) {
    try {
      const projectUrl = `${ref.origin}/api/v4/projects/${encodedProjectPath}`;
      const projectResponse = await fetch(projectUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (projectResponse.ok) {
        return {
          exists: false,
          softPass: false,
          error: `Commit ${ref.sha.slice(0, 7)} not found on ${ref.host}/${ref.projectPath}`,
        };
      }

      logger.warn(
        { ref, projectStatus: projectResponse.status },
        "Cannot verify commit on inaccessible GitLab project, soft-passing",
      );
      return {
        exists: false,
        softPass: true,
        error: `Cannot verify commit on inaccessible GitLab project ${ref.host}/${ref.projectPath} — set GITLAB_TOKEN for private project verification`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ ref, error: msg }, "Failed to check GitLab project visibility, soft-passing");
      return { exists: false, softPass: true, error: `Network error checking project visibility: ${msg}` };
    }
  }

  if (commitResponse.status >= 500) {
    logger.warn({ ref, status: commitResponse.status }, "GitLab API error, soft-passing");
    return { exists: false, softPass: true, error: `GitLab API returned ${commitResponse.status}` };
  }

  return {
    exists: false,
    softPass: false,
    error: `GitLab API returned ${commitResponse.status} for commit ${ref.sha.slice(0, 7)}`,
  };
}

/**
 * Verify that all GitHub commit evidence in a comment body is reachable
 * on the remote. PR links are accepted without verification since they
 * are inherently remote-visible.
 */
async function verifyCommitRefOnRemote(ref: CommitEvidenceRef) {
  return ref.provider === "github" ? verifyCommitRef(ref) : verifyGitLabCommitRef(ref);
}

export async function verifyCommitEvidenceIsRemoteVisible(commentBody: string): Promise<VerifyResult> {
  const commitRefs = extractCommitEvidenceRefs(commentBody);

  // If the comment only has review links (no commit refs), it's valid.
  if (commitRefs.length === 0) {
    return { valid: true };
  }

  const unreachable: CommitEvidenceRef[] = [];
  let allSoftPass = true;

  for (const ref of commitRefs) {
    const result = await verifyCommitRefOnRemote(ref);
    if (!result.exists && !result.softPass) {
      unreachable.push(ref);
      allSoftPass = false;
    } else if (result.exists) {
      allSoftPass = false;
    }
  }

  if (unreachable.length > 0) {
    const details = unreachable
      .map((r) =>
        r.provider === "github"
          ? `\`${r.sha.slice(0, 7)}\` on ${r.host}/${r.owner}/${r.repo}`
          : `\`${r.sha.slice(0, 7)}\` on ${r.host}/${r.projectPath}`,
      )
      .join(", ");
    return {
      valid: false,
      error: `Commit evidence is not reachable on the remote: ${details}. Push the commit(s) before marking the issue done.`,
      unreachableRefs: unreachable,
    };
  }

  if (allSoftPass) {
    logger.warn({ commitRefs }, "All commit evidence verifications soft-passed (could not reach forge APIs)");
    return { valid: true, softPass: true };
  }

  return { valid: true };
}
