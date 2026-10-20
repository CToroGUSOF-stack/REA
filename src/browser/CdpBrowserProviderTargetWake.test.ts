import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "./CdpBrowserProvider.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../tests/fixtures/fakeCdpBrowser.js";
import { wakeBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { BrowserTargetWake } from "../domain/browserObservationSchemas.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";

const wake = async (
  browser: FakeCdpBrowser,
  overrides: Record<string, unknown> = {},
): Promise<Result<BrowserTargetWake, AnalysisError>> => {
  const provider = new CdpBrowserProvider();
  try {
    return await provider.wakeTargets(
      wakeBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_ids: ["allowed-page"],
        probe_deadline_ms: 200,
        wake_deadline_ms: 2000,
        ...overrides,
      }),
    );
  } finally {
    await provider.close();
  }
};

describe("CdpBrowserProvider wakeTargets classification", () => {
  it("classifies a responsive target without any reload", async () => {
    const browser = await startFakeCdpBrowser();
    try {
      const woken = await wake(browser);
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toEqual([
        {
          target_id: "allowed-page",
          status: "awake",
          elapsed_ms: expect.any(Number),
          reload_sent: false,
        },
      ]);
      expect(woken.value.results[0]?.elapsed_ms).toBeLessThan(1_000);
      expect(woken.value.limitations.length).toBe(1);
      expect(browser.discardedReloadCount()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("reports an unknown explicit timeout for a discarded target without reviving it", async () => {
    const browser = await startFakeCdpBrowser({
      discardedTargetIds: ["allowed-page"],
    });
    try {
      const woken = await wake(browser, { probe_deadline_ms: 120 });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toEqual([
        {
          target_id: "allowed-page",
          status: "unknown",
          elapsed_ms: expect.any(Number),
          reload_sent: false,
          failure_reason: "timeout",
        },
      ]);
      // Probe-only wake must not navigate the stalled target.
      expect(browser.discardedReloadCount()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("classifies missing targets without opening a session", async () => {
    const browser = await startFakeCdpBrowser();
    try {
      const woken = await wake(browser, { target_ids: ["missing-target"] });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toEqual([
        {
          target_id: "missing-target",
          status: "unknown",
          elapsed_ms: expect.any(Number),
          reload_sent: false,
          failure_reason: "target_not_found",
        },
      ]);
    } finally {
      await browser.close();
    }
  });

  it("classifies origin-filtered selections as not allowed", async () => {
    const browser = await startFakeCdpBrowser();
    try {
      const disallowed = await wake(browser, {
        target_ids: ["disallowed-page"],
        allowed_origins: [browser.allowedOrigin],
      });
      expect(disallowed.ok).toBe(true);
      if (disallowed.ok === false) return;
      expect(disallowed.value.results).toEqual([
        {
          target_id: "disallowed-page",
          status: "unknown",
          elapsed_ms: expect.any(Number),
          reload_sent: false,
          failure_reason: "target_not_allowed",
        },
      ]);
    } finally {
      await browser.close();
    }
  });

  it("classifies duplicate selections once with a limitation", async () => {
    const browser = await startFakeCdpBrowser();
    try {
      const woken = await wake(browser, {
        target_ids: ["allowed-page", "allowed-page"],
      });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toHaveLength(1);
      expect(woken.value.limitations).toContainEqual(
        "Duplicate target IDs were classified once.",
      );
    } finally {
      await browser.close();
    }
  });
});

describe("CdpBrowserProvider wakeTargets revival", () => {
  it("revives a discarded target through the caller-opted reload", async () => {
    const browser = await startFakeCdpBrowser({
      discardedTargetIds: ["allowed-page"],
      discardedReviveDelayMs: 40,
    });
    try {
      const woken = await wake(browser, {
        probe_deadline_ms: 120,
        wake_deadline_ms: 2_000,
        revive: "reload",
      });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toEqual([
        {
          target_id: "allowed-page",
          status: "awake_after_reload",
          elapsed_ms: expect.any(Number),
          reload_sent: true,
        },
      ]);
      expect(woken.value.results[0]?.elapsed_ms).toBeLessThan(2_000);
      expect(browser.discardedReloadCount()).toBe(1);
      // The close event lags the transport stop by a tick under load.
      await expect
        .poll(() => browser.activeConnectionCount(), { timeout: 2_000 })
        .toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("stays unknown when revival does not answer within the wake deadline", async () => {
    const browser = await startFakeCdpBrowser({
      discardedTargetIds: ["allowed-page"],
      discardedReviveDelayMs: 600,
    });
    try {
      const woken = await wake(browser, {
        probe_deadline_ms: 120,
        wake_deadline_ms: 150,
        revive: "reload",
      });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(woken.value.results).toEqual([
        {
          target_id: "allowed-page",
          status: "unknown",
          elapsed_ms: expect.any(Number),
          reload_sent: true,
          failure_reason: "timeout",
        },
      ]);
      expect(browser.discardedReloadCount()).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("classifies mixed selections in input order without reopening sockets", async () => {
    const browser = await startFakeCdpBrowser({
      discardedTargetIds: ["allowed-page"],
      discardedReviveDelayMs: 40,
      additionalPageWithWebSocket: true,
    });
    try {
      const woken = await wake(browser, {
        target_ids: ["allowed-page", "allowed-page-with-socket"],
        probe_deadline_ms: 120,
        revive: "reload",
      });
      expect(woken.ok).toBe(true);
      if (woken.ok === false) return;
      expect(
        woken.value.results.map((result) => [result.target_id, result.status]),
      ).toEqual([
        ["allowed-page", "awake_after_reload"],
        ["allowed-page-with-socket", "awake"],
      ]);
    } finally {
      await browser.close();
    }
  });
});

describe("CdpBrowserProvider wakeTargets cancellation", () => {
  it("keeps a pre-aborted call cancellation explicit", async () => {
    const browser = await startFakeCdpBrowser();
    try {
      const provider = new CdpBrowserProvider();
      const controller = new AbortController();
      controller.abort(new Error("caller cancelled first"));

      const woken = await provider.wakeTargets(
        wakeBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_ids: ["allowed-page"],
        }),
        { signal: controller.signal },
      );
      expect(woken.ok).toBe(false);
      if (woken.ok === true) return;
      expect(woken.error).toBeInstanceOf(AnalysisCancelledError);
      expect((woken.error as AnalysisCancelledError).operation).toBe(
        "wake_browser_targets",
      );
      await provider.close();
    } finally {
      await browser.close();
    }
  });
});
