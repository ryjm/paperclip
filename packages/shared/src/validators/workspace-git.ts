import { z } from "zod";

export const localWorkspaceGitStateSchema = z.object({
  repoRoot: z.string().nullable(),
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  trackedRef: z.string().nullable(),
  hasDirtyTrackedFiles: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
}).strict();
