# Agent-aware deep analysis provider selection

Status: draft implementation for [issue #2417](https://github.com/morluto/rea/issues/2417).
Branch: `feat/auto-provider-selection-2417`.

This document describes intended behavior. It is a proposal under review, not a
statement that the public contract below is approved or released.

## Problem

REA composes several deep analysis providers (Ghidra, Hopper, IDA, and future
adapters such as angr). Each publishes its own host availability, target
compatibility, capabilities, and resolved analysis profile.

Before this change, automatic selection bound a provider only when exactly one
candidate was usable. With two or more usable candidates, the initial
`open_binary` failed with an `ambiguous` selection error and no target was
admitted. That made multi-provider installations unable to reach the artifact
and forced the caller to discover the failure, read the candidate list, and
retry with an explicit `provider_id` — without any REA-held state to inspect in
between.

## Selected design: the agent decides, REA supplies facts and enforces them

REA does not rank providers. There is no maintained priority matrix, no
"Ghidra beats Hopper" default, and no automatic comparison of decompilation
quality. Ghidra, Hopper, and IDA are not universally ordered: the right engine
depends on the user's question (a Ghidra-specific MIPS/PSP or Swift workflow, an
existing IDA GUI session, a Hopper-only Mach-O database), which REA cannot infer
from the target alone.

Instead:

1. `open_binary` parses the target and evaluates every configured provider.
2. REA reports availability, target support, capabilities, and profile
   eligibility for every candidate, plus one explicit selection state.
3. One eligible provider is bound automatically, preserving prior behavior.
4. Several eligible providers admit the target in a `selection_required` state
   without binding or launching an arbitrary engine.
5. The external agent reads `binary_session`, compares the candidates against
   the user's requested analysis, and reopens the same target with a concrete
   `provider_id`.
6. REA validates that choice, binds it, and retains the decision as Evidence.

An embedded LLM, automatic multi-provider execution, speculative engine
launching, and automatic fallback after a runtime failure are explicitly out of
scope.

## Selection semantics

### Precedence

Unchanged, evaluated in this order:

1. An explicit concrete `provider_id` supplied by the caller.
2. The configured `REA_ANALYSIS_PROVIDER` preference when the request omits a
   selector. It is a preference, not a ranking: if that provider cannot serve
   the target, the environment path still binds nothing for an artifact-only
   target rather than silently choosing another engine.
3. Automatic selection.

An explicit `provider_id: "auto"` asks REA to apply automatic selection; it is
not an instruction to pick arbitrarily. Automatic selection is deterministic for
a given target and provider configuration, so repeating it for unchanged target
bytes reuse the already-resolved route: an omitted selector always keeps the
active route, and an explicit `auto` keeps it when that route was itself produced
by `auto`. Re-resolving would otherwise tear down a working binding (and its
retained snapshot) to report a tie for a target the caller already opened. A
concrete `provider_id`, or an `auto` request against a concrete binding, always
re-resolves because it expresses a new decision.

An explicit concrete request that is unknown, unavailable, target-unsupported,
or has an unresolvable profile is rejected with a typed error. No case falls
back to another provider.

### States

Automatic selection produces exactly one of three states for a parsed target.

| State                | Condition                       | Binding | Deep engines started |
| -------------------- | ------------------------------- | ------- | -------------------- |
| `bound`              | Exactly one eligible candidate  | yes     | none at admission    |
| `unbound`            | No eligible candidate           | no      | none                 |
| `selection_required` | Two or more eligible candidates | no      | none                 |

"Eligible" is the existing authoritative result: host availability, target
compatibility, and a resolved analysis profile whose provider identity matches
the adapter. Being installed is never sufficient.

`unbound` also covers artifact-only and auxiliary workflows, where no configured
deep provider supports the target. Those workflows keep working.

### Public contract

`binary_session` gains one field, one per-candidate fact, and one availability
reason:

- `analysis_provider_selection_state`: `"bound" | "unbound" |
  "selection_required" | null`. `null` means no target has been resolved on the
  reported route (target-free discovery).
