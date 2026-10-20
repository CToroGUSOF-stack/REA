import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, rm, access, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import {
  attachedScenarioLeaseKey,
  failBrowserScenarioOperation,
  openPlaywrightScenarioBrowser,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";

const hostPlatform = process.platform;

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: hostPlatform });
});

it("locks one attached browser for spellings that discover the same endpoint", () => {
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222/", "page-1"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-2"),
  );
});

it("locks one attached browser across loopback spellings of one endpoint", () => {
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).toBe(
    attachedScenarioLeaseKey("http://[::1]:9222", "page-1"),
  );
  expect(attachedScenarioLeaseKey("http://[::1]:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://[::1]:9222", "page-2"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9223", "page-1"),
  );
});

const deferred = <Value>() => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

it("passes the selected environment to the actual browser launch boundary", async () => {
  vi.stubEnv("LANG", "ambient-language");
  const selected = {
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PRIVATE_VALUE: "not-a-launch-setting",
  };
  let launchedEnvironment: unknown;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });
  await expect(
    openPlaywrightScenarioBrowser(scenario, selected, {
      launcher: {
        connectOverCDP: async () => {
          throw new Error("Unexpected connection");
        },
        launchPersistentContext: async (_profile, options) => {
          launchedEnvironment = options?.env;
          throw new Error("launch boundary reached");
        },
      },
    }),
  ).rejects.toThrow("launch boundary reached");
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
  });
});

const androidLaunchScenario = (executablePath: string) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: executablePath },
    start_url: { url: "https://example.test" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });

const captureAndroidLaunch = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  Object.defineProperty(process, "platform", { value: "android" });
  let launchedProfile: string | undefined;
  let launchOptions: Parameters<
    typeof import("playwright-core").chromium.launchPersistentContext
  >[1];
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(process.execPath),
      environment,
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (profile, options) => {
            launchedProfile = profile;
            launchOptions = options;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toThrow("launch boundary reached");
  return { launchedProfile, launchOptions };
};

it.each([
  {
    name: "uses the Termux prefix when no temp directory is selected",
    variables: {},
    parent: "prefix" as const,
    forwarded: { TMPDIR: "prefix" as const },
  },
  {
    name: "keeps a caller-selected TMPDIR",
    variables: { TMPDIR: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMPDIR: "explicit" as const },
  },
  {
    name: "uses TMP when TMPDIR is absent",
    variables: { TMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMP: "explicit" as const, TMPDIR: "explicit" as const },
  },
  {
    name: "uses TEMP when TMPDIR and TMP are absent",
    variables: { TEMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TEMP: "explicit" as const, TMPDIR: "explicit" as const },
  },
  {
    name: "prefers TMPDIR over TMP and TEMP",
    variables: {
      TMPDIR: "explicit" as const,
      TMP: "other" as const,
      TEMP: "other" as const,
    },
    parent: "explicit" as const,
    forwarded: {
      TMPDIR: "explicit" as const,
      TMP: "other" as const,
      TEMP: "other" as const,
    },
  },
  {
    name: "treats an empty TMPDIR as unset and uses TMP",
    variables: { TMPDIR: "" as const, TMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMPDIR: "explicit" as const, TMP: "explicit" as const },
  },
  {
    name: "treats empty temp variables as unset and uses the Termux prefix",
    variables: { TMPDIR: "" as const, TMP: "" as const, TEMP: "" as const },
    parent: "prefix" as const,
    forwarded: {
      TMPDIR: "prefix" as const,
      TMP: "" as const,
      TEMP: "" as const,
    },
  },
])(
  "keeps Termux Chromium on a writable temp directory: $name",
  async ({ variables, parent, forwarded }) => {
    const root = await createTestTempDirectory("rea-termux-temp-");
    const prefix = join(root, "usr");
    const paths = {
      explicit: join(root, "explicit-tmp"),
      other: join(root, "other-tmp"),
      prefix: join(prefix, "tmp"),
    };
    const resolvePath = (
      token: "" | "explicit" | "other" | "prefix",
    ): string => (token === "" ? "" : paths[token]);
    const selected = {
      LANG: "selected-language",
      PREFIX: prefix,
      ...Object.fromEntries(
        Object.entries(variables).map(([name, token]) => [
          name,
          resolvePath(token),
        ]),
      ),
    };
    const { launchedProfile, launchOptions } =
      await captureAndroidLaunch(selected);
    expect(launchedProfile?.startsWith(paths[parent])).toBe(true);
    expect(launchOptions?.args).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
    ]);
    expect(launchOptions?.env).toEqual({
      LANG: "selected-language",
      LD_PRELOAD: `${prefix}/lib/libtermux-exec.so`,
      TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
      ...Object.fromEntries(
        Object.entries(forwarded).map(([name, token]) => [
          name,
          resolvePath(token),
        ]),
      ),
    });
  },
);

