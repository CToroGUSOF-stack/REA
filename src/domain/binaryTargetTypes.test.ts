import { describe, expect, it } from "vitest";

import {
  BINARY_ARCHITECTURES,
  isElfOnlyArchitecture,
} from "./binaryTargetTypes.js";

describe("ELF-only families", () => {
  it.each(["hexagon", "sparc"] as const)(
    "keeps %s inside the partition that no PE or Mach-O header can declare",
    (family) => {
      expect(isElfOnlyArchitecture(family)).toBe(true);
    },
  );

  it("keeps every other family outside the partition", () => {
    const others = BINARY_ARCHITECTURES.filter(
      (family) => !isElfOnlyArchitecture(family),
    );
    expect(others).toEqual([
      "x86",
      "x86_64",
      "arm",
      "arm64",
      "mips",
      "6502",
      "riscv",
      "powerpc",
      "m68k",
    ]);
  });
});
