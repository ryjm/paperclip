import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CapturePayload = {
  argv: string[];
  cwd: string;
};

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  console.log("provider  model");
  console.log("openai    gpt-4.1-mini");
  process.exit(0);
}
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
  }), "utf8");
}
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
}));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "pi ok" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } },
  },
  toolResults: [],
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi execute", () => {
  it("runs inside the resolved agent-home workspace instead of the configured cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-home-cwd-"));
    const configuredWorkspace = path.join(root, "configured-workspace");
    const agentHomeWorkspace = path.join(root, "agent-home-workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const previousHome = process.env.HOME;

    await fs.mkdir(configuredWorkspace, { recursive: true });
    await fs.mkdir(agentHomeWorkspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    process.env.HOME = root;
    vi.resetModules();

    const { execute, resetPiModelsCacheForTests } = await import("@paperclipai/adapter-pi-local/server");

    try {
      const result = await execute({
        runId: "run-agent-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: configuredWorkspace,
          model: "openai/gpt-4.1-mini",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Continue your Paperclip work.",
        },
        context: {
          paperclipWorkspace: {
            source: "agent_home",
            cwd: agentHomeWorkspace,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.cwd).toBe(agentHomeWorkspace);
    } finally {
      resetPiModelsCacheForTests();
      vi.resetModules();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
