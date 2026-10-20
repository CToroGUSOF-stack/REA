import {
  EvidenceFileError,
  EvidenceIntegrityError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import {
  createImmutableEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import type { InspectAnalysisViewInput } from "../domain/analysisView/analysisView.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareBundles } from "../domain/bundleComparison.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readEvidenceBundle,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "./EvidenceBundleFiles.js";
import { inspectAnalysisViewValidated } from "./analysisView/AnalysisViewService.js";

/** Validate a standalone bundle and report its complete record/revision counts. */
export const importEvidenceBundleCommand = async (
  path: string,
): Promise<Result<JsonValue, AnalysisError>> => {
  const loaded = await readEvidenceBundle(path);
  if (!loaded.ok) return loaded;
  return ok({
    imported: loaded.value.records.length,
    unknowns_added: loaded.value.unknowns.length,
    total: loaded.value.records.length,
  });
};

/** Validate a source bundle and atomically export canonical bytes. */
export const exportEvidenceBundleCommand = async (
  sourcePath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<Result<JsonValue, AnalysisError>> => {
  // The sealed snapshot lets the writer reuse this authentication.
  const loaded = await readImmutableEvidenceBundle(sourcePath);
  if (!loaded.ok) return loaded;
  return projectWrite(
    loaded.value,
    await persistEvidenceBundleCommand(loaded.value, outputPath, overwrite),
  );
};

/** Publish complete parent Evidence before delivering it or its linked summary. */
export const deliverAnalysisEvidence = async (
  evidence: Evidence,
  outputPath: string,
  detail: "complete" | "summary" = "complete",
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  const bundle = createImmutableEvidenceBundle([evidence]);
  const delivered =
    detail === "summary"
      ? inspectAnalysisViewValidated(
          {
            source: {
              kind: "retained-evidence",
              evidence_id: evidence.evidence_id,
            },
            view: { kind: "summary" },
          },
          (id) => bundle.records.find((record) => record.evidence_id === id),
        )
      : ok(evidence);
  if (!delivered.ok) return delivered;
  const written = await persistEvidenceBundleCommand(
    bundle,
    outputPath,
    false,
    signal,
  );
  if (!written.ok) return err(written.error.retainPartialObservation(evidence));
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(evidence.operation, {
        cause: signal.reason,
        partialObservation: delivered.value,
        diagnostics: { evidence_bundle: { ...written.value } },
      }),
    );
  return delivered;
};

/** Resolve the caller's exact retained parent from an authenticated portable bundle. */
export const inspectAnalysisViewFromBundle = async (
  input: InspectAnalysisViewInput,
  bundlePath: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  if (input.source.kind !== "retained-evidence")
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["source", "kind"],
          reason: "invalid_value",
          message:
            "--evidence-bundle requires a retained-evidence source with the exact parent evidence_id; inline Evidence already supplies its source",
        },
      ]),
    );
  const loaded = await readImmutableEvidenceBundle(
    bundlePath,
    signal,
    resources,
  );
  if (!loaded.ok) return loaded;
  return inspectAnalysisViewValidated(input, (id) =>
    loaded.value.records.find((record) => record.evidence_id === id),
  );
};

/** Publish a completed bundle and retry its exact staged-output cleanup owner. */
const persistEvidenceBundleCommand = async (
  bundle: EvidenceBundle,
  outputPath: string,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<Result<PublishedEvidenceFile, AnalysisError>> => {
  const resources = new ArtifactResourceScope();
  const written = await writeEvidenceBundle(
    bundle,
    outputPath,
    overwrite,
    resources,
    signal,
  );
  if (written.ok) return written;

  let cleanupSucceeded = false;
  try {
    await resources.close();
    cleanupSucceeded = true;
  } catch {
    // The original error cause retains the same staged-output owner for diagnostics.
  }
  if (
    cleanupSucceeded &&
    written.error instanceof EvidenceFileError &&
    written.error.published
  ) {
    return ok(written.error.published);
  }
  return written;
};

/** Compare two validated canonical Evidence bundles without session state. */
export const compareEvidenceBundlesCommand = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
}): Promise<Result<JsonValue, AnalysisError>> => {
  // Sealed snapshots let comparison and its bundle digests reuse this
  // authentication instead of re-validating every record twice more.
  const [left, right] = await Promise.all([
    readImmutableEvidenceBundle(input.leftPath),
    readImmutableEvidenceBundle(input.rightPath),
  ]);
  if (!left.ok) return left;
  if (!right.ok) return right;
  try {
    return ok(jsonValueSchema.parse(compareBundles(left.value, right.value)));
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle comparison failed", {
        cause,
      }),
    );
  }
};

const projectWrite = (
  bundle: EvidenceBundle,
  written: Result<PublishedEvidenceFile, AnalysisError>,
): Result<JsonValue, AnalysisError> =>
  written.ok
    ? ok({
        path: written.value.path,
        bytes: written.value.bytes,
        records: bundle.records.length,
      })
    : err(written.error);