it("does not let a stuck Android launch block later launches", async () => {
  const firstRoot = await createTestTempDirectory("rea-termux-stuck-a-");
  const secondRoot = await createTestTempDirectory("rea-termux-stuck-b-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  const nodeOs = createRequire(import.meta.url)("node:os") as {
    tmpdir: () => string;
  };
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  let firstLookup: string | undefined;
  let firstLookupAfterWait: string | undefined;
  let secondLookup: string | undefined;
  const opening = (root: string, onLaunch: () => Promise<void>) =>
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(process.execPath),
      { PREFIX: root, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async () => {
            await onLaunch();
            throw new Error("launch boundary reached");
          },
        },
      },
    );
  const first = opening(firstRoot, async () => {
    firstLookup = nodeOs.tmpdir();
    firstEntered.resolve(undefined);
    await releaseFirst.promise;
    firstLookupAfterWait = nodeOs.tmpdir();
  });
  try {
    await firstEntered.promise;
    await expect(
      opening(secondRoot, async () => {
        secondLookup = nodeOs.tmpdir();
      }),
    ).rejects.toThrow("launch boundary reached");
  } finally {
    releaseFirst.resolve(undefined);
  }
  await expect(first).rejects.toThrow("launch boundary reached");
  expect(firstLookup).toBe(join(firstRoot, "tmp"));
  expect(firstLookupAfterWait).toBe(join(firstRoot, "tmp"));
  expect(secondLookup).toBe(join(secondRoot, "tmp"));
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

it("places Playwright's host artifact directory on the Termux temp directory", async () => {
  await import("playwright-core");
  const prefix = await createTestTempDirectory("rea-termux-host-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(prefix, "missing-chromium")),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
    ),
  ).rejects.toThrow(/executable doesn't exist/);
  expect(
    (await readdir(join(prefix, "tmp"))).some((name) =>
      name.startsWith("playwright-artifacts-"),
    ),
  ).toBe(true);
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

it("publishes a writable Playwright browsers path before an Android launch", async () => {
  const prefix = await createTestTempDirectory("rea-termux-playwright-");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "");
  Object.defineProperty(process, "platform", { value: "android" });
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(prefix, "missing-chromium")),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
    ),
  ).rejects.toThrow(/executable doesn't exist/);
  expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
    join(prefix, "tmp", "ms-playwright"),
  );
});

it("launches Termux Chromium from the binary next to its ICU data", async () => {
  const prefix = await createTestTempDirectory("rea-termux-icu-");
  const wrapper = join(prefix, "bin", "chromium-browser");
  const chrome = join(prefix, "lib", "chromium", "chrome");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(prefix, "lib", "chromium"), { recursive: true });
  await writeFile(wrapper, "#!/bin/sh\n");
  await writeFile(chrome, "#!/bin/sh\n");
  Object.defineProperty(process, "platform", { value: "android" });
  let executablePath: string | undefined;
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(wrapper),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            executablePath = options?.executablePath;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toThrow("launch boundary reached");
  expect(executablePath).toBe(chrome);
});

