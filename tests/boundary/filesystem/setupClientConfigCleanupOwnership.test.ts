import {
  lstat as fsLstat,
  mkdir,
  open as fsOpen,
  readFile,
  rename,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readClientRegistrationInspections,
  readClientRegistrationStatuses,
} from "../../../src/application/ClientRegistrationStatus.js";
import {
  existingMaintenanceScope,
  planIntegrationMaintenance,
} from "../../../src/application/UpdateMaintenance.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { ok } from "../../../src/domain/result.js";
import type { DoctorHost } from "../../../src/application/Doctor.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import {
  filterClientsNeedingConfigure,
  systemSetupHost,
} from "../../../src/application/SetupHost.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";
import { configureDetectedClients } from "../../../src/application/SetupClients.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import {
  systemUninstallHost,
  runUninstall,
} from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const openMock = vi.mocked(fsOpen);
const lstatMock = vi.mocked(fsLstat);
let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  openMock.mockImplementation((...args) => actualFs.open(...args));
  lstatMock.mockImplementation((...args) => actualFs.lstat(...args));
});

afterEach(() => {
  openMock.mockReset();
  lstatMock.mockReset();
});

const holdReadHandle = (
  path: string,
  reason: string,
  initiallyHeld = true,
  maxFailures = Number.POSITIVE_INFINITY,
) => {
  const closeAttempts: FileHandle[] = [];
  let released = false;
  let held = initiallyHeld;
  let remainingFailures = maxFailures;
  openMock.mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args);
    if (String(args[0]) !== path) return handle;
    const nativeClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeAttempts.push(handle);
      if (held && !released && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(reason);
      }
      await nativeClose();
    });
    return handle;
  });
  return {
    closeAttempts,
    hold: () => {
      held = true;
    },
    release: () => {
      released = true;
    },
  };
};

/** Linux setup host with its VS Code client configuration directory prepared. */
const preparedVsCodeSetupHost = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") },
  );
  const client = (await host.supportedClients()).find(
    ({ name }) => name === "vscode",
  );
  if (client === undefined) throw new Error("VS Code setup client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  return { home, host, client };
};

/** Release the held read handle and verify host cleanup retries that same owner. */
const expectCloseReclaimsHandle = async (
  host: { close?: () => Promise<string | undefined> },
  closeAttempts: readonly object[],
  release: () => void,
) => {
  const attemptsBeforeClose = closeAttempts.length;
  release();
  expect(await host.close?.()).toBeUndefined();
  expect(closeAttempts).toHaveLength(attemptsBeforeClose + 1);
  expect(closeAttempts.at(-1)).toBe(closeAttempts[0]);
};

/** Give up on the assertion path: release the handle and let cleanup close it. */
const cleanupHeldHandle = async (
  host: { close?: () => Promise<string | undefined> },
  release: () => void,
) => {
  release();
  await host.close?.();
};

it("retains invalid UTF-8 diagnostics and the uninstall read owner when close fails", async () => {
  const home = await createTestTempDirectory("rea-uninstall-utf8-close-");
  const path = join(home, "client.json");
  const original = Buffer.from([0xff]);
  await writeFile(path, original);
  const { closeAttempts, release } = holdReadHandle(
    path,
    "held uninstall handle",
  );
  const host = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    expect(
      await host.removeClient({
        name: "cursor",
        format: "json",
        configPath: path,
      }),
    ).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("not valid UTF-8"),
    });
    expect(await readFile(path)).toEqual(original);
    expect(closeAttempts).toHaveLength(3);
    expect(closeAttempts.every((handle) => handle === closeAttempts[0])).toBe(
      true,
    );
    await expectCloseReclaimsHandle(host, closeAttempts, release);
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

it("stops uninstall and retains the backup read owner when its close fails", async () => {
  const home = await createTestTempDirectory("rea-uninstall-backup-close-");
  const path = join(home, "client.json");
  const client = { name: "cursor", format: "json", configPath: path } as const;
  await writeFile(path, '{"keep":"before setup"}\n');
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "configured" });
  const configured = await readFile(path, "utf8");
  const { closeAttempts, release } = holdReadHandle(
    `${path}.rea.backup`,
    "held backup handle",
  );
  const host = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    expect(await host.removeClient(client)).toEqual({
      name: "cursor",
      status: "failed",
      detail:
        "Configuration could not be backed up, so no change was made. Check file permissions, then rerun uninstall.",
    });
    expect(await readFile(path, "utf8")).toBe(configured);
    expect(closeAttempts).toHaveLength(2);
    await expectCloseReclaimsHandle(host, closeAttempts, release);
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

