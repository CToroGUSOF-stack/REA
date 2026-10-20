import { afterEach, expect, it, vi } from "vitest";

const tty = vi.hoisted(() => ({
  path: "rea-injected-exit-output-tty",
  fd: 1_000_007,
}));

// Simulate only Linux TTY admission for an injected process. These tests do not
// establish Windows debugger support and never open a real TTY or target.
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  const { constants } = await import("node:fs");
  return {
    ...filesystem,
    realpath: async (...args: Parameters<typeof filesystem.realpath>) =>
      args[0] === tty.path ? tty.path : filesystem.realpath(...args),
    open: async (...args: Parameters<typeof filesystem.open>) =>
      args[0] === tty.path
        ? {
            fd: tty.fd,
            stat: async () => ({
              dev: 7,
              ino: 11,
              mode: constants.S_IFCHR,
            }),
            close: async () => undefined,
          }
        : filesystem.open(...args),
  };
});

vi.mock("node:tty", async (importOriginal) => {
  const terminal = await importOriginal<typeof import("node:tty")>();
  return {
    ...terminal,
    isatty: (fd: number) => fd === tty.fd || terminal.isatty(fd),
  };
});

import { evidenceSchema } from "../../src/domain/evidence.js";
import { stopOwnedDebuggerProcess } from "../../src/process/ownedDebuggerSession.js";
import { RizinDebugSessionManager } from "../../src/rizin/RizinDebugSessionManager.js";
import { createInjectedProcess } from "../boundary/providers/RizinDebugSessionCoverage.fixtures.js";

const managers: RizinDebugSessionManager[] = [];
const controls: ReturnType<typeof createInjectedProcess>["control"][] = [];

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const startInjected = async (
  stopProcess: typeof stopOwnedDebuggerProcess = async () => ({
    status: "stopped",
  }),
) => {
  let commandWritten!: (text: string) => void;
  const written = new Promise<string>((resolve) => {
    commandWritten = resolve;
  });
  const injected = createInjectedProcess({ onWrite: commandWritten });
  controls.push(injected.control);
  const manager = new RizinDebugSessionManager(
    {},
    {
      platform: "linux",
      spawnProcess: injected.spawnProcess,
      // The injected process uses this test runner's PID. Never invoke real
      // process cleanup for that identity.
      stopProcess,
    },
  );
  managers.push(manager);
  const started = await manager.start({
    path: "./exit/../fixture.bin",
    inferior_tty: tty.path,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw started.error;
  return {
    manager,
    sessionId: started.value.session_id,
    control: injected.control,
    written,
  };
};

afterEach(async () => {
  vi.useRealTimers();
  for (const control of controls.splice(0)) control.exit();
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
});

it("retains multiple post-exit NUL frames in partial Evidence until output closes", async () => {
  const fixture = await startInjected();
  let settled = false;
  const execution = fixture.manager
    .execute(fixture.sessionId, "dr")
    .then((result) => {
      settled = true;
      return result;
    });
  await fixture.written;
  fixture.control.output("before-exit\0");
  await nextTurn();
  fixture.control.exitLeader();
  await nextTurn();
  expect(settled).toBe(false);

  fixture.control.output("tail-one\0");
  await nextTurn();
  expect(settled).toBe(false);
  fixture.control.output(
    Buffer.concat([
      Buffer.from("tail-two\0"),
      Buffer.from([0xff, 0]),
      Buffer.from("tail-three\0"),
    ]),
  );
  await nextTurn();
  expect(settled).toBe(false);
  fixture.control.closeOutput();

  const result = await execution;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    command: "dr",
    output: ["before-exit", "tail-one", "tail-two", "�", "tail-three"].join(
      "\n",
    ),
    completion_status: "unknown",
    output_invalid_utf8: true,
  });
  expect(result.value.evidence.normalized_result).toEqual(result.value.result);
  expect(result.value.evidence.raw_result).toEqual(result.value.result);
  expect(result.value.evidence.limitations.join(" ")).toContain(
    "Rizin exited before the command-completion marker",
  );
});