it("keeps a caller-selected Android browser that is not Termux Chromium", async () => {
  const prefix = await createTestTempDirectory("rea-termux-custom-");
  const selected = join(prefix, "bin", "custom-chromium");
  const chrome = join(prefix, "lib", "chromium", "chrome");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(prefix, "lib", "chromium"), { recursive: true });
  await writeFile(selected, "#!/bin/sh\n");
  await writeFile(chrome, "#!/bin/sh\n");
  Object.defineProperty(process, "platform", { value: "android" });
  let executablePath: string | undefined;
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(selected),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            executablePath = options?.executablePath;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toThrow("launch boundary reached");
  expect(executablePath).toBe(selected);
});

it("places each overlapping Playwright artifact directory in its own Termux temp", async () => {
  await import("playwright-core");
  const firstRoot = await createTestTempDirectory("rea-termux-artifacts-a-");
  const secondRoot = await createTestTempDirectory("rea-termux-artifacts-b-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  const launch = (root: string) =>
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(root, "missing-chromium")),
      { PREFIX: root, TMPDIR: "", TMP: "", TEMP: "" },
    );
  const settled = await Promise.allSettled([
    launch(firstRoot),
    launch(secondRoot),
  ]);
  expect(settled.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  for (const result of settled)
    if (result.status === "rejected")
      expect(result.reason).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/executable doesn't exist/),
        }),
      );
  const artifactCount = async (root: string) =>
    (await readdir(join(root, "tmp"))).filter((name) =>
      name.startsWith("playwright-artifacts-"),
    ).length;
  expect(await artifactCount(firstRoot)).toBe(1);
  expect(await artifactCount(secondRoot)).toBe(1);
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

it("keeps attached-target ownership after the cleanup response timeout", async () => {
  vi.useFakeTimers();
  try {
    const closeStarted = deferred<void>();
    const closeResult = deferred<void>();
    const settled: boolean[] = [];
    const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: () => {
        closeStarted.resolve(undefined);
        return closeResult.promise;
      },
      removeProfile: undefined,
      onSettled: (browserClosed) => settled.push(browserClosed),
    });
    const timedOutClose = cleanup.close();
    let timedOutFailure: unknown;
    void timedOutClose.catch((cause: unknown) => {
      timedOutFailure = cause;
    });
    const timeoutExpectation = expect(timedOutClose).rejects.toMatchObject({
      reason: "cleanup_failed",
      cleanup: { reason: expect.stringContaining("timed out") },
    });
    await closeStarted.promise;
    let responseSettled = false;
    void timedOutClose
      .finally(() => {
        responseSettled = true;
      })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(29_999);
    expect(responseSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutExpectation;
    expect(settled).toEqual([]);

    closeResult.resolve(undefined);
    await cleanup.close();
    expect(settled).toEqual([true]);
    expect(timedOutFailure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
  } finally {
    vi.useRealTimers();
  }
});

it("does not configure a late attached connection after cancellation", async () => {
  const connection =
    deferred<Pick<Browser, "contexts" | "close" | "isConnected" | "version">>();
  const connectionStarted = deferred<void>();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    version: () => "fixture",
  };
  const controller = new AbortController();
  const launcher = {
    connectOverCDP: () => {
      connectionStarted.resolve(undefined);
      return connection.promise;
    },
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher,
      signal: controller.signal,
    },
  );
  await connectionStarted.promise;
  controller.abort();
  connection.resolve(connectedBrowser);

  await expect(opening).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
  });
  expect(connectedBrowser.contexts).not.toHaveBeenCalled();
  expect(connectedBrowser.close).toHaveBeenCalledOnce();
});

