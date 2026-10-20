import { expect, it } from "vitest";
import { dependencyReconstructionCoverageData } from "../../../src/domain/reconstructionCoverage.fixture.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";

it("reports a transitive missing dependency through the compiled CLI and preserves complete controls", async () => {
  const observedAt = new Date().toISOString();
  for (const [edges, status] of [
    [{ "cli.help": [] }, "ready"],
    [{ "cli.help": ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"], absent: [] }, "ready"],
  ] as const) {
    const input = {
      coverage: dependencyReconstructionCoverageData(edges, observedAt),
      boundary_id: "replacement.cli",
    };
    const result = await runCliJson([
      "evaluate-reconstruction-coverage",
      JSON.stringify(input),
      "--json",
    ]);
    expect(result).toMatchObject({ status, boundary_id: "replacement.cli" });
  }
});
