import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";

describe("GET /health", () => {
  const runtimeProvenance = {
    startedAt: "2026-03-21T00:00:00.000Z",
    cwd: "/work/server",
    repoRoot: "/work",
    packageVersion: "0.2.0-beta.1",
    gitBranch: "main",
    gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
    gitCommitShortSha: "0123456789ab",
    checkoutKind: "repo_checkout" as const,
  };

  it("returns runtime provenance for local_trusted health checks", async () => {
    const app = express();
    app.use(
      "/health",
      healthRoutes(undefined, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        runtimeProvenance,
      }),
    );

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      runtime: runtimeProvenance,
    });
  });

  it("redacts filesystem paths outside local_trusted mode", async () => {
    const app = express();
    app.use(
      "/health",
      healthRoutes(undefined, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        runtimeProvenance,
      }),
    );

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      runtime: {
        startedAt: runtimeProvenance.startedAt,
        packageVersion: runtimeProvenance.packageVersion,
        gitBranch: runtimeProvenance.gitBranch,
        gitCommitSha: runtimeProvenance.gitCommitSha,
        gitCommitShortSha: runtimeProvenance.gitCommitShortSha,
        checkoutKind: runtimeProvenance.checkoutKind,
      },
    });
  });
});
