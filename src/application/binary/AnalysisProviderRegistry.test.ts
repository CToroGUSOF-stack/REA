import { describe, expect, it } from "vitest";

import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";

const DATABASE_TARGET: BinaryTarget = {
  path: "/tmp/fixture.hop",
  sha256: "a".repeat(64),
  kind: "database",
  format: "analysis-database",
};
const ARTIFACT_TARGET: BinaryTarget = {
  path: "/tmp/app.asar",
  sha256: "b".repeat(64),
  kind: "archive",
  format: "asar",
};

it("rejects malformed provider capability declarations", () => {
  const alpha = candidate("alpha");
  expect(
    () => new AnalysisProviderRegistry([alpha.provider, alpha.provider]),
  ).toThrow(/Duplicate analysis provider ID: alpha/u);
  expect(
    () =>
      new AnalysisProviderRegistry([
        {
          ...alpha.provider,
          capabilities: () => {
            const descriptor = capability(alpha.provider.identity());
            return [descriptor, descriptor];
          },
        },
      ]),
  ).toThrow(/declares operation address_name more than once/u);
  expect(
    () =>
      new AnalysisProviderRegistry([
        {
          ...alpha.provider,
          capabilities: () => [
            capability({ ...alpha.provider.identity(), name: "forged" }),
          ],
        },
      ]),
  ).toThrow(/published mismatched capability provenance/u);
  expect(
    () => new AnalysisProviderRegistry([candidate("auto").provider]),
  ).toThrow(/Invalid analysis provider ID: auto/u);
});

it("uses one owner readiness snapshot for candidate availability and capabilities", async () => {
  const base = candidate("alpha").provider;
  let observed = 0;
  let capabilityReads = 0;
  const provider: AnalysisProviderCandidate = {
    ...base,
    inspectAvailability: () => {
      throw new Error("availability must come from the owner snapshot");
    },
    capabilities: () => {
      capabilityReads += 1;
      return [capability(base.identity())];
    },
    inspectReadinessSnapshot: () => {
      observed += 1;
      return {
        availability: {
          status: "unavailable",
          code: "runtime_unavailable",
          reason: "native inspection failed",
          diagnostics: { failure_stage: "self-test" },
        },
        capabilities: [capability(base.identity())],
      };
    },
  };

  const [status] = await new AnalysisProviderRegistry([provider]).candidates();
  expect(observed).toBe(1);
  expect(capabilityReads).toBe(1);
  expect(status).toMatchObject({
    availability: {
      status: "unavailable",
      code: "runtime_unavailable",
      diagnostics: { failure_stage: "self-test" },
    },
    capabilities: [{ operation: "address_name" }],
  });
});

it("selects the sole available provider and honors explicit selection precedence", async () => {
  const alpha = candidate("alpha");
  const beta = candidate("beta", { available: false });
  const sole = await new AnalysisProviderRegistry([
    beta.provider,
    alpha.provider,
  ]).select(DATABASE_TARGET);
  expect(sole).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "alpha" },
        selectionSource: "auto-single-candidate",
      },
    },
  });

  const selected = new AnalysisProviderRegistry(
    [alpha.provider, candidate("beta").provider],
    "beta",
  );
  expect(await selected.select(DATABASE_TARGET)).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "beta" },
        selectionSource: "environment",
      },
    },
  });
  expect(await selected.select(DATABASE_TARGET, "alpha")).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "alpha" },
        selectionSource: "request",
      },
    },
  });
});

