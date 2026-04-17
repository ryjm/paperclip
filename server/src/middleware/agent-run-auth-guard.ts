import type { RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects mutating requests that carry X-Paperclip-Run-Id but lack a valid
 * Bearer token.  In local_trusted mode the default actor is an implicit board
 * user with full privileges.  That fallback is intentional for the UI, but
 * agent runs must authenticate with a real JWT so mutations are attributed to
 * the correct agent and run.
 */
export function agentRunAuthGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const runId = req.header("x-paperclip-run-id");
    if (!runId) {
      next();
      return;
    }

    if (req.actor.source === "local_implicit") {
      res.status(401).json({
        error: "Agent run mutations require Bearer authentication. "
             + "Ensure PAPERCLIP_API_KEY is injected for this run.",
      });
      return;
    }

    next();
  };
}