- `analysis_provider_candidates[].eligibility`: `"eligible" | "ineligible" |
  "unevaluated"`. `unevaluated` is an omission, not a rejection: REA resolves
  only the profiles a selection needs, so an unrequested candidate stays
  explicitly unknown instead of being reported as unusable.
- An `eligible` candidate reports the identity its resolved profile committed,
  including the concrete version, and every capability it published carries that
  same identity. An adapter that declares an unresolved version must not hide the
  version REA actually resolved from a caller comparing candidates.
- `tool_availability.groups[].reason` accepts the new
  `"provider_selection_required"` value.

`open_binary` remains the only way to select or switch a deep provider. No
`switch_analysis_provider` tool is introduced: the existing lifecycle already
serializes target transitions, drains in-flight calls, retires the previous
client, and restores the previous session on failure.

### Diagnostics for operations attempted before a decision

A deep operation on a `selection_required` target returns the existing typed
`ProviderSelectionError` with `reason: "ambiguous"`, the requested selector, the
candidate IDs, and the per-candidate rejections. Deep operations on an `unbound`
target keep `provider_unavailable` or `target_unsupported` as appropriate.
`provider_unavailable` is never used to mean "several usable providers are
waiting for a decision".

Because the unbound route advertises no deep capabilities, an unbound target
cannot present deep operations as executable: `binary_session.capabilities` and
`tool_availability` list only what the current route can actually run. Discovery
must also report _why_ without misdirecting the caller: a deep operation that is
unavailable solely because the choice is pending is reported as
`provider_selection_required` with the eligible provider IDs, never as
`provider_missing`. Telling a caller to install a provider that is already
installed and eligible is a wrong, non-actionable diagnostic.

That advice must also be resolvable. Session-level eligibility says nothing about
a specific operation, so the named providers are the eligible candidates that
declared every operation the tool requires as available. A provider that is
eligible for the target but cannot run the requested operation is not offered for
it. When no eligible candidate declares those operations, the pending choice is
not the blocker, so the operation keeps the `provider_missing` diagnostic rather
than sending the caller to pick a provider that cannot help.

## Evidence requirements

A target admission that resolves a new selection records one deterministic,
REA-owned Evidence record (`predicate_type: "rea.provider-selection"`,
`operation: "open_binary"`) that separates three different kinds of statement:

- `candidates[]` — objective per-provider observations: provider identity and
  version, availability status and rejection code, target support status and
  rejection code, eligibility, and the actionable rejection reason.
- `selection_state`, `deterministic_rule`, `selected_provider_id`,
  `selection_source`, `eligible_provider_ids` — the deterministic REA decision.
- `caller_rationale` — explicitly `null`. REA does not reconstruct or fabricate
  the agent's private reasoning, and an explicit `provider_id` is recorded as a
  caller choice, not as verified engine evidence.

The record is attributed to REA's selection policy with
`authority: "analyst-inference"` and `confidence: "derived"`. It reports a REA
decision over local availability and the parsed target, not an observation of the
artifact's contents, so it must not claim `shipped-artifact`: that class is what
static reconstruction treats as an artifact observation and what unknown
resolution accepts as static authority. Its
`predicate_type: "rea.provider-selection"` and null analysis profile keep it out
of the artifact-keyed snapshot and obligation paths regardless, and its `derived`
confidence keeps it out of the `inferred`-only reconciliation projections.

Target identity, format, architecture, and SHA-256 come from the evidence
subject rather than being duplicated in the payload. Candidate capabilities are
deliberately excluded: they are large, already available through
`binary_session`, and add no selection decision. `parameters.provider_id` records
the selector REA applied — the caller's `provider_id` when supplied, otherwise
the configured default — so a caller choice is distinguishable from a configured
or automatic one through `selection_source`.

The record carries `analysis_profile: null` and is never registered with the
snapshot cache, so it can neither replay provider results nor be mistaken for
provider-produced analysis. It is created with `createEvidence`, so it keeps the
standard digest identity, immutability, bundle validation, retention, export,
and cleanup semantics.

