import type { Client } from "@modelcontextprotocol/client";

import type { McpInputSchemaProfile } from "./config/mcpInputSchemaProfile.js";
import type { McpOutputSchemaProfile } from "./config/mcpOutputSchemaProfile.js";
import { jsonParts } from "./domain/jsonSerialization.js";

interface CatalogProfiles {
  readonly input_schema: McpInputSchemaProfile | null;
  readonly output_schema: McpOutputSchemaProfile | null;
}

interface ToolSize {
  readonly name: string;
  readonly json_bytes: number;
  readonly input_schema_json_bytes: number;
  readonly output_schema_json_bytes: number;
}

/** Count the SDK-observed JSON in bounded parts, without another catalog-sized string. */
const jsonBytes = (value: unknown): number => {
  let bytes = 0;
  for (const part of jsonParts(value)) bytes += Buffer.byteLength(part, "utf8");
  return bytes;
};

/** Measure the received tools/list result, not a model's rendered tools or token usage. */
export const measureMcpDoctorCatalog = (
  result: Awaited<ReturnType<Client["listTools"]>>,
  profiles: CatalogProfiles,
) => {
  let inputBytes = 0;
  let outputBytes = 0;
  let largestTool: ToolSize | null = null;
  let largestInput: { name: string; json_bytes: number } | null = null;
  let largestOutput: { name: string; json_bytes: number } | null = null;
  for (const tool of result.tools) {
    const input = jsonBytes(tool.inputSchema);
    const output =
      tool.outputSchema === undefined ? 0 : jsonBytes(tool.outputSchema);
    const bytes = jsonBytes(tool);
    inputBytes += input;
    outputBytes += output;
    if (largestTool === null || bytes > largestTool.json_bytes)
      largestTool = {
        name: tool.name,
        json_bytes: bytes,
        input_schema_json_bytes: input,
        output_schema_json_bytes: output,
      };
    if (largestInput === null || input > largestInput.json_bytes)
      largestInput = { name: tool.name, json_bytes: input };
    if (
      tool.outputSchema !== undefined &&
      (largestOutput === null || output > largestOutput.json_bytes)
    )
      largestOutput = { name: tool.name, json_bytes: output };
  }
  const bytes = jsonBytes(result);
  return {
    profiles,
    complete: result.nextCursor === undefined,
    tools_list_json_bytes: bytes,
    input_schema_json_bytes: inputBytes,
    output_schema_json_bytes: outputBytes,
    other_json_bytes: bytes - inputBytes - outputBytes,
    largest_tool: largestTool,
    largest_input_schema: largestInput,
    largest_output_schema: largestOutput,
    limitation:
      "UTF-8 bytes of the SDK-observed tools/list JSON result, excluding the JSON-RPC envelope and transport framing. Schema totals count values; other_json_bytes includes keys, tool metadata and result metadata. These are not model tokens or proof of client acceptance. Profiles are requested child configuration; server identity is checked separately. A continuation cursor means this is only one page, not the complete catalog.",
  };
};
