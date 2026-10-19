import { describe, expect, it } from "vitest";

import { executableFormatHintSchema } from "./dosCom.js";
import {
  admitRawBinary,
  parseRawBinaryEntryPoint,
  rawBinarySelectionError,
  validateRawBinaryLength,
} from "./rawBinary.js";

describe("headerless format hints", () => {
  it("admits dos-com and raw-binary names only", () => {
    expect(executableFormatHintSchema.safeParse("dos-com").success).toBe(true);
    expect(executableFormatHintSchema.safeParse("raw-binary").success).toBe(
      true,
    );
    expect(executableFormatHintSchema.safeParse("raw").success).toBe(false);
  });
});

describe("raw-binary entry addresses", () => {
  it("canonicalizes equivalent hex spellings without dropping the source", () => {
    const parsed = parseRawBinaryEntryPoint("0x08000000");
    expect(parsed).toEqual({
      ok: true,
      value: {
        source: "0x08000000",
        canonical: "0x8000000",
        value: 0x8000000n,
      },
    });
  });
  it.each(["8000000", "0x", "0xgg", "0X8000000", ""])(
    "rejects malformed entry %s",
    (value) => {
      expect(parseRawBinaryEntryPoint(value).ok).toBe(false);
    },
  );
});

describe("raw-binary admission", () => {
  it("admits a little-endian ARM image mapped at the caller entry", () => {
    expect(
      admitRawBinary({
        architecture: "arm",
        entryPoint: "0x8000000",
        fileBytes: 4,
      }),
    ).toEqual({
      ok: true,
      value: {
        architecture: "arm",
        entryPoint: "0x8000000",
        entryPointSource: "0x8000000",
      },
    });
  });
  it("rejects an empty file as a target refusal while naming the extent", () => {
    expect(validateRawBinaryLength(0).ok).toBe(false);
    const result = admitRawBinary({
      architecture: "x86",
      entryPoint: "0x1000",
      fileBytes: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        reason: "raw-binary requires at least one file byte",
        constraint: "file_format_rejected",
      },
    });
  });
  it.each(["arm", "x86"] as const)(
    "rejects a 32-bit mapping that exceeds the %s architecture width",
    (architecture) => {
      const result = admitRawBinary({
        architecture,
        entryPoint: "0xfffffffc",
        fileBytes: 8,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected overflow rejection");
      expect(result.error.reason).toContain(`${architecture} address width`);
      expect(result.error.constraint).toBe("load_selection_rejected");
    },
  );
  it("allows a 64-bit mapping that would overflow 32-bit ARM", () => {
    expect(
      admitRawBinary({
        architecture: "arm64",
        entryPoint: "0xfffffffc",
        fileBytes: 8,
      }).ok,
    ).toBe(true);
  });
  it.each(["x86_64", "arm64"] as const)(
    "rejects a 64-bit mapping that exceeds the %s architecture width",
    (architecture) => {
      const result = admitRawBinary({
        architecture,
        entryPoint: "0xfffffffffffffffc",
        fileBytes: 8,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected 64-bit overflow rejection");
      expect(result.error.reason).toContain(`${architecture} address width`);
      expect(result.error.constraint).toBe("load_selection_rejected");
    },
  );
  it("admits boundary single-byte mapping at the maximum 64-bit address", () => {
    const admitted = admitRawBinary({
      architecture: "x86_64",
      entryPoint: "0xffffffffffffffff",
      fileBytes: 1,
    });
    expect(admitted).toEqual({
      ok: true,
      value: {
        architecture: "x86_64",
        entryPoint: "0xffffffffffffffff",
        entryPointSource: "0xffffffffffffffff",
      },
    });
    const overflow = admitRawBinary({
      architecture: "x86_64",
      entryPoint: "0xffffffffffffffff",
      fileBytes: 2,
    });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) throw new Error("expected overflow");
    expect(overflow.error.reason).toContain("x86_64 address width");
  });
  it.each(["arm", "arm64"])(
    "rejects unaligned %s entries before provider selection",
    (architecture) => {
      for (const entryPoint of ["0x8000001", "0x8000002", "0x8000003"]) {
        expect(
          admitRawBinary({ architecture, entryPoint, fileBytes: 4 }),
        ).toEqual({
          ok: false,
          error: {
            reason: `raw-binary ${architecture} entry_point ${entryPoint} must be 4-byte aligned`,
            constraint: "load_selection_rejected",
          },
        });
      }
    },
  );
  it.each([
    ["malformed entry", { architecture: "arm", entryPoint: "0xgg" }],
    ["missing entry", { architecture: "arm", entryPoint: undefined }],
    [
      "missing architecture",
      { architecture: undefined, entryPoint: "0x8000000" },
    ],
  ])("classifies a %s as caller input", (_name, selection) => {
    const result = admitRawBinary({ ...selection, fileBytes: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected caller-input rejection");
    expect(result.error.constraint).toBe("load_selection_rejected");
  });
  it.each(["x86", "x86_64"])(
    "admits byte-aligned %s entries",
    (architecture) => {
      const admitted = admitRawBinary({
        architecture,
        entryPoint: "0x1001",
        fileBytes: 1,
      });
      if (!admitted.ok) throw new Error(admitted.error.reason);
      expect(admitted.value.entryPoint).toBe("0x1001");
    },
  );
});

describe("raw-binary selection pairing", () => {
  it("requires architecture and entry with format=raw-binary", () => {
    expect(rawBinarySelectionError({ format: "raw-binary" })).toBe(
      "format=raw-binary requires architecture and entry_point",
    );
    expect(
      rawBinarySelectionError({
        format: "raw-binary",
        architecture: "arm",
        entryPoint: "0x8000000",
      }),
    ).toBeUndefined();
  });
  it("rejects architecture or entry without format=raw-binary", () => {
    expect(
      rawBinarySelectionError({ architecture: "arm", entryPoint: "0x1" }),
    ).toBe("architecture and entry_point apply only with format=raw-binary");
    expect(
      rawBinarySelectionError({ format: "dos-com", architecture: "x86" }),
    ).toBe("architecture and entry_point apply only with format=raw-binary");
  });
});
