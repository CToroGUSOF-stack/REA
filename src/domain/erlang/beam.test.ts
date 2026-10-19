import { expect, it } from "vitest";
import { inspectErlangBeamInputSchema, erlangBeamSchema } from "./beam.js";

it("rejects extra caller arguments and admits a BEAM form with no tables", () => {
  expect(
    inspectErlangBeamInputSchema.safeParse({
      path: "/artifacts/app.beam",
      extra: true,
    }).success,
  ).toBe(false);
  const report = erlangBeamSchema.parse({
    artifact: {
      path: "/artifacts/app.beam",
      sha256: "a".repeat(64),
      bytes: 16,
    },
    form: { location: { offset: 0, bytes: 12 }, size: 4 },
    chunks: [],
    atoms: null,
    atom_encoding: null,
    exports: null,
    imports: null,
    lambdas: null,
    code: null,
    module: null,
    coverage: { status: "complete", examined_chunks: 0, atoms: 0 },
    limitations: ["No atom table was present."],
  });
  expect(report.atoms).toBeNull();
  expect(report.module).toBeNull();
});
