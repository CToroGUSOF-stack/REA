import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { createEvidence } from "../../dist/domain/evidence.js";
import { createVerifierRun } from "./verifier-run.mjs";

const errorReply = (code = "cleanup_incomplete") => ({
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: {
          code,
          category: "execution_failure",
          message: "Fixture provider cleanup failed",
          retryable: true,
          remediation: { action: "Retain and inspect the owned provider" },
          details: { cleanup: "incomplete", resources: ["fixture-process"] },
        },
      }),
    },
  ],
});

const captureReply = (change = (result) => result) => {
  const result = {
    application: {
      executable_path: "/fixture/electron",
      application_path: "/fixture/main.cjs",
      electron_version: "fixture-version",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
    },
    actions: [],
    windows: [],
    processes: { items: [] },
    ipc: { events: [], observed: 0, dropped: 0 },
    timeline: { events: [], observed: 0, dropped: 0 },
    retention: {
      budget_bytes: 1024,
      estimated_retained_bytes: 0,
      event_serialized_byte_upper_bound: 0,
      retained: 0,
      dropped: 0,
      dropped_event_families: [],
      dropped_event_roles: [],
      observed_ipc: 0,
      dropped_ipc: 0,
      observed_runtime: 0,
      dropped_runtime: 0,
    },
    coverage: {
      status: "complete",
      observed_event_families: [],
      unavailable_event_families: [],
      observed_roles: [],
      pre_capture_activity: "unavailable",
    },
    limitations: ["Controlled contract fixture, not a real Electron run."],
  };
  const evidence = createEvidence(
    undefined,
    {
      id: "fixture-electron",
      name: "Controlled Electron fixture",
      version: "1",
    },
    {
      predicateType: "fixture.electron-capture",
      operation: "capture_electron_scenario",
      parameters: {},
      result: change(result),
      confidence: "observed",
      authority: "controlled-replay",
    },
  );
  return { structuredContent: evidence };
};

const harness = (overrides = {}) => {
  const calls = [];
  const run = createVerifierRun({
    lifecycle: { state: () => ({ safe_to_close: true }) },
    closeClient: async () => calls.push("client"),
    closeTransport: async () => calls.push("transport"),
    closeHost: async () => calls.push("inspector"),
    writeArtifact: async (name) => calls.push(`write:${name}`),
    retainOwner: async () => calls.push("retain"),
    reportRetention: async () => calls.push("report-retention"),
    ...overrides,
  });
  return { run, calls };
};

test("cleanup_incomplete is owned before an ENOSPC reply artifact can fail", async () => {
  const noSpace = Object.assign(new Error("No space for the raw reply"), {
    code: "ENOSPC",
  });
  const reply = errorReply();
  const { run, calls } = harness({
    writeArtifact: async () => {
      assert.equal(run.state().must_retain, true);
      throw noSpace;
    },
  });
  const facts = run.observeReply("capture_electron_scenario", reply);
  assert.equal(facts.error.code, "cleanup_incomplete");
  assert.equal(run.unsafeReply().reply, reply);
  const written = await run.diagnostic("capture.json", () =>
    JSON.stringify(reply),
  );
  assert.equal(written.ok, false);
  assert.equal(written.error.cause, noSpace);
  assert.equal(facts.error.code, "cleanup_incomplete");
  assert.equal(run.state().failures[0].cause, noSpace);
  await run.finalize(async () => {});
  assert.deepEqual(calls, ["inspector", "report-retention", "retain"]);
});

for (const [label, reply] of [
  [
    "malformed error projection",
    { isError: true, content: [{ type: "text", text: "{}" }] },
  ],
  ["malformed Evidence", { structuredContent: {} }],
  [
    "valid Evidence with an invalid capture cleanup",
    captureReply((result) => ({
      ...result,
      application: { ...result.application, cleanup: "unverified" },
    })),
  ],
]) {
  test(`${label} latches unknown before its real parser throws`, async () => {
    const { run, calls } = harness();
    assert.throws(() => run.observeReply("capture_electron_scenario", reply));
    assert.equal(run.state().cleanup_unverified, true);
    assert.equal(run.unsafeReply().reply, reply);
    await run.finalize(async () => {});
    assert.deepEqual(calls, ["inspector", "report-retention", "retain"]);
  });
}

test("later normal replies cannot clear a retained incomplete cleanup", async () => {
  const { run, calls } = harness();
  const original = errorReply();
  run.observeReply("close_binary", original);
  const healthy = captureReply();
  const facts = run.observeReply("capture_electron_scenario", healthy);
  assert.equal(
    facts.evidence.evidence_id,
    healthy.structuredContent.evidence_id,
  );
  run.observeReply("export_evidence_bundle", { structuredContent: {} });
  assert.equal(run.state().must_retain, true);
  assert.equal(run.unsafeReply().reply, original);
  await run.finalize(async () => {});
  assert.deepEqual(calls, ["inspector", "report-retention", "retain"]);
});

