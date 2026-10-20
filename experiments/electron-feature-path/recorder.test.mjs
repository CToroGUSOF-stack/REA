import assert from "node:assert/strict";
import test from "node:test";

import { createRecorder } from "./recorder.mjs";

const selectedPath = "/selected.txt";
const selection = () => ({
  channels: ["save"],
  file_paths: [selectedPath],
  retention_bytes: 64 * 1024,
});
const valueOf = (result) => {
  assert.equal(result.ok, true);
  return result.value;
};
const recorder = (input = selection()) => valueOf(createRecorder(input));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const eventPhases = (events) => events.map(({ phase }) => phase);

test("overlapping invocations on the same channel retain distinct async lineage", async () => {
  const capture = recorder();
  const gates = { first: deferred(), second: deferred() };
  const writes = [];
  const write = valueOf(
    capture.wrapFileWriter((path, label) => {
      writes.push({ path, label });
      return label;
    }),
  );
  const handler = valueOf(
    capture.wrapHandler("save", async (label) => {
      await gates[label].promise;
      return write(selectedPath, label);
    }),
  );

  const first = handler("first");
  const second = handler("second");
  gates.second.resolve();
  assert.equal(await second, "second");
  gates.first.resolve();
  assert.equal(await first, "first");

  assert.deepEqual(writes, [
    { path: selectedPath, label: "second" },
    { path: selectedPath, label: "first" },
  ]);
  const { events, coverage } = capture.snapshot();
  assert.equal(coverage.status, "selected-probes-retained");
  const starts = events.filter(
    (event) => event.kind === "handler" && event.phase === "started",
  );
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].invocation_id, starts[1].invocation_id);
  const effects = events.filter((event) => event.kind === "file-write");
  assert.deepEqual(
    effects.map((event) => event.invocation_id),
    [
      starts[1].invocation_id,
      starts[1].invocation_id,
      starts[0].invocation_id,
      starts[0].invocation_id,
    ],
  );
  assert.equal(new Set(effects.map((event) => event.effect_id)).size, 2);
  assert.ok(effects.every((event) => event.within_handler));
  assert.deepEqual(
    events
      .filter(
        (event) => event.kind === "handler" && event.phase === "fulfilled",
      )
      .map((event) => event.invocation_id),
    [starts[1].invocation_id, starts[0].invocation_id],
  );
});

