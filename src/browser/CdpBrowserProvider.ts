import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  sanitizeBrowserUrl,
  type InspectWebPageInput,
  type ListBrowserTargetsInput,
  type WakeBrowserTargetsInput,
} from "../domain/browserObservation.js";
import {
  browserTargetListSchema,
  browserTargetWakeSchema,
  webPageInspectionSchema,
  type BrowserTargetList,
  type BrowserTargetWake,
  type BrowserTargetWakeFailureReason,
  type BrowserTargetWakeOutcome,
  type WebPageInspection,
} from "../domain/browserObservationSchemas.js";
import { IsolatedWebBundleAnalyzer } from "./IsolatedWebBundleAnalyzer.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "../domain/webBundleAnalysis.js";
import {
  webObservationSessionSchema,
  type ObserveWebSessionInput,
  type WebObservationSession,
} from "../domain/browserSession.js";
import {
  webMcpDiscoverySchema,
  type DiscoverWebMcpToolsInput,
  type WebMcpDiscovery,
} from "../domain/webMcpDiscovery.js";
import {
  browserCaptureComparisonSchema,
  compareBrowserCaptures,
  type BrowserCaptureComparison,
  type BrowserCaptureComparisonInput,
} from "../domain/browserCaptureComparison.js";
import {
  webScreenshotDiffSchema,
  webScreenshotSchema,
  type CaptureWebScreenshotInput,
  type CompareWebScreenshotsInput,
  type WebScreenshot,
  type WebScreenshotDiff,
} from "../domain/webScreenshot.js";
import {
  AnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type {
  BrowserObservationFailureReason,
  BrowserObservationOperation,
} from "../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  hasCdpTargetWebSocket,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import {
  attachCdpTargetSession,
  cleanupCdpTargetCommands,
  closeCdpTargetSession,
  openCdpEndpoint,
  openCdpTargetSession,
  type CdpOpenedEndpoint,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { capturePage, type CapturedPage } from "./CdpPageCapture.js";
import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { authorizeCdpTarget } from "./CdpAuthorizedTarget.js";
import { observeCdpSession } from "./CdpObservationSession.js";
import { discoverWebMcp } from "./CdpWebMcpDiscovery.js";
import { captureCdpScreenshot } from "./CdpScreenshot.js";
import { comparePngScreenshots } from "./PngVisualDiff.js";

import { CDP_BROWSER_PROVIDER_IDENTITY } from "./providerIdentities.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  CdpTargetSessionOwner,
  bindCdpTransportCleanup,
} from "./CdpTargetSessionOwner.js";
const CLEANUP_DOMAINS = [
  "Network",
  "Debugger",
  "Runtime",
  "Page",
  "WebMCP",
] as const;

/** Bounded wake primitive outcome: responsive, deadline expired, or failed. */
type WakeCommandOutcome =
  | { readonly kind: "responsive" }
  | { readonly kind: "deadline" }
  | {
      readonly kind: "failed";
      readonly reason: BrowserTargetWakeFailureReason;
    };

/** Upper bound for one verification probe; a revived renderer answers within one. */
const WAKE_POLL_MAX_WAIT_MS = 500;

/** Pause between verification probes so stalled renderers are not hammered. */
const WAKE_POLL_SPACING_MS = 100;

/** Collapse CDP transport failures to the wake outcome's failure-reason set. */
const wakeCollapseReason = (
  reason: BrowserObservationFailureReason,
): BrowserTargetWakeFailureReason =>
  reason === "disconnected" ? "disconnected" : "protocol_error";

/** Read abort state through a function boundary so property narrowing resets. */
const wakeAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** Per-target failures classify into results; unreferenced reasons escalate. */
const wakeSelectionFailureReason = (
  cause: unknown,
): BrowserTargetWakeFailureReason | undefined => {
  if (!(cause instanceof BrowserObservationError)) return undefined;
  switch (cause.reason) {
    case "target_not_found":
    case "target_not_allowed":
      return cause.reason;
    case "protocol_error":
    case "disconnected":
    case "invalid_endpoint_response":
      return "protocol_error";
    default:
      return undefined;
  }
};

