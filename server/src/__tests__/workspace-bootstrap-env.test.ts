import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceBootstrapEnv } from "@paperclipai/adapter-utils/server-utils";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeExecutable(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function writeFakeCommand(input: {
  binDir: string;
  name: string;
  stdoutEntries?: Record<string, string>;
  stderr?: string;
  expectedArgs?: string[];
  exitCode?: number;
}) {
  const stdoutEntries = input.stdoutEntries ?? {};
  const stderr = input.stderr ?? "";
  const expectedArgs = input.expectedArgs ?? [];
  const exitCode = input.exitCode ?? 0;
  const outputBody = Object.entries(stdoutEntries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\0");

  const script = `#!/usr/bin/env node
const expectedArgs = ${JSON.stringify(expectedArgs)};
const actualArgs = process.argv.slice(2);
if (JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) {
  console.error(\`unexpected args: \${JSON.stringify(actualArgs)}\`);
  process.exit(97);
}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});\n` : ""}${
    outputBody
      ? `process.stdout.write(${JSON.stringify(`${outputBody}\\0`)});\n`
      : ""
  }process.exit(${exitCode});
`;

  await writeExecutable(path.join(input.binDir, input.name), script);
}

describe("resolveWorkspaceBootstrapEnv", () => {
  it("uses direnv from the nearest workspace root", async () => {
    const root = await createTempRoot("paperclip-bootstrap-direnv-");
    const repoRoot = path.join(root, "repo");
    const cwd = path.join(repoRoot, "src-tauri", "tests");
    const binDir = path.join(root, "bin");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".envrc"), "use flake\n", "utf8");
    await writeFakeCommand({
      binDir,
      name: "direnv",
      expectedArgs: ["exec", repoRoot, "env", "-0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "direnv",
        BOOTSTRAP_ROOT: repoRoot,
        CUSTOM_VALUE: "from-input",
        PAPERCLIP_RUN_ID: "run-123",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(cwd, {
      CUSTOM_VALUE: "from-input",
      PAPERCLIP_RUN_ID: "run-123",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.env.BOOTSTRAP_TOOL).toBe("direnv");
    expect(result.env.BOOTSTRAP_ROOT).toBe(repoRoot);
    expect(result.env.CUSTOM_VALUE).toBe("from-input");
    expect(result.env.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(result.notes).toEqual([
      `Loaded workspace bootstrap from ${path.join(repoRoot, ".envrc")} via direnv.`,
    ]);
  });

  it("falls back to nix develop when direnv bootstrap fails", async () => {
    const root = await createTempRoot("paperclip-bootstrap-nix-");
    const repoRoot = path.join(root, "repo");
    const cwd = path.join(repoRoot, "src-tauri");
    const binDir = path.join(root, "bin");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".envrc"), "use flake\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "flake.nix"), "{ }\n", "utf8");

    await writeFakeCommand({
      binDir,
      name: "direnv",
      expectedArgs: ["exec", repoRoot, "env", "-0"],
      stderr: "direnv: .envrc is blocked\n",
      exitCode: 1,
    });
    await writeFakeCommand({
      binDir,
      name: "nix",
      expectedArgs: ["develop", repoRoot, "--command", "env", "-0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "nix_develop",
        BOOTSTRAP_ROOT: repoRoot,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(cwd, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.env.BOOTSTRAP_TOOL).toBe("nix_develop");
    expect(result.env.BOOTSTRAP_ROOT).toBe(repoRoot);
    expect(result.notes).toEqual([
      `Attempted workspace bootstrap from ${path.join(repoRoot, ".envrc")} via direnv, but the bootstrap command failed (direnv: .envrc is blocked); continuing without repo bootstrap.`,
      `Loaded workspace bootstrap from ${path.join(repoRoot, "flake.nix")} via nix develop.`,
    ]);
  });

  it("falls back to projectSearchRoots when primary cwd has no markers", async () => {
    const root = await createTempRoot("paperclip-bootstrap-project-root-");
    const agentHome = path.join(root, "agent-home");
    const projectCwd = path.join(root, "project");
    const binDir = path.join(root, "bin");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(projectCwd, { recursive: true });
    await fs.writeFile(path.join(projectCwd, "flake.nix"), "{ }\n", "utf8");
    await writeFakeCommand({
      binDir,
      name: "nix",
      expectedArgs: ["develop", projectCwd, "--command", "env", "-0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "nix_develop",
        BOOTSTRAP_ROOT: projectCwd,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(
      agentHome,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      { projectSearchRoots: [projectCwd] },
    );

    expect(result.env.BOOTSTRAP_TOOL).toBe("nix_develop");
    expect(result.env.BOOTSTRAP_ROOT).toBe(projectCwd);
    expect(result.notes).toEqual([
      `Loaded workspace bootstrap from ${path.join(projectCwd, "flake.nix")} via nix develop.`,
    ]);
  });

  it("does not use projectSearchRoots when primary cwd has markers", async () => {
    const root = await createTempRoot("paperclip-bootstrap-primary-wins-");
    const primaryRepo = path.join(root, "primary");
    const projectCwd = path.join(root, "project");
    const cwd = path.join(primaryRepo, "src");
    const binDir = path.join(root, "bin");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(projectCwd, { recursive: true });
    await fs.writeFile(path.join(primaryRepo, ".envrc"), "use flake\n", "utf8");
    await fs.writeFile(path.join(projectCwd, "flake.nix"), "{ }\n", "utf8");
    await writeFakeCommand({
      binDir,
      name: "direnv",
      expectedArgs: ["exec", primaryRepo, "env", "-0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "direnv",
        BOOTSTRAP_ROOT: primaryRepo,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(
      cwd,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      { projectSearchRoots: [projectCwd] },
    );

    expect(result.env.BOOTSTRAP_TOOL).toBe("direnv");
    expect(result.env.BOOTSTRAP_ROOT).toBe(primaryRepo);
  });

  it("skips projectSearchRoots that match the primary cwd", async () => {
    const root = await createTempRoot("paperclip-bootstrap-skip-same-");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await resolveWorkspaceBootstrapEnv(
      cwd,
      { PATH: process.env.PATH ?? "" },
      { projectSearchRoots: [cwd, ""] },
    );

    expect(result.notes).toEqual([]);
    expect(result.env.BOOTSTRAP_TOOL).toBeUndefined();
  });

  it("tries multiple projectSearchRoots and uses the first with markers", async () => {
    const root = await createTempRoot("paperclip-bootstrap-multi-root-");
    const agentHome = path.join(root, "agent-home");
    const emptyProject = path.join(root, "empty-project");
    const nixProject = path.join(root, "nix-project");
    const binDir = path.join(root, "bin");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(emptyProject, { recursive: true });
    await fs.mkdir(nixProject, { recursive: true });
    await fs.writeFile(path.join(nixProject, "flake.nix"), "{ }\n", "utf8");
    await writeFakeCommand({
      binDir,
      name: "nix",
      expectedArgs: ["develop", nixProject, "--command", "env", "-0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "nix_develop",
        BOOTSTRAP_ROOT: nixProject,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(
      agentHome,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      { projectSearchRoots: [emptyProject, nixProject] },
    );

    expect(result.env.BOOTSTRAP_TOOL).toBe("nix_develop");
    expect(result.env.BOOTSTRAP_ROOT).toBe(nixProject);
  });

  it("uses nix-shell when shell.nix is the only bootstrap marker", async () => {
    const root = await createTempRoot("paperclip-bootstrap-shell-");
    const repoRoot = path.join(root, "repo");
    const cwd = path.join(repoRoot, "workspace");
    const binDir = path.join(root, "bin");
    const shellNixPath = path.join(repoRoot, "shell.nix");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(shellNixPath, "{ }\n", "utf8");
    await writeFakeCommand({
      binDir,
      name: "nix-shell",
      expectedArgs: [shellNixPath, "--run", "env -0"],
      stdoutEntries: {
        BOOTSTRAP_TOOL: "nix_shell",
        BOOTSTRAP_ROOT: repoRoot,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const result = await resolveWorkspaceBootstrapEnv(cwd, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.env.BOOTSTRAP_TOOL).toBe("nix_shell");
    expect(result.notes).toEqual([
      `Loaded workspace bootstrap from ${shellNixPath} via nix-shell.`,
    ]);
  });
});