for (const boundary of ["handler", "file-writer"]) {
  const wrap = (capture, fn) =>
    valueOf(
      boundary === "handler"
        ? capture.wrapHandler("save", fn)
        : capture.wrapFileWriter(fn),
    );
  const argsFor = (args) =>
    boundary === "handler" ? args : [selectedPath, ...args];

  test(`${boundary} preserves synchronous receiver, arguments, return and thrown identity`, () => {
    const capture = recorder();
    const receiver = {};
    const token = {};
    const args = argsFor([token, Symbol("argument"), undefined]);
    let calls = 0;
    const successful = wrap(capture, function (...actual) {
      calls += 1;
      assert.equal(this, receiver);
      assert.deepEqual(actual, args);
      assert.equal(actual[boundary === "handler" ? 0 : 1], token);
      return token;
    });
    assert.equal(successful.apply(receiver, args), token);
    assert.equal(calls, 1);
    const cause = new Error("fixture failure");
    const throwing = wrap(capture, function (...actual) {
      assert.equal(this, receiver);
      assert.deepEqual(actual, args);
      throw cause;
    });
    assert.throws(
      () => throwing.apply(receiver, args),
      (error) => error === cause,
    );
    assert.deepEqual(eventPhases(capture.snapshot().events), [
      "started",
      "returned_completion_unknown",
      "started",
      "threw",
    ]);
  });

  test(`${boundary} preserves original Promise and settlement identity`, async () => {
    const capture = recorder();
    const receiver = {};
    const token = {};
    const args = argsFor([token]);
    for (const outcome of ["fulfilled", "rejected"]) {
      const gate = deferred();
      const fn = wrap(capture, function (...actual) {
        assert.equal(this, receiver);
        assert.deepEqual(actual, args);
        return gate.promise;
      });
      const original = fn.apply(receiver, args);
      assert.equal(original, gate.promise);
      const settled =
        outcome === "fulfilled" ? token : new Error("rejected fixture");
      if (outcome === "fulfilled") {
        gate.resolve(settled);
        assert.equal(await original, settled);
      } else {
        gate.reject(settled);
        await assert.rejects(original, (error) => error === settled);
      }
    }
    assert.deepEqual(eventPhases(capture.snapshot().events), [
      "started",
      "fulfilled",
      "started",
      "rejected",
    ]);
  });

  test(`${boundary} never reads an arbitrary then getter`, () => {
    const capture = recorder();
    let reads = 0;
    // oxlint-disable-next-line unicorn/no-thenable -- Regression: the getter must never be read by observation.
    const thenable = Object.defineProperty({}, "then", {
      get() {
        reads += 1;
        throw new Error("then getter must remain untouched");
      },
    });
    const fn = wrap(capture, () => thenable);
    assert.equal(fn(...argsFor([])), thenable);
    assert.equal(reads, 0);
    assert.deepEqual(eventPhases(capture.snapshot().events), [
      "started",
      "returned_completion_unknown",
    ]);
  });

  test(`${boundary} preserves a Promise when its constructor getter prevents observation`, async () => {
    const capture = recorder();
    const gate = deferred();
    let constructorReads = 0;
    Object.defineProperty(gate.promise, "constructor", {
      configurable: true,
      get() {
        constructorReads += 1;
        throw new Error("observer constructor failure");
      },
    });
    const fn = wrap(capture, () => gate.promise);
    assert.equal(fn(...argsFor([])), gate.promise);
    assert.equal(constructorReads, 1);
    assert.deepEqual(eventPhases(capture.snapshot().events), [
      "started",
      "returned_completion_unknown",
    ]);
    delete gate.promise.constructor;
    gate.resolve("original settlement");
    assert.equal(await gate.promise, "original settlement");
    assert.equal(capture.snapshot().events.length, 2);
  });
}

test("outside effects have no invocation or handler lifetime", () => {
  const capture = recorder();
  const write = valueOf(capture.wrapFileWriter(() => 7));
  assert.equal(write(selectedPath), 7);
  const events = capture.snapshot().events;
  assert.equal(events.length, 2);
  assert.ok(
    events.every(
      (event) => event.invocation_id === null && event.within_handler === false,
    ),
  );
});

