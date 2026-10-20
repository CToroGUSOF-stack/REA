import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { SessionProviderRouter } from "../../../src/application/binary/SessionProviderRouter.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { err, ok } from "../../../src/domain/result.js";

type DeclaredOperation = Exclude<AnalysisOperation, "health">;

describe("target-bound provider routing", () => {
  it("rejects provider identity and operation-family collisions at composition", () => {
    const alpha = deepProvider("alpha");
    const registry = new AnalysisProviderRegistry([alpha.provider]);
    expect(() =>
      SessionProviderRouter.selectable(registry, [auxiliaryProvider("alpha")]),
    ).toThrow(/Duplicate configured provider ID: alpha/u);
    expect(() =>
      SessionProviderRouter.selectable(registry, [
        auxiliaryProvider("auxiliary", "address_name"),
      ]),
    ).toThrow(
      /Deep and auxiliary providers both declare operation address_name/u,
    );
  });

  it("admits a multi-candidate target without binding or starting an engine", async () => {
    const { session, target, alpha, beta } = await overlappingSession();

    // Two eligible providers: the target is admitted without binding or
    // starting an arbitrary engine, and the decision is reported instead.
    expect((await session.open(target)).ok).toBe(true);
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);
    expect(alpha.profileResolutions).toBe(1);
    expect(beta.profileResolutions).toBe(1);
    expect(session.activeTarget()?.path).toBe(target);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
      analysis_provider_candidates: [
        { provider: { id: "alpha" }, eligibility: "eligible", selected: false },
        { provider: { id: "beta" }, eligibility: "eligible", selected: false },
      ],
    });

    // A deep operation before the caller decides stays typed and actionable.
    const undecided = await session.execute("address_name", {
      address: "0x1",
    });
    expect(undecided.ok).toBe(false);
    if (!undecided.ok)
      expect(undecided.error).toMatchObject({
        _tag: "ProviderSelectionError",
        reason: "ambiguous",
        requestedProviderId: "auto",
        operation: "address_name",
      });
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);

    // Disjoint auxiliary families keep working on a selection-required target.
    const auxiliaryResult = await session.execute("inspect_macho", {});
    expect(auxiliaryResult.ok && auxiliaryResult.value.provider.id).toBe(
      "auxiliary",
    );
    await session.close();
  });

  it("binds an explicitly chosen provider and preserves its provenance", async () => {
    const { session, target, alpha, beta } = await overlappingSession();
    expect((await session.open(target)).ok).toBe(true);

    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "bound",
      analysis_provider_binding: {
        provider: { id: "alpha", version: "1" },
        selection_source: "request",
      },
      analysis_provider_candidates: [
        { provider: { id: "alpha" }, eligibility: "eligible", selected: true },
        {
          provider: { id: "beta" },
          eligibility: "unevaluated",
          selected: false,
        },
      ],
    });
    expect(alpha.clients).toHaveLength(0);

    const observed = await session.execute("address_name", { address: "0x1" });
    expect(observed.ok).toBe(true);
    if (observed.ok)
      expect(observed.value).toMatchObject({
        provider: { id: "alpha", version: "1" },
        analysisProfile: { provider: { id: "alpha", version: "1" } },
        result: "alpha:address_name",
        subject: {
          sha256: expect.any(String),
          path: target,
          format: "analysis-database",
        },
      });
    expect(alpha.clients).toHaveLength(1);
    expect(beta.clients).toHaveLength(0);

    // Reopening the same target and profile retains the live client.
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.closed).toBe(false);

    const auxiliaryBound = await session.execute("inspect_macho", {});
    expect(auxiliaryBound.ok && auxiliaryBound.value.provider.id).toBe(
      "auxiliary",
    );
    await session.close();
  });

  it("rejects unknown choices and never falls back after a runtime failure", async () => {
    const { session, target, alpha, beta } = await overlappingSession();
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);

    // A later auto request keeps the bound provider when no alternative is
    // eligible, and an unknown choice never disturbs the active binding.
    alpha.available = false;
    expect((await session.open(target)).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    const unknown = await session.open(target, { providerId: "missing" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.error).toMatchObject({ reason: "unknown_provider" });
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    expect((await session.open(target, { providerId: "beta" })).ok).toBe(true);
    // alpha was bound but never asked to analyze, so it has no client to retire.
    expect(alpha.clients).toHaveLength(0);
    beta.fail = true;
    const failed = await session.execute("address_name", { address: "0x2" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    expect(alpha.clients).toHaveLength(0);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });

    await session.close();
    expect(beta.clients[0]?.closed).toBe(true);
  });

  it("never falls back to a provider that already ran after a runtime failure", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const session = selectableSession([beta.provider, alpha.provider]);

    // The first provider actually runs, so a fallback would be observable here.
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect((await session.execute("address_name", { address: "0x1" })).ok).toBe(
      true,
    );
    expect(alpha.clients[0]?.calls).toEqual(["address_name"]);

    expect((await session.open(target, { providerId: "beta" })).ok).toBe(true);
    expect(alpha.clients[0]?.closed).toBe(true);
    beta.fail = true;
    const failed = await session.execute("address_name", { address: "0x2" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    // The failure stays with the selected provider: the retired provider is not
    // restarted and no provider is silently substituted.
    expect(alpha.clients[0]?.calls).toEqual(["address_name"]);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });

    await session.close();
    expect(beta.clients[0]?.closed).toBe(true);
  });
});