describe("inspection without deep binding", () => {
  it("retains discovery facts without resolving a deep profile for covered automatic inspection", async () => {
    const alpha = candidate("alpha", { profile: "error" });
    const beta = candidate("beta", { profile: "error" });
    const registry = new AnalysisProviderRegistry(
      [alpha.provider, beta.provider],
      "auto",
      (target) => target === DATABASE_TARGET,
    );
    expect(await registry.select(DATABASE_TARGET)).toMatchObject({
      ok: true,
      value: {
        requestedProviderId: "auto",
        binding: null,
        candidates: [
          {
            provider: { id: "alpha" },
            selected: false,
            availability: { status: "available" },
          },
          {
            provider: { id: "beta" },
            selected: false,
            availability: { status: "available" },
          },
        ],
      },
    });
    expect(alpha.created).toEqual([]);
    expect(beta.created).toEqual([]);
  });

  it("keeps explicit request and environment choices even when auxiliary inspection covers the target", async () => {
    const alpha = candidate("alpha");
    const beta = candidate("beta");
    const registry = new AnalysisProviderRegistry(
      [alpha.provider, beta.provider],
      "beta",
      () => true,
    );
    expect(await registry.select(DATABASE_TARGET)).toMatchObject({
      ok: true,
      value: {
        binding: { identity: { id: "beta" }, selectionSource: "environment" },
      },
    });
    expect(await registry.select(DATABASE_TARGET, "alpha")).toMatchObject({
      ok: true,
      value: {
        binding: { identity: { id: "alpha" }, selectionSource: "request" },
      },
    });
    expect(await registry.select(DATABASE_TARGET, "auto")).toMatchObject({
      ok: true,
      value: { binding: null },
    });
    expect(await registry.select(DATABASE_TARGET, "missing")).toMatchObject({
      ok: false,
      error: { reason: "unknown_provider" },
    });
  });

  it("reports a selection-required state when auxiliary inspection does not cover the target", async () => {
    const registry = new AnalysisProviderRegistry(
      [candidate("alpha").provider, candidate("beta").provider],
      "auto",
      () => false,
    );
    // Two eligible providers: the target is admitted without a binding and the
    // tie is reported as a pending choice rather than rejected as ambiguity.
    expect(await registry.select(DATABASE_TARGET)).toMatchObject({
      ok: true,
      value: {
        selectionState: "selection_required",
        binding: null,
        requestedProviderId: "auto",
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await registry.select(DATABASE_TARGET, undefined, {
        signal: controller.signal,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  });
});

describe("analysis provider registry: selection failures", () => {
  it("returns actionable unknown, unavailable, and unsupported failures", async () => {
    const unavailable = candidate("alpha", { available: false });
    const registry = new AnalysisProviderRegistry([unavailable.provider]);

    const unknown = await registry.select(DATABASE_TARGET, "missing");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(projectAnalysisError(unknown.error)).toMatchObject({
        details: {
          selection_reason: "unknown_provider",
          requested_provider_id: "missing",
          candidate_ids: ["alpha"],
        },
      });

    const rejected = await registry.select(DATABASE_TARGET, "alpha");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(projectAnalysisError(rejected.error)).toMatchObject({
        code: "provider_unavailable",
        details: {
          rejections: [
            {
              provider_id: "alpha",
              code: "runtime_missing",
              diagnostics: { executable_path: "/opt/alpha/bin/analyze" },
            },
          ],
        },
      });

    const unsupported = await new AnalysisProviderRegistry([
      candidate("alpha", { available: false }).provider,
    ]).select(ARTIFACT_TARGET, "alpha");
    if (unsupported.ok)
      throw new Error("expected unsupported target rejection");
    expect(unsupported.error).toBeInstanceOf(ProviderSelectionError);
    if (
      !unsupported.ok &&
      unsupported.error instanceof ProviderSelectionError
    ) {
      expect(unsupported.error).toMatchObject({
        reason: "target_unsupported",
      });
      expect(unsupported.error.rejections.map(({ code }) => code)).toEqual([
        "runtime_missing",
        "target_kind_unsupported",
      ]);
    }
  });

  it("keeps artifact-only targets unbound under auto or environment preference", async () => {
    const alpha = candidate("alpha");
    const environment = new AnalysisProviderRegistry([alpha.provider], "alpha");
    const automatic = new AnalysisProviderRegistry([alpha.provider]);

    for (const registry of [environment, automatic]) {
      const selected = await registry.select(ARTIFACT_TARGET);
      expect(selected).toMatchObject({
        ok: true,
        value: {
          binding: null,
          candidates: [
            {
              selected: false,
              targetSupport: {
                status: "unsupported",
                code: "target_kind_unsupported",
              },
            },
          ],
        },
      });
    }
    const explicit = await automatic.select(ARTIFACT_TARGET, "alpha");
    if (explicit.ok) throw new Error("expected provider selection rejection");
    expect(explicit.error).toBeInstanceOf(ProviderSelectionError);
    if (explicit.error instanceof ProviderSelectionError)
      expect(explicit.error.reason).toBe("target_unsupported");
  });

  it("rejects an unknown environment preference even when every candidate rejects the target", async () => {
    const alpha = candidate("alpha");
    const misconfigured = new AnalysisProviderRegistry(
      [alpha.provider],
      "missing",
    );

    for (const selected of [
      await misconfigured.select(ARTIFACT_TARGET),
      await misconfigured.select(ARTIFACT_TARGET, "missing"),
    ]) {
      if (selected.ok) throw new Error("expected unknown provider rejection");
      expect(projectAnalysisError(selected.error)).toMatchObject({
        details: {
          selection_reason: "unknown_provider",
          requested_provider_id: "missing",
          candidate_ids: ["alpha"],
        },
      });
    }
  });
});

describe("analysis provider registry: profile and cleanup failures", () => {
  it("does not bind a profile with unresolved version or adapter failure", async () => {
    const unresolved = candidate("unresolved", { profile: "missing" });
    const failed = candidate("failed", { profile: "error" });

    const automatic = await new AnalysisProviderRegistry([
      unresolved.provider,
    ]).select(DATABASE_TARGET);
    expect(automatic).toMatchObject({
      ok: true,
      value: {
        binding: null,
        candidates: [
          {
            availability: {
              status: "unavailable",
              code: "version_unresolved",
            },
          },
        ],
      },
    });

    const explicit = await new AnalysisProviderRegistry([
      failed.provider,
    ]).select(DATABASE_TARGET, "failed");
    if (explicit.ok) throw new Error("expected provider selection rejection");
    expect(explicit.error).toMatchObject({
      _tag: "ProviderAdapterError",
      providerId: "failed",
    });
  });

  it("aborts automatic selection when a provider reports unconfirmed cleanup", async () => {
    const ghidra = candidate("ghidra");
    const alternate = candidate("hopper");
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["/opt/ghidra/data/languages/x86.ldefs"],
      { reason: "descriptor close failed" },
      { operation: "resolve_analysis_profile" },
    );
    const provider: AnalysisProviderCandidate = {
      ...ghidra.provider,
      resolveAnalysisProfile: () => Promise.resolve(err(cleanupFailure)),
    };

    const selected = await new AnalysisProviderRegistry([
      alternate.provider,
      provider,
    ]).select(DATABASE_TARGET);

    expect(selected).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        providerId: "ghidra",
        cleanupIncomplete: true,
      },
    });
    expect(alternate.created).toEqual([]);
  });

  it("owns a signal-ignoring profile probe until final completion and joins shutdown", async () => {
    const alpha = candidate("alpha");
    let observedSignal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ignoresCancellation: AnalysisProviderCandidate = {
      ...alpha.provider,
      resolveAnalysisProfile: async (target, options) => {
        observedSignal = options?.signal;
        started?.();
        await gate;
        return alpha.provider.resolveAnalysisProfile(target);
      },
    };
    const registry = new AnalysisProviderRegistry([ignoresCancellation]);
    const controller = new AbortController();
    const reason = { caller: "profile finalization" };
    let selected = false;
    const selecting = registry
      .select(DATABASE_TARGET, "alpha", { signal: controller.signal })
      .then((result) => {
        selected = true;
        return result;
      });
    await pending;
    controller.abort(reason);
    let closed = false;
    const closing = registry.closeOwnedResources().then((result) => {
      closed = true;
      return result;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(selected).toBe(false);
      expect(closed).toBe(false);
      expect(registry.hasPendingOwnedResources()).toBe(true);
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBe(reason);
      finish?.();
      const result = await selecting;
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", cause: reason },
      });
      expect(await closing).toEqual(ok(null));
      expect(registry.hasPendingOwnedResources()).toBe(false);
      expect(alpha.created).toEqual([]);
    } finally {
      finish?.();
      await Promise.all([selecting, closing]);
    }
  });
});

