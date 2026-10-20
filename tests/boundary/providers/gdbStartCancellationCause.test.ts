import { expect, it, vi } from "vitest";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

it("keeps the caller's abort reason for an already-aborted signal", async () => {
  const spawnProcess = vi.fn(async () => {
    throw new Error("must not spawn");
  });
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: "unused" },
    spawnProcess,
  });
  const controller = new AbortController();
  const reason = Object.freeze({ requested: "stop" });
  controller.abort(reason);
  const result = await manager.start(controller.signal);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error.cause).toBe(reason);
  expect(spawnProcess).not.toHaveBeenCalled();
});
