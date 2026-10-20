import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";

/** Caller PDB format admitted by this adapter. */
export const GHIDRA_PDB_FORMAT = "rea-ghidra-pdb-v1";
export const GHIDRA_PDB_SCRIPT = "ReaGhidraApplyPdb.java";
/** Ghidra analyzer that consumes `PdbUniversalAnalyzer.setPdbFileOption`. */
export const GHIDRA_PDB_ANALYZER = "PDB Universal";

const MSF7_MAGIC = Buffer.from(
  "Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0",
  "latin1",
);
const MSF_BLOCK_SIZES = new Set([512, 1024, 2048, 4096, 8192, 16384, 32768]);
const MAX_MSF_DIRECTORY_BYTES = 256 * 1024 * 1024;
const PDB_INFO_STREAM = 1;
const PDB_DBI_STREAM = 3;
const NIL_STREAM_SIZE = 0xffff_ffff;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const age = z.number().int().nonnegative().max(0xffff_ffff);

/** Caller-selected PDB committed into the analysis profile before import. */
export const ghidraPdbCommitmentSchema = z.strictObject({
  format: z.literal(GHIDRA_PDB_FORMAT),
  path: z.string().refine(isAbsolute, "PDB path must be absolute"),
  configured_path: z.string().refine(isAbsolute, "PDB path must be absolute"),
  sha256: digest,
  bytes: z.number().int().nonnegative(),
  guid,
  age,
});
export type GhidraPdbCommitment = z.infer<typeof ghidraPdbCommitmentSchema>;

/** What the pre-analysis script verified and handed to Ghidra. */
export const ghidraPdbReportSchema = z.strictObject({
  format: z.literal(GHIDRA_PDB_FORMAT),
  sha256: digest,
  guid,
  age,
  program_guid: guid,
  program_age: age,
});
export type GhidraPdbReport = z.infer<typeof ghidraPdbReportSchema>;

/** Identity read from the MSF PDB information and DBI streams. */
export interface PdbIdentity {
  readonly guid: string;
  /** DBI age when present and nonzero, else the PDB stream age (Ghidra's rule). */
  readonly age: number;
  readonly pdbStreamAge: number;
  readonly version: number;
  readonly signature: number;
}

/** A PDB file that is not a readable MSF 7.00 container. */
export class PdbFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdbFormatError";
  }
}

const formatGuid = (bytes: Buffer): string =>
  [
    bytes.readUInt32LE(0).toString(16).padStart(8, "0"),
    bytes.readUInt16LE(4).toString(16).padStart(4, "0"),
    bytes.readUInt16LE(6).toString(16).padStart(4, "0"),
    bytes.subarray(8, 10).toString("hex"),
    bytes.subarray(10, 16).toString("hex"),
  ].join("-");

/** Normalize a CodeView or Ghidra GUID spelling for comparison. */
export const normalizePdbGuid = (value: string): string => {
  const hex = value
    .replace(/^\{|\}$/gu, "")
    .replaceAll("-", "")
    .toLowerCase();
  return /^[0-9a-f]{32}$/u.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : value.toLowerCase();
};

const readExactly = async (
  file: FileHandle,
  position: number,
  length: number,
  size: number,
): Promise<Buffer> => {
  if (position < 0 || length < 0 || position + length > size)
    throw new PdbFormatError("PDB structure points outside the file");
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (read.bytesRead === 0) throw new PdbFormatError("PDB file ended early");
    offset += read.bytesRead;
  }
  return bytes;
};

/**
 * Read the PDB GUID and age from an MSF 7.00 container without loading it:
 * the superblock, the stream directory, then the first bytes of the PDB
 * information stream (1) and the DBI stream (3).
 */