Repeat operations do not duplicate it: equivalent decisions produce an identical
`evidence_id`, which the ledger records as a duplicate. The retained reopen fast
path (same target and same profile) still records a decision that differs from
the one in force — asking explicitly for the provider that automatic selection
already bound is a new caller choice — while reusing the live client, its run ID,
and the snapshot binding. That record is adopted into the active route so
`analysis_provider_binding.selection_source` reports `request` instead of the
superseded automatic decision, and repeating the same explicit choice adds no
second record.

## Compatibility guarantees

- Existing supported provider IDs and capability contracts are unchanged.
- `analysis_provider_binding` keeps its shape and semantics, including
  `selection_source: "auto-single-candidate"` for the single-candidate case.
- Existing successful single-provider workflows, artifact-only workflows, and
  target-free discovery are unchanged.
- `analysis_provider_candidates[]` keeps its existing fields; `eligibility` is
  additive. `analysis_provider_selection_state` is additive.
- `tool_availability.groups[].reason` gains the additive
  `provider_selection_required` member; previously reported reasons keep their
  meaning and are unchanged for every case that already produced them.
- Repeating `auto` for unchanged target bytes no longer discards an already
  resolved automatic binding. A concrete selector still re-resolves and switches,
  and a provider failure still never switches engines implicitly.
- Target ownership, resource cleanup, cancellation, and the single-active-target
  invariant are unchanged.
- No new execution, injection, network, or target-mutation capability is added.
  Provider adapters are not modified.

## Acceptance criteria

1. Zero eligible providers: the target is admitted unbound, complete rejection
   diagnostics are retained, no engine starts, and deep operations fail with a
   typed error. Artifact-only operations still work.
2. One eligible provider: it is bound automatically with
   `selection_source: "auto-single-candidate"`, and no additional call is
   required.
3. Two or more eligible providers: `open_binary` succeeds,
   `analysis_provider_selection_state` is `selection_required`, no provider is
   bound or started, and candidate metadata is complete. Every eligible candidate
   reports the version its resolved profile committed, and its capabilities carry
   that same identity.
4. A deep operation before the decision returns a typed `ambiguous` error naming
   the candidate IDs, and the same operations are advertised as
   `provider_selection_required` naming only the eligible providers that declared
   what the operation needs. An operation no eligible provider can run keeps the
   `provider_missing` diagnostic.
5. Reopening the same target with a concrete `provider_id` validates and binds
   exactly that provider, which then appears in `analysis_provider_binding` with
   its resolved version and profile.
6. Repeating `auto` for unchanged target bytes keeps the resolved automatic route
   and its live provider client; a concrete binding is still replaced on request.
7. Candidate ordering is canonical (provider ID) and independent of provider
   registration order.
8. A selection Evidence record exists for the decision, is attributed to REA
   rather than to an engine, and is not duplicated by an equivalent reopen.
9. A runtime provider failure never triggers automatic fallback.
10. `npm run check:fast`, `npm run docs:check`, and the affected test projects
    pass.

## Open decisions for maintainers

- **Public field naming.** `analysis_provider_selection_state`, `eligibility`,
  and the `provider_selection_required` availability reason are new wire values.
  An equivalent representation was not sufficient: the eligibility rule and the
  pending-choice reason are REA's decisions, and re-deriving them in every
  consumer would duplicate the policy or, as before, misreport a configured
  provider as missing. If a smaller public surface is preferred, the state could
  be derived from the binding plus the eligible candidate count, at the cost of
  losing the actionable remediation.
- **Caller-supplied rationale.** The record reserves `caller_rationale` but
  never populates it. Accepting an agent-authored rationale would require a new
  public input on `open_binary` and has not been added.
- **Scope.** Enabling this behavior by default changes what a multi-provider
  `open_binary` returns. `CONTRIBUTING.md` requires an explicit maintainer scope
  decision before a capability expansion is integrated; this branch is a draft
  proposal for that decision, not an integration request.
- **Real-engine verification.** The workflow is verified against simulated
  providers and the MCP boundary. A real multi-provider host (for example Ghidra
  and IDA configured together) has not been exercised here.