it("keeps shared-ownership proof when the ownership read completes but its close fails", async () => {
  // FreeBuff without a profile marker leaves its shared storage applicability-
  // unverified. The completed ownership read is the proof that later read
  // failures are blocking; discarding it softens every failure to retained,
  // so purge runs while the active shared registration remains.
  const home = await createTestTempDirectory("rea-freebuff-ownership-close-");
  const setupHost = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home },
  );
  const client = (await setupHost.supportedClients()).find(
    ({ name }) => name === "freebuff",
  );
  if (client === undefined) throw new Error("freebuff client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(
    client.configPath,
    JSON.stringify({ mcpServers: { other: { command: "other" } } }),
  );
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "configured" });
  const state = join(home, ".rea", "state.json");
  await mkdir(dirname(state), { recursive: true });
  await writeFile(state, "{}\n");
  const { release } = holdReadHandle(
    client.configPath,
    "held ownership read handle",
  );
  const host = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    const result = await runUninstall(true, host);
    expect(result.status).toBe("failed");
    expect(result.items).toContainEqual(
      expect.objectContaining({ name: "freebuff", status: "failed" }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        name: "uninstall",
        status: "skipped",
        detail: expect.stringContaining(
          "No REA registration, skill, or data was removed",
        ),
      }),
    );
    // Data must not be purged while the shared registration is still active.
    await expect(readFile(state, "utf8")).resolves.toBe("{}\n");
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

it("keeps shared-ownership proof when removal refuses a shadowed duplicate", async () => {
  // The effective row is REA-owned while an earlier duplicate is foreign, so
  // removal refuses the edit. That refusal must not erase ownership: without
  // the positive row fact, recurring close failures soften to retained and
  // purge runs while the owned row remains active.
  const home = await createTestTempDirectory("rea-freebuff-shadowed-close-");
  const setupHost = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home },
  );
  const client = (await setupHost.supportedClients()).find(
    ({ name }) => name === "freebuff",
  );
  if (client === undefined) throw new Error("freebuff client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(
    client.configPath,
    '{"mcpServers":{"rea":{"command":"foreign-server","args":[]},"rea":{"command":"rea","args":["mcp"]}}}',
  );
  const state = join(home, ".rea", "state.json");
  await mkdir(dirname(state), { recursive: true });
  await writeFile(state, "{}\n");
  const { release } = holdReadHandle(
    client.configPath,
    "held ownership read handle",
  );
  const host = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    const result = await runUninstall(true, host);
    expect(result.status).toBe("failed");
    expect(result.items).toContainEqual(
      expect.objectContaining({ name: "freebuff", status: "failed" }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        name: "uninstall",
        status: "skipped",
        detail: expect.stringContaining(
          "No REA registration, skill, or data was removed",
        ),
      }),
    );
    await expect(readFile(state, "utf8")).resolves.toBe("{}\n");
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

it("stops removal when a completed reread leaves its handle unreleased", async () => {
  // Greptile P1: preflight and reread both complete with a foreign-only row,
  // but the reread handle cannot be closed even by the cleanup retry. REA
  // still owns that open handle, so removal must stop before purge: serving
  // the completed text would let removeAll delete managed data while the
  // incomplete cleanup is only reported later, by close().
  const home = await createTestTempDirectory("rea-freebuff-reread-leak-");
  const setupHost = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home },
  );
  const client = (await setupHost.supportedClients()).find(
    ({ name }) => name === "freebuff",
  );
  if (client === undefined) throw new Error("freebuff client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(
    client.configPath,
    '{"mcpServers":{"rea":{"command":"foreign-server","args":[]}}}',
  );
  const state = join(home, ".rea", "state.json");
  await mkdir(dirname(state), { recursive: true });
  await writeFile(state, "{}\n");
  const { hold, release } = holdReadHandle(
    client.configPath,
    "held removal reread handle",
    false,
  );
  const base = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  const host = {
    ...base,
    inspectSkill: async () => {
      hold();
      return base.inspectSkill?.();
    },
  };
  try {
    const result = await runUninstall(true, host);
    expect(result.status).toBe("failed");
    expect(result.items).toContainEqual(
      expect.objectContaining({
        name: "freebuff",
        status: "failed",
        detail: expect.stringContaining("its resources could not be released"),
      }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        name: "uninstall",
        status: "skipped",
        detail: expect.stringContaining("Uninstall stopped at this failure"),
      }),
    );
    // Managed data must survive an unreleased read handle.
    await expect(readFile(state, "utf8")).resolves.toBe("{}\n");
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

