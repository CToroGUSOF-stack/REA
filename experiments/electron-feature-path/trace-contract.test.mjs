import assert from "node:assert/strict";
import test from "node:test";

import { createRecorder } from "./recorder.mjs";
import { traceSchema } from "./trace-contract.mjs";

const path = "/selected.txt";
const selection = () => ({
  channels: ["save"],
  file_paths: [path],
  retention_bytes: 64 * 1024,
});
const valueOf = (result) => {
  assert.equal(result.ok, true);
  return result.value;
};
const recorder = (input = selection()) => valueOf(createRecorder(input));
const writeSnapshot = () => {
  const capture = recorder();
  const write = valueOf(capture.wrapFileWriter(() => 7));
  write(path);
  return capture.snapshot();
};
const handlerSnapshot = () => {
  const capture = recorder();
  valueOf(capture.wrapHandler("save", () => 7))();
  return capture.snapshot();
};
const rejectMutation = (mutate, produce = writeSnapshot) => {
  const snapshot = produce();
  mutate(snapshot);
  assert.equal(traceSchema.safeParse(snapshot).success, false);
};

test("real recorder snapshots parse without altering selected facts", async () => {
  const capture = recorder();
  const write = valueOf(capture.wrapFileWriter(async () => "written"));
  const handler = valueOf(capture.wrapHandler("save", () => write(path)));
  assert.equal(await handler(), "written");
  const snapshot = capture.snapshot();
  const parsed = traceSchema.parse(snapshot);
  assert.deepEqual(parsed, snapshot);
  assert.equal(parsed.coverage.status, "selected-probes-retained");
  assert.equal(parsed.coverage.observed, 4);
  assert.equal(parsed.coverage.dropped, 0);
  const start = parsed.events.find(
    (event) => event.kind === "handler" && event.phase === "started",
  );
  const effect = parsed.events.find(
    (event) => event.kind === "file-write" && event.phase === "fulfilled",
  );
  assert.equal(effect.invocation_id, start.invocation_id);
  assert.equal(effect.within_handler, true);
  assert.equal(effect.path, path);
  assert.equal(typeof start.registration.script_name, "string");
});

test("an unused recorder has a valid empty trace with retained selection cost", () => {
  const snapshot = recorder().snapshot();
  const parsed = traceSchema.parse(snapshot);
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.coverage.observed, 0);
  assert.equal(parsed.coverage.retained, 0);
  assert.equal(parsed.coverage.dropped, 0);
  assert.ok(parsed.coverage.estimated_retained_bytes > 0);
  assert.deepEqual(parsed.selection, selection());
});

test("truncated snapshots retain the examined partial facts and coverage", () => {
  const capture = recorder({
    ...selection(),
    retention_bytes: writeSnapshot().coverage.estimated_retained_bytes,
  });
  const write = valueOf(capture.wrapFileWriter(() => 7));
  write(path);
  write(path);
  const snapshot = capture.snapshot();
  const parsed = traceSchema.parse(snapshot);
  assert.deepEqual(parsed, snapshot);
  assert.equal(parsed.coverage.status, "truncated");
  assert.equal(parsed.coverage.observed, 4);
  assert.equal(parsed.coverage.retained, 2);
  assert.equal(parsed.coverage.dropped, 2);
  assert.deepEqual(
    parsed.events.map((event) => event.phase),
    ["started", "returned"],
  );
  assert.ok(
    parsed.events.every(
      (event) => event.path === path && event.invocation_id === null,
    ),
  );
});

test("truncated snapshots may have zero retained events without claiming no observations", () => {
  const capture = recorder({
    ...selection(),
    retention_bytes: recorder().snapshot().coverage.estimated_retained_bytes,
  });
  valueOf(capture.wrapFileWriter(() => 7))(path);
  const parsed = traceSchema.parse(capture.snapshot());
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.coverage.status, "truncated");
  assert.equal(parsed.coverage.observed, 2);
  assert.equal(parsed.coverage.retained, 0);
  assert.equal(parsed.coverage.dropped, 2);
});

test("unknown handler lifetime remains null in a real later effect", async () => {
  const capture = recorder();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // oxlint-disable-next-line unicorn/no-thenable -- Exercise an opaque then getter without allowing the recorder to read it.
  const opaque = Object.defineProperty({}, "then", {
    get() {
      throw new Error("must not inspect a thenable");
    },
  });
  const write = valueOf(capture.wrapFileWriter(() => 7));
  let later;
  const handler = valueOf(
    capture.wrapHandler("save", () => {
      later = gate.then(() => write(path));
      return opaque;
    }),
  );
  assert.equal(handler(), opaque);
  release();
  assert.equal(await later, 7);
  const parsed = traceSchema.parse(capture.snapshot());
  const start = parsed.events.find(
    (event) => event.kind === "handler" && event.phase === "started",
  );
  const completion = parsed.events.find(
    (event) => event.phase === "returned_completion_unknown",
  );
  assert.equal(completion.within_handler, null);
  const effects = parsed.events.filter((event) => event.kind === "file-write");
  assert.equal(effects.length, 2);
  assert.ok(effects.every((event) => event.within_handler === null));
  assert.ok(
    effects.every((event) => event.invocation_id === start.invocation_id),
  );
});

