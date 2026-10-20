import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

export const x64dbgDiscoveryInputSchema = z.strictObject({});

export const x64dbgExecutableSchema = z.strictObject({
  path: z.string(),
  source: z.enum(["environment", "well-known-path"]),
  architecture: z.enum(["x64", "x86"]).nullable(),
  size_bytes: z.number().int().nonnegative(),
  architecture_status: z.enum(["pe_header", "unrecognized_header"]),
});

export const x64dbgDiscoverySchema = z.strictObject({
  provider: z.string(),
  host_platform: z.string(),
  status: z.enum([
    "available",
    "unsupported_platform",
    "configured_path_not_found",
    "not_found",
  ]),
  reason: z.string(),
  executables: z.array(x64dbgExecutableSchema),
  configured_command: z.string().nullable(),
  launched_process: z.literal(false),
  debug_session_capability: z.literal("not_implemented"),
});

/** Discovery-only x64dbg contracts; no session, attach, or breakpoint tools. */
export const X64DBG_TOOL_CONTRACTS = [
  {
    name: "discover_x64dbg",
    ...toolContractMetadata("discover_x64dbg"),
    kind: "native-provider",
    description:
      "Report whether a bring-your-own x64dbg or x32dbg executable is configured through REA_X64DBG_COMMAND or present in well-known Windows install locations, with PE-header architecture. Reads file metadata only: it never launches the debugger, attaches to, or modifies any process. On non-Windows hosts it returns unsupported_platform. Live debugging sessions are not implemented.",
    inputSchema: x64dbgDiscoveryInputSchema,
    outputSchema: x64dbgDiscoverySchema,
    examples: [{ title: "Discover x64dbg", input: {} }],
  },
] as const satisfies readonly ToolContract[];
