import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { completeVerifierRun } from "./verifier-run.mjs";

/** Finish all owned resources before releasing inputs or reporting success. */
export async function finishScreenshotVerifier(
  run,
  workspace,
  closeTasks,
  failures = [],
) {
  const cleanupFailures = [];
  for (const close of closeTasks) {
    try {
      await close();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  let completed;
  try {
    completed = await completeVerifierRun(run);
    const lineage = completed.process_lineage;
    assert.equal(lineage.status, "verified", JSON.stringify(lineage));
    assert.deepEqual(
      lineage.descendants,
      [],
      "Screenshot verifier left live descendants",
    );
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  if (cleanupFailures.length === 0) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  if (failures.length || cleanupFailures.length) {
    throw new AggregateError(
      [...failures, ...cleanupFailures],
      cleanupFailures.length
        ? `Screenshot verifier cleanup failed; workspace retained at ${workspace}`
        : "Screenshot verification failed",
    );
  }
  return completed;
}
