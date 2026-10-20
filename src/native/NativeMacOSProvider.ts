import {
  plistSourceFormat,
  requireRegularPlist,
  nativePlistFailure,
  resolveNativePlistSelection,
  unreadablePlist,
} from "./NativePlistSource.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY,
  nativeMacOSCapabilities,
} from "./NativeMacOSProviderMetadata.js";
import {
  appleDispatchMetadataFailure,
  inspectAppleDispatchMetadata,
} from "./AppleDispatchMetadata.js";
import {
  observeNativeUi,
  finishNativeUiObservation,
} from "./NativeUiObservation.js";
import { NativeUiCleanupError } from "./NativeUiCleanupError.js";
import { LldbCallTracer, type NativeCallTracer } from "./LldbCallTracer.js";
import { observeNativeCalls } from "./NativeCallObservation.js";
import { realpath } from "node:fs/promises";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  NATIVE_TOOL_CONTRACTS,
  type NativeToolName,
} from "../contracts/native/nativeToolContracts.js";
import {
  isMachOFormat,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { isAppleDispatchMetadataTarget } from "../domain/native/objcSwiftMetadata.js";
import { toolContract } from "../contracts/toolContracts.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisError,
  resolvedAnalysisError,
} from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  projectPlistValue,
  nonFiniteRealLimitation,
  negativeZeroRealLimitation,
  unknownDateLimitation,
  unknownScalarLimitation,
} from "../domain/apple/plistValue.js";
import { createPlistNumberProjection } from "../domain/apple/plistNumbers.js";
import type { NativeUiObservationResult } from "../domain/native/nativeUiObservation.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../domain/propertyListKeys.js";
import {
  demangleSwiftSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  type InspectSignature,
  listArchitecturesSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NATIVE_COMMAND_TIMEOUT_MS,
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NativeCommandFailure,
  XcrunCommandRunner,
  failureCapture,
  type NativeCommandCleanupFailure,
  type NativeCommandCapture,
  type NativeCommandRunner,
} from "./CommandRunner.js";
import {
  withSignatureTarget,
  verifySignatureTarget,
  type SignatureTargetBinding,
} from "./SignatureTargetBinding.js";
import { parseCodeSignature } from "./parsers/codesign.js";
import {
  describeEntitlementDifferences,
  describeSignatureSlices,
  describeSignedSlicesOfUnsignedDefault,
  entitlementShape,
  sameCdhashes,
  type SliceSignature,
} from "./signatureSlices.js";
import { parseDemangledSymbols } from "./parsers/demangle.js";
import { parseLipoOutput } from "./parsers/lipo.js";
import {
  parsePlistJson,
  parsePlistXml,
  plistJsonNeedsNumberTypes,
} from "./parsers/plist.js";
import {
  architectureLocations,
  inspectNativeMacho,
} from "./NativeMachoInspection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  createNativeUiHelperRuntime,
  type NativeUiHelperRuntime,
} from "./NativeUiHelperRuntime.js";
import { NativeUiInterruptionControl } from "./NativeUiInterruptionControl.js";

type SignatureRuntimeRootFactory = () => Promise<
  Pick<PrivateRuntimeRoot, "path" | "close">
>;

