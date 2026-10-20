import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "./HopperProvider.js";

describe("Hopper provider capabilities", () => {
  it("declines headerless raw-binary targets with a Ghidra-directed reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/ecu.bin",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "raw-binary",
        architecture: "arm",
        availableArchitectures: ["arm"],
        entryPoint: "0x8000000",
        entryPointSource: "0x8000000",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("Ghidra"),
    });
  });
  it("declines DOS MZ targets with a provider-specific support reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/legacy.exe",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("Ghidra"),
    });
  });
  it("declines Hexagon targets with a Ghidra-directed reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    const support = provider.inspectTargetSupport({
      path: "/tmp/chre_pal.so",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "hexagon",
      availableArchitectures: ["hexagon"],
    });
    expect(support).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining("Hexagon"),
    });
    if (support.status === "unsupported") {
      expect(support.reason).toContain("header-driven");
      expect(support.reason).not.toContain("verified");
    }
    if (support.status === "unsupported") {
      expect(support.reason).toContain("Ghidra");
    }
  });
  it("keeps the verified-profile advice for a family with a pinned Ghidra profile", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    const support = provider.inspectTargetSupport({
      path: "/tmp/mips-elf",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "mips",
      availableArchitectures: ["mips"],
      mips: { elfClass: 32, byteOrder: "little", type: 3, flags: 0 },
    });
    if (support.status !== "unsupported") throw new Error("expected decline");
    expect(support.reason).toContain("verified Ghidra MIPS profile");
  });

  it("declines SPARC targets with a Ghidra-directed reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    const support = provider.inspectTargetSupport({
      path: "/tmp/sparcv9-bin",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "sparc",
      availableArchitectures: ["sparc"],
    });
    expect(support).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining("SPARC"),
    });
    if (support.status === "unsupported") {
      expect(support.reason).toContain("header-driven");
      expect(support.reason).not.toContain("verified");
    }
  });
});