it("closes an attached connection when cancellation starts target discovery", async () => {
  const controller = new AbortController();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => {
      controller.abort();
      return [];
    }),
    isConnected: vi.fn(() => true),
    version: () => "fixture",
  };
  const launcher = {
    connectOverCDP: async () => connectedBrowser,
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });

  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher,
        signal: controller.signal,
      },
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  expect(connectedBrowser.contexts).toHaveBeenCalledOnce();
  expect(connectedBrowser.close).toHaveBeenCalledOnce();
});

const attachedBrowserFixture = (
  callbacks: {
    readonly send?: (method: string, parameters?: unknown) => Promise<unknown>;
    readonly emulateMedia?: (
      options: Parameters<Page["emulateMedia"]>[0],
    ) => Promise<void>;
    readonly detach?: () => Promise<void>;
    readonly closeBrowser?: () => Promise<void>;
    readonly isTargetClosed?: () => boolean;
    readonly isBrowserConnected?: () => boolean;
  } = {},
) => {
  const discoverySession = {
    send: vi.fn(async () => ({ targetInfo: { targetId: "page-1" } })),
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
  const environmentSession = {
    send: vi.fn(callbacks.send ?? (async () => undefined)),
    detach: vi.fn(callbacks.detach ?? (async () => undefined)),
  } as unknown as CDPSession;
  const page = {
    emulateMedia: vi.fn(callbacks.emulateMedia ?? (async () => undefined)),
    isClosed: vi.fn(callbacks.isTargetClosed ?? (() => false)),
  } as unknown as Page;
  const context = {
    pages: () => [page],
    newCDPSession: vi
      .fn()
      .mockResolvedValueOnce(discoverySession)
      .mockResolvedValueOnce(environmentSession),
  } as unknown as BrowserContext;
  const browser = {
    close: vi.fn(callbacks.closeBrowser ?? (async () => undefined)),
    contexts: () => [context],
    isConnected: vi.fn(callbacks.isBrowserConnected ?? (() => true)),
    version: () => "fixture",
  } as unknown as Pick<
    Browser,
    "contexts" | "close" | "isConnected" | "version"
  >;
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  return {
    browser,
    environmentSession,
    page,
    open: (signal?: AbortSignal) =>
      openPlaywrightScenarioBrowser(
        scenario,
        {},
        {
          launcher: {
            connectOverCDP: async () => browser,
            launchPersistentContext: async () => {
              throw new Error("Unexpected launch");
            },
          },
          signal,
        },
      ),
  };
};

it("restores its environment overrides before releasing an attached browser", async () => {
  const cleanupOrder: string[] = [];
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        cleanupOrder.push("timezone");
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === ""
      )
        cleanupOrder.push("locale");
      if (method === "Emulation.clearDeviceMetricsOverride")
        cleanupOrder.push("device-metrics");
    },
    emulateMedia: async (options) => {
      if (options?.colorScheme === null) cleanupOrder.push("media");
    },
    detach: async () => {
      cleanupOrder.push("session");
    },
    closeBrowser: async () => {
      cleanupOrder.push("browser");
    },
  });
  const opened = await fixture.open();
  await opened.cleanup.close();

  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "en-US" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setTimezoneOverride",
    { timezoneId: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.clearDeviceMetricsOverride",
  );
  expect(fixture.page.emulateMedia).toHaveBeenLastCalledWith({
    colorScheme: null,
    reducedMotion: null,
  });
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
  expect(cleanupOrder).toEqual([
    "timezone",
    "locale",
    "device-metrics",
    "media",
    "session",
    "browser",
  ]);
});

