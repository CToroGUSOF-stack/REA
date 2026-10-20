import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import { toolContract } from "../contracts/toolContracts.js";
import { ok } from "../domain/result.js";
import { discoverX64dbg } from "../x64dbg/X64dbgDiscovery.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

/** Register discovery-only x64dbg availability reporting. */
export const registerX64dbgTools = (
  server: McpServer,
  environment: Readonly<NodeJS.ProcessEnv>,
  logger: Logger,
  delivery: ToolResultDelivery,
): void => {
  const discover = toolContract("discover_x64dbg");
  server.registerTool(
    discover.name,
    toolRegistrationOptions(discover),
    async () => {
      const result = await logToolExecution(logger, discover.name, async () =>
        ok(discoverX64dbg({ platform: process.platform, environment })),
      );
      if (!result.ok) return delivery.toCallToolResult(result, discover);
      return delivery.toCallToolResult(
        {
          ok: true,
          value: {
            ...result.value,
            executables: [...result.value.executables],
          },
        },
        discover,
      );
    },
  );
};
