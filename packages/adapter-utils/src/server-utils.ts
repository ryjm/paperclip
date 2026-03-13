import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface WorkspaceBootstrapResolution {
  env: Record<string, string>;
  notes: string[];
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export function deriveAgentHomeFromInstructionsFilePath(
  instructionsFilePath: string,
  cwd = process.cwd(),
): string | null {
  const trimmed = instructionsFilePath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  return path.dirname(resolved);
}

function stripAmbientPaperclipEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PAPERCLIP_")) continue;
    stripped[key] = value;
  }
  return stripped;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

async function pathExistsForBootstrap(candidate: string): Promise<boolean> {
  return fs.access(candidate, fsConstants.F_OK).then(() => true).catch(() => false);
}

type WorkspaceBootstrapMarkers = {
  envrcRoot: string | null;
  flakeRoot: string | null;
  shellNixPath: string | null;
  defaultNixPath: string | null;
};

async function findWorkspaceBootstrapMarkers(startCwd: string): Promise<WorkspaceBootstrapMarkers> {
  let current = path.resolve(startCwd);
  let envrcRoot: string | null = null;
  let flakeRoot: string | null = null;
  let shellNixPath: string | null = null;
  let defaultNixPath: string | null = null;

  while (true) {
    if (!envrcRoot && await pathExistsForBootstrap(path.join(current, ".envrc"))) {
      envrcRoot = current;
    }
    if (!flakeRoot && await pathExistsForBootstrap(path.join(current, "flake.nix"))) {
      flakeRoot = current;
    }
    if (!shellNixPath) {
      const candidate = path.join(current, "shell.nix");
      if (await pathExistsForBootstrap(candidate)) shellNixPath = candidate;
    }
    if (!defaultNixPath) {
      const candidate = path.join(current, "default.nix");
      if (await pathExistsForBootstrap(candidate)) defaultNixPath = candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return {
    envrcRoot,
    flakeRoot,
    shellNixPath,
    defaultNixPath,
  };
}

type WorkspaceBootstrapCandidate = {
  tool: "direnv" | "nix_develop" | "nix_shell";
  command: string;
  args: string[];
  sourceDescription: string;
  successNote: string;
};

function filteredStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function parseEnvSnapshot(snapshot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of snapshot.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

async function commandExists(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await ensureCommandResolvable(command, cwd, env);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceBootstrapEnv(
  cwd: string,
  env: Record<string, string>,
): Promise<WorkspaceBootstrapResolution> {
  const mergedEnv = filteredStringEnv(
    ensurePathInEnv({
      ...stripAmbientPaperclipEnv(process.env),
      ...env,
    }),
  );
  const markers = await findWorkspaceBootstrapMarkers(cwd);
  const notes: string[] = [];
  const candidates: WorkspaceBootstrapCandidate[] = [];

  if (markers.envrcRoot) {
    if (await commandExists("direnv", cwd, mergedEnv)) {
      candidates.push({
        tool: "direnv",
        command: "direnv",
        args: ["exec", markers.envrcRoot, "env", "-0"],
        sourceDescription: `workspace bootstrap from ${path.join(markers.envrcRoot, ".envrc")} via direnv`,
        successNote: `Loaded workspace bootstrap from ${path.join(markers.envrcRoot, ".envrc")} via direnv.`,
      });
    } else {
      notes.push(
        `Found ${path.join(markers.envrcRoot, ".envrc")} but \`direnv\` was not available in PATH; continuing without repo bootstrap.`,
      );
    }
  }

  if (markers.flakeRoot) {
    if (await commandExists("nix", cwd, mergedEnv)) {
      candidates.push({
        tool: "nix_develop",
        command: "nix",
        args: ["develop", markers.flakeRoot, "--command", "env", "-0"],
        sourceDescription: `workspace bootstrap from ${path.join(markers.flakeRoot, "flake.nix")} via nix develop`,
        successNote: `Loaded workspace bootstrap from ${path.join(markers.flakeRoot, "flake.nix")} via nix develop.`,
      });
    } else {
      notes.push(
        `Found ${path.join(markers.flakeRoot, "flake.nix")} but \`nix\` was not available in PATH; continuing without repo bootstrap.`,
      );
    }
  }

  const nixShellEntry = markers.shellNixPath ?? markers.defaultNixPath;
  if (nixShellEntry) {
    if (await commandExists("nix-shell", cwd, mergedEnv)) {
      candidates.push({
        tool: "nix_shell",
        command: "nix-shell",
        args: [nixShellEntry, "--run", "env -0"],
        sourceDescription: `workspace bootstrap from ${nixShellEntry} via nix-shell`,
        successNote: `Loaded workspace bootstrap from ${nixShellEntry} via nix-shell.`,
      });
    } else {
      notes.push(
        `Found ${nixShellEntry} but \`nix-shell\` was not available in PATH; continuing without repo bootstrap.`,
      );
    }
  }

  for (const candidate of candidates) {
    const probe = await runChildProcess(
      `workspace-bootstrap-${candidate.tool}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      candidate.command,
      candidate.args,
      {
        cwd,
        env: mergedEnv,
        timeoutSec: 120,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if (probe.timedOut) {
      notes.push(
        `Attempted ${candidate.sourceDescription}, but the bootstrap command timed out; continuing without repo bootstrap.`,
      );
      continue;
    }
    if ((probe.exitCode ?? 1) !== 0) {
      const detail =
        firstNonEmptyLine(probe.stderr) ||
        firstNonEmptyLine(probe.stdout) ||
        `exit code ${probe.exitCode ?? -1}`;
      notes.push(
        `Attempted ${candidate.sourceDescription}, but the bootstrap command failed (${detail}); continuing without repo bootstrap.`,
      );
      continue;
    }

    const resolvedEnv = filteredStringEnv(ensurePathInEnv(parseEnvSnapshot(probe.stdout)));
    return {
      env: resolvedEnv,
      notes: [...notes, candidate.successNote],
    };
  }

  return {
    env: mergedEnv,
    notes,
  };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = {
      ...stripAmbientPaperclipEnv(process.env),
      ...opts.env,
    };

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        runningProcesses.set(runId, { child, graceSec: opts.graceSec });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (!child.killed) {
                    child.kill("SIGKILL");
                  }
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
            });
          });
        });
      })
      .catch(reject);
  });
}
