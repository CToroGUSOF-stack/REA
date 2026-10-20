import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisProviderCandidateEvaluation } from "./AnalysisProviderEvaluation.js";

/**
 * Caller-visible outcome of one deep-provider selection for a parsed target.
 *
 * `selection_required` is the agent-aware state: more than one configured
 * provider is eligible, so REA refuses to bind an arbitrary engine and reports
 * the decision instead of starting one. `unbound` means no configured deep
 * provider is eligible, which preserves artifact-only and auxiliary workflows.
 */
export type ProviderSelectionState = "bound" | "unbound" | "selection_required";

/**
 * Per-candidate eligibility for the reported target.
 *
 * `unevaluated` is a deliberate omission, not a rejection: REA resolves only
 * the profiles a selection actually needs, so an unrequested provider stays
 * unknown rather than being reported as unusable.
 */
export type ProviderCandidateEligibility =
  | "eligible"
  | "ineligible"
  | "unevaluated";

/** Candidate whose profile was resolved and validated against the target. */
export type EligibleAnalysisProviderEvaluation =
  AnalysisProviderCandidateEvaluation & {
    readonly profile: AnalysisProfileCommitment;
  };

/** Pure decision over already evaluated candidates; no provider side effects. */
export interface AutoProviderSelectionDecision {
  readonly state: ProviderSelectionState;
  /** Eligible candidates in the registry's canonical provider-ID order. */
  readonly eligible: readonly EligibleAnalysisProviderEvaluation[];
}

/**
 * Decide how automatic selection resolves a target.
 *
 * Eligibility is exactly the authoritative evaluation result: availability,
 * target compatibility, and a resolved, identity-matched analysis profile.
 * This function never ranks providers, never starts a client, and never
 * resolves installations; the caller owns those boundaries.
 */
export const decideAutoProviderSelection = (
  evaluations: readonly AnalysisProviderCandidateEvaluation[],
): AutoProviderSelectionDecision => {
  const eligible = evaluations.filter(isEligible);
  return {
    state:
      eligible.length === 0
        ? "unbound"
        : eligible.length === 1
          ? "bound"
          : "selection_required",
    eligible,
  };
};

const isEligible = (
  evaluation: AnalysisProviderCandidateEvaluation,
): evaluation is EligibleAnalysisProviderEvaluation =>
  evaluation.profile !== undefined;
