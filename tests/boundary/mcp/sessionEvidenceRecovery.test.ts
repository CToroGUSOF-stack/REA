import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createServer } from "../../../src/server/createServer.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const bundleResult = (reply: CallToolResult) =>
  z.object({ result: evidenceBundleSchema }).parse(reply.structuredContent)
    .result;

type Bundle = ReturnType<typeof bundleResult>;

const recordsWithPredicate = (bundle: Bundle, predicate: string) =>
  bundle.records.filter(({ predicate_type: actual }) => actual === predicate);

/**
 * Assert the exact retained-record composition for one admitted target.
 *
 * Admitting `target` records one selection decision attributed to REA's
 * selection policy; the provider observations and the Unknown mutation history
 * are unchanged by it. The length is asserted together with each contributing
 * group so the count stays justified rather than a bare constant.
 */
const expectRetainedRecords = (bundle: Bundle, target: string): void => {
  const selection = recordsWithPredicate(bundle, "rea.provider-selection");
  expect(selection).toHaveLength(1);
  expect(selection[0]).toMatchObject({
    operation: "open_binary",
    authority: "analyst-inference",
    confidence: "derived",
    provider: { id: "rea-provider-selection" },
    subject: { local_path: target, format: "analysis-database" },
  });
  const analysis = recordsWithPredicate(bundle, "rea.analysis");
  expect(analysis).toHaveLength(1);
  // The decision describes the same target identity as that target's analysis.
  expect(selection[0]?.subject?.digest).toEqual(analysis[0]?.subject?.digest);
  expect(
    recordsWithPredicate(bundle, "rea.javascript-application-analysis"),
  ).toHaveLength(1);
  expect(
    recordsWithPredicate(bundle, "rea.residual-unknown-mutation"),
  ).toHaveLength(2);
  // One selection record plus the four investigation records above.
  expect(bundle.records).toHaveLength(5);
  expect(bundle.unknowns).toHaveLength(2);
};

const successfulTool = async (
  client: Client,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<CallToolResult> => {
  const reply = await client.callTool({ name, arguments: arguments_ });
  expect(reply.isError, `${name}: ${JSON.stringify(reply.content)}`).not.toBe(
    true,
  );
  return reply;
};

const recordUnknownHistory = async (client: Client): Promise<void> => {
  const fields = {
    severity: "medium",
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const unknown = await successfulTool(client, "record_unknown", {
    ...fields,
    question: "Which source revision produced this target?",
    domain: "provenance",
  });
  const recorded = z
    .object({ result: z.object({ unknown_id: z.string() }) })
    .parse(unknown.structuredContent).result;
  await successfulTool(client, "update_unknown", {
    ...fields,
    unknown_id: recorded.unknown_id,
    expected_revision: 1,
    status: "investigating",
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    resolution: null,
  });
};

it.each(["switch", "restart"] as const)(
  "preserves investigation records through failed target %s and cleanup retries",
  async (transition) => {
    const root = await createTestTempDirectory("rea-mcp-switch-evidence-");
    const first = join(root, "first.hop");
    const second = join(root, "second.hop");
    await writeFile(first, "first source-owned target");
    await writeFile(second, "second source-owned target");
    const application = join(root, "application");
    await mkdir(application);
    await writeFile(
      join(application, "index.js"),
      'export const label = "retained";',
    );
    const nextTarget = transition === "switch" ? second : first;
    const calls: string[] = [];
    const base = createCacheProvider(calls);
    let cleanupAllowed = true;
    let created = 0;
    const failure = new ProviderCleanupError(
      "fixture",
      [join(root, "runtime")],
      {
        reason: "fixture cleanup temporarily unavailable",
      },
    );
    const session = createTestBinarySession({
      ...base,
      createClient: (target, profile, context) => {
        created += 1;
        return {
          ...base.createClient(target, profile, context),
          operationHealthSnapshot: () => ({
            state: cleanupAllowed ? "idle" : "exited",
            stage: "analysis",
            retryAction: cleanupAllowed ? null : "restart_provider",
            exitCode: cleanupAllowed ? null : 1,
            requests: [],
          }),
          close: () =>
            Promise.resolve(cleanupAllowed ? ok(null) : err(failure)),
        };
      },
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const client = new Client({
      name: "switch-evidence-recovery",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const call = (name: string, arguments_: Record<string, unknown> = {}) =>
      successfulTool(client, name, arguments_);
    const query = { address: "0x1000", document: "fixture" };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await call("open_binary", { path: first });
      // The cached primitive must be discarded when the provider is retired,
      // independently of the investigation's Evidence and Unknown history.
      await call("address_name", query);
      const analyzed = await call("analyze_javascript_application", {
        input_path: application,
        format: "directory",
        max_heap_mb: 128,
      });
      const applicationId = z
        .object({ evidence_id: z.string() })
        .parse(analyzed.structuredContent).evidence_id;
      await recordUnknownHistory(client);
      const before = bundleResult(await call("get_evidence_bundle"));
      expectRetainedRecords(before, first);

      cleanupAllowed = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const replacement = await client.callTool({
          name: "open_binary",
          arguments: { path: nextTarget },
        });
        expect(parseMcpToolError(replacement)).toMatchObject({
          error: { code: "cleanup_incomplete" },
        });
        expect(session.activeTarget()).toBeUndefined();
        expect(created).toBe(1);
        expect(bundleResult(await call("get_evidence_bundle"))).toEqual(before);
      }
      const exportedPath = join(root, "retained.json");
      await call("export_evidence_bundle", { path: exportedPath });
      expect(
        evidenceBundleSchema.parse(
          JSON.parse(await readFile(exportedPath, "utf8")),
        ),
      ).toEqual(before);

      cleanupAllowed = true;
      await call("open_binary", { path: nextTarget });
      const recovered = bundleResult(await call("get_evidence_bundle"));
      if (transition === "restart") {
        // Restarting the same target resolves the same decision, whose Evidence
        // identity already exists, so recovery adds no record at all.
        expect(recovered).toEqual(before);
      } else {
        // A successful switch retains every record and adds exactly the new
        // target's admitting decision, bound to that target.
        const retainedIds = new Set(
          before.records.map(({ evidence_id: id }) => id),
        );
        expect(
          recovered.records.filter(({ evidence_id: id }) =>
            retainedIds.has(id),
          ),
        ).toHaveLength(before.records.length);
        expect(recovered.records).toHaveLength(before.records.length + 1);
        expect(
          recovered.records.filter(
            ({ evidence_id: id }) => !retainedIds.has(id),
          ),
        ).toMatchObject([
          {
            operation: "open_binary",
            predicate_type: "rea.provider-selection",
            authority: "analyst-inference",
            confidence: "derived",
            provider: { id: "rea-provider-selection" },
            subject: { local_path: second, format: "analysis-database" },
          },
        ]);
        expect(recovered.unknowns).toEqual(before.unknowns);
      }
      await call("address_name", query);
      expect(
        calls.filter((operation) => operation === "address_name"),
      ).toHaveLength(2);
      expect(created).toBe(2);
      await call("inspect_analysis_view", {
        source: { kind: "retained-evidence", evidence_id: applicationId },
        view: { kind: "page", collection: "modules", offset: 0, limit: 10 },
      });
      await call("close_binary");
      const closed = bundleResult(await call("get_evidence_bundle"));
      expect(closed.records).toEqual([]);
      expect(closed.unknowns).toEqual([]);
    } finally {
      cleanupAllowed = true;
      await client.close();
      await server.close();
      await session.close();
    }
  },
);
