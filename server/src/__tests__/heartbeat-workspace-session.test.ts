import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  recoverProjectWorkspaceFromManifest,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

const ORIGINAL_PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
const ORIGINAL_PAPERCLIP_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HOME === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = ORIGINAL_PAPERCLIP_HOME;
  }
  if (ORIGINAL_PAPERCLIP_INSTANCE_ID === undefined) {
    delete process.env.PAPERCLIP_INSTANCE_ID;
  } else {
    process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_PAPERCLIP_INSTANCE_ID;
  }
});

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("recoverProjectWorkspaceFromManifest", () => {
  it("recovers managed workspace cwd and metadata from a persisted manifest", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-manifest-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const workspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      workspaceId.slice(0, 32),
    );
    const repoDir = path.join(manifestDir, "repo");

    try {
      await fs.mkdir(repoDir, { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          mode: "git_worktree",
          agentId,
          projectId,
          taskKey,
          workspaceId,
          sourceProjectCwd: "/home/jake/vault/projects/tabula",
          sourceRepoRoot: "/home/jake/vault/projects/tabula",
          relativeCwd: null,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: "main",
          branchName: "paperclip/test",
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [workspaceId],
      });

      expect(recovered).toMatchObject({
        cwd: repoDir,
        workspaceId,
        repoUrl: "https://github.com/ryjm/tabula",
        repoRef: "main",
      });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("uses relativeCwd from the persisted manifest when present", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-relative-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const workspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      workspaceId.slice(0, 32),
    );
    const repoDir = path.join(manifestDir, "repo");
    const relativeCwd = path.join("packages", "server");
    const nestedCwd = path.join(repoDir, relativeCwd);

    try {
      await fs.mkdir(nestedCwd, { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          mode: "git_worktree",
          agentId,
          projectId,
          taskKey,
          workspaceId,
          relativeCwd,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: null,
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [workspaceId],
      });

      expect(recovered?.cwd).toBe(nestedCwd);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("ignores manifests that do not match a tracked workspace id", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-mismatch-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestWorkspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const trackedWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      manifestWorkspaceId.slice(0, 32),
    );

    try {
      await fs.mkdir(path.join(manifestDir, "repo"), { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          projectId,
          taskKey,
          workspaceId: manifestWorkspaceId,
          relativeCwd: null,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: null,
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [trackedWorkspaceId],
      });

      expect(recovered).toBeNull();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("resets session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(true);
  });

  it("resets session context on manual on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});
