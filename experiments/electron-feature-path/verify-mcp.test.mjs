import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseApplicationGraphEvidence } from "../../dist/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { parseEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import { requireMcpToolError } from "../../scripts/lib/mcp-verifier-results.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const verifier = fileURLToPath(new URL("verify-mcp.mjs", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const runVerifier = async (context, { checkpointCollision = false } = {}) => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "rea-feature-path-verifier-")),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const electron = join(temporary, "not-an-executable.txt");
  await writeFile(
    electron,
    "Self-authored non-executable test input; never execute this file.\n",
    { mode: 0o600 },
  );
  assert.equal((await stat(electron)).mode & 0o111, 0);
  const output = join(temporary, "output");
  const collisionText =
    "Caller-owned checkpoint collision: preserve these bytes.\n";
  let collisionReady;
  if (checkpointCollision) {
    collisionReady = new Promise((resolve, reject) => {
      let installed = false;
      // Wait for the verifier's own fresh directory creation. Its MCP startup
      // and static analysis must still precede the checkpoint export.
      const watcher = watch(temporary, (_event, name) => {
        if (String(name) !== "output" || installed) return;
        installed = true;
        void writeFile(
          join(output, "evidence-checkpoint.json"),
          collisionText,
          { flag: "wx" },
        ).then(resolve, reject);
      });
      watcher.on("error", reject);
      context.after(() => watcher.close());
    });
  }
  const completed = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [verifier, "--electron", electron, "--output", output],
      {
        cwd: root,
        timeout: 30000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
  if (collisionReady) await collisionReady;
  return { completed, output, electron, collisionText };
};

const subprocessOptions = {
  skip:
    process.platform === "win32"
      ? "Requires POSIX non-executable file permissions."
      : false,
  timeout: 45000,
};

test(
  "a real failed capture preserves the validated complete static parent checkpoint",
  subprocessOptions,
  async (context) => {
    const { completed, output, electron } = await runVerifier(context);
    assert.equal(completed.code, 1, completed.stderr);
    const staticReply = await readJson(
      join(output, "analyze_javascript_application.json"),
    );
    const summary = parseEvidence(staticReply.structuredContent);
    const parentId = summary.normalized_result.parent_evidence_id;
    assert.equal(typeof parentId, "string");
    const feature = parseEvidence(
      (await readJson(join(output, "trace_application_feature.json")))
        .structuredContent,
    );
    const checkpoint = parseEvidenceBundle(
      await readJson(join(output, "evidence-checkpoint.json")),
    );
    const parent = checkpoint.records.find(
      (record) => record.evidence_id === parentId,
    );
    assert.ok(
      parent,
      "The summary's complete parent must survive failed capture.",
    );
    assert.notEqual(parent.evidence_id, summary.evidence_id);
    const source = parseApplicationGraphEvidence(parent);
    assert.equal(
      source.ok,
      true,
      "The retained parent must remain valid input to application workflows.",
    );
    assert.ok(source.value.graph.nodes.length > 0);
    assert.ok(
      checkpoint.records.some(
        (record) => record.evidence_id === feature.evidence_id,
      ),
    );
    const captureRequest = await readJson(
      join(output, "capture_electron_scenario-request.json"),
    );
    assert.equal(captureRequest.arguments.executable_path, electron);
    const captureReply = await readJson(
      join(output, "capture_electron_scenario.json"),
    );
    const captureError = requireMcpToolError(captureReply);
    assert.equal(captureError.category, "invalid_input");
    assert.equal(captureError.code, "invalid_request");
    assert.ok(
      captureError.details.issues.some(
        (issue) =>
          issue.path.length === 1 &&
          issue.path[0] === "executable_path" &&
          issue.message.includes("not an executable file"),
      ),
    );
    const exportRequest = await readJson(
      join(output, "export_evidence_bundle-before-capture-request.json"),
    );
    assert.equal(
      exportRequest.arguments.path,
      join(output, "evidence-checkpoint.json"),
    );
    assert.notEqual(
      (
        await readJson(
          join(output, "export_evidence_bundle-before-capture.json"),
        )
      ).isError,
      true,
    );
    await assert.rejects(readFile(join(output, "evidence-bundle.json")), {
      code: "ENOENT",
    });
    const lifecycle = await readJson(join(output, "lifecycle.json"));
    assert.equal(lifecycle.safe_to_close, true);
    assert.equal(lifecycle.cleanup_unverified, false);
  },
);

test(
  "a real checkpoint destination collision prevents capture and preserves existing bytes",
  subprocessOptions,
  async (context) => {
    const { completed, output, collisionText } = await runVerifier(context, {
      checkpointCollision: true,
    });
    assert.equal(completed.code, 1, completed.stderr);
    const staticReply = await readJson(
      join(output, "analyze_javascript_application.json"),
    );
    parseEvidence(staticReply.structuredContent);
    const featureReply = await readJson(
      join(output, "trace_application_feature.json"),
    );
    parseEvidence(featureReply.structuredContent);
    const exportReply = await readJson(
      join(output, "export_evidence_bundle-before-capture.json"),
    );
    assert.equal(exportReply.isError, true);
    requireMcpToolError(exportReply);
    assert.equal(
      await readFile(join(output, "evidence-checkpoint.json"), "utf8"),
      collisionText,
    );
    await assert.rejects(
      readFile(join(output, "capture_electron_scenario-request.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(output, "capture_electron_scenario.json")),
      { code: "ENOENT" },
    );
    const lifecycle = await readJson(join(output, "lifecycle.json"));
    assert.equal(lifecycle.safe_to_close, true);
    assert.equal(lifecycle.cleanup_unverified, false);
  },
);
