import { z } from "incur";

import { createBrowserExtensionService } from "../composition/browserExtension.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectBrowserExtensionInputSchema } from "../domain/browserExtension/browserExtension.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Inspect one operator-selected extension package through the shared workflow. */
export const registerBrowserExtensionCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectBrowserExtension, {
    description:
      "Inspect a CRX, XPI, ZIP, or unpacked manifest.json without loading the extension",
    args: z.object({
      path: z.string().describe("Local CRX, XPI, ZIP, or manifest.json"),
    }),
    options: z.object({
      maxFileBytes: inspectBrowserExtensionInputSchema.shape.max_file_bytes,
      maxManifestBytes:
        inspectBrowserExtensionInputSchema.shape.max_manifest_bytes,
      maxEntries: inspectBrowserExtensionInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createBrowserExtensionService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectBrowserExtension,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_manifest_bytes: options.maxManifestBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              service,
              "rea-browser-extension",
              "inspect_browser_extension",
              signal,
            ),
        );
      }),
  });
};