describe("analysis provider registry: agent-driven selection", () => {
  it("admits a target for explicit selection when two providers are eligible", async () => {
    // Registration order must not affect the admitted state or the reporting.
    for (const providers of [
      [candidate("beta"), candidate("alpha")],
      [candidate("alpha"), candidate("beta")],
    ]) {
      const registry = new AnalysisProviderRegistry(
        providers.map(({ provider }) => provider),
      );
      const selected = await registry.select(DATABASE_TARGET);
      expect(selected).toMatchObject({
        ok: true,
        value: {
          requestedProviderId: "auto",
          binding: null,
          selectionState: "selection_required",
          candidates: [
            {
              provider: { id: "alpha" },
              eligibility: "eligible",
              selected: false,
            },
            {
              provider: { id: "beta" },
              eligibility: "eligible",
              selected: false,
            },
          ],
        },
      });
      for (const { created } of providers) expect(created).toEqual([]);
    }
  });

  it("treats three eligible candidates as selection-required with stable ordering", async () => {
    const registry = new AnalysisProviderRegistry(
      ["gamma", "alpha", "beta"].map((id) => candidate(id).provider),
    );
    const selected = await registry.select(DATABASE_TARGET);
    if (!selected.ok) throw selected.error;
    expect(selected.value.selectionState).toBe("selection_required");
    expect(selected.value.binding).toBeNull();
    expect(
      selected.value.candidates.map(({ provider }) => provider.id),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      selected.value.candidates.map(({ eligibility }) => eligibility),
    ).toEqual(["eligible", "eligible", "eligible"]);
  });

  it("keeps an available but target-incompatible provider unbound", async () => {
    const alpha = candidate("alpha");
    const registry = new AnalysisProviderRegistry([alpha.provider]);
    const selected = await registry.select(ARTIFACT_TARGET);
    if (!selected.ok) throw selected.error;
    expect(selected.value).toMatchObject({
      selectionState: "unbound",
      binding: null,
      candidates: [
        {
          eligibility: "ineligible",
          targetSupport: {
            status: "unsupported",
            code: "target_kind_unsupported",
          },
        },
      ],
    });
    expect(alpha.created).toEqual([]);

    const operation = registry.unboundOperationError(
      "address_name",
      selected.value,
    );
    expect(operation).toMatchObject({
      reason: "target_unsupported",
      operation: "address_name",
      candidateIds: ["alpha"],
    });
  });

  it("keeps unavailable and unresolvable providers unbound and ineligible", async () => {
    const unavailable = candidate("alpha", { available: false });
    const unresolved = candidate("beta", { profile: "missing" });
    const invalid = candidate("gamma", { profile: "error" });
    const registry = new AnalysisProviderRegistry([
      unavailable.provider,
      unresolved.provider,
      invalid.provider,
    ]);

    const selected = await registry.select(DATABASE_TARGET);
    if (!selected.ok) throw selected.error;
    expect(selected.value.selectionState).toBe("unbound");
    expect(selected.value.binding).toBeNull();
    expect(
      selected.value.candidates.map(({ provider, eligibility }) => ({
        id: provider.id,
        eligibility,
      })),
    ).toEqual([
      { id: "alpha", eligibility: "ineligible" },
      { id: "beta", eligibility: "ineligible" },
      { id: "gamma", eligibility: "ineligible" },
    ]);
    expect(
      selected.value.candidates.map(({ availability }) => availability.code),
    ).toEqual(["runtime_missing", "version_unresolved", "version_unresolved"]);
    for (const fixture of [unavailable, unresolved, invalid])
      expect(fixture.created).toEqual([]);

    // A prerequisite or profile failure is not the same as awaiting a choice.
    expect(
      registry.unboundOperationError("address_name", selected.value),
    ).toMatchObject({ reason: "provider_unavailable" });
  });

  it("reports ambiguous only at the operation boundary before a choice", async () => {
    const registry = new AnalysisProviderRegistry([
      candidate("alpha").provider,
      candidate("beta").provider,
    ]);
    const selected = await registry.select(DATABASE_TARGET);
    if (!selected.ok) throw selected.error;

    const operation = registry.unboundOperationError(
      "address_name",
      selected.value,
    );
    expect(operation).toMatchObject({
      _tag: "ProviderSelectionError",
      reason: "ambiguous",
      requestedProviderId: "auto",
      operation: "address_name",
      candidateIds: ["alpha", "beta"],
    });
    expect(operation.userMessage).toContain("Choose one with provider_id");
  });
});