it("accepts a completion marker delivered with post-exit output", async () => {
  const fixture = await startInjected();
  let settled = false;
  const execution = fixture.manager
    .execute(fixture.sessionId, "dr")
    .then((result) => {
      settled = true;
      return result;
    });
  const written = await fixture.written;
  const marker = /!echo (\S+)\n/u.exec(written)?.[1];
  expect(marker).toBeDefined();
  fixture.control.exitLeader();
  await nextTurn();
  expect(settled).toBe(false);
  fixture.control.output("tail-one\0");
  await nextTurn();
  expect(settled).toBe(false);
  fixture.control.output(`tail-two\n${marker}\n\0`);

  const result = await execution;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    output: "tail-one\ntail-two\n",
    completion_status: "complete",
    output_truncated: false,
  });
  expect(result.value.evidence.normalized_result).toEqual(result.value.result);
  expect(result.value.evidence.raw_result).toEqual(result.value.result);
  fixture.control.closeOutput();
});

it("bounds post-exit output draining when inherited output remains open", async () => {
  const fixture = await startInjected();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const execution = fixture.manager
    .execute(fixture.sessionId, "dr")
    .then((result) => {
      settled = true;
      return result;
    });
  await fixture.written;
  fixture.control.output("retained-before-exit\0");
  await nextTurn();
  fixture.control.exitLeader();
  await nextTurn();
  expect(settled).toBe(false);

  // The output drain must finish independently of the 120 s command deadline.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).toBe(true);
  const result = await execution;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    output: "retained-before-exit",
    completion_status: "unknown",
  });
  expect(result.value.evidence.normalized_result).toEqual(result.value.result);
  fixture.control.closeOutput();
});

it("cancels post-exit draining promptly and retains the observed tail", async () => {
  const fixture = await startInjected();
  const abort = new AbortController();
  const execution = fixture.manager.execute(
    fixture.sessionId,
    "dr",
    abort.signal,
  );
  await fixture.written;
  fixture.control.exitLeader();
  await nextTurn();
  fixture.control.output("tail-before-cancellation\0");
  await nextTurn();
  abort.abort();

  const result = await execution;
  if (result.ok) throw new Error("Cancelled command unexpectedly succeeded");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      output: "tail-before-cancellation",
      completion_status: "unknown",
    },
    raw_result: {
      output: "tail-before-cancellation",
      completion_status: "unknown",
    },
  });
  // Cancellation completes while the fixture's output pipe is still open.
  fixture.control.closeOutput();
});