it("retains attached environment ownership until a failed reset can be retried", async () => {
  let localeResetAttempts = 0;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === ""
      ) {
        localeResetAttempts += 1;
        if (localeResetAttempts === 1) throw new Error("reset interrupted");
      }
    },
  });
  const opened = await fixture.open();

  await expect(opened.cleanup.close()).rejects.toMatchObject({
    reason: "cleanup_failed",
    cleanup: { reason: "reset interrupted" },
  });
  expect(fixture.browser.close).not.toHaveBeenCalled();
  expect(fixture.environmentSession.detach).not.toHaveBeenCalled();

  await opened.cleanup.close();
  expect(localeResetAttempts).toBe(2);
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("does not clear an attached environment override it failed to acquire", async () => {
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      )
        throw new Error("caller already owns locale");
    },
  });

  await expect(fixture.open()).rejects.toThrow("caller already owns locale");
  expect(fixture.environmentSession.send).not.toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.clearDeviceMetricsOverride",
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("waits for a cancelled environment mutation before restoring it", async () => {
  const localeStarted = deferred<void>();
  const localeResult = deferred<void>();
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      ) {
        localeStarted.resolve(undefined);
        await localeResult.promise;
      }
    },
  });
  const controller = new AbortController();
  const opening = fixture.open(controller.signal);
  await localeStarted.promise;
  const cancelled = expect(opening).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(fixture.environmentSession.send).not.toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );

  localeResult.resolve(undefined);
  await cancelled;
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("releases cleanup ownership when the attached target is destroyed", async () => {
  let targetClosed = false;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        targetClosed &&
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        throw new Error("Target closed");
    },
    isTargetClosed: () => targetClosed,
  });
  const opened = await fixture.open();
  targetClosed = true;

  await opened.cleanup.close();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("releases cleanup ownership when the attached browser disconnects", async () => {
  let connected = true;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        !connected &&
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        throw new Error("Browser disconnected");
    },
    isBrowserConnected: () => connected,
  });
  const opened = await fixture.open();
  connected = false;

  await opened.cleanup.close();
  expect(fixture.browser.close).not.toHaveBeenCalled();
});

it("cancels same-target queued connection before acquiring a browser", async () => {
  const makeScenario = (targetId: string) =>
    browserScenarioSchema.parse({
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: targetId,
      },
      start_url: { url: "https://example.test" },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
    });
  let rejectFirst: ((cause: Error) => void) | undefined;
  const firstConnection = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  let resolveFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const endpoints: string[] = [];
  const connectOverCDP = vi.fn((endpoint: string) => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) {
      resolveFirstStarted?.();
      return firstConnection;
    }
    return Promise.reject(new Error("connection failed"));
  });
  const launchPersistentContext = vi.fn(async () => {
    throw new Error("launch boundary reached");
  });
  const launcher = { connectOverCDP, launchPersistentContext };
  const environment = {};
  const first = openPlaywrightScenarioBrowser(
    makeScenario("page-1"),
    environment,
    { launcher },
  );
  await firstStarted;
  expect(connectOverCDP).toHaveBeenCalledTimes(1);

  const controller = new AbortController();
  const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
  const queued = openPlaywrightScenarioBrowser(
    makeScenario("page-1"),
    environment,
    { launcher, signal: controller.signal },
  );
  controller.abort();
  await expect(queued).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
  });
  expect(connectOverCDP).toHaveBeenCalledTimes(1);
  expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));

  await expect(
    openPlaywrightScenarioBrowser(makeScenario("page-2"), environment, {
      launcher,
    }),
  ).rejects.toThrow("connection failed");
  expect(connectOverCDP).toHaveBeenCalledTimes(2);

  const launch = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  await expect(
    openPlaywrightScenarioBrowser(launch, environment, { launcher }),
  ).rejects.toThrow("launch boundary reached");
  expect(launchPersistentContext).toHaveBeenCalledTimes(1);

  if (rejectFirst === undefined)
    throw new Error("first connection did not begin");
  rejectFirst(new Error("first connection failed"));
  await expect(first).rejects.toThrow("first connection failed");
  await expect(
    openPlaywrightScenarioBrowser(makeScenario("page-1"), environment, {
      launcher,
    }),
  ).rejects.toThrow("connection failed");
  expect(connectOverCDP).toHaveBeenCalledTimes(3);
});