describe("analysis provider registry: selection precedence", () => {
  it("keeps explicit and configured preferences ahead of automatic selection", async () => {
    const registry = new AnalysisProviderRegistry(
      [candidate("alpha").provider, candidate("beta").provider],
      "beta",
    );

    // An explicit concrete request wins over the configured preference.
    expect(await registry.select(DATABASE_TARGET, "alpha")).toMatchObject({
      ok: true,
      value: {
        selectionState: "bound",
        binding: {
          identity: { id: "alpha" },
          selectionSource: "request",
        },
      },
    });
    // The configured preference wins when the request omits a selector.
    expect(await registry.select(DATABASE_TARGET)).toMatchObject({
      ok: true,
      value: {
        selectionState: "bound",
        binding: {
          identity: { id: "beta" },
          selectionSource: "environment",
        },
      },
    });
    // An explicit `auto` still asks REA to decide, so it reports the tie.
    expect(await registry.select(DATABASE_TARGET, "auto")).toMatchObject({
      ok: true,
      value: {
        selectionState: "selection_required",
        binding: null,
        requestedProviderId: "auto",
      },
    });
  });

  it("cancels automatic evaluation before admitting a selection-required target", async () => {
    const alpha = candidate("alpha");
    const controller = new AbortController();
    const beta = candidate("beta");
    const interrupting: AnalysisProviderCandidate = {
      ...beta.provider,
      resolveAnalysisProfile: (target, options) => {
        controller.abort();
        return beta.provider.resolveAnalysisProfile(target, options);
      },
    };
    const selected = await new AnalysisProviderRegistry([
      alpha.provider,
      interrupting,
    ]).select(DATABASE_TARGET, undefined, { signal: controller.signal });

    expect(selected).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
    expect(alpha.created).toEqual([]);
    expect(beta.created).toEqual([]);
  });

  it("rejects unknown and unsupported explicit providers without fallback", async () => {
    const registry = new AnalysisProviderRegistry([
      candidate("alpha").provider,
      candidate("beta").provider,
    ]);
    const unknown = await registry.select(DATABASE_TARGET, "missing");
    expect(unknown).toMatchObject({
      ok: false,
      error: { reason: "unknown_provider", operation: "open_binary" },
    });
    const unsupported = await registry.select(ARTIFACT_TARGET, "alpha");
    expect(unsupported).toMatchObject({
      ok: false,
      error: { reason: "target_unsupported", operation: "open_binary" },
    });
  });
});