for (const completion of [
  { name: "primitive return", phase: "returned", lifetime: false },
  { name: "sync throw", phase: "threw", lifetime: false },
  { name: "Promise fulfillment", phase: "fulfilled", lifetime: false },
  { name: "Promise rejection", phase: "rejected", lifetime: false },
  {
    name: "opaque object",
    phase: "returned_completion_unknown",
    lifetime: null,
  },
  {
    name: "opaque function",
    phase: "returned_completion_unknown",
    lifetime: null,
  },
  {
    name: "opaque thenable",
    phase: "returned_completion_unknown",
    lifetime: null,
  },
  {
    name: "observer setup failure",
    phase: "returned_completion_unknown",
    lifetime: null,
  },
]) {
  test(`${completion.name} updates terminal handler lifetime before recording and preserves detached lineage`, async () => {
    const capture = recorder();
    const later = deferred();
    const settlement = deferred();
    const write = valueOf(capture.wrapFileWriter(() => "written"));
    let detached;
    let reads = 0;
    const cause = new Error("handler failure");
    let result = "returned value";
    if (completion.name === "opaque object") result = {};
    if (completion.name === "opaque function") result = () => {};
    if (completion.name === "opaque thenable") {
      // oxlint-disable-next-line unicorn/no-thenable -- Regression: this getter must remain untouched while completion stays unknown.
      result = Object.defineProperty({}, "then", {
        get() {
          reads += 1;
          throw new Error("unexpected then read");
        },
      });
    }
    if (completion.phase === "fulfilled" || completion.phase === "rejected")
      result = settlement.promise;
    if (completion.name === "observer setup failure")
      result = Object.defineProperty(settlement.promise, "constructor", {
        configurable: true,
        get() {
          throw new Error("unobservable constructor");
        },
      });
    const handler = valueOf(
      capture.wrapHandler("save", () => {
        assert.equal(write(selectedPath), "written");
        detached = later.promise.then(() => write(selectedPath));
        if (completion.phase === "threw") throw cause;
        return result;
      }),
    );
    if (completion.phase === "threw")
      assert.throws(handler, (error) => error === cause);
    else assert.equal(handler(), result);
    if (completion.phase === "fulfilled") {
      settlement.resolve("settled");
      assert.equal(await result, "settled");
    } else if (completion.phase === "rejected") {
      const rejected = assert.rejects(result, (error) => error === cause);
      settlement.reject(cause);
      await rejected;
    } else if (completion.name === "observer setup failure") {
      delete result.constructor;
      settlement.resolve("settled");
      assert.equal(await result, "settled");
    }
    const beforeDetached = capture.snapshot().events;
    const handlerEvents = beforeDetached.filter(
      (event) => event.kind === "handler",
    );
    assert.equal(handlerEvents.length, 2);
    const [start, terminal] = handlerEvents;
    assert.equal(start.phase, "started");
    assert.equal(start.within_handler, true);
    assert.equal(terminal.phase, completion.phase);
    assert.equal(terminal.within_handler, completion.lifetime);
    assert.equal(terminal.invocation_id, start.invocation_id);
    const insideEffects = beforeDetached.filter(
      (event) => event.kind === "file-write",
    );
    assert.equal(insideEffects.length, 2);
    assert.ok(insideEffects.every((event) => event.within_handler === true));
    later.resolve();
    assert.equal(await detached, "written");
    assert.equal(reads, 0);
    const events = capture.snapshot().events;
    const effects = events.filter((event) => event.kind === "file-write");
    assert.equal(effects.length, 4);
    assert.ok(
      effects.every((event) => event.invocation_id === start.invocation_id),
    );
    assert.ok(
      effects
        .slice(2)
        .every((event) => event.within_handler === completion.lifetime),
    );
    assert.ok(effects[2].sequence > terminal.sequence);
  });
}

test("a pending file effect reports its parent lifetime when the effect settles", async () => {
  for (const result of ["completed", {}]) {
    const capture = recorder();
    const pendingWrite = deferred();
    const write = valueOf(capture.wrapFileWriter(() => pendingWrite.promise));
    let effect;
    const handler = valueOf(
      capture.wrapHandler("save", () => {
        effect = write(selectedPath);
        return result;
      }),
    );
    assert.equal(handler(), result);
    assert.equal(effect, pendingWrite.promise);
    pendingWrite.resolve("written");
    assert.equal(await effect, "written");
    const events = capture.snapshot().events;
    const handlerStart = events.find(
      (event) => event.kind === "handler" && event.phase === "started",
    );
    const effects = events.filter((event) => event.kind === "file-write");
    assert.deepEqual(eventPhases(effects), ["started", "fulfilled"]);
    assert.equal(effects[0].within_handler, true);
    assert.equal(
      effects[1].within_handler,
      typeof result === "string" ? false : null,
    );
    assert.ok(
      effects.every(
        (event) => event.invocation_id === handlerStart.invocation_id,
      ),
    );
  }
});

test("selection forwards unselected handlers and file input forms transparently", () => {
  const capture = recorder();
  const handler = () => 12;
  assert.equal(valueOf(capture.wrapHandler("other", handler)), handler);
  const receiver = {};
  const payload = {};
  const paths = [
    "/other.txt",
    new URL("file:///selected.txt"),
    Buffer.from(selectedPath),
    { fd: 7 },
  ];
  let calls = 0;
  const write = valueOf(
    capture.wrapFileWriter(function (path, arg) {
      assert.equal(this, receiver);
      assert.equal(arg, payload);
      assert.equal(path, paths[calls]);
      calls += 1;
      return path;
    }),
  );
  for (const path of paths)
    assert.equal(write.call(receiver, path, payload), path);
  assert.equal(calls, paths.length);
  assert.equal(handler(), 12);
  assert.deepEqual(capture.snapshot().events, []);
  assert.equal(capture.snapshot().coverage.observed, 0);
});

