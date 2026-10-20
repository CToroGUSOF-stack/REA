import { parseEvidence } from "../../dist/domain/evidence.js";
import { electronActiveObservationResultSchema } from "../../dist/domain/javascript/electronActiveObservation.js";
import { requireMcpToolError } from "../../scripts/lib/mcp-verifier-results.mjs";

// An unresolved Promise alone does not keep Node alive when all resource
// handles have disappeared (for example, after a partially failed close).
export const retainVerifierOwner = () =>
  new Promise(() => {
    setInterval(() => {}, 60_000);
  });

const replyFacts = (operation, reply) => {
  if (reply.isError) {
    const error = requireMcpToolError(reply);
    return {
      cleanup: error.code === "cleanup_incomplete" ? "incomplete" : "verified",
      error,
    };
  }
  if (operation === "capture_electron_scenario") {
    const evidence = parseEvidence(reply.structuredContent);
    const capture = electronActiveObservationResultSchema.parse(
      evidence.normalized_result,
    );
    return {
      cleanup:
        capture.application.cleanup === "terminated-owned-process"
          ? "verified"
          : "unknown",
      evidence,
    };
  }
  return { cleanup: "verified" };
};

/** Own cleanup truth independently of transport settlement and artifact storage. */
export function createVerifierRun({
  lifecycle,
  closeClient,
  closeTransport,
  closeHost,
  writeArtifact,
  retainOwner,
  reportRetention,
  onFailure,
}) {
  let cleanupUnsafe = false;
  let unsafeReply;
  const failures = [];
  const recordFailure = (stage, cause) => {
    failures.push({ stage, cause });
    // Reporting is observational; even a broken diagnostic sink cannot release ownership.
    try {
      onFailure?.(stage, cause);
    } catch (reportCause) {
      failures.push({ stage: "failure-reporting", cause: reportCause });
    }
  };
  const observeReply = (operation, reply) => {
    const wasUnsafe = cleanupUnsafe;
    cleanupUnsafe = true;
    // Hold the original reply before parsing. Malformed cleanup remains unknown.
    const previousUnsafeReply = unsafeReply;
    unsafeReply ??= { operation, reply };
    const facts = replyFacts(operation, reply);
    cleanupUnsafe = wasUnsafe || facts.cleanup !== "verified";
    if (!cleanupUnsafe) unsafeReply = previousUnsafeReply;
    return facts;
  };
  const mustRetain = () => cleanupUnsafe || !lifecycle.state().safe_to_close;
  const attempt = async (stage, action, ownsResource = false) => {
    try {
      return { ok: true, value: await action() };
    } catch (cause) {
      if (ownsResource) cleanupUnsafe = true;
      recordFailure(stage, cause);
      return {
        ok: false,
        error: { _tag: "VerifierStepFailure", stage, cause },
      };
    }
  };
  const diagnostic = (name, produceBytes) =>
    attempt(`artifact:${name}`, async () =>
      writeArtifact(name, await produceBytes()),
    );
  const finalize = async (writeDiagnostics) => {
    try {
      // Resolve inspector ownership before releasing the last server handle;
      // diagnostics must reflect any failure of this cleanup too.
      await attempt("close-inspector", closeHost, true);
      if (!mustRetain()) {
        await attempt("close-client", closeClient, true);
        if (!mustRetain())
          await attempt("close-transport", closeTransport, true);
      }
      await attempt("diagnostics", writeDiagnostics);
    } finally {
      // Every fallible close, serialization, write and notification stays inside
      // this guard. Diagnostics never take control away from the resource owner.
      if (mustRetain()) {
        await attempt("retention-reporting", reportRetention);
        await retainOwner();
      }
    }
  };
  return {
    observeReply,
    recordFailure,
    diagnostic,
    finalize,
    state: () => ({
      cleanup_unverified: cleanupUnsafe,
      must_retain: mustRetain(),
      failures: [...failures],
    }),
    unsafeReply: () => unsafeReply,
  };
}
