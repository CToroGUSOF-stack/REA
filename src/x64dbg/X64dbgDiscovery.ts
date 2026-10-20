import { closeSync, openSync, readSync, statSync } from "node:fs";
import { win32 } from "node:path";

/** BYO x64dbg provider identity. Discovery never starts a debugger session. */
export const X64DBG_PROVIDER_IDENTITY = {
  id: "x64dbg.byo",
  name: "x64dbg (bring your own)",
  version: null,
} as const;

export type X64dbgArchitecture = "x64" | "x86";

export type X64dbgCandidateSource = "environment" | "well-known-path";

export type X64dbgExecutableCapability = {
  readonly path: string;
  readonly source: X64dbgCandidateSource;
  readonly architecture: X64dbgArchitecture | null;
  readonly size_bytes: number;
  readonly architecture_status: "pe_header" | "unrecognized_header";
};

export type X64dbgDiscoveryStatus =
  | "available"
  | "unsupported_platform"
  | "configured_path_not_found"
  | "not_found";

export type X64dbgDiscoveryResult = {
  readonly provider: string;
  readonly host_platform: string;
  readonly status: X64dbgDiscoveryStatus;
  readonly reason: string;
  readonly executables: readonly X64dbgExecutableCapability[];
  readonly configured_command: string | null;
  readonly launched_process: false;
  readonly debug_session_capability: "not_implemented";
};

/** Host seams so discovery is deterministic in tests on any platform. */
export interface X64dbgDiscoveryHost {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** Returns file size when the path is a regular file, otherwise undefined. */
  readonly fileSize?: (path: string) => number | undefined;
  /** Reads at most `length` bytes from the start of the file. */
  readonly readHead?: (path: string, length: number) => Uint8Array | undefined;
}

export const X64DBG_COMMAND_ENV = "REA_X64DBG_COMMAND";

const PE_HEADER_READ_BYTES = 4096;

const defaultFileSize = (path: string): number | undefined => {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
};

const defaultReadHead = (
  path: string,
  length: number,
): Uint8Array | undefined => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = new Uint8Array(length);
    const read = readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

/** Classify a PE image by its COFF machine field without executing it. */
export const peArchitecture = (head: Uint8Array): X64dbgArchitecture | null => {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 6 > head.length) return null;
  if (view.getUint32(peOffset, true) !== 0x00004550) return null;
  const machine = view.getUint16(peOffset + 4, true);
  if (machine === 0x8664) return "x64";
  if (machine === 0x014c) return "x86";
  return null;
};

/** Ordered well-known install locations derived from the Windows environment. */
export const wellKnownX64dbgPaths = (
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] => {
  const roots = [
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.LOCALAPPDATA === undefined
      ? undefined
      : win32.join(environment.LOCALAPPDATA, "Programs"),
    environment.SystemDrive === undefined
      ? undefined
      : `${environment.SystemDrive}\\`,
  ].filter((root): root is string => root !== undefined && root.length > 0);
  const paths: string[] = [];
  for (const root of roots)
    for (const relative of [
      "x64dbg\\release\\x64\\x64dbg.exe",
      "x64dbg\\release\\x32\\x32dbg.exe",
      "x64dbg\\x64\\x64dbg.exe",
      "x64dbg\\x32\\x32dbg.exe",
    ])
      paths.push(win32.join(root, relative));
  return [...new Set(paths)];
};

const describe = (
  path: string,
  source: X64dbgCandidateSource,
  host: X64dbgDiscoveryHost,
): X64dbgExecutableCapability | undefined => {
  const size = (host.fileSize ?? defaultFileSize)(path);
  if (size === undefined) return undefined;
  const head = (host.readHead ?? defaultReadHead)(path, PE_HEADER_READ_BYTES);
  const architecture = head === undefined ? null : peArchitecture(head);
  return {
    path,
    source,
    architecture,
    size_bytes: size,
    architecture_status:
      architecture === null ? "unrecognized_header" : "pe_header",
  };
};

/**
 * Locate a BYO x64dbg/x32dbg executable and report file-metadata capability.
 * Reads file metadata and the PE header only; never launches the debugger,
 * attaches to a process, or writes anything. Every failure is reported as a
 * status instead of thrown, so callers composing optional providers are not
 * affected by this adapter being unavailable.
 */
export const discoverX64dbg = (
  host: X64dbgDiscoveryHost,
): X64dbgDiscoveryResult => {
  const configuredRaw = host.environment[X64DBG_COMMAND_ENV]?.trim();
  const configured =
    configuredRaw === undefined || configuredRaw.length === 0
      ? null
      : configuredRaw;
  const base = {
    provider: X64DBG_PROVIDER_IDENTITY.id,
    host_platform: host.platform,
    configured_command: configured,
    launched_process: false,
    debug_session_capability: "not_implemented",
  } as const;
  if (host.platform !== "win32")
    return {
      ...base,
      status: "unsupported_platform",
      reason: `x64dbg is a Windows debugger; discovery is unavailable on ${host.platform}.`,
      executables: [],
    };
  try {
    if (configured !== null) {
      const found = describe(configured, "environment", host);
      return found === undefined
        ? {
            ...base,
            status: "configured_path_not_found",
            reason: `${X64DBG_COMMAND_ENV} does not name an existing regular file.`,
            executables: [],
          }
        : {
            ...base,
            status: "available",
            reason: `Resolved from ${X64DBG_COMMAND_ENV}.`,
            executables: [found],
          };
    }
    const executables = wellKnownX64dbgPaths(host.environment).flatMap(
      (path) => describe(path, "well-known-path", host) ?? [],
    );
    return executables.length === 0
      ? {
          ...base,
          status: "not_found",
          reason: `No x64dbg executable found; set ${X64DBG_COMMAND_ENV} to x64dbg.exe or x32dbg.exe.`,
          executables: [],
        }
      : {
          ...base,
          status: "available",
          reason: "Resolved from well-known install locations.",
          executables,
        };
  } catch (error) {
    return {
      ...base,
      status: "not_found",
      reason: `Discovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
      executables: [],
    };
  }
};
