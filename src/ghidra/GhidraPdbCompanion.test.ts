import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import {
  ghidraPdbCompanionFailure,
  ghidraPdbCompanionLimitations,
  PdbFormatError,
  readPdbIdentity,
  resolveGhidraPdbCompanion,
  type GhidraPdbCommitment,
  type GhidraPdbReport,
} from "./GhidraPdbCompanion.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";

const GUID = "213292a1-809b-6608-4c4c-44205044422e";
const OTHER_GUID = "22803638-e976-1fbb-4c4c-44205044422e";
const BLOCK = 512;

const guidBytes = (guid: string): Buffer => {
  const hex = guid.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
};

/**
 * Minimal MSF 7.00 container: superblock, block map, stream directory, the
 * PDB information stream (1) and, optionally, a new-format DBI header (3).
 */
const msfPdb = (options: {
  readonly guid?: string;
  readonly pdbAge?: number;
  readonly dbiAge?: number;
}): Buffer => {
  const blocks = Array.from({ length: 7 }, () => Buffer.alloc(BLOCK));
  const info = blocks[5]!;
  info.writeUInt32LE(20000404, 0);
  info.writeUInt32LE(0x1234_5678, 4);
  info.writeUInt32LE(options.pdbAge ?? 1, 8);
  guidBytes(options.guid ?? GUID).copy(info, 12);
  const dbi = options.dbiAge !== undefined;
  if (dbi) {
    blocks[6]!.writeInt32LE(-1, 0);
    blocks[6]!.writeUInt32LE(19990903, 4);
    blocks[6]!.writeUInt32LE(options.dbiAge ?? 0, 8);
  }
  const sizes = dbi ? [0, 28, 0xffff_ffff, 64] : [0, 28];
  const directory = blocks[4]!;
  let cursor = 0;
  directory.writeUInt32LE(sizes.length, cursor);
  cursor += 4;
  for (const size of sizes) {
    directory.writeUInt32LE(size, cursor);
    cursor += 4;
  }
  directory.writeUInt32LE(5, cursor);
  cursor += 4;
  if (dbi) {
    directory.writeUInt32LE(6, cursor);
    cursor += 4;
  }
  blocks[3]!.writeUInt32LE(4, 0);
  const superblock = blocks[0]!;
  superblock.write("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0", 0, "latin1");
  superblock.writeUInt32LE(BLOCK, 32);
  superblock.writeUInt32LE(1, 36);
  superblock.writeUInt32LE(blocks.length, 40);
  superblock.writeUInt32LE(cursor, 44);
  superblock.writeUInt32LE(3, 52);
  return Buffer.concat(blocks);
};

const identityOf = async (bytes: Buffer) => {
  const directory = await createTestTempDirectory("rea-pdb-identity-");
  const path = join(directory, "fixture.pdb");
  await writeFile(path, bytes);
  const file = await open(path, "r");
  try {
    return await readPdbIdentity(file, bytes.length);
  } finally {
    await file.close();
  }
};

const peTarget = (codeView?: {
  guid: string | null;
  age: number;
}): BinaryTarget => ({
  path: "/tmp/fixture.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
  ...(codeView === undefined
    ? {}
    : {
        codeView: {
          pdbPath: "C:\\build\\fixture.pdb",
          pdbFileName: "fixture.pdb",
          ...codeView,
        },
      }),
});

const pdbFile = async (bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-pdb-companion-");
  const path = join(directory, "fixture.pdb");
  await writeFile(path, bytes);
  return path;
};

describe("PDB identity", () => {
  it("reads the GUID and prefers the DBI age, as Ghidra does", async () => {
    expect(await identityOf(msfPdb({ pdbAge: 9, dbiAge: 2 }))).toMatchObject({
      guid: GUID,
      age: 2,
      pdbStreamAge: 9,
      version: 20000404,
      signature: 0x1234_5678,
    });
  });

  it("uses the PDB stream age without a DBI stream", async () => {
    expect(await identityOf(msfPdb({ pdbAge: 4 }))).toMatchObject({
      guid: GUID,
      age: 4,
    });
  });

  it.each([
    ["a non-MSF file", Buffer.alloc(4096)],
    ["a truncated container", msfPdb({}).subarray(0, 2048)],
  ])("rejects %s", async (_label, bytes) => {
    await expect(identityOf(bytes)).rejects.toBeInstanceOf(PdbFormatError);
  });
});

