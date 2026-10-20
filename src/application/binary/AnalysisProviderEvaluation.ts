import {
  analysisProfileSchema,
  type AnalysisProfileCommitment,
} from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { jsonObjectSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";

/** Profile-resolution truth for one discovered provider candidate. */
export interface AnalysisProviderCandidateEvaluation {
  readonly candidate: AnalysisProviderCandidate;
  readonly status: AnalysisProviderCandidateStatus;
  readonly profile?: AnalysisProfileCommitment;
  readonly profileError?: AnalysisError;
}

/** Resolve and validate one provider profile without starting its client. */
export const evaluateAnalysisProviderCandidate = async (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  target: BinaryTarget,
  options: AnalysisProfileResolutionOptions = {},
): Promise<
  Result<AnalysisProviderCandidateEvaluation, AnalysisCancelledError>
> => {
  const { signal } = options;
  if (signalIsAborted(signal))
    return err(
      new AnalysisCancelledError("open_binary", { cause: signal?.reason }),
    );
  let resolved: Awaited<ReturnType<typeof candidate.resolveAnalysisProfile>>;
  try {
    resolved = await candidate.resolveAnalysisProfile(target, options);
  } catch (cause: unknown) {
    resolved = err(
      cause instanceof AnalysisError
        ? cause
        : new ProviderAdapterError(
            status.provider.id,
            "resolve_analysis_profile",
            {
              cause,
              diagnostics: { reason: "Provider profile resolution threw" },
            },
          ),
    );
  }
  if (!resolved.ok && resolved.error instanceof AnalysisCancelledError)
    return err(resolved.error);
  if (!resolved.ok) {
    const error = resolved.error;
    const rejection =
      error instanceof AnalysisUnsupportedTargetError
        ? {
            candidate,
            status: {
              ...status,
              eligibility: "ineligible" as const,
              targetSupport: {
                status: "unsupported" as const,
                code: "target_format_unsupported" as const,
                reason: error.reason,
                diagnostics: { path: error.path, error_tag: error._tag },
              },
            },
          }
        : rejectedProfile(candidate, status, error.message, {
            error_tag: error._tag,
          });
    return ok({ ...rejection, profileError: error });
  }
  if (signalIsAborted(signal))
    return err(
      new AnalysisCancelledError("open_binary", { cause: signal?.reason }),
    );
  try {
    if (resolved.value.profile === null)
      return ok(
        rejectedProfile(
          candidate,
          status,
          "Provider version or analysis profile could not be resolved",
        ),
      );
    const profile = analysisProfileSchema.parse(resolved.value.profile);
    const identity = candidate.identity();
    if (
      profile.provider.id !== identity.id ||
      profile.provider.name !== identity.name ||
      (identity.version !== null &&
        profile.provider.version !== identity.version)
    )
      return ok(
        rejectedProfile(
          candidate,
          status,
          "Resolved analysis profile has mismatched provider identity",
        ),
      );
    return ok({
      candidate,
      status: eligibleStatus(status, profile.provider),
      profile,
    });
  } catch (cause: unknown) {
    void cause;
    return ok(
      rejectedProfile(
        candidate,
        status,
        "Provider returned an invalid analysis profile",
      ),
    );
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/**
 * Attribute an eligible candidate to the identity its profile resolved.
 *
 * An adapter may declare an unresolved version and resolve the concrete one only
 * while probing. The profile is the fact that settled the identity, so every
 * eligible candidate must report that identity here — including the candidates
 * of a `selection_required` target, where no provider is bound yet and the
 * caller compares them. Every capability the provider published must carry the
 * same identity, because the reported route and its descriptors are one fact.
 */
const eligibleStatus = (
  status: AnalysisProviderCandidateStatus,
  provider: ProviderIdentity,
): AnalysisProviderCandidateStatus => ({
  ...status,
  provider: structuredClone(provider),
  eligibility: "eligible",
  capabilities: status.capabilities.map((capability) => ({
    ...capability,
    provider: structuredClone(provider),
  })),
});

const rejectedProfile = (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  reason: string,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): AnalysisProviderCandidateEvaluation => ({
  candidate,
  status: {
    ...status,
    eligibility: "ineligible",
    availability: {
      status: "unavailable",
      code: "version_unresolved",
      reason,
      diagnostics: jsonObjectSchema.parse({
        ...status.availability.diagnostics,
        ...diagnostics,
      }),
    },
  },
});