interface CandidateFixture {
  readonly provider: AnalysisProviderCandidate;
  readonly created: string[];
}

const candidate = (
  id: string,
  options: {
    readonly available?: boolean;
    readonly profile?: "resolved" | "missing" | "error";
  } = {},
): CandidateFixture => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  const created: string[] = [];
  const available = options.available ?? true;
  const provider: AnalysisProviderCandidate = {
    identity: () => identity,
    capabilities: () => [capability(identity)],
    inspectAvailability: (): ProviderAvailability =>
      available
        ? {
            status: "available",
            code: null,
            reason: null,
            diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
          }
        : {
            status: "unavailable",
            code: "runtime_missing",
            reason: `${id} runtime is unavailable`,
            diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
          },
    inspectTargetSupport: (target): ProviderTargetSupport =>
      target.kind === "database"
        ? {
            status: "supported",
            code: null,
            reason: null,
            diagnostics: { target_kind: target.kind },
          }
        : {
            status: "unsupported",
            code: "target_kind_unsupported",
            reason: `${id} only accepts analysis databases in this fixture`,
            diagnostics: { target_kind: target.kind },
          },
    resolveAnalysisProfile: () => {
      if (options.profile === "error")
        return Promise.resolve(
          err(new ProviderAdapterError(id, "resolve_analysis_profile")),
        );
      return Promise.resolve(
        ok({
          profile:
            options.profile === "missing"
              ? null
              : createAnalysisProfile(
                  { id, name: identity.name, version: "1" },
                  { fixture: id },
                ),
        }),
      );
    },
    createClient: (_target, profile): AnalysisClient => {
      created.push(id);
      const executionIdentity = profile?.provider ?? identity;
      return {
        execute: (operation) =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                operation === "health" ? null : `${id}:${operation}`,
                executionIdentity,
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      };
    },
  };
  return { provider, created };
};

