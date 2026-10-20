import type { FileHandle } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";

const fault = vi.hoisted(() => ({
  path: "",
  beforeRead: undefined as (() => void) | undefined,
  onClose: undefined as (() => void) | undefined,
  denyClose: false,
  readFailure: undefined as Error | undefined,
  handles: [] as FileHandle[],
}));

// The provider has no filesystem injection seam. Keep module interception in
// an isolated worker and use real Linux admission, file reads and closes.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const value = await original.readFile(...args);
      if (args[0] === "/proc/self/limits") fault.beforeRead?.();
      return value;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (args[0] !== fault.path) return handle;
      fault.handles.push(handle);
      const close = handle.close.bind(handle);
      if (fault.readFailure !== undefined) {
        const failure = fault.readFailure;
        handle.stat = async () => {
          throw failure;
        };
      }
      handle.close = async () => {
        if (fault.denyClose) {
          fault.onClose?.();
          throw new Error("controlled descriptor close failure");
        }
        await close();
        fault.onClose?.();
      };
      return handle;
    },
  };
});

import { EvmInterfaceService } from "../../src/application/evm/EvmInterfaceService.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
} from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { EvmoleInterfaceProvider } from "../../src/evm/EvmoleInterfaceProvider.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

const supportedHost = process.platform === "linux" && process.arch === "x64";

const fixture = async () => {
  const workspace = await createTestWorkspace("rea-evm-artifact-cancellation-");
  fault.path = await workspace.write("selected.hex", "0x60006000f3\n");
  fault.beforeRead = undefined;
  fault.onClose = undefined;
  fault.denyClose = false;
  fault.readFailure = undefined;
  fault.handles = [];
  const createRuntime = vi.fn(async () => {
    throw new Error("Carrier failure must not start the worker runtime");
  });
  const provider = new EvmoleInterfaceProvider({}, undefined, createRuntime);
  onTestFinished(async () => {
    fault.beforeRead = undefined;
    fault.onClose = undefined;
    fault.denyClose = false;
    try {
      await provider.close();
    } finally {
      for (const handle of fault.handles)
        if (handle.fd >= 0) await handle.close();
      await removeTestWorkspace(workspace.root);
    }
  });
  return {
    path: fault.path,
    provider,
    service: new EvmInterfaceService(provider),
    createRuntime,
  };
};

it
  .runIf(supportedHost)
  .each([
    "pre-aborted",
    "read-admission",
    "confirmed-close",
    "failed-close",
  ] as const)("preserves caller cancellation through %s", async (stage) => {
  const { path, provider, service, createRuntime } = await fixture();
  const controller = new AbortController();
  const reason = { requested: "stop reading this carrier" };
  const abort = () => controller.abort(reason);
  if (stage === "pre-aborted") abort();
  else if (stage === "read-admission") fault.beforeRead = abort;
  else fault.onClose = abort;
  fault.denyClose = stage === "failed-close";

  const result = await service.inspect(
    { path, encoding: "hex" },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected carrier cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(createRuntime).not.toHaveBeenCalled();
  expect(result.error.cleanupIncomplete).toBe(stage === "failed-close");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: stage === "failed-close" ? "cleanup_incomplete" : "cancelled",
    details: {
      operation: "inspect_evm_interface",
      cleanup: stage === "failed-close" ? "incomplete" : "complete",
    },
  });
  expect(fault.handles).toHaveLength(stage.endsWith("close") ? 1 : 0);
  if (stage === "failed-close") {
    expect(result.error.cleanupResources).toContain(path);
    expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    fault.denyClose = false;
    await provider.close();
  }
  expect(fault.handles.every((handle) => handle.fd === -1)).toBe(true);
});

it.runIf(supportedHost).each([false, true])(
  "preserves a physical read failure over late cancellation (failed close: %s)",
  async (failedClose) => {
    const { path, provider, service, createRuntime } = await fixture();
    const failure = Object.assign(new Error("controlled read denial"), {
      code: "EACCES",
    });
    const controller = new AbortController();
    fault.readFailure = failure;
    fault.onClose = () => controller.abort("later caller cancellation");
    fault.denyClose = failedClose;
    const result = await service.inspect(
      { path, encoding: "hex" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected physical read failure");
    expect(result.error).not.toBeInstanceOf(AnalysisCancelledError);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(result.error.cleanupIncomplete).toBe(failedClose);
    if (!failedClose) {
      expect(result.error).toBeInstanceOf(AnalysisAccessDeniedError);
      expect(result.error.cause).toBe(failure);
    } else {
      expect(result.error.cleanupResources).toContain(path);
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      fault.denyClose = false;
      await provider.close();
    }
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]?.fd).toBe(-1);
  },
);
