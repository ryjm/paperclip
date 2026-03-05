import { describe, expect, it } from "vitest";
import {
  containsGitHubCommitOrPrLink,
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