it("keeps the ZCode fallback row when its profile probe is unresolved", async () => {
  // A denied profile probe leaves ZCode's applicability unresolved, never
  // absent: the shared fallback must stay in ZCode's scope so its row is
  // inspected and removed, fail-closed, instead of leaving an installed
  // ZCode wired to purged data. Definitive absence still keeps ZCode out of
  // another product's primary storage.
  const home = await createTestTempDirectory("rea-zcode-fallback-unresolved-");
  const fallback = join(home, ".agents", "mcp.json");
  const profile = join(home, ".zcode", "cli");
  lstatMock.mockImplementation((path) =>
    String(path) === profile
      ? Promise.reject(
          Object.assign(new Error("EACCES: permission denied, lstat"), {
            code: "EACCES",
          }),
        )
      : actualFs.lstat(path),
  );
  const unresolved = systemUninstallHost(
    home,
    undefined,
    { HOME: home },
    "linux",
  );
  try {
    const clients = await unresolved.clients();
    const row = clients.find(
      (candidate) =>
        candidate.name === "zcode" && candidate.configPath === fallback,
    );
    expect(row).toMatchObject({ format: "zcode_fallback" });
    // Fail-closed: the unresolved row carries no unverified softening, so a
    // failed read blocks removal instead of retaining around the purge.
    expect(row?.applicability).toBeUndefined();
  } finally {
    await unresolved.close?.();
  }
  lstatMock.mockImplementation((...args) => actualFs.lstat(...args));
  const absent = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    const clients = await absent.clients();
    expect(
      clients.some(
        (candidate) =>
          candidate.name === "zcode" && candidate.format === "zcode_fallback",
      ),
    ).toBe(false);
  } finally {
    await absent.close?.();
  }
});

