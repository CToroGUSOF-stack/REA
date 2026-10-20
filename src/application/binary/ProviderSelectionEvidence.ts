import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { PROVIDER_SELECTION_PROVIDER } from "../InvestigationProviders.js";
import type {
  AnalysisProviderCandidateStatus,
  AnalysisProviderSelection,
} from "./AnalysisProviderRegistry.js";

/**
 * Closed vocabulary for the deterministic rule that produced a selection.
 *
 * The rule restates the selection source in Evidence terms. It is never a
 * provider ranking: `auto-multiple-eligible` records that REA declined to
 * choose rather than that one engine is preferable.
 */
export type ProviderSelectionRule =
  | "explicit-provider"
  | "configured-preference"
  | "auto-single-candidate"
  | "auto-multiple-eligible"
  | "auto-none-eligible";

const SELECTION_LIMITATIONS = [
  "Provider eligibility reflects local host availability, target compatibility, and profile resolution for this target; it does not establish analysis fidelity, completeness, or superiority for any provider.",
  "REA records no caller or agent rationale in this record. An explicit provider_id is a caller choice, not verified engine evidence.",
] as const;

const stateLimitation = (
  selection: AnalysisProviderSelection,
): readonly string[] => {
  switch (selection.selectionState) {
    case "selection_required":
      return [
        "No provider was bound because more than one configured provider is eligible for this target. Reopen the target with an explicit provider_id to bind one.",
      ];
    case "unbound":
      return [
        "No eligible deep analysis provider was available for this target, so deep analysis operations stay unavailable; artifact-only operations remain available.",
      ];
    case "bound":
      return [];
  }
};

/**
 * Retain one deterministic REA-owned record of a deep-provider selection.
 *
 * Objective candidate observations, the deterministic REA decision, and the
 * (absent) caller rationale are separate fields so a consumer never mistakes a
 * local configuration fact or a policy outcome for engine-derived analysis.
 * The record carries no analysis profile, so it can never become a snapshot
 * replay binding for provider-produced results.
 */
export const createProviderSelectionEvidence = (
  target: BinaryTarget,
  selection: AnalysisProviderSelection,
): Result<Evidence, AnalysisError> => {
  try {
    return ok(
      createEvidence(target, PROVIDER_SELECTION_PROVIDER, {
        predicateType: "rea.provider-selection",
        operation: "open_binary",
        parameters: { provider_id: selection.requestedProviderId },
        result: selectionObservation(selection),
        confidence: "derived",
        // This decision is REA's own provider policy applied to local
        // availability and the parsed target, not a read of the artifact's
        // contents. Leaving the default would claim `shipped-artifact`, which
        // static reconstruction treats as an artifact observation and which
        // unknown resolution accepts as static authority. `analyst-inference`
        // with `derived` confidence is this repository's class for a
        // REA-computed record that is not a raw observation.
        authority: "analyst-inference",
        limitations: [...SELECTION_LIMITATIONS, ...stateLimitation(selection)],
      }),
    );
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(
        "Provider selection Evidence could not be created from a validated selection",
        { cause },
      ),
    );
  }
};

const selectionObservation = (
  selection: AnalysisProviderSelection,
): JsonValue => ({
  selection_state: selection.selectionState,
  deterministic_rule: selectionRule(selection),
  selected_provider_id: selection.binding?.identity.id ?? null,
  selection_source: selection.binding?.selectionSource ?? null,
  eligible_provider_ids: selection.candidates
    .filter(({ eligibility }) => eligibility === "eligible")
    .map(({ provider }) => provider.id),
  candidates: selection.candidates.map(candidateObservation),
  // REA never infers the agent's private reasoning; an absent rationale stays
  // explicit rather than being reconstructed from the chosen provider.
  caller_rationale: null,
});

const candidateObservation = (
  candidate: AnalysisProviderCandidateStatus,
): JsonValue => ({
  provider_id: candidate.provider.id,
  provider_version: candidate.provider.version,
  availability: {
    status: candidate.availability.status,
    code: candidate.availability.code,
  },
  target_support: {
    status: candidate.targetSupport.status,
    code: candidate.targetSupport.code,
  },
  eligibility: candidate.eligibility,
  rejection: candidateRejection(candidate),
});

const candidateRejection = (
  candidate: AnalysisProviderCandidateStatus,
): JsonValue => {
  if (candidate.availability.status === "unavailable")
    return {
      code: candidate.availability.code,
      reason: candidate.availability.reason,
    };
  if (candidate.targetSupport.status === "unsupported")
    return {
      code: candidate.targetSupport.code,
      reason: candidate.targetSupport.reason,
    };
  return null;
};

const selectionRule = (
  selection: AnalysisProviderSelection,
): ProviderSelectionRule => {
  const source = selection.binding?.selectionSource;
  if (source === "request") return "explicit-provider";
  if (source === "environment") return "configured-preference";
  if (source === "auto-single-candidate") return "auto-single-candidate";
  if (selection.requestedProviderId !== "auto") return "configured-preference";
  return selection.selectionState === "selection_required"
    ? "auto-multiple-eligible"
    : "auto-none-eligible";
};
