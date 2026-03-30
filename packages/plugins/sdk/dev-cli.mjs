#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const distCliPath = path.join(packageDir, "dist", "dev-cli.js");

if (existsSync(distCliPath)) {
  await import(pathToFileURL(distCliPath).href);
} else {
  const repoRoot = path.resolve(packageDir, "..", "..", "..");
  const tsxCliPath = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const sourceCliPath = path.join(packageDir, "src", "dev-cli.ts");

  if (!existsSync(tsxCliPath)) {
    console.error(
      `paperclip-plugin-dev-server could not find ${path.relative(packageDir, distCliPath)} or ${path.relative(packageDir, tsxCliPath)}.`,
    );
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [tsxCliPath, sourceCliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}
