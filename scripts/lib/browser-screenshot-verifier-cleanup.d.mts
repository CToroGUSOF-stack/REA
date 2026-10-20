import type { VerifierRun, VerifierRunStart } from "./verifier-run.mjs";

export function finishScreenshotVerifier(
  run: VerifierRunStart,
  workspace: string,
  closeTasks: readonly (() => void | Promise<void>)[],
  failures?: readonly unknown[],
): Promise<VerifierRun>;
