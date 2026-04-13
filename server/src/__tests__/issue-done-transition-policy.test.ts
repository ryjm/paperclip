import { describe, expect, it } from "vitest";
import {
  buildDoneEvidenceRequiredErrorResponse,
  buildDoneEvidenceUnreachableErrorResponse,
  containsGitHubCommitOrPrLink,
  issueRequiresDoneEvidence,
  resolveDoneTransitionEvidenceComment,
} from "../routes/issues.js";

describe("containsGitHubCommitOrPrLink", () => {
  it("accepts GitHub commit links", () => {
    expect(
      containsGitHubCommitOrPrLink("Implemented in https://github.com/acme/paperclip/commit/abc1234"),
    ).toBe(true);
  });

  it("accepts GitHub pull request links", () => {
    expect(
      containsGitHubCommitOrPrLink("Shipped in https://github.com/acme/paperclip/pull/42"),
    ).toBe(true);
  });

  it("rejects other GitHub URLs", () => {
    expect(
      containsGitHubCommitOrPrLink("See https://github.com/acme/paperclip/issues/99"),
    ).toBe(false);
  });
});

describe("resolveDoneTransitionEvidenceComment", () => {
  it("prefers the new transition comment when provided", () => {
    expect(
      resolveDoneTransitionEvidenceComment(
        "Done via https://github.com/acme/paperclip/pull/77",
        "Old note without links",
      ),
    ).toContain("/pull/77");
  });

  it("falls back to the latest existing comment", () => {
    expect(
      resolveDoneTransitionEvidenceComment(
        undefined,
        "Latest: https://github.com/acme/paperclip/commit/def5678",
      ),
    ).toContain("/commit/def5678");
  });

  it("returns null when no usable comment exists", () => {
    expect(resolveDoneTransitionEvidenceComment("   ", "  ")).toBeNull();
  });
});

describe("buildDoneEvidenceRequiredErrorResponse", () => {
  it("documents both enforcement signals and closeout fallbacks", () => {
    const payload = buildDoneEvidenceRequiredErrorResponse();
    expect(payload.error).toContain("code label");
    expect(payload.error).toContain("repo-connected workspace");
    expect(payload.error).toContain("keep the issue open until traceability is available");
    expect(payload.details).toMatchObject({
      requiredLabel: "code",
      enforcedSignals: {
        codeLabel: expect.any(String),
        projectRepoWorkspace: expect.any(String),
      },
      acceptedEvidence: {
        githubCommitUrl: "https://github.com/<owner>/<repo>/commit/<sha>",
        githubPullRequestUrl: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      fallback: {
        nonCode: "Remove the code label before marking done when the task did not require repository changes.",
        projectBound:
          "If the issue is in a repo-connected project but did not change files, move it to a non-repo project or remove the project association.",
      },
    });
  });
});

describe("buildDoneEvidenceUnreachableErrorResponse", () => {
  it("includes remote verification failure details", () => {
    const payload = buildDoneEvidenceUnreachableErrorResponse(
      "Commit abc1234 not found on github.com/acme/paperclip (public repo)",
    );
    expect(payload.error).toContain("not reachable on the remote repository");
    expect(payload.error).toContain("Push the commit(s)");
    expect(payload.details.remoteVerification).toMatchObject({
      result: "unreachable",
      detail: "Commit abc1234 not found on github.com/acme/paperclip (public repo)",
      fix: "git push the branch containing the cited commit, then retry the done transition.",
    });
    // inherits base evidence details
    expect(payload.details.requiredLabel).toBe("code");
  });
});

describe("issueRequiresDoneEvidence", () => {
  it("requires evidence when current labels include code", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "Code" }],
      }),
    ).toBe(true);
  });

  it("does not require evidence when current labels do not include code", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "ops" }],
      }),
    ).toBe(false);
  });

  it("matches the code label case-insensitively even with extra whitespace", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "  CODE  " }],
      }),
    ).toBe(true);
  });

  it("uses next labelIds when labels are being updated", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "ops" }],
        nextLabelIds: ["2"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "code" },
        ],
      }),
    ).toBe(true);
  });

  it("does not require evidence when code label is removed in the same patch", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "2", name: "code" }],
        nextLabelIds: ["1"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "code" },
        ],
      }),
    ).toBe(false);
  });

  it("requires evidence for repo-connected project workspace when issue lacks code label", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "ops" }],
        repoConnectedProjectWorkspace: true,
      }),
    ).toBe(true);
  });

  it("requires evidence for repo-connected project issues even when code label is removed", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "2", name: "code" }],
        nextLabelIds: ["1"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "code" },
        ],
        repoConnectedProjectWorkspace: true,
      }),
    ).toBe(true);
  });
});
