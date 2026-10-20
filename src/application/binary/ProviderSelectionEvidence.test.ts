import { describe, expect, it } from "vitest";

import {
  createProviderSelectionEvidence,
  type ProviderSelectionRule,
} from "./ProviderSelectionEvidence.js";
import type {
  AnalysisProviderCandidateStatus,
  AnalysisProviderSelection,
} from "./AnalysisProviderRegistry.js";
import type { ProviderCandidateEligibility } from "./AutoProviderSelectionPolicy.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { workflowSnapshotRecord } from "../WorkflowEvidence.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture.bin",
  sha256: "c".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
};

const candidate = (
  id: string,
  eligibility: ProviderCandidateEligibility,
): AnalysisProviderCandidateStatus => ({
  provider: {
    id,
    name: `${id} provider`,
    version: eligibility === "eligible" ? "1" : null,
  },
  availability:
    eligibility === "ineligible"
      ? {
          status: "unavailable",
          code: "runtime_missing",
          reason: `${id} runtime is unavailable`,
          diagnostics: {},
        }
      : { status: "available", code: null, reason: null, diagnostics: {} },
  targetSupport: {
    status: "supported",
    code: null,
    reason: null,
    diagnostics: {},
  },
  selected: false,
  eligibility,
  capabilities: [],
});

const selection = (
  overrides: Partial<AnalysisProviderSelection> = {},
): AnalysisProviderSelection => ({
  requestedProviderId: "auto",
  binding: null,
  selectionState: "selection_required",
  candidates: [candidate("alpha", "eligible"), candidate("beta", "eligible")],
  ...overrides,
});

const boundSelection = (): AnalysisProviderSelection => {
  const [alpha] = selection().candidates;
  if (alpha === undefined) throw new Error("fixture");
  const selected: AnalysisProviderCandidateStatus = {
    ...alpha,
    selected: true,
  };
  return {
    requestedProviderId: "alpha",
    selectionState: "bound",
    binding: {
      provider: {
        identity: () => ({
          id: "alpha",
          name: "alpha provider",
          version: null,
        }),
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
        resolveAnalysisProfile: () => Promise.reject(new Error("fixture")),
        createClient: () => {
          throw new Error("fixture");
        },
      },
      identity: { id: "alpha", name: "alpha provider", version: "1" },
      selectionSource: "request",
      profile: createAnalysisProfile(
        { id: "alpha", name: "alpha provider", version: "1" },
        { fixture: "alpha" },
      ),
      capabilities: [],
    },
    candidates: [selected, candidate("beta", "unevaluated")],
  };
};

const observation = (value: AnalysisProviderSelection) => {
  const created = createProviderSelectionEvidence(TARGET, value);
  if (!created.ok) throw created.error;
  return created.value;
};

const rule = (value: AnalysisProviderSelection): ProviderSelectionRule => {
  const result = jsonObjectSchema.parse(
    observation(value).normalized_result,
  ).deterministic_rule;
  return result as ProviderSelectionRule;
};