test("independent diagnostic, reporting and inspector failures cannot bypass retain", async () => {
  const raw = errorReply();
  const artifactError = new Error("artifact sink failed");
  const inspectorError = new Error("inspector cleanup failed");
  const reportingError = new Error("retention reporting failed");
  const observerError = new Error("failure observer failed");
  const { run, calls } = harness({
    writeArtifact: async () => {
      throw artifactError;
    },
    closeHost: async () => {
      calls.push("inspector");
      throw inspectorError;
    },
    reportRetention: async () => {
      calls.push("report-retention");
      throw reportingError;
    },
    onFailure: () => {
      throw observerError;
    },
  });
  run.observeReply("capture_electron_scenario", raw);
  await run.finalize(async () => {
    await run.diagnostic("stderr.txt", () => Buffer.from("stderr"));
    await run.diagnostic("lifecycle.json", () => "{}");
  });
  assert.deepEqual(calls, ["inspector", "report-retention", "retain"]);
  assert.equal(run.unsafeReply().reply, raw);
  const failures = run.state().failures;
  assert.deepEqual(
    failures
      .filter(({ stage }) => stage !== "failure-reporting")
      .map(({ stage }) => stage),
    [
      "close-inspector",
      "artifact:stderr.txt",
      "artifact:lifecycle.json",
      "retention-reporting",
    ],
  );
  assert.equal(
    failures.filter(({ cause }) => cause === observerError).length,
    4,
  );
});

test("throwing diagnostics still reach inspector cleanup and final retention", async () => {
  const diagnosticsError = new Error("Cannot produce diagnostic bytes");
  const { run, calls } = harness({
    lifecycle: { state: () => ({ safe_to_close: false }) },
  });
  await run.finalize(async () => {
    throw diagnosticsError;
  });
  assert.deepEqual(calls, ["inspector", "report-retention", "retain"]);
  assert.equal(run.state().failures[0].cause, diagnosticsError);
});

test("a fully parsed successful capture closes owned resources without retaining", async () => {
  const { run, calls } = harness();
  const reply = captureReply();
  const facts = run.observeReply("capture_electron_scenario", reply);
  assert.equal(
    facts.evidence.normalized_result.application.cleanup,
    "terminated-owned-process",
  );
  assert.equal(run.state().must_retain, false);
  assert.equal(run.unsafeReply(), undefined);
  await run.finalize(async () => {
    await run.diagnostic("lifecycle.json", () => "{}");
  });
  assert.deepEqual(calls, [
    "inspector",
    "client",
    "transport",
    "write:lifecycle.json",
  ]);
  assert.deepEqual(run.state().failures, []);
});

test("a client-close failure preserves ownership and skips forced transport close", async () => {
  const closeError = new Error("client close failed");
  const { run, calls } = harness({
    closeClient: async () => {
      calls.push("client");
      throw closeError;
    },
  });
  await run.finalize(async () => {});
  assert.deepEqual(calls, [
    "inspector",
    "client",
    "report-retention",
    "retain",
  ]);
  assert.equal(run.state().failures[0].cause, closeError);
  assert.equal(run.state().must_retain, true);
});

test("inspector failure keeps the server open and is present in final diagnostics", async () => {
  const closeError = new Error("inspector cleanup failed");
  let diagnosticState;
  const { run, calls } = harness({
    closeHost: async () => {
      calls.push("inspector");
      throw closeError;
    },
    writeArtifact: async (_name, bytes) => {
      diagnosticState = JSON.parse(bytes);
      calls.push("write:lifecycle.json");
    },
  });
  run.observeReply("capture_electron_scenario", captureReply());
  await run.finalize(async () => {
    await run.diagnostic("lifecycle.json", () => JSON.stringify(run.state()));
  });
  assert.deepEqual(calls, [
    "inspector",
    "write:lifecycle.json",
    "report-retention",
    "retain",
  ]);
  assert.equal(diagnosticState.cleanup_unverified, true);
  assert.equal(diagnosticState.must_retain, true);
  assert.equal(run.state().failures[0].cause, closeError);
});

test("the real retention owner keeps Node alive without other referenced handles", async () => {
  const moduleUrl = new URL("verifier-run.mjs", import.meta.url).href;
  const program = `
    import { createVerifierRun, retainVerifierOwner } from ${JSON.stringify(moduleUrl)};
    const events = [];
    setTimeout(() => {
      process.stdout.write(JSON.stringify(events), () => process.exit(0));
    }, 50).unref();
    const run = createVerifierRun({
      lifecycle: { state: () => ({ safe_to_close: true }) },
      closeClient: async () => { events.push("client"); },
      closeTransport: async () => { events.push("transport"); },
      closeHost: async () => {
        events.push("inspector");
        throw new Error("Inspector directory cleanup failed");
      },
      writeArtifact: async () => {},
      reportRetention: () => { events.push("retain"); },
      retainOwner: retainVerifierOwner,
    });
    await run.finalize(async () => {});
  `;
  // The unref'ed proof timer cannot keep the child alive by itself. A bare
  // unresolved retention Promise exits with Node's unsettled-await status 13.
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { timeout: 5000, maxBuffer: 8192 },
  );
  assert.deepEqual(JSON.parse(stdout), ["inspector", "retain"]);
  assert.equal(stderr, "");
});