it("serves a completed removal reread when its close retry releases the handle", async () => {
  // Preflight saw no owned row; another writer adds one before removal. The
  // reread's first close fails but its cleanup retry releases the handle:
  // the completed text is the ownership evidence that drives removal of the
  // concurrently added row instead of softening to retained and leaving it
  // active while data is purged.
  const home = await createTestTempDirectory("rea-freebuff-reread-close-");
  const setupHost = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home },
  );
  const client = (await setupHost.supportedClients()).find(
    ({ name }) => name === "freebuff",
  );
  if (client === undefined) throw new Error("freebuff client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(
    client.configPath,
    '{"mcpServers":{"rea":{"command":"foreign-server","args":[]}}}',
  );
  const cacheOwned = join(home, ".rea", "cache", "owned");
  await mkdir(dirname(cacheOwned), { recursive: true });
  await writeFile(cacheOwned, "owned\n");
  const { hold, release } = holdReadHandle(
    client.configPath,
    "held removal reread handle",
    false,
    1,
  );
  const base = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  const host = {
    ...base,
    inspectSkill: async () => {
      // Another writer registers REA between preflight and removal.
      await writeFile(
        client.configPath,
        '{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}}}',
      );
      hold();
      return base.inspectSkill?.();
    },
  };
  try {
    const result = await runUninstall(true, host);
    expect(result.status).toBe("complete");
    expect(result.items).toContainEqual(
      expect.objectContaining({ name: "freebuff", status: "removed" }),
    );
    expect(await readFile(client.configPath, "utf8")).not.toContain("rea");
    await expect(readFile(cacheOwned)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

describe("ZCode fallback cleanup ownership", () => {
  it.each(["preflight", "configure"])(
    "retains a failed ZCode fallback close during %s until host cleanup",
    async (operation) => {
      const home = await createTestTempDirectory("rea-zcode-fallback-close-");
      const host = systemSetupHost(
        { platform: "linux", homeDirectory: home } as DoctorHost,
        { HOME: home },
      );
      const client = (await host.supportedClients()).find(
        ({ name }) => name === "zcode",
      );
      if (client?.zcodeFallbackPath === undefined)
        throw new Error("ZCode fallback path missing");
      const fallback = client.zcodeFallbackPath;
      await mkdir(dirname(fallback), { recursive: true });
      const original = '{"mcpServers":{"other":{"command":"other"}}}\n';
      await writeFile(fallback, original);
      const { closeAttempts, release } = holdReadHandle(
        fallback,
        "held fallback handle",
      );
      try {
        const action =
          operation === "preflight"
            ? host.inspectClientConfiguration?.(client, {}, ["rea", "mcp"])
            : host.configureClient(client, {}, ["rea", "mcp"]);
        if (action === undefined) throw new Error("setup preflight missing");
        await expect(action).rejects.toMatchObject({
          _tag: "ConfigurationError",
          cause: expect.any(RegularFileCleanupFailure),
          cleanup: { resources: [fallback] },
        });
        expect(closeAttempts).toHaveLength(2);
        expect(closeAttempts[0]).toBe(closeAttempts[1]);
        expect(await readFile(fallback, "utf8")).toBe(original);
        await expect(readFile(client.configPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expectCloseReclaimsHandle(host, closeAttempts, release);
      } finally {
        await cleanupHeldHandle(host, release);
      }
    },
  );
});

describe("setup client configuration cleanup ownership", () => {
  it.each([
    ["valid UTF-8", Buffer.from('{"servers": {"other": {}}}\n')],
    ["malformed UTF-8", Buffer.from([0xff])],
  ] as const)(
    "stops configuration and retains the %s read owner until host close",
    async (encoding, original) => {
      const { host, client } = await preparedVsCodeSetupHost(
        "rea-setup-config-close-",
      );
      await writeFile(client.configPath, original);

      const { closeAttempts, release } = holdReadHandle(
        client.configPath,
        "test holds the config handle open",
      );
      const configure = vi.spyOn(host, "configureClient");

      try {
        const failure = await filterClientsNeedingConfigure(
          host,
          [client],
          {},
          ["rea", "mcp"],
        )
          .then((detectedClients) =>
            configureDetectedClients({
              host,
              detectedClients,
              providerEnvironment: {},
              command: ["rea", "mcp"],
              clients: {},
              appliedActions: [],
            }),
          )
          .then(
            () => undefined,
            (cause: unknown) => cause,
          );
        expect(failure).toBeInstanceOf(ConfigurationError);
        if (encoding === "malformed UTF-8")
          expect(failure).toMatchObject({
            cause: {
              outcome: { kind: "failed", cause: expect.any(TypeError) },
            },
          });
        expect(failure).toMatchObject({
          _tag: "ConfigurationError",
          cause: expect.any(RegularFileCleanupFailure),
          cleanup: {
            resources: [client.configPath],
            reason: expect.stringContaining(
              "test holds the config handle open",
            ),
          },
        });
        expect(configure).not.toHaveBeenCalled();
        expect(closeAttempts).toHaveLength(2);
        expect(closeAttempts[0]).toBe(closeAttempts[1]);
        expect(await readFile(client.configPath)).toEqual(original);

        await expectCloseReclaimsHandle(host, closeAttempts, release);
      } finally {
        await cleanupHeldHandle(host, release);
      }
    },
  );

  it("waits for an admitted configuration read and rejects later admissions", async () => {
    const { host, client } = await preparedVsCodeSetupHost(
      "rea-setup-config-inflight-",
    );
    await writeFile(client.configPath, '{"servers": {}}\n');

    let beginRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      beginRead = resolve;
    });
    let unblockRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      unblockRead = resolve;
    });
    let heldRead = false;
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) !== client.configPath || heldRead) return handle;
      heldRead = true;
      const nativeRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        beginRead();
        await readGate;
        return nativeRead(...readArgs);
      });
      return handle;
    });

    let hostCloseFinished = false;
    let alignment: Promise<boolean> | undefined;
    try {
      alignment = host.clientNeedsConfigure(client, {}, ["rea", "mcp"]);
      await readStarted;

      const close = host.close;
      if (close === undefined) throw new Error("Setup host close is missing");
      const closeResult = close().then((result) => {
        hostCloseFinished = true;
        return result;
      });

      const lateAdmission = await host
        .clientNeedsConfigure(client, {}, ["rea", "mcp"])
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(lateAdmission).toBeInstanceOf(ConfigurationError);
      expect(lateAdmission).toMatchObject({
        message: expect.stringContaining("Artifact resource scope is closed"),
      });
      expect(hostCloseFinished).toBe(false);

      unblockRead();
      await expect(alignment).resolves.toBe(true);
      expect(await closeResult).toBeUndefined();
      expect(hostCloseFinished).toBe(true);
    } finally {
      unblockRead();
      await alignment?.catch(() => undefined);
      await host.close?.();
    }
  });
});

