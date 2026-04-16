import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, relativePath: string, name: string) {
  const skillDir = path.join(root, relativePath);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual(["paperclipai/paperclip/paperclip"]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual(["paperclip"]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });

  it("drops stale plugin-cache runtime skill paths after a GitHub plugin refresh", async () => {
    const root = await makeTempDir("paperclip-skill-runtime-refresh-");
    cleanupDirs.add(root);

    const staleSkillDir = await createSkillDir(
      root,
      path.join("codex-home", "plugins", "cache", "openai-curated", "github", "old-hash", "skills", "gh-address-comments"),
      "gh-address-comments",
    );
    const refreshedSkillDir = await createSkillDir(
      root,
      path.join("codex-home", "plugins", "cache", "openai-curated", "github", "new-hash", "skills", "gh-address-comments"),
      "gh-address-comments",
    );
    await fs.rm(staleSkillDir, { recursive: true, force: true });

    const entries = await readPaperclipRuntimeSkillEntries(
      {
        paperclipRuntimeSkills: [
          {
            key: "github:gh-address-comments",
            runtimeName: "gh-address-comments",
            source: staleSkillDir,
          },
          {
            key: "github:gh-address-comments",
            runtimeName: "gh-address-comments",
            source: refreshedSkillDir,
          },
        ],
      },
      path.join(root, "unused", "module"),
    );

    expect(entries).toEqual([
      {
        key: "github:gh-address-comments",
        runtimeName: "gh-address-comments",
        source: refreshedSkillDir,
        required: false,
        requiredReason: null,
      },
    ]);
  });

  it("falls back to bundled skills when every configured runtime skill path is stale", async () => {
    const root = await makeTempDir("paperclip-skill-runtime-fallback-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    const bundledSkillDir = await createSkillDir(root, path.join("skills", "paperclip"), "paperclip");
    const staleSkillDir = path.join(
      root,
      "codex-home",
      "plugins",
      "cache",
      "openai-curated",
      "github",
      "old-hash",
      "skills",
      "gh-address-comments",
    );

    const entries = await readPaperclipRuntimeSkillEntries(
      {
        paperclipRuntimeSkills: [
          {
            key: "github:gh-address-comments",
            runtimeName: "gh-address-comments",
            source: staleSkillDir,
          },
        ],
      },
      moduleDir,
    );

    expect(entries).toEqual([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: bundledSkillDir,
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      },
    ]);
  });
});
