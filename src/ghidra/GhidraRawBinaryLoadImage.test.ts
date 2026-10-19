import { describe, expect, it } from "vitest";

import { attestGhidraRawBinaryLoadImage } from "./GhidraLoadImageValues.js";
import { fixtureRawBinaryLoadImage } from "./GhidraRawBinaryLoadImage.fixture.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

describe("raw-binary Ghidra language binding", () => {
  it("maps the four admitted families to little-endian generic languages", () => {
    expect(ghidraRawBinaryLanguage("x86")).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "gcc",
    });
    expect(ghidraRawBinaryLanguage("x86_64")).toEqual({
      languageId: "x86:LE:64:default",
      compilerSpecId: "gcc",
    });
    expect(ghidraRawBinaryLanguage("arm")).toEqual({
      languageId: "ARM:LE:32:v7",
      compilerSpecId: "default",
    });
    expect(ghidraRawBinaryLanguage("arm64")).toEqual({
      languageId: "AARCH64:LE:64:v8A",
      compilerSpecId: "default",
    });
  });
});

describe("raw-binary multi-architecture load-image checks", () => {
  it.each(["x86", "x86_64", "arm", "arm64"] as const)(
    "verifies mapped bytes across admitted CPU architecture %s",
    (architecture) => {
      const f = fixtureRawBinaryLoadImage(architecture);
      const result = attestGhidraRawBinaryLoadImage(
        f.snapshot,
        f.target,
        f.observation,
      );
      const language = ghidraRawBinaryLanguage(architecture);
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: "verified",
          format: "raw-binary",
          architecture,
          language_id: language.languageId,
          compiler_spec_id: language.compilerSpecId,
          base_address: f.target.entryPoint,
          file_bytes: f.snapshot.bytes,
          entry: { address: f.target.entryPoint, file_offset: 0 },
        },
      });
      if (!result.ok) throw result.error;
      if (result.value.status !== "verified")
        throw new Error("Expected verified status");
      expect(result.value.checks.every((item) => item.matched)).toBe(true);
    },
  );
});

describe("raw-binary load-image invariant mismatch checks", () => {
  it.each([
    {
      name: "mapping.sha256",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings[0]!.sha256 = "0".repeat(64);
      },
    },
    {
      name: "mapping.start",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings[0]!.start = "0x0";
      },
    },
    {
      name: "mapping.end",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings[0]!.end = "0x8000001";
      },
    },
    {
      name: "mapping.file_offset",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings[0]!.file_offset = 4;
      },
    },
    {
      name: "mapping.length",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings[0]!.length = 100;
      },
    },
    {
      name: "mapping_count",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.mappings = [];
      },
    },
    {
      name: "mapping_count",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        const m = f.observation.mappings[0]!;
        f.observation.mappings = [m, { ...m, block: "ram2" }];
      },
    },
    {
      name: "compiler_spec_id",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.compiler_spec_id = "drifted_cspec";
      },
    },
    {
      name: "modified_file_sha256",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.source_files[0]!.modified_sha256 = "1".repeat(64);
      },
    },
    {
      name: "original_file_sha256",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.source_files[0]!.original_sha256 = "1".repeat(64);
      },
    },
    {
      name: "source_file_count",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.source_files = [];
      },
    },
    {
      name: "source_file_size",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.source_files[0]!.size = 9999;
      },
    },
    {
      name: "image_base",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.image_base = "0x1000";
      },
    },
    {
      name: "executable_format",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.executable_format = "ELF";
      },
    },
    {
      name: "relocation_records",
      mutate: (f: ReturnType<typeof fixtureRawBinaryLoadImage>) => {
        f.observation.relocations = [
          {
            address: "0x8000000",
            segment: null,
            offset: null,
            status: "applied",
            type: 1,
            values: [],
            original_bytes_hex: "00000000",
            memory_bytes_hex: "1eff2fe1",
          },
        ];
      },
    },
  ])(
    "detects mismatch in $name check when raw-binary invariant is violated",
    ({ name, mutate }) => {
      const f = fixtureRawBinaryLoadImage();
      mutate(f);
      const result = attestGhidraRawBinaryLoadImage(
        f.snapshot,
        f.target,
        f.observation,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: "mismatch",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name,
              matched: false,
            }),
          ]),
        },
      });
    },
  );
});

describe("raw-binary entry point and snapshot identity checks", () => {
  it("retains mismatch evidence for a drifted language", () => {
    const f = fixtureRawBinaryLoadImage();
    f.observation.language_id = "x86:LE:32:default";
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: "mismatch", observations: f.observation },
    });
  });
  it("preserves additional language entries while requiring the caller entry", () => {
    const f = fixtureRawBinaryLoadImage();
    f.observation.entry_points = ["0x0", f.target.entryPoint, "0xffff0000"];
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: { status: "verified", observations: f.observation },
    });
    f.observation.entry_points = ["0x0", "0xffff0000"];
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "entry_point",
            matched: false,
            observed: null,
          }),
        ]),
      },
    });
  });
  it("rejects stale snapshot identity", () => {
    const f = fixtureRawBinaryLoadImage();
    expect(
      attestGhidraRawBinaryLoadImage(
        f.snapshot,
        { ...f.target, sha256: "f".repeat(64) },
        f.observation,
      ).ok,
    ).toBe(false);
  });
});
