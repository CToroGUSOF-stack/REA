import type { output } from "zod";
import type { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import type { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Bind offline layout inspection to its named contract and session Evidence owner. */
export const registerBinaryDiagnosticsTools = (
  server: EvidenceMcpServer,
  layoutService: BinaryLayoutService,
  entropyService: ByteEntropyService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  evidenceById?: EvidenceLookup,
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const layout = toolContract("inspect_binary_layout");
  const entropy = toolContract("inspect_byte_entropy");
  const run = (
    contract: typeof layout | typeof entropy,
    service: BinaryLayoutService | ByteEntropyService,
    {
      detail,
      ...request
    }: output<typeof layout.inputSchema> | output<typeof entropy.inputSchema>,
    signal: AbortSignal,
  ) =>
    runAdmittedToolOperation(
      server,
      withAdmittedAnalysis,
      contract.name,
      signal,
      async () => {
        const result = await logToolExecution(
          logger,
          contract.name,
          async () => {
            if (detail === "summary") {
              const ready = requireAnalysisViewRetention(contract.name, {
                recordEvidence,
                evidenceById,
              });
              if (!ready.ok) return ready;
            }
            const inspected = await service.inspect(request, { signal });
            return detail === "summary" && inspected.ok
              ? summarizeRetainedAnalysis(inspected.value, {
                  recordEvidence,
                  evidenceById,
                })
              : inspected;
          },
        );
        if (!result.ok)
          return server.delivery.toCallToolResult(result, contract);
        const recorded = recordEvidence?.(result.value);
        return server.delivery.toEvidenceToolResult(
          result.value,
          contract,
          recorded,
        );
      },
    );
  server.registerTool(
    layout.name,
    toolRegistrationOptions(layout),
    (request, context) =>
      run(layout, layoutService, request, context.mcpReq.signal),
  );
  server.registerTool(
    entropy.name,
    toolRegistrationOptions(entropy),
    (request, context) =>
      run(entropy, entropyService, request, context.mcpReq.signal),
  );
};
