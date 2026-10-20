import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { reconstructionObligationLedgerSchema } from "../../../src/domain/reconstructionObligationLedgerSchemas.js";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";

const execute = promisify(execFile);

describe("reconstruction obligation ledger CLI parity", () => {
  it("reports non-canonical authenticated bundles as caller input", async () => {
    const records = ["first", "second"].map((label) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: { label },
          result: { label },
        },
      ),
    );
    const canonical = createEvidenceBundle(records);
    const input = {
      evidence_bundle: canonical,
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    };
    const accepted = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
    );
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      normalized_result: { status: "unknown", summary: { total: 0 } },
    });
    input.evidence_bundle = {
      ...canonical,
      records: [...canonical.records].reverse(),
    };
    let stdout: string;
    try {
      await execute(
        process.execPath,
        [
          "scripts/rea.mjs",
          "build-reconstruction-obligation-ledger",
          JSON.stringify(input),
          "--json",
        ],
        { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
      );
      throw new Error("Expected non-canonical bundle input to fail");
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error) ||
        !("stdout" in cause) ||
        typeof cause.stdout !== "string"
      )
        throw cause;
      stdout = cause.stdout;
    }
    expect(JSON.parse(stdout)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      details: {
        operation: "build_reconstruction_obligation_ledger",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining(
              "Evidence bundle manifests are not canonical",
            ),
          }),
        ],
      },
    });
  }, 20_000);

  it("builds the same Evidence-backed empty ledger through the CLI", async () => {
    const input = {
      evidence_bundle: createEvidenceBundle([]),
      reviewed_obligations: [],
      manifest: {
        bindings: [],
        contradictions: [],
      },
    };
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      predicate_type: "rea.reconstruction-obligation-ledger",
      normalized_result: {
        schema: "ReconstructionObligationLedger",
        status: "unknown",
        summary: { total: 0 },
      },
    });
  }, 20_000);
});

cliTest(
  "retains authentic dynamic-event uncertainty through analysis and ledger CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ledger-semantic-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "sample-app", version: "1.0.0", main: "main.js" }),
    );
    await writeFile(
      join(root, "main.js"),
      [
        "const events = require('node:events');",
        "const bus = new events.EventEmitter();",
        "bus.on(process.argv[2], () => console.log('done'));",
      ].join("\n"),
    );
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(analyzed.exitCode).toBe(0);
    const application = parseEvidence(analyzed.json);
    const source = javascriptApplicationAnalysisResultSchema.parse(
      application.normalized_result,
    );
    expect(source.graph.coverage.status).toBe("complete");
    expect(source.semantic_graph.coverage.status).toBe("unknown");
    const eventUnknown = source.semantic_graph.unknowns.find(
      ({ family }) => family === "event",
    );
    expect(eventUnknown?.detail).toBe(
      "Dynamic on event name remains unresolved.",
    );
    if (eventUnknown === undefined)
      throw new Error("Missing analyzer event frontier");
    const requestPath = join(root, "ledger-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        evidence_bundle: createEvidenceBundle([application]),
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      }),
    );
    const built = await cli.run({
      arguments: [
        "build-reconstruction-obligation-ledger",
        requestPath,
        "--json",
      ],
    });
    expect(built.exitCode).toBe(0);
    const ledger = reconstructionObligationLedgerSchema.parse(
      parseEvidence(built.json).normalized_result,
    );
    const event = ledger.obligations.find(
      ({ target }) => target.semantic_node_id === eventUnknown.node_id,
    );
    expect(event).toMatchObject({
      family: "event",
      residual_unknown_ids: [eventUnknown.unknown_id],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "residual-unknown" }),
      ]),
    });
    expect(
      ledger.obligations.some(({ family }) => family === "package-lifecycle"),
    ).toBe(true);
    expect(ledger.reports.residual_unknown_ids).toContain(
      eventUnknown.unknown_id,
    );
    expect(ledger.coverage.status).toBe("partial");
    expect(ledger.status).not.toBe("ready");
    for (const unknown of source.semantic_graph.unknowns)
      expect(
        ledger.limitations.some(
          (limitation) =>
            limitation.includes(unknown.unknown_id) &&
            limitation.includes(unknown.detail),
        ),
      ).toBe(true);
  },
);