/** Read-only semantic provider composed from Xcode command-line utilities. */
export class NativeMacOSProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #tracerFactory: () => NativeCallTracer;
  readonly #privateRuntimeRootFactory: SignatureRuntimeRootFactory | undefined;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(
      environment,
    ),
    platform: NodeJS.Platform = process.platform,
    tracerFactory?: () => NativeCallTracer,
    privateRuntimeRootFactory?: SignatureRuntimeRootFactory,
  ) {
    this.#environment = snapshotEnvironment(environment, platform);
    this.#tracerFactory =
      tracerFactory ?? (() => new LldbCallTracer(this.#environment));
    this.#privateRuntimeRootFactory = privateRuntimeRootFactory;
    this.#capabilities = nativeMacOSCapabilities(platform);
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new NativeMacOSClient(
      target,
      this.runner,
      this.#tracerFactory(),
      this.#environment,
      this.#privateRuntimeRootFactory,
    );
  }
}

class NativeMacOSClient implements AnalysisClient {
  readonly #pendingNativeUiRuntimes = new Set<NativeUiHelperRuntime>();
  readonly #pendingCommands = new Set<Promise<unknown>>();
  readonly #signatureResources = new ArtifactResourceScope();
  readonly #plistResources = new ArtifactResourceScope();
  readonly #callResources = new ArtifactResourceScope();
  readonly #dispatchResources = new ArtifactResourceScope();
  #nativeUiTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly target: BinaryTarget,
    private readonly runner: NativeCommandRunner,
    private readonly tracer: NativeCallTracer,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly privateRuntimeRootFactory:
      | SignatureRuntimeRootFactory
      | undefined,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ) {
    if (this.#closed)
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Native provider client is closed",
        ),
      );
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (operation === "inspect_native_dispatch_metadata") {
      const input = toolContract(operation).inputSchema.safeParse(parameters);
      if (!input.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            input.error.issues,
            parameters,
            {
              cause: input.error,
            },
          ),
        );
      if (!isAppleDispatchMetadataTarget(this.target))
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Binary Apple metadata requires Mach-O; other providers can report symbol-only metadata",
          ),
        );
      try {
        const result = await this.#dispatchResources.run(() =>
          inspectAppleDispatchMetadata(
            this.target,
            input.data.max_records,
            this.#dispatchResources,
            options?.signal,
          ),
        );
        return ok(
          createAnalysisExecution(result, result.provider, {
            locations: [{ kind: "artifact-path", path: this.target.path }],
            limitations: result.result.coverage.flatMap(({ reason }) =>
              reason === null ? [] : [reason],
            ),
          }),
        );
      } catch (cause) {
        return err(appleDispatchMetadataFailure(cause, this.target.path));
      }
    }
    if (!isNativeOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by native macOS tools.",
        ),
      );
    if (operation === "observe_native_calls") {
      const result = await observeNativeCalls(
        this.target,
        parameters,
        this.tracer,
        this.#callResources,
        options?.signal,
      );
      return result.ok
        ? ok(
            createAnalysisExecution(result.value, IDENTITY, {
              limitations: result.value.limitations,
              locations: [{ kind: "artifact-path", path: this.target.path }],
            }),
          )
        : result;
    }
    if (
      operation === "observe_native_ui" ||
      operation === "capture_native_ui_scenario"
    ) {
      return this.#observeNativeUi(operation, parameters, options?.signal);
    }
    try {
      const observation = await this.#dispatch(
        operation,
        parameters,
        options?.signal,
      );
      return observation.ok
        ? ok(
            createAnalysisExecution(observation.value.result, IDENTITY, {
              limitations: observation.value.limitations,
              locations: observation.value.locations,
            }),
          )
        : err(resolvedAnalysisError(observation.error));
    } catch (cause: unknown) {
      return err(nativeOutputFailure(operation, cause));
    }
  }

  async close(): Promise<Result<null, AnalysisError>> {
    this.#closed = true;
    await Promise.allSettled(this.#pendingCommands);
    const uiCleanupFailures = await this.#serializeNativeUi(() =>
      this.#retryNativeUiCleanup(),
    );
    const signatureCleanup = await closeNativeFileScope(
      this.#signatureResources,
      "signature-snapshot",
    );
    const plistCleanup = await closeNativeFileScope(
      this.#plistResources,
      "plist-file",
    );
    const callCleanup = await closeNativeFileScope(
      this.#callResources,
      "native-call-target",
    );
    const dispatchCleanup = await closeNativeFileScope(
      this.#dispatchResources,
      "native-dispatch-metadata-target",
    );
    const commandCleanup = await this.#retryNativeCommandCleanup();
    let result = await this.tracer.close();
    const cleanupErrors = [
      ...(uiCleanupFailures.length === 0
        ? []
        : [this.#nativeUiCleanupFailure(uiCleanupFailures, "close_binary")]),
      ...(commandCleanup === undefined ? [] : [commandCleanup]),
      ...(signatureCleanup === undefined ? [] : [signatureCleanup]),
      ...(plistCleanup === undefined ? [] : [plistCleanup]),
      ...(callCleanup === undefined ? [] : [callCleanup]),
      ...(dispatchCleanup === undefined ? [] : [dispatchCleanup]),
    ];
    for (const cleanupError of cleanupErrors)
      result = result.ok
        ? err(cleanupError)
        : err(
            analysisErrorWithCleanupFailure(
              result.error,
              cleanupError,
            ).bindCleanupDependencies([result.error, cleanupError]),
          );
    return result;
  }

  #observeNativeUi(
    operation: "observe_native_ui" | "capture_native_ui_scenario",
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ) {
    return this.#serializeNativeUi(async () => {
      if (this.#closed)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Native provider client is closed",
          ),
        );
      const earlierCleanupFailures = await this.#retryNativeUiCleanup();
      if (earlierCleanupFailures.length > 0)
        return err(
          this.#nativeUiCleanupFailure(earlierCleanupFailures, operation),
        );
      const runtime = createNativeUiHelperRuntime(this.environment);
      const interruption = new NativeUiInterruptionControl(
        signal,
        runtime.signal,
      );
      try {
        this.#pendingNativeUiRuntimes.add(runtime);
        let result: Awaited<ReturnType<typeof observeNativeUi>>;
        try {
          result = await observeNativeUi(this.target, operation, parameters, {
            environment: this.environment,
            runtime,
            interruption,
          });
        } catch (cause: unknown) {
          result = err(
            cause instanceof AnalysisError
              ? cause
              : new ProviderAdapterError(IDENTITY.id, operation, { cause }),
          );
        }
        try {
          await runtime.close();
          this.#pendingNativeUiRuntimes.delete(runtime);
        } catch (cause: unknown) {
          result = finishNativeUiObservation(result, operation, interruption);
          const cleanup = this.#nativeUiCleanupFailure(
            [{ runtime, cause }],
            operation,
            result.ok ? result.value : undefined,
          );
          return err(
            result.ok
              ? cleanup
              : analysisErrorWithCleanupFailure(
                  result.error,
                  cleanup,
                  operation,
                ).bindCleanupDependencies([result.error, cleanup]),
          );
        }
        result = finishNativeUiObservation(result, operation, interruption);
        return result.ok
          ? ok(
              createAnalysisExecution(result.value, IDENTITY, {
                limitations: result.value.limitations,
              }),
            )
          : result;
      } finally {
        interruption.dispose();
      }
    });
  }

  #serializeNativeUi<Value>(operation: () => Promise<Value>): Promise<Value> {
    const call = this.#nativeUiTail.then(operation, operation);
    this.#nativeUiTail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async #retryNativeUiCleanup(): Promise<
    Array<{ readonly runtime: NativeUiHelperRuntime; readonly cause: unknown }>
  > {
    const failures: Array<{
      readonly runtime: NativeUiHelperRuntime;
      readonly cause: unknown;
    }> = [];
    for (const runtime of this.#pendingNativeUiRuntimes) {
      try {
        await runtime.close();
        this.#pendingNativeUiRuntimes.delete(runtime);
      } catch (cause: unknown) {
        failures.push({ runtime, cause });
      }
    }
    return failures;
  }

  async #retryNativeCommandCleanup(): Promise<AnalysisError | undefined> {
    if (this.runner.retryCleanup === undefined) return undefined;
    try {
      const failures = await this.runner.retryCleanup();
      return failures.length === 0
        ? undefined
        : nativeCommandCleanupFailure(failures);
    } catch (cause: unknown) {
      return new ProviderCleanupError(
        IDENTITY.id,
        ["native-command-process-cleanup"],
        {
          reason:
            cause instanceof Error
              ? cause.message || cause.name
              : String(cause) || "native command cleanup failed unexpectedly",
        },
        { cause },
      );
    }
  }

  #nativeUiCleanupFailure(
    failures: readonly {
      readonly runtime: NativeUiHelperRuntime;
      readonly cause: unknown;
    }[],
    operation: string,
    partialObservation?: NativeUiObservationResult,
  ): ProviderCleanupError {
    return new NativeUiCleanupError(failures, operation, partialObservation);
  }

  #dispatch(
    operation: NativeToolName,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    switch (operation) {
      case "observe_native_ui":
      case "capture_native_ui_scenario":
      case "observe_native_calls":
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              IDENTITY.id,
              operation,
              "UI observation uses its explicit authority boundary",
            ),
          ),
        );
      case "inspect_macho":
        return this.#inspectMacho(signal);
      case "inspect_signature":
        return this.#inspectSignature(signal);
      case "inspect_plist":
        return this.#inspectPlist(parameters, signal);
      case "list_architectures":
        return this.#listArchitectures(signal);
      case "demangle_swift":
        return this.#demangle(parameters, signal);
    }
  }

  async #listArchitectures(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    // lipo reads only Mach-O; its refusal of a PE, ELF, or plist target is not
    // a tool failure that a retry or `rea doctor` could repair.
    if (!isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "list_architectures",
          "Active artifact is not Mach-O.",
        ),
      );
    const capture = await this.#run(
      "list_architectures",
      "lipo",
      ["-detailed_info", this.target.path],
      { signal },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const { architectures } = parseLipoOutput(
      capture.value.stdout,
      this.target.path,
    );
    const result = listArchitecturesSchema.parse({
      architectures: {
        items: architectures,
        total: architectures.length,
        exhaustive: true,
        limitations: [],
      },
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      limitations: [],
      locations: architectureLocations(result.architectures.items),
    });
  }

  async #demangle(
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const symbols = z.array(z.string()).safeParse(parameters.symbols);
    if (!symbols.success)
      return err(
        new AnalysisOutputError(
          "demangle_swift",
          "symbols were not parsed strings",
        ),
      );
    const capture = await this.#run(
      "demangle_swift",
      "swift-demangle",
      // `--` keeps symbols that begin with `-` from selecting demangler options.
      ["--compact", "--", ...symbols.data],
      { signal },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const result = demangleSwiftSchema.parse({
      symbols: parseDemangledSymbols(symbols.data, capture.value.stdout),
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      limitations: [],
      locations: [],
    });
  }

  async #inspectSignature(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    // This provider's signature inspection covers Mach-O code signatures
    // only. On another container, codesign's "not signed" verdict cannot
    // see a format-level signature such as a xar pkg signature, so
    // reporting it would claim unsigned for a layer that was never
    // evaluated.
    if (this.target.kind !== "executable" || !isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_signature",
          "Active artifact is not Mach-O; its container-level signature layer is not evaluated by codesign.",
        ),
      );
    const inspected = await withSignatureTarget(
      this.target,
      this.#signatureResources,
      (binding) => this.#inspectBoundSignature(binding, signal),
      signal,
      this.privateRuntimeRootFactory,
    );
    return inspected.ok
      ? ok({
          result: inspected.value,
          limitations: inspected.value.limitations,
          locations: [],
        })
      : inspected;
  }

  async #inspectBoundSignature(
    binding: SignatureTargetBinding,
    signal?: AbortSignal,
  ): Promise<Result<InspectSignature, AnalysisError>> {
    const display = await this.#captureSignature(
      binding,
      ["-d", "--verbose=4"],
      signal,
    );
    if (!display.ok) return display;
    const unsigned = isNonzeroUnsignedObservation(display.value);
    const displayFailure = codeSignCaptureFailure(display.value);
    if (displayFailure !== null) return err(displayFailure);
    const requirements = await this.#captureSignature(
      binding,
      ["-d", "-r-"],
      signal,
    );
    if (!requirements.ok) return requirements;
    const requirementsFailure = codeSignCaptureFailure(requirements.value);
    if (requirementsFailure !== null) return err(requirementsFailure);
    const entitlements = await this.#captureSignature(
      binding,
      ["-d", "--entitlements", ":-"],
      signal,
    );
    if (!entitlements.ok) return entitlements;
    const entitlementsFailure = codeSignCaptureFailure(entitlements.value);
    if (entitlementsFailure !== null) return err(entitlementsFailure);
    // codesign echoes the resolved executable path in its diagnostics.
    const parsed = parseCodeSignature(display.value.stderr, unsigned, [
      binding.snapshotPath,
      ...(await canonicalPath(binding.snapshotPath)),
    ]);
    // The requirement is printed to stdout; stderr echoes the path.
    const requirementText =
      /designated\s*=>\s*(.+)$/mu.exec(requirements.value.stdout)?.[1] ?? null;
    // Entitlements XML is printed to stdout; stderr echoes the path.
    const entitlementValue = parseEntitlements(entitlements.value.stdout);
    const captures = [display.value, requirements.value, entitlements.value];
    const limitations = [
      ...parsed.limitations,
      "Inspected a digest-verified Mach-O byte snapshot; filesystem-bound signing context and trust validation are not examined.",
      ...entitlementValue.limitations.map((note) => `Entitlements: ${note}`),
    ];
    const mixedSigning =
      !unsigned &&
      (isNonzeroUnsignedObservation(requirements.value) ||
        isNonzeroUnsignedObservation(entitlements.value));
    // Without -a, codesign describes one slice of a universal file, so every
    // slice of a universal file is queried: an unsigned slice stays hidden
    // behind an identity requirement, a slice signed with another identifier,
    // runtime flag or entitlements is otherwise never reported, and an
    // unsigned default slice hides every signed one. An unsigned display has
    // no Format line, so the bound target's architectures stand in for it.
    // The bound target names slices by CPU family, which merges arm64, arm64e
    // and arm64e.x1; lipo names each slice as codesign -a accepts it.
    // Target classification already proves a thin file has one slice, so
    // only an unsigned universal file needs lipo for its slice names.
    const sliceNames =
      unsigned &&
      this.target.kind === "executable" &&
      this.target.format === "mach-o-universal"
        ? await this.#unsignedSliceNames(binding, signal)
        : null;
    if (sliceNames !== null && !sliceNames.ok) return sliceNames;
    if (sliceNames !== null) {
      captures.push(...sliceNames.value.captures);
      limitations.push(...sliceNames.value.limitations);
    }
    const provenance = captures.map((capture) =>
      invocation(capture, binding.snapshotPath),
    );
    const architectures =
      sliceNames === null
        ? mixedSigning
          ? codeSignArchitectures(parsed.format, this.target)
          : universalCodeSignArchitectures(parsed.format)
        : sliceNames.value.names;
    if (mixedSigning || architectures.length > 1) {
      const slices = await this.#inspectSignatureSlices(
        binding,
        architectures,
        {
          mixed: mixedSigning,
          cdhashes: parsed.cdhashes,
          requirements: requirements.value.exitCode,
          // Compare slice entitlements only with aggregate entitlements that
          // were read and decoded; an undecodable aggregate proves nothing.
          entitlementsComparable:
            entitlements.value.exitCode === 0 && entitlementValue.decoded,
          entitlementValue: entitlementValue.value,
          entitlementShape: entitlementValue.shape,
          entitlements: entitlements.value.exitCode,
        },
        signal,
      );
      if (!slices.ok) return slices;
      provenance.push(...slices.value.provenance);
      limitations.push(...slices.value.limitations);
      limitations.push(
        ...(unsigned
          ? describeSignedSlicesOfUnsignedDefault(slices.value.signed)
          : describeSignatureSlices(
              {
                identifier: parsed.identifier,
                team_identifier: parsed.team_identifier,
                cdhashes: parsed.cdhashes,
                authorities: parsed.authorities,
                hardened_runtime: parsed.hardened_runtime,
                entitlements: entitlementValue.value,
                designated_requirement: requirementText,
              },
              slices.value.signed,
            )),
      );
    }
    const version = await verifySignatureTarget(this.target, binding, signal);
    if (!version.ok) return version;
    const result = inspectSignatureSchema.parse({
      ...parsed,
      designated_requirement: requirementText,
      entitlements: entitlementValue.value,
      provenance,
      limitations,
    });
    return ok(result);
  }

  /**
   * Query each slice of a universal file. Signed slices are parsed so the
   * caller can compare them with the aggregate fields; a slice whose CDHash
   * differs from the aggregate is also asked for its entitlements when the
   * aggregate entitlements query succeeded, since they are signed per slice.
   */
  async #inspectSignatureSlices(
    binding: SignatureTargetBinding,
    architectures: readonly string[],
    aggregate: Readonly<{
      /** The aggregate queries already observed an unsigned slice. */
      mixed: boolean;
      /** CDHashes of the slice the aggregate display described. */
      cdhashes: readonly string[];
      requirements: number | null;
      /** The aggregate entitlements were read and decoded. */
      entitlementsComparable: boolean;
      /** The decoded aggregate entitlements, compared against each slice. */
      entitlementValue: JsonValue | null;
      /** Type-tagged form of the aggregate entitlements, or null. */
      entitlementShape: string | null;
      entitlements: number | null;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<SignatureSlices, AnalysisError>> {
    // Captures are projected to provenance as they arrive. A FAT file admits
    // up to 128 slices and each command may return up to its own output
    // budget, so retaining raw outputs until the end would multiply them.
    const provenance: NativeCommandInvocation[] = [];
    const limitations: string[] = [];
    const signed: SliceSignature[] = [];
    const unsigned: string[] = [];
    const unclassified: string[] = [];
    const entitlementsUnavailable: string[] = [];
    const executablePaths = [
      binding.snapshotPath,
      ...(await canonicalPath(binding.snapshotPath)),
    ];
    for (const architecture of architectures) {
      const slice = await this.#captureSignature(
        binding,
        ["-d", "-a", architecture, "--verbose=4"],
        signal,
      );
      if (!slice.ok) return slice;
      provenance.push(invocation(slice.value, binding.snapshotPath));
      if (slice.value.exitCode !== 0) {
        // codesign prefixes its diagnostic with the echoed snapshot path, so
        // a file name that happens to say "not signed at all" must not pass
        // for the verdict.
        if (isNonzeroUnsignedObservation(slice.value, executablePaths))
          unsigned.push(architecture);
        else unclassified.push(architecture);
        continue;
      }
      const parsed = parseCodeSignature(
        slice.value.stderr,
        false,
        executablePaths,
      );
      const facts: SliceSignature = {
        architecture,
        identifier: parsed.identifier,
        team_identifier: parsed.team_identifier,
        cdhashes: parsed.cdhashes,
        authorities: parsed.authorities,
        hardened_runtime: parsed.hardened_runtime,
      };
      // The aggregate entitlements belong to the described slice; another
      // slice's entitlements are hashed into its own code directory.
      if (
        !aggregate.entitlementsComparable ||
        sameCdhashes(parsed.cdhashes, aggregate.cdhashes)
      ) {
        signed.push(facts);
        continue;
      }
      const sliceEntitlements = await this.#captureSignature(
        binding,
        ["-d", "-a", architecture, "--entitlements", ":-"],
        signal,
      );
      if (!sliceEntitlements.ok) return sliceEntitlements;
      provenance.push(
        invocation(sliceEntitlements.value, binding.snapshotPath),
      );
      const decoded =
        sliceEntitlements.value.exitCode === 0
          ? parseEntitlements(sliceEntitlements.value.stdout)
          : null;
      if (decoded !== null)
        limitations.push(
          ...decoded.limitations.map(
            (text) => `Entitlements of the ${architecture} slice: ${text}`,
          ),
        );
      // Entitlements that could not be read or decoded stay unobserved, so
      // the comparison never reports them as absent.
      if (decoded === null || !decoded.decoded) {
        signed.push(facts);
        entitlementsUnavailable.push(architecture);
        continue;
      }
      // Compare now and keep only the outcome: 128 slices of parsed
      // entitlement trees would otherwise stay live until the end.
      signed.push({
        ...facts,
        entitlementDifferences: describeEntitlementDifferences(
          decoded.value,
          aggregate.entitlementValue,
          { slice: decoded.shape, described: aggregate.entitlementShape },
        ),
      });
    }
    if (entitlementsUnavailable.length > 0)
      limitations.push(
        `Entitlements could not be read for Mach-O slices: ${entitlementsUnavailable.join(", ")}.`,
      );
    if (unsigned.length > 0)
      limitations.push(`Unsigned Mach-O slices: ${unsigned.join(", ")}.`);
    else if (aggregate.mixed)
      limitations.push(
        "One or more Mach-O slices are unsigned, but their architectures could not be classified.",
      );
    if (unclassified.length > 0)
      limitations.push(
        `Signature state could not be classified for Mach-O slices: ${unclassified.join(", ")}.`,
      );
    // These aggregate queries fail for a fully unsigned file too; only name
    // mixed signing states when a signed slice was actually observed.
    const mixed = aggregate.mixed || (unsigned.length > 0 && signed.length > 0);
    if (aggregate.requirements !== 0 && mixed)
      limitations.push(
        "The aggregate designated requirement is unavailable because Mach-O slices have mixed signing states.",
      );
    if (aggregate.entitlements !== 0 && mixed)
      limitations.push(
        "The aggregate entitlements are unavailable because Mach-O slices have mixed signing states.",
      );
    return ok({ provenance, signed, limitations });
  }

  /**
   * Name the slices of a universal file whose default slice is unsigned.
   * codesign's unsigned display has no Format line, so ask lipo; when lipo
   * cannot answer, fall back to the bound target's CPU families.
   */
  async #unsignedSliceNames(
    binding: SignatureTargetBinding,
    signal?: AbortSignal,
  ): Promise<
    Result<
      {
        readonly names: readonly string[];
        readonly captures: NativeCommandCapture[];
        readonly limitations: readonly string[];
      },
      AnalysisError
    >
  > {
    const archs = await this.#captureSignature(
      binding,
      ["-archs"],
      signal,
      "lipo",
    );
    // A missing lipo must not fail the signature facts already collected.
    // Only that exact, cleanup-complete condition falls back; cancellation,
    // target changes, a closed client and cleanup failures still propagate.
    if (
      !archs.ok &&
      archs.error instanceof AnalysisCapabilityUnavailableError &&
      archs.error.reason === "lipo is unavailable through xcrun." &&
      !archs.error.cleanupIncomplete
    )
      return ok({
        names: codeSignArchitectures(null, this.target),
        captures: [],
        limitations: [
          "lipo is unavailable, so slice names come from the target's CPU families; variants such as arm64e.x1 are not distinguished.",
        ],
      });
    if (!archs.ok) return archs;
    const names =
      archs.value.exitCode === 0
        ? [
            ...new Set(
              archs.value.stdout
                .trim()
                .split(/\s+/u)
                .filter((name) =>
                  /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/u.test(name),
                ),
            ),
          ]
        : [];
    return ok({
      names:
        names.length > 0 ? names : codeSignArchitectures(null, this.target),
      captures: [archs.value],
      limitations:
        names.length > 0
          ? []
          : [
              "lipo did not name the slices, so slice names come from the target's CPU families; variants such as arm64e.x1 are not distinguished.",
            ],
    });
  }

  async #captureSignature(
    binding: SignatureTargetBinding,
    args: readonly string[],
    signal?: AbortSignal,
    tool: "codesign" | "lipo" = "codesign",
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    const before = await verifySignatureTarget(this.target, binding, signal);
    if (!before.ok) return before;
    let capture: Result<NativeCommandCapture, AnalysisError>;
    try {
      capture = await this.#run(
        "inspect_signature",
        tool,
        [...args, binding.snapshotPath],
        {
          signal,
          acceptNonZero: true,
        },
      );
    } catch (cause: unknown) {
      capture = err(
        new ProviderAdapterError(IDENTITY.id, "inspect_signature", {
          cause,
          diagnostics: {
            phase: "codesign-capture",
            path: this.target.path,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
    // Verify failed captures too: a disappearing target is not a codesign
    // execution failure, and later captures must never use another version.
    const after = await verifySignatureTarget(this.target, binding, signal);
    return after.ok ? capture : after;
  }

  async #inspectPlist(
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const requested = parameters.path;
    if (requested !== undefined && typeof requested !== "string")
      return err(
        new AnalysisOutputError("inspect_plist", "path was not a string"),
      );
    try {
      return await this.#plistResources.run(async () => {
        try {
          const plist = await resolveNativePlistSelection(
            this.target,
            requested,
          );
          if (!plist.ok) return plist;
          const fileInput = {
            selection: plist.value,
            resources: this.#plistResources,
            signal,
          };
          const selected = await requireRegularPlist(fileInput);
          if (!selected.ok) return selected;
          const classified = await this.#run(
            "inspect_plist",
            "file",
            ["-b", plist.value.path],
            { signal },
          );
          if (!classified.ok) return classified;
          const json = await this.#run(
            "inspect_plist",
            "plutil",
            ["-convert", "json", "-o", "-", "--", plist.value.path],
            { signal, acceptNonZero: true },
          );
          if (!json.ok) return json;
          // JSON cannot express data, dates, or non-finite reals; plutil rejects
          // such plists, so decode its lossless XML conversion instead. JSON also
          // prints an integral <real> like an <integer>, so a number beyond the
          // exact JSON range takes its element type from the XML conversion.
          const jsonDecoded = json.value.exitCode === 0;
          const xml =
            jsonDecoded && !plistJsonNeedsNumberTypes(json.value.stdout)
              ? undefined
              : await this.#run(
                  "inspect_plist",
                  "plutil",
                  ["-convert", "xml1", "-o", "-", "--", plist.value.path],
                  { signal, acceptNonZero: !jsonDecoded },
                );
          if (xml !== undefined && !xml.ok) return xml;
          if (xml !== undefined && xml.value.exitCode !== 0) {
            const capture = failureCapture(xml.value, false);
            return err(
              unreadablePlist(
                plist.value,
                `plutil could not decode it as a property list (${plutilDiagnostic(capture, plist.value.path)})`,
                {
                  capturedOutput: {
                    stdout: capture.stdout,
                    stderr: capture.stderr,
                    truncated: capture.truncated,
                    stdout_bytes: capture.stdoutBytes,
                    stderr_bytes: capture.stderrBytes,
                    exit_code: capture.exitCode,
                    signal: capture.signal,
                  },
                },
              ),
            );
          }
          const parsed =
            xml === undefined
              ? parsePlistJson(json.value.stdout)
              : jsonDecoded
                ? parsePlistJson(json.value.stdout, xml.value.stdout)
                : parsePlistXml(xml.value.stdout);
          if (!parsed.ok) return parsed;
          const provenance = [
            classified.value,
            json.value,
            ...(xml === undefined ? [] : [xml.value]),
          ].map((item) => invocation(item, plist.value.path, "$PLIST"));
          const converted = xml?.value ?? json.value;
          const format = await plistSourceFormat(classified.value.stdout, {
            ...fileInput,
            capturedOutput: {
              stdout: converted.stdout,
              stderr: converted.stderr,
              truncated: false,
              stdout_bytes: converted.stdoutBytes,
              stderr_bytes: converted.stderrBytes,
              exit_code: converted.exitCode,
              signal: converted.signal,
            },
          });
          if (!format.ok) return format;
          const result = inspectPlistSchema.parse({
            format: format.value,
            value: parsed.value.value,
            bundle: parsed.value.bundle,
            source_path: plist.value.path,
            provenance,
            limitations: parsed.value.limitations,
          });
          return ok({
            result: jsonValueSchema.parse(result),
            limitations: parsed.value.limitations,
            locations: [{ kind: "artifact-path", path: plist.value.path }],
          });
        } catch (cause: unknown) {
          // Producer failures stay opaque; only scope admission failures reach the file mapper.
          return err(nativeOutputFailure("inspect_plist", cause));
        }
      });
    } catch (cause: unknown) {
      return err(nativePlistFailure(cause, undefined));
    }
  }

  async #inspectMacho(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    if (!isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_macho",
          "Active artifact is not Mach-O.",
        ),
      );
    return inspectNativeMacho({
      target: this.target,
      ...(signal === undefined ? {} : { signal }),
      run: (tool, arguments_, commandSignal) =>
        this.#run("inspect_macho", tool, arguments_, {
          signal: commandSignal,
        }),
      invocation: (capture) => invocation(capture, this.target.path),
    });
  }

  async #run(
    operation: NativeToolName,
    tool: string,
    arguments_: readonly string[],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly acceptNonZero?: boolean;
    } = {},
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    if (this.#closed)
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Native provider client is closed",
        ),
      );
    const command = this.runner.run(tool, arguments_, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      acceptNonZero: options.acceptNonZero ?? false,
    });
    this.#pendingCommands.add(command);
    let captured: Awaited<typeof command>;
    try {
      captured = await command;
    } finally {
      this.#pendingCommands.delete(command);
    }
    if (captured.ok) return captured;
    return err(translateCommandFailure(operation, captured.error));
  }
}

