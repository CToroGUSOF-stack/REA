import { dirname } from "node:path";
import { z } from "zod";

import type { OptionalProviderReadiness } from "../domain/OptionalProviderReadiness.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";

// Resolve from the installation being checked, not this updater's cached modules.
// Import only: never create a device manager, enumerate devices or control a target.
const probe = String.raw`
import { createRequire, findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const report = (result) => process.stdout.write(JSON.stringify(result), () => process.exit(0));
const root = pathToFileURL(join(process.argv[1], "package.json"));
const check = async () => {
  let manifest;
  let installScript = false;
  try {
    manifest = findPackageJSON("frida", root);
    if (manifest !== undefined) {
      const metadata = JSON.parse(await readFile(manifest, "utf8"));
      installScript = typeof metadata?.scripts?.install === "string" && metadata.scripts.install.length > 0;
    }
  } catch (cause) {
    return { status: cause?.code === "ERR_MODULE_NOT_FOUND" ? "absent" : "unknown", detail: String(cause) };
  }
  try {
    const entry = createRequire(root).resolve("frida");
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.getDeviceManager !== "function") throw new TypeError("Frida does not export getDeviceManager.");
    return { status: "ready" };
  } catch (cause) {
    return { status: "unavailable", detail: String(cause), ...(manifest === undefined || !installScript ? {} : { manifest }) };
  }
};
report(await check());
`;

const responseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("absent"), detail: z.string() }),
  z.object({ status: z.literal("unknown"), detail: z.string() }),
  z.object({
    status: z.literal("unavailable"),
    detail: z.string(),
    manifest: z.string().optional(),
  }),
]);

/** Check only whether the installed Frida native module can load in a fresh Node process. */
export const fridaBindingReadiness = async (
  packageRoot: string,
  manager: "npm" | "bun",
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<OptionalProviderReadiness> => {
  const identity = { provider: "frida", scope: "native-module" } as const;
  const unknown = (detail: string): OptionalProviderReadiness => ({
    ...identity,
    status: "unknown",
    reason: "probe-failed",
    detail,
    remediation:
      "Frida native module readiness could not be checked. Inspect the diagnostic, then rerun rea update.",
  });
  try {
    const output = await execFileOutput(
      process.execPath,
      ["--input-type=module", "-e", probe, packageRoot],
      {
        cwd: packageRoot,
        env: environment,
        windowsHide: true,
        timeout: 10_000,
        stopSignal: "SIGTERM",
        maxBuffer: 64 * 1024,
      },
    );
    const decoded = safeParseJson(output.stdout);
    if (!decoded.ok) return unknown(decoded.error);
    const parsed = responseSchema.safeParse(decoded.value);
    if (!parsed.success)
      return unknown("Frida readiness probe returned an invalid response.");
    const result = parsed.data;
    if (result.status === "ready") return { ...identity, status: "ready" };
    if (result.status === "unknown") return unknown(result.detail);
    if (result.status === "absent")
      return {
        ...identity,
        status: "unavailable",
        reason: "dependency-absent",
        detail: result.detail,
        remediation:
          "Frida is not installed. Reinstall REA with its owning package manager, including optional dependencies, to use Frida instrumentation; then rerun rea update.",
      };
    const fridaRoot =
      result.manifest === undefined ? undefined : dirname(result.manifest);
    return {
      ...identity,
      status: "unavailable",
      reason: "module-load-failed",
      detail: result.detail,
      remediation:
        fridaRoot === undefined
          ? "Frida could not load. Inspect the diagnostic and repair this installation, then rerun rea update."
          : "Frida could not load. Run the recovery command in its working directory to execute Frida's install script (it may download or build its native binding), then rerun rea update. Other dependency install scripts remain disabled during updates.",
      ...(fridaRoot === undefined
        ? {}
        : {
            recovery: {
              command:
                manager === "npm"
                  ? [
                      "npm",
                      "--prefix",
                      fridaRoot,
                      "run",
                      "install",
                      "--ignore-scripts=false",
                    ]
                  : ["bun", "run", "--cwd", fridaRoot, "install"],
              workingDirectory: packageRoot,
            },
          }),
    };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const capture = execFileOutputFailure(cause);
    if (capture === undefined) return unknown(message);
    const { stdout, stderr, ...metadata } = capture;
    return unknown(
      `${message}\nProcess: ${JSON.stringify(metadata)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
};
