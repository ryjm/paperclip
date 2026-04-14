import { cn } from "../lib/utils";

type IssueDoneEvidenceNoticeProps = {
  codeEvidenceRequired: boolean;
  codeEvidenceSatisfied: boolean;
  uiEvidenceRequired: boolean;
  uiScreenshotSatisfied: boolean;
  uiPlaywrightSatisfied: boolean;
};

export function IssueDoneEvidenceLabelGuidance({ className }: { className?: string }) {
  return (
    <p className={className}>
      Use <code>code</code> for repo-changing work and <code>ui</code> for UI-changing work.
      <br />
      <code>code</code> blocks <code>done</code> until the latest comment has a GitHub commit or PR link.
      <br />
      <code>ui</code> blocks <code>done</code> until the issue has screenshot attachments and the latest comment cites a passing Playwright run.
    </p>
  );
}

export function IssueDoneEvidenceNotice({
  codeEvidenceRequired,
  codeEvidenceSatisfied,
  uiEvidenceRequired,
  uiScreenshotSatisfied,
  uiPlaywrightSatisfied,
}: IssueDoneEvidenceNoticeProps) {
  const doneEvidenceMissing =
    (codeEvidenceRequired && !codeEvidenceSatisfied) ||
    (uiEvidenceRequired && (!uiScreenshotSatisfied || !uiPlaywrightSatisfied));
  const tone = doneEvidenceMissing
    ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100";

  return (
    <div className={cn("rounded-lg border px-3 py-2 text-xs", tone)}>
      <div className="font-medium">Done evidence</div>
      {codeEvidenceRequired ? (
        <p className="mt-1">
          <code>code</code>: latest comment must include a GitHub commit or PR link.{" "}
          <span className="font-medium">{codeEvidenceSatisfied ? "Ready" : "Missing"}</span>
        </p>
      ) : null}
      {uiEvidenceRequired ? (
        <p className="mt-1">
          <code>ui</code>: issue needs at least one image attachment plus a latest comment with passing Playwright evidence.{" "}
          <span className="font-medium">
            Screenshots {uiScreenshotSatisfied ? "ready" : "missing"}; Playwright{" "}
            {uiPlaywrightSatisfied ? "ready" : "missing"}
          </span>
        </p>
      ) : null}
      {!codeEvidenceRequired && !uiEvidenceRequired ? (
        <p className="mt-1 text-muted-foreground">
          Use <code>code</code> for repo-changing work and <code>ui</code> for UI-changing work. The <code>ui</code>{" "}
          label turns on screenshot-attachment and passing Playwright requirements before <code>done</code>.
        </p>
      ) : null}
    </div>
  );
}