test("malformed structure, event fields and experimental format are rejected", () => {
  for (const input of [null, undefined, {}, [], "trace"])
    assert.equal(traceSchema.safeParse(input).success, false);
  const mutations = [
    (trace) => {
      delete trace.events;
    },
    (trace) => {
      trace.format = "rea-evidence";
    },
    (trace) => {
      trace.events = null;
    },
    (trace) => {
      trace.events[0].kind = "native-call";
    },
    (trace) => {
      trace.events[0].phase = "completed";
    },
    (trace) => {
      trace.events[0].within_handler = "unknown";
    },
    (trace) => {
      trace.events[0].invocation_id = 0;
    },
    (trace) => {
      trace.events[0].effect_id = 1.5;
    },
    (trace) => {
      trace.coverage.observed = -1;
    },
    (trace) => {
      trace.selection.retention_bytes = 100;
    },
    (trace) => {
      trace.limitations = [false];
    },
  ];
  for (const mutate of mutations) rejectMutation(mutate);
  rejectMutation((trace) => {
    trace.events[0].registration.line = -1;
  }, handlerSnapshot);
});

test("extra fields at every contract boundary are rejected", () => {
  for (const mutate of [
    (trace) => {
      trace.extra = true;
    },
    (trace) => {
      trace.selection.extra = true;
    },
    (trace) => {
      trace.coverage.extra = true;
    },
    (trace) => {
      trace.events[0].payload = "not captured";
    },
  ])
    rejectMutation(mutate);
  rejectMutation((trace) => {
    trace.events[0].extra = true;
  }, handlerSnapshot);
  rejectMutation((trace) => {
    trace.events[0].registration.extra = true;
  }, handlerSnapshot);
});

test("coverage counter, status and retained-budget forgeries are rejected", () => {
  for (const mutate of [
    (trace) => {
      trace.coverage.retained -= 1;
    },
    (trace) => {
      trace.coverage.observed += 1;
    },
    (trace) => {
      trace.coverage.dropped = 1;
    },
    (trace) => {
      trace.coverage.status = "truncated";
    },
    (trace) => {
      trace.coverage.observed += 1;
      trace.coverage.dropped = 1;
    },
    (trace) => {
      trace.coverage.estimated_retained_bytes =
        trace.selection.retention_bytes + 1;
    },
  ])
    rejectMutation(mutate);
});

test("nonpositive, duplicate, descending and out-of-coverage sequences are rejected", () => {
  for (const mutate of [
    (trace) => {
      trace.events[0].sequence = 0;
    },
    (trace) => {
      trace.events[1].sequence = trace.events[0].sequence;
    },
    (trace) => {
      trace.events.reverse();
    },
    (trace) => {
      trace.events[1].sequence = trace.coverage.observed + 1;
    },
    (trace) => {
      trace.events[0].sequence = 1.5;
    },
  ])
    rejectMutation(mutate);
});

test("sequence gaps are valid when explicit dropped coverage accounts for them", () => {
  const snapshot = writeSnapshot();
  snapshot.events[1].sequence = 3;
  snapshot.coverage.observed = 3;
  snapshot.coverage.dropped = 1;
  snapshot.coverage.status = "truncated";
  assert.deepEqual(traceSchema.parse(snapshot), snapshot);
});

test("relative selected paths and relative recorded effect paths are rejected", () => {
  rejectMutation((trace) => {
    trace.selection.file_paths = ["relative.txt"];
  });
  rejectMutation((trace) => {
    trace.events[0].path = "relative.txt";
  });
});

test("recorded paths and handler channels must belong to the declared selection", () => {
  rejectMutation((trace) => {
    trace.events[0].path = "/unselected.txt";
  });
  rejectMutation((trace) => {
    trace.events[0].channel = "unselected";
  }, handlerSnapshot);
});

test("duplicate channel and file selections are rejected", () => {
  rejectMutation((trace) => {
    trace.selection.channels.push(trace.selection.channels[0]);
  });
  rejectMutation((trace) => {
    trace.selection.file_paths.push(trace.selection.file_paths[0]);
  });
});

test("NUL paths are rejected even when a recorded path matches the selection", () => {
  rejectMutation((trace) => {
    trace.selection.file_paths[0] = "/selected\0.txt";
    for (const event of trace.events)
      event.path = trace.selection.file_paths[0];
  });
  rejectMutation((trace) => {
    trace.events[0].path = "/selected\0.txt";
  });
});