/** Send one CDP command raced against a bounded deadline; late replies are consumed. */
const wakeCommandOutcome = (
  targetSession: CdpTargetSession,
  method: string,
  params: Readonly<Record<string, unknown>>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<WakeCommandOutcome> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: WakeCommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ kind: "deadline" }), deadlineMs);
    timer.unref();
    void targetSession.connection
      .send(method, params, targetSession.sessionId, signal)
      .then(
        () => settle({ kind: "responsive" }),
        (cause: unknown) =>
          settle({
            kind: "failed",
            reason:
              cause instanceof BrowserObservationError
                ? wakeCollapseReason(cause.reason)
                : "protocol_error",
          }),
      );
  });

/** Yield to the event loop between verification probes, honoring cancellation. */
const wakePause = (
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (wakeAborted(signal)) {
      reject(
        new AnalysisCancelledError("wake_browser_targets", {
          cause: signal?.reason,
        }),
      );
      return;
    }
    let settled = false;
    const abort = (): void => {
      settle();
      reject(
        new AnalysisCancelledError("wake_browser_targets", {
          cause: signal?.reason,
        }),
      );
    };
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
  });

/**
 * Probe until the target answers, the wake window expires, or CDP reports an
 * unusable transport. Undefined callers check cancellation before the result
 * is trusted: every deadline resolution re-verifies the caller's signal.
 */
const wakeVerifyResponsive = async (
  targetSession: CdpTargetSession,
  wakeDeadlineAtMs: number,
  signal: AbortSignal | undefined,
): Promise<true | BrowserTargetWakeFailureReason> => {
  for (;;) {
    if (wakeAborted(signal))
      throw new AnalysisCancelledError("wake_browser_targets", {
        cause: signal?.reason,
      });
    const remainingMs = wakeDeadlineAtMs - Date.now();
    if (remainingMs <= 0) return "timeout";
    const probe = await wakeCommandOutcome(
      targetSession,
      "Page.enable",
      {},
      Math.min(remainingMs, WAKE_POLL_MAX_WAIT_MS),
      signal,
    );
    if (wakeAborted(signal))
      throw new AnalysisCancelledError("wake_browser_targets", {
        cause: signal?.reason,
      });
    if (probe.kind === "responsive") return true;
    if (probe.kind === "failed") return probe.reason;
    const pauseMs = Math.min(
      WAKE_POLL_SPACING_MS,
      Math.max(0, wakeDeadlineAtMs - Date.now()),
    );
    if (pauseMs > 0) await wakePause(pauseMs, signal);
  }
};

/**
 * Release one wake session. A shared browser socket stays open for later
 * targets; the caller releases it once after the last selection.
 */
const closeWakeTargetSession = async (
  targetSession: CdpTargetSession,
  sharedWithEndpoint: boolean,
  releaseSharedSocket: boolean,
  signal?: AbortSignal,
  owner?: CdpTargetSessionOwner,
): Promise<void> => {
  if (sharedWithEndpoint && owner !== undefined && !releaseSharedSocket) {
    await cleanupCdpTargetCommands(targetSession, CLEANUP_DOMAINS, signal);
    return;
  }
  await closeCdpTargetSession(targetSession, CLEANUP_DOMAINS, signal, owner);
};

/** Passive browser observation through a selected user-owned CDP endpoint. */
export class CdpBrowserProvider implements BrowserObservationPort {
  readonly #owner = new CdpTargetSessionOwner();
  readonly #bundleAnalyzer = new IsolatedWebBundleAnalyzer();

  async close(): Promise<void> {
    const outcomes = await Promise.allSettled([
      this.#owner.close(),
      this.#bundleAnalyzer.close(),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const typed = failures.filter(
        (failure): failure is AnalysisError => failure instanceof AnalysisError,
      );
      throw new ProviderCleanupError(
        CDP_BROWSER_PROVIDER_IDENTITY.id,
        typed.flatMap((failure) => failure.cleanupResources),
        { reason: "Browser transport and analyzer cleanup remain incomplete" },
        {
          operation: "analyze_web_bundle",
          cause: new AggregateError(failures),
        },
      ).bindCleanupDependencies(typed);
    }
  }

  identity(): ProviderIdentity {
    return CDP_BROWSER_PROVIDER_IDENTITY;
  }