describe("target-bound provider routing transitions", () => {
  it("preserves bundle-root identity for artifact inventory operations", async () => {
    const target = await databaseTarget();
    const analysis = deepProvider("alpha");
    const artifact = auxiliaryProvider("artifact", "inventory_artifact");
    const session = selectableSession([analysis.provider], artifact);

    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    const result = await session.execute("inventory_artifact", {});
    if (!result.ok) throw result.error;

    expect(result).toMatchObject({
      ok: true,
      value: {
        subject: {
          path: target,
          sha256: "f".repeat(64),
          format: "directory",
        },
      },
    });
  });

  it("preserves the active client when a provider switch is cancelled while draining", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const pending = deferred<ReturnType<typeof successfulExecution>>();
    alpha.pending = pending.promise;
    const session = selectableSession([alpha.provider, beta.provider]);
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    const running = session.execute("address_name", { address: "0x1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    const switching = session.open(target, {
      providerId: "beta",
      signal: controller.signal,
    });
    while (beta.profileResolutions === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    pending.resolve(successfulExecution("alpha"));

    expect(await running).toMatchObject({ ok: true });
    const cancelled = await switching;
    expect(cancelled).toEqual({
      ok: false,
      error: new AnalysisCancelledError("open_binary"),
    });
    expect(alpha.clients[0]?.closed).toBe(false);
    expect(beta.clients).toHaveLength(0);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    alpha.pending = undefined;
    const retained = await session.execute("address_name", { address: "0x2" });
    expect(retained.ok && retained.value.provider.id).toBe("alpha");
    expect(alpha.clients).toHaveLength(1);
    await session.close();
    expect(alpha.clients[0]?.closed).toBe(true);
  });
});