it("preserves completed command facts and verifies cleanup when cancellation follows its marker", async () => {
  const abort = new AbortController();
  const commands: string[] = [];
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      commands.push(text);
      const marker = /!echo (\S+)\n/u.exec(text)?.[1];
      if (marker === undefined) throw new Error("Missing command marker");
      setImmediate(() => {
        if (text.startsWith("dr\n")) {
          control.output(
            Buffer.concat([
              Buffer.from("confirmed-output"),
              Buffer.from([0xff]),
              Buffer.from(`\n${marker}\n\0`),
            ]),
          );
          // The frame waiter resumes first and parses the marker. Abort then
          // runs before execute resumes with the completed command result.
          queueMicrotask(() => abort.abort());
        } else if (text.startsWith("olj\n")) {
          control.output(`[]\n${marker}\n\0`);
        } else {
          throw new Error(`Unexpected injected command: ${text}`);
        }
      });
    },
  });
  controls.push(injected.control);
  const manager = new RizinDebugSessionManager(
    {},
    {
      platform: "linux",
      spawnProcess: injected.spawnProcess,
      // This calls only the injected handle's kill, which emits fake exit and
      // close events. It never sends a signal to the fixture's runner PID.
      stopProcess: stopOwnedDebuggerProcess,
    },
  );
  managers.push(manager);
  const started = await manager.start({
    path: "./fixture.bin",
    inferior_tty: tty.path,
  });
  if (!started.ok) throw started.error;

  const result = await manager.execute(
    started.value.session_id,
    "dr",
    abort.signal,
  );

  if (result.ok) throw new Error("Cancelled command unexpectedly succeeded");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cleanupIncomplete).toBe(false);
  const evidence = evidenceSchema.parse(result.error.partialObservation);
  expect(evidence.normalized_result).toMatchObject({
    output: "confirmed-output�\n",
    completion_status: "complete",
    output_truncated: false,
    output_invalid_utf8: true,
  });
  expect(evidence.raw_result).toEqual(evidence.normalized_result);
  // This readback is skipped if cancellation incorrectly poisons the protocol.
  expect(commands.some((command) => command.startsWith("olj\n"))).toBe(true);
  const closed = await manager.close(started.value.session_id);
  expect(closed).toEqual({ ok: true, value: { target_state: "unknown" } });
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("retains unknown cleanup without claiming a cancelled debugger was stopped", async () => {
  const reason = "injected inferior identity remains unverified";
  let cleanupUnverified = true;
  const fixture = await startInjected(async () =>
    cleanupUnverified
      ? { status: "incomplete", reason }
      : { status: "stopped" },
  );
  const abort = new AbortController();
  const execution = fixture.manager.execute(
    fixture.sessionId,
    "dr",
    abort.signal,
  );
  await fixture.written;
  fixture.control.output("partial-before-cancellation\0");
  await nextTurn();
  abort.abort();

  const result = await execution;
  if (result.ok) throw new Error("Cancelled command unexpectedly succeeded");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([fixture.sessionId]);
  expect(result.error.cause).toMatchObject({ _tag: "AnalysisCancelledError" });
  const evidence = evidenceSchema.parse(result.error.partialObservation);
  expect(evidence.normalized_result).toMatchObject({
    output: "partial-before-cancellation",
    completion_status: "unknown",
  });
  expect(evidence.raw_result).toEqual(evidence.normalized_result);
  expect(evidence.limitations.join(" ")).toContain(reason);
  expect(evidence.limitations.join(" ")).toContain("retained");
  expect(evidence.limitations.join(" ")).not.toContain("was stopped");
  expect(fixture.manager.status(fixture.sessionId)?.state).toBe("closed");

  cleanupUnverified = false;
  expect(await fixture.manager.close(fixture.sessionId)).toEqual({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(fixture.manager.status(fixture.sessionId)).toBeUndefined();
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("keeps Windows platform admission closed before spawning a debugger", async () => {
  const injected = createInjectedProcess();
  controls.push(injected.control);
  const spawnProcess = vi.fn(injected.spawnProcess);
  const manager = new RizinDebugSessionManager(
    {},
    {
      platform: "win32",
      spawnProcess,
      stopProcess: async () => ({ status: "stopped" }),
    },
  );
  managers.push(manager);

  const result = await manager.start({
    path: "./fixture.bin",
    inferior_tty: tty.path,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("require Linux");
  expect(spawnProcess).not.toHaveBeenCalled();
});

it.each([
  { name: "an unterminated marker", terminated: false, protocolFailure: false },
  {
    name: "a genuine protocol failure",
    terminated: true,
    protocolFailure: true,
  },
])(
  "keeps post-exit completion unknown with $name",
  async ({ terminated, protocolFailure }) => {
    const fixture = await startInjected();
    const execution = fixture.manager.execute(fixture.sessionId, "dr");
    const written = await fixture.written;
    const marker = /!echo (\S+)\n/u.exec(written)?.[1];
    expect(marker).toBeDefined();
    fixture.control.exitLeader();
    await nextTurn();
    fixture.control.output(
      `guarded-tail\n${marker}\n${terminated ? "\0" : ""}`,
    );
    if (protocolFailure) fixture.control.stdinError();
    fixture.control.closeOutput();

    const result = await execution;
    expect(result.ok).toBe(!protocolFailure);
    const evidence = evidenceSchema.parse(
      result.ok ? result.value.evidence : result.error.partialObservation,
    );
    expect(evidence.normalized_result).toMatchObject({
      output: "guarded-tail\n",
      completion_status: "unknown",
      output_truncated: false,
    });
    expect(evidence.raw_result).toEqual(evidence.normalized_result);
    if (protocolFailure) {
      if (result.ok)
        throw new Error("Expected the genuine stdin protocol failure");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(evidence.limitations.join(" ")).toContain(
        "Rizin stdin stream failed: injected stdin error",
      );
    }
  },
);
