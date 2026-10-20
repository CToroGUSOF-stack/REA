import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonValue } from "../domain/jsonValue.js";

/** A Leandec MCP tool answered with isError=true; text is its own message. */
export class LeandecToolError extends Error {
  readonly _tag = "LeandecToolError";
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
  }
}

/** The MCP transport failed: process exit, malformed frame or JSON-RPC error. */
export class LeandecRpcError extends Error {
  readonly _tag = "LeandecRpcError";
  constructor(
    readonly reason: "exit" | "frame" | "rpc" | "spawn",
    message: string,
    readonly capturedOutput: string,
  ) {
    super(message);
  }
}

/** A pending call exceeded its deadline or the caller cancelled it. */
export class LeandecCallCancelled extends Error {
  readonly _tag = "LeandecCallCancelled";
  constructor(
    readonly reason: "timeout" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

interface PendingCall {
  readonly resolve: (result: JsonValue) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/** Bounded stderr retained for diagnostics instead of unbounded memory growth. */
const STDERR_LIMIT = 16 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface LeandecMcpClientOptions {
  readonly python: string;
  readonly server: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly defaultTimeoutMs: number;
}

/**
 * One Leandec stdio MCP session. Leandec's own MCP server owns target
 * resolution, its SQLite cache and the project lock, so this client never
 * touches Ghidra or the cache directly.
 */
export class LeandecMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingCall>();
  readonly #options: LeandecMcpClientOptions;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #exit:
    | { readonly code: number | null; readonly signal: string | null }
    | undefined;
  #closed = false;
  #handshake: Promise<void> | undefined;
  #serverVersion: string | undefined;

  constructor(options: LeandecMcpClientOptions) {
    this.#options = options;
    this.#child = spawn(options.python, [options.server], {
      cwd: options.cwd,
      env: { ...options.environment } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.#child.on("error", (cause: Error) => {
      this.#failAll(new LeandecRpcError("spawn", cause.message, this.#stderr));
    });
    this.#child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      const detail =
        signal === null ? `exit ${String(code)}` : `signal ${signal}`;
      this.#failAll(
        new LeandecRpcError(
          "exit",
          `Leandec MCP server stopped (${detail})`,
          this.#stderr,
        ),
      );
    });
  }

  serverVersion(): string | undefined {
    return this.#serverVersion;
  }

  /** Perform the MCP handshake once; repeated callers share the same attempt. */
  initialize(signal?: AbortSignal): Promise<void> {
    this.#handshake ??= this.#handshakeOnce(signal).catch((cause: unknown) => {
      this.#handshake = undefined;
      throw cause;
    });
    return this.#handshake;
  }

  async #handshakeOnce(signal?: AbortSignal): Promise<void> {
    const result = await this.#request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rea-leandec", version: "1" },
      },
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.#options.defaultTimeoutMs,
      },
    );
    const serverInfo = asRecord(asRecord(result)?.serverInfo);
    if (typeof serverInfo?.version === "string")
      this.#serverVersion = serverInfo.version;
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Call one tool and return its parsed JSON payload. */
  async call(
    tool: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<JsonValue> {
    await this.initialize(options.signal);
    const result = await this.#request(
      "tools/call",
      { name: tool, arguments: argumentsValue },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs ?? this.#options.defaultTimeoutMs,
      },
    );
    const content = Array.isArray(asRecord(result)?.content)
      ? (asRecord(result)?.content as JsonValue[])
      : [];
    const textValue = asRecord(content[0])?.text;
    const text = typeof textValue === "string" ? textValue : "";
    if (asRecord(result)?.isError === true)
      throw new LeandecToolError(tool, text || `${tool} failed`);
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      // A few tools answer plain text such as "no background jobs".
      return text;
    }
  }

  /** Stop the server, rejecting anything still in flight. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(
      new LeandecRpcError("exit", "Leandec MCP session closed", this.#stderr),
    );
    if (this.#exit !== undefined) return;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 2000);
      timer.unref();
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #request(
    method: string,
    params: JsonValue,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
  ): Promise<JsonValue> {
    if (this.#exit !== undefined)
      return Promise.reject(
        new LeandecRpcError(
          "exit",
          "Leandec MCP server is not running",
          this.#stderr,
        ),
      );
    if (options.signal?.aborted === true)
      return Promise.reject(
        new LeandecCallCancelled("aborted", "Caller cancelled the request"),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.#settle(id, (pending) =>
          pending.reject(
            new LeandecCallCancelled("aborted", "Caller cancelled the request"),
          ),
        );
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.#settle(id, (pending) =>
          pending.reject(
            new LeandecCallCancelled(
              "timeout",
              `Leandec ${method} exceeded ${String(options.timeoutMs)}ms`,
            ),
          ),
        );
      }, options.timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort: options.signal === undefined ? undefined : onAbort,
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #settle(id: number, action: (pending: PendingCall) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined)
      pending.signal.removeEventListener("abort", pending.onAbort);
    action(pending);
  }

  #write(message: JsonValue): void {
    if (this.#exit !== undefined) return;
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#buffer = "";
      this.#failAll(
        new LeandecRpcError(
          "frame",
          "Leandec MCP frame exceeded its limit",
          this.#stderr,
        ),
      );
      return;
    }
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: JsonValue;
      try {
        message = JSON.parse(line) as JsonValue;
      } catch {
        this.#failAll(
          new LeandecRpcError(
            "frame",
            "Leandec MCP emitted a non-JSON line",
            line,
          ),
        );
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message: JsonValue): void {
    const record = asRecord(message);
    const id = record?.id;
    if (typeof id !== "number") return;
    const error = asRecord(record?.error);
    if (error !== undefined) {
      this.#settle(id, (pending) =>
        pending.reject(
          new LeandecRpcError(
            "rpc",
            typeof error.message === "string"
              ? error.message
              : "Leandec JSON-RPC error",
            this.#stderr,
          ),
        ),
      );
      return;
    }
    this.#settle(id, (pending) => pending.resolve(record?.result as JsonValue));
  }

  #failAll(cause: Error): void {
    for (const id of Array.from(this.#pending.keys())) {
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.signal !== undefined && pending.onAbort !== undefined)
        pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(cause);
    }
  }
}

const asRecord = (
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
