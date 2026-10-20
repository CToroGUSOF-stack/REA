#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseExecutableHeader } from "../dist/domain/binaryTarget.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";

// Links a source-owned x86-64 PE with its PDB, moves the PDB away from the path
// recorded in the image, then checks REA_GHIDRA_PDB_FILE end to end.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-pdb.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "verify:ghidra:pdb supports Linux/macOS hosts; the Windows P0 run is a separate follow-up.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "verify:ghidra:pdb prerequisite missing: GHIDRA_INSTALL_DIR (bring your own Ghidra).",
  );
const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `verify:ghidra:pdb prerequisite unavailable: ${JSON.stringify(installation)}`,
  );
const clang = process.env.REA_CLANG ?? "clang";
const lldLink = process.env.REA_LLD_LINK ?? "lld-link";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "tests", "conformance", "ghidra", "pdb-companion.c");
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-pdb-"));
const runtime = join(workspace, "runtime");
const symbols = join(workspace, "symbols");
await mkdir(runtime);
await mkdir(symbols);
let report;
let client;

try {
  const target = await link("fixture", 3);
  const other = await link("other", 7);
  const header = parseExecutableHeader(await readFile(target.exe), "x64");
  assert.ok(header.ok, JSON.stringify(header));
  const codeView = header.value.codeView;
  assert.ok(codeView?.guid, "The linked fixture has no RSDS CodeView record");
  const otherHeader = parseExecutableHeader(await readFile(other.exe), "x64");
  assert.ok(otherHeader.ok);
  assert.notEqual(otherHeader.value.codeView?.guid, codeView.guid);
  const sha256 = digest(await readFile(target.exe));
  const pdbSha256 = digest(await readFile(target.pdb));

  // 1. Control: without a caller PDB Ghidra cannot recover the PDB-only names.
  const baseline = await session({}, async () => {
    const procedures = await operation("list_procedures");
    return names(procedures);
  });
  assert.ok(!baseline.includes("rea_pdb_scale"), baseline.join(", "));

  // 2. A matching caller PDB is verified, applied, and reported.
  const applied = await session(
    { REA_GHIDRA_PDB_FILE: target.pdb },
    async () => {
      const procedures = names(await operation("list_procedures"));
      const pseudo = await tool("procedure_pseudo_code", {
        procedure: "rea_pdb_entry",
      });
      assert.notEqual(pseudo.isError, true, JSON.stringify(pseudo));
      return { procedures, evidence: parseEvidence(pseudo.structuredContent) };
    },
  );
  assert.ok(
    applied.procedures.includes("rea_pdb_scale"),
    applied.procedures.join(", "),
  );
  assert.ok(
    applied.procedures.includes("rea_pdb_entry"),
    applied.procedures.join(", "),
  );
  const evidence = applied.evidence;
  assert.equal(evidence.subject.digest.sha256, sha256);
  const companion = evidence.analysis_profile.parameters.pdb_companion;
  assert.equal(companion.format, "rea-ghidra-pdb-v1");
  assert.equal(companion.guid, codeView.guid);
  assert.equal(companion.age, codeView.age);
  assert.equal(companion.sha256, pdbSha256);
  assert.match(evidence.normalized_result, /rea_pdb_scale/u);
  assert.ok(
    evidence.limitations.some((text) =>
      text.startsWith(`PDB applied: ${companion.path} (sha256 ${pdbSha256}`),
    ),
    JSON.stringify(evidence.limitations),
  );

  // 3. A PDB from another link is refused before Ghidra starts, naming both GUIDs.
  const refused = await session(
    { REA_GHIDRA_PDB_FILE: other.pdb },
    async () => {
      const opened = await tool("open_binary", {
        path: target.exe,
        provider_id: "ghidra",
      });
      return opened.isError === true
        ? opened
        : await tool("list_procedures", {});
    },
    false,
  );
  const refusal = requireMcpToolError(refused);
  assert.equal(refusal.code, "unsupported_target", JSON.stringify(refusal));
  const refusalText = JSON.stringify(refusal);
  assert.ok(refusalText.includes(codeView.guid), refusalText);
  assert.ok(refusalText.includes(otherHeader.value.codeView.guid), refusalText);

  // 4. The pre-script itself refuses a PDB that changed after the commitment.
  const stale = await runHeadless([
    workspace,
    "pdb-refusal",
    "-import",
    target.exe,
    "-readOnly",
    "-deleteProject",
    "-scriptPath",
    join(root, "bridge", "ghidra"),
    "-preScript",
    "ReaGhidraApplyPdb.java",
    target.pdb,
    "0".repeat(64),
    codeView.guid,
    String(codeView.age),
  ]);
  assert.ok(
    stale.includes("REA PDB file changed after the analysis profile"),
    stale,
  );
  assert.ok(
    stale.includes("Processing aborted as a result of pre-script."),
    stale,
  );

  report = {
    ghidra_version: installation.providerVersion,
    target_sha256: sha256,
    codeview: codeView,
    pdb_sha256: pdbSha256,
    baseline_has_pdb_names: false,
    applied_procedures: applied.procedures,
    pseudocode: evidence.normalized_result,
    mismatch_refusal: refusal.code,
    mismatch_message: refusal.message,
    stale_pdb_prescript_abort: true,
  };
} finally {
  await rm(workspace, { recursive: true, force: true });
}
assert.ok(report, "No PDB report was produced");
const verifierRun = await completeVerifierRun(run);
assertVerifierCleanupComplete(verifierRun.process_lineage);
process.stdout.write(
  `${JSON.stringify({ verifier_run: verifierRun, ...report, cleanup: "complete" }, null, 2)}\n`,
);

