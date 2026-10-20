import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  resolveWakaruCommand,
  runWakaruCommand,
  type WakaruLauncher,
} from "./WakaruCommand.js";
import {
  RECOVERY_LIMITATIONS,
  RECOVERY_LIMITS,
  recoveryLimitations,
} from "./WakaruRelease.js";

it("names the Wakaru configuration requirement when it is not configured", async () => {
  const refusal: unknown = await resolveWakaruCommand({}).catch(
    (cause: unknown) => cause,
  );

  if (!(refusal instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected a capability refusal");
  expect(refusal.reason).toContain("REA_WAKARU_COMMAND");
  expect(projectAnalysisError(refusal)).toMatchObject({
    code: "capability_unavailable",
    message: refusal.reason,
    remediation: { action: refusal.reason },
  });
});

it("rejects an exhausted shared execution budget before launching the next command", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() - 1,
      launcher: async () => {
        throw new Error("An expired budget must not launch");
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisTimeoutError",
    operation: "recover_javascript_sources",
  });
});

it("preserves caller cancellation before acquiring an expired execution budget", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() - 1,
      signal: AbortSignal.abort(),
      launcher: async () => {
        throw new Error("A cancelled request must not launch");
      },
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
});

const commandFixture = (
  emit: (producer: ReturnType<typeof createProducer>) => void,
) => {
  const producer = createProducer();
  const launcher: WakaruLauncher = async (options) => {
    setImmediate(() => emit(producer));
    return {
      process: producer,
      ownership: {
        runId: options.runId,
        leaderPid: 12345,
        processGroupId: 12345,
        expectedParentPid: process.pid,
      },
      cleanup: async () => ({ cleaned: true, signaled: false }),
    };
  };
  return {
    producer,
    context: {
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() + 5_000,
      launcher,
    },
  };
};

const createProducer = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });

it("retains stdout and stderr delivered after launcher exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.stdout.write("first");
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stdout.end("last");
      producer.stderr.end("diagnostic");
      producer.emit("close", 0, null);
    });
  });
  await expect(runWakaruCommand(context)).resolves.toMatchObject({
    exit_code: 0,
    signal: null,
    stdout: "firstlast",
    stderr: "diagnostic",
  });
});

it("checks the diagnostic byte limit against output delivered after exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stderr.end(Buffer.alloc(RECOVERY_LIMITS.reportBytes + 1, 97));
      producer.stdout.end();
      producer.emit("close", 0, null);
    });
  });
  await expect(runWakaruCommand(context)).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "recover_javascript_sources",
  });
});