it("serializes concurrent attach across loopback spellings of one browser", async () => {
  const makeScenario = (endpoint: string) =>
    browserScenarioSchema.parse({
      browser: { mode: "connect", cdp_endpoint: endpoint, target_id: "page-1" },
      start_url: { url: "https://example.test" },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
    });
  const firstConnection =
    deferred<Pick<Browser, "contexts" | "close" | "isConnected" | "version">>();
  let rejectFirstConnection: ((cause: Error) => void) | undefined;
  const failingConnection = new Promise<never>((_resolve, reject) => {
    rejectFirstConnection = reject;
  });
  const firstStarted = deferred<void>();
  const endpoints: string[] = [];
  const connectOverCDP = vi.fn((endpoint: string) => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) {
      firstStarted.resolve(undefined);
      return firstConnection.promise;
    }
    return failingConnection;
  });
  const launcher = {
    connectOverCDP,
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };

  const first = openPlaywrightScenarioBrowser(
    makeScenario("http://127.0.0.1:9222"),
    {},
    { launcher },
  );
  await firstStarted.promise;

  const second = openPlaywrightScenarioBrowser(
    makeScenario("http://[::1]:9222"),
    {},
    { launcher },
  );
  const race = await Promise.race([
    second.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise((resolve) => setTimeout(() => resolve("queued"), 100)),
  ]);
  // The loopback spelling is the same browser, so the second attach must wait
  // for the lease instead of dialing in parallel and being rejected.
  expect(race).toBe("queued");
  expect(connectOverCDP).toHaveBeenCalledTimes(1);

  firstConnection.resolve({
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    version: () => "fixture",
  });
  await expect(first).rejects.toThrow();
  if (rejectFirstConnection === undefined)
    throw new Error("second connection did not begin");
  rejectFirstConnection(new Error("second connection failed"));
  await expect(second).rejects.toThrow("second connection failed");
  expect(endpoints).toEqual(["http://127.0.0.1:9222", "http://[::1]:9222"]);
});

it("tracks only pending browser cleanup resources and resolves prior errors after exact recovery", async () => {
  const root = await createTestTempDirectory("rea-browser-cleanup-recovery-");
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "authored-data"), "profile control");
  let browserDenied = true;
  let profileDenied = true;
  let browserCloses = 0;
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async () => {
      browserCloses++;
      if (browserDenied) throw new Error("controlled transport close failure");
    },
    removeProfile: async () => {
      if (profileDenied) throw new Error("controlled profile removal failure");
      await rm(profile, { recursive: true });
    },
  });
  try {
    const first: unknown = await owner.close().catch((cause: unknown) => cause);
    expect(first).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_transport", "browser_profile"],
    });
    browserDenied = false;
    const second: unknown = await owner
      .close()
      .catch((cause: unknown) => cause);
    expect(owner.browserClosed).toBe(true);
    for (const error of [first, second])
      expect(error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["browser_profile"],
      });
    await access(profile);
    profileDenied = false;
    await owner.close();
    await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
    for (const error of [first, second])
      expect(error).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    expect(browserCloses).toBe(2);
  } finally {
    browserDenied = false;
    profileDenied = false;
    await owner.close();
  }
});

it("bounds an opening failure response while retaining the same late cleanup lease", async () => {
  vi.useFakeTimers();
  let acknowledge: () => void = () => {};
  const late = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const lease = new AnalysisCleanupLease(() => late, ["browser_profile"]);
  const reason = { caller: "cancelled opening" };
  const primary = new AnalysisCancelledError("capture_browser_scenario", {
    cause: reason,
  });
  try {
    const opening = failBrowserScenarioOperation(lease, primary).catch(
      (cause: unknown) => cause,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await opening;
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_profile"],
    });
    expect(lease.released).toBe(false);
    acknowledge();
    await lease.release();
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected typed cleanup failure");
    expect(projectAnalysisError(failure)).toMatchObject({ code: "cancelled" });
    expect(primary.cause).toBe(reason);
  } finally {
    acknowledge();
    await lease.release();
    vi.useRealTimers();
  }
});
