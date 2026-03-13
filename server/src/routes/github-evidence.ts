/**
 * Verifies that GitHub commit evidence cited in issue comments is actually
 * reachable on the remote repository, not just a locally-constructed URL
 * pointing at an unpushed commit.
 *
 * PR links are inherently remote-visible (you cannot create a PR without
 * pushing), so only commit links require verification.
 */

import { logger } from "../middleware/logger.js";

const GITHUB_COMMIT_URL_CAPTURE_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([0-9a-fA-F]{7,40})/g;

const GITHUB_PR_LINK_RE =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

const VERIFY_TIMEOUT_MS = 10_000;

export interface GitHubCommitRef {
  owner: string;
  repo: string;
  sha: string;
  url: string;
}

export function extractGitHubCommitRefs(body: string): GitHubCommitRef[] {
  const refs: GitHubCommitRef[] = [];
  for (const match of body.matchAll(GITHUB_COMMIT_URL_CAPTURE_RE)) {
    refs.push({
      owner: match[1],
      repo: match[2],
      sha: match[3],
      url: match[0],
    });
  }
  return refs;
}

export function containsGitHubPrLink(body: string): boolean {
  return GITHUB_PR_LINK_RE.test(body);
}

export interface VerifyResult {
  /** true when all commit refs are confirmed on the remote (or only PR links are present) */
  valid: boolean;
  /** human-readable explanation when invalid */
  error?: string;
  /** refs that could not be found on the remote */
  unreachableRefs?: GitHubCommitRef[];
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

/**
 * Verify that all GitHub commit evidence in a comment body is reachable
 * on the remote. PR links are accepted without verification since they
 * are inherently remote-visible.
 */
export async function verifyGitHubEvidenceIsRemoteVisible(commentBody: string): Promise<VerifyResult> {
  const commitRefs = extractGitHubCommitRefs(commentBody);

  // If the comment only has PR links (no commit refs), it's valid — PRs are inherently remote
  if (commitRefs.length === 0) {
    return { valid: true };
  }

  const unreachable: GitHubCommitRef[] = [];
  let allSoftPass = true;

  for (const ref of commitRefs) {
    const result = await verifyCommitRef(ref);
    if (!result.exists && !result.softPass) {
      unreachable.push(ref);
      allSoftPass = false;
    } else if (result.exists) {
      allSoftPass = false;
    }
  }

  if (unreachable.length > 0) {
    const details = unreachable
      .map((r) => `\`${r.sha.slice(0, 7)}\` on github.com/${r.owner}/${r.repo}`)
      .join(", ");
    return {
      valid: false,
      error: `Commit evidence is not reachable on the remote: ${details}. Push the commit(s) before marking the issue done.`,
      unreachableRefs: unreachable,
    };
  }

  if (allSoftPass) {
    logger.warn({ commitRefs }, "All commit evidence verifications soft-passed (could not reach GitHub API)");
    return { valid: true, softPass: true };
  }

  return { valid: true };
}