describe("selection-required session lifecycle", () => {
  it("retains one selection record per distinct decision and never duplicates it", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const session = selectableSession([alpha.provider, beta.provider]);

    expect((await session.open(target)).ok).toBe(true);
    const pending = selectionRecords(session);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      predicate_type: "rea.provider-selection",
      operation: "open_binary",
      confidence: "derived",
      provider: { id: "rea-provider-selection" },
      analysis_profile: null,
      parameters: { provider_id: "auto" },
      normalized_result: {
        selection_state: "selection_required",
        deterministic_rule: "auto-multiple-eligible",
        selected_provider_id: null,
        selection_source: null,
        eligible_provider_ids: ["alpha", "beta"],
        caller_rationale: null,
      },
    });
    expect(pending[0]?.subject).toMatchObject({
      digest: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      format: "analysis-database",
    });

    // Reopening the same target without a selector keeps the retained route,
    // so the equivalent decision is not recorded again.
    expect((await session.open(target)).ok).toBe(true);
    expect(selectionRecords(session)).toHaveLength(1);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "selection_required",
    });
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);

    // Choosing a provider records the new, different decision.
    expect((await session.open(target, { providerId: "beta" })).ok).toBe(true);
    const decided = selectionRecords(session);
    expect(decided).toHaveLength(2);
    expect(
      decided
        .map(
          (record) =>
            (
              record.normalized_result as {
                readonly deterministic_rule: string;
              }
            ).deterministic_rule,
        )
        .sort(),
    ).toEqual(["auto-multiple-eligible", "explicit-provider"]);
    expect(beta.clients).toHaveLength(0);

    const observed = await session.execute("address_name", { address: "0x1" });
    expect(observed.ok && observed.value.provider.id).toBe("beta");
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(1);

    // Selection Evidence is not provider-produced analysis and is never
    // replayed as a snapshot binding.
    expect(
      session.exportAnalysisSnapshot().ok &&
        selectionRecords(session).every(
          ({ analysis_profile: profile }) => profile === null,
        ),
    ).toBe(true);

    await session.close();
    expect(selectionRecords(session)).toEqual([]);
    expect(beta.clients[0]?.closed).toBe(true);
  });

  it("keeps a selection-required target stable across an auxiliary call", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const session = selectableSession(
      [alpha.provider, beta.provider],
      auxiliaryProvider(),
    );
    expect((await session.open(target)).ok).toBe(true);

    const auxiliary = await session.execute("inspect_macho", {});
    expect(auxiliary.ok && auxiliary.value.provider.id).toBe("auxiliary");
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
    });
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);
    await session.close();
  });
});

