import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "renamed and defaulted bundler parameters retain export evidence through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundler-exports-");
    await writeFile(
      join(root, "bundle.js"),
      `
    throw new Error("This analysis fixture must not execute");
    globalThis.webpackChunkApp.push([[1], {
      17(module = {}, exports = {}) { module.exports = { parse: value => value }; },
      18(e = {}, t = {}, r) {
        e.exports = { parse: value => value };
        e.exports.extra = 1;
        Object.defineProperty(e.exports, "named", { value: 1 });
        r.d(t, { declared: () => 1 });
        function shadow(e = {}, t = {}) { e.exports.fake = 1; t.fake = 1; }
      },
      19(e) { e.exports = { parse: value => value }; }
    }]);
  `,
    );
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(analyzed.exitCode, analyzed.stderr).toBe(0);
    const contract = toolContract("analyze_javascript_application");
    const evidence = contract.outputSchema.parse(analyzed.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    const modules = result.graph.nodes.filter(
      ({ kind }) => kind === "javascript-module",
    );
    const exportsByKey = Object.fromEntries(
      modules.map(({ observations }) => [
        observations[0]?.properties.module_key,
        observations[0]?.properties.exports,
      ]),
    );
    expect(exportsByKey).toEqual({
      17: ["parse"],
      18: ["declared", "extra", "named", "parse"],
      19: ["parse"],
    });
    expect(result.graph.coverage.status).toBe("complete");
    for (const module of modules)
      expect(module.observations[0]?.evidence).toMatchObject({
        state: "observed",
        confidence: "exact",
        coverage: { status: "complete" },
      });
    const { client, call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: root,
    });
    expect(response.isError).not.toBe(true);
    const retained = contract.outputSchema.parse(response.structuredContent);
    expect(retained.evidence_id).toBe(evidence.evidence_id);
    await client.ping();
  },
);