const capability = (provider: ProviderIdentity): CapabilityDescriptor => ({
  provider,
  operation: "address_name",
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

describe("profile resolution terminal facts", () => {
  it.each([false, true])(
    "preserves a physical profile failure across late caller abort (throws: %s)",
    async (throws) => {
      const alpha = candidate("alpha");
      const controller = new AbortController();
      const primary = new ProviderAdapterError(
        "alpha",
        "resolve_analysis_profile",
        { cause: new Error("physical profile failure") },
      );
      const registry = new AnalysisProviderRegistry([
        {
          ...alpha.provider,
          resolveAnalysisProfile: async () => {
            controller.abort({ caller: "after physical failure" });
            if (throws) throw primary;
            return err(primary);
          },
        },
      ]);
      const result = await registry.select(DATABASE_TARGET, "alpha", {
        signal: controller.signal,
      });
      expect(result).toEqual(err(primary));
      expect(registry.hasPendingOwnedResources()).toBe(false);
      expect(await registry.closeOwnedResources()).toEqual(ok(null));
    },
  );

  it("preserves exact cancellation with cleanup and blocks admission until its owner confirms release", async () => {
    const alpha = candidate("alpha");
    const controller = new AbortController();
    const reason = { caller: "final cleanup" };
    const primary = new AnalysisCancelledError("resolve_analysis_profile", {
      cause: reason,
      cleanup: { reason: "file close rejected", resources: ["profile-file"] },
    });
    let attempts = 0;
    let allowClose = false;
    const registry = new AnalysisProviderRegistry([
      {
        ...alpha.provider,
        resolveAnalysisProfile: async () => {
          attempts++;
          controller.abort(reason);
          return err(primary);
        },
        closeOwnedResources: async () => {
          if (!allowClose) return err(primary);
          primary.resolveCleanup();
          return ok(null);
        },
      },
    ]);
    const result = await registry.select(DATABASE_TARGET, "alpha", {
      signal: controller.signal,
    });
    expect(result).toEqual(err(primary));
    expect(primary.cause).toBe(reason);
    expect(registry.hasPendingOwnedResources()).toBe(true);
    expect(await registry.select(DATABASE_TARGET, "alpha")).toEqual(
      err(primary),
    );
    expect(attempts).toBe(1);
    allowClose = true;
    expect(await registry.closeOwnedResources()).toEqual(ok(null));
    expect(primary.cleanupIncomplete).toBe(false);
    expect(registry.hasPendingOwnedResources()).toBe(false);
  });
});

describe("automatic profile cleanup ownership", () => {
  it.each(["alpha", "beta"])(
    "keeps automatic mixed-child cleanup conjunctive when %s releases first",
    async (first) => {
      const alpha = candidate("alpha");
      const beta = candidate("beta");
      const controller = new AbortController();
      const reason = { caller: "mixed profile finalization" };
      const failures = {
        alpha: new AnalysisCancelledError("resolve_analysis_profile", {
          cause: reason,
          cleanup: { reason: "alpha descriptor", resources: ["alpha-file"] },
        }),
        beta: new ProviderCleanupError("beta", ["beta-file"], {
          reason: "beta descriptor",
        }),
      };
      let entered = 0;
      let admitChildren: (() => void) | undefined;
      const admitted = new Promise<void>((resolve) => {
        admitChildren = resolve;
      });
      const released = new Set<string>();
      const registry = new AnalysisProviderRegistry(
        [alpha, beta].map((fixture) => {
          const id = fixture.provider.identity().id as "alpha" | "beta";
          return {
            ...fixture.provider,
            resolveAnalysisProfile: async () => {
              entered++;
              if (entered === 2) {
                controller.abort(reason);
                admitChildren?.();
              }
              await admitted;
              return err(failures[id]);
            },
            closeOwnedResources: async () => {
              if (!released.has(id)) return err(failures[id]);
              failures[id].resolveCleanup();
              return ok(null);
            },
          };
        }),
      );
      const result = await registry.select(DATABASE_TARGET, "auto", {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Mixed failed profiles admitted");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual([
        "alpha-file",
        "beta-file",
      ]);
      expect(result.error.diagnostics?.profile_errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider_id: "alpha" }),
          expect.objectContaining({ provider_id: "beta" }),
        ]),
      );
      const close1 = await registry.closeOwnedResources();
      expect(close1.ok).toBe(false);
      released.add(first);
      const close2 = await registry.closeOwnedResources();
      expect(close2.ok).toBe(false);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual([
        first === "alpha" ? "beta-file" : "alpha-file",
      ]);
      expect(close1.ok ? [] : close1.error.cleanupResources).toEqual([
        first === "alpha" ? "beta-file" : "alpha-file",
      ]);
      released.add(first === "alpha" ? "beta" : "alpha");
      expect(await registry.closeOwnedResources()).toEqual(ok(null));
      expect(result.error.cleanupIncomplete).toBe(false);
      if (close1.ok || close2.ok)
        throw new Error("Cleanup unexpectedly succeeded");
      expect(close1.error.cleanupIncomplete).toBe(false);
      expect(close2.error.cleanupIncomplete).toBe(false);
      expect(registry.hasPendingOwnedResources()).toBe(false);
    },
  );
});