export const readPdbIdentity = async (
  file: FileHandle,
  size: number,
): Promise<PdbIdentity> => {
  const superblock = await readExactly(file, 0, 56, size);
  if (!superblock.subarray(0, MSF7_MAGIC.length).equals(MSF7_MAGIC))
    throw new PdbFormatError("The file is not an MSF 7.00 PDB");
  const blockSize = superblock.readUInt32LE(32);
  const blockCount = superblock.readUInt32LE(40);
  const directoryBytes = superblock.readUInt32LE(44);
  const blockMapBlock = superblock.readUInt32LE(52);
  if (!MSF_BLOCK_SIZES.has(blockSize))
    throw new PdbFormatError(`Unsupported MSF block size ${blockSize}`);
  if (directoryBytes < 4 || directoryBytes > MAX_MSF_DIRECTORY_BYTES)
    throw new PdbFormatError("The MSF stream directory size is invalid");
  const block = async (index: number, length = blockSize, at = 0) => {
    if (index >= blockCount)
      throw new PdbFormatError("PDB block index is out of range");
    return readExactly(file, index * blockSize + at, length, size);
  };
  const directoryBlockCount = Math.ceil(directoryBytes / blockSize);
  if (directoryBlockCount * 4 > blockSize)
    throw new PdbFormatError("The MSF stream directory block map is too large");
  const map = await block(blockMapBlock, directoryBlockCount * 4);
  const directory = Buffer.concat(
    await Promise.all(
      Array.from({ length: directoryBlockCount }, (_, index) =>
        block(map.readUInt32LE(index * 4)),
      ),
    ),
  ).subarray(0, directoryBytes);
  const streams = directory.readUInt32LE(0);
  if (streams <= PDB_INFO_STREAM || 4 + streams * 4 > directory.length)
    throw new PdbFormatError("The MSF stream directory is truncated");
  const sizes = Array.from({ length: streams }, (_, index) =>
    directory.readUInt32LE(4 + index * 4),
  );
  let cursor = 4 + streams * 4;
  const firstBlocks: (number | undefined)[] = [];
  for (const streamSize of sizes) {
    const blocks =
      streamSize === NIL_STREAM_SIZE ? 0 : Math.ceil(streamSize / blockSize);
    if (cursor + blocks * 4 > directory.length)
      throw new PdbFormatError("The MSF stream directory is truncated");
    firstBlocks.push(blocks === 0 ? undefined : directory.readUInt32LE(cursor));
    cursor += blocks * 4;
  }
  const infoBlock = firstBlocks[PDB_INFO_STREAM];
  if (infoBlock === undefined || (sizes[PDB_INFO_STREAM] ?? 0) < 28)
    throw new PdbFormatError("The PDB information stream is missing");
  const info = await block(infoBlock, 28);
  const pdbStreamAge = info.readUInt32LE(8);
  let dbiAge = 0;
  const dbiBlock = firstBlocks[PDB_DBI_STREAM];
  const dbiSize = sizes[PDB_DBI_STREAM] ?? 0;
  if (dbiBlock !== undefined && dbiSize !== NIL_STREAM_SIZE && dbiSize >= 12) {
    const dbi = await block(dbiBlock, 12);
    // A new-format DBI header starts with signature -1 and carries the age
    // the linker wrote into the image's CodeView record.
    if (dbi.readInt32LE(0) === -1) dbiAge = dbi.readUInt32LE(8);
  }
  return {
    version: info.readUInt32LE(0),
    signature: info.readUInt32LE(4),
    pdbStreamAge,
    age: dbiAge > 0 ? dbiAge : pdbStreamAge,
    guid: formatGuid(info.subarray(12, 28)),
  };
};

const hashFile = async (file: FileHandle, size: number): Promise<string> => {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const read = await file.read(chunk, 0, chunk.length, position);
    if (read.bytesRead === 0) throw new Error("PDB file ended while hashing");
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest("hex");
};

interface InspectedPdb {
  readonly path: string;
  readonly identity: PdbIdentity;
  readonly sha256: string;
  readonly bytes: number;
}

/** Resolve, identify and hash one PDB through a single no-follow handle. */
const inspectPdbFile = async (configured: string): Promise<InspectedPdb> => {
  const path = await realpath(configured);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("The PDB is not a regular file");
    const identity = await readPdbIdentity(file, stat.size);
    const sha256 = await hashFile(file, stat.size);
    return { path, identity, sha256, bytes: stat.size };
  } finally {
    await file.close();
  }
};

