import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv2020 from "ajv/dist/2020.js";
import { estimateTokenCount } from "tokenx";
import { z } from "zod";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { parseEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import { createMcpLifecycle } from "./mcp-lifecycle.mjs";
import { createVerifierRun, retainVerifierOwner } from "./verifier-run.mjs";
import { traceSchema } from "./trace-contract.mjs";
import { verifyNoTokenOwnedProcesses } from "../../dist/process/ProcessOwnership.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../../dist/process/ProcessOwnershipObservation.js";

const { values } = parseArgs({
  options: {
    electron: { type: "string" },
    output: { type: "string" },
    baseline: { type: "boolean", default: false },
    "cancel-after-ready": { type: "boolean", default: false },
  },
});
if (
  !values.electron ||
  !values.output ||
  !isAbsolute(values.electron) ||
  !isAbsolute(values.output)
)
  throw new Error(
    "Use --electron ABS_EXECUTABLE --output NEW_ABS_DIRECTORY [--baseline]",
  );

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("fixture", import.meta.url));
const executable = await realpath(values.electron);
// A fresh output directory is the filesystem authority boundary. Never overwrite.
await mkdir(values.output, { mode: 0o700 });
const output = await realpath(values.output);
await mkdir(join(output, "profile"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = [
  join(fixture, "main.cjs"),
  join(fixture, "preload.cjs"),
  join(fixture, "renderer.js"),
  join(fixture, "renderer.html"),
  join(fixture, "..", "recorder.mjs"),
  join(fixture, "..", "trace-contract.mjs"),
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("mcp-lifecycle.mjs", import.meta.url)),
  fileURLToPath(new URL("verifier-run.mjs", import.meta.url)),
];
const sourceDigests = await Promise.all(
  sourcePaths.map(async (path) => ({
    path,
    sha256: hash(await readFile(path)),
  })),
);
const selectedPaths = { electron: values.electron, output: values.output };
const executableIdentity = {
  path: executable,
  sha256: hash(await readFile(executable)),
};
const verifySourceIdentity = async () => {
  for (const source of sourceDigests)
    assert.equal(
      hash(await readFile(source.path)),
      source.sha256,
      `Source changed: ${source.path}`,
    );
  assert.equal(
    hash(await readFile(executable)),
    executableIdentity.sha256,
    "Electron executable changed",
  );
};
await writeFile(
  join(output, "selection.json"),
  JSON.stringify(
    {
      selected_paths: selectedPaths,
      executable: executableIdentity,
      mode: values["cancel-after-ready"]
        ? "cancellation-probe"
        : values.baseline
          ? "baseline"
          : "prototype",
      source_digests: sourceDigests,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
const client = new Client({
  name: "rea-feature-path-experiment",
  version: "1",
});
await prepareProcessOwnershipInspection();
const captureBaseline = await systemProcessOwnershipHost.captureBaseline();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "scripts/rea.mjs"), "mcp"],
  cwd: root,
  env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
  stderr: "pipe",
});
const lifecycle = createMcpLifecycle({
  client,
  transport,
  verify_cancelled: async () => {
    // This request drains admitted capture work even when the SDK suppresses
    // the cancelled request's reply. The drain alone does not prove cleanup.
    const drain = await client.callTool(
      { name: "close_binary", arguments: {} },
      { timeout: 30000 },
    );
    run.observeReply("close_binary", drain);
    await run.diagnostic("cancellation-drain.json", () =>
      JSON.stringify(drain),
    );
    assert.notEqual(drain.isError, true, "Session drain failed");
    const ownershipBytes = await readFile(join(output, "ownership.json"));
    const ownership = z
      .strictObject({
        run_id: z.string().uuid(),
        launcher_pid: z.number().int().positive(),
        electron_version: z.string().min(1),
      })
      .parse(JSON.parse(ownershipBytes.toString("utf8")));
    await prepareProcessOwnershipInspection();
    const check = await verifyNoTokenOwnedProcesses(
      ownership.run_id,
      systemProcessOwnershipHost,
      captureBaseline,
      {
        leaderPid: ownership.launcher_pid,
        processGroupId: ownership.launcher_pid,
      },
    );
    await run.diagnostic("cancellation-process-check.json", () =>
      JSON.stringify(check),
    );
    assert.equal(
      check.cleaned,
      true,
      "Token-owned process cleanup remains unknown",
    );
    return {
      status: "verified-token-absence",
      ownership,
      ownership_sha256: hash(ownershipBytes),
      process_check: check,
    };
  },
});
const run = createVerifierRun({
  lifecycle,
  closeClient: () => client.close(),
  closeTransport: () => transport.close(),
  closeHost: () => systemProcessOwnershipHost.close?.(),
  writeArtifact: (name, bytes) =>
    writeFile(join(output, name), bytes, { flag: "wx" }),
  // Keep the process and connection available for manual recovery even if
  // every diagnostic destination or the inspector fails.
  retainOwner: retainVerifierOwner,
  reportRetention: () => {
    process.exitCode = 1;
    console.error(
      `Cleanup unverified; retaining the owned MCP server connection. Diagnostics: ${output}`,
    );
  },
  onFailure: (stage, cause) => {
    process.exitCode = 1;
    console.error(`Verifier ${stage} failed: ${String(cause)}`);
  },
});
const started = performance.now();
const cancel = () => lifecycle.cancel();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

