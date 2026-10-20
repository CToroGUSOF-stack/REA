import { describe, expect, it } from "vitest";

import { x64dbgDiscoverySchema } from "../contracts/x64dbgToolContracts.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  discoverX64dbg,
  peArchitecture,
  wellKnownX64dbgPaths,
  type X64dbgDiscoveryHost,
} from "./X64dbgDiscovery.js";

const pe = (machine: number): Uint8Array => {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x84, machine, true);
  return bytes;
};

const windowsHost = (
  files: Readonly<Record<string, Uint8Array>>,
  environment: NodeJS.ProcessEnv,
): X64dbgDiscoveryHost => ({
  platform: "win32",
  environment,
  fileSize: (path) => files[path]?.length,
  readHead: (path, length) => files[path]?.subarray(0, length),
});

describe("discoverX64dbg", () => {
  it("returns unsupported_platform on Linux without touching the filesystem", () => {
    const result = discoverX64dbg({
      platform: "linux",
      environment: { REA_X64DBG_COMMAND: "/opt/x64dbg.exe" },
      fileSize: () => {
        throw new Error("must not be called");
      },
    });
    expect(result.status).toBe("unsupported_platform");
    expect(result.reason).toContain("linux");
    expect(result.executables).toEqual([]);
    expect(result.launched_process).toBe(false);
    expect(x64dbgDiscoverySchema.parse(result)).toEqual(result);
  });

  it("prefers REA_X64DBG_COMMAND and reports PE architecture", () => {
    const path = "D:\\tools\\x64dbg\\x64\\x64dbg.exe";
    const result = discoverX64dbg(
      windowsHost(
        { [path]: pe(0x8664) },
        { REA_X64DBG_COMMAND: ` ${path} `, ProgramFiles: "C:\\Program Files" },
      ),
    );
    expect(result.status).toBe("available");
    expect(result.executables).toEqual([
      {
        path,
        source: "environment",
        architecture: "x64",
        size_bytes: 0x100,
        architecture_status: "pe_header",
      },
    ]);
    expect(x64dbgDiscoverySchema.parse(result)).toEqual(result);
  });

  it("does not fall back to well-known paths when the configured path is missing", () => {
    const known = "C:\\Program Files\\x64dbg\\release\\x64\\x64dbg.exe";
    const result = discoverX64dbg(
      windowsHost(
        { [known]: pe(0x8664) },
        {
          REA_X64DBG_COMMAND: "C:\\missing.exe",
          ProgramFiles: "C:\\Program Files",
        },
      ),
    );
    expect(result.status).toBe("configured_path_not_found");
    expect(result.executables).toEqual([]);
  });

  it("finds x64 and x32 builds in well-known locations", () => {
    const x64 = "C:\\Program Files\\x64dbg\\release\\x64\\x64dbg.exe";
    const x32 = "C:\\Program Files\\x64dbg\\release\\x32\\x32dbg.exe";
    const result = discoverX64dbg(
      windowsHost(
        { [x64]: pe(0x8664), [x32]: pe(0x014c) },
        { ProgramFiles: "C:\\Program Files" },
      ),
    );
    expect(result.status).toBe("available");
    expect(result.executables.map((entry) => entry.architecture)).toEqual([
      "x64",
      "x86",
    ]);
  });

  it("reports not_found with a remediation hint", () => {
    const result = discoverX64dbg(windowsHost({}, {}));
    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("REA_X64DBG_COMMAND");
  });

  it("fails closed instead of throwing when the host seam throws", () => {
    const result = discoverX64dbg({
      platform: "win32",
      environment: { ProgramFiles: "C:\\Program Files" },
      fileSize: () => {
        throw new Error("access denied");
      },
    });
    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("access denied");
  });

  it("marks non-PE files as unrecognized", () => {
    const path = "C:\\x\\x64dbg.exe";
    const result = discoverX64dbg(
      windowsHost({ [path]: new Uint8Array(8) }, { REA_X64DBG_COMMAND: path }),
    );
    expect(result.executables[0]?.architecture_status).toBe(
      "unrecognized_header",
    );
  });
});

describe("x64dbg helpers", () => {
  it("rejects truncated or foreign machine headers", () => {
    expect(peArchitecture(new Uint8Array(2))).toBeNull();
    expect(peArchitecture(pe(0xaa64))).toBeNull();
  });

  it("derives deduplicated install candidates from the environment", () => {
    const paths = wellKnownX64dbgPaths({
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    });
    expect(paths).toContain(
      "C:\\Users\\a\\AppData\\Local\\Programs\\x64dbg\\release\\x64\\x64dbg.exe",
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("publishes a read-only discovery contract with no session tools", () => {
    const contract = toolContract("discover_x64dbg");
    expect(contract.effects.launchesProcess).toBe(false);
    expect(contract.effects.executesForeignCode).toBe(false);
    expect(contract.effects.mutatesTarget).toBe(false);
    expect(contract.annotations.readOnlyHint).toBe(true);
  });
});
