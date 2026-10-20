import { afterEach, expect, it } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createWebScreenshotArtifact } from "../../../src/domain/webScreenshot.js";

const INTEGRATION_TEST_TIMEOUT_MS = 20_000;
const resources: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});
const connectBrowser = async () => {
  const client = new Client({ name: "spatial-screenshot-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/rea.mjs", "mcp"],
    stderr: "pipe",
  });
  resources.push(client, transport);
  await client.connect(transport);
  return { client };
};

it(
  "preserves spatial comparison provenance through CLI, advertised MCP schemas and retained Evidence",
  async () => {
    const root = await createTestTempDirectory("rea-screenshot-regions-");
    const connected = await connectBrowser();
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const artifact = (red: number) =>
      createWebScreenshotArtifact(
        Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          pngChunk("IHDR", header),
          pngChunk(
            "IDAT",
            deflateSync(Buffer.from([0, 0, 0, 0, 255, red, 0, 0, 255])),
          ),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      );
    const input = {
      before: artifact(0),
      after: artifact(24),
      regions: [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 1, y: 0, width: 1, height: 1 },
      ],
    };
    const advertised = (await connected.client.listTools()).tools.find(
      ({ name }) => name === "compare_web_screenshots",
    );
    if (advertised?.outputSchema === undefined)
      throw new Error("Missing screenshot schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(advertised.inputSchema);
    const validateOutput = ajv.compile(
      z.record(z.string(), z.unknown()).parse(advertised.outputSchema),
    );
    expect(validateInput(input)).toBe(true);
    const result = await connected.client.callTool({
      name: advertised.name,
      arguments: input,
    });
    expect(result.isError).not.toBe(true);
    expect(
      validateOutput(result.structuredContent),
      JSON.stringify(validateOutput.errors),
    ).toBe(true);
    const mcp = parseEvidence(result.structuredContent);
    expect(mcp.parameters).toMatchObject({
      regions: input.regions,
      before_artifact_sha256: input.before.sha256,
      after_artifact_sha256: input.after.sha256,
    });
    expect(mcp.normalized_result).toMatchObject({
      changed_bounds: { x: 1, y: 0, width: 1, height: 1 },
      region_diffs: [
        { status: "identical", changed_bounds: null },
        { status: "different", changed_pixels: 1 },
      ],
    });
    const paths = [
      join(root, "before.json"),
      join(root, "after.json"),
      join(root, "regions.json"),
    ];
    await Promise.all(
      paths.map((path, index) =>
        writeFile(
          path,
          JSON.stringify([input.before, input.after, input.regions][index]),
        ),
      ),
    );
    for (const selection of [paths[2] ?? "", JSON.stringify(input.regions)]) {
      const cli = parseEvidence(
        await runCliJson([
          "compare-web-screenshots",
          paths[0] ?? "",
          paths[1] ?? "",
          "--regions",
          selection,
          "--json",
        ]),
      );
      expect(cli.evidence_id).toBe(mcp.evidence_id);
      expect(cli.normalized_result).toEqual(mcp.normalized_result);
    }
    const other = parseEvidence(
      (
        await connected.client.callTool({
          name: advertised.name,
          arguments: { ...input, regions: [input.regions[0]] },
        })
      ).structuredContent,
    );
    expect(other.evidence_id).not.toBe(mcp.evidence_id);
    for (const region of [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: 1, height: 1, extra: true },
    ])
      expect(validateInput({ ...input, regions: [region] })).toBe(false);
    const outOfBounds = [{ x: 2, y: 0, width: 1, height: 1 }];
    const rejected = await connected.client.callTool({
      name: advertised.name,
      arguments: { ...input, regions: outOfBounds },
    });
    expect(parseMcpToolError(rejected)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { issues: [{ path: ["regions", 0], reason: "out_of_range" }] },
      },
    });
    expect(
      await runCliJson([
        "compare-web-screenshots",
        paths[0] ?? "",
        paths[1] ?? "",
        "--regions",
        JSON.stringify(outOfBounds),
        "--json",
      ]),
    ).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["regions", 0], reason: "out_of_range" }] },
    });
    const bundle = join(root, "evidence.json");
    const exported = await connected.client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: bundle },
    });
    expect(exported.isError).not.toBe(true);
    const retained = JSON.parse(await readFile(bundle, "utf8")) as {
      records: unknown[];
    };
    expect(
      retained.records
        .map(parseEvidence)
        .find(({ evidence_id }) => evidence_id === mcp.evidence_id)
        ?.normalized_result,
    ).toEqual(mcp.normalized_result);
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

it.each([
  { count: 65, width: 1024, height: 1024, resource: "cpu" },
  { count: 1025, width: 1, height: 1, resource: "capacity" },
])(
  "reports region $resource admission through CLI and MCP",
  async ({ count, width, height, resource }) => {
    const root = await createTestTempDirectory("rea-region-admission-");
    const connected = await connectBrowser();
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1024, 0);
    header.writeUInt32BE(1024, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const artifact = createWebScreenshotArtifact(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(Buffer.from([0]))),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    );
    const regions = Array.from({ length: count }, () => ({
      x: 0,
      y: 0,
      width,
      height,
    }));
    const result = await connected.client.callTool({
      name: "compare_web_screenshots",
      arguments: { before: artifact, after: artifact, regions },
    });
    const mcp = parseMcpToolError(result).error;
    expect(mcp).toMatchObject({
      code: "resource_constraint",
      details: {
        resource,
        reported_limits: { boundary: "png-screenshot-regions" },
      },
    });
    const imagePath = join(root, "image.json"),
      regionsPath = join(root, "regions.json");
    await writeFile(imagePath, JSON.stringify(artifact));
    await writeFile(regionsPath, JSON.stringify(regions));
    const cli = await runCliJson([
      "compare-web-screenshots",
      imagePath,
      imagePath,
      "--regions",
      regionsPath,
      "--json",
    ]);
    expect(cli).toMatchObject({ code: mcp.code, details: mcp.details });
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

const pngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return chunk;
};
