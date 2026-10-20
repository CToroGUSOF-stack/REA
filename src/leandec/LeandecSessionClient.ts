import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisExecution,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  analysisSearchPredicate,
  analysisSearchQuerySchema,
} from "../domain/analysisSearch.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  LeandecCallCancelled,
  LeandecMcpClient,
  LeandecRpcError,
  LeandecToolError,
} from "./LeandecMcpClient.js";
import {
  isLeandecOperation,
  leandecLimitations,
  LEANDEC_PROVIDER_IDENTITY,
} from "./LeandecProviderCapabilities.js";
import type { LeandecSettings } from "./LeandecSettings.js";

interface InventoryEntry {
  readonly address: string;
  readonly name: string;
  readonly qualified: string;
  readonly size: number;
}

interface StringEntry {
  readonly address: string;
  readonly value: string;
}

interface Inventory {
  readonly entries: readonly InventoryEntry[];
  readonly total: number;
}

/** One answer before Evidence composition. */
interface Answer {
  readonly result: JsonValue;
  readonly locations: readonly EvidenceLocation[];
  readonly limitations: readonly string[];
}

const HEX = /^(?:0x)?[0-9a-f]+$/iu;
const INTERIOR_ONLY =
  "This address is not a procedure entry; Leandec resolves entries and containing functions, not arbitrary symbols.";

/** Canonical Leandec address: lowercase hexadecimal without a 0x prefix. */
const canonicalAddress = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!HEX.test(trimmed)) return undefined;
  try {
    return BigInt(`0x${trimmed.replace(/^0x/iu, "")}`).toString(16);
  } catch {
    return undefined;
  }
};

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};

const list = (value: JsonValue | undefined): readonly JsonValue[] =>
  Array.isArray(value) ? value : [];

const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Leandec-backed session for one parsed target. Every read goes through
 * Leandec's MCP server, which answers from its persistent SQLite cache and only
 * starts Ghidra when a requested function is not cached yet.
 */
export class LeandecSessionClient implements AnalysisClient {
  readonly #client: LeandecMcpClient;
  readonly #target: BinaryTarget;
  readonly #settings: LeandecSettings;
  readonly #profile: AnalysisProfileCommitment | undefined;
  #session: Promise<string> | undefined;
  #inventory: Promise<Inventory> | undefined;
  #strings:
    | Promise<{ items: readonly StringEntry[]; total: number }>
    | undefined;
  #closed = false;