async function link(name, variant) {
  const object = join(workspace, `${name}.obj`);
  const exe = join(workspace, `${name}.exe`);
  const linked = join(workspace, `${name}.pdb`);
  await promisify(execFile)(clang, [
    "--target=x86_64-pc-windows-msvc",
    "-O1",
    "-gcodeview",
    `-DREA_PDB_VARIANT=${variant}`,
    "-c",
    source,
    "-o",
    object,
  ]);
  await promisify(execFile)(lldLink, [
    "/entry:rea_pdb_entry",
    "/subsystem:console",
    "/nodefaultlib",
    "/debug",
    `/pdb:${linked}`,
    `/out:${exe}`,
    object,
  ]);
  // The image records the link-time PDB path; moving the PDB means only an
  // explicit caller selection can supply it.
  const pdb = join(symbols, `${name}-renamed.pdb`);
  await rename(linked, pdb);
  return { exe, pdb };
}

async function session(extraEnv, body, expectOpen = true) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: runtime,
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "ghidra",
    REA_PROCESS_RUN_ID: run.run_id,
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
    GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { JAVA_HOME: process.env.JAVA_HOME }),
    ...extraEnv,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "rea.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  client = new Client({ name: "rea-real-pdb", version: "1" });
  let stderr = "";
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    if (expectOpen) {
      const opened = await tool("open_binary", {
        path: join(workspace, "fixture.exe"),
        provider_id: "ghidra",
      });
      assert.notEqual(opened.isError, true, JSON.stringify(opened));
    }
    const result = await body();
    await tool("close_binary");
    return result;
  } catch (error) {
    if (stderr.length > 0) console.error(stderr);
    throw error;
  } finally {
    await client.close();
  }
}

function names(procedures) {
  return procedures.map((procedure) => procedure.value);
}

async function operation(name, arguments_ = {}) {
  return requireMcpOperationResult(await tool(name, arguments_), name);
}

async function tool(name, arguments_ = {}) {
  return client.callTool({ name, arguments: arguments_ }, { timeout: 600000 });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runHeadless(arguments_) {
  const launch = await spawnOwnedProviderProcess({
    command: join(process.env.GHIDRA_INSTALL_DIR, "support", "analyzeHeadless"),
    arguments: arguments_,
    runId: run.run_id,
    expectedCommand: null,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  try {
    assert.ok(
      await supervisor.waitForExit(600_000),
      "Ghidra PDB refusal check exceeded its deadline",
    );
    const snapshot = supervisor.snapshot();
    return `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  } finally {
    const stopped = await supervisor.stop();
    assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
    supervisor.dispose();
  }
}
