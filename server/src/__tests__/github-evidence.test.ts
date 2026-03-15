import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containsGitHubPrLink,
  extractGitHubCommitRefs,
  verifyGitHubEvidenceIsRemoteVisible,
} from "../routes/github-evidence.js";

describe("extractGitHubCommitRefs", () => {
  it("extracts owner, repo, and sha from commit URLs", () => {
    const body = "Shipped in https://github.com/acme/paperclip/commit/abc1234def5678";
    const refs = extractGitHubCommitRefs(body);
    expect(refs).toEqual([
      {
        owner: "acme",
        repo: "paperclip",
        sha: "abc1234def5678",
        url: "https://github.com/acme/paperclip/commit/abc1234def5678",
      },
    ]);
  });

  it("extracts multiple commit refs", () => {
    const body =
      "First: https://github.com/acme/repo/commit/aaa1111 " +
      "Second: https://github.com/other/thing/commit/bbb2222";
    const refs = extractGitHubCommitRefs(body);
    expect(refs).toHaveLength(2);
    expect(refs[0].owner).toBe("acme");
    expect(refs[1].owner).toBe("other");
  });

  it("returns empty array for PR-only links", () => {
    const body = "Merged in https://github.com/acme/paperclip/pull/42";
    expect(extractGitHubCommitRefs(body)).toEqual([]);
  });

  it("returns empty array for text without GitHub links", () => {
    expect(extractGitHubCommitRefs("Just a plain comment")).toEqual([]);
  });
});

describe("containsGitHubPrLink", () => {
  it("detects PR links", () => {
    expect(containsGitHubPrLink("See https://github.com/acme/repo/pull/123")).toBe(true);
  });

  it("rejects non-PR GitHub links", () => {
    expect(containsGitHubPrLink("See https://github.com/acme/repo/commit/abc123")).toBe(false);
  });
});

describe("verifyGitHubEvidenceIsRemoteVisible", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("passes when comment contains only PR links (no commit refs to verify)", async () => {
    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Merged in https://github.com/acme/paperclip/pull/42",
    );
    expect(result.valid).toBe(true);
    expect(result.softPass).toBeUndefined();
  });

  it("passes when commit exists on remote (GitHub API returns 200)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(true);
  });

  it("rejects when commit does not exist on public remote (API 404, repo accessible)", async () => {
    globalThis.fetch = vi
      .fn()
      // First call: commit lookup → 404
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // Second call: repo visibility check → 200 (public)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not reachable on the remote");
    expect(result.unreachableRefs).toHaveLength(1);
    expect(result.unreachableRefs![0].sha).toBe("abc1234");
  });

  it("rejects when commit does not exist and GITHUB_TOKEN is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_123");

    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not reachable on the remote");
  });

  it("soft-passes when repo is inaccessible (private) without GITHUB_TOKEN", async () => {
    globalThis.fetch = vi
      .fn()
      // commit lookup → 404
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // repo visibility → 404 (private)
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/private-repo/commit/abc1234",
    );
    expect(result.valid).toBe(true);
    expect(result.softPass).toBe(true);
  });

  it("soft-passes on rate limiting (403)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(true);
    expect(result.softPass).toBe(true);
  });

  it("soft-passes on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(true);
    expect(result.softPass).toBe(true);
  });

  it("soft-passes on GitHub 5xx error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 502 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "Done in https://github.com/acme/paperclip/commit/abc1234",
    );
    expect(result.valid).toBe(true);
    expect(result.softPass).toBe(true);
  });

  it("rejects when any of multiple commit refs is unreachable", async () => {
    globalThis.fetch = vi
      .fn()
      // First commit: exists
      .mockResolvedValueOnce({ ok: true, status: 200 })
      // Second commit: 404
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // Repo check for second commit: public
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await verifyGitHubEvidenceIsRemoteVisible(
      "First: https://github.com/acme/repo/commit/aaa1111 " +
        "Second: https://github.com/acme/repo/commit/bbb2222",
    );
    expect(result.valid).toBe(false);
    expect(result.unreachableRefs).toHaveLength(1);
    expect(result.unreachableRefs![0].sha).toBe("bbb2222");
  });
});
