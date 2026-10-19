import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectErlangBeamInputSchema } from "../domain/erlang/beam.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  erlangBeamFixture,
  erlangBeamManyAtomsFixture,
} from "./Beam.fixture.js";
import { parseErlangBeam } from "./BeamParser.js";

const defaults = inspectErlangBeamInputSchema.parse({
  path: "/artifacts/app.beam",
});

const parse = (bytes: Buffer, input = defaults) =>
  parseErlangBeam(
    bytes,
    {
      path: input.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    input,
  );

it("reads atoms, exports, imports, lambdas and the Code header", () => {
  const report = parse(erlangBeamFixture("demo"));
  expect(report.atom_encoding).toBe("utf8");
  expect(report.module).toBe("demo");
  expect(report.atoms?.map((atom) => atom.name)).toEqual([
    "demo",
    "module_info",
    "start",
    "erlang",
    "get_module_info",
  ]);
  expect(report.exports).toEqual([
    { function_index: 3, function: "start", arity: 0, label: 2 },
    { function_index: 2, function: "module_info", arity: 0, label: 1 },
    { function_index: 2, function: "module_info", arity: 1, label: 3 },
  ]);
  expect(report.imports).toEqual([
    {
      module_index: 4,
      module: "erlang",
      function_index: 5,
      function: "get_module_info",
      arity: 1,
    },
  ]);
  expect(report.lambdas?.[0]).toMatchObject({
    function: "start",
    arity: 1,
    label: 4,
    old_unique: 42,
  });
  expect(report.code).toMatchObject({
    instruction_set: 0,
    opcode_max: 169,
    labels: 4,
    functions: 2,
    extra_header_bytes: 0,
    instructions: { bytes: 4 },
  });
  expect(report.chunks.map((chunk) => chunk.name)).toEqual([
    "AtU8",
    "Code",
    "ExpT",
    "ImpT",
    "FunT",
  ]);
});

it("fails a truncated FOR1 container without partial success", () => {
  expect(() => parse(Buffer.from("FOR1"))).toThrow(ArtifactReaderFailure);
});

it("fails a FOR1 form that is not BEAM", () => {
  const bytes = Buffer.alloc(16);
  bytes.write("FOR1");
  bytes.writeUInt32BE(8, 4);
  bytes.write("WAVE", 8);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("fails when the atom budget is exhausted", () => {
  const bytes = erlangBeamManyAtomsFixture(3);
  expect(() =>
    parse(
      bytes,
      inspectErlangBeamInputSchema.parse({
        path: defaults.path,
        max_atoms: 1,
      }),
    ),
  ).toThrow(ArtifactReaderFailure);
});