it("enforces the shared deadline while exited output streams remain open", async () => {
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
  });
  try {
    await expect(
      runWakaruCommand({ ...context, deadline: performance.now() + 50 }),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      operation: "recover_javascript_sources",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("honors cancellation while waiting for output after exit", async () => {
  const controller = new AbortController();
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
    setImmediate(() => controller.abort());
  });
  try {
    await expect(
      runWakaruCommand({ ...context, signal: controller.signal }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

const posixOnly = it.skipIf(process.platform === "win32");

const withExecutable = async (
  body: string,
  use: (path: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-wakaru-host-"));
  try {
    const path = join(root, "wakaru");
    await writeFile(path, body);
    await chmod(path, 0o700);
    await use(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

it("refuses hosts without a verified resource limiter and names the supported hosts", async () => {
  const refusal: unknown = await resolveWakaruCommand(
    { REA_WAKARU_COMMAND: "/selected/wakaru" },
    { platform: "win32", arch: "x64" },
  ).catch((cause: unknown) => cause);

  if (!(refusal instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected a capability refusal");
  expect(refusal.reason).toContain("Linux x64 or macOS arm64");
});

posixOnly(
  "selects the shell limiter on macOS arm64 without requiring prlimit",
  async () => {
    await withExecutable("#!/bin/sh\n", async (command) => {
      await expect(
        resolveWakaruCommand(
          { REA_WAKARU_COMMAND: command },
          { platform: "darwin", arch: "arm64" },
        ),
      ).resolves.toMatchObject({
        limiter: "/bin/sh",
        limiterKind: "shell-ulimit",
      });
    });
  },
);

posixOnly("ignores the prlimit override on macOS", async () => {
  await withExecutable("#!/bin/sh\n", async (command) => {
    await expect(
      resolveWakaruCommand(
        {
          REA_WAKARU_COMMAND: command,
          REA_JAVASCRIPT_PRLIMIT_COMMAND: "relative/prlimit",
        },
        { platform: "darwin", arch: "arm64" },
      ),
    ).resolves.toMatchObject({ limiter: "/bin/sh" });
  });
});

it("keeps the Linux limiter invocation unchanged", async () => {
  const seen: string[][] = [];
  const { context } = commandFixture((producer) => {
    producer.stdout.end();
    producer.stderr.end();
    producer.emit("exit", 0, null);
    producer.emit("close", 0, null);
  });
  await runWakaruCommand({
    ...context,
    launcher: async (options) => {
      seen.push([options.command, ...options.arguments]);
      return context.launcher(options);
    },
  });
  expect(seen[0]).toEqual([
    "/usr/bin/prlimit",
    `--as=${String(RECOVERY_LIMITS.addressSpaceBytes)}`,
    `--fsize=${String(RECOVERY_LIMITS.outputBytes)}`,
    "--core=0",
    "--cpu=120",
    "--",
    "/selected/wakaru",
    "--version",
  ]);
});

it("passes the engine to the shell limiter as positional arguments, not interpolated text", async () => {
  const seen: string[][] = [];
  const { context } = commandFixture((producer) => {
    producer.stdout.end();
    producer.stderr.end();
    producer.emit("exit", 0, null);
    producer.emit("close", 0, null);
  });
  await runWakaruCommand({
    ...context,
    command: "/path with spaces/$(touch pwned)/wakaru",
    limiter: "/bin/sh",
    limiterKind: "shell-ulimit",
    arguments: ["--version", "a;b"],
    launcher: async (options) => {
      seen.push([options.command, ...options.arguments]);
      return context.launcher(options);
    },
  });
  const [command, flag, script, zero, ...rest] = seen[0] ?? [];
  expect(command).toBe("/bin/sh");
  expect(flag).toBe("-c");
  expect(script).toContain("ulimit -f 262144");
  expect(script).toContain("ulimit -c 0");
  expect(script).toContain("ulimit -t 120");
  expect(script).toContain('exec "$0" "$@"');
  expect(script).not.toContain("pwned");
  expect(zero).toBe("/path with spaces/$(touch pwned)/wakaru");
  expect(rest).toEqual(["--version", "a;b"]);
});

it("states on macOS that no memory ceiling is enforced and keeps Linux wording unchanged", () => {
  expect(recoveryLimitations("prlimit")).toEqual(RECOVERY_LIMITATIONS);
  expect(RECOVERY_LIMITATIONS.at(-1)).toContain("1 GiB address-space ceiling");
  const mac = recoveryLimitations("shell-ulimit");
  expect(mac.slice(0, -1)).toEqual(RECOVERY_LIMITATIONS.slice(0, -1));
  expect(mac.at(-1)).toContain("macOS adapter");
  expect(mac.at(-1)).toContain("memory use is not capped");
  expect(mac.at(-1)).not.toContain("1 GiB address-space ceiling");
});

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "applies the output, core and CPU limits before starting the engine on macOS",
  async () => {
    await withExecutable(
      "#!/bin/sh\nulimit -f\nulimit -c\nulimit -t\n",
      async (command) => {
        const result = await runWakaruCommand({
          command,
          limiter: "/bin/sh",
          limiterKind: "shell-ulimit",
          arguments: [],
          cwd: tmpdir(),
          environment: process.env,
          deadline: performance.now() + 10_000,
        });
        expect(result.exit_code).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
          String(RECOVERY_LIMITS.outputBytes / 512),
          "0",
          String(RECOVERY_LIMITS.timeoutMs / 1000),
        ]);
      },
    );
  },
);