const unreadable = (configured: string, cause: unknown) =>
  new ProviderAdapterError("ghidra", "resolve_analysis_profile", {
    cause,
    diagnostics: {
      setting: "REA_GHIDRA_PDB_FILE",
      path: configured,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
    userMessage:
      "REA_GHIDRA_PDB_FILE must name a readable MSF 7.00 PDB file. Check the path and permissions, then reopen the target.",
  });

/**
 * Resolve the configured PDB into an immutable profile commitment, refusing
 * it unless its GUID and age equal the target's RSDS CodeView record.
 */
export const resolveGhidraPdbCompanion = async (
  configured: string | undefined,
  target: BinaryTarget,
): Promise<
  Result<
    GhidraPdbCommitment | undefined,
    AnalysisUnsupportedTargetError | ProviderAdapterError
  >
> => {
  if (configured === undefined) return ok(undefined);
  const codeView =
    target.kind === "executable" && target.format === "pe"
      ? target.codeView
      : undefined;
  if (codeView === undefined || codeView.guid === null)
    return err(
      new AnalysisUnsupportedTargetError(
        "resolve_analysis_profile",
        target.path,
        "REA_GHIDRA_PDB_FILE matches a PDB against a PE target's RSDS CodeView record (GUID and age); this target declares none, so the PDB cannot be proven to belong to it.",
        { remediationAction: "Unset REA_GHIDRA_PDB_FILE for this target." },
      ),
    );
  let inspected: InspectedPdb;
  try {
    inspected = await inspectPdbFile(configured);
  } catch (cause: unknown) {
    return err(unreadable(configured, cause));
  }
  const { path, identity, sha256, bytes } = inspected;
  const expectedGuid = normalizePdbGuid(codeView.guid);
  if (identity.guid !== expectedGuid || identity.age !== codeView.age)
    return err(
      new AnalysisUnsupportedTargetError(
        "resolve_analysis_profile",
        target.path,
        `The PDB ${path} has GUID ${identity.guid} and age ${identity.age}, but the target's CodeView record declares GUID ${expectedGuid} and age ${codeView.age}. REA refuses to apply debug information from another build.`,
        {
          remediationAction:
            "Select the PDB written by the same link as this executable (matching GUID and age), or unset REA_GHIDRA_PDB_FILE.",
        },
      ),
    );
  return ok({
    format: GHIDRA_PDB_FORMAT,
    path,
    configured_path: configured,
    sha256,
    bytes,
    guid: identity.guid,
    age: identity.age,
  });
};

/**
 * Fail closed unless the pre-analysis script verified exactly the committed
 * PDB against the Program and Ghidra reports that PDB loaded after analysis.
 */
export const ghidraPdbCompanionFailure = (
  commitment: GhidraPdbCommitment | undefined,
  report: GhidraPdbReport | undefined,
  loaded: boolean | null | undefined,
  operation: AnalysisOperation,
): ProviderAdapterError | undefined => {
  if (commitment === undefined && report === undefined) return undefined;
  const reason =
    commitment === undefined
      ? "The Ghidra session reported a caller PDB that the profile did not commit."
      : report === undefined
        ? "The Ghidra session did not report the committed caller PDB."
        : report.sha256 !== commitment.sha256 ||
            report.guid !== commitment.guid ||
            report.age !== commitment.age ||
            report.program_guid !== commitment.guid ||
            report.program_age !== commitment.age
          ? `The Ghidra session applied a PDB (GUID ${report.guid}, age ${report.age}, sha256 ${report.sha256}; Program GUID ${report.program_guid}, age ${report.program_age}) that differs from the committed PDB (GUID ${commitment.guid}, age ${commitment.age}, sha256 ${commitment.sha256}).`
          : loaded !== true
            ? `Ghidra did not report the committed PDB ${commitment.path} as loaded after analysis; the ${GHIDRA_PDB_ANALYZER} analyzer may have failed. See the session's ghidra.log.`
            : undefined;
  return reason === undefined
    ? undefined
    : new ProviderAdapterError("ghidra", operation, {
        diagnostics: { reason },
      });
};

/** Session limitations that keep PDB-supplied facts distinct from Ghidra discoveries. */
export const ghidraPdbCompanionLimitations = (
  commitment: GhidraPdbCommitment | undefined,
): readonly string[] =>
  commitment === undefined
    ? []
    : [
        `PDB applied: ${commitment.path} (sha256 ${commitment.sha256}, GUID ${commitment.guid}, age ${commitment.age}) was matched against the target's CodeView record and passed to Ghidra's ${GHIDRA_PDB_ANALYZER} analyzer before auto-analysis. Names, types and other symbols from it are caller-supplied debug information, not Ghidra discoveries; a matching GUID and age identify the build, not the completeness of the PDB.`,
      ];