  async listTargets(
    input: ListBrowserTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<BrowserTargetList, AnalysisError>> {
    try {
      const endpoint = await openCdpEndpoint(
        input.cdp_endpoint,
        "list_browser_targets",
        options.signal,
        undefined,
        this.#owner,
      );
      if (endpoint.connection !== undefined)
        await this.#owner.finish(endpoint.connection);
      const { discovery } = endpoint;
      const selected = selectTargets(
        discovery,
        input.allowed_origins.length === 0
          ? undefined
          : new Set(input.allowed_origins),
      );
      return ok(
        browserTargetListSchema.parse({
          browser: discovery.version,
          targets: selected.allowed,
          excluded: selected.excluded,
          limitations: [
            input.allowed_origins.length === 0
              ? "All page targets with supported HTTP(S) URLs are listed."
              : "Only page targets whose current URL matches an explicitly requested exact origin are listed.",
            ...(selected.unconnectable === 0
              ? []
              : [
                  `${String(selected.unconnectable)} otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.`,
                ]),
            ...(selected.allowed.some((target) => target.attached === null)
              ? [
                  "CDP discovery omitted attachment state for one or more targets; attached is reported as unknown.",
                ]
              : []),
          ],
        }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "list_browser_targets", options.signal));
    }
  }

  async wakeTargets(
    input: WakeBrowserTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<BrowserTargetWake, AnalysisError>> {
    let endpoint: CdpOpenedEndpoint | undefined;
    const results: BrowserTargetWakeOutcome[] = [];
    const limitations: string[] = [];
    try {
      if (wakeAborted(options.signal))
        throw new AnalysisCancelledError("wake_browser_targets", {
          cause: options?.signal?.reason,
        });
      endpoint = await openCdpEndpoint(
        input.cdp_endpoint,
        "wake_browser_targets",
        options.signal,
        undefined,
        this.#owner,
      );
      const ordered: string[] = [];
      for (const targetId of input.target_ids)
        if (!ordered.includes(targetId)) ordered.push(targetId);
      if (ordered.length < input.target_ids.length)
        limitations.push("Duplicate target IDs were classified once.");
      for (let index = 0; index < ordered.length; index += 1) {
        if (wakeAborted(options.signal))
          throw new AnalysisCancelledError("wake_browser_targets", {
            cause: options?.signal?.reason,
          });
        const targetId = ordered[index] as string;
        const selectionStartAtMs = Date.now();
        let targetSession: CdpTargetSession | undefined;
        try {
          const authorized = authorizeCdpTarget(
            endpoint.discovery,
            { target_id: targetId, allowed_origins: input.allowed_origins },
            "wake_browser_targets",
          );
          targetSession =
            endpoint.connection !== undefined
              ? await attachCdpTargetSession(
                  endpoint.connection,
                  authorized.target,
                  "wake_browser_targets",
                  options.signal,
                  this.#owner,
                )
              : await openCdpTargetSession(
                  endpoint.discovery,
                  authorized.target,
                  "wake_browser_targets",
                  options.signal,
                  undefined,
                  this.#owner,
                );
          results.push(
            await this.#wakeOneTarget(
              authorized.target.id,
              targetSession,
              input,
              options,
            ),
          );
        } catch (cause: unknown) {
          if (cause instanceof AnalysisCancelledError) throw cause;
          const reason = wakeSelectionFailureReason(cause);
          if (reason === undefined) throw cause;
          results.push({
            target_id: targetId,
            status: "unknown",
            elapsed_ms: Math.max(0, Date.now() - selectionStartAtMs),
            reload_sent: false,
            failure_reason: reason,
          });
        } finally {
          if (targetSession !== undefined)
            await closeWakeTargetSession(
              targetSession,
              endpoint.connection !== undefined &&
                targetSession.connection === endpoint.connection,
              index === ordered.length - 1,
              options.signal,
              this.#owner,
            );
        }
      }
      if (endpoint.connection !== undefined)
        await this.#owner.finish(endpoint.connection);
      if (input.revive === "none")
        limitations.push(
          "Probe-only wake changed no target; deadline-stalled targets stay unverified without the caller-opted reload revival.",
        );
      const stale = results.filter(
        (result) => result.status === "unknown",
      ).length;
      if (stale > 0)
        limitations.push(
          `${String(stale)} selected target(s) stayed unverified within the reported deadlines.`,
        );
      return ok(
        browserTargetWakeSchema.parse({
          browser: endpoint.discovery.version,
          results,
          limitations,
        }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "wake_browser_targets", options.signal));
    }
  }

  async inspectPage(
    input: InspectWebPageInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebPageInspection, AnalysisError>> {
    try {
      const captured = await this.#capture(input, options, "inspect_web_page");
      return ok(webPageInspectionSchema.parse(captured.inspection));
    } catch (cause: unknown) {
      return err(providerError(cause, "inspect_web_page", options.signal));
    }
  }

  async analyzeBundle(
    input: AnalyzeWebBundleInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebBundleAnalysis, AnalysisError>> {
    const admission = await this.#bundleAnalyzer.reserve();
    if (!admission.ok) return admission;
    let captured: CapturedPage | undefined;
    try {
      captured = await this.#capture(input, options, "analyze_web_bundle");
      const sourceMaps = input.fetch_source_maps
        ? await fetchWebSourceMaps(
            captured.sourceMapRequests,
            {
              ...input,
              allowed_origins:
                input.allowed_origins.length > 0
                  ? input.allowed_origins
                  : [captured.inspection.target.origin],
            },
            options.signal,
          )
        : undefined;
      return await this.#bundleAnalyzer.analyze(
        captured.inspection,
        sourceMaps ?? {
          status: "not_requested",
          requested: 0,
          processed: 0,
          items: [],
        },
        input,
        options.signal,
      );
    } catch (cause: unknown) {
      // fetchWebSourceMaps rethrows the exact abort reason. Preserve cancellation
      // even when a caller supplied an AnalysisError as that reason.
      if (options.signal?.aborted === true && cause === options.signal.reason) {
        return err(
          new AnalysisCancelledError("analyze_web_bundle", {
            cause,
            ...(captured === undefined
              ? {}
              : { partialObservation: captured.inspection }),
          }),
        );
      }
      return err(providerError(cause, "analyze_web_bundle", options.signal));
    } finally {
      this.#bundleAnalyzer.releaseReservation();
    }
  }

  async observeSession(
    input: ObserveWebSessionInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebObservationSession, AnalysisError>> {
    try {
      return ok(
        webObservationSessionSchema.parse(
          await withTargetSession(
            input,
            "observe_web_session",
            options,
            observeCdpSession,
            this.#owner,
          ),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "observe_web_session", options.signal));
    }
  }

  async discoverWebMcpTools(
    input: DiscoverWebMcpToolsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebMcpDiscovery, AnalysisError>> {
    try {
      return ok(
        webMcpDiscoverySchema.parse(
          await withTargetSession(
            input,
            "discover_webmcp_tools",
            options,
            discoverWebMcp,
            this.#owner,
          ),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "discover_webmcp_tools", options.signal));
    }
  }

  async compareCaptures(
    input: BrowserCaptureComparisonInput,
  ): Promise<Result<BrowserCaptureComparison, AnalysisError>> {
    try {
      return ok(
        browserCaptureComparisonSchema.parse(compareBrowserCaptures(input)),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "compare_web_captures"));
    }
  }

  async captureScreenshot(
    input: CaptureWebScreenshotInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebScreenshot, AnalysisError>> {
    try {
      return ok(
        webScreenshotSchema.parse(
          await withTargetSession(
            input,
            "capture_web_screenshot",
            options,
            captureCdpScreenshot,
            this.#owner,
          ),
        ),
      );
    } catch (cause: unknown) {
      return err(
        providerError(cause, "capture_web_screenshot", options.signal),
      );
    }
  }

  async compareScreenshots(
    input: CompareWebScreenshotsInput,
  ): Promise<Result<WebScreenshotDiff, AnalysisError>> {
    try {
      return ok(webScreenshotDiffSchema.parse(comparePngScreenshots(input)));
    } catch (cause: unknown) {
      if (cause instanceof TypeError)
        return err(
          new AnalysisInputError("compare_web_screenshots", { cause }, [
            { path: [], reason: "invalid_format", message: cause.message },
          ]),
        );
      return err(providerError(cause, "compare_web_screenshots"));
    }
  }

  /** Classify one target, revive deadline-stalled renderers on request. */
  async #wakeOneTarget(
    targetId: string,
    targetSession: CdpTargetSession,
    input: WakeBrowserTargetsInput,
    options: ExecutionOptions,
  ): Promise<BrowserTargetWakeOutcome> {
    const startAtMs = Date.now();
    const outcome = (
      status: BrowserTargetWakeOutcome["status"],
      reloadSent: boolean,
      failureReason?: BrowserTargetWakeFailureReason,
    ): BrowserTargetWakeOutcome => ({
      target_id: targetId,
      status,
      elapsed_ms: Math.max(0, Date.now() - startAtMs),
      reload_sent: reloadSent,
      ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
    });

    const responsive = await wakeCommandOutcome(
      targetSession,
      "Page.enable",
      {},
      input.probe_deadline_ms,
      options.signal,
    );
    if (wakeAborted(options.signal))
      throw new AnalysisCancelledError("wake_browser_targets", {
        cause: options?.signal?.reason,
      });
    if (responsive.kind === "responsive") return outcome("awake", false);
    if (
      responsive.kind === "failed" &&
      (responsive.reason === "protocol_error" ||
        responsive.reason === "disconnected")
    )
      return outcome("unknown", false, responsive.reason);
    if (input.revive === "none") return outcome("unknown", false, "timeout");

    const wakeDeadlineAtMs = Date.now() + input.wake_deadline_ms;
    const reload = await wakeCommandOutcome(
      targetSession,
      "Page.reload",
      { ignoreCache: false },
      Math.min(
        input.probe_deadline_ms,
        Math.max(0, wakeDeadlineAtMs - Date.now()),
      ),
      options.signal,
    );
    if (wakeAborted(options.signal))
      throw new AnalysisCancelledError("wake_browser_targets", {
        cause: options?.signal?.reason,
      });
    const reloadSent = reload.kind === "responsive";
    if (reload.kind === "failed" && reload.reason !== "timeout")
      return outcome("unknown", reloadSent, reload.reason);
    const verified = await wakeVerifyResponsive(
      targetSession,
      wakeDeadlineAtMs,
      options.signal,
    );
    return verified === true
      ? outcome("awake_after_reload", reloadSent)
      : outcome("unknown", reloadSent, verified);
  }

  async #capture(
    input: InspectWebPageInput,
    options: ExecutionOptions,
    operation: "inspect_web_page" | "analyze_web_bundle",
  ): Promise<CapturedPage> {
    return await withTargetSession(
      input,
      operation,
      options,
      async (session) => await capturePage({ ...session, operation }),
      this.#owner,
      (captured) => captured.inspection,
    );
  }
}

/** Facts and transport handed to one target operation. */
interface CdpTargetOperationSession<Input> {
  readonly connection: CdpTargetSession["connection"];
  readonly sessionId: CdpTargetSession["sessionId"];
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: Input;
  readonly signal?: AbortSignal;
  readonly progress?: NonNullable<ExecutionOptions["progress"]>;
}

/** Authorize one discovered target, run work in its session, and close REA's socket. */
const withTargetSession = async <
  Input extends Pick<
    InspectWebPageInput,
    "cdp_endpoint" | "target_id" | "allowed_origins"
  >,
  Output,
>(
  input: Input,
  operation: BrowserObservationOperation,
  options: ExecutionOptions,
  work: (session: CdpTargetOperationSession<Input>) => Promise<Output>,
  owner: CdpTargetSessionOwner,
  partialObservation?: (output: Output) => AnalysisPartialObservation,
): Promise<Output> => {
  const endpoint = await openCdpEndpoint(
    input.cdp_endpoint,
    operation,
    options.signal,
    undefined,
    owner,
  );
  let targetSession: CdpTargetSession | undefined;
  let outcome: Result<Output, unknown>;
  let cleanupFailure: AnalysisError | undefined;
  try {
    const target = authorizeTarget(endpoint.discovery, input);
    const scopedInput = scopeToTargetOrigin(input, target);
    targetSession =
      endpoint.connection === undefined
        ? await openCdpTargetSession(
            endpoint.discovery,
            target,
            operation,
            options.signal,
            undefined,
            owner,
          )
        : await attachCdpTargetSession(
            endpoint.connection,
            target,
            operation,
            options.signal,
            owner,
          );
    outcome = ok(
      await work({
        connection: targetSession.connection,
        sessionId: targetSession.sessionId,
        discovery: endpoint.discovery,
        target,
        input: scopedInput,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.progress === undefined
          ? {}
          : { progress: options.progress }),
      }),
    );
  } catch (cause: unknown) {
    outcome = err(cause);
  }
  try {
    if (targetSession !== undefined)
      await closeCdpTargetSession(
        targetSession,
        CLEANUP_DOMAINS,
        options.signal,
        owner,
      );
    if (
      endpoint.connection !== undefined &&
      endpoint.connection !== targetSession?.connection
    )
      await owner.finish(endpoint.connection);
  } catch (cause: unknown) {
    cleanupFailure =
      cause instanceof AnalysisError
        ? cause
        : new ProviderCleanupError(
            "rea-cdp-browser",
            [input.target_id],
            { reason: cause instanceof Error ? cause.message : String(cause) },
            { operation, cause },
          );
  }

  if (outcome.ok && options.signal?.aborted === true)
    outcome = err(
      partialObservation === undefined
        ? new AnalysisCancelledError(operation, {
            cause: options.signal.reason,
          })
        : new AnalysisCancelledError(operation, {
            cause: options.signal.reason,
            partialObservation: partialObservation(outcome.value),
          }),
    );

  if (cleanupFailure !== undefined) {
    if (!outcome.ok && outcome.error instanceof AnalysisError)
      throw bindCdpTransportCleanup(
        cleanupFailure,
        analysisErrorWithCleanupFailure(
          outcome.error,
          cleanupFailure,
          operation,
        ),
      );
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, cleanupFailure],
        `CDP operation ${operation} failed and cleanup remains incomplete.`,
        { cause: outcome.error },
      );
    throw bindCdpTransportCleanup(
      cleanupFailure,
      new ProviderCleanupError(
        "rea-cdp-browser",
        cleanupFailure.cleanupResources,
        { cleanup_error: cleanupFailure.message },
        {
          operation,
          cause: cleanupFailure,
          ...(partialObservation === undefined
            ? {}
            : { partialObservation: partialObservation(outcome.value) }),
        },
      ),
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const selectTargets = (
  discovery: CdpEndpointDiscovery,
  allowedOrigins: ReadonlySet<string> | undefined,
): {
  readonly allowed: readonly BrowserTargetList["targets"][number][];
  readonly excluded: BrowserTargetList["excluded"];
  readonly unconnectable: number;
} => {
  const allowed = [];
  let disallowedOrigin = 0;
  let unsupportedUrl = 0;
  let nonPage = 0;
  let unconnectable = 0;
  for (const target of discovery.targets) {
    if (target.type !== "page") {
      nonPage += 1;
      continue;
    }
    const url = sanitizeBrowserUrl(target.url);
    if (url.origin === null) {
      unsupportedUrl += 1;
      continue;
    }
    if (allowedOrigins !== undefined && !allowedOrigins.has(url.origin)) {
      disallowedOrigin += 1;
      continue;
    }
    if (!hasCdpTargetWebSocket(discovery, target)) {
      unconnectable += 1;
      continue;
    }
    allowed.push({
      target_id: target.id,
      type: target.type,
      title: target.title,
      url: url.url,
      origin: url.origin,
      attached: target.attached,
    });
  }
  allowed.sort((left, right) =>
    compareUnicodeCodePoints(left.target_id, right.target_id),
  );
  return {
    allowed,
    excluded: {
      disallowed_origin: disallowedOrigin,
      unsupported_url: unsupportedUrl,
      non_page: nonPage,
    },
    unconnectable,
  };
};

const authorizeTarget = (
  discovery: CdpEndpointDiscovery,
  input: Pick<InspectWebPageInput, "target_id" | "allowed_origins">,
): CdpEndpointTarget => {
  return authorizeCdpTarget(discovery, input, "inspect_web_page").target;
};

const scopeToTargetOrigin = <T extends { allowed_origins: readonly string[] }>(
  input: T,
  target: CdpEndpointTarget,
): T => {
  if (input.allowed_origins.length > 0) return input;
  const origin = sanitizeBrowserUrl(target.url).origin;
  if (origin === null)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return { ...input, allowed_origins: [origin] };
};

const providerError = (
  cause: unknown,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): AnalysisError =>
  cause instanceof BrowserObservationError && cause.operation !== operation
    ? new BrowserObservationError(operation, cause.reason, { cause })
    : cause instanceof AnalysisError
      ? cause
      : signal?.aborted === true
        ? new AnalysisCancelledError(operation, { cause })
        : new ProviderAdapterError(
            CDP_BROWSER_PROVIDER_IDENTITY.id,
            operation,
            {
              cause,
            },
          );
