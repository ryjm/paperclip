import { describe, expect, it } from "vitest";
import { reconcileStaleExecutionLocks } from "../services/issues.ts";

describe("reconcileStaleExecutionLocks", () => {
  it("returns the cleared row when the stale execution lock update succeeds", async () => {
    const originalRow = {
      id: "issue-1",
      executionRunId: "stale-run",
      executionLockedAt: new Date("2026-03-31T00:00:00.000Z"),
    };
    const clearedRow = {
      ...originalRow,
      executionRunId: null,
      executionLockedAt: null,
    };

    let selectCallCount = 0;
    const fakeDb = {
      select() {
        return {
          from() {
            return {
              where() {
                selectCallCount += 1;
                return Promise.resolve([]);
              },
            };
          },
        };
      },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([clearedRow]);
                  },
                };
              },
            };
          },
        };
      },
    };

    const [result] = await reconcileStaleExecutionLocks(fakeDb, [originalRow]);

    expect(result).toEqual(clearedRow);
    expect(selectCallCount).toBe(1);
  });

  it("refetches the current issue row when clearing the stale lock loses a race", async () => {
    const originalRow = {
      id: "issue-1",
      executionRunId: "stale-run",
      executionLockedAt: new Date("2026-03-31T00:00:00.000Z"),
    };
    const currentRow = {
      id: "issue-1",
      executionRunId: "live-run",
      executionLockedAt: new Date("2026-03-31T00:05:00.000Z"),
    };

    let selectCallCount = 0;
    const fakeDb = {
      select() {
        return {
          from() {
            return {
              where() {
                selectCallCount += 1;
                if (selectCallCount === 1) {
                  return Promise.resolve([]);
                }
                return Promise.resolve([currentRow]);
              },
            };
          },
        };
      },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([]);
                  },
                };
              },
            };
          },
        };
      },
    };

    const [result] = await reconcileStaleExecutionLocks(fakeDb, [originalRow]);

    expect(result).toEqual(currentRow);
    expect(selectCallCount).toBe(2);
  });
});
