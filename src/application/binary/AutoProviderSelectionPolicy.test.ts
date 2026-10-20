import { describe, expect, it } from "vitest";

import {
  decideAutoProviderSelection,
  type EligibleAnalysisProviderEvaluation,
} from "./AutoProviderSelectionPolicy.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import type { AnalysisProviderCandidate } from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisProviderCandidateEvaluation } from "./AnalysisProviderEvaluation.js";

const evaluation = (
  id: string,
  eligibility: AnalysisProviderCandidateStatus["eligibility"],
): AnalysisProviderCandidateEvaluation => ({
  candidate: candidate(id),
  status: {
    provider: { id, name: `${id} provider`, version: null },
    availability: {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {},
    },
    targetSupport: {
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    },
    selected: false,
    eligibility,
    capabilities: [],
  },
  ...(eligibility === "eligible"
    ? {
        profile: createAnalysisProfile(
          { id, name: `${id} provider`, version: "1" },
          { fixture: id },
        ),
      }
    : {}),
});

const candidate = (id: string): AnalysisProviderCandidate => ({
  identity: () => ({ id, name: `${id} provider`, version: null }),
  capabilities: () => [],
  inspectAvailability: () => ({
    status: "available",
    code: null,
    reason: null,
    diagnostics: {},
  }),
  inspectTargetSupport: () => ({
    status: "supported",
    code: null,
    reason: null,
    diagnostics: {},
  }),
  resolveAnalysisProfile: () => {
    throw new AnalysisCancelledError("open_binary");
  },
  createClient: () => {
    throw new Error("the policy must never create a client");
  },
});

const eligibleIds = (
  decision: ReturnType<typeof decideAutoProviderSelection>,
): readonly string[] =>
  decision.eligible.map(({ status }) => status.provider.id);

describe("automatic provider selection policy", () => {
  it("stays unbound when no candidate is eligible", () => {
    const decision = decideAutoProviderSelection([
      evaluation("alpha", "ineligible"),
      evaluation("beta", "unevaluated"),
    ]);
    expect(decision.state).toBe("unbound");
    expect(eligibleIds(decision)).toEqual([]);
  });

  it("stays unbound for an empty candidate set", () => {
    expect(decideAutoProviderSelection([])).toMatchObject({
      state: "unbound",
      eligible: [],
    });
  });

  it("binds the single eligible candidate", () => {
    const decision = decideAutoProviderSelection([
      evaluation("alpha", "ineligible"),
      evaluation("beta", "eligible"),
      evaluation("gamma", "unevaluated"),
    ]);
    expect(decision.state).toBe("bound");
    expect(eligibleIds(decision)).toEqual(["beta"]);
  });

  it("requires an explicit decision once two candidates are eligible", () => {
    const decision = decideAutoProviderSelection([
      evaluation("alpha", "eligible"),
      evaluation("beta", "eligible"),
      evaluation("gamma", "ineligible"),
    ]);
    expect(decision.state).toBe("selection_required");
    expect(eligibleIds(decision)).toEqual(["alpha", "beta"]);
  });

  it("requires an explicit decision for three or more eligible candidates", () => {
    const decision = decideAutoProviderSelection([
      evaluation("alpha", "eligible"),
      evaluation("beta", "eligible"),
      evaluation("gamma", "eligible"),
      evaluation("delta", "eligible"),
    ]);
    expect(decision.state).toBe("selection_required");
    expect(eligibleIds(decision)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("preserves the evaluated order regardless of candidate identity order", () => {
    const forward = decideAutoProviderSelection([
      evaluation("alpha", "eligible"),
      evaluation("beta", "eligible"),
    ]);
    const reversed = decideAutoProviderSelection([
      evaluation("beta", "eligible"),
      evaluation("alpha", "eligible"),
    ]);
    expect(forward.state).toBe(reversed.state);
    expect(eligibleIds(forward)).toEqual(["alpha", "beta"]);
    expect(eligibleIds(reversed)).toEqual(["beta", "alpha"]);
  });

  it("exposes only profile-resolved candidates as eligible", () => {
    const decision = decideAutoProviderSelection([
      evaluation("alpha", "eligible"),
      evaluation("beta", "eligible"),
      evaluation("gamma", "ineligible"),
    ]);
    for (const entry of decision.eligible)
      expect(entry.profile.provider.id).toBe(entry.status.provider.id);
    expect(
      decision.eligible satisfies readonly EligibleAnalysisProviderEvaluation[],
    ).toHaveLength(2);
  });
});