describe("automatic re-selection on an unchanged target", () => {
  it("keeps the resolved automatic binding when auto is requested again", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    beta.available = false;
    const session = selectableSession([alpha.provider, beta.provider]);

    expect((await session.open(target)).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "bound",
      analysis_provider_binding: {
        provider: { id: "alpha" },
        selection_source: "auto-single-candidate",
      },
    });
    expect((await session.execute("address_name", { address: "0x1" })).ok).toBe(
      true,
    );
    expect(alpha.clients).toHaveLength(1);
    const resolutions = alpha.profileResolutions;

    // A second provider becomes eligible and the caller repeats `auto`. The
    // same deterministic policy already answered for these bytes, so the live
    // binding, its client, and its snapshot are not torn down for a tie.
    beta.available = true;
    expect((await session.open(target, { providerId: "auto" })).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "bound",
      analysis_provider_binding: { provider: { id: "alpha" } },
    });
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.closed).toBe(false);
    expect(alpha.profileResolutions).toBe(resolutions);
    expect(beta.clients).toHaveLength(0);
    await session.close();
  });

  it("keeps an unbound automatic route stable when auto is requested again", async () => {
    const { session, target, alpha, beta } = await overlappingSession();
    expect((await session.open(target)).ok).toBe(true);

    expect((await session.open(target, { providerId: "auto" })).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
    });
    expect(alpha.profileResolutions).toBe(1);
    expect(beta.profileResolutions).toBe(1);
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);
    await session.close();
  });

  it("records an explicit choice that reuses the retained client", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    beta.available = false;
    const session = selectableSession([alpha.provider, beta.provider]);

    // Automatic selection binds the only eligible provider and records it.
    expect((await session.open(target)).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_binding: {
        provider: { id: "alpha", version: "1" },
        selection_source: "auto-single-candidate",
      },
    });
    expect((await session.execute("address_name", { address: "0x1" })).ok).toBe(
      true,
    );
    expect(alpha.clients).toHaveLength(1);
    const automatic = selectionRecords(session);
    expect(automatic).toHaveLength(1);
    expect(automatic.map(selectionRuleOf)).toEqual(["auto-single-candidate"]);
    const callsAfterAnalysis = [...(alpha.clients[0]?.calls ?? [])];

    // Asking explicitly for the provider already bound changes no engine work,
    // so the live client is retained; the caller's choice must still be adopted
    // and recorded instead of leaving `selection_source` on the earlier
    // automatic decision.
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.closed).toBe(false);
    expect(alpha.clients[0]?.calls).toEqual(callsAfterAnalysis);
    expect(beta.clients).toHaveLength(0);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "bound",
      analysis_provider_binding: {
        provider: { id: "alpha", version: "1" },
        selection_source: "request",
      },
    });
    expect(selectionRecords(session).map(selectionRuleOf).sort()).toEqual([
      "auto-single-candidate",
      "explicit-provider",
    ]);

    // Repeating the same explicit choice is the same decision, so it adds no
    // record and does not disturb the retained client.
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(selectionRecords(session)).toHaveLength(2);
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.closed).toBe(false);

    // The retained client still serves analysis after the adoption.
    expect((await session.execute("address_name", { address: "0x2" })).ok).toBe(
      true,
    );
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.calls).toEqual([
      ...callsAfterAnalysis,
      "address_name",
    ]);

    await session.close();
    expect(alpha.clients[0]?.closed).toBe(true);
  });

  it("re-resolves auto against a concrete binding because that is a new decision", async () => {
    const { session, target, alpha, beta } = await overlappingSession();
    expect((await session.open(target, { providerId: "beta" })).ok).toBe(true);
    expect((await session.execute("address_name", { address: "0x1" })).ok).toBe(
      true,
    );
    expect(beta.clients).toHaveLength(1);

    // The caller explicitly leaves a concrete binding for automatic selection,
    // so REA re-resolves and reports the tie instead of keeping that binding.
    expect((await session.open(target, { providerId: "auto" })).ok).toBe(true);
    expect(await bindingStatus(session)).toMatchObject({
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
    });
    expect(beta.clients[0]?.closed).toBe(true);
    expect(alpha.clients).toHaveLength(0);
    await session.close();
  });
});

describe("selected provider capability provenance", () => {
  it("labels selected-provider capabilities with the resolved identity", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const session = selectableSession([alpha.provider], auxiliaryProvider());

    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    const resolved = { id: "alpha", name: "alpha provider", version: "1" };
    const status = await bindingStatus(session);
    expect(status).toMatchObject({
      analysis_provider_binding: { provider: resolved },
      analysis_provider_candidates: [
        {
          provider: resolved,
          selected: true,
          capabilities: [{ provider: resolved }],
        },
      ],
    });
    expect(
      z
        .object({ capabilities: z.array(z.object({ provider: z.unknown() })) })
        .parse(status)
        .capabilities.map(({ provider }) => provider),
    ).toEqual([
      { id: "alpha", name: "alpha provider", version: "1" },
      { id: "auxiliary", name: "auxiliary provider", version: "1" },
    ]);
    await session.close();
  });
});

interface ClientState {
  readonly calls: string[];
  closed: boolean;
}

interface DeepProviderFixture {
  provider: AnalysisProviderCandidate;
  readonly clients: ClientState[];
  available: boolean;
  fail: boolean;
  profileResolutions: number;
  pending: Promise<ReturnType<typeof successfulExecution>> | undefined;
}

