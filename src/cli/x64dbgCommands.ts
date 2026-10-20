import { z } from "incur";
import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { discoverX64dbg } from "../x64dbg/X64dbgDiscovery.js";
import type { CliInstance } from "./types.js";

/** Register the discovery-only x64dbg command; it never starts a debugger. */
export const registerX64dbgCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.discoverX64dbg, {
    description:
      "Report BYO x64dbg availability and architecture from file metadata without launching it",
    args: z.object({}),
    run: () =>
      logCliCommand(logger, CLI_COMMANDS.discoverX64dbg, async () =>
        discoverX64dbg({ platform: process.platform, environment }),
      ),
  });
};
