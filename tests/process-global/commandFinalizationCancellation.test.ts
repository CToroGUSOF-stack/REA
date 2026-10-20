import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cli } from "incur";
import { afterEach, expect, it, vi } from "vitest";

import { WasmArtifactService } from "../../src/application/wasm/WasmArtifactService.js";
import { registerAnalysisViewCommands } from "../../src/cli/analysisViewCommands.js";
import { registerWasmCommands } from "../../src/cli/wasmCommands.js";
import { wasmArtifactModule } from "../../src/composition/wasm.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err, ok } from "../../src/domain/result.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import { silentLogger } from "../../src/logger.js";
import { analysisViewLayoutEvidence } from "../fixtures/analysisView.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  wasmArtifactExecution,
  wasmArtifactFixture,
} from "../fixtures/wasm/artifact.js";

const host = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  get exitCode() {
    return process.exitCode;
  },
  set exitCode(value: typeof process.exitCode) {
    process.exitCode = value;
  },
  on(signal: string, listener: () => void) {
    this.listeners.set(signal, listener);
  },
  off(signal: string, listener: () => void) {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  },
}));

vi.mock("../../src/cli/commandCancellation.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/cli/commandCancellation.js")
    >();
  return {
    ...original,
    withCommandCancellation: <Value>(
      operation: (signal: AbortSignal) => Promise<Value>,
    ) => original.withCommandCancellation(operation, host),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  host.listeners.clear();
});

it.each([
  "control",
  "interrupt",
  "primary-failure",
  "cleanup-failure",
  "interrupt-cleanup-failure",
] as const)(
  "finishes the registered WASM command through final close: %s",
  async (scenario) => {
    const value = wasmArtifactFixture();
    const primary = new AnalysisOutputError(
      "inspect_wasm_artifact",
      "primary reply failure",
    );
    const cleanup = new ProviderCleanupError(
      "wabt-artifact",
      ["exact-owned-root"],
      { reason: "close refused" },
      { operation: "inspect_wasm_artifact" },
    );
    let closed = false;
    const service = new WasmArtifactService({
      inspect: async () =>
        scenario === "primary-failure"
          ? err(primary)
          : ok(wasmArtifactExecution(value)),
      close: async () => {
        await Promise.resolve();
        if (scenario !== "control" && scenario !== "cleanup-failure")
          host.listeners.get("SIGINT")?.();
        closed = true;
        if (
          scenario === "cleanup-failure" ||
          scenario === "interrupt-cleanup-failure"
        )
          throw cleanup;
      },
    });
    vi.spyOn(wasmArtifactModule, "create").mockReturnValue(service);
    const cli = Cli.create("finalization-test", { sync: false });
    registerWasmCommands(cli, silentLogger, {});
    let output = "";
    const previousExitCode = process.exitCode;
    let exitCode;
    try {
      process.exitCode = undefined;
      await cli.serve(
        ["inspect-wasm-artifact", value.artifact.path, "--json"],
        {
          stdout: (part) => {
            output += part;
          },
          exit: () => {},
        },
      );
      exitCode = process.exitCode;
    } finally {
      process.exitCode = previousExitCode;
    }
    const result = JSON.parse(output);
    expect(closed).toBe(true);
    expect(host.listeners.size).toBe(0);
    if (scenario === "control") {
      expect(result.normalized_result).toEqual(value);
      expect(exitCode).toBeUndefined();
    } else if (scenario === "primary-failure") {
      expect(result).toMatchObject({
        code: "unreadable_output",
        details: { reason: "primary reply failure" },
      });
      expect(exitCode).toBe(130);
    } else {
      expect(result).toMatchObject({
        code: scenario === "interrupt" ? "cancelled" : "cleanup_incomplete",
        details: {
          partial_observation: {
            operation: "inspect_wasm_artifact",
            normalized_result: value,
          },
          ...(scenario === "interrupt"
            ? {}
            : { resources: ["exact-owned-root"] }),
        },
      });
      if (scenario !== "cleanup-failure") expect(exitCode).toBe(130);
    }
  },
);

it.each([
  ["bundle", "control"],
  ["bundle", "SIGINT"],
  ["bundle", "SIGTERM"],
  ["evidence-file", "control"],
  ["evidence-file", "SIGINT"],
  ["evidence-file", "SIGTERM"],
] as const)(
  "preserves the analysis-view exit status after %s close and logging: %s",
  async (source, signal) => {
    const root = await createTestTempDirectory("rea-analysis-view-signal-");
    const parent = analysisViewLayoutEvidence();
    const filename = source === "bundle" ? "bundle.json" : "evidence.json";
    const path = join(root, filename);
    await writeFile(
      path,
      JSON.stringify(
        source === "bundle" ? createEvidenceBundle([parent]) : parent,
      ),
    );
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        await originalClose.call(this);
        expect(this.handle.fd).toBe(-1);
        if (signal !== "control") {
          expect(host.listeners.has(signal)).toBe(true);
          host.listeners.get(signal)!();
        }
      });
    const cli = Cli.create("analysis-view-finalization-test", { sync: false });
    registerAnalysisViewCommands(cli, silentLogger);
    let output = "";
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await cli.serve(
        [
          "inspect-analysis-view",
          JSON.stringify({
            source:
              source === "bundle"
                ? { kind: "retained-evidence", evidence_id: parent.evidence_id }
                : { kind: "evidence-file", path },
            view: { kind: "summary" },
          }),
          ...(source === "bundle" ? ["--evidence-bundle", path] : []),
          "--json",
        ],
        {
          stdout: (part) => {
            output += part;
          },
          exit: () => {},
        },
      );
      expect(close).toHaveBeenCalledOnce();
      expect(host.listeners.size).toBe(0);
      expect(await readdir(root)).toEqual([filename]);
      expect(JSON.parse(output)).toMatchObject(
        signal === "control"
          ? { operation: "inspect_analysis_view" }
          : { code: "cancelled" },
      );
      expect(process.exitCode ?? 0).toBe(
        signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0,
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  },
);