try {
  lifecycle.throwIfCancelled();
  await client.connect(transport);
  lifecycle.throwIfCancelled();
  const listed = await client.listTools();
  lifecycle.throwIfCancelled();
  const catalogJson = JSON.stringify(listed);
  const tokenEstimates = {
    method: "tokenx heuristic; not billed/model tokens",
    complete_catalog: estimateTokenCount(catalogJson),
    requests_and_replies: 0,
    actual_model_tokens: null,
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const call = async (name, args, stage) => {
    lifecycle.throwIfCancelled();
    const tool = listed.tools.find((item) => item.name === name);
    assert.ok(tool, `Missing ${name}`);
    await writeFile(
      join(output, `${name}${stage ? `-${stage}` : ""}-request.json`),
      JSON.stringify({ name, arguments: args }),
      { flag: "wx" },
    );
    assert.ok(ajv.validate(tool.inputSchema, args), JSON.stringify(ajv.errors));
    const reply = await lifecycle.call(name, args);
    // Cleanup facts belong to the reply boundary, before serialization,
    // token accounting, or artifact writes can fail.
    const facts = run.observeReply(name, reply);
    const replyJson = JSON.stringify(reply);
    tokenEstimates.requests_and_replies +=
      estimateTokenCount(JSON.stringify({ name, arguments: args })) +
      estimateTokenCount(replyJson);
    await writeFile(
      join(output, `${name}${stage ? `-${stage}` : ""}.json`),
      replyJson,
      {
        flag: "wx",
      },
    );
    assert.notEqual(reply.isError, true, `${name} failed; see ${output}`);
    assert.ok(
      ajv.validate(tool.outputSchema, reply.structuredContent),
      JSON.stringify(ajv.errors),
    );
    return facts.evidence ?? reply.structuredContent;
  };

  const staticSummary = parseEvidence(
    await call("analyze_javascript_application", {
      input_path: fixture,
      format: "directory",
      detail: "summary",
    }),
  );
  const feature = parseEvidence(
    await call("trace_application_feature", {
      application: {
        kind: "retained-evidence",
        evidence_id: staticSummary.normalized_result.parent_evidence_id,
      },
      seed: { kind: "channel", value: "prototype:export", match: "exact" },
    }),
  );
  // Summary replies omit the complete retained parent. Persist and validate
  // it before capture can fail or cancellation can clear the session ledger.
  await call(
    "export_evidence_bundle",
    {
      path: join(output, "evidence-checkpoint.json"),
    },
    "before-capture",
  );
  const checkpoint = parseEvidenceBundle(
    JSON.parse(
      await readFile(join(output, "evidence-checkpoint.json"), "utf8"),
    ),
  );
  assert.ok(
    checkpoint.records.some(
      (record) =>
        record.evidence_id ===
        staticSummary.normalized_result.parent_evidence_id,
    ),
    "Checkpoint omitted the complete static parent",
  );
  if (values["cancel-after-ready"]) {
    const waitForReady = async () => {
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        try {
          assert.equal(await readFile(join(output, "ready"), "utf8"), "ready");
          return;
        } catch (cause) {
          if (cause?.code !== "ENOENT") throw cause;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new Error("Fixture readiness was not observed");
    };
    void waitForReady().then(
      () => lifecycle.cancel("Cancellation probe after fixture readiness"),
      () => lifecycle.cancel("Fixture readiness deadline elapsed"),
    );
  }
  const capture = await call("capture_electron_scenario", {
    executable_path: executable,
    application_path: join(fixture, "main.cjs"),
    application_root: fixture,
    args: [output, ...(values.baseline ? ["baseline"] : [])],
    actions: values["cancel-after-ready"]
      ? [{ kind: "click", step_id: "blocked", selector: "#never-exists" }]
      : [
          { kind: "click", step_id: "export", selector: "#export" },
          { kind: "click", step_id: "flush", selector: "#flush" },
          { kind: "click", step_id: "barrier", selector: "#flushed" },
        ],
  });
  await call(
    "export_evidence_bundle",
    {
      path: join(output, "evidence-bundle.json"),
    },
    "after-capture",
  );
  const bundleBytes = await readFile(join(output, "evidence-bundle.json"));
  const bundle = parseEvidenceBundle(JSON.parse(bundleBytes.toString("utf8")));
  assert.ok(
    bundle.records.some(
      (record) =>
        record.evidence_id ===
        staticSummary.normalized_result.parent_evidence_id,
    ),
  );
  assert.equal(
    capture.normalized_result.application.cleanup,
    "terminated-owned-process",
  );
  assert.ok(
    capture.normalized_result.actions.every(
      (action) => action.status === "completed",
    ),
  );
  assert.ok(
    capture.normalized_result.ipc.events.some(
      (event) =>
        event.kind === "main-handler-invocation" &&
        event.channel === "prototype:export",
    ),
  );
  const traceBytes = await readFile(join(output, "trace.json"));
  const trace = traceSchema.parse(JSON.parse(traceBytes.toString("utf8")));
  const starts = trace.events.filter(
    (event) => event.kind === "handler" && event.phase === "started",
  );
  const writes = trace.events.filter(
    (event) => event.kind === "file-write" && event.phase === "fulfilled",
  );
  if (values.baseline) assert.equal(trace.events.length, 0);
  else {
    assert.equal(trace.coverage.dropped, 0);
    assert.equal(starts.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].invocation_id, starts[0].invocation_id);
    assert.equal(writes[0].within_handler, true);
    assert.equal(writes[0].path, join(output, "result.txt"));
    assert.equal(starts[0].registration.script_name, join(fixture, "main.cjs"));
    assert.ok(
      trace.events.some(
        (event) => event.kind === "handler" && event.phase === "fulfilled",
      ),
    );
  }
  assert.equal(
    await readFile(join(output, "result.txt"), "utf8"),
    "fixture exported\n",
  );
  await verifySourceIdentity();
  const summary = {
    mode: values.baseline ? "baseline" : "prototype",
    node: process.version,
    selected_paths: selectedPaths,
    executable: executableIdentity,
    server: client.getServerVersion(),
    electron_version: capture.normalized_result.application.electron_version,
    source_digests: sourceDigests,
    evidence_ids: {
      static_summary: staticSummary.evidence_id,
      feature: feature.evidence_id,
      capture: capture.evidence_id,
    },
    experimental_trace_sha256: hash(traceBytes),
    evidence_bundle: {
      path: join(output, "evidence-bundle.json"),
      sha256: hash(bundleBytes),
      records: bundle.records.length,
    },
    mcp_catalog_bytes: Buffer.byteLength(catalogJson, "utf8"),
    token_estimates: tokenEstimates,
    observed_relation: values.baseline
      ? null
      : {
          invocation_id: starts[0].invocation_id,
          effect_id: writes[0].effect_id,
          authority: "fixture-probe-async-context",
          ui_action_association: "unknown",
        },
    cleanup: capture.normalized_result.application.cleanup,
    elapsed_ms: performance.now() - started,
    limitations: trace.limitations,
  };
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(summary));
} catch (cause) {
  if (!values["cancel-after-ready"] || cause?.code !== "cancelled_verified") {
    process.exitCode = 1;
    run.recordFailure("verification", cause);
    await run.diagnostic("failure.json", () =>
      JSON.stringify({
        code: cause?.code ?? "verification_failed",
        message: String(cause),
      }),
    );
    console.error(`Verification failed; diagnostics: ${output}`);
  } else {
    await verifySourceIdentity();
    const result = {
      mode: "cancellation-probe",
      node: process.version,
      selected_paths: selectedPaths,
      executable: executableIdentity,
      server: client.getServerVersion(),
      original_reply: "suppressed-or-unavailable",
      independent_verification: cause.verification,
      elapsed_ms: performance.now() - started,
      source_digests: sourceDigests,
    };
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(result, null, 2),
      { flag: "wx" },
    );
    console.log(JSON.stringify(result));
  }
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  await run.finalize(async () => {
    await run.diagnostic(
      "server-stderr.txt",
      () => lifecycle.stderrSnapshot().bytes,
    );
    await run.diagnostic("lifecycle.json", () => {
      const { bytes: _bytes, ...stderrCoverage } = lifecycle.stderrSnapshot();
      return JSON.stringify(
        {
          ...lifecycle.state(),
          cleanup_unverified: run.state().cleanup_unverified,
          server_pid: transport.pid ?? null,
          stderr: stderrCoverage,
        },
        null,
        2,
      );
    });
  });
}