describe("provider selection Evidence", () => {
  it("attributes the deterministic decision to REA rather than to an engine", () => {
    const evidence = observation(boundSelection());
    expect(evidence.provider).toEqual({
      id: "rea-provider-selection",
      name: "REA deep-provider selection policy",
      version: "1",
    });
    // A selection decision is not provider-produced analysis, so it never
    // carries an analysis profile or claims a snapshot replay binding.
    expect(evidence.analysis_profile).toBeNull();
    expect(
      workflowSnapshotRecord(evidence, "analyze_function"),
    ).toBeUndefined();
    expect(evidence.predicate_type).toBe("rea.provider-selection");
    expect(evidence.operation).toBe("open_binary");
    expect(evidence.confidence).toBe("derived");
    expect(evidence.parameters).toEqual({ provider_id: "alpha" });
  });

  it("never claims artifact authority for a REA provider decision", () => {
    for (const value of [
      boundSelection(),
      selection(),
      selection({
        requestedProviderId: "beta",
        selectionState: "unbound",
        candidates: [candidate("beta", "unevaluated")],
      }),
    ]) {
      const evidence = observation(value);
      // The decision reports REA's own provider policy over local availability
      // and the parsed target; it is not a read of the artifact's contents.
      // `shipped-artifact` is what static reconstruction and snapshot logic
      // treat as an artifact observation, so claiming it would misrepresent the
      // record as engine-derived evidence about the binary.
      expect(evidence.authority).not.toBe("shipped-artifact");
      expect(evidence.authority).toBe("analyst-inference");
      expect(evidence.confidence).toBe("derived");
      // The artifact-keyed consumers additionally require this predicate and a
      // concrete analysis profile, neither of which a decision record has.
      expect(evidence.predicate_type).not.toBe("rea.analysis");
      expect(evidence.analysis_profile).toBeNull();
    }
  });

  it("binds the observation to the validated target identity", () => {
    const evidence = observation(selection());
    expect(evidence.subject).toMatchObject({
      name: "fixture.bin",
      local_path: TARGET.path,
      digest: { sha256: TARGET.sha256 },
      format: "elf",
      architecture: "x86_64",
    });
  });

  it("separates candidate observations, the REA decision, and absent caller rationale", () => {
    const evidence = observation(selection());
    expect(evidence.normalized_result).toMatchObject({
      selection_state: "selection_required",
      deterministic_rule: "auto-multiple-eligible",
      selected_provider_id: null,
      selection_source: null,
      eligible_provider_ids: ["alpha", "beta"],
      candidates: [
        {
          provider_id: "alpha",
          provider_version: "1",
          availability: { status: "available", code: null },
          target_support: { status: "supported", code: null },
          eligibility: "eligible",
          rejection: null,
        },
        {
          provider_id: "beta",
          availability: { status: "available", code: null },
          eligibility: "eligible",
          rejection: null,
        },
      ],
      caller_rationale: null,
    });
  });

  it("retains the rejection that made a candidate ineligible", () => {
    const evidence = observation(
      selection({
        candidates: [
          candidate("alpha", "eligible"),
          candidate("beta", "eligible"),
          candidate("gamma", "ineligible"),
        ],
      }),
    );
    expect(evidence.normalized_result).toMatchObject({
      eligible_provider_ids: ["alpha", "beta"],
      candidates: [
        {},
        {},
        {
          provider_id: "gamma",
          eligibility: "ineligible",
          rejection: {
            code: "runtime_missing",
            reason: "gamma runtime is unavailable",
          },
        },
      ],
    });
  });

  it("reports the deterministic rule for each selection outcome", () => {
    expect(rule(boundSelection())).toBe("explicit-provider");
    expect(rule(selection())).toBe("auto-multiple-eligible");
    expect(
      rule(
        selection({
          selectionState: "unbound",
          candidates: [candidate("alpha", "ineligible")],
        }),
      ),
    ).toBe("auto-none-eligible");
    expect(
      rule(
        selection({
          requestedProviderId: "alpha",
          selectionState: "unbound",
          candidates: [candidate("alpha", "unevaluated")],
        }),
      ),
    ).toBe("configured-preference");
  });

  it("states the unresolved condition that the state represents", () => {
    const pending = observation(selection());
    expect(pending.limitations.join(" ")).toContain(
      "Reopen the target with an explicit provider_id",
    );
    const unbound = observation(
      selection({
        selectionState: "unbound",
        candidates: [candidate("alpha", "ineligible")],
      }),
    );
    expect(unbound.limitations.join(" ")).toContain(
      "No eligible deep analysis provider was available",
    );
    expect(pending.limitations.join(" ")).toContain(
      "does not establish analysis fidelity",
    );
  });

  it("produces identical identity for equivalent decisions and distinct identity otherwise", () => {
    expect(observation(selection()).evidence_id).toBe(
      observation(selection()).evidence_id,
    );
    expect(observation(selection()).evidence_id).not.toBe(
      observation(selection({ candidates: [candidate("alpha", "eligible")] }))
        .evidence_id,
    );
    expect(observation(selection()).evidence_id).not.toBe(
      observation(boundSelection()).evidence_id,
    );
  });
});