describe("REA_GHIDRA_PDB_FILE", () => {
  it("is an absolute caller-selected path", () => {
    const parsed = parseConfig({ REA_GHIDRA_PDB_FILE: "/symbols/app.pdb" });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.ghidraPdbFile).toBe("/symbols/app.pdb");
    const relative = parseConfig({ REA_GHIDRA_PDB_FILE: "app.pdb" });
    expect(relative.ok).toBe(false);
  });

  it("cannot be combined with disabling the analyzer that applies it", () => {
    const parsed = parseConfig({
      REA_GHIDRA_PDB_FILE: "/symbols/app.pdb",
      REA_GHIDRA_DISABLED_ANALYZERS: "Stack,PDB Universal",
    });
    if (parsed.ok) throw new Error("Expected a configuration error");
    expect(parsed.error.settings).toEqual([
      {
        setting: "REA_GHIDRA_DISABLED_ANALYZERS",
        constraint:
          "cannot disable PDB Universal while REA_GHIDRA_PDB_FILE is set",
      },
    ]);
  });
});

describe("Ghidra PDB commitment", () => {
  it("commits a PDB whose GUID and age match the target CodeView record", async () => {
    const bytes = msfPdb({ dbiAge: 1 });
    const path = await pdbFile(bytes);
    const resolved = await resolveGhidraPdbCompanion(
      path,
      peTarget({ guid: GUID.toUpperCase(), age: 1 }),
    );
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value).toMatchObject({
      format: "rea-ghidra-pdb-v1",
      configured_path: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      guid: GUID,
      age: 1,
    });
  });

  it("is absent without the setting", async () => {
    const resolved = await resolveGhidraPdbCompanion(undefined, peTarget());
    expect(resolved.ok && resolved.value).toBeUndefined();
  });

  it.each([
    ["another GUID", { guid: OTHER_GUID, age: 1 }, OTHER_GUID],
    ["another age", { guid: GUID, age: 2 }, "age 2"],
  ])(
    "refuses a PDB from another build (%s), naming both identities",
    async (_label, codeView, expected) => {
      const path = await pdbFile(msfPdb({ dbiAge: 1 }));
      const resolved = await resolveGhidraPdbCompanion(
        path,
        peTarget(codeView),
      );
      if (resolved.ok) throw new Error("Expected a refusal");
      const projected = projectAnalysisError(resolved.error);
      expect(projected.code).toBe("unsupported_target");
      const text = JSON.stringify(projected);
      expect(text).toContain(`GUID ${GUID} and age 1`);
      expect(text).toContain(expected);
    },
  );

  it.each([
    ["no CodeView record", peTarget()],
    ["a CodeView record without a GUID", peTarget({ guid: null, age: 1 })],
    [
      "a non-PE target",
      {
        path: "/tmp/fixture",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "elf",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
      } as BinaryTarget,
    ],
  ])("refuses a target with %s", async (_label, target) => {
    const path = await pdbFile(msfPdb({ dbiAge: 1 }));
    const resolved = await resolveGhidraPdbCompanion(path, target);
    if (resolved.ok) throw new Error("Expected a refusal");
    expect(projectAnalysisError(resolved.error).code).toBe(
      "unsupported_target",
    );
  });

  it("reports an unreadable or malformed PDB against its setting", async () => {
    for (const path of [
      "/rea-missing/app.pdb",
      await pdbFile(Buffer.alloc(64)),
    ]) {
      const resolved = await resolveGhidraPdbCompanion(
        path,
        peTarget({ guid: GUID, age: 1 }),
      );
      if (resolved.ok) throw new Error("Expected an error");
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        details: { diagnostics: { setting: "REA_GHIDRA_PDB_FILE", path } },
      });
    }
  });
});

const commitment: GhidraPdbCommitment = {
  format: "rea-ghidra-pdb-v1",
  path: "/symbols/app.pdb",
  configured_path: "/symbols/app.pdb",
  sha256: "b".repeat(64),
  bytes: 3584,
  guid: GUID,
  age: 1,
};
const applied: GhidraPdbReport = {
  format: "rea-ghidra-pdb-v1",
  sha256: commitment.sha256,
  guid: GUID,
  age: 1,
  program_guid: GUID,
  program_age: 1,
};

