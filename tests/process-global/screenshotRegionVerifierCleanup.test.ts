import { stat } from "node:fs/promises";

import { beforeEach, expect, it, vi } from "vitest";

import { finishScreenshotVerifier } from "../../scripts/lib/browser-screenshot-verifier-cleanup.mjs";
import {
  completeVerifierRun,
  type VerifierRun,
} from "../../scripts/lib/verifier-run.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

vi.mock("../../scripts/lib/verifier-run.mjs", () => ({
  completeVerifierRun: vi.fn(),
}));

const run = {
  run_id: "screenshot-verifier-test",
  verifier_pid: 100,
  parent_pid: 99,
};
const completed: VerifierRun = {
  ...run,
  process_lineage: {
    status: "verified",
    observed_at: "2026-01-01T00:00:00.000Z",
    launcher_pid: 100,
    launcher_parent_pid: 99,
    process_group_id: 100,
    descendants: [],
  },
};

beforeEach(() => {
  vi.mocked(completeVerifierRun).mockReset().mockResolvedValue(completed);
});

it("releases the workspace only after every close and the lineage check", async () => {
  const workspace = await createTestTempDirectory("rea-screenshot-cleanup-");
  const closed: string[] = [];
  vi.mocked(completeVerifierRun).mockImplementation(async () => {
    expect(closed).toEqual(["client", "transport", "browser"]);
    expect((await stat(workspace)).isDirectory()).toBe(true);
    return completed;
  });
  expect(
    await finishScreenshotVerifier(run, workspace, [
      () => {
        closed.push("client");
      },
      async () => {
        closed.push("transport");
      },
      async () => {
        closed.push("browser");
      },
    ]),
  ).toBe(completed);
  await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["client", "transport", "browser"])(
  "retains inputs and attempts every close after a %s failure",
  async (failed) => {
    const workspace = await createTestTempDirectory("rea-screenshot-cleanup-");
    const primary = new Error("comparison failed");
    const cleanup = new Error(`${failed} close failed`);
    const closed: string[] = [];
    const tasks = ["client", "transport", "browser"].map((name) => () => {
      closed.push(name);
      if (name === failed) {
        if (name === "client") throw cleanup;
        return Promise.reject(cleanup);
      }
      return undefined;
    });
    await expect(
      finishScreenshotVerifier(run, workspace, tasks, [primary]),
    ).rejects.toMatchObject({ errors: [primary, cleanup] });
    expect(closed).toEqual(["client", "transport", "browser"]);
    expect(completeVerifierRun).toHaveBeenCalledWith(run);
    expect((await stat(workspace)).isDirectory()).toBe(true);
  },
);

it("collects multiple close failures even without a verification failure", async () => {
  const workspace = await createTestTempDirectory("rea-screenshot-cleanup-");
  const failures = [new Error("client"), new Error("browser")];
  await expect(
    finishScreenshotVerifier(
      run,
      workspace,
      failures.map((failure) => async () => {
        throw failure;
      }),
    ),
  ).rejects.toMatchObject({ errors: failures });
  expect((await stat(workspace)).isDirectory()).toBe(true);
});

it.each(["live", "unavailable", "error"])(
  "rejects %s lineage and retains the workspace",
  async (kind) => {
    const workspace = await createTestTempDirectory("rea-screenshot-cleanup-");
    if (kind === "error")
      vi.mocked(completeVerifierRun).mockRejectedValue(
        new Error("snapshot failed"),
      );
    else
      vi.mocked(completeVerifierRun).mockResolvedValue({
        ...run,
        process_lineage:
          kind === "live"
            ? {
                ...completed.process_lineage,
                status: "verified",
                descendants: [
                  { pid: 101, parent_pid: 100, process_group_id: 100 },
                ],
                process_group_id: 100,
              }
            : {
                ...completed.process_lineage,
                status: "unavailable",
                reason: "identity could not be verified",
              },
      });
    await expect(finishScreenshotVerifier(run, workspace, [])).rejects.toThrow(
      "cleanup failed",
    );
    expect((await stat(workspace)).isDirectory()).toBe(true);
  },
);

it("preserves a verification failure when cleanup succeeds", async () => {
  const workspace = await createTestTempDirectory("rea-screenshot-cleanup-");
  const primary = new Error("comparison failed");
  await expect(
    finishScreenshotVerifier(run, workspace, [], [primary]),
  ).rejects.toMatchObject({ errors: [primary] });
  await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});
