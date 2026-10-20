import { describe, expect, it } from "vitest";

import { dylibResolutionInputSchema } from "./apple/dylibResolution.js";
import { processScenarioSchema } from "./process/processScenario.js";

// Look-ahead spellings of the accepted languages; RE2 and Rust validators
// reject look-around, so the schemas advertise equivalent complements.
const lookaheadRootRelativePath =
  /^(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\u0000]+$/u;
const lookaheadEnvironmentName =
  /^(?!(?:REA_PROCESS_RUN_ID|__proto__)(?![\s\S]))[^=\u0000]+$/u;
const PROTOTYPE_NAME_DIAGNOSTIC =
  "__proto__ cannot reach the captured process because the PTY backend drops it before launch; run /usr/bin/env with __proto__=VALUE before the command instead";

const strings = (alphabet: readonly string[], maxLength: number): string[] => {
  const all: string[] = [];
  let level = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    level = level.flatMap((prefix) =>
      alphabet.map((character) => `${prefix}${character}`),
    );
    all.push(...level);
  }
  return all;
};

describe("look-around-free advertised patterns", () => {
  it("accepts exactly the previous normalized relative dylib roots", () => {
    const candidates = strings(["a", ".", "/", "\\", "\u0000"], 7);
    const mismatches = candidates.filter(
      (root) =>
        dylibResolutionInputSchema.safeParse({ roots: [root] }).success !==
        lookaheadRootRelativePath.test(root),
    );
    expect(candidates.length).toBeGreaterThan(90_000);
    expect(mismatches).toEqual([]);
  });

  it("accepts exactly the look-ahead environment names around the reserved names", () => {
    const edits = ["", "R", "X", "_", "p", "=", "\u0000", "é"];
    const candidates = new Set<string>(strings(["R", "E", "=", "x"], 5));
    for (const reserved of ["REA_PROCESS_RUN_ID", "__proto__"])
      for (let index = 0; index <= reserved.length; index += 1)
        for (const edit of edits) {
          const prefix = reserved.slice(0, index);
          candidates.add(`${prefix}${edit}`);
          candidates.add(`${prefix}${edit}${reserved.slice(index)}`);
          candidates.add(`${prefix}${edit}${reserved.slice(index + 1)}`);
          candidates.add(`${edit}${reserved.slice(index)}`);
        }
    const accepts = (name: string) =>
      processScenarioSchema.safeParse({
        executable: "/bin/true",
        environment: { [name]: "value" },
      }).success;
    const mismatches = [...candidates].filter(
      (name) => accepts(name) !== lookaheadEnvironmentName.test(name),
    );
    expect(accepts("REA_PROCESS_RUN_ID")).toBe(false);
    expect(accepts("REA_PROCESS_RUN_ID_2")).toBe(true);
    expect(accepts("REA_PROCESS_RUN")).toBe(true);
    // The computed key defines an own member, as JSON.parse does.
    expect(accepts("__proto__")).toBe(false);
    expect(accepts("__proto__x")).toBe(true);
    expect(accepts("__proto_")).toBe(true);
    expect(mismatches).toEqual([]);
  });

  it("keeps the reserved-name diagnostic", () => {
    const parsed = processScenarioSchema.safeParse({
      executable: "/bin/true",
      environment: { REA_PROCESS_RUN_ID: "value" },
    });
    // Record keys report their own issues nested under the invalid key.
    expect(parsed.error?.issues).toMatchObject([
      {
        code: "invalid_key",
        path: ["environment", "REA_PROCESS_RUN_ID"],
        issues: [
          { message: "REA_PROCESS_RUN_ID is reserved by the process adapter" },
        ],
      },
    ]);
  });

  it("reports __proto__ instead of silently dropping it", () => {
    const parsed = processScenarioSchema.safeParse({
      executable: "/bin/true",
      environment: JSON.parse(
        '{"__proto__":"selected-value","NORMAL_CAPTURE_KEY":"control-value"}',
      ),
    });
    expect(parsed.error?.issues).toMatchObject([
      {
        code: "invalid_key",
        path: ["environment", "__proto__"],
        issues: [{ message: PROTOTYPE_NAME_DIAGNOSTIC }],
      },
    ]);
  });
});
