import { AsyncLocalStorage } from "node:async_hooks";
import { getCallSites, types } from "node:util";
import { selectionSchema } from "./trace-contract.mjs";

const limitations = [
  "Only caller-selected wrappers are observed; bypassing a wrapper is unobserved.",
  "The file-writer operation is caller-bound; a fulfilled call is not proof of durable storage.",
  "Invocation IDs identify this recorder only; they are not Electron capture correlation IDs.",
  "Async context lineage does not prove business causality or an association with a UI action.",
  "Effects after handler completion retain lineage with within_handler=false.",
  "Registration locations are raw wrapper-installation call sites, not handler implementation locations or source-map recovery.",
  "Renderer/preload execution, native calls, payloads and ambient environment are not captured.",
  "Promise completion observers can change unhandled-rejection reporting.",
  "Promise constructor/species access can have side effects; failed observer setup leaves completion and handler lifetime unknown.",
  "Non-Promise object/function returns have unknown completion; arbitrary thenables are not invoked.",
];

const invalid = (message) => ({
  ok: false,
  error: { code: "invalid_input", message },
});

const withinHandler = (scope) =>
  scope?.status === "unknown" ? null : scope?.status === "active";
const execute = ({
  operation,
  receiver,
  args,
  start,
  scope,
  complete,
  record,
}) => {
  const finish = (phase, status = "completed") => {
    complete(status);
    record({ ...start, phase, within_handler: withinHandler(scope) });
  };
  record({
    ...start,
    phase: "started",
    within_handler: withinHandler(scope),
  });
  let result;
  try {
    result = Reflect.apply(operation, receiver, args);
  } catch (cause) {
    finish("threw");
    throw cause;
  }
  if (types.isPromise(result)) {
    // Preserve the original Promise and exception identity. Attaching an
    // observer changes unhandled-rejection reporting; see the experiment README.
    try {
      Promise.prototype.then.call(
        result,
        () => finish("fulfilled"),
        () => finish("rejected"),
      );
    } catch {
      // A Promise subclass or constructor getter can reject observer setup.
      // Keep the original return value and explicitly lose completion coverage.
      finish("returned_completion_unknown", "unknown");
    }
  } else {
    // Do not access or invoke an arbitrary thenable's .then getter.
    const unknownCompletion =
      result !== null &&
      (typeof result === "object" || typeof result === "function");
    finish(
      unknownCompletion ? "returned_completion_unknown" : "returned",
      unknownCompletion ? "unknown" : "completed",
    );
  }
  return result;
};

const createHandlerProbe = ({ channels, context, record }) => {
  let invocation = 0;
  return function wrapHandler(channel, handler) {
    if (typeof channel !== "string" || typeof handler !== "function")
      return invalid("A literal channel and callable handler are required.");
    if (!channels.has(channel)) return { ok: true, value: handler };
    const site = getCallSites(2, { sourceMap: false })[1];
    const registration = site
      ? {
          script_name: site.scriptName,
          line: site.lineNumber,
          column: site.columnNumber,
        }
      : null;
    return {
      ok: true,
      value: function observedHandler(...args) {
        const scope = { invocation_id: ++invocation, status: "active" };
        const start = {
          kind: "handler",
          invocation_id: scope.invocation_id,
          channel,
          registration,
        };
        return context.run(scope, () =>
          execute({
            operation: handler,
            receiver: this,
            args,
            start,
            scope,
            record,
            complete: (status) => {
              scope.status = status;
            },
          }),
        );
      },
    };
  };
};

const createFileProbe = ({ paths, context, record }) => {
  let effect = 0;
  return function wrapFileWriter(writer) {
    if (typeof writer !== "function")
      return invalid("A callable writer is required.");
    return {
      ok: true,
      value: function observedFileWrite(path, ...args) {
        // Preserve FileHandle/URL/Buffer inputs and unselected paths unchanged.
        if (typeof path !== "string" || !paths.has(path))
          return Reflect.apply(writer, this, [path, ...args]);
        const scope = context.getStore();
        const start = {
          kind: "file-write",
          effect_id: ++effect,
          invocation_id: scope?.invocation_id ?? null,
          path,
        };
        return execute({
          operation: writer,
          receiver: this,
          args: [path, ...args],
          start,
          scope,
          record,
          complete: () => {},
        });
      },
    };
  };
};

/** Explicit, fixture-only probes. This is not a production provider or Evidence. */
export function createRecorder(input) {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.message);
  const selection = parsed.data;
  const channels = new Set(selection.channels);
  const paths = new Set(selection.file_paths);
  if (
    channels.size !== selection.channels.length ||
    paths.size !== selection.file_paths.length
  )
    return invalid("Selections must be unique.");

  const selectionBytes =
    512 +
    limitations.reduce(
      (sum, value) => sum + Buffer.byteLength(value, "utf8") + 4,
      0,
    ) +
    [...channels, ...paths].reduce((sum, value) => sum + value.length * 8, 0);
  if (selectionBytes > selection.retention_bytes)
    return {
      ok: false,
      error: {
        code: "resource_constraint",
        message: "Selected strings exceed the retention estimate budget.",
      },
    };

  const context = new AsyncLocalStorage();
  const events = [];
  let observed = 0;
  let estimatedBytes = selectionBytes;
  let dropped = 0;

  const record = (event) => {
    observed += 1;
    // Count an upper bound for escaped strings before serialization or copying.
    // This is a retention estimate, not a measured process-memory ceiling.
    const strings = [
      event.channel,
      event.path,
      event.registration?.script_name,
    ];
    const estimate =
      1024 + strings.reduce((sum, value) => sum + (value?.length ?? 0) * 8, 0);
    if (estimate > selection.retention_bytes - estimatedBytes) {
      dropped += 1;
      return;
    }
    estimatedBytes += estimate;
    events.push({ sequence: observed, ...event });
  };

  return {
    ok: true,
    value: {
      wrapHandler: createHandlerProbe({ channels, context, record }),
      wrapFileWriter: createFileProbe({ paths, context, record }),
      snapshot: () => ({
        format: "rea-electron-feature-path-prototype-v1",
        selection: structuredClone(selection),
        events: structuredClone(events),
        coverage: {
          status: dropped === 0 ? "selected-probes-retained" : "truncated",
          observed,
          retained: events.length,
          dropped,
          estimated_retained_bytes: estimatedBytes,
        },
        limitations: [...limitations],
      }),
    },
  };
}