const deepProvider = (id: string): DeepProviderFixture => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  const fixture: Omit<DeepProviderFixture, "provider"> = {
    clients: [],
    available: true,
    fail: false,
    profileResolutions: 0,
    pending: undefined,
  };
  const provider: AnalysisProviderCandidate = {
    identity: () => identity,
    capabilities: () => [capability(identity, "address_name")],
    inspectAvailability: () =>
      fixture.available
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
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () => {
      fixture.profileResolutions += 1;
      return Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id, name: identity.name, version: "1" },
            { provider: id },
          ),
        }),
      );
    },
    createClient: (_target, profile): AnalysisClient => {
      const state: ClientState = { calls: [], closed: false };
      fixture.clients.push(state);
      return {
        execute: (operation) => {
          if (operation === "health")
            return Promise.resolve(successfulExecution(id, profile?.provider));
          state.calls.push(operation);
          if (fixture.fail)
            return Promise.resolve(
              err(new ProviderAdapterError(id, operation)),
            );
          if (fixture.pending !== undefined) return fixture.pending;
          return Promise.resolve(successfulExecution(id, profile?.provider));
        },
        close: () => {
          state.closed = true;
          return Promise.resolve(ok(null));
        },
      };
    },
  };
  return Object.assign(fixture, { provider });
};

const successfulExecution = (
  id: string,
  provider: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: "1",
  },
) => ok(createAnalysisExecution(`${id}:address_name`, provider));

const auxiliaryProvider = (
  id = "auxiliary",
  operation: DeclaredOperation = "inspect_macho",
): AnalysisProvider => {
  const identity = {
    id,
    name: `${id} provider`,
    version: "1",
  };
  return {
    identity: () => identity,
    capabilities: () => [capability(identity, operation)],
    createClient: (target) => ({
      execute: (operation) =>
        Promise.resolve(
          ok(
            createAnalysisExecution(
              `${operation}:auxiliary`,
              identity,
              operation === "inventory_artifact" ||
                operation === "inspect_artifact"
                ? {
                    subject: {
                      path: target.sourcePath ?? target.path,
                      sha256: "f".repeat(64),
                      format: "directory",
                    },
                  }
                : {},
            ),
          ),
        ),
      close: () => Promise.resolve(ok(null)),
    }),
  };
};

const selectableSession = (
  providers: readonly AnalysisProviderCandidate[],
  auxiliary?: AnalysisProvider,
): BinarySession =>
  composeBinarySession(
    new AnalysisProviderRegistry(providers),
    auxiliary === undefined ? [] : [auxiliary],
  );

/** One parsed database target with two eligible deep providers and an auxiliary. */
const overlappingSession = async () => {
  const target = await databaseTarget();
  const alpha = deepProvider("alpha");
  const beta = deepProvider("beta");
  return {
    target,
    alpha,
    beta,
    session: selectableSession(
      [beta.provider, alpha.provider],
      auxiliaryProvider(),
    ),
  };
};

const capability = (
  provider: ProviderIdentity,
  operation: DeclaredOperation,
): CapabilityDescriptor => ({
  provider,
  operation,
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: operation === "address_name",
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const databaseTarget = async (): Promise<string> => {
  const directory = await createTestTempDirectory("rea-provider-binding-");
  const path = join(directory, "fixture.hop");
  await writeFile(path, "fixture");
  return path;
};

const bindingStatus = async (session: BinarySession) =>
  z
    .object({
      analysis_provider_selection_state: z.unknown(),
      analysis_provider_binding: z.unknown(),
      analysis_provider_candidates: z.array(z.unknown()),
    })
    .passthrough()
    .parse(await session.status());

/** Session-owned records for deterministic selection decisions only. */
const selectionRecords = (session: BinarySession) =>
  session
    .exportEvidenceBundle()
    .records.filter(
      ({ predicate_type: predicate }) => predicate === "rea.provider-selection",
    );

/** Deterministic rule reported by one selection record. */
const selectionRuleOf = (record: {
  readonly normalized_result: unknown;
}): string =>
  z.object({ deterministic_rule: z.string() }).parse(record.normalized_result)
    .deterministic_rule;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
};
