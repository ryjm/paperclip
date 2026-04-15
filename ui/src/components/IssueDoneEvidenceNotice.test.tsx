// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IssueDoneEvidenceLabelGuidance,
  IssueDoneEvidenceNotice,
  resolveIssueDoneEvidenceState,
} from "./IssueDoneEvidenceNotice";

describe("IssueDoneEvidenceNotice", () => {
  it("renders general guidance with the ready tone when no labels require evidence", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceNotice
        codeEvidenceRequired={false}
        codeEvidenceSatisfied={true}
        uiEvidenceRequired={false}
        uiScreenshotSatisfied={true}
        uiPlaywrightSatisfied={true}
      />,
    );

    expect(html).toContain("border-emerald-500/30");
    expect(html).toContain("Use <code>code</code> for repo-changing work");
    expect(html).toContain("screenshot-attachment and passing Playwright requirements");
  });

  it("renders missing code evidence with the warning tone", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceNotice
        codeEvidenceRequired={true}
        codeEvidenceSatisfied={false}
        uiEvidenceRequired={false}
        uiScreenshotSatisfied={true}
        uiPlaywrightSatisfied={true}
      />,
    );

    expect(html).toContain("border-amber-500/30");
    expect(html).toContain("latest comment must include a GitHub commit or PR link");
    expect(html).toContain("<span class=\"font-medium\">Missing</span>");
  });

  it("renders missing screenshot and Playwright evidence for ui-labeled issues", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceNotice
        codeEvidenceRequired={false}
        codeEvidenceSatisfied={true}
        uiEvidenceRequired={true}
        uiScreenshotSatisfied={false}
        uiPlaywrightSatisfied={false}
      />,
    );

    expect(html).toContain("border-amber-500/30");
    expect(html).toContain("issue needs at least one image attachment plus a latest comment with passing Playwright evidence");
    expect(html).toContain("Screenshots missing; Playwright missing");
  });

  it("updates the ui evidence message when screenshots are ready but Playwright evidence is missing", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceNotice
        codeEvidenceRequired={false}
        codeEvidenceSatisfied={true}
        uiEvidenceRequired={true}
        uiScreenshotSatisfied={true}
        uiPlaywrightSatisfied={false}
      />,
    );

    expect(html).toContain("Screenshots ready; Playwright missing");
  });

  it("renders the success tone when both code and ui evidence are satisfied", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceNotice
        codeEvidenceRequired={true}
        codeEvidenceSatisfied={true}
        uiEvidenceRequired={true}
        uiScreenshotSatisfied={true}
        uiPlaywrightSatisfied={true}
      />,
    );

    expect(html).toContain("border-emerald-500/30");
    expect(html).toContain("<span class=\"font-medium\">Ready</span>");
    expect(html).toContain("Screenshots ready; Playwright ready");
  });
});

describe("IssueDoneEvidenceLabelGuidance", () => {
  it("renders the label guidance copy used in issue properties", () => {
    const html = renderToStaticMarkup(
      <IssueDoneEvidenceLabelGuidance className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground" />,
    );

    expect(html).toContain("Use <code>code</code> for repo-changing work and <code>ui</code> for UI-changing work.");
    expect(html).toContain("<code>code</code> blocks <code>done</code> until the latest comment has a GitHub commit or PR link.");
    expect(html).toContain("<code>ui</code> blocks <code>done</code> until the issue has screenshot attachments and the latest comment cites a passing Playwright run.");
  });
});

describe("resolveIssueDoneEvidenceState", () => {
  it("uses the latest comment in the IssueDetail thread for code evidence", () => {
    const state = resolveIssueDoneEvidenceState({
      currentLabels: [{ id: "label-code", name: "code" }],
      attachments: [],
      comments: [
        { body: "Implemented in https://github.com/acme/paperclip/pull/42" },
        { body: "Latest update is missing the GitHub link." },
      ],
    });

    expect(state.codeEvidenceRequired).toBe(true);
    expect(state.codeEvidenceSatisfied).toBe(false);
  });

  it("uses the latest comment in the IssueDetail thread for ui Playwright evidence", () => {
    const state = resolveIssueDoneEvidenceState({
      currentLabels: [{ id: "label-ui", name: "ui" }],
      attachments: [{ contentType: "image/png" }],
      comments: [
        { body: "Playwright rerun: chromium smoke -> 18 passed" },
        { body: "Latest note only mentions screenshots." },
      ],
    });

    expect(state.uiEvidenceRequired).toBe(true);
    expect(state.uiScreenshotSatisfied).toBe(true);
    expect(state.uiPlaywrightSatisfied).toBe(false);
  });
});
