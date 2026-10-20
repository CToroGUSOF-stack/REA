import { describe, expect, it } from "vitest";

import { parseExecutableHeader } from "./binaryTarget.js";
import { elf } from "./binaryTarget.fixture.js";

const decline = {
  ok: false,
  error: "unsupported ELF architecture",
} as const;

describe("SPARC ELF admission", () => {
  it("admits the ELF64 big-endian machine value that selects one Ghidra language", () => {
    expect(parseExecutableHeader(elf(2, 2, 43), "x64")).toMatchObject({
      ok: true,
      value: { format: "elf", architecture: "sparc" },
    });
  });

  it("declines an ELFCLASS32 header carrying the SPARC V9 machine value", () => {
    expect(parseExecutableHeader(elf(1, 2, 43), "x64")).toMatchObject(decline);
  });

  it("declines a little-endian header carrying the SPARC V9 machine value", () => {
    expect(parseExecutableHeader(elf(2, 1, 43), "x64")).toMatchObject(decline);
  });

  it("declines the 32-bit machine values whose e_flags alone decide V8 or V9", () => {
    expect(parseExecutableHeader(elf(1, 2, 2), "x64")).toMatchObject(decline);
    expect(parseExecutableHeader(elf(1, 2, 18), "x64")).toMatchObject(decline);
  });
});