const unscopedRegistrationReaders: readonly {
  readonly name: string;
  readonly read: (
    home: string,
    environment: NodeJS.ProcessEnv,
    execute: Parameters<typeof planIntegrationMaintenance>[3],
  ) => Promise<unknown>;
}[] = [
  {
    name: "inspections",
    read: (home, environment) =>
      readClientRegistrationInspections(home, "/current/rea", { environment }),
  },
  {
    name: "statuses",
    read: (home, environment) =>
      readClientRegistrationStatuses(home, "/current/rea", { environment }),
  },
  {
    name: "maintenance scope",
    read: (home, environment) =>
      existingMaintenanceScope(home, "/current/rea", environment),
  },
  {
    name: "maintenance plan",
    read: (home, environment, execute) =>
      planIntegrationMaintenance(home, "/current/rea", environment, execute),
  },
];

it.each(
  unscopedRegistrationReaders.flatMap((reader) =>
    ["configuration", "policy"].flatMap((source) =>
      ["completed", "failed"].map((readOutcome) => ({
        ...reader,
        source,
        readOutcome,
      })),
    ),
  ),
)(
  "$name transfers the exact $source owner after a $readOutcome read without a supplied scope",
  async ({ read, source, readOutcome }) => {
    const home = await createTestTempDirectory(
      "rea-registration-unscoped-close-",
    );
    const config = join(
      home,
      source === "policy" ? ".gemini/settings.json" : ".cursor/mcp.json",
    );
    await mkdir(dirname(config), { recursive: true });
    const registration =
      '{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}}}\n';
    await writeFile(config, registration);
    const heldPath = source === "policy" ? join(home, "system.json") : config;
    const heldText = source === "policy" ? "{}\n" : registration;
    await writeFile(
      heldPath,
      readOutcome === "failed" ? Buffer.from([0xff]) : heldText,
    );
    const environment = {
      HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system.json"),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "absent-defaults.json"),
    };
    const held = holdReadHandle(
      heldPath,
      "held standalone registration descriptor",
    );
    const execute = vi.fn(async () =>
      ok('{"status":"planned","plannedActions":[]}'),
    );
    try {
      const outcome = await read(home, environment, execute).then(
        (value) => ({ kind: "returned" as const, value }),
        (cause: unknown) => ({ kind: "threw" as const, cause }),
      );
      expect(outcome).toMatchObject({
        kind: "threw",
        cause: expect.any(RegularFileCleanupFailure),
      });
      if (
        outcome.kind !== "threw" ||
        !(outcome.cause instanceof RegularFileCleanupFailure)
      )
        throw new Error("Read lost its failed cleanup owner");
      const failure = outcome.cause;
      expect(failure.path).toBe(heldPath);
      if (readOutcome === "completed")
        expect(failure.outcome).toEqual({ kind: "completed", value: heldText });
      else
        expect(failure.outcome).toMatchObject({
          kind: "failed",
          cause: { _tag: "InvalidUtf8FileError", path: heldPath },
        });
      expect(failure.owner.handle).toBe(held.closeAttempts[0]);
      await expect(failure.owner.close()).rejects.toThrow("held standalone");
      await rename(heldPath, `${heldPath}.retired`);
      await writeFile(heldPath, "replacement");
      held.release();
      await failure.owner.close();
      expect(failure.owner.handle.fd).toBe(-1);
      expect(new Set(held.closeAttempts).size).toBe(1);
      expect(await readFile(heldPath, "utf8")).toBe("replacement");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      held.release();
      for (const handle of new Set(held.closeAttempts)) await handle.close();
    }
  },
);

it("keeps a supplied registration scope responsible for diagnostics and cleanup retry", async () => {
  const home = await createTestTempDirectory("rea-registration-scoped-close-");
  const config = join(home, ".cursor/mcp.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    '{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}}}',
  );
  const held = holdReadHandle(config, "held scoped registration descriptor");
  const resources = new ArtifactResourceScope();
  try {
    expect(
      (
        await readClientRegistrationStatuses(home, "/current/rea", {
          environment: { HOME: home },
          resources,
        })
      ).find((status) => status.client === "cursor"),
    ).toMatchObject({ state: "invalid", command: [] });
    expect(resources.hasPending).toBe(true);
    await expect(resources.close()).rejects.toThrow();
    held.release();
    await resources.close();
    expect(resources.hasPending).toBe(false);
    expect(new Set(held.closeAttempts).size).toBe(1);
    expect(held.closeAttempts[0]!.fd).toBe(-1);
  } finally {
    held.release();
    await resources.close();
  }
});