  constructor(
    target: BinaryTarget,
    settings: LeandecSettings,
    profile?: AnalysisProfileCommitment,
  ) {
    this.#target = target;
    this.#settings = settings;
    this.#profile = profile;
    this.#client = new LeandecMcpClient({
      python: settings.python,
      server: settings.server,
      environment: settings.environment,
      cwd: settings.cwd,
      defaultTimeoutMs: settings.defaultTimeoutMs,
    });
  }

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions = {},
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closed)
      return err(
        this.#unavailable(operation, "This Leandec session is already closed."),
      );
    if (options.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    if (operation !== "health" && !isLeandecOperation(operation))
      return err(
        this.#unavailable(
          operation,
          "Leandec answers procedure, string, reference and byte queries; this operation needs another provider.",
        ),
      );
    try {
      const answer = await this.#answer(operation, parameters, options);
      return ok(
        createAnalysisExecution(answer.result, this.#identity(), {
          subject: {
            path: this.#target.path,
            sha256: this.#target.sha256,
            format: this.#target.format,
            ...(this.#target.architecture === undefined
              ? {}
              : { architecture: this.#target.architecture }),
          },
          limitations:
            operation === "health"
              ? answer.limitations
              : [...leandecLimitations(operation), ...answer.limitations],
          ...(this.#profile === undefined
            ? {}
            : { analysisProfile: this.#profile }),
          locations: [
            { kind: "artifact-path", path: this.#target.path },
            ...answer.locations,
          ],
        }),
      );
    } catch (cause: unknown) {
      return err(this.#project(cause, operation, options));
    }
  }

  async close(): Promise<Result<null, AnalysisError>> {
    this.#closed = true;
    await this.#client.close();
    return ok(null);
  }

  reuseReadiness(): "ready" | "blocked" | "unknown" {
    return this.#closed ? "blocked" : "unknown";
  }

  #identity() {
    return {
      id: LEANDEC_PROVIDER_IDENTITY.id,
      name: LEANDEC_PROVIDER_IDENTITY.name,
      version: this.#profile?.provider.version ?? null,
    };
  }

  async #answer(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    if (operation === "health") return this.#health(options);
    const document = parameters.document;
    if (document !== undefined && document !== this.#target.path)
      throw new AnalysisInputError(operation, {
        userMessage:
          "A Leandec session analyzes one target; omit document or pass the selected target path.",
      });
    if (!isLeandecOperation(operation))
      throw this.#unavailable(operation, "Unsupported Leandec operation.");
    const key = await this.#ensureSession(options);
    switch (operation) {
      case "list_documents":
        return { result: [this.#target.path], locations: [], limitations: [] };
      case "list_procedures":
        return this.#listProcedures(key, options);
      case "search_procedures":
        return this.#searchProcedures(operation, parameters, options);
      case "list_strings":
        return this.#listStrings(parameters, options);
      case "search_strings":
        return this.#searchStrings(operation, parameters, options);
      case "procedure_address":
        return this.#procedureAddress(operation, parameters, options);
      case "address_name":
        return this.#addressName(parameters, options);
      case "procedure_pseudo_code":
        return this.#pseudocode(operation, parameters, key, options);
      case "procedure_assembly":
        return this.#assembly(operation, parameters, key, options);
      case "procedure_callers":
      case "procedure_callees":
        return this.#relationships(operation, parameters, key, options);
      case "xrefs":
        return this.#xrefs(parameters, key, options);
      case "read_bytes":
        return this.#readBytes(operation, parameters, key, options);
    }
  }

  async #health(options: ExecutionOptions): Promise<Answer> {
    const key = await this.#ensureSession(options);
    const overview = record(
      await this.#call("overview", { target: key }, options),
    );
    return {
      result: {
        ready: true,
        leandec: {
          key,
          server_version: this.#settings.serverVersion,
          functions: overview.functions ?? null,
          strings: overview.strings ?? null,
          db: overview.db ?? null,
        },
      },
      locations: [],
      limitations: [],
    };
  }

  async #listProcedures(
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const inventory = await this.#inventoryOf(key, options);
    return {
      result: inventory.entries.map((entry) => ({
        address: entry.address,
        value: entry.qualified,
      })),
      locations: [],
      limitations:
        inventory.total > inventory.entries.length
          ? [
              `Leandec's inventory was capped at ${String(this.#settings.inventoryLimit)} of ${String(inventory.total)} functions; raise LEANDEC_INVENTORY_LIMIT for a complete list.`,
            ]
          : [],
    };
  }

  async #searchProcedures(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const query = this.#searchQuery(operation, parameters);
    const matches = analysisSearchPredicate(query);
    const inventory = await this.#inventoryOf(
      await this.#ensureSession(options),
      options,
    );
    return {
      result: inventory.entries
        .filter((entry) => matches(entry.qualified))
        .map((entry) => ({ address: entry.address, value: entry.qualified })),
      locations: [],
      limitations: [],
    };
  }

  async #listStrings(
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const strings = await this.#stringsOf(options);
    const wanted =
      parameters.address === undefined
        ? undefined
        : canonicalAddress(parameters.address);
    const selected =
      wanted === undefined
        ? strings.items
        : strings.items.filter((entry) => entry.address === wanted);
    return {
      result: selected.map(({ address, value }) => ({ address, value })),
      locations: [],
      limitations:
        strings.total > strings.items.length
          ? [
              `Leandec returned ${String(strings.items.length)} of ${String(strings.total)} strings; raise LEANDEC_STRING_LIMIT for a complete list.`,
            ]
          : [],
    };
  }

  async #searchStrings(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const query = this.#searchQuery(operation, parameters);
    const matches = analysisSearchPredicate(query);
    const strings = await this.#stringsOf(options);
    return {
      result: strings.items
        .filter((entry) => matches(entry.value))
        .map(({ address, value }) => ({ address, value })),
      locations: [],
      limitations: [],
    };
  }

  async #procedureAddress(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    return {
      result: entry.address,
      locations: [{ kind: "address", address: entry.address }],
      limitations: [],
    };
  }

  async #addressName(
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const key = await this.#ensureSession(options);
    const address =
      canonicalAddress(parameters.address) ??
      (await this.#resolve("address_name", parameters.address, options))
        .address;
    const resolved = record(
      await this.#call("resolve", { target: key, selector: address }, options),
    );
    const exact = resolved.exact === true ? text(resolved.name) : undefined;
    if (exact !== undefined)
      return {
        result: exact,
        locations: [{ kind: "address", address }],
        limitations: [],
      };
    const labels = record(
      await this.#call(
        "sql",
        {
          target: key,
          query: `SELECT name FROM labels WHERE addr = '${address}' AND name != '' LIMIT 1`,
        },
        options,
      ),
    );
    const label = text(list(list(labels.rows)[0])[0]);
    return {
      result: label ?? null,
      locations: [{ kind: "address", address }],
      limitations: label === undefined ? [INTERIOR_ONLY] : [],
    };
  }

  async #pseudocode(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "decompile",
        { target: key, selector: entry.address },
        options,
      ),
    );
    const code = text(payload.pseudocode);
    return {
      result: code === undefined || code.length === 0 ? null : code,
      locations: [{ kind: "address", address: entry.address }],
      limitations:
        payload.cached === true
          ? []
          : ["This pseudocode was decompiled on demand."],
    };
  }

  async #assembly(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "disassemble",
        { target: key, selector: entry.address },
        options,
      ),
    );
    return {
      result: text(payload.assembly) ?? null,
      locations: [{ kind: "address", address: entry.address }],
      limitations: [],
    };
  }

  async #relationships(
    operation: "procedure_callers" | "procedure_callees",
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "xrefs",
        { target: key, selector: entry.address },
        options,
      ),
    );
    const field = operation === "procedure_callers" ? "callers" : "callees";
    return {
      result: list(payload[field])
        .map((item) => text(record(item).address))
        .filter((address): address is string => address !== undefined),
      locations: [{ kind: "address", address: entry.address }],
      limitations:
        payload.cached === true
          ? []
          : [
              "Reference indexing for this function did not complete; this list may be incomplete.",
            ],
    };
  }

  async #xrefs(
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const address =
      canonicalAddress(parameters.address) ??
      (await this.#resolve("xrefs", parameters.address, options)).address;
    let references = record(
      await this.#call(
        "instruction_xrefs",
        { target: key, address, direction: "in", limit: 10_000 },
        options,
      ),
    );
    if (references.complete !== true) {
      const owner = text(references.function);
      if (owner !== undefined) {
        await this.#call("xrefs", { target: key, selector: owner }, options);
        references = record(
          await this.#call(
            "instruction_xrefs",
            { target: key, address, direction: "in", limit: 10_000 },
            options,
          ),
        );
      }
    }
    const sources = [
      ...new Set(
        list(references.references)
          .map((item) => text(record(item).src))
          .filter((value): value is string => value !== undefined),
      ),
    ];
    return {
      result: sources,
      locations: [{ kind: "address", address }],
      limitations: [
        ...(references.complete === true
          ? []
          : ["The containing function's reference index is not complete."]),
        ...(references.truncated === true
          ? ["More incoming references exist than the 10000-row cap."]
          : []),
      ],
    };
  }

  async #readBytes(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const address = canonicalAddress(parameters.address);
    if (address === undefined)
      throw new AnalysisInputError(operation, {
        userMessage: "read_bytes requires a hexadecimal address.",
      });
    const length = Number(parameters.length ?? 256);
    if (!Number.isInteger(length) || length < 1)
      throw new AnalysisInputError(operation, {
        userMessage: "read_bytes requires a positive integer length.",
      });
    await this.#call("sections", { target: key }, options);
    const payload = record(
      await this.#call("read_bytes", { target: key, address, length }, options),
    );
    const bytes = hexFromDump(text(payload.dump) ?? "");
    return {
      result: {
        address,
        requested_bytes: length,
        returned_bytes: bytes.length / 2,
        bytes_hex: bytes,
        complete: bytes.length / 2 === length,
      },
      locations: [{ kind: "address", address }],
      limitations: [],
    };
  }

  #searchQuery(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ) {
    const parsed = analysisSearchQuerySchema.safeParse(parameters);
    if (!parsed.success)
      throw new AnalysisInputError(operation, { cause: parsed.error });
    return parsed.data;
  }

  async #resolve(
    operation: string,
    raw: JsonValue | undefined,
    options: ExecutionOptions,
  ): Promise<InventoryEntry> {
    const key = await this.#ensureSession(options);
    const inventory = await this.#inventoryOf(key, options);
    const address = canonicalAddress(raw);
    if (address !== undefined) {
      const exact = inventory.entries.find(
        (entry) => entry.address === address,
      );
      if (exact !== undefined) return exact;
      const resolved = record(
        await this.#call(
          "resolve",
          { target: key, selector: address },
          options,
        ),
      );
      const inside = text(resolved.address);
      const owner = inventory.entries.find((entry) => entry.address === inside);
      if (owner !== undefined) return owner;
      throw new AnalysisInputError(operation, { userMessage: INTERIOR_ONLY });
    }
    if (typeof raw !== "string" || raw.trim().length === 0)
      throw new AnalysisInputError(operation, {
        userMessage: "procedure is required.",
      });
    const wanted = raw.trim();
    const matches = inventory.entries.filter(
      (entry) => entry.qualified === wanted || entry.name === wanted,
    );
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length === 0)
      throw new AnalysisInputError(operation, {
        userMessage: `Leandec found no procedure named ${wanted}; search_procedures finds similar names.`,
      });
    throw new AnalysisInputError(operation, {
      userMessage: `${wanted} names ${String(matches.length)} Leandec entries (${matches
        .map((entry) => entry.address)
        .join(", ")}); select one by address.`,
    });
  }

  async #ensureSession(options: ExecutionOptions): Promise<string> {
    this.#session ??= this.#open(options).catch((cause: unknown) => {
      this.#session = undefined;
      throw cause;
    });
    return this.#session;
  }

  async #open(options: ExecutionOptions): Promise<string> {
    await this.#client.initialize(options.signal);
    try {
      return await this.#overviewKey(options);
    } catch (cause: unknown) {
      if (
        !(cause instanceof LeandecToolError) ||
        !/unknown target/iu.test(cause.message)
      )
        throw cause;
      // A different path with identical bytes is the same analysis: reuse the
      // stored key instead of re-importing into an existing Ghidra project.
      const byDigest = await this.#findByDigest(options);
      if (byDigest !== undefined) return byDigest;
      if (!this.#settings.autoAnalyze)
        throw this.#unavailable(
          "open_binary",
          `${cause.message}. Run "python3 ${this.#settings.server} import ${this.#target.path}" once, or set LEANDEC_AUTO_ANALYZE=1.`,
        );
      await this.#importTarget(options);
      return this.#overviewKey(options);
    }
  }

  async #findByDigest(options: ExecutionOptions): Promise<string | undefined> {
    const targets = list(await this.#call("targets", {}, options));
    const match = targets
      .map((item) => record(item))
      .find((item) => text(item.slice_sha256) === this.#target.sha256);
    return text(match?.key);
  }

  async #overviewKey(options: ExecutionOptions): Promise<string> {
    const overview = record(
      await this.#call("overview", { target: this.#target.path }, options),
    );
    const key = text(overview.key);
    if (key === undefined)
      throw this.#unavailable(
        "open_binary",
        "Leandec did not report a target key for this path.",
      );
    if (typeof overview.functions === "number")
      this.#overviewTotal = overview.functions;
    return key;
  }

  #overviewTotal: number | undefined;

  async #importTarget(options: ExecutionOptions): Promise<void> {
    const job = record(
      await this.#call(
        "analyze",
        {
          path: this.#target.path,
          ...(this.#target.format === "mach-o-universal"
            ? { arch: this.#target.architecture }
            : {}),
        },
        options,
        this.#settings.importTimeoutMs,
      ),
    );
    const id = text(job.id);
    if (id === undefined)
      throw new ProviderAdapterError("leandec", "analyze", {
        userMessage: "Leandec did not return a background job identifier.",
      });
    const deadline = Date.now() + this.#settings.importTimeoutMs;
    for (;;) {
      if (options.signal?.aborted === true)
        throw new AnalysisCancelledError("analyze", {
          cause: options.signal.reason,
        });
      if (Date.now() > deadline)
        throw new AnalysisTimeoutError(
          "analyze",
          this.#settings.importTimeoutMs,
          {
            userMessage: `Leandec import of ${this.#target.path} is still running; poll it from Pi with the job tool.`,
          },
        );
      const jobs = list(await this.#call("job", { id, lines: 6 }, options));
      const current = record(jobs[0]);
      if (current.running !== true) {
        const tail = text(current.log_tail) ?? "";
        if (current.exit_code === 0) return;
        if (current.exit_code === undefined && /done in .*->/u.test(tail))
          return;
        throw new ProviderAdapterError("leandec", "analyze", {
          userMessage: `Leandec import failed (exit ${String(current.exit_code ?? "unknown")}): ${tail}`,
        });
      }
      await options.progress?.report({
        phase: "analyze",
        completed: 0,
        total: null,
        message: `Leandec is importing ${this.#target.path}`,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
      });
    }
  }

  async #inventoryOf(
    key: string,
    options: ExecutionOptions,
  ): Promise<Inventory> {
    this.#inventory ??= this.#loadInventory(key, options);
    return this.#inventory;
  }

  async #loadInventory(
    key: string,
    options: ExecutionOptions,
  ): Promise<Inventory> {
    const payload = record(
      await this.#call(
        "sql",
        {
          target: key,
          limit: this.#settings.inventoryLimit,
          query:
            "SELECT addr, name, COALESCE(ns, ''), size FROM functions " +
            "WHERE kind != 'external' ORDER BY size ASC",
        },
        options,
      ),
    );
    const entries = list(payload.rows).flatMap((row) => {
      const cells = list(row);
      const address = text(cells[0]);
      const name = text(cells[1]);
      if (address === undefined || name === undefined) return [];
      const namespace = text(cells[2]) ?? "";
      return [
        {
          address,
          name,
          qualified: namespace.length > 0 ? `${namespace}::${name}` : name,
          size: typeof cells[3] === "number" ? cells[3] : 0,
        },
      ];
    });
    const total = this.#overviewTotal ?? entries.length;
    return { entries, total };
  }

  async #stringsOf(
    options: ExecutionOptions,
  ): Promise<{ items: readonly StringEntry[]; total: number }> {
    this.#strings ??= this.#loadStrings(options);
    return this.#strings;
  }

  async #loadStrings(
    options: ExecutionOptions,
  ): Promise<{ items: readonly StringEntry[]; total: number }> {
    const key = await this.#ensureSession(options);
    const payload = record(
      await this.#call(
        "strings",
        { target: key, limit: this.#settings.stringLimit },
        options,
      ),
    );
    const items = list(payload.items).flatMap((item) => {
      const value = record(item);
      const address = text(value.address);
      const string = text(value.value);
      return address === undefined || string === undefined
        ? []
        : [{ address, value: string }];
    });
    return {
      items,
      total:
        typeof payload.total_strings === "number"
          ? payload.total_strings
          : items.length,
    };
  }

  async #call(
    tool: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
    timeoutMs: number = this.#settings.defaultTimeoutMs,
  ): Promise<JsonValue> {
    return this.#client.call(tool, argumentsValue, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs,
    });
  }

  #project(
    cause: unknown,
    operation: string,
    options: ExecutionOptions,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof LeandecCallCancelled)
      return cause.reason === "timeout"
        ? new AnalysisTimeoutError(operation, this.#settings.defaultTimeoutMs, {
            userMessage: cause.message,
          })
        : new AnalysisCancelledError(operation, {
            cause: options.signal?.reason ?? cause,
          });
    if (cause instanceof LeandecToolError)
      return /no function|no procedure|required|hexadecimal|invalid|unknown target|not a procedure/iu.test(
        cause.message,
      )
        ? new AnalysisInputError(operation, { userMessage: cause.message })
        : new ProviderAdapterError("leandec", operation, {
            userMessage: cause.message,
          });
    if (cause instanceof LeandecRpcError)
      return new ProviderAdapterError("leandec", operation, {
        userMessage: cause.message,
        capturedOutput: {
          stdout: "",
          stderr: cause.capturedOutput,
          truncated: false,
        },
        cause,
      });
    return new ProviderAdapterError("leandec", operation, { cause });
  }

  #unavailable(
    operation: string,
    reason: string,
  ): AnalysisCapabilityUnavailableError {
    return new AnalysisCapabilityUnavailableError(
      LEANDEC_PROVIDER_IDENTITY.id,
      operation,
      reason,
      { userMessage: reason, retryable: true },
    );
  }
}

/** Extract lowercase hexadecimal bytes from Leandec's hexdump text. */
const hexFromDump = (dump: string): string => {
  const parts: string[] = [];
  for (const line of dump.split("\n")) {
    const payload = line.slice(8).split("|")[0] ?? "";
    for (const token of payload.replace("*", " ").trim().split(/\s+/u)) {
      if (/^[0-9a-f]{2}$/u.test(token)) parts.push(token);
    }
  }
  return parts.join("");
};