describe("Ghidra PDB session outcome", () => {
  it("accepts the committed PDB once Ghidra reports it loaded", () => {
    expect(
      ghidraPdbCompanionFailure(commitment, applied, true, "health"),
    ).toBeUndefined();
    expect(
      ghidraPdbCompanionFailure(undefined, undefined, null, "health"),
    ).toBeUndefined();
    expect(ghidraPdbCompanionLimitations(commitment)).toEqual([
      expect.stringMatching(
        /^PDB applied: \/symbols\/app\.pdb \(sha256 b{64}, GUID 213292a1-809b-6608-4c4c-44205044422e, age 1\).*not Ghidra discoveries/u,
      ),
    ]);
  });

  it.each([
    ["no report", undefined, true, "did not report"],
    [
      "another file",
      { ...applied, sha256: "c".repeat(64) },
      true,
      "differs from the committed PDB",
    ],
    [
      "another Program",
      { ...applied, program_guid: OTHER_GUID },
      true,
      "differs from the committed PDB",
    ],
    [
      "no loaded PDB after analysis",
      applied,
      false,
      "did not report the committed PDB",
    ],
    ["an unknown load state", applied, null, "as loaded after analysis"],
  ] as const)("fails closed on %s", (_label, report, loaded, reason) => {
    const failure = ghidraPdbCompanionFailure(
      commitment,
      report,
      loaded,
      "list_procedures",
    );
    expect(failure?.diagnostics).toMatchObject({
      reason: expect.stringContaining(reason),
    });
  });

  it("fails closed on a report the profile did not commit", () => {
    expect(
      ghidraPdbCompanionFailure(undefined, applied, true, "health"),
    ).toBeDefined();
  });
});

describe("Ghidra provider with a caller PDB", () => {
  const session = async (
    report: GhidraPdbReport | undefined,
    loaded: boolean | null,
  ) => {
    const path = await pdbFile(msfPdb({ dbiAge: 1 }));
    const config = parseConfig({
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
      REA_GHIDRA_PDB_FILE: path,
    });
    if (!config.ok) throw config.error;
    const counts = { starts: 0, calls: 0, closes: 0 };
    const ghidra = new GhidraProvider(
      config.value,
      silentLogger,
      {},
      host,
      () => ({
        start: () => {
          counts.starts++;
          return Promise.resolve(
            ok({
              name: "REA Ghidra bridge" as const,
              run_id: "11111111-1111-4111-8111-111111111111",
              profile_digest: "a".repeat(64),
              provider: { id: "ghidra" as const, version: "12.1.4" },
              read_only: false,
              analysis_complete: true,
              analysis_timed_out: false,
              capabilities: [...GHIDRA_SESSION_CAPABILITIES],
              target: {
                name: "fixture.exe",
                language_id: "x86:LE:64:default",
                compiler_spec_id: "windows",
                image_base: "0x140000000",
                default_address_space: "ram",
                sha256: "a".repeat(64),
              },
              pdb: {
                file: "fixture.pdb",
                guid: GUID.toUpperCase(),
                age: "1",
                signature: null,
                version: null,
                loaded,
              },
              ...(report === undefined ? {} : { pdb_companion: report }),
            }),
          );
        },
        callTool: () => {
          counts.calls++;
          return Promise.resolve(ok([]));
        },
        close: () => {
          counts.closes++;
          return Promise.resolve(ok(null));
        },
      }),
    );
    const target = peTarget({ guid: GUID, age: 1 });
    const resolved = await ghidra.resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected profile");
    return {
      counts,
      profile: resolved.value.profile,
      client: ghidra.createClient(target, resolved.value.profile),
    };
  };

  const fixtureSha256 = createHash("sha256")
    .update(msfPdb({ dbiAge: 1 }))
    .digest("hex");

  it("commits the PDB into the profile and reports it as applied", async () => {
    const { client, counts, profile } = await session(
      { ...applied, sha256: fixtureSha256 },
      true,
    );
    const committed = profile.parameters.pdb_companion as GhidraPdbCommitment;
    expect(committed).toMatchObject({
      format: "rea-ghidra-pdb-v1",
      sha256: fixtureSha256,
      guid: GUID,
      age: 1,
    });
    const listed = await client.execute("list_procedures", {});
    if (!listed.ok) throw listed.error;
    expect(counts).toMatchObject({ starts: 1, calls: 1, closes: 0 });
    expect(listed.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`PDB applied: ${committed.path}`),
      ]),
    );
  });

  it.each([
    ["no PDB report", undefined, true],
    ["a PDB Ghidra did not load", "applied", false],
  ] as const)(
    "fails closed on %s before any analysis call",
    async (_label, report, loaded) => {
      const { client, counts } = await session(
        report === undefined
          ? undefined
          : { ...applied, sha256: fixtureSha256 },
        loaded,
      );
      const failed = await client.execute("list_procedures", {});
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
      expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
    },
  );
});
