/** Unchanged upstream source pin; executed bytes are identified separately. */
export const WAKARU_RELEASE = {
  version: "1.14.0",
  revision: "8219bf5016a063d7fb215101a8c45d5959ec733f",
  repository: "https://github.com/pionxzh/wakaru",
} as const;

/**
 * Releases the report parser accepts. Wakaru changes `--version`, `--json`
 * and `provenance.json` only by addition within a major version
 * (https://github.com/pionxzh/wakaru/blob/v1.14.0/docs/cli.md#machine-readable-output-compatibility);
 * 1.13.0 is the first release this adapter verified.
 */
export const WAKARU_ACCEPTED_RANGE = "^1.13.0";

/** Catalog identity for the verified Wakaru release. Evidence replaces version with the observed banner. */
export const WAKARU_PROVIDER_IDENTITY = {
  id: "wakaru",
  name: "Wakaru",
  version: WAKARU_RELEASE.version,
} as const;

/** Per-operation resource bounds shared by the verified adapters. */
export const RECOVERY_LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024,
  outputEntries: 10000,
  reportBytes: 8 * 1024 * 1024,
  addressSpaceBytes: 1024 * 1024 * 1024,
  timeoutMs: 120000,
} as const;

const COMMON_LIMITATIONS = [
  "Recovered sources are derived artifacts; original variable names and runtime equivalence are not established.",
  "Extraction ranges refer to half-open UTF-8 byte offsets in the original input, not rewritten line positions or whole-bundle coverage.",
  "Emitted source maps are preserved as reported by the engine; their mapping accuracy is not independently established.",
  "Inspection mode may produce non-executable regions. No input or recovered application code is executed.",
] as const;

const RESOURCE_LIMITATIONS = {
  prlimit:
    "Linux adapter: one worker, 1 GiB address-space ceiling, 120-second deadline, 64 MiB total input, 128 MiB output, 10000 output entries and 8 MiB per diagnostic/report stream. Resource limits are per operation, not aggregate host containment.",
  "shell-ulimit":
    "macOS adapter: one worker, 120-second CPU and wall-clock deadline, 64 MiB total input, 128 MiB output, 10000 output entries and 8 MiB per diagnostic/report stream. Output file size, core dumps and CPU time are limited through the shell; macOS cannot enforce an address-space ceiling, so memory use is not capped. Resource limits are per operation, not aggregate host containment.",
} as const;

/** Public limitations for transformations, extraction provenance and the host's resource limiter. */
export const recoveryLimitations = (
  limiterKind: keyof typeof RESOURCE_LIMITATIONS = "prlimit",
) => [...COMMON_LIMITATIONS, RESOURCE_LIMITATIONS[limiterKind]] as const;

/** Limitations for the Linux adapter, the original verified host. */
export const RECOVERY_LIMITATIONS = recoveryLimitations("prlimit");