it("registers before production and gates fresh selections until shutdown has joined finalization", async () => {
  const alpha = candidate("alpha");
  let calls = 0;
  let enter: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const registry = new AnalysisProviderRegistry([
    {
      ...alpha.provider,
      resolveAnalysisProfile: async (target) => {
        calls++;
        if (calls === 1) {
          enter?.();
          await gate;
        }
        return alpha.provider.resolveAnalysisProfile(target);
      },
    },
  ]);
  const selecting = registry.select(DATABASE_TARGET, "alpha");
  await entered;
  const closing = registry.closeOwnedResources();
  const next = registry.select(DATABASE_TARGET, "alpha");
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(registry.hasPendingOwnedResources()).toBe(true);
    finish?.();
    expect(await selecting).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await closing).toEqual(ok(null));
    expect((await next).ok).toBe(true);
    expect(calls).toBe(2);
    expect(registry.hasPendingOwnedResources()).toBe(false);
  } finally {
    finish?.();
    await Promise.all([selecting, closing, next]);
    await registry.closeOwnedResources();
  }
});

it("joins cancelled readiness finalization and shutdown before admitting another observation", async () => {
  const base = candidate("alpha").provider;
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let observed: AbortSignal | undefined;
  const registry = new AnalysisProviderRegistry([
    {
      ...base,
      inspectAvailability: async ({ signal } = {}) => {
        calls++;
        if (calls === 1) {
          observed = signal;
          enter();
          await gate;
        }
        return base.inspectAvailability();
      },
    },
  ]);
  const controller = new AbortController();
  const reason = { request: "opaque readiness cancellation" };
  let settled = false;
  const observing = registry
    .candidates(undefined, { signal: controller.signal })
    .catch((cause) => {
      settled = true;
      return cause;
    });
  await entered;
  controller.abort(reason);
  let closed = false;
  const closing = registry.closeOwnedResources().then((value) => {
    closed = true;
    return value;
  });
  const next = registry.candidates();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    expect(calls).toBe(1);
    expect(observed?.reason).toBe(reason);
    expect(registry.hasPendingOwnedResources()).toBe(true);
    finish();
    const failure = await observing;
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure.cause).toBe(reason);
    expect(await closing).toEqual(ok(null));
    expect(await next).toMatchObject([
      {
        availability: {
          status: "unknown",
          diagnostics: { finalization: "in_progress" },
        },
      },
    ]);
    expect(await registry.candidates()).toHaveLength(1);
    expect(calls).toBe(2);
    expect(registry.hasPendingOwnedResources()).toBe(false);
  } finally {
    finish();
    await Promise.allSettled([observing, closing, next]);
    await registry.closeOwnedResources();
  }
});