const nativeCommandCleanupFailure = (
  failures: readonly NativeCommandCleanupFailure[],
): ProviderCleanupError =>
  new ProviderCleanupError(
    IDENTITY.id,
    [...new Set(failures.flatMap(({ resources }) => resources))],
    {
      reason: "Native command process cleanup remains incomplete",
      failures: failures.map(({ reason, resources }) => ({
        reason,
        resources: [...resources],
      })),
    },
  );

/** Each file workflow retains its own exact resource set through client close. */
const closeNativeFileScope = async (
  scope: ArtifactResourceScope,
  resource: string,
): Promise<AnalysisError | undefined> => {
  try {
    await scope.close();
    return undefined;
  } catch (cause: unknown) {
    const observation = ArtifactReaderFailure.cleanupObservation(
      cause,
      resource,
    );
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      observation.resources,
      { reason: observation.reason },
      { operation: "close_binary", cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
};

const nativeOutputFailure = (
  operation: AnalysisOperation,
  cause: unknown,
): AnalysisError =>
  new AnalysisOutputError(operation, "Native output parsing failed", { cause });

interface NativeObservation {
  readonly result: JsonValue;
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
}

interface SignatureSlices {
  readonly provenance: readonly NativeCommandInvocation[];
  /** Slices codesign reported as signed, in query order. */
  readonly signed: readonly SliceSignature[];
  readonly limitations: readonly string[];
}

const isNativeOperation = (
  operation: AnalysisOperation,
): operation is NativeToolName =>
  NATIVE_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateCommandFailure = (
  operation: NativeToolName,
  failure: NativeCommandFailure,
): AnalysisError => {
  const preparation = failure.preparationFailure;
  if (preparation !== undefined) {
    const marker = preparation.cleanupFailure;
    const compiler = preparation.compilerOutcome;
    const options = {
      cause: failure,
      ...(preparation.capturedOutput === undefined
        ? {}
        : { capturedOutput: preparation.capturedOutput }),
      ...(marker === undefined
        ? {}
        : {
            cleanup: {
              reason: marker.message,
              resources: marker.cleanupResources,
            },
          }),
      diagnostics: {
        phase: "process-preparation",
        tool: failure.tool,
        reason: failure.reason,
        detail: preparation.message,
        ...(compiler === undefined
          ? {}
          : {
              compiler_outcome: {
                outcome: compiler.outcome,
                code: compiler.code,
                signal: compiler.signal,
                ...(compiler.timeoutMs === undefined
                  ? {}
                  : { timeout_ms: compiler.timeoutMs }),
              },
            }),
      },
    };
    const error =
      preparation.cancellation === undefined
        ? new ProviderAdapterError(IDENTITY.id, operation, options)
        : failure.reason === "timeout"
          ? new AnalysisTimeoutError(operation, NATIVE_COMMAND_TIMEOUT_MS, {
              ...options,
              cause: preparation.cancellation.reason,
            })
          : new AnalysisCancelledError(operation, {
              ...options,
              cause: preparation.cancellation.reason,
            });
    return marker === undefined
      ? error
      : error.bindCleanupDependencies([marker]);
  }
  const capturedOutput =
    failure.capture === null
      ? undefined
      : {
          stdout: failure.capture.stdout,
          stderr: failure.capture.stderr,
          truncated: failure.capture.truncated,
          stdout_bytes: failure.capture.stdoutBytes,
          stderr_bytes: failure.capture.stderrBytes,
          exit_code: failure.capture.exitCode,
          signal: failure.capture.signal,
        };
  const cleanup =
    failure.cleanupFailure === null
      ? undefined
      : {
          reason: failure.cleanupFailure,
          resources: [...failure.cleanupResources],
        };
  const errorOptions = {
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
  if (failure.reason === "unavailable") {
    const reason = `${failure.tool} is unavailable through xcrun.`;
    return new AnalysisCapabilityUnavailableError(
      IDENTITY.id,
      operation,
      reason,
      { ...errorOptions, userMessage: reason },
    );
  }
  if (failure.reason === "cancelled")
    return new AnalysisCancelledError(operation, errorOptions);
  if (failure.reason === "timeout")
    return new AnalysisTimeoutError(
      operation,
      NATIVE_COMMAND_TIMEOUT_MS,
      errorOptions,
    );
  if (failure.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `Native command output exceeded ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes; complete output is required for analysis.`,
      { max_output_bytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES },
      errorOptions,
    );
  return new ProviderAdapterError(IDENTITY.id, operation, {
    cause: failure,
    ...errorOptions,
    diagnostics: {
      tool: failure.tool,
      reason: failure.reason,
      exit_code: failure.capture?.exitCode ?? failure.exitCode,
      signal: failure.capture?.signal ?? null,
      stdout_bytes: failure.capture?.stdoutBytes ?? 0,
      stderr_bytes: failure.capture?.stderrBytes ?? 0,
      ...(failure.detail === null ? {} : { detail: failure.detail }),
    },
  });
};

const translateCodeSignExitFailure = (
  capture: NativeCommandCapture,
): AnalysisError =>
  translateCommandFailure(
    "inspect_signature",
    new NativeCommandFailure(
      "codesign",
      "nonzero-exit",
      capture.exitCode,
      undefined,
      // Accepted output stays complete until the provider decides it failed.
      failureCapture(capture, false),
    ),
  );

const commandOutput = (capture: NativeCommandCapture): string =>
  `${capture.stdout}\n${capture.stderr}`;

/**
 * A signed artifact exits zero; its diagnostics can still contain this text
 * through the echoed path or identifier.
 */
const isNonzeroUnsignedObservation = (
  capture: NativeCommandCapture,
  echoedPaths: readonly string[] = [],
): boolean => {
  if (capture.exitCode === null || capture.exitCode === 0) return false;
  let output = commandOutput(capture);
  for (const path of echoedPaths)
    if (path.length > 0) output = output.split(path).join("");
  return /not signed at all|code object is not signed/iu.test(output);
};

const canonicalPath = async (path: string): Promise<string[]> => {
  try {
    return [await realpath(path)];
  } catch {
    return [];
  }
};

const codeSignCaptureFailure = (
  capture: NativeCommandCapture,
): AnalysisError | null =>
  capture.exitCode === 0 || isNonzeroUnsignedObservation(capture)
    ? null
    : translateCodeSignExitFailure(capture);

/** Slice names codesign printed for a universal file, as its `-a` accepts them. */
const universalCodeSignArchitectures = (format: string | null): string[] => {
  const universal = /^Mach-O universal \(([^)\r\n]+)\)$/u.exec(
    format ?? "",
  )?.[1];
  if (universal === undefined) return [];
  // Accept every slice name codesign prints; macOS 27 system binaries also
  // carry variant names such as arm64e.x1.
  return [
    ...new Set(
      universal
        .split(/\s+/u)
        .filter((architecture) =>
          /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/u.test(architecture),
        ),
    ),
  ];
};

const codeSignArchitectures = (
  format: string | null,
  target: BinaryTarget,
): string[] => {
  const universal = universalCodeSignArchitectures(format);
  if (universal.length > 0) return universal;
  if (target.kind !== "executable" || !isMachOFormat(target.format)) return [];
  return target.availableArchitectures.map((architecture) =>
    architecture === "x86" ? "i386" : architecture,
  );
};

const invocation = (
  capture: NativeCommandCapture,
  artifactPath: string,
  alias = "$ARTIFACT",
): NativeCommandInvocation => ({
  tool: capture.tool,
  command: [
    capture.executable,
    ...capture.arguments.map((argument) =>
      argument === artifactPath ? alias : argument,
    ),
  ],
  tool_version: capture.toolVersion,
  version_reason: capture.versionReason,
  executable_sha256: capture.executableSha256,
  exit: { code: capture.exitCode, signal: capture.signal },
  stdout_bytes: capture.stdoutBytes,
  stderr_bytes: capture.stderrBytes,
});

/**
 * Decode the entitlements plist codesign prints. Data and date values, which
 * JSON cannot carry, become the typed objects inspect_plist uses; a plist
 * that cannot be decoded at all is reported rather than failing the result.
 * Limitation sentences come back unprefixed so callers can name the slice.
 */
const parseEntitlements = (
  output: string,
): {
  readonly value: JsonValue;
  readonly limitations: readonly string[];
  /** False when the plist was present but could not be decoded. */
  readonly decoded: boolean;
  /** Type-tagged form of the decoded plist, for comparison; null if none. */
  readonly shape: string | null;
} => {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  // codesign prints nothing for no entitlements. A header without its
  // closing tag is a cut-off plist, which must stay unknown, not "none".
  if (start < 0)
    return { value: null, limitations: [], decoded: true, shape: null };
  if (end < start)
    return {
      value: null,
      decoded: false,
      shape: null,
      limitations: [
        "the entitlements plist is cut off before its closing tag; entitlements are unavailable.",
      ],
    };
  let decoded: ReturnType<typeof parseXmlPropertyList>;
  try {
    decoded = parseXmlPropertyList(
      output.slice(start, end + "</plist>".length),
    );
  } catch (cause: unknown) {
    // Keep the facts already collected; the comparison treats these
    // entitlements as unobserved rather than absent.
    return {
      value: null,
      decoded: false,
      shape: null,
      limitations: [
        `the entitlements plist could not be decoded (${cause instanceof Error ? cause.message : String(cause)}); entitlements are unavailable.`,
      ],
    };
  }
  // The plist owners project scalars JSON cannot carry (data, dates,
  // non-finite reals, exact integers) and report what each projection lost.
  const projected = projectPlistValue(decoded.value);
  const numbers = createPlistNumberProjection(decoded.numberLiterals);
  const value = numbers.project(projected.value);
  return {
    value,
    decoded: true,
    shape: entitlementShape(decoded.value),
    limitations: [
      ...numbers.limitations(),
      ...(projected.nonFiniteRealCount === 0
        ? []
        : [nonFiniteRealLimitation(projected.nonFiniteRealCount)]),
      ...(projected.negativeZeroRealCount === 0
        ? []
        : [negativeZeroRealLimitation(projected.negativeZeroRealCount)]),
      ...(projected.unknownDateCount === 0
        ? []
        : [unknownDateLimitation(projected.unknownDateCount)]),
      ...(projected.unknownScalarCount === 0
        ? []
        : [unknownScalarLimitation(projected.unknownScalarCount)]),
      ...(decoded.omittedPrototypeKeys === 0
        ? []
        : [omittedPrototypeKeysLimitation(decoded.omittedPrototypeKeys)]),
    ],
  };
};

/** Failed plutil conversions can report on either stream; preserve both. */
const plutilDiagnostic = (
  capture: Pick<NativeCommandCapture, "stdout" | "stderr">,
  path: string,
): string => {
  const diagnostics = [capture.stderr, capture.stdout]
    .map((stream) => {
      const text = stream.trim();
      return text.startsWith(`${path}: `) ? text.slice(path.length + 2) : text;
    })
    .filter((text) => text.length > 0);
  return diagnostics.length === 0
    ? "plutil printed no diagnostic"
    : diagnostics.join("\n");
};
