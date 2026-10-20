import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

/** Match the native owner's ordinary spelling only for extended local drive paths. */
const localDrivePath = (path: string): string =>
  path.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, "");

const guardianSource = fileURLToPath(
  new URL("../../scripts/rea-android-workspace-guardian.mjs", import.meta.url),
);
const readySchema = z.strictObject({
  path: z.string(),
  volumeSerial: z.string().regex(/^[a-f0-9]{16}$/u),
  fileId: z.string().regex(/^[a-f0-9]{32}$/u),
  privateDacl: z.literal(true),
});

/** Parse the guardian's one-line UTF-8 readiness frame without depending on pipe chunk boundaries. */
export const readGuardianReadyLine = (stdout: Readable): Promise<string> =>
  new Promise((resolve, reject) => {
    const frame = Buffer.alloc(4096);
    let length = 0;
    const onError = (cause: Error): void => {
      stdout.off("data", onData);
      reject(cause);
    };
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(10);
      const fragmentLength = newline === -1 ? chunk.length : newline;
      const nextLength = length + fragmentLength;
      if (nextLength + (newline === -1 ? 0 : 1) > frame.length) {
        stdout.off("data", onData);
        reject(
          new Error("Android workspace guardian readiness exceeded 4 KiB"),
        );
        return;
      }
      chunk.copy(frame, length, 0, fragmentLength);
      length = nextLength;
      if (newline === -1) return;
      stdout.off("data", onData);
      try {
        resolve(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            frame.subarray(0, length),
          ),
        );
      } catch (cause) {
        reject(cause);
      }
    };
    stdout.on("data", onData);
    // Retain an error listener after readiness, as the child pipe can fail later.
    stdout.once("error", onError);
  });

/** The Android provider needs a path and a cleanup owner, regardless of host. */
export interface JadxWorkspaceRoot {
  readonly path: string;
  readonly failureSignal?: AbortSignal;
  close(): Promise<void>;
}

type GuardianExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};

const boundedWait = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** A detached guardian retains native cleanup ownership without keeping its caller alive. */
const releaseGuardianReferences = (
  child: ChildProcessWithoutNullStreams,
): void => {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
};

class WindowsJadxWorkspaceRoot implements JadxWorkspaceRoot {
  readonly #failure = new AbortController();
  readonly failureSignal = this.#failure.signal;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<GuardianExit>;
  readonly #diagnostics: () => string;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    readonly path: string,
    child: ChildProcessWithoutNullStreams,
    exit: Promise<GuardianExit>,
    diagnostics: () => string,
  ) {
    this.#child = child;
    this.#exit = exit;
    this.#diagnostics = diagnostics;
    void this.#exit.then((result) => {
      if (!this.#closing)
        this.#failure.abort(
          new Error(
            `Android workspace guardian exited before cleanup: ${result.error?.message ?? result.code ?? result.signal ?? "unknown"}`,
          ),
        );
    });
  }

  static async create(): Promise<WindowsJadxWorkspaceRoot> {
    const parent = tmpdir();
    const child = spawn(process.execPath, [guardianSource, parent], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: parent,
        TMP: parent,
      },
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
    });
    const exit = new Promise<GuardianExit>((resolve) => {
      child.once("error", (error: Error) =>
        resolve({ code: null, signal: null, error }),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const ready = readGuardianReadyLine(child.stdout);
    try {
      const line = await boundedWait(
        Promise.race([
          ready,
          exit.then((result) => {
            throw new Error(
              `Android workspace guardian exited during startup: ${result.error?.message ?? result.code ?? result.signal ?? "unknown"}; ${diagnostics}`,
            );
          }),
        ]),
        15000,
        "Android workspace guardian startup timed out",
      );
      const observation = readySchema.parse(JSON.parse(line));
      if (
        win32.dirname(localDrivePath(observation.path)).toLowerCase() !==
          localDrivePath(win32.resolve(parent)).toLowerCase() ||
        !/^rea-android-[a-f0-9]{32}$/u.test(win32.basename(observation.path))
      )
        throw new Error(
          "Android workspace guardian returned an unexpected root",
        );
      child.stdout.resume();
      return new WindowsJadxWorkspaceRoot(
        observation.path,
        child,
        exit,
        () => diagnostics,
      );
    } catch (cause) {
      if (!child.stdin.destroyed) child.stdin.end();
      try {
        await boundedWait(
          exit,
          30000,
          "Android workspace guardian did not settle after startup failure",
        );
      } catch (cleanupFailure) {
        throw new AggregateError(
          [cause, cleanupFailure],
          "Android workspace guardian startup and cleanup failed",
        );
      } finally {
        releaseGuardianReferences(child);
      }
      throw cause;
    }
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#finish().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  async #finish(): Promise<void> {
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    let result: GuardianExit;
    try {
      result = await boundedWait(
        this.#exit,
        120000,
        `Android workspace guardian cleanup timed out for ${this.path}`,
      );
    } catch (cause) {
      releaseGuardianReferences(this.#child);
      throw cause;
    }
    if (result.error !== undefined || result.code !== 0)
      throw new Error(
        `Android workspace guardian cleanup failed for ${this.path}: ${result.error?.message ?? result.code ?? result.signal ?? "unknown"}; ${this.#diagnostics()}`,
      );
    try {
      await lstat(this.path);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return;
      throw cause;
    }
    throw new Error(
      `Android workspace guardian exited but retained ${this.path}`,
    );
  }
}

/** POSIX retains its in-process root; Windows keeps a detached native owner. */
export const createJadxWorkspaceRoot = (): Promise<JadxWorkspaceRoot> =>
  process.platform === "win32"
    ? WindowsJadxWorkspaceRoot.create()
    : PrivateRuntimeRoot.create({ prefix: "rea-android-" });