it("joins every candidate and retains physical failure with exact mixed cleanup owners", async () => {
  const alpha = candidate("alpha").provider;
  const beta = candidate("beta").provider;
  const gamma = candidate("gamma").provider;
  let finish!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const physical = new ProviderAdapterError("alpha", "binary_session", {
    diagnostics: { reason: "physical observation failed" },
  });
  const cleanup = new ProviderCleanupError(
    "beta",
    ["beta retained prerequisite"],
    { reason: "controlled cleanup refusal" },
  );
  let releases = 0;
  const registry = new AnalysisProviderRegistry([
    {
      ...alpha,
      inspectAvailability: async () => {
        throw physical;
      },
    },
    {
      ...beta,
      inspectAvailability: async () => {
        enter();
        await gate;
        throw cleanup;
      },
      closeOwnedResources: async () => {
        releases++;
        cleanup.resolveCleanup();
        return ok(null);
      },
    },
    gamma,
  ]);
  let settled = false;
  const observing = registry.candidates().catch((cause) => {
    settled = true;
    return cause;
  });
  await entered;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    const failure = await observing;
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toContain("beta retained prerequisite");
    expect(failure.diagnostics).toMatchObject({
      readiness_candidates: [
        { provider: { id: "gamma" }, availability: { status: "available" } },
      ],
    });
    expect(failure.cleanupPrimary).toBe(physical);
    expect(projectAnalysisError(failure).details).toMatchObject({
      diagnostics: {
        readiness_errors: expect.arrayContaining([
          {
            provider_id: "alpha",
            error: expect.objectContaining({ code: "execution_failure" }),
          },
          {
            provider_id: "beta",
            error: expect.objectContaining({ code: "cleanup_incomplete" }),
          },
        ]),
      },
    });
    expect(registry.hasPendingOwnedResources()).toBe(true);
    expect(await registry.closeOwnedResources()).toEqual(ok(null));
    expect(releases).toBe(1);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "execution_failure",
      details: { diagnostics: { reason: "physical observation failed" } },
    });
    expect(registry.hasPendingOwnedResources()).toBe(false);
  } finally {
    finish();
    await observing;
    await registry.closeOwnedResources();
  }
});

it("registers selection before async readiness can race shutdown", async () => {
  let calls = 0;
  let observed: AbortSignal | undefined;
  const base = candidate("alpha").provider;
  const registry = new AnalysisProviderRegistry([
    {
      ...base,
      inspectAvailability: async ({ signal } = {}) => {
        calls++;
        observed = signal;
        return base.inspectAvailability();
      },
    },
  ]);
  const selecting = registry.select(DATABASE_TARGET, "alpha");
  const closing = registry.closeOwnedResources();
  const [selected, closed] = await Promise.all([selecting, closing]);
  expect(selected).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(closed).toEqual(ok(null));
  expect(calls).toBe(1);
  expect(observed?.aborted).toBe(true);
  expect((await registry.select(DATABASE_TARGET, "alpha")).ok).toBe(true);
  expect(calls).toBe(2);
  expect(registry.hasPendingOwnedResources()).toBe(false);
});