test("retention reports drops without preventing the operation or exceeding its budget", () => {
  const capture = recorder({ ...selection(), retention_bytes: 3000 });
  let calls = 0;
  const write = valueOf(capture.wrapFileWriter(() => ++calls));
  assert.equal(write(selectedPath), 1);
  assert.equal(write(selectedPath), 2);
  const { events, coverage } = capture.snapshot();
  assert.equal(coverage.status, "truncated");
  assert.equal(coverage.observed, 4);
  assert.equal(coverage.retained, events.length);
  assert.equal(coverage.dropped, coverage.observed - coverage.retained);
  assert.ok(coverage.dropped > 0);
  assert.ok(coverage.estimated_retained_bytes <= 3000);
  assert.ok(events.length > 0);
  assert.ok(
    events.every(
      (event, index) =>
        index === 0 || event.sequence > events[index - 1].sequence,
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(capture.snapshot()), "utf8") <= 3000,
  );
});

test("selection strings count toward admission and snapshot retention", () => {
  const hugeChannel = "x".repeat(1024 * 1024);
  const refused = createRecorder({
    ...selection(),
    channels: [hugeChannel],
    retention_bytes: 1024,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "resource_constraint");
  const retentionBytes = 9 * 1024 * 1024;
  const capture = recorder({
    ...selection(),
    channels: [hugeChannel],
    retention_bytes: retentionBytes,
  });
  const handler = valueOf(capture.wrapHandler(hugeChannel, () => 19));
  assert.equal(handler(), 19);
  const { events, coverage } = capture.snapshot();
  assert.deepEqual(events, []);
  assert.equal(coverage.status, "truncated");
  assert.equal(coverage.observed, 2);
  assert.equal(coverage.dropped, 2);
  assert.ok(coverage.estimated_retained_bytes >= hugeChannel.length);
  assert.ok(coverage.estimated_retained_bytes <= retentionBytes);
  assert.equal(capture.snapshot().selection.channels[0], hugeChannel);
});

test("caller selection and returned snapshots cannot mutate recorder state", () => {
  const input = selection();
  const capture = recorder(input);
  input.channels.push("outside");
  input.file_paths[0] = "/changed.txt";
  input.retention_bytes = 1024;
  const outside = () => "outside";
  assert.equal(valueOf(capture.wrapHandler("outside", outside)), outside);
  const handler = valueOf(capture.wrapHandler("save", () => 23));
  handler();
  const first = capture.snapshot();
  const baseline = structuredClone(first);
  first.selection.channels[0] = "changed";
  first.events[0].registration.script_name = "changed";
  first.events.length = 0;
  first.coverage.observed = -1;
  first.limitations.length = 0;
  assert.deepEqual(capture.snapshot(), baseline);
  handler();
  assert.equal(baseline.events.length, 2);
  assert.equal(capture.snapshot().events.length, 4);
});

test("malformed selections and non-callable wrappers return tagged failures", () => {
  const badSelections = [
    null,
    undefined,
    {},
    { ...selection(), channels: [] },
    { ...selection(), channels: [""] },
    { ...selection(), channels: ["save", "save"] },
    { ...selection(), file_paths: [] },
    { ...selection(), file_paths: ["relative.txt"] },
    { ...selection(), file_paths: [selectedPath, selectedPath] },
    { ...selection(), retention_bytes: 1023 },
    { ...selection(), retention_bytes: 1024.5 },
    { ...selection(), retention_bytes: "1024" },
    { ...selection(), unexpected: true },
  ];
  for (const input of badSelections) {
    const result = createRecorder(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_input");
    assert.equal(typeof result.error.message, "string");
  }
  const capture = recorder();
  for (const fn of [null, undefined, {}, 1, "function"]) {
    for (const result of [
      capture.wrapHandler("save", fn),
      capture.wrapFileWriter(fn),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid_input");
    }
  }
  assert.equal(capture.wrapHandler({}, () => {}).ok, false);
  assert.deepEqual(capture.snapshot().events, []);
});
