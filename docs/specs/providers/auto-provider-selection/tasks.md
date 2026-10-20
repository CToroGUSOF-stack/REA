# Tasks: agent-aware deep analysis provider selection

Tracking for [issue #2417](https://github.com/morluto/rea/issues/2417) on branch
`feat/auto-provider-selection-2417`. States reflect what was actually completed
in this branch, including what was verified and what was not.

## Phase A — Baseline

- [x] Inspect repository architecture, contribution rules, and provider
      selection implementation.
- [x] Confirm the working branch and that the working tree had no unrelated
      changes.
- [x] Verify the pinned toolchain against the checkout: `.nvmrc` requests Node
      `24.18.0` and `package.json` requests npm `11.16.0`; the host ran Node
      `26.3.0` with npm `12.0.2`, which satisfies `engines.node`
      (`^22.19.0 || ^24.11.0 || >=26.0.0`).
- [x] Install locked dependencies with `npm ci` (exit 0).
- [x] Record baseline focused-test results: 4 files, 15 tests, all passing.

## Phase B — Design

- [x] `docs/specs/providers/auto-provider-selection/spec.md`.
- [x] `docs/specs/providers/auto-provider-selection/plan.md`.
- [x] `docs/specs/providers/auto-provider-selection/tasks.md`.
- [x] Document why the agent-aware design was chosen over a static priority
      matrix, and record the remaining maintainer decisions.

## Phase C — Regression tests

- [x] `AutoProviderSelectionPolicy.test.ts`: zero, one, two, and four eligible
      candidates; ineligible and unevaluated exclusion; ordering.
- [x] `AnalysisProviderRegistry.test.ts`: registration-order independence, three
      eligible candidates, available-but-incompatible, unavailable, unresolvable
      and invalid profiles, precedence, explicit rejection, cancellation during
      automatic evaluation, and the operation-boundary reasons.
- [x] Replace the two assertions that expected `ambiguous` on the initial
      `open_binary`. Both were rewritten to assert the admitted
      `selection_required` state plus a typed `ambiguous` error at the operation
      boundary; no assertion was simply deleted.
- [x] `providerBinding.test.ts`: selection-required lifecycle, no speculative
      start, retained fast path, Evidence retention and identity, no fallback,
      switching, cleanup.
- [x] `ProviderSelectionEvidence.test.ts`: attribution, subject binding,
      separated observation/decision/rationale fields, rejection retention, rule
      vocabulary, limitation text, digest stability.
- [x] `providerSelectionMcp.test.ts`: the complete external-agent workflow over
      `InMemoryTransport`.

## Phase D — Core implementation

- [x] `AutoProviderSelectionPolicy.ts`: pure `decideAutoProviderSelection`, plus
      the `ProviderSelectionState` and `ProviderCandidateEligibility`
      vocabularies.
- [x] `AnalysisProviderRegistry.ts`: report the state and per-candidate
      eligibility, classify automatic outcomes, and select the reason for an
      unbound operation.
- [x] `AnalysisProviderEvaluation.ts`: record eligible/ineligible on the
      evaluated candidate status.
- [x] `SessionProviderRouter`, `BinarySessionOpen`, and `BinarySessionExecution`
      reused unchanged.

## Phase E — Contracts and Evidence

- [x] `BinarySessionStatus.ts` projects `analysis_provider_selection_state` and
      `analysis_provider_candidates[].eligibility`.
- [x] `toolOutputSchemaPrimitives.ts` advertises both additive fields.
- [x] `ProviderSelectionEvidence.ts` creates the deterministic, REA-attributed
      selection record and reuses `createEvidence` for identity and integrity.
- [x] `BinarySession.ts` records it on the admitting transition and treats a
      recording failure as a failed open with the existing retry/restore path.
- [x] Confirm the record never carries an analysis profile and never enters the
      snapshot replay cache.

## Phase F — MCP integration

- [x] Demonstrate admit, inspect, premature-operation error, explicit reopen,
      analysis, and binding through the MCP `InMemoryTransport` boundary.

## Phase G — Documentation

- [x] Update `.agents/skills/reverse-engineer-anything/SKILL.md` with the
      candidate inspection and selection workflow, including the instruction not
      to treat availability as proof of fidelity.
- [x] Update `docs/mcp-contracts.md` selection and discovery semantics.
- [x] Update `docs/cli.md` multi-provider guidance.
- [x] Update `docs/installation.md`: its readiness guidance still described the
      removed pre-admission `ambiguous` failure.

## Phase J — Pre-PR audit follow-up

A read-only review against the repository PR template found one defect, one
undisclosed lifecycle side effect, and several documentation imprecisions. All
were resolved in this commit.

- [x] **Fix: pending choice misreported as a missing provider.** On a
      `selection_required` target, `tool_availability` reported every deep
      operation as `provider_missing` with "Install or configure a provider…"
      while the providers were installed and eligible. `CapabilityInventory` now
      reports `provider_selection_required` with the eligible provider IDs, and
      `toolAvailabilityReason` gained that member. Covered by the MCP test.
- [x] **Fix: repeated `auto` tore down a live binding.** Calling `open_binary`
      with `provider_id: "auto"` on an already-bound target re-resolved the
      policy, unbound the session, closed the running provider client, and
      cleared the retained snapshot. `resolveSessionTarget` now keeps the
      resolved route for unchanged target bytes when that route was itself
      produced by `auto`; a concrete selector, or `auto` against a concrete
      binding, still re-resolves. Covered by three composition tests.
- [x] **Docs: Evidence record frequency.** "Every admitted target transition"
      contradicted the retained fast path, which records nothing. Reworded in
      `spec.md` and `mcp-contracts.md`.
- [x] **Docs: CLI operation attribution.** `docs/cli.md` now states that
      `details.operation` names the internal provider primitive the workflow
      reached first, not the CLI command.
- [x] **Docs: `parameters.provider_id` semantics.** Documented as the selector
      REA applied (caller value or configured default), distinguishable through
      `selection_source`.
- [x] **Rebase.** Branch rebased onto `upstream/main` (`fb28ec153`); the four
      files edited by both sides merged without conflict.

## Phase K — Review response on PR #3090

Two P2 findings from the automated review, both reproduced against the branch and
fixed at the boundary that owns the fact.

- [x] **Resolved provider versions disappeared** (`AnalysisProviderEvaluation.ts`).
      Re-attribution lived in `selectedResult`, so it covered only the bound
      provider: with two or more eligible candidates every other candidate
      reported the adapter's unresolved declaration (`version: null`) and so did
      its capabilities and the selection Evidence. The evaluation is what
      resolved the profile, so `eligibleStatus` now attributes the committed
      identity there and `selectedResult` only marks the choice. The MCP test
      asserts the resolved version on both eligible candidates and their
      capabilities.
- [x] **Provider advice could not resolve failures** (`CapabilityInventory.ts`).
      `provider_selection_required` named every eligible provider, including ones
      that cannot run the requested tool. `SelectionContext` now carries each
      eligible candidate's declared-and-available operations, and the advisory is
      filtered per operation (all string requirements, any-of for alternatives).
      When no eligible candidate declares them the helper returns `undefined`, so
      the operation keeps the accurate `provider_missing` diagnostic instead of
      advising a provider that cannot help. Covered by differentiated
      expectations for an operation both providers declare, one only `alpha`
      declares, and two no eligible provider declares.

## Phase L — Evidence authority classification

- [x] **Selection Evidence claimed artifact authority** (review round 3).
      `createEvidence` defaults `authority` to `shipped-artifact`, so the record
      was indistinguishable from an artifact observation. Verified before
      changing: `ReconstructionObligationCandidates.ts:388` classified any
      `shipped-artifact` record as a static `"candidate"`, and
      `ReconstructionObligationAuthority.ts:98` accepted it as satisfying a
      `"static"` requirement — both wrong for a provider decision. The record now
      declares `authority: "analyst-inference"` with `confidence: "derived"`, the
      repository's existing pairing for REA-computed records
      (`registerInvestigationTools`, `UnknownEvidence`). The remaining consumers
      were checked: the artifact-keyed snapshot paths additionally require
      `predicate_type: "rea.analysis"` and a non-null analysis profile, the
      JS/managed reconciliation projections require `confidence: "inferred"`, and
      the bundle `scenarios` manifest requires `controlled-replay`, so none of
      them admit this record either way.
      `ProviderSelectionEvidence.test.ts` asserts the classification, including
      an explicit `not.toBe("shipped-artifact")`.

## Phase M — Review response: explicit choices on the retained fast path

- [x] **Explicit choices went unrecorded** (`BinarySession.ts`, review round 4).
      `#tryRetainedFastPath` returned before `#recordProviderSelection`, so
      naming the provider that `auto` had already bound reused the live client,
      recorded nothing, and left `analysis_provider_binding.selection_source` on
      `auto-single-candidate`. The fast path now receives the resolved route and,
      when it differs from the retained one, records that decision with
      `#recordProviderSelection` and adopts the route into the active binding
      (`{ ...retained, route }`) while keeping the client, run ID, analysis
      profile, snapshot binding, and in-flight state. The record is written before
      the route is adopted, so a failed write leaves the still-valid retained
      session untouched. An identical route object (an omitted selector, or
      `auto` against an `auto` route) skips both steps, and a repeated identical
      explicit choice resolves to the same Evidence digest, which the ledger
      reports as a duplicate.
- [x] Regression test (`providerBinding.test.ts`, "records an explicit choice that
      reuses the retained client") covering the agreed matrix: automatic bind and
      record, explicit reopen reusing one client with no new provider calls,
      `selection_source: "request"`, no duplicate on repeat, and analysis still
      served by the retained client. Verified to fail without the `BinarySession`
      change.

## Phase H — Verification

Recorded on Windows 11 with Node.js `26.3.0`, npm `12.0.2`. Baseline comparisons
use `upstream/main` (`fb28ec153`), which is now the branch point: the same
command ran on a detached checkout of that revision and on this branch, and the
failing test files were diffed.

- [x] `npm ci` — exit 0 (the rebase added only `package.json` scripts upstream;
      dependencies and the lockfile are unchanged).
- [x] `npm run test:focused -- <9 affected files>` — 9 files, 71 tests, exit 0.
      The set includes `toolSchemaValidity` and `serverIdentity`, so advertised
      JSON Schemas and catalog digests are validated after SDK conversion.
- [x] `npm run test:fast` — 26 failed files / 126 failing tests on both the
      baseline and this branch; 5462 baseline passes become 5491 (+29 from the
      new and extended tests, including two new source test files). The failing
      file sets are identical.
- [x] `npm run test:mcp` — 12 failed files / 43 failing tests on both sides; 432
      baseline passes become 435. The failing file sets are identical.
- [x] `npm run verify:test-discovery` — "Discovered all 1058 test files exactly
      once."
- [x] `npm run check:fast` — exit 0.
- [x] `npm run check` — **exit 0**: typecheck, lint (0 errors), `format:check`,
      knip, `metadata:check`, and the architecture guards.
- [x] `npm run docs:generate` then `npm run docs:check` — exit 0.
- [x] The remaining `test:fast` / `test:mcp` failures are pre-existing on this
      host and identical to the baseline: symlinks (`EPERM`), executable bits,
      `listen EACCES`, and uninstalled Ghidra/IDA/Hopper/WABT toolchains. The two
      `format:check` failures recorded before the rebase are gone because
      upstream reformatted `src/ghidra/GhidraDoctor.test.ts` and
      `GhidraSnapshotCache.test.ts`.
- [x] Re-record two tests that asserted exact Evidence totals:
      `tests/boundary/mcp/sessionMcpHarness.ts` and
      `tests/boundary/mcp/sessionMcp.test.ts` now derive the totals and assert
      the selection record explicitly instead of a magic number.
- [x] Runtime probes against the built `dist/` (throwaway scripts in the system
      temp directory, not repository tests) confirmed: two eligible providers
      start no client; `selection_required` reports `provider_selection_required`
      with the eligible IDs for official, enhanced, and navigation-context
      operations; `unbound` still reports `provider_missing`; and repeating
      `auto` keeps the bound provider and its live client while a concrete
      selector still switches and retires it.

Unverified on this host: real Ghidra, Hopper, and IDA providers; POSIX-only
lanes; `npm run check:pr` (skipped for time; its component checks were run
individually); and `npm run test:acceptance`, which needs a full
`npm run build:cached`.

## Phase I — PR preparation

- [x] Review the diff for scope, compatibility, formatting, and incomplete
      tests.
- [x] Prepare the commit message and Draft PR description (see the report
      accompanying this branch).
- [ ] Do not push, comment, or open the remote Draft PR without explicit
      approval.

## Not done in this branch

- Real-engine verification on a host with two configured deep providers
  (Ghidra + IDA or Hopper). Simulated providers do not establish real provider
  behavior.
- A caller-supplied selection rationale input. The Evidence record reserves
  `caller_rationale` and always writes `null`.
- Any change to a provider adapter, to execution or mutation authority, or to
  the tool catalog.
- Windows symmetry: the engine runs its checks on this host, so POSIX-only
  lanes remain unexecuted here.
